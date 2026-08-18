import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    private var viewController: MapGenViewController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? Storage.initDirectories()
        buildMainMenu()

        let initialRect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        window = NSWindow(
            contentRect: initialRect,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Hunting Map Generator"
        window.minSize = NSSize(width: 900, height: 600)
        viewController = MapGenViewController()
        window.contentViewController = viewController

        window.setFrameAutosaveName("HuntingMapGenerator.MainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)

        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // MARK: - Main menu

    private func buildMainMenu() {
        let mainMenu = NSMenu()
        NSApp.mainMenu = mainMenu

        // ── App menu ──────────────────────────────────────────────────────────
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu

        appMenu.addItem(
            withTitle: "About Hunting Map Generator",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())

        let settingsItem = NSMenuItem(
            title: "Settings\u{2026}",   // "…" as Unicode to avoid file-encoding issues
            action: #selector(openSettingsFromMenu(_:)),
            keyEquivalent: ","
        )
        settingsItem.target = self
        appMenu.addItem(settingsItem)

        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Hide Hunting Map Generator",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthers = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(
            withTitle: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Hunting Map Generator",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        // ── Window menu (enables Cmd+M, Cmd+W) ───────────────────────────────
        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowItem.submenu = windowMenu
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.miniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "Zoom",
            action: #selector(NSWindow.zoom(_:)),
            keyEquivalent: ""
        )
        windowMenu.addItem(.separator())
        windowMenu.addItem(
            withTitle: "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        )
        NSApp.windowsMenu = windowMenu
    }

    // MARK: - Actions

    @objc private func openSettingsFromMenu(_ sender: Any?) {
        viewController.openSettings()
    }
}
