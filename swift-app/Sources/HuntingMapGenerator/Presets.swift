import Foundation

/// Swift parity for Stage 22 preset commands.
enum Presets {

    static func presetsDir() throws -> URL {
        try Storage.baseDataDir().appendingPathComponent("presets")
    }

    static func nowISO() -> String { Projects.nowISO() }

    // MARK: - Save preset

    /// Settings are read from project.json rather than accepted from the caller —
    /// the tabs persist their own state, so a frontend copy can be stale.
    static func savePreset(name: String, projectId: String) throws -> [String: Any] {
        let dir = try presetsDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let project = try Projects.readRawProjectJSON(dir: Projects.projectDir(id: projectId))

        let id = UUID().uuidString
        let entry: [String: Any] = [
            "id": id,
            "name": name,
            "createdAt": nowISO(),
            "format": project["format"] ?? [String: Any](),
            "layers": project["layers"] ?? [String: Any](),
        ]

        let data = try JSONSerialization.data(withJSONObject: entry, options: .prettyPrinted)
        try data.write(to: dir.appendingPathComponent("\(id).json"))
        return entry
    }

    // MARK: - List presets

    static func listPresets() throws -> [[String: Any]] {
        let dir = try presetsDir()
        guard FileManager.default.fileExists(atPath: dir.path) else { return [] }

        var entries: [[String: Any]] = []
        let items = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        for url in items where url.pathExtension == "json" {
            let data = try Data(contentsOf: url)
            if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                entries.append(obj)
            }
        }
        entries.sort { ($0["createdAt"] as? String ?? "") > ($1["createdAt"] as? String ?? "") }
        return entries
    }

    // MARK: - Apply preset

    static func applyPreset(projectId: String, presetId: String) throws {
        let presetPath = try presetsDir().appendingPathComponent("\(presetId).json")
        let data = try Data(contentsOf: presetPath)
        guard let preset = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Bumps the generation for the same reason snapshot restore does: a tab
        // save computed before this point must not land on top of the preset.
        try Projects.rewriteWithNewGeneration(id: projectId) { meta in
            if let format = preset["format"] { meta["format"] = format }
            if let layers = preset["layers"] { meta["layers"] = layers }
        }
    }

    // MARK: - Delete preset

    static func deletePreset(presetId: String) throws {
        let path = try presetsDir().appendingPathComponent("\(presetId).json")
        if FileManager.default.fileExists(atPath: path.path) {
            try FileManager.default.removeItem(at: path)
        }
    }
}
