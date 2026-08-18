# Hunting Map Generator — Owner/Developer Guide

This document is for whoever maintains and builds the app, not for end users.

---

## Building from Source

### Prerequisites

- **macOS 13+** recommended for development (builds target macOS 10.13+)
- **Xcode 15+** (for Swift/WKWebView build; Command Line Tools for Tauri build)
- **Rust** via rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js 18+** and **Yarn 1.x**: install via MacPorts (`sudo port install nodejs18 yarn`)
- **Tauri CLI**: installed automatically via `yarn tauri`

### Tauri build (Option A — cross-platform)

```bash
cd ~/Projects/MapGen

# Install JS dependencies
yarn install

# Run in dev mode (hot-reload)
yarn tauri dev

# Build release installer (.app + .dmg on macOS)
yarn tauri build

# Build for Intel Mac specifically
yarn tauri build --target x86_64-apple-darwin

# Universal binary (Intel + Apple Silicon)
rustup target add x86_64-apple-darwin aarch64-apple-darwin
yarn tauri build --target universal-apple-darwin
```

Output: `src-tauri/target/<target>/release/bundle/`

### Swift/WKWebView build (Option B — macOS only via Xcode)

```bash
# Build frontend + copy assets + build Swift app (universal binary)
./scripts/build-swift-app.sh

# Debug build (native arch, faster)
./scripts/build-swift-app.sh --debug

# Open in Xcode (run with Cmd+R; select HuntingMapGenerator scheme, My Mac destination)
open swift-app/Package.swift
```

> **Important:** run the build script (or `yarn build && cp -r dist/ swift-app/Sources/HuntingMapGenerator/Resources/dist/`) before `Cmd+R` in Xcode. Xcode builds the Swift code only; it does not rebuild the React frontend.

Output: `swift-app/.build/apple/Products/Release/HuntingMapGenerator`

---

## macOS Code Signing and Notarization

For distribution outside the Mac App Store:

1. **Signing identity** — set `signingIdentity` in `src-tauri/tauri.conf.json` to your Developer ID Application certificate name (from Keychain Access).
2. **Notarization** — use `./scripts/sign-and-notarize.sh` after building. Requires `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` environment variables set to an App-Specific Password.
3. **Stapling** — the script runs `xcrun stapler staple` automatically.

Minimum macOS target is **12.0** (set in `tauri.conf.json` and `Package.swift`). The Swift build requires macOS 12 for `actor`/`Task`, and the frontend is compiled for Safari 15, so 12.0 is the real floor. Mac Pro 6,1 tops out at Monterey 12.7, which satisfies this — test there or on a VM before distributing.

---

## Linux Packages

Targets **x86_64 Ubuntu 22.04+**, with a Flatpak for other distributions.

> **Linux packages cannot be built from macOS.** Tauri links against the system GTK and WebKitGTK libraries, so there is no supported cross-compile path. Build on an Ubuntu machine, VM, container, or CI runner.

```bash
# On Ubuntu — install prerequisites, then build .deb + AppImage
./scripts/build-linux.sh --deps

# Subsequent builds
./scripts/build-linux.sh

# Also build and install a Flatpak
./scripts/build-linux.sh --flatpak
```

Output lands in `src-tauri/target/release/bundle/`:

| File | Use |
|---|---|
| `deb/*.deb` | Ubuntu / Debian — `sudo apt install ./<file>.deb` |
| `appimage/*.AppImage` | Portable, no install — `chmod +x` and run |
| `hunting-map-generator.flatpak` | Every other distro — `flatpak install --user <file>.flatpak` |

**Ubuntu 22.04 is the minimum** because Tauri v2 requires `webkit2gtk-4.1`, which is not packaged for 20.04. Build on the oldest release you intend to support: the resulting binary's glibc requirement is set by the build host, so a 22.04 build runs on 24.04 but not the reverse.

### Flatpak notes

The manifest (`flatpak/com.huntingmapgenerator.app.yml`) repackages the `.deb` rather than compiling from source, which is the approach Tauri documents. It grants only what the app needs: `--device=dri` (MapLibre renders via WebGL), `--share=network` (map tiles and county data downloads), and read/write access to Documents and Downloads so a chosen PDF export folder keeps working across sessions.

The runtime is pinned to `org.gnome.Platform//47`, which supplies `webkit2gtk-4.1`. Tauri v2 does not use the GTK 4 WebKit build, so if a future runtime drops the GTK 3 one, pin backwards rather than migrating.

`flatpak/com.huntingmapgenerator.app.metainfo.xml` carries the AppStream metadata that software centres and Flathub require.

---

## Windows Package

Targets **x86_64 Windows 10/11**.

> **The Windows installer cannot be built from macOS or Linux.** Tauri links against WebView2 through the MSVC toolchain, so there is no supported cross-compile path. Build on a Windows machine, a Windows VM, or CI.

```powershell
# On Windows — install prerequisites, then build the installer
.\scripts\build-windows.ps1 -Deps

# Subsequent builds
.\scripts\build-windows.ps1
```

Output lands in `src-tauri\target\release\bundle\nsis\*.exe` — a per-user installer (no Administrator prompt) that installs to the current user's profile, matching the app's no-accounts, no-telemetry design. `bundle.windows.nsis.installMode` in `tauri.conf.json` controls this; set it to `"both"` if you want end users to choose per-user vs. per-machine at install time.

**Rust must use the MSVC toolchain**, not GNU — `rustup-init.exe` selects this by default on Windows, but if `rustc -vV` reports a `gnu` host triple, switch with:

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

