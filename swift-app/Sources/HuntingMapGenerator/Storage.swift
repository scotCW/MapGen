import Foundation

// MARK: - AppSettings

/// Mirrors the Rust AppSettings struct (serde camelCase).
/// Property names are already camelCase so JSONEncoder uses them as-is.
struct AppSettings: Codable {
    var version: Int
    var theme: String
    var units: String
    var difficulty: String
    var dataLocation: String?
    var onlineByDefault: Bool
    var snapshotRetention: Int
    var currencyWarningMonths: Int
    var defaultDpi: Int
    var autoOpenFolderAfterExport: Bool

    static let defaults = AppSettings(
        version: 1,
        theme: "system",
        units: "imperial",
        difficulty: "beginner",
        dataLocation: nil,
        onlineByDefault: true,
        snapshotRetention: 20,
        currencyWarningMonths: 12,
        defaultDpi: 200,
        autoOpenFolderAfterExport: true
    )

    /// Mirrors `#[serde(default)]` on the Rust struct. The synthesised decoder
    /// would reject a settings.json missing any key, and `baseDataDir` treats a
    /// decode failure as "no custom location" — so a hand-edited file with one
    /// key dropped would make a relocated data directory, and every project in
    /// it, appear to vanish. Decoding each key independently avoids that and
    /// keeps older settings files loading as fields are added.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings.defaults
        version                   = try c.decodeIfPresent(Int.self,    forKey: .version)                   ?? d.version
        theme                     = try c.decodeIfPresent(String.self, forKey: .theme)                     ?? d.theme
        units                     = try c.decodeIfPresent(String.self, forKey: .units)                     ?? d.units
        difficulty                = try c.decodeIfPresent(String.self, forKey: .difficulty)                ?? d.difficulty
        dataLocation              = try c.decodeIfPresent(String.self, forKey: .dataLocation)
        onlineByDefault           = try c.decodeIfPresent(Bool.self,   forKey: .onlineByDefault)           ?? d.onlineByDefault
        snapshotRetention         = try c.decodeIfPresent(Int.self,    forKey: .snapshotRetention)         ?? d.snapshotRetention
        currencyWarningMonths     = try c.decodeIfPresent(Int.self,    forKey: .currencyWarningMonths)     ?? d.currencyWarningMonths
        defaultDpi                = try c.decodeIfPresent(Int.self,    forKey: .defaultDpi)                ?? d.defaultDpi
        autoOpenFolderAfterExport = try c.decodeIfPresent(Bool.self,   forKey: .autoOpenFolderAfterExport) ?? d.autoOpenFolderAfterExport
    }

    /// Explicit memberwise init, since providing `init(from:)` suppresses the
    /// synthesised one that `defaults` above relies on.
    init(version: Int, theme: String, units: String, difficulty: String,
         dataLocation: String?, onlineByDefault: Bool, snapshotRetention: Int,
         currencyWarningMonths: Int, defaultDpi: Int, autoOpenFolderAfterExport: Bool) {
        self.version = version
        self.theme = theme
        self.units = units
        self.difficulty = difficulty
        self.dataLocation = dataLocation
        self.onlineByDefault = onlineByDefault
        self.snapshotRetention = snapshotRetention
        self.currencyWarningMonths = currencyWarningMonths
        self.defaultDpi = defaultDpi
        self.autoOpenFolderAfterExport = autoOpenFolderAfterExport
    }
}

// MARK: - Storage

enum Storage {

    // MARK: - Directories

    /// ~/Library/Application Support/com.huntingmapgenerator.app
    static var defaultAppDir: URL {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("com.huntingmapgenerator.app")
    }

    static var settingsFileURL: URL {
        defaultAppDir.appendingPathComponent("settings/settings.json")
    }

