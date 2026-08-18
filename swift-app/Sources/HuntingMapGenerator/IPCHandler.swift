import AppKit
import Foundation
import WebKit

/// Dispatches JS→Swift IPC messages and delivers results back to JavaScript.
///
/// Message format (JSON string posted by ipc.ts):
///   { "cmd": "<command>", "args": { ... }, "id": <integer> }
///
/// Callback format (evaluated by Swift on the web view):
///   window.__ipcCallback(id, success, valueJson)
/// where `valueJson` is a JSON-encoded string that ipc.ts JSON.parse()s.
enum IPCHandler {

    // MARK: - Public entry point

    static func handle(
        cmd: String,
        args: [String: Any],
        id: Int,
        webView: WKWebView
    ) {
        // pick_folder requires NSOpenPanel which must run on the main thread.
        if cmd == "pick_folder" {
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseDirectories  = true
                panel.canChooseFiles        = false
                panel.allowsMultipleSelection = false
                panel.title = args["title"] as? String ?? "Choose Folder"
                if panel.runModal() == .OK, let url = panel.url {
                    let escaped = escapeForJSString(url.path)
                    callJS(id: id, success: true, payload: "\"\(escaped)\"", webView: webView)
                } else {
                    callJS(id: id, success: true, payload: "null", webView: webView)
                }
            }
            return
        }

