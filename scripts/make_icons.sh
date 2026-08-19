#!/usr/bin/env bash
# Converts icon.png → all required icon formats for Tauri and the Swift app.
# icon.png carries real alpha transparency (see strip_icon_checkerboard.py) —
# it's generated from the original icon.jpeg, which had a checkerboard
# "transparency placeholder" baked into its pixels since JPEG has no alpha.
# Uses only macOS system tools: sips, iconutil, python3 (stdlib only).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/icon.png"
ICONS_DIR="$REPO/src-tauri/icons"
ICONSET="$(mktemp -d)/icon.iconset"

if [[ ! -f "$SRC" ]]; then
  echo "Error: $SRC not found. Run scripts/strip_icon_checkerboard.py first." >&2
  exit 1
fi

mkdir -p "$ICONS_DIR" "$ICONSET"

echo "==> Source: $SRC ($(sips -g pixelWidth -g pixelHeight "$SRC" | awk '/pixel/{printf $2" "}')px)"

# ---------------------------------------------------------------------------
# Helper: resize PNG → PNG at WxH (sips preserves alpha)
# ---------------------------------------------------------------------------
RGBA_SCRIPT="$REPO/scripts/png_to_rgba.py"

resize() {
  local w=$1 h=$2 out=$3
  sips -z "$h" "$w" "$SRC" --out "$out" --setProperty format png -s formatOptions best > /dev/null 2>&1
  python3 "$RGBA_SCRIPT" "$out"  # no-op safety net if sips ever produces RGB-only
}

# ---------------------------------------------------------------------------
# Tauri required sizes
# ---------------------------------------------------------------------------
echo "==> Generating Tauri icons…"
resize 32  32  "$ICONS_DIR/32x32.png"
resize 128 128 "$ICONS_DIR/128x128.png"
resize 256 256 "$ICONS_DIR/128x128@2x.png"

# ---------------------------------------------------------------------------
# .iconset → .icns  (full Apple HiDPI set)
# ---------------------------------------------------------------------------
echo "==> Generating .iconset for iconutil…"
resize 16   16   "$ICONSET/icon_16x16.png"
resize 32   32   "$ICONSET/icon_16x16@2x.png"
resize 32   32   "$ICONSET/icon_32x32.png"
resize 64   64   "$ICONSET/icon_32x32@2x.png"
resize 128  128  "$ICONSET/icon_128x128.png"
resize 256  256  "$ICONSET/icon_128x128@2x.png"
resize 256  256  "$ICONSET/icon_256x256.png"
resize 512  512  "$ICONSET/icon_256x256@2x.png"
resize 512  512  "$ICONSET/icon_512x512.png"
resize 1024 1024 "$ICONSET/icon_512x512@2x.png"

echo "==> Running iconutil…"
iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"

# ---------------------------------------------------------------------------
# .ico — PNG-compressed ICO (Vista+), assembled from stdlib Python
# ---------------------------------------------------------------------------
echo "==> Generating icon.ico…"
ICO_16="$(mktemp /tmp/ico16.XXXXXX.png)"
ICO_32="$(mktemp /tmp/ico32.XXXXXX.png)"
ICO_48="$(mktemp /tmp/ico48.XXXXXX.png)"
ICO_256="$(mktemp /tmp/ico256.XXXXXX.png)"

resize 16  16  "$ICO_16"
resize 32  32  "$ICO_32"
resize 48  48  "$ICO_48"
resize 256 256 "$ICO_256"

python3 - "$ICO_16" "$ICO_32" "$ICO_48" "$ICO_256" "$ICONS_DIR/icon.ico" <<'PYEOF'
import sys, struct

paths = sys.argv[1:-1]
out   = sys.argv[-1]

images = []
for p in paths:
    with open(p, 'rb') as f:
        data = f.read()
    # Read PNG dimensions from IHDR chunk (bytes 16-24)
    w = struct.unpack('>I', data[16:20])[0]
    h = struct.unpack('>I', data[20:24])[0]
    images.append((w, h, data))

# ICO header: reserved=0, type=1 (icon), count
header = struct.pack('<HHH', 0, 1, len(images))

# Directory entries (16 bytes each); image data follows the directory
dir_offset = 6 + 16 * len(images)
entries = b''
blobs   = b''
for w, h, data in images:
    # width/height: 0 means 256 in ICO spec
    bw = 0 if w >= 256 else w
    bh = 0 if h >= 256 else h
    entries += struct.pack('<BBBBHHII',
        bw, bh,
        0,   # color count (0 = not palettized)
        0,   # reserved
        1,   # color planes
        32,  # bits per pixel
        len(data),
        dir_offset + len(blobs),
    )
    blobs += data

with open(out, 'wb') as f:
    f.write(header + entries + blobs)

print(f"  Wrote {len(images)}-image ICO → {out}")
PYEOF

# Cleanup temp files
rm -f "$ICO_16" "$ICO_32" "$ICO_48" "$ICO_256"

# ---------------------------------------------------------------------------
# Swift app — copy the .icns into swift-app Resources
# ---------------------------------------------------------------------------
SWIFT_RES="$REPO/swift-app/Sources/HuntingMapGenerator/Resources"
if [[ -d "$SWIFT_RES" ]]; then
  echo "==> Copying icon to swift-app resources…"
  cp "$ICONS_DIR/icon.icns" "$SWIFT_RES/AppIcon.icns"
fi

echo ""
echo "==> Done. Icons written to $ICONS_DIR"
ls -lh "$ICONS_DIR"
