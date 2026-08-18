import Foundation

// MARK: - Data types

/// Mirrors Rust's ForkedFrom (camelCase JSON via Codable property names).
struct ForkedFrom: Codable {
    let id: String
    let name: String
}

/// Mirrors Rust's NotesSettings (serde camelCase).
struct NotesSettings: Codable {
    var printOnOverview: Bool
    var printedFontSize: Int

    static let defaults = NotesSettings(printOnOverview: false, printedFontSize: 8)
}

/// Full project definition — stored in project.json.
/// Mirrors Rust's ProjectMeta with serde camelCase.
struct ProjectMeta: Codable {
    var version: Int
    var id: String
    var name: String
    var state: String?
    var counties: [String]
    var areaSizeKm2: Double?
    var sheetCount: Int
    var lastModified: String   // ISO-8601 UTC
    var createdAt: String      // ISO-8601 UTC
    var forkedFrom: ForkedFrom?
    var notes: String
    var notesSettings: NotesSettings

    // Custom decoder supplies defaults for fields added after initial release,
    // mirroring Rust's #[serde(default)].
    enum CodingKeys: String, CodingKey {
        case version, id, name, state, counties, areaSizeKm2, sheetCount
        case lastModified, createdAt, forkedFrom, notes, notesSettings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version       = try c.decode(Int.self,          forKey: .version)
        id            = try c.decode(String.self,        forKey: .id)
        name          = try c.decode(String.self,        forKey: .name)
        state         = try c.decodeIfPresent(String.self,      forKey: .state)
        counties      = try c.decodeIfPresent([String].self,    forKey: .counties)   ?? []
        areaSizeKm2   = try c.decodeIfPresent(Double.self,      forKey: .areaSizeKm2)
        sheetCount    = try c.decodeIfPresent(Int.self,         forKey: .sheetCount) ?? 1
        lastModified  = try c.decode(String.self,        forKey: .lastModified)
        createdAt     = try c.decode(String.self,        forKey: .createdAt)
        forkedFrom    = try c.decodeIfPresent(ForkedFrom.self,  forKey: .forkedFrom)
        notes         = try c.decodeIfPresent(String.self,      forKey: .notes)         ?? ""
        notesSettings = try c.decodeIfPresent(NotesSettings.self, forKey: .notesSettings) ?? .defaults
    }

    // Explicit memberwise init so call sites in createProject / forkProject still compile.
    init(version: Int, id: String, name: String, state: String?, counties: [String],
         areaSizeKm2: Double?, sheetCount: Int, lastModified: String, createdAt: String,
         forkedFrom: ForkedFrom?, notes: String, notesSettings: NotesSettings = .defaults) {
        self.version       = version
        self.id            = id
        self.name          = name
        self.state         = state
        self.counties      = counties
        self.areaSizeKm2   = areaSizeKm2
        self.sheetCount    = sheetCount
        self.lastModified  = lastModified
        self.createdAt     = createdAt
        self.forkedFrom    = forkedFrom
        self.notes         = notes
        self.notesSettings = notesSettings
    }
}

/// Lightweight summary returned to the Projects screen grid.
/// Mirrors Rust's ProjectSummary.
struct ProjectSummary: Codable {
    var id: String
    var name: String
    var state: String?
    var counties: [String]
    var areaSizeKm2: Double?
    var sheetCount: Int
    var lastModified: String
    var createdAt: String
    var forkedFromId: String?
    var forkedFromName: String?
    var hasThumbnail: Bool
}

// MARK: - Projects

enum Projects {

    // MARK: - Directory helpers

    static func projectsDir() throws -> URL {
        return try Storage.baseDataDir().appendingPathComponent("projects")
    }

    static func projectDir(id: String) throws -> URL {
        return try projectsDir().appendingPathComponent(id)
    }

    // MARK: - Timestamps