        // export_huntmap and import_huntmap use NSSavePanel/NSOpenPanel (main thread).
        if cmd == "export_huntmap" || cmd == "import_huntmap" {
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let result: Any?
                    if cmd == "export_huntmap" {
                        let projectId = args["projectId"] as? String ?? ""
                        result = try Snapshots.exportHuntmap(projectId: projectId, webView: webView)
                    } else {
                        result = try Snapshots.importHuntmap()
                    }
                    let payload = result.flatMap { val -> String? in
                        if let dict = val as? [String: Any],
                           let data = try? JSONSerialization.data(withJSONObject: dict),
                           let s = String(data: data, encoding: .utf8) { return s }
                        if let s = val as? String { return "\"\(escapeForJSString(s))\"" }
                        return nil
                    } ?? "null"
                    callJS(id: id, success: true, payload: payload, webView: webView)
                } catch {
                    callJS(id: id, success: false,
                           payload: "\"" + escapeForJSString(error.localizedDescription) + "\"",
                           webView: webView)
                }
            }
            return
        }

        // reveal_in_finder also needs the main thread.
        if cmd == "reveal_in_finder" {
            DispatchQueue.main.async {
                if let path = args["path"] as? String {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: path)]
                    )
                }
                callJS(id: id, success: true, payload: "null", webView: webView)
            }
            return
        }

        // All other commands run on a background thread (file I/O may be slow on
        // spinning-disk Mac Pros).
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let result = try dispatch(cmd: cmd, args: args)
                let jsonString: String
                if let value = result {
                    jsonString = try encodeResult(value)
                } else {
                    jsonString = "null"
                }
                callJS(id: id, success: true, payload: jsonString, webView: webView)
            } catch {
                callJS(id: id, success: false, payload: error.localizedDescription, webView: webView)
            }
        }
    }

    // MARK: - Command dispatcher

    /// Returns `nil` for void commands (serialised to JSON `null`).
    private static func dispatch(cmd: String, args: [String: Any]) throws -> Any? {
        switch cmd {

        // ── Storage ──────────────────────────────────────────────────────────

        case "get_data_dir":
            return try Storage.getDataDir()

        case "get_settings":
            return try Storage.getSettings()

        case "set_setting":
            guard let key = args["key"] as? String else {
                throw IPCError.missingArg("key")
            }
            let value: Any = args["value"] ?? NSNull()
            try Storage.setSetting(key: key, value: value)
            return nil

        // ── Projects ─────────────────────────────────────────────────────────

        case "list_projects":
            return try Projects.listProjects()

        case "create_project":
            guard let name = args["name"] as? String else {
                throw IPCError.missingArg("name")
            }
            return try Projects.createProject(name: name)

        case "fork_project":
            guard let sourceId = args["sourceId"] as? String else {
                throw IPCError.missingArg("sourceId")
            }
            guard let newName = args["newName"] as? String else {
                throw IPCError.missingArg("newName")
            }
            return try Projects.forkProject(sourceId: sourceId, newName: newName)

        case "rename_project":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            guard let name = args["name"] as? String else {
                throw IPCError.missingArg("name")
            }
            try Projects.renameProject(id: id, name: name)
            return nil

        case "delete_project":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            try Projects.deleteProject(id: id)
            return nil

        case "get_project":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            return try Projects.getProject(id: id)

        case "save_format_settings":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            guard let format = args["format"] as? [String: Any] else {
                throw IPCError.missingArg("format")
            }
            guard let generation = (args["expectedGeneration"] as? NSNumber)?.uint64Value else {
                throw IPCError.missingArg("expectedGeneration")
            }
            return try Projects.saveFormatSettings(id: id, format: format, expectedGeneration: generation)

        case "save_layer_settings":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            guard let layers = args["layers"] as? [String: Any] else {
                throw IPCError.missingArg("layers")
            }
            guard let generation = (args["expectedGeneration"] as? NSNumber)?.uint64Value else {
                throw IPCError.missingArg("expectedGeneration")
            }
            return try Projects.saveLayerSettings(id: id, layers: layers, expectedGeneration: generation)

        case "save_area_settings":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            guard let area = args["area"] as? [String: Any] else {
                throw IPCError.missingArg("area")
            }
            guard let generation = (args["expectedGeneration"] as? NSNumber)?.uint64Value else {
                throw IPCError.missingArg("expectedGeneration")
            }
            return try Projects.saveAreaSettings(id: id, area: area, expectedGeneration: generation)

        case "save_state_selection":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            let state    = args["state"]    as? String
            let counties = args["counties"] as? [String] ?? []
            guard let generation = (args["expectedGeneration"] as? NSNumber)?.uint64Value else {
                throw IPCError.missingArg("expectedGeneration")
            }
            return try Projects.saveStateSelection(id: id, state: state, counties: counties, expectedGeneration: generation)

        case "save_notes":
            guard let id = args["id"] as? String else {
                throw IPCError.missingArg("id")
            }
            let notes           = args["notes"]           as? String ?? ""
            let printOnOverview = args["printOnOverview"] as? Bool   ?? false
            let printedFontSize = args["printedFontSize"] as? Int    ?? 8
            guard let generation = (args["expectedGeneration"] as? NSNumber)?.uint64Value else {
                throw IPCError.missingArg("expectedGeneration")
            }
            return try Projects.saveNotes(
                id: id,
                notes: notes,
                printOnOverview: printOnOverview,
                printedFontSize: printedFontSize,
                expectedGeneration: generation
            )

        // ── Exports ──────────────────────────────────────────────────────────

        case "save_export":
            guard let projectId  = args["projectId"]  as? String else { throw IPCError.missingArg("projectId")  }
            guard let filename   = args["filename"]   as? String else { throw IPCError.missingArg("filename")   }
            guard let dataBase64 = args["dataBase64"] as? String else { throw IPCError.missingArg("dataBase64") }
            let outputFolder = args["outputFolder"] as? String
            let dpi   = args["dpi"]   as? Int ?? 150
            let pages = args["pages"] as? Int ?? 1
            let savedPath = try Exports.saveExport(
                projectId: projectId,
                filename: filename,
                dataBase64: dataBase64,
                outputFolder: outputFolder,
                dpi: dpi,
                pages: pages
            )
            return savedPath

        case "get_export_history":
            guard let projectId = args["projectId"] as? String else {
                throw IPCError.missingArg("projectId")
            }
            return try Exports.getExportHistory(projectId: projectId)

        // ── Data downloads ────────────────────────────────────────────────

        case "list_downloaded_layers":
            guard let stateId = args["stateId"] as? String else {
                throw IPCError.missingArg("stateId")
            }
            return try Downloads.listDownloadedLayers(stateId: stateId)

        case "start_download":
            guard let stateId = args["stateId"] as? String else {
                throw IPCError.missingArg("stateId")
            }
            let items = args["items"] as? [[String: Any]] ?? []
            // async — fire and forget (progress polled separately)
            Task { try? await Downloads.startDownload(stateId: stateId, items: items) }
            return nil

        case "get_download_progress":
            // Runs async but we need sync return — use a semaphore
            let sema = DispatchSemaphore(value: 0)
            var result: [String: Any] = [:]
            Task {
                result = await Downloads.getDownloadProgress()
                sema.signal()
            }
            sema.wait()
            return result

        case "cancel_download":
            Task { await Downloads.cancelDownload() }
            return nil

        case "delete_layer_data":
            guard let stateId = args["stateId"] as? String else {
                throw IPCError.missingArg("stateId")
            }
            guard let layerId = args["layerId"] as? String else {
                throw IPCError.missingArg("layerId")
            }
            try Downloads.deleteLayer(stateId: stateId, layerId: layerId)
            return nil

        case "get_data_disk_usage":
            return try Downloads.diskUsage()

        // Stage 21 — snapshots
        case "save_snapshot":
            guard let projectId = args["projectId"] as? String else { throw IPCError.missingArg("projectId") }
            let label = args["label"] as? String
            return try Snapshots.saveSnapshot(projectId: projectId, label: label)

        case "list_snapshots":
            guard let projectId = args["projectId"] as? String else { throw IPCError.missingArg("projectId") }
            return try Snapshots.listSnapshots(projectId: projectId)

        case "restore_snapshot":
            guard let projectId  = args["projectId"]  as? String else { throw IPCError.missingArg("projectId") }
            guard let snapshotId = args["snapshotId"] as? String else { throw IPCError.missingArg("snapshotId") }
            try Snapshots.restoreSnapshot(projectId: projectId, snapshotId: snapshotId)
            return nil

        case "delete_snapshot":
            guard let projectId  = args["projectId"]  as? String else { throw IPCError.missingArg("projectId") }
            guard let snapshotId = args["snapshotId"] as? String else { throw IPCError.missingArg("snapshotId") }
            try Snapshots.deleteSnapshot(projectId: projectId, snapshotId: snapshotId)
            return nil

        // export_huntmap / import_huntmap are handled above (main-thread path)

        // Stage 22 — presets
        case "save_preset":
            guard let name = args["name"] as? String else { throw IPCError.missingArg("name") }
            guard let projectId = args["projectId"] as? String else { throw IPCError.missingArg("projectId") }
            return try Presets.savePreset(name: name, projectId: projectId)

        case "list_presets":
            return try Presets.listPresets()

        case "apply_preset":
            guard let projectId = args["projectId"] as? String else { throw IPCError.missingArg("projectId") }
            guard let presetId  = args["presetId"]  as? String else { throw IPCError.missingArg("presetId") }
            try Presets.applyPreset(projectId: projectId, presetId: presetId)
            return nil

        case "delete_preset":
            guard let presetId = args["presetId"] as? String else { throw IPCError.missingArg("presetId") }
            try Presets.deletePreset(presetId: presetId)
            return nil

        // Stage 22 — app log
        case "write_app_log":
            guard let message = args["message"] as? String else { throw IPCError.missingArg("message") }
            try Storage.writeAppLog(message: message)
            return nil

        case "read_app_log":
            let lines = args["lines"] as? Int ?? 200
            return try Storage.readAppLog(lines: lines)

        default:
            throw IPCError.unknownCommand(cmd)
        }
    }

    // MARK: - JS callback

    /// Converts any Swift value returned by a command into a JSON string.
    /// NSJSONSerialization only accepts Array/Dictionary at the top level, so
    /// scalars (String, Int, Bool) are encoded manually.
    private static func encodeResult(_ value: Any) throws -> String {
        switch value {
        case let s as String:
            return "\"\(escapeForJSString(s))\""
        case let b as Bool:
            return b ? "true" : "false"
        case let n as Int:
            return "\(n)"
        // The generation-guarded save commands return UInt64, which does not
        // bridge to Int here and would otherwise fall through to
        // JSONSerialization — which rejects a bare scalar at the top level.
        case let n as UInt64:
            return "\(n)"
        case let n as Double:
            return "\(n)"
        default:
            let data = try JSONSerialization.data(withJSONObject: value, options: [])
            return String(data: data, encoding: .utf8) ?? "null"
        }
    }

    /// Evaluates `window.__ipcCallback(id, success, "jsonEncodedPayload")` on
    /// the web view.  Must run on the main thread.
    private static func callJS(
        id: Int,
        success: Bool,
        payload: String,
        webView: WKWebView
    ) {
        // Encode the payload string so it is safe to embed inside a JS string
        // literal — escape backslashes, double-quotes, and control characters.
        let escaped = escapeForJSString(payload)
        let js = "window.__ipcCallback(\(id), \(success), \"\(escaped)\")"

        DispatchQueue.main.async {
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// Escapes a Swift String for embedding between `"..."` in a JS statement.
    private static func escapeForJSString(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.utf8.count)
        for ch in s.unicodeScalars {
            switch ch {
            case "\\":  out += "\\\\"
            case "\"":  out += "\\\""
            case "\n":  out += "\\n"
            case "\r":  out += "\\r"
            case "\t":  out += "\\t"
            case "\u{2028}": out += "\\u2028"   // JS line separator
            case "\u{2029}": out += "\\u2029"   // JS paragraph separator
            default:
                // Keep ASCII printable; use \\uXXXX for other control chars.
                if ch.value < 0x20 {
                    out += String(format: "\\u%04X", ch.value)
                } else {
                    out.unicodeScalars.append(ch)
                }
            }
        }
        return out
    }
}

// MARK: - Errors

enum IPCError: LocalizedError {
    case missingArg(String)
    case unknownCommand(String)

    var errorDescription: String? {
        switch self {
        case .missingArg(let arg):
            return "Missing required IPC argument: \(arg)"
        case .unknownCommand(let cmd):
            return "Unknown IPC command: \(cmd)"
        }
    }
}
