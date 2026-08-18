import Foundation

// MARK: - Types

struct LayerManifestEntry: Codable {
    var layerId: String
    var layerName: String
    var downloadedAt: String
    var sizeBytes: Int
    var sourceUrl: String
    var isStale: Bool
}

struct LayerManifest: Codable {
    var layers: [LayerManifestEntry]

    static let empty = LayerManifest(layers: [])
}

struct DataDiskUsage: Codable {
    var totalBytes: Int
    var dataDir: String
}

struct DownloadProgressState: Codable {
    var active: Bool
    var currentLayerId: String
    var currentLayerName: String
    var overallCompleted: Int
    var overallTotal: Int
    var error: String?
}

// MARK: - Download state (shared across concurrent requests)

actor DownloadActor {
    static let shared = DownloadActor()

    private var progress = DownloadProgressState(
        active: false, currentLayerId: "", currentLayerName: "",
        overallCompleted: 0, overallTotal: 0, error: nil
    )
    private var cancelRequested = false
    private var task: Task<Void, Never>?

    func getProgress() -> DownloadProgressState { progress }

    func requestCancel() { cancelRequested = true }

    func start(stateId: String, items: [[String: Any]]) throws {
        guard !progress.active else { throw DataError.alreadyDownloading }
        cancelRequested = false
        progress = DownloadProgressState(
            active: true, currentLayerId: "", currentLayerName: "",
            overallCompleted: 0, overallTotal: items.count, error: nil
        )
        task = Task {
            var completed = 0
            for item in items {
                guard !cancelRequested else {
                    progress.active = false
                    progress.error = "Download cancelled"
                    return
                }
                let layerId   = item["layerId"]   as? String ?? ""
                let layerName = item["layerName"] as? String ?? ""
                let urlString = item["downloadUrl"] as? String ?? ""

                progress.currentLayerId   = layerId
                progress.currentLayerName = layerName
                progress.overallCompleted = completed

                do {
                    let size = try await downloadOne(stateId: stateId, layerId: layerId, layerName: layerName, urlString: urlString)
                    try DataStore.updateManifest(stateId: stateId, layerId: layerId, layerName: layerName, urlString: urlString, size: size)
                    completed += 1
                } catch {
                    progress.active = false
                    progress.error = "\(layerName): \(error.localizedDescription)"
                    return
                }
            }
            progress.active = false
            progress.overallCompleted = completed
            progress.currentLayerId = ""
            progress.currentLayerName = ""
        }
    }

    private func downloadOne(stateId: String, layerId: String, layerName: String, urlString: String) async throws -> Int {
        guard let url = URL(string: urlString) else { throw DataError.invalidURL(urlString) }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw DataError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let dest = try DataStore.layerFilePath(stateId: stateId, layerId: layerId)
        try data.write(to: dest, options: .atomic)
        return data.count
    }
}

// MARK: - DataStore (filesystem helpers)

enum DataStore {
    static func stateDir(stateId: String) throws -> URL {
        let dir = try Storage.baseDataDir()
            .appendingPathComponent("data")
            .appendingPathComponent(stateId.lowercased())
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func layerFilePath(stateId: String, layerId: String) throws -> URL {
        try stateDir(stateId: stateId).appendingPathComponent("\(layerId).geojson")
    }

    static func manifestPath(stateId: String) throws -> URL {
        try stateDir(stateId: stateId).appendingPathComponent("manifest.json")
    }

    static func readManifest(stateId: String) -> LayerManifest {
        guard let path = try? manifestPath(stateId: stateId),
              let data = try? Data(contentsOf: path),
              let m = try? JSONDecoder().decode(LayerManifest.self, from: data)
        else { return .empty }
        return m
    }

    static func writeManifest(stateId: String, manifest: LayerManifest) throws {
        let path = try manifestPath(stateId: stateId)
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: path, options: .atomic)
    }

    static func updateManifest(stateId: String, layerId: String, layerName: String, urlString: String, size: Int) throws {
        var manifest = readManifest(stateId: stateId)
        manifest.layers.removeAll { $0.layerId == layerId }
        let iso = ISO8601DateFormatter().string(from: Date())
        manifest.layers.append(LayerManifestEntry(
            layerId: layerId, layerName: layerName,
            downloadedAt: iso, sizeBytes: size,
            sourceUrl: urlString, isStale: false
        ))
        try writeManifest(stateId: stateId, manifest: manifest)
    }

    static func listDownloadedLayers(stateId: String) throws -> [LayerManifestEntry] {
        let dir  = try stateDir(stateId: stateId)
        var manifest = readManifest(stateId: stateId)
        let threshold: TimeInterval = 90 * 24 * 3600
        let now = Date()
        let fmt = ISO8601DateFormatter()
        manifest.layers = manifest.layers.filter { entry in
            dir.appendingPathComponent("\(entry.layerId).geojson").exists
        }.map { entry in
            var e = entry
            if let d = fmt.date(from: entry.downloadedAt) {
                e.isStale = now.timeIntervalSince(d) > threshold
            }
            return e
        }
        return manifest.layers
    }

    static func deleteLayer(stateId: String, layerId: String) throws {
        let file = try layerFilePath(stateId: stateId, layerId: layerId)
        if file.exists { try FileManager.default.removeItem(at: file) }
        var manifest = readManifest(stateId: stateId)
        manifest.layers.removeAll { $0.layerId == layerId }
        try writeManifest(stateId: stateId, manifest: manifest)
    }

    static func dataDiskUsage() throws -> DataDiskUsage {
        let root = try Storage.baseDataDir().appendingPathComponent("data")
        let bytes = dirSize(root)
        return DataDiskUsage(totalBytes: bytes, dataDir: root.path)
    }

    private static func dirSize(_ url: URL) -> Int {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total = 0
        for case let fileURL as URL in enumerator {
            total += (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
        return total
    }
}

// MARK: - Downloads IPC helpers (called from IPCHandler)

enum Downloads {
    static func listDownloadedLayers(stateId: String) throws -> [[String: Any]] {
        let entries = try DataStore.listDownloadedLayers(stateId: stateId)
        let enc = JSONEncoder()
        enc.outputFormatting = []
        return try entries.map { entry in
            let d = try enc.encode(entry)
            return (try JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
        }
    }

    static func startDownload(stateId: String, items: [[String: Any]]) async throws {
        try await DownloadActor.shared.start(stateId: stateId, items: items)
    }

    static func getDownloadProgress() async -> [String: Any] {
        let p = await DownloadActor.shared.getProgress()
        let enc = JSONEncoder()
        enc.outputFormatting = []
        let d = (try? enc.encode(p)) ?? Foundation.Data()
        return (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }

    static func cancelDownload() async {
        await DownloadActor.shared.requestCancel()
    }

    static func deleteLayer(stateId: String, layerId: String) throws {
        try DataStore.deleteLayer(stateId: stateId, layerId: layerId)
    }

    static func diskUsage() throws -> [String: Any] {
        let usage = try DataStore.dataDiskUsage()
        let enc = JSONEncoder()
        let d = (try? enc.encode(usage)) ?? Foundation.Data()
        return (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }
}

// MARK: - Errors

enum DataError: LocalizedError {
    case alreadyDownloading
    case invalidURL(String)
    case httpError(Int)

    var errorDescription: String? {
        switch self {
        case .alreadyDownloading:      return "A download is already in progress"
        case .invalidURL(let u):       return "Invalid URL: \(u)"
        case .httpError(let code):     return "HTTP error \(code)"
        }
    }
}

// MARK: - URL exists helper

private extension URL {
    var exists: Bool { FileManager.default.fileExists(atPath: path) }
}
