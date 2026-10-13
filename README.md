# Hunting Map Generator

A desktop app for building custom printable hunting maps from public USGS, Census, and USFS data, with multi-sheet PDF export, magnetic declination, and land-access overlays.

Generates print-ready topographic hunting maps as PDFs. Works fully offline once county data is downloaded — no accounts, no telemetry.

## Two builds, one frontend

This repo ships **two independent native shells** around the same React/TypeScript frontend (`src/`) — pick one, they're not both required:

| | Tauri (Option A) | Swift (Option B) |
|---|---|---|
| Directory | [`src-tauri/`](src-tauri) | [`swift-app/`](swift-app) |
| Backend language | Rust | Swift, via `WKScriptMessageHandler` |
| Platforms | macOS, Windows, Linux | macOS only |
| Build | `yarn tauri build` | `./scripts/build-swift-app.sh` or Xcode |
| Status | Primary, actively built/released | Alternate native shell; signing not yet configured |

Both talk to the same frontend through the same IPC surface (`src/lib/ipc.ts`), which detects at runtime which shell it's running in. `project.json` and the on-disk data layout are shared, so a project is portable between the two.

Default to the **Tauri build** unless you specifically need the Swift shell — it's the one with working release packaging today. See [swift-app/README.md](swift-app/README.md) for the Swift build's architecture and Xcode setup.

## Features

- Custom paper size, scale, and multi-sheet layouts (auto or fixed grid)
- Land access overlays (huntable, no-hunting, closed, private, unknown) from public datasets
- USFS road/trail classification, county boundaries, land ownership
- Magnetic declination (WMM2025) and compass rose on exported maps
- Offline-first: download county data once, generate maps without a connection

## Installing on Windows

Windows 10 or 11, x86_64 (64-bit Intel/AMD).

