# Hunting Map Generator

A Tauri v2 desktop app for building custom printable hunting maps from public USGS, Census, and USFS data, with multi-sheet PDF export, magnetic declination, and land-access overlays.

Generates print-ready topographic hunting maps as PDFs. Works fully offline once county data is downloaded — no accounts, no telemetry.

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

See [BUILDING.md](BUILDING.md) for platform-specific build and packaging instructions (macOS, Windows, Linux).

## Data Sources

- **USGS National Map** — Topographic tiles, imagery, hillshade (public domain)
- **U.S. Census Bureau TIGER** — County and state boundaries (public domain)
- **Protected Areas Database (PAD-US)** — Federal and state land ownership (USGS, public domain)
- **USFS Motor Vehicle Use Maps** — Road and trail classification (public domain)
- **NOAA WMM2025** — Magnetic declination coefficients (public domain)

## License

Application source is released under [The Unlicense](LICENSE). Map data are public-domain government datasets — verify land access independently before entering any area.
