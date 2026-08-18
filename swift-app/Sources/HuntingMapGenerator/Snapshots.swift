import AppKit
import Foundation

/// Swift parity for Stage 21 snapshot + .huntmap commands.
enum Snapshots {

    // MARK: - Directories

    static func snapshotsDir(projectId: String) throws -> URL {
        try Projects.projectDir(id: projectId).appendingPathComponent("snapshots")
    }

    // MARK: - Save snapshot

    static func saveSnapshot(projectId: String, label: String?) throws -> [String: Any] {
        let dir = try Projects.projectDir(id: projectId)
        let meta = try Projects.readRawProjectJSON(dir: dir)

        let sdir = try snapshotsDir(projectId: projectId)
        try FileManager.default.createDirectory(at: sdir, withIntermediateDirectories: true)

        let id = UUID().uuidString
        let savedAt = Projects.nowISO()
        let labelStr = label ?? ""
        let projectName = meta["name"] as? String ?? ""

        var snap: [String: Any] = [
            "id": id,
            "label": labelStr,
            "projectName": projectName,
            "savedAt": savedAt,
            "meta": meta,
        ]

        let data = try JSONSerialization.data(withJSONObject: snap)
        try data.write(to: sdir.appendingPathComponent("\(id).json"))

        try pruneSnapshots(in: sdir)

        // Return entry (without full meta)
        snap.removeValue(forKey: "meta")
        return snap
    }

    /// Deletes the oldest snapshots beyond the `snapshotRetention` setting.
    private static func pruneSnapshots(in sdir: URL) throws {
        let settings = (try? Storage.getSettings()) ?? [:]
        let keep = max(1, settings["snapshotRetention"] as? Int ?? 20)

        var dated: [(String, URL)] = []
        let items = try FileManager.default.contentsOfDirectory(at: sdir, includingPropertiesForKeys: nil)
        for url in items where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let savedAt = obj["savedAt"] as? String else { continue }
            dated.append((savedAt, url))
        }

        guard dated.count > keep else { return }
        dated.sort { $0.0 > $1.0 }   // newest first
        for (_, url) in dated.dropFirst(keep) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - List snapshots

    static func listSnapshots(projectId: String) throws -> [[String: Any]] {
        let sdir = try snapshotsDir(projectId: projectId)
        guard FileManager.default.fileExists(atPath: sdir.path) else { return [] }

        var entries: [[String: Any]] = []
        let items = try FileManager.default.contentsOfDirectory(at: sdir, includingPropertiesForKeys: nil)
        for url in items where url.pathExtension == "json" {
            let data = try Data(contentsOf: url)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            entries.append([
                "id": obj["id"] as? String ?? "",
                "label": obj["label"] as? String ?? "",
                "projectName": obj["projectName"] as? String ?? "",
                "savedAt": obj["savedAt"] as? String ?? "",
            ])
        }

        entries.sort { ($0["savedAt"] as? String ?? "") > ($1["savedAt"] as? String ?? "") }
        return entries
    }

    // MARK: - Restore snapshot

    static func restoreSnapshot(projectId: String, snapshotId: String) throws {
        let snapPath = try snapshotsDir(projectId: projectId).appendingPathComponent("\(snapshotId).json")
        let data = try Data(contentsOf: snapPath)
        guard let snap = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let snapMeta = snap["meta"] as? [String: Any] else {
            throw NSError(domain: "Snapshots", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid snapshot"])
        }

        // Bumps the generation, so any tab save still in flight — including one
        // scheduled while this restore was being awaited — is refused rather
        // than landing on top of the restored values.
        try Projects.rewriteWithNewGeneration(id: projectId) { current in
            // Restore settings, preserve identity
            for key in ["notes", "notesSettings", "format", "layers", "area", "state", "counties"] {
                current[key] = snapMeta[key]
            }
        }
    }

    // MARK: - Delete snapshot

    static func deleteSnapshot(projectId: String, snapshotId: String) throws {
        let path = try snapshotsDir(projectId: projectId).appendingPathComponent("\(snapshotId).json")
        if FileManager.default.fileExists(atPath: path.path) {
            try FileManager.default.removeItem(at: path)
        }
    }

    // MARK: - Export .huntmap (uses NSSavePanel on main thread)

    static func exportHuntmap(projectId: String, webView: Any?) throws -> String? {
        // Build bundle JSON synchronously first
        let dir = try Projects.projectDir(id: projectId)
        let meta = try Projects.readRawProjectJSON(dir: dir)
        let name = meta["name"] as? String ?? "project"
        let safe = name.components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "- ")).inverted).joined(separator: "_")

        let bundle: [String: Any] = [
            "version": 1,
            "exportedAt": Projects.nowISO(),
            "meta": meta,
        ]
        let bundleData = try JSONSerialization.data(withJSONObject: bundle, options: .prettyPrinted)

        // Show NSSavePanel on main thread, block with semaphore
        var savedPath: String? = nil
        let sem = DispatchSemaphore(value: 0)

        DispatchQueue.main.async {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "\(safe).huntmap"
            panel.allowedContentTypes = []
            panel.title = "Export Hunting Map"
            if panel.runModal() == .OK, let url = panel.url {
                do {
                    try bundleData.write(to: url)
                    savedPath = url.path
                } catch {}
            }
            sem.signal()
        }
        sem.wait()
        return savedPath
    }

    // MARK: - Import .huntmap (uses NSOpenPanel on main thread)

    static func importHuntmap() throws -> [String: Any]? {
        var chosenPath: String? = nil
        let sem = DispatchSemaphore(value: 0)

        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.title = "Import Hunting Map"
            panel.allowsMultipleSelection = false
            panel.canChooseDirectories = false
            if panel.runModal() == .OK, let url = panel.url {
                chosenPath = url.path
            }
            sem.signal()
        }
        sem.wait()

        guard let path = chosenPath else { return nil }

        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let bundle = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let meta = bundle["meta"] as? [String: Any] else {
            throw NSError(domain: "Snapshots", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid .huntmap file"])
        }

        // Create new project from meta
        let newId = UUID().uuidString
        let now = Projects.nowISO()
        let newDir = try Projects.projectsDir().appendingPathComponent(newId)
        try FileManager.default.createDirectory(at: newDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newDir.appendingPathComponent("snapshots"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newDir.appendingPathComponent("exports"), withIntermediateDirectories: true)

        var imported = meta
        imported["id"] = newId
        imported["lastModified"] = now
        imported["createdAt"] = now
        imported["version"] = 1

        try Projects.writeRawProjectJSON(dir: newDir, dict: imported)

        // Return summary
        return [
            "id": newId,
            "name": meta["name"] as? String ?? "Imported Project",
            "state": meta["state"] ?? NSNull(),
            "counties": meta["counties"] ?? [],
            "areaSizeKm2": meta["areaSizeKm2"] ?? NSNull(),
            "sheetCount": meta["sheetCount"] ?? 1,
            "lastModified": now,
            "createdAt": now,
            "forkedFromId": (meta["forkedFrom"] as? [String: Any])?["id"] ?? NSNull(),
            "forkedFromName": (meta["forkedFrom"] as? [String: Any])?["name"] ?? NSNull(),
            "hasThumbnail": false,
        ]
    }

}
