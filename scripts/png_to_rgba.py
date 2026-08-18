#!/usr/bin/env python3
"""
Convert sRGB PNG files (color type 2) to RGBA (color type 6) in-place.
Uses only Python stdlib — no Pillow, no Homebrew dependencies.

Correctly handles all five PNG filter types (None, Sub, Up, Average, Paeth).
Required because sips produces RGB-only PNGs when converting from JPEG,
but Tauri's icon bundler requires RGBA.

License: Unlicense (public domain)
"""
import struct
import zlib
import sys


def paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def unfilter_row(filt: int, row: bytes, prev: bytes, bpp: int) -> bytes:
    """Reconstruct raw pixel bytes from a filtered PNG scanline."""
    out = bytearray(len(row))
    if filt == 0:  # None
        out[:] = row
    elif filt == 1:  # Sub
        for i, b in enumerate(row):
            a = out[i - bpp] if i >= bpp else 0
            out[i] = (b + a) & 0xFF
    elif filt == 2:  # Up
        for i, b in enumerate(row):
            out[i] = (b + prev[i]) & 0xFF
    elif filt == 3:  # Average
        for i, b in enumerate(row):
            a = out[i - bpp] if i >= bpp else 0
            out[i] = (b + (a + prev[i]) // 2) & 0xFF
    elif filt == 4:  # Paeth
        for i, b in enumerate(row):
            a = out[i - bpp] if i >= bpp else 0
            pb_ = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            out[i] = (b + paeth_predictor(a, pb_, c)) & 0xFF
    return bytes(out)


def make_png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFF_FFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def rgb_png_to_rgba(path: str) -> None:
    with open(path, "rb") as f:
        raw = f.read()

    PNG_SIG = b"\x89PNG\r\n\x1a\n"
    assert raw[:8] == PNG_SIG, f"{path}: not a PNG file"

    # Parse chunks
    pos = 8
    chunks: list[tuple[bytes, bytes]] = []
    while pos < len(raw):
        n = struct.unpack(">I", raw[pos : pos + 4])[0]
        ctype = raw[pos + 4 : pos + 8]
        data = raw[pos + 8 : pos + 8 + n]
        chunks.append((ctype, data))
        pos += 12 + n

    # Validate IHDR
    ihdr_data = next(d for t, d in chunks if t == b"IHDR")
    width, height = struct.unpack(">II", ihdr_data[:8])
    bit_depth = ihdr_data[8]
    color_type = ihdr_data[9]

    if color_type == 6:
        print(f"  skip {path} (already RGBA)")
        return
    assert color_type == 2, f"{path}: expected RGB (type 2), got type {color_type}"
    assert bit_depth == 8, f"{path}: only 8-bit depth supported"

    # Decompress all IDAT chunks
    compressed = b"".join(d for t, d in chunks if t == b"IDAT")
    pixel_data = zlib.decompress(compressed)

    stride = 1 + width * 3  # filter byte + 3 bytes/pixel
    assert len(pixel_data) == stride * height, "IDAT length mismatch"

    # Reconstruct raw pixels and convert to RGBA
    prev_row = bytes(width * 3)
    rgba_scanlines: list[bytes] = []
    for y in range(height):
        filt = pixel_data[y * stride]
        filtered = pixel_data[y * stride + 1 : y * stride + 1 + width * 3]
        raw_row = unfilter_row(filt, filtered, prev_row, bpp=3)
        prev_row = raw_row

        # Add opaque alpha byte after each RGB triplet
        rgba_row = bytearray()
        for x in range(width):
            rgba_row.extend(raw_row[x * 3 : x * 3 + 3])
            rgba_row.append(0xFF)

        rgba_scanlines.append(b"\x00" + bytes(rgba_row))  # filter type 0 = None

    # Build new IHDR with color_type = 6 (RGBA)
    new_ihdr = ihdr_data[:9] + b"\x06" + ihdr_data[10:]

    # Compress new pixel data
    new_idat = zlib.compress(b"".join(rgba_scanlines), level=6)

    # Write new PNG
    out = (
        PNG_SIG
        + make_png_chunk(b"IHDR", new_ihdr)
        + make_png_chunk(b"IDAT", new_idat)
        + make_png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(out)

    print(f"  RGBA: {path}  ({width}x{height})")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        rgb_png_to_rgba(p)