    /// Returns the active base data directory.
    /// Reads `dataLocation` from settings.json; falls back to defaultAppDir
    /// when the setting is absent or the path no longer exists.
    static func baseDataDir() throws -> URL {
        let fm = FileManager.default
        if fm.fileExists(atPath: settingsFileURL.path),
           let data = try? Data(contentsOf: settingsFileURL),
           let settings = try? JSONDecoder().decode(AppSettings.self, from: data),
           let custom = settings.dataLocation {
            let customURL = URL(fileURLWithPath: custom)
            if fm.fileExists(atPath: customURL.path) {
                return customURL
            }
        }
        return defaultAppDir
    }

    /// Creates the seven canonical subdirectories and a default settings.json
    /// on first launch.  Safe to call on every launch.
    static func initDirectories() throws {
        let fm = FileManager.default
        let base = defaultAppDir

        for sub in ["projects", "data", "settings", "presets", "regions", "access-rules", "logs"] {
            try fm.createDirectory(
                at: base.appendingPathComponent(sub),
                withIntermediateDirectories: true
            )
        }

        if !fm.fileExists(atPath: settingsFileURL.path) {
            try writeSettings(AppSettings.defaults)
        }
    }

    // MARK: - IPC commands

    static func getDataDir() throws -> String {
        return try baseDataDir().path
    }

    /// Returns settings as a JSON-compatible dictionary (for IPCHandler).
    static func getSettings() throws -> [String: Any] {
        let fm = FileManager.default
        let data: Data
        if fm.fileExists(atPath: settingsFileURL.path) {
            data = try Data(contentsOf: settingsFileURL)
        } else {
            data = try encodeSettings(AppSettings.defaults)
        }
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw StorageError.jsonParseFailed("settings.json is not a JSON object")
        }
        return dict
    }

    /// Merges one key/value pair into settings.json.
    static func setSetting(key: String, value: Any) throws {
        let fm = FileManager.default
        var dict: [String: Any]

        if fm.fileExists(atPath: settingsFileURL.path) {
            let data = try Data(contentsOf: settingsFileURL)
            guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw StorageError.jsonParseFailed("settings.json is not a JSON object")
            }
            dict = parsed
        } else {
            let data = try encodeSettings(AppSettings.defaults)
            dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }

        dict[key] = value
        let updated = try JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted)
        try updated.write(to: settingsFileURL)
    }

    // MARK: - Private helpers

    private static func encodeSettings(_ s: AppSettings) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        return try encoder.encode(s)
    }

    private static func writeSettings(_ s: AppSettings) throws {
        let data = try encodeSettings(s)
        try data.write(to: settingsFileURL)
    }

    // MARK: - App log (Stage 22)

    static var logFileURL: URL {
        defaultAppDir.appendingPathComponent("logs/app.log")
    }

    static func writeAppLog(message: String) throws {
        let fm = FileManager.default
        let dir = logFileURL.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ts = fmt.string(from: Date())
        let line = "[\(ts)] \(message)\n"

        var content = ""
        if fm.fileExists(atPath: logFileURL.path) {
            content = (try? String(contentsOf: logFileURL, encoding: .utf8)) ?? ""
        }
        content += line

        // Trim to 2000 lines
        let lines = content.components(separatedBy: "\n")
        let trimmed = lines.count > 2000
            ? lines.suffix(2000).joined(separator: "\n") + "\n"
            : content
        try trimmed.write(to: logFileURL, atomically: true, encoding: .utf8)
    }

    static func readAppLog(lines: Int) throws -> String {
        guard FileManager.default.fileExists(atPath: logFileURL.path) else { return "" }
        let content = try String(contentsOf: logFileURL, encoding: .utf8)
        let all = content.components(separatedBy: "\n")
        let slice = all.count > lines ? Array(all.suffix(lines)) : all
        return slice.joined(separator: "\n")
    }
}

// MARK: - Errors

enum StorageError: LocalizedError {
    case jsonParseFailed(String)

    var errorDescription: String? {
        switch self {
        case .jsonParseFailed(let msg): return "Storage JSON parse error: \(msg)"
        }
    }
}
