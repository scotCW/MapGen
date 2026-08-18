# Third-Party Licenses

Hunting Map Generator is released into the public domain under the Unlicense.
It is built on top of the following open-source libraries, each of which
retains its own copyright and license terms.

---

## Summary

| License | Count | Notes |
|---------|-------|-------|
| MIT | ~117 crates + runtime JS | Permissive |
| MIT OR Apache-2.0 | ~326 crates | We elect MIT |
| Apache-2.0 | 3 crates | Permissive |
| BSD-3-Clause | 4 crates + MapLibre GL JS | Permissive, attribution required |
| ISC | 1 crate | MIT-equivalent |
| Zlib | 1 crate | Permissive |
| Unicode-3.0 | 18 crates (ICU data) | Permissive |
| Unlicense OR MIT | 11 crates | Public domain or MIT |
| MPL-2.0 | 5 crates (Servo CSS engine) | File-level copyleft — source on crates.io |
| CC-BY-4.0 | caniuse-lite | **Dev-build tool only — not bundled in the app** |

---

## JavaScript / Node runtime dependencies (bundled in app)

### MapLibre GL JS
- **License:** BSD-3-Clause
- **Source:** https://github.com/maplibre/maplibre-gl-js
- Copyright (c) 2020, MapLibre contributors
- Copyright (c) 2016-2020, Mapbox

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

### React and ReactDOM
- **License:** MIT
- **Source:** https://github.com/facebook/react
- Copyright (c) Meta Platforms, Inc. and affiliates.

### @tauri-apps/api
- **License:** MIT OR Apache-2.0 (we elect MIT)
- **Source:** https://github.com/tauri-apps/tauri

---

## Rust / Tauri backend dependencies

Tauri (https://github.com/tauri-apps/tauri) provides the desktop shell,
including WKWebView integration (macOS), WebView2 (Windows), and WebKitGTK
(Linux). The full dependency tree is compiled into the application binary.

### MIT OR Apache-2.0 crates (electing MIT)

The majority of Rust dependencies are dual-licensed MIT OR Apache-2.0.
These include: tauri, tauri-build, tauri-codegen, tauri-macros,
tauri-plugin-opener, tauri-plugin-shell, tauri-runtime, tauri-runtime-wry,
tauri-utils, wry, tao, muda, serde, serde_json, tokio, and many others.

We elect the MIT license for all dual-licensed packages.

### BSD-3-Clause crates

- cssparser-macros is BSD-3-Clause dual-licensed alongside MPL-2.0 (see below)
- uuid: BSD-3-Clause AND MIT

### MPL-2.0 crates (Mozilla Public License 2.0)

The following five crates originate from the Mozilla Servo project's CSS
engine. They are pulled in by Tauri's internal HTML processing (via dom_query
and wry). The Mozilla Public License 2.0 is a file-level copyleft license
that permits use in larger works under different licenses, provided the
MPL-licensed source files remain available.

Source is publicly available on crates.io and the repositories listed:

| Crate | Version | Source |
|-------|---------|--------|
| cssparser | 0.36.0 | https://github.com/servo/rust-cssparser |
| cssparser-macros | 0.6.1 | https://github.com/servo/rust-cssparser |
| dtoa-short | 0.3.5 | https://github.com/upsuper/dtoa-short |
| option-ext | 0.2.0 | https://github.com/soc/option-ext |
| selectors | 0.36.1 | https://github.com/servo/stylo |

A copy of the Mozilla Public License 2.0 is available at:
https://www.mozilla.org/en-US/MPL/2.0/

### Unicode-3.0 crates (ICU4X data)

ICU normalization and locale data crates (icu_normalizer, icu_properties,
icu_collections, icu_locale_core, etc.) carry the Unicode-3.0 license.
This is a permissive license for Unicode data files.
https://www.unicode.org/copyright.html

### Other permissive licenses

- **Zlib** (miniz_oxide, adler): https://opensource.org/licenses/Zlib
- **ISC** (signal-hook-registry): https://opensource.org/licenses/ISC
- **Apache-2.0 only** (embed-resource, unicode-ident, tauri-winres):
  https://www.apache.org/licenses/LICENSE-2.0
- **Unlicense OR MIT** (various small utilities): public domain or MIT

---

## Dev-build-only dependencies (NOT bundled in the distributed app)

The following tools are used only during development or the build process.
They are not included in the installed application:

- **TypeScript** (Apache-2.0) — https://github.com/microsoft/TypeScript
- **Vite** (MIT) — https://github.com/vitejs/vite
- **@vitejs/plugin-react** (MIT) — https://github.com/vitejs/vite-plugin-react
- **@tauri-apps/cli** (MIT OR Apache-2.0) — https://github.com/tauri-apps/tauri
- **caniuse-lite** (CC-BY-4.0) — used by Babel for browser targeting, not bundled
- **@types/\*** (MIT) — TypeScript declaration files

---

## Data sources used by the application (not bundled)

Map tile data is fetched live from public government servers and is not
included in the application binary:

- **USGS National Map** tiles — public domain (U.S. government work)
  https://www.usgs.gov/programs/national-geospatial-program/national-map
- **U.S. Geological Survey attribution** is displayed on every map per their
  terms of service.
