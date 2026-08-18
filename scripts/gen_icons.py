"""
Generate placeholder app icons for Tauri.
Uses only Python stdlib — no PIL required.
Creates solid green squares at the required sizes.
Run: python3 scripts/gen_icons.py
"""
import struct
import zlib
import os

ICON_COLOR = (34, 102, 51, 255)  # Hunting green, fully opaque

def make_png(width: int, height: int, rgba: tuple[int, int, int, int]) -> bytes:
    r, g, b, a = rgba
    raw_rows = []
    for _ in range(height):
        row = b"\x00" + bytes([r, g, b, a] * width)
        raw_rows.append(row)
    raw = b"".join(raw_rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    idat = chunk(b"IDAT", compressed)
    iend = chunk(b"IEND", b"")
    return header + ihdr + idat + iend


out = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(out, exist_ok=True)

sizes = [
    ("32x32.png", 32, 32),
    ("128x128.png", 128, 128),
    ("128x128@2x.png", 256, 256),
]

for fname, w, h in sizes:
    path = os.path.join(out, fname)
    with open(path, "wb") as f:
        f.write(make_png(w, h, ICON_COLOR))
    print(f"  wrote {path} ({w}x{h})")

# icon.ico — minimal single-image ICO (32x32)
# ICO header + ICONDIRENTRY + PNG data
png32 = make_png(32, 32, ICON_COLOR)
ico_header = struct.pack("<HHH", 0, 1, 1)  # reserved, type=1 (ICO), count=1
entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png32), 22)
with open(os.path.join(out, "icon.ico"), "wb") as f:
    f.write(ico_header + entry + png32)
print(f"  wrote icon.ico")

# icon.icns — Apple Icon Image format
# Minimal ICNS with a single 128x128 PNG
png128 = make_png(128, 128, ICON_COLOR)
icns_type = b"ic07"  # 128x128 PNG
chunk_size = struct.pack(">I", 8 + len(png128))
icns_data = icns_type + chunk_size + png128
total_size = struct.pack(">I", 8 + len(icns_data))
with open(os.path.join(out, "icon.icns"), "wb") as f:
    f.write(b"icns" + total_size + icns_data)
print(f"  wrote icon.icns")

print("Icons generated successfully.")
