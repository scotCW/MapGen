#!/usr/bin/env python3
"""
One-time fix: icon.jpeg's "transparent" background was exported from a design
tool with its checkerboard placeholder baked into the pixels (JPEG has no
alpha channel, so the tool flattened onto its own UI convention for
transparency instead of a solid color). This produced a visible grey/white
checkerboard behind the logo in every generated app icon.

Rebuilds icon.jpeg as icon.png with real alpha transparency in two passes:

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
    Image.fromarray(rgba.astype(np.uint8), mode="RGBA").save(OUT)
    print(f"wrote {OUT} ({is_bg.sum()}/{h*w} px transparent, {is_bg.sum()/(h*w)*100:.1f}%)")


if __name__ == "__main__":
    main()
