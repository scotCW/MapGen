# Hunting Map Generator — Swift/WKWebView build (Option B)

This directory is the **native Swift shell** for Hunting Map Generator.
It hosts the same React/TypeScript frontend (from `src/`) as the Tauri build,
but replaces the Rust/Tauri backend with equivalent Swift code and bridges
JS↔Swift IPC using `WKScriptMessageHandler`.

## Architecture

```
swift-app/
├── Package.swift                           SPM manifest
├── Sources/HuntingMapGenerator/
│   ├── main.swift                          Entry point (NSApplication)
│   ├── AppDelegate.swift                   Window setup, Storage.initDirectories()
│   ├── MapGenViewController.swift          WKWebView host + WKScriptMessageHandler
│   ├── MapGenSchemeHandler.swift           Serves dist/ via mapgen:// custom scheme
│   ├── IPCHandler.swift                    JS→Swift command dispatcher
│   ├── Storage.swift                       AppSettings + data-directory helpers
│   ├── Projects.swift                      Project CRUD (mirrors projects.rs)
│   └── Resources/
│       └── dist/                           Populated by build-swift-app.sh
└── Info.plist                              Bundle metadata for Xcode builds
```

The React frontend lives in `src/` and is shared between both builds.
The IPC abstraction in `src/lib/ipc.ts` auto-detects the runtime:

| Runtime | Detection | Transport |
|---------|-----------|-----------|
| Tauri | `window.__TAURI_INTERNALS__` | `@tauri-apps/api/core` |
| Swift/WKWebView | `window.webkit.messageHandlers.invoke` | `WKScriptMessageHandler` |
| Browser dev | neither | rejects with a clear error |

## Building from the command line

```bash
# From the repo root — builds Vite output then the Swift app (universal binary):
./scripts/build-swift-app.sh

# Debug build (native arch only, faster):
./scripts/build-swift-app.sh --debug
```

The release binary lands at:

```
swift-app/.build/apple/Products/Release/HuntingMapGenerator
```

The resource bundle with the frontend assets is placed next to the binary:

```
swift-app/.build/apple/Products/Release/HuntingMapGenerator_HuntingMapGenerator.bundle/
```

## Opening in Xcode

```bash
open swift-app/Package.swift
```

Xcode will open the Swift package.  Before running:

1. Select the `HuntingMapGenerator` scheme.
2. Copy `dist/` (after running `yarn build`) into
   `Sources/HuntingMapGenerator/Resources/dist/`, or run the build script once
   to do it automatically.
3. Set your development team in **Signing & Capabilities** if you want to run
   on a device or submit to the Mac App Store.

Code signing is handled by Xcode's automatic signing.  The entitlements file
(`App.entitlements`) enables the App Sandbox, outbound network access, and
user-selected file read/write.

## Relationship to the Tauri build

| Aspect | Tauri (Option A) | Swift (Option B) |
|--------|-----------------|------------------|
| Frontend | `src/` | `src/` (same) |
| IPC | Rust via `invoke()` | Swift via `WKScriptMessageHandler` |
| Backend | `src-tauri/` | `swift-app/Sources/` |
| Build | `yarn tauri build` | `./scripts/build-swift-app.sh` |
| Data dir | `~/Library/Application Support/com.huntingmapgenerator.app` | same |
| project.json schema | same (camelCase JSON) | same |
