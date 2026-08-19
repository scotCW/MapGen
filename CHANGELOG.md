# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
