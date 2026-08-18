import Foundation
import WebKit

/// Serves the compiled Vite output (dist/) from the app bundle via the
/// custom `mapgen://` URL scheme so WKWebView can load local files without
/// relaxing security policies or requiring a running dev server.
class MapGenSchemeHandler: NSObject, WKURLSchemeHandler {

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            fail(urlSchemeTask, status: 400, message: "Bad request URL")
            return
        }

        // Normalise the path: bare "/" or empty → "index.html"
        var path = requestURL.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        // Resolve against the dist/ directory bundled with the app.
        guard let distBase = distDirectory() else {
            fail(urlSchemeTask, status: 500, message: "Bundle resource directory not found")
            return
        }

        // Strip the leading "/" and append to the base URL safely.
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let fileURL  = distBase.appendingPathComponent(relative)

        guard
            FileManager.default.fileExists(atPath: fileURL.path),
            let data = try? Data(contentsOf: fileURL)
        else {
            fail(urlSchemeTask, status: 404, message: "File not found: \(relative)")
            return
        }

        let mime = mimeType(for: path)
        let response = HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type":   mime,
                "Content-Length": "\(data.count)",
                // Permit scripts on this origin to call the WebKit bridge.
                "Access-Control-Allow-Origin": "*",
            ]
        )!

        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Nothing to cancel — all I/O is synchronous.
    }

    // MARK: - Helpers

    /// Resolves the `Resources/dist` directory inside the SPM resource bundle.
    private func distDirectory() -> URL? {
        // Bundle.module is synthesised by SPM when resources are declared in
        // Package.swift.  For swift build output the bundle sits next to the
        // executable; for Xcode it is inside the .app bundle.
        Bundle.module.resourceURL?.appendingPathComponent("Resources/dist")
    }

    private func fail(_ task: WKURLSchemeTask, status: Int, message: String) {
        guard let url = task.request.url else { return }
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/plain"]
        )!
        task.didReceive(response)
        task.didReceive((message + "\n").data(using: .utf8)!)
        task.didFinish()
    }

    private func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html":        return "text/html; charset=utf-8"
        case "js", "mjs":  return "application/javascript"
        case "css":         return "text/css"
        case "json":        return "application/json"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":         return "image/gif"
        case "svg":         return "image/svg+xml"
        case "ico":         return "image/x-icon"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "otf":         return "font/otf"
        case "map":         return "application/json"
        case "webp":        return "image/webp"
        case "txt":         return "text/plain"
        default:            return "application/octet-stream"
        }
    }
}