1. Download `Hunting-Map-Generator-<version>-windows-x64-setup.exe` from the latest [Windows release](https://github.com/scotCW/MapGen/releases) (tagged `windows`).
2. Run it. The installer is **not code-signed yet**, so Windows SmartScreen shows "Windows protected your PC" — click **More info → Run anyway**.
3. It installs **for your user account only** — no Administrator prompt — to `%LOCALAPPDATA%\Hunting Map Generator`, and adds a Start menu shortcut.

**WebView2** (the browser engine the app renders with) is built into Windows 11 and current Windows 10. On older Windows 10 builds the installer downloads it automatically, so the first install needs an internet connection there.

**Where your data lives:** projects, downloaded county data, presets, settings, and logs are stored in `%APPDATA%\com.huntingmapgenerator.app\` (paste that into File Explorer's address bar). Exported PDFs go to each project's `exports` folder unless you pick another output folder on the Export tab. Uninstalling the app leaves this folder in place; delete it yourself to remove all data.

**Uninstall:** Settings → Apps → Installed apps → *Hunting Map Generator* → Uninstall.

**Tips**
- *Settings → Display* has a **Text size** option and a **Wide / curved screen** layout (auto-detected on 21:9 and wider monitors) that keeps the app in a centred column.
- On a slow connection, county data downloads show progress in megabytes; a download only fails if no data arrives for 90 seconds. Map previews and PDF exports stream the basemap tiles, so they need a connection.

## Installing on Linux

x86_64 (64-bit Intel/AMD). Download from the latest [Linux release](https://github.com/scotCW/MapGen/releases) (tagged `linux`) and pick the package for your distribution:

| Package | For | Install |
|---|---|---|
| `Hunting-Map-Generator-<version>-linux-amd64.deb` | Ubuntu 22.04+, Debian 12+, Linux Mint 21+, Pop!_OS | `sudo apt install ./Hunting-Map-Generator-<version>-linux-amd64.deb` |
| `Hunting-Map-Generator-<version>-linux-x86_64.rpm` | Fedora, RHEL/Rocky/Alma 9+, openSUSE | `sudo dnf install ./Hunting-Map-Generator-<version>-linux-x86_64.rpm` (openSUSE: `sudo zypper install …`) |
| `Hunting-Map-Generator-<version>-linux-x86_64.flatpak` | Any distribution with Flatpak (Arch, Steam Deck, older or immutable distros) | `flatpak install --user ./Hunting-Map-Generator-<version>-linux-x86_64.flatpak` |
| `Hunting-Map-Generator-<version>-linux-x86_64.AppImage` | Any distribution, no install or root needed | `chmod +x Hunting-Map-Generator-<version>-linux-x86_64.AppImage` then run it |

**Which one?** Prefer the `.deb`/`.rpm` on distributions that have them, then the Flatpak (sandboxed, updates its own runtime). The AppImage is a single portable file with no sandbox and no app-menu entry unless you use a helper such as AppImageLauncher. It needs FUSE 2 (`libfuse2`, called `libfuse2t64` on Ubuntu 24.04); without it, run it with `--appimage-extract-and-run`. If its window opens blank, start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1` (a known WebKitGTK and GPU-driver mismatch with bundled WebKit), or use another package.

The `.deb` and `.rpm` need **WebKitGTK 4.1** (`libwebkit2gtk-4.1`), which the package manager pulls in automatically. Ubuntu 20.04 and other distributions without it should use the Flatpak. The Flatpak brings its own runtime (GNOME 51); if Flathub isn't configured yet, add it first with `flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo` so the runtime can be fetched. Launch the app from your desktop's app menu, or run `hunting-map-generator` (deb/rpm) or `flatpak run com.huntingmapgenerator.app` (Flatpak) from a terminal.

**Where your data lives:** `~/.local/share/com.huntingmapgenerator.app/` for the deb/rpm/AppImage, and `~/.var/app/com.huntingmapgenerator.app/data/com.huntingmapgenerator.app/` for the Flatpak. The Flatpak can write exported PDFs only to your Documents and Downloads folders (and to folders you pick in a file dialog). Uninstalling leaves your data in place.

**Uninstall:** `sudo apt remove hunting-map-generator`, `sudo dnf remove hunting-map-generator`, `flatpak uninstall com.huntingmapgenerator.app`, or just delete the AppImage file.

The packages are **not signed**. Build them yourself from source with `./scripts/build-linux.sh` on Ubuntu, or `./scripts/build-linux-docker.sh` from macOS or any Docker host (see [BUILDING.md](BUILDING.md#linux-packages)).

## Installing on macOS

Download the universal `.dmg` (Apple Silicon and Intel, macOS 12+) from the release tagged `macos`. It's unsigned, so right-click the app → **Open** on first launch.

## Development

Requires [Yarn](https://yarnpkg.com) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
yarn install
yarn tauri dev
```

**On Windows**, Rust must use the MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`) with the Visual Studio C++ Build Tools installed. `.\scripts\build-windows.ps1 -Deps` installs the prerequisites via winget, then `.\scripts\build-windows.ps1` builds the installer into `src-tauri\target\release\bundle\nsis\`. Keep that script saved as **UTF-8 with BOM** — Windows PowerShell 5.1 (the default on Windows 11) reads BOM-less scripts as ANSI and fails on its non-ASCII characters.

## Building

See [BUILDING.md](BUILDING.md) for platform-specific build and packaging instructions (macOS, Windows, Linux) for the Tauri build, and [swift-app/README.md](swift-app/README.md) for the Swift build.

## State Coverage

Adding a state means writing its region/layer config (`public/regions/<state>.json`) and land-access rules (`public/access-rules/<state>.json`) — no code changes required. States not yet started aren't listed below; see `public/regions/_states.json` for the live list and `public/regions/TEMPLATE.json` for the config schema.

| State | Layer groups | Data layers | Access rules |
|---|---|---|---|
| Colorado | 3 | 5 | ✅ |
| Wyoming | 3 | 6 | ✅ |

## Data Sources

- **USGS National Map** — Topographic tiles, imagery, hillshade (public domain)
- **U.S. Census Bureau TIGER** — County and state boundaries (public domain)
- **Protected Areas Database (PAD-US)** — Federal and state land ownership (USGS, public domain)
- **USFS Motor Vehicle Use Maps** — Road and trail classification (public domain)
- **NOAA WMM2025** — Magnetic declination coefficients (public domain)

## License

Application source is released under [The Unlicense](LICENSE). Map data are public-domain government datasets — verify land access independently before entering any area.