**WebView2**: ships with Windows 10 21H2+ and all of Windows 11, so most machines need nothing extra. For older systems, the NSIS installer downloads the WebView2 bootstrapper automatically at install time (`bundle.windows.nsis`) — no separate runtime install is required on the build machine or the end user's.

**Code signing**: `bundle.windows.certificateThumbprint` is `null` by default (unsigned). Windows SmartScreen will warn on first run without a code-signing certificate; set the thumbprint (and `digestAlgorithm`/`timestampUrl` alongside it) once you have one.

---

## Adding a New State

The region config system is fully data-driven. Adding a state requires **no code changes** — only JSON files.

### Step 1 — Create the region layer config

Copy `public/regions/TEMPLATE.json` to `public/regions/<statename>.json` (all lowercase, e.g. `montana.json`). Fill in:

| Field | Required | Description |
|---|---|---|
| `schemaVersion` | yes | Always `1` |
| `stateId` | yes | 2-letter FIPS abbreviation (`MT`) |
| `stateName` | yes | Full name (`Montana`) |
| `description` | yes | One sentence about data sources |
| `countyBoundarySource` | yes | TIGER REST API URL for state's counties (change `STATE='XX'` to the state's 2-digit FIPS code) |
| `groups[]` | yes | One or more layer groups specific to this state |

**State FIPS codes for common western states:**

| State | FIPS |
|---|---|
| Colorado | 08 |
| Wyoming | 56 |
| Montana | 30 |
| Idaho | 16 |
| Utah | 49 |
| Nevada | 32 |
| New Mexico | 35 |

**Layer group guidelines:**
- Use group IDs prefixed with the state abbreviation (e.g. `mt_wildlife`, `mt_hunting_units`)
- Use layer IDs prefixed the same way (`mt_swa`, `mt_walk_in`)
- Set `accessCategory` (1–5) on access-category layers; null on reference layers
- Set `accessRuleId` to match the rule ID in the state's access-rules file

### Step 2 — Create the access classification rules

Copy `public/access-rules/TEMPLATE.json` to `public/access-rules/<statename>.json`. Fill in rules that override or supplement `_national.json`:

- Rule `id` must be globally unique — prefix with state abbreviation (`mt_walk_in`)
- Rule `priority` is 1–99; the engine adds +1000 at runtime so state rules always beat national ones
- `match[]` — all conditions must be true (AND)
- `match_any[]` — at least one must be true (OR); when both are present, both must be satisfied
- Ambiguity always defaults to `unknown` (Category 5) — never guess open

### Step 3 — Register the state in the manifest

Add an entry to `public/regions/_states.json`:

```json
{
  "id": "MT",
  "name": "Montana",
  "file": "montana"
}
```

The `file` value is the filename without `.json`. That's it — the app will show Montana in the state selector and load its layers automatically.

### Step 4 — Test

1. Run `yarn tauri dev`
2. Create a new project, open the state selector in the workspace header, pick Montana
3. Open the Layers tab — Montana-specific layer groups should appear below the national groups
4. Verify the Layers panel shows your group label, descriptions, and layer names
5. Run `yarn tsc --noEmit` to confirm no type errors

---

## Project Data Layout

```
~/Library/Application Support/com.huntingmapgenerator.app/
  projects/
    <uuid>/
      project.json          Human-readable project settings
      thumbnail.png         Auto-generated preview (256×256)
      snapshots/            Rolling undo history (JSON diffs)
      exports/
        *.pdf               Exported maps
        _history.json       Export history (last 50 entries)
  data/
    colorado/
      larimer/
        *.geojson           Downloaded county vector layers
        _manifest.json      Source dates, sizes, checksums
  settings/
    settings.json           Global app settings
  presets/                  User-saved print presets (Stage 22)
  regions/                  Layer config overrides (future)
  access-rules/             Classification rule overrides (future)
  logs/                     App logs (Stage 22)
```

---

## Architecture Notes

### Two parallel build paths

Both builds share the same React/TypeScript frontend (`src/`). Every new backend command must be implemented in **both**:

| | Tauri (Option A) | Swift (Option B) |
|---|---|---|
| Backend | `src-tauri/src/*.rs` | `swift-app/Sources/HuntingMapGenerator/*.swift` |
| IPC dispatch | `#[tauri::command]` + `lib.rs` registration | `IPCHandler.swift` switch-case |
| Data dir | `~/Library/Application Support/com.huntingmapgenerator.app` | same |

Frontend code that calls Tauri-specific APIs (e.g. `@tauri-apps/plugin-dialog`) must use runtime detection:
```typescript
if ((window as any).__TAURI_INTERNALS__) {
  // Tauri path
} else {
  // Swift path via invoke("pick_folder", ...)
}
```

### IPC contract

The frontend calls `invoke(cmd, args)` from `src/lib/ipc.ts`. Arguments and return values are JSON-serializable. See the command list in `src-tauri/src/lib.rs` (Tauri) and `IPCHandler.swift` (Swift) for the full set.

### Safety rules (non-negotiable)

- Ambiguous land access → Category 5 (Unknown). Never guess open.
- The mandatory legal disclaimer (`ACCESS_DISCLAIMER` in `src/types/access.ts`) must appear on every exported PDF page. It cannot be disabled by settings.
- The access classification first-run modal must appear before any map is shown and requires explicit acknowledgment.
- No telemetry, crash reporting, or network calls except for map tiles and user-initiated data downloads.