    static func nowISO() -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fmt.string(from: Date())
    }

    // MARK: - Default blobs for new projects (mirrors Rust Default impls)

    static let defaultFormat: [String: Any] = [
        "paperSize": "letter", "paperWidthIn": 8.5, "paperHeightIn": 11.0,
        "orientation": "portrait", "margins": "normal", "sheetLayout": "1",
        "sheetsAcross": 2, "sheetsDown": 2, "sheetsSplit": "side-by-side",
        "sheetsArrangement": "3x2", "scale": 24000, "scaleCustom": NSNull(),
        "scaleLock": "scale", "freeformDraw": false,
    ]

    static let defaultLayers: [String: Any] = [
        "activeBasemap": "usgs_topo",
        "enabledLayers": [Any](),
        "layerOpacities": [String: Any](),
    ]

    // MARK: - JSON helpers

    static func readProjectJSON(dir: URL) throws -> ProjectMeta {
        let data = try Data(contentsOf: dir.appendingPathComponent("project.json"))
        return try JSONDecoder().decode(ProjectMeta.self, from: data)
    }

    /// Reads project.json as a raw dictionary (preserves all fields including
    /// format/layers blobs that are not in the Codable struct).
    static func readRawProjectJSON(dir: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: dir.appendingPathComponent("project.json"))
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProjectError.jsonParseFailed("project.json is not a JSON object")
        }
        return dict
    }

    static func writeRawProjectJSON(dir: URL, dict: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: dir.appendingPathComponent("project.json"), options: .atomic)
    }

    static func writeProjectJSON(dir: URL, meta: ProjectMeta) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        let data = try encoder.encode(meta)
        try data.write(to: dir.appendingPathComponent("project.json"))
    }

    /// Converts a ProjectMeta + directory into a ProjectSummary dictionary.
    static func summaryDict(meta: ProjectMeta, dir: URL) throws -> [String: Any] {
        let hasThumbnail = FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("thumbnail.png").path
        )
        let summary = ProjectSummary(
            id: meta.id,
            name: meta.name,
            state: meta.state,
            counties: meta.counties,
            areaSizeKm2: meta.areaSizeKm2,
            sheetCount: meta.sheetCount,
            lastModified: meta.lastModified,
            createdAt: meta.createdAt,
            forkedFromId: meta.forkedFrom?.id,
            forkedFromName: meta.forkedFrom?.name,
            hasThumbnail: hasThumbnail
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = []
        let data = try encoder.encode(summary)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProjectError.jsonParseFailed("Could not convert ProjectSummary to dictionary")
        }
        return dict
    }

    // MARK: - IPC commands

    /// Returns all projects sorted by lastModified descending.
    static func listProjects() throws -> [[String: Any]] {
        let base = try projectsDir()
        let fm   = FileManager.default

        guard fm.fileExists(atPath: base.path) else { return [] }

        let entries = try fm.contentsOfDirectory(
            at: base,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: .skipsHiddenFiles
        )

        var result: [[String: Any]] = []
        for entry in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: entry.path, isDirectory: &isDir),
                  isDir.boolValue,
                  fm.fileExists(atPath: entry.appendingPathComponent("project.json").path)
            else { continue }

            if let meta = try? readProjectJSON(dir: entry),
               let dict = try? summaryDict(meta: meta, dir: entry) {
                result.append(dict)
            }
        }

        // Sort by lastModified descending (ISO-8601 strings sort lexicographically).
        result.sort { a, b in
            let da = a["lastModified"] as? String ?? ""
            let db = b["lastModified"] as? String ?? ""
            return da > db
        }
        return result
    }

    /// Creates a new project folder and project.json; returns its summary dict.
    static func createProject(name: String) throws -> [String: Any] {
        let id  = UUID().uuidString.lowercased()
        let now = nowISO()
        let dir = try projectDir(id: id)
        let fm  = FileManager.default

        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("snapshots"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("exports"),   withIntermediateDirectories: true)

        let meta = ProjectMeta(
            version: 1,
            id: id,
            name: name,
            state: nil,
            counties: [],
            areaSizeKm2: nil,
            sheetCount: 1,
            lastModified: now,
            createdAt: now,
            forkedFrom: nil,
            notes: ""
        )
        // Write via raw dict so format/layers blobs are included
        let encoder = JSONEncoder(); encoder.outputFormatting = []
        let encoded = try encoder.encode(meta)
        guard var dict = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw ProjectError.jsonParseFailed("encode failed")
        }
        dict["format"] = defaultFormat
        dict["layers"] = defaultLayers
        try writeRawProjectJSON(dir: dir, dict: dict)
        return try summaryDict(meta: meta, dir: dir)
    }

    /// Creates a fully independent copy of a project with forkedFrom lineage.
    static func forkProject(sourceId: String, newName: String) throws -> [String: Any] {
        let sourceDir = try projectDir(id: sourceId)
        let source    = try readProjectJSON(dir: sourceDir)

        let newId  = UUID().uuidString.lowercased()
        let now    = nowISO()
        let newDir = try projectDir(id: newId)
        let fm     = FileManager.default

        try fm.createDirectory(at: newDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: newDir.appendingPathComponent("snapshots"), withIntermediateDirectories: true)
        try fm.createDirectory(at: newDir.appendingPathComponent("exports"),   withIntermediateDirectories: true)

        let forked = ProjectMeta(
            version: 1,
            id: newId,
            name: newName,
            state: source.state,
            counties: source.counties,
            areaSizeKm2: source.areaSizeKm2,
            sheetCount: source.sheetCount,
            lastModified: now,
            createdAt: now,
            forkedFrom: ForkedFrom(id: source.id, name: source.name),
            notes: ""
        )
        // Copy format/layers blobs from source so the fork inherits them
        let encoder = JSONEncoder(); encoder.outputFormatting = []
        let encoded = try encoder.encode(forked)
        guard var dict = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw ProjectError.jsonParseFailed("encode failed")
        }
        let sourceRaw = try readRawProjectJSON(dir: sourceDir)
        dict["format"] = sourceRaw["format"] ?? defaultFormat
        dict["layers"] = sourceRaw["layers"] ?? defaultLayers
        try writeRawProjectJSON(dir: newDir, dict: dict)
        return try summaryDict(meta: forked, dir: newDir)
    }

    /// Renames a project in-place and updates lastModified.
    ///
    /// Goes through `lockedUpdate` rather than a bare read-modify-write: IPC
    /// commands are dispatched concurrently here, so an unlocked rename can
    /// interleave with a tab's settings save and drop one of the two changes.
    static func renameProject(id: String, name: String) throws {
        try lockedUpdate(id: id) { dict in
            dict["name"] = name
        }
    }

    /// Deletes the project directory recursively.
    static func deleteProject(id: String) throws {
        let dir = try projectDir(id: id)
        if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
        }
    }

    /// Returns the full project.json contents as a dictionary (all fields).
    static func getProject(id: String) throws -> [String: Any] {
        let dir = try projectDir(id: id)
        var dict = try readRawProjectJSON(dir: dir)
        // Ensure format and layers are present (backwards-compat for old files)
        if dict["format"] == nil { dict["format"] = defaultFormat }
        if dict["layers"] == nil { dict["layers"] = defaultLayers }
        return dict
    }

    /// Persists format settings, bumps lastModified.
    // MARK: - Generation-guarded writes
    //
    // Mirrors the Rust `guarded_update` / `rewrite_with_new_generation` pair.
    // The lock matters more here than on the Tauri side: IPC commands are
    // dispatched on a concurrent global queue, so without it two saves really
    // can interleave their read-check-write cycles.

    private static let writeLock = NSLock()

    /// Applies a partial settings update only if the caller's view of the
    /// document is still current. Returns the generation the write landed on.
    static func guardedUpdate(
        id: String,
        expectedGeneration: UInt64,
        _ apply: (inout [String: Any]) -> Void
    ) throws -> UInt64 {
        writeLock.lock()
        defer { writeLock.unlock() }

        let dir = try projectDir(id: id)
        var dict = try readRawProjectJSON(dir: dir)
        let current = (dict["settingsGeneration"] as? NSNumber)?.uint64Value ?? 0
        guard current == expectedGeneration else {
            throw ProjectError.staleGeneration
        }
        apply(&dict)
        dict["lastModified"] = nowISO()
        try writeRawProjectJSON(dir: dir, dict: dict)
        return current
    }

    /// Mutates project.json under the same lock as the guarded writes, without
    /// touching the generation. For edits that are neither a settings save nor a
    /// wholesale rewrite — renaming, say, which must not invalidate a tab's
    /// pending save, but equally must not lose one by interleaving with it.
    static func lockedUpdate(id: String, _ apply: (inout [String: Any]) -> Void) throws {
        writeLock.lock()
        defer { writeLock.unlock() }

        let dir = try projectDir(id: id)
        var dict = try readRawProjectJSON(dir: dir)
        apply(&dict)
        dict["lastModified"] = nowISO()
        try writeRawProjectJSON(dir: dir, dict: dict)
    }

    /// Rewrites the document wholesale and bumps the generation, invalidating
    /// any save still in flight from before. Used by restore and preset apply.
    @discardableResult
    static func rewriteWithNewGeneration(
        id: String,
        _ apply: (inout [String: Any]) -> Void
    ) throws -> UInt64 {
        writeLock.lock()
        defer { writeLock.unlock() }

        let dir = try projectDir(id: id)
        var dict = try readRawProjectJSON(dir: dir)
        apply(&dict)
        let next = ((dict["settingsGeneration"] as? NSNumber)?.uint64Value ?? 0) &+ 1
        dict["settingsGeneration"] = NSNumber(value: next)
        dict["lastModified"] = nowISO()
        try writeRawProjectJSON(dir: dir, dict: dict)
        return next
    }

    static func saveFormatSettings(id: String, format: [String: Any], expectedGeneration: UInt64) throws -> UInt64 {
        try guardedUpdate(id: id, expectedGeneration: expectedGeneration) { dict in
            dict["format"] = format
        }
    }

    /// Persists layer settings, bumps lastModified.
    static func saveLayerSettings(id: String, layers: [String: Any], expectedGeneration: UInt64) throws -> UInt64 {
        try guardedUpdate(id: id, expectedGeneration: expectedGeneration) { dict in
            dict["layers"] = layers
        }
    }

    /// Persists area settings (print-box centre), bumps lastModified.
    static func saveAreaSettings(id: String, area: [String: Any], expectedGeneration: UInt64) throws -> UInt64 {
        try guardedUpdate(id: id, expectedGeneration: expectedGeneration) { dict in
            dict["area"] = area
        }
    }

    /// Persists the selected state and county list, bumps lastModified.
    static func saveStateSelection(id: String, state: String?, counties: [String], expectedGeneration: UInt64) throws -> UInt64 {
        try guardedUpdate(id: id, expectedGeneration: expectedGeneration) { dict in
            dict["state"] = state ?? NSNull()
            dict["counties"] = counties
        }
    }

    /// Persists notes text and print-on-overview settings, bumps lastModified.
    static func saveNotes(id: String, notes: String, printOnOverview: Bool, printedFontSize: Int, expectedGeneration: UInt64) throws -> UInt64 {
        try guardedUpdate(id: id, expectedGeneration: expectedGeneration) { dict in
            dict["notes"] = notes
            dict["notesSettings"] = [
                "printOnOverview": printOnOverview,
                "printedFontSize": max(6, min(24, printedFontSize)),
            ]
        }
    }
}

// MARK: - Errors

enum ProjectError: LocalizedError {
    case jsonParseFailed(String)
    /// A save was refused for being based on pre-rewrite state. The description
    /// must stay byte-identical to the Rust `STALE_GENERATION` constant — the
    /// frontend matches on this string to drop the write quietly.
    case staleGeneration

    var errorDescription: String? {
        switch self {
        case .jsonParseFailed(let msg): return "Project JSON error: \(msg)"
        case .staleGeneration:          return "STALE_GENERATION"
        }
    }
}
