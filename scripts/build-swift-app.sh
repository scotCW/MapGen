#!/usr/bin/env bash
# build-swift-app.sh — builds the Swift/WKWebView version of Hunting Map Generator.
#
# Usage:
#   ./scripts/build-swift-app.sh          # release build (universal binary)
#   ./scripts/build-swift-app.sh --debug  # debug build (native arch only)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SWIFT_APP="$REPO_ROOT/swift-app"

# ── 1. Build the React frontend ───────────────────────────────────────────────
echo "==> Building React frontend (Vite)..."
cd "$REPO_ROOT"
yarn build   # produces dist/

# ── 2. Copy dist/ into the Swift app's resource tree ─────────────────────────
echo "==> Copying frontend assets into Swift bundle resources..."
RESOURCES_DIR="$SWIFT_APP/Sources/HuntingMapGenerator/Resources"
rm -rf "$RESOURCES_DIR/dist"
cp -r "$REPO_ROOT/dist" "$RESOURCES_DIR/dist"

# ── 3. Build the Swift app ────────────────────────────────────────────────────
cd "$SWIFT_APP"

if [[ "${1:-}" == "--debug" ]]; then
    echo "==> Building Swift app (debug, native arch)..."
    swift build --product HuntingMapGenerator
    echo "==> Done. Binary: $SWIFT_APP/.build/debug/HuntingMapGenerator"
else
    echo "==> Building Swift app (release, universal binary)..."
    swift build -c release \
        --arch arm64 --arch x86_64 \
        --product HuntingMapGenerator
    echo "==> Done. Binary: $SWIFT_APP/.build/apple/Products/Release/HuntingMapGenerator"
fi
