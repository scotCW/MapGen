import Foundation

// MARK: - Data types

/// Mirrors Rust's ExportHistoryEntry (serde camelCase).
struct ExportHistoryEntry: Codable {
    var id: String
    var filename: String
    var path: String
    var date: String
    var dpi: Int
    var pages: Int
    var fileSizeBytes: Int
    var outputFolder: String
}

// MARK: - Exports

enum Exports {

    private static let maxHistory = 50

    // MARK: - Directory helpers

    static func exportsDir(projectId: String) throws -> URL {
        let base = try Storage.baseDataDir()
        return base
            .appendingPathComponent("projects")
            .appendingPathComponent(projectId)
            .appendingPathComponent("exports")
    }

    private static func historyFile(exportsDir: URL) -> URL {
        exportsDir.appendingPathComponent("_history.json")
    }

    // MARK: - Save export

    /// Decodes a base64 PDF, writes it to disk, appends a history entry.
    /// Returns the absolute path of the saved file.
    static func saveExport(
        projectId: String,
        filename: String,
        dataBase64: String,
        outputFolder: String?,
        dpi: Int,
        pages: Int
    ) throws -> String {
        guard let data = Data(base64Encoded: dataBase64, options: .ignoreUnknownCharacters) else {
            throw ExportError.base64DecodeFailed
        }

        let exDir = try exportsDir(projectId: projectId)
        let fm    = FileManager.default

        // Resolve output folder — caller-supplied or project exports dir.
        let destDir: URL
        if let folder = outputFolder, !folder.isEmpty {
            destDir = URL(fileURLWithPath: folder)
        } else {
            destDir = exDir
        }

        try fm.createDirectory(at: destDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: exDir,   withIntermediateDirectories: true)

        let destFile = destDir.appendingPathComponent(filename)
        try data.write(to: destFile, options: .atomic)

        let fileSize = (try? fm.attributesOfItem(atPath: destFile.path)[.size] as? Int) ?? data.count

        let entry = ExportHistoryEntry(
            id: UUID().uuidString.lowercased(),
            filename: filename,
            path: destFile.path,
            date: nowISO(),
            dpi: dpi,
            pages: pages,
            fileSizeBytes: fileSize,
            outputFolder: destDir.path
        )

        try prependHistory(entry: entry, exportsDir: exDir)
        return destFile.path
    }

    // MARK: - Get export history

    static func getExportHistory(projectId: String) throws -> [[String: Any]] {
        let exDir = try exportsDir(projectId: projectId)
        let file  = historyFile(exportsDir: exDir)
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let data = try Data(contentsOf: file)
        guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return arr
    }

    // MARK: - Private helpers

    private static func nowISO() -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fmt.string(from: Date())
    }

    private static func prependHistory(entry: ExportHistoryEntry, exportsDir: URL) throws {
        let file = historyFile(exportsDir: exportsDir)
        let fm   = FileManager.default

        var existing: [[String: Any]] = []
        if fm.fileExists(atPath: file.path),
           let data = try? Data(contentsOf: file),
           let arr  = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            existing = arr
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = []
        let entryData = try encoder.encode(entry)
        guard let entryDict = try JSONSerialization.jsonObject(with: entryData) as? [String: Any] else {
            throw ExportError.encodeFailed
        }

        var updated = [entryDict] + existing
        if updated.count > maxHistory { updated = Array(updated.prefix(maxHistory)) }

        let out = try JSONSerialization.data(withJSONObject: updated, options: .prettyPrinted)
        try out.write(to: file, options: .atomic)
    }
}

// MARK: - Errors

enum ExportError: LocalizedError {
    case base64DecodeFailed
    case encodeFailed

    var errorDescription: String? {
        switch self {
        case .base64DecodeFailed: return "Failed to decode base64 PDF data"
        case .encodeFailed:       return "Failed to encode export history entry"
        }
    }
}
