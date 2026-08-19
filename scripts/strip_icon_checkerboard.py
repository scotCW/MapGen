#!/usr/bin/env python3
"""
One-time fix: icon.jpeg's "transparent" background was exported from a design
tool with its checkerboard placeholder baked into the pixels (JPEG has no
alpha channel, so the tool flattened onto its own UI convention for
transparency instead of a solid color). This produced a visible grey/white
checkerboard behind the logo in every generated app icon.

Rebuilds icon.jpeg as icon.png in three steps:

1. Flood-fill from the image border through pixels close to either checker
   color. This is the safe pass — it can't touch real artwork, since real
   design elements (the pin's white inner ring, contour linework, compass
   fill) aren't colored *and* connected all the way out to the edge.
2. A handful of background pockets are fully enclosed by artwork (e.g. the
   gaps between the deer's legs) and pass 1 can't reach them. For those,
   label the remaining checker-colored regions and keep only the ones that
   contain a real mix of *both* checker colors — true checkerboard patches
   alternate, whereas solid single-color artwork (like a real white ring)
   does not, so this can't misfire on real design content.
3. Composite the now-transparent artwork onto an opaque cream/parchment
   background, sized to an ~82% safe zone. Apple's HIG requires macOS app
   icons to be fully opaque and fill the canvas themselves — unlike iOS,
   macOS doesn't apply its own background/mask, so a transparent icon (steps
   1-2 alone) is nearly invisible against the Dock's dark translucent
   material in dark mode.

Requires: pillow, numpy, scipy (pip3 install --user pillow numpy scipy).
Run: python3 scripts/strip_icon_checkerboard.py
Then regenerate the platform icons with scripts/make_icons.sh.
"""
import os
from collections import deque

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "icon.jpeg")
OUT = os.path.join(REPO, "icon.png")

# Measured directly from icon.jpeg's checkerboard pixels — re-measure if the
# source is ever re-exported (sample a strip of pure background and take the
# two most common colors; see git history for how these were derived).
CHECKER_COLORS = [(254, 254, 254), (243, 243, 243)]
TOL = 6
MIN_POCKET_SIZE = 20
MIN_COLOR_FRAC = 0.15  # each checker color must be at least this much of a pocket

# Step 3: final opaque composite, per Apple's macOS app icon guidelines.
BACKGROUND = (244, 236, 214)  # warm parchment/map-paper cream
SAFE_ZONE_FRAC = 0.82  # artwork's longer dimension fills this fraction of the canvas


def main() -> None:
    im = Image.open(SRC).convert("RGB")
    arr = np.array(im).astype(np.int16)
    h, w, _ = arr.shape

    is_white = np.abs(arr - np.array(CHECKER_COLORS[0])).max(axis=2) <= TOL
    is_grey = np.abs(arr - np.array(CHECKER_COLORS[1])).max(axis=2) <= TOL
    match_grid = is_white | is_grey

    # Pass 1: border-seeded flood fill.
    visited = np.zeros((h, w), dtype=bool)
    is_bg = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not visited[y, x] and match_grid[y, x]:
                visited[y, x] = True
                is_bg[y, x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not visited[y, x] and match_grid[y, x]:
                visited[y, x] = True
                is_bg[y, x] = True
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny, nx] and match_grid[ny, nx]:
                visited[ny, nx] = True
                is_bg[ny, nx] = True
                q.append((nx, ny))

    # Pass 2: enclosed checker pockets — require a real mix of both colors.
    remaining = match_grid & ~is_bg
    labels, n = ndimage.label(remaining, structure=np.ones((3, 3)))
    for lbl in range(1, n + 1):
        comp = labels == lbl
        size = comp.sum()
        if size < MIN_POCKET_SIZE:
            continue
        white_frac = (comp & is_white).sum() / size
        grey_frac = (comp & is_grey).sum() / size
        if white_frac >= MIN_COLOR_FRAC and grey_frac >= MIN_COLOR_FRAC:
            is_bg |= comp

    alpha = np.where(is_bg, 0, 255).astype(np.uint8)
    rgba = np.dstack([np.array(im), alpha])
    transparent = Image.fromarray(rgba.astype(np.uint8), mode="RGBA")

    # Step 3: composite onto an opaque canvas, safe-zone-scaled and centered.
    content_alpha = np.array(transparent)[:, :, 3]
    rows = np.any(content_alpha > 10, axis=1)
    cols = np.any(content_alpha > 10, axis=0)
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    content = transparent.crop((cmin, rmin, cmax + 1, rmax + 1))
    cw, ch = content.size

    scale = (max(h, w) * SAFE_ZONE_FRAC) / max(cw, ch)
    new_w, new_h = int(cw * scale), int(ch * scale)
    content_resized = content.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (w, h), BACKGROUND + (255,))
    canvas.paste(content_resized, ((w - new_w) // 2, (h - new_h) // 2), content_resized)
    canvas.convert("RGB").save(OUT)  # no alpha channel — Apple requires macOS icons be fully opaque
    print(f"wrote {OUT} ({w}x{h}, opaque, artwork at {SAFE_ZONE_FRAC*100:.0f}% safe zone)")


if __name__ == "__main__":
    main()
