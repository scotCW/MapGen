# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.0.2] - 2026-10-11

Prerelease. **Windows only** — see the `windows` tag; an x86_64 NSIS installer (per-user, no Administrator prompt). Unsigned, so Windows SmartScreen warns on first run (More info → Run anyway). Fixes from Windows 11 testing.

### Fixed
- **Magnetic declination was wrong**, not just stale: the WMM2025 Legendre recursion mixed fully-normalised constants into a Schmidt seed, and the geodetic rotation had a sign error. Denver read ~9.2°E and Seattle ~19.4°E; now 7.5°E / 14.9°E, matching NOAA. The compass rose shows the epoch it was computed for (e.g. "WMM2025 · 2026.8").
- **Map element toggles didn't affect the export.** The Preview checkboxes only changed the on-screen mock-up — unticking the title block still printed it. Elements are now saved per project (`elements` in project.json, `save_map_elements` command) and the PDF honours them. Every element can be turned off, including the access disclaimer.
- **`get_settings` dropped every key `AppSettings` doesn't list** — `hide_access_disclaimer`, `experience_level`, the export preferences and the first-run acknowledgement were saved but never read back, so those settings appeared to do nothing. It now returns all stored keys over the defaults.
- **Scale drift** (e.g. 1:49,909 for a chosen 1:50,000): moving the area box re-derived the scale from the moved box's degree extents. Moving no longer changes the scale; back-computed scales snap within 1%, and drifted custom scales saved by older builds are repaired on load.
- **Print layout overlaps**: the ratio text ran into the warning box, warning text overflowed its box, coordinate labels sat under the neatline and inside the title block, and the legend could overlap the map. Layout now comes from one module (`src/lib/pageLayout.ts`) with reserved space for every band and label; the legend wraps into columns. Checked across 1,280 paper/layout/scale/element combinations with no text overlaps.
- Multi-sheet overview page was stretched for non-square grids (2×1, 3×2); it now keeps its true aspect ratio.
- Data downloads gave no feedback on slow networks and hid failures: the error was only rendered inside the progress view, which vanished as soon as the download stopped. The button now shows "Starting…", progress shows bytes received, results/errors stay on screen, and the 120s total timeout is replaced by connect + 90s stall timeouts (files stream to disk).
- Project names with characters the PDF fonts can't encode (e.g. emoji) no longer make export fail.
- Windows: export paths with `\` separators display correctly; "Show in Finder" reads "Show in folder".

### Changed
- **Preview renders the real page**: drawing goes through a small painter interface (`src/lib/painter.ts`) with pdf-lib and SVG back ends, so the preview and the exported PDF come from the same code. Added zoom (buttons, Ctrl+scroll, Fit page/width, 100%) and drag-to-pan.
- Preview element changes are staged behind a **Save & Apply** button; the Preview re-reads the project on each visit.
- Layers tab fits and outlines the printed area (and follows it when the area changes) instead of centring once at a fixed zoom.
- Area tab shades the parts of the paper footprint that won't print as map, so the clear window is exactly the printed extent.

### Added
- Settings → Display: **Text size** (Normal / Large / Larger / Largest; default Large, via native webview zoom — new `core:webview:allow-set-webview-zoom` capability) and **Wide / curved screen** layout (Auto-detects 21:9+ monitors, or On/Off) that centres the app in a comfortable-width column.
- Settings dialog **Save & Close** button; settings changes broadcast so open screens update immediately.

## [0.0.1] - 2026-08-18

Initial prerelease. **macOS only** — see the `macos` tag; a universal (arm64 + x86_64) build. Unsigned/not notarized, so Gatekeeper requires right-click → Open on first launch. The Xcode/Swift build (`swift-app/`) isn't packaged in this release — its signing isn't set up yet.

### Added
- Initial commit of the Tauri v2 desktop app: custom paper size/scale/multi-sheet layouts, land-access overlays, USFS road/trail data, magnetic declination (WMM2025) and compass rose, offline-first county data download.
- `README.md`, documenting the dual Tauri/Swift build architecture and current state coverage (Colorado, Wyoming).
- Dependabot: version updates (`.github/dependabot.yml`, npm/cargo/GitHub Actions, weekly), security updates, and alerts.
- `code-quality.yml` CI workflow (frontend typecheck+build via Yarn, `cargo check`/`clippy`/`fmt` for the Rust backend) as a practical substitute for GitHub's native Code Quality product, which needs GitHub Advanced Security (not available on this repo's plan for a private repo — same blocker affects code scanning and secret scanning).

### Fixed
- CI workflow used `npm ci` against a Yarn-only project (no `package-lock.json`) — switched to `yarn install`/`yarn build`.
- CI pinned Node 20; a dependency (`@mapbox/jsonlint-lines-primitives`, pulled in by maplibre-gl) requires Node ≥22 — bumped the workflow.
- Existing Rust source wasn't `rustfmt`-clean — applied `cargo fmt` (whitespace only).
- `tauri.conf.json`'s version wasn't bumped along with `package.json`/`Cargo.toml` for the 0.0.1 release — corrected.
- App icon (`icon.jpeg`) had a checkerboard "transparency placeholder" baked into its pixels (JPEG has no alpha channel), visible behind the logo in every generated icon size. `scripts/strip_icon_checkerboard.py` rebuilds it: strip the checkerboard to real transparency, then composite onto an opaque cream/parchment background per Apple's macOS HIG (macOS icons must be fully opaque and fill the canvas themselves — a transparent icon is nearly invisible against the Dock's dark material in dark mode). `make_icons.sh` now sources the corrected `icon.png`. Not shipped in the 0.0.1 build — lands with the next code release.

### Dependencies
Bumped via Dependabot (individual PR commit history for these was lost during a later `git filter-repo` identity rewrite — see below — but the resulting versions are unchanged and verified against the live files):
- `actions/checkout` 4→7, `actions/setup-node` 4→7
- `uuid` 1.24.0→1.24.1 (Rust)
- `@vitejs/plugin-react` 4.7.0→5.2.0
- `typescript` 5.9.3→7.0.2
- `maplibre-gl` 4.7.1→6.3.0 — required real code fixes: v6 dropped the default export entirely (`import * as maplibregl` instead of a default import, across 4 files), the global `GeoJSON.*` namespace disappeared (it had only ever arrived via a triple-slash reference inside maplibre-gl v4's own types — added `@types/geojson` as an explicit dependency instead), and `preserveDrawingBuffer` moved into a nested `canvasContextAttributes` object.
- `react`/`react-dom`/`@types/react` 18→19 — required a real code fix: the global `JSX` namespace moved to `React.JSX` (switched to `ReactElement` from `"react"`). Also caught and fixed a related gap Dependabot's grouping missed: `@types/react-dom` stayed on ^18 while everything else moved to ^19.

### Repository housekeeping
- Renamed the default branch from `main` to `master`.
- Rewrote all commit authors/committers across every branch to `scotCW <299917302+scotCW@users.noreply.github.com>` — earlier commits had accidentally picked up a real name and university email from local git config. This was a hard history rewrite (new SHAs, force-pushed); it's why the five dependency-bump PRs above don't show individual commits in the current history even though their changes are all present.
