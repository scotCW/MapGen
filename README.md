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

## Development

Requires [Yarn](https://yarnpkg.com) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
yarn install
yarn tauri dev
```

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
