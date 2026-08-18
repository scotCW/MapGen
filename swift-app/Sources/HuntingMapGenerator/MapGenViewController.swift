import AppKit
import WebKit

class MapGenViewController: NSViewController, WKScriptMessageHandler {
    private var webView: WKWebView!

    // MARK: - View lifecycle

    override func loadView() {
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800))
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()

        // 1. Register the custom mapgen:// scheme so we can serve dist/ files
        //    from inside the app bundle without a running web server.
        config.setURLSchemeHandler(MapGenSchemeHandler(), forURLScheme: "mapgen")

        // 2. Register the JS→Swift message channel.  React calls:
        //      window.webkit.messageHandlers.invoke.postMessage(jsonString)
        config.userContentController.add(self, name: "invoke")

        // 3. Inject a stub __ipcCallback at document-start so the symbol
        //    exists even before ipc.ts has executed.  ipc.ts overwrites it
        //    with the real implementation when it loads.
        let bridgeScript = """
        if (typeof window.__ipcCallback === 'undefined') {
            window.__ipcCallback = function(id, success, valueJson) {};
        }
        """
        let userScript = WKUserScript(
            source: bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(userScript)

        // Build the web view, filling the entire view controller view.
        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        view.addSubview(webView)

        // Load the React app via the custom scheme.
        let startURL = URL(string: "mapgen://localhost/index.html")!
        webView.load(URLRequest(url: startURL))
    }

    // MARK: - Settings bridge

    /// Called by AppDelegate when the user triggers Settings (⌘,) via the menu.
    func openSettings() {
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript(
                "document.dispatchEvent(new CustomEvent('open-settings'))",
                completionHandler: nil
            )
        }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "invoke",
              let bodyString = message.body as? String,
              let data = bodyString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = json["cmd"] as? String,
              let id  = json["id"]  as? Int
        else { return }

        let args = json["args"] as? [String: Any] ?? [:]
        IPCHandler.handle(cmd: cmd, args: args, id: id, webView: webView)
    }
}
