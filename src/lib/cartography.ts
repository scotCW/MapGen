/**
 * Cartographic elements drawn into a pdf-lib PDFPage.
 * All coordinates use pdf-lib's convention: (0,0) = bottom-left, y increases upward.
 */

import type { PDFPage, PDFFont } from "pdf-lib";
import { rgb } from "pdf-lib";
import type { Bounds } from "./geo";
import { WMM_MODEL_YEAR } from "./wmm";

// ---------------------------------------------------------------------------
// Color palette (all light-themed — print is always light)
// ---------------------------------------------------------------------------

const BLACK  = rgb(0, 0, 0);
const WHITE  = rgb(1, 1, 1);
const GREY   = rgb(0.45, 0.45, 0.45);
const LGREY  = rgb(0.85, 0.85, 0.85);
const RED    = rgb(0.70, 0.07, 0.07);
const DKBLUE = rgb(0.04, 0.22, 0.52);

// ---------------------------------------------------------------------------
// Neatline
// ---------------------------------------------------------------------------

export function drawNeatline(
  page: PDFPage,
  x: number, y: number,
  w: number, h: number,
  lineWidth = 1.5,
) {
  // Inner hairline
  page.drawRectangle({
    x, y, width: w, height: h,
    borderColor: BLACK, borderWidth: lineWidth,
  });
  // Outer thicker border offset by 2pt
  page.drawRectangle({
    x: x - 3, y: y - 3, width: w + 6, height: h + 6,
    borderColor: BLACK, borderWidth: 0.75,
  });
}

// ---------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------

export interface TitleBlockOptions {
  x: number; y: number; width: number; height: number;
  title: string;
  subtitle: string;  // "Colorado · Larimer County"
  scale: number;     // 24000
  dateStr: string;   // "2026-03-15"
  sheetRef: string;  // "Sheet 1 of 1"
  font: PDFFont;
  fontBold: PDFFont;
}

export function drawTitleBlock(page: PDFPage, opts: TitleBlockOptions) {
  const { x, y, width, height, font, fontBold } = opts;

  // Background
  page.drawRectangle({ x, y, width, height, color: WHITE, borderColor: LGREY, borderWidth: 0.5 });

  const mid = y + height / 2;
  // Title (left-aligned, bold)
  page.drawText(opts.title, {
    x: x + 8, y: mid + 2,
    font: fontBold, size: 11, color: BLACK,
  });
  // Subtitle line
  const sub = `${opts.subtitle}   |   Scale 1:${opts.scale.toLocaleString()}   |   ${opts.dateStr}   |   ${opts.sheetRef}`;
  page.drawText(sub, {
    x: x + 8, y: mid - 9,
    font, size: 7, color: GREY,
  });

  // Right-side branding
  const brand = "Hunting Map Generator";
  const brandW = font.widthOfTextAtSize(brand, 7);
  page.drawText(brand, {
    x: x + width - brandW - 8,
    y: mid - 3,
    font, size: 7, color: GREY,
  });
}

// ---------------------------------------------------------------------------
// Scale bar
// ---------------------------------------------------------------------------

export interface ScaleBarOptions {
  x: number; y: number;
  font: PDFFont;
  scale: number;         // e.g. 24000
  pageWidthPt: number;   // used for ratio bar width
}

// A round-number progression for scale-bar segment lengths. Includes
// sub-1 steps because a single segment easily represents more than a mile
// of ground at typical USGS topo scales (1:24,000 => ~1 mile in ~190pt),
// so without them the bar would still collapse toward one giant segment.
const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function niceScaleUnit(target: number): number {
  let best = NICE_STEPS[0];
  for (const step of NICE_STEPS) {
    if (step <= target) best = step; else break;
  }
  return best;
}

function formatUnitLabel(value: number): string {
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function drawScaleBar(page: PDFPage, opts: ScaleBarOptions) {
  const { x, y, font, scale, pageWidthPt } = opts;

  // Bar width in points: barUnits * (ground units per paper inch) * pt/inch.
  // 1 inch on paper = scale inches on ground = scale/63360 miles = scale/39370.08 km.
  const PT_PER_IN = 72;
  const ptsPerMile = PT_PER_IN * 63360 / scale;   // paper pts per ground mile
  const ptsPerKm   = PT_PER_IN * 39370.08 / scale; // paper pts per ground km

  // Always land on a fixed number of segments with a "nice" round distance
  // each (0.25 mi, 0.5 mi, 1 mi, 2 mi, ...) rather than rounding the total
  // bar length to the nearest whole unit — the latter is what previously
  // collapsed to a single segment at ordinary topo scales (round(1 mile in
  // ~190pt) when the target width was only 110pt).
  const SEGMENTS = 4;
  const targetPts = Math.max(120, Math.min(200, pageWidthPt * 0.28));
  const barH      = 6;
  const yBar      = y + 18;

  // ── Miles bar ────────────────────────────────────────────────────────────
  const mileUnit = niceScaleUnit(targetPts / ptsPerMile / SEGMENTS);
  const segMilePts = mileUnit * ptsPerMile;
  const barW = segMilePts * SEGMENTS;
  for (let i = 0; i < SEGMENTS; i++) {
    page.drawRectangle({
      x: x + i * segMilePts, y: yBar,
      width: segMilePts, height: barH,
      color: i % 2 === 0 ? BLACK : WHITE,
      borderColor: BLACK, borderWidth: 0.4,
    });
  }
  for (let i = 0; i <= SEGMENTS; i++) {
    const label = formatUnitLabel(i * mileUnit);
    const lw = font.widthOfTextAtSize(label, 5.5);
    page.drawText(label, {
      x: x + i * segMilePts - lw / 2, y: yBar + barH + 1.5,
      font, size: 5.5, color: BLACK,
    });
  }
  page.drawText("Miles", {
    x: x + barW + 4, y: yBar + 1,
    font, size: 6, color: BLACK,
  });

  // ── Kilometres bar ────────────────────────────────────────────────────────
  const yKm = yBar - barH - 4;
  const kmUnit = niceScaleUnit(targetPts / ptsPerKm / SEGMENTS);
  const segKmPts = kmUnit * ptsPerKm;
  const barKmW = segKmPts * SEGMENTS;
  for (let i = 0; i < SEGMENTS; i++) {
    page.drawRectangle({
      x: x + i * segKmPts, y: yKm,
      width: segKmPts, height: barH,
      color: i % 2 === 0 ? WHITE : BLACK,
      borderColor: BLACK, borderWidth: 0.4,
    });
  }
  for (let i = 0; i <= SEGMENTS; i++) {
    const label = formatUnitLabel(i * kmUnit);
    const lw = font.widthOfTextAtSize(label, 5.5);
    page.drawText(label, {
      x: x + i * segKmPts - lw / 2, y: yKm - 7,
      font, size: 5.5, color: BLACK,
    });
  }
  page.drawText("km", {
    x: x + barKmW + 4, y: yKm + 1,
    font, size: 6, color: BLACK,
  });

  // Ratio text below both bars — clear of the km bar's tick labels (yKm - 7)
  // and its own descender, which is the fix for the ratio text visually
  // colliding with the tick number "1" that sat almost directly above it.
  page.drawText(`1:${scale.toLocaleString()}`, {
    x: x, y: yKm - 18,
    font, size: 7, color: BLACK,
  });
}

// ---------------------------------------------------------------------------
// Compass rose  (drawn entirely with pdf-lib geometric primitives)
// ---------------------------------------------------------------------------

export interface CompassRoseOptions {
  cx: number; cy: number;   // centre point in pts
  radius: number;            // outer radius in pts
  declDeg: number;           // magnetic declination, degrees (+ = East)
  font: PDFFont;
  fontBold: PDFFont;
}

export function drawCompassRose(page: PDFPage, opts: CompassRoseOptions) {
  const { cx, cy, radius: R, declDeg, font, fontBold } = opts;

  const d2r = (d: number) => d * Math.PI / 180;

  // Background circle
  page.drawCircle({ x: cx, y: cy, size: R + 4, color: WHITE, borderColor: LGREY, borderWidth: 0.5 });

  // ── True north arrow ─────────────────────────────────────────────────────
  drawArrow(page, cx, cy, 0, R * 0.85, R * 0.13, BLACK, WHITE);
  page.drawText("N", {
    x: cx - fontBold.widthOfTextAtSize("N", 8) / 2,
    y: cy + R * 0.85 + 2,
    font: fontBold, size: 8, color: BLACK,
  });

  // ── Magnetic north arrow (dashed / lighter) ──────────────────────────────
  const mAngle = d2r(declDeg); // CCW from geographic north (pdf: north = up = +y)
  const mDirX  =  Math.sin(mAngle);
  const mDirY  =  Math.cos(mAngle);
  const mnLen  = R * 0.72;
  drawDashedLine(page,
    cx, cy, cx + mDirX * mnLen, cy + mDirY * mnLen,
    [3, 2], DKBLUE, 0.8,
  );
  // Arrowhead
  const tip = { x: cx + mDirX * mnLen, y: cy + mDirY * mnLen };
  const perpX = -mDirY * (R * 0.07);
  const perpY =  mDirX * (R * 0.07);
  page.drawLine({
    start: tip, end: { x: tip.x - mDirX * R * 0.12 + perpX, y: tip.y - mDirY * R * 0.12 + perpY },
    thickness: 0.7, color: DKBLUE,
  });
  page.drawLine({
    start: tip, end: { x: tip.x - mDirX * R * 0.12 - perpX, y: tip.y - mDirY * R * 0.12 - perpY },
    thickness: 0.7, color: DKBLUE,
  });

  // MN label
  const mnLabelX = cx + mDirX * (mnLen + 4);
  const mnLabelY = cy + mDirY * (mnLen + 4);
  page.drawText("MN", {
    x: mnLabelX - fontBold.widthOfTextAtSize("MN", 5) / 2,
    y: mnLabelY - 2,
    font: fontBold, size: 5, color: DKBLUE,
  });

  // ── Cardinal spokes S / E / W ─────────────────────────────────────────────
  for (const [angle, label] of [
    [180, "S"], [90, "E"], [270, "W"],
  ] as [number, string][]) {
    const rad = d2r(angle);
    const dx  =  Math.sin(rad);
    const dy  = -Math.cos(rad);
    page.drawLine({
      start: { x: cx, y: cy },
      end:   { x: cx + dx * R * 0.55, y: cy + dy * R * 0.55 },
      thickness: 0.6, color: GREY,
    });
    page.drawText(label, {
      x: cx + dx * (R * 0.6) - font.widthOfTextAtSize(label, 6) / 2,
      y: cy + dy * (R * 0.6) - 3,
      font, size: 6, color: GREY,
    });
  }

  // ── Declination angle label ───────────────────────────────────────────────
  const sign   = declDeg >= 0 ? "E" : "W";
  const absDec = Math.abs(declDeg);
  const decLabel = `${absDec.toFixed(1)}°${sign}`;
  const modelLbl = WMM_MODEL_YEAR;
  page.drawText(decLabel, {
    x: cx - font.widthOfTextAtSize(decLabel, 5.5) / 2,
    y: cy - R * 0.55 - 7,
    font, size: 5.5, color: DKBLUE,
  });
  page.drawText(modelLbl, {
    x: cx - font.widthOfTextAtSize(modelLbl, 4.5) / 2,
    y: cy - R * 0.55 - 14,
    font, size: 4.5, color: GREY,
  });
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export interface LegendEntry {
  label: string;
  color: string;   // hex "#rrggbb"
  dash?: boolean;  // if true, draw as a dashed line instead of fill swatch
}

export interface LegendOptions {
  x: number; y: number; width: number;
  entries: LegendEntry[];
  font: PDFFont;
  fontBold: PDFFont;
}

export function drawLegend(page: PDFPage, opts: LegendOptions) {
  const { x, y, width, entries, font, fontBold } = opts;
  if (entries.length === 0) return;

  const ROW_H    = 11;
  const SWATCH   = 8;
  const PAD      = 4;
  // Space reserved for the title, separate from the row loop below — this is
  // the fix for the first swatch visually intersecting "Legend": the swatch
  // top used to land just 1pt below the title's own baseline, at the same
  // x-position as the "L", with no headroom for the title's ascender.
  const TITLE_H  = 16;
  const totalH   = TITLE_H + entries.length * ROW_H + PAD;

  // Background
  page.drawRectangle({
    x, y, width, height: totalH,
    color: WHITE, borderColor: LGREY, borderWidth: 0.5,
  });

  page.drawText("Legend", {
    x: x + PAD, y: y + totalH - 11,
    font: fontBold, size: 7, color: BLACK,
  });

  for (let i = 0; i < entries.length; i++) {
    const e  = entries[i];
    const ey = y + totalH - TITLE_H - SWATCH - i * ROW_H;
    const fc = hexToRgb(e.color);

    if (e.dash) {
      // Line entry (e.g., routes)
      drawDashedLine(page, x + PAD, ey + 4, x + PAD + SWATCH, ey + 4, [2, 1.5], fc, 1.2);
    } else {
      page.drawRectangle({
        x: x + PAD, y: ey, width: SWATCH, height: SWATCH,
        color: fc, borderColor: BLACK, borderWidth: 0.4,
      });
    }
    page.drawText(e.label, {
      x: x + PAD + SWATCH + 4, y: ey + 1,
      font, size: 6.5, color: BLACK,
    });
  }
}

// ---------------------------------------------------------------------------
// Lat/Lon grid
// ---------------------------------------------------------------------------

export interface GridOptions {
  mapX: number; mapY: number; mapW: number; mapH: number;
  bounds: Bounds;
  font: PDFFont;
  /** Explicit interval in degrees; if omitted, chosen automatically. */
  intervalDeg?: number;
}

export function drawLatLonGrid(page: PDFPage, opts: GridOptions) {
  const { mapX, mapY, mapW, mapH, bounds, font } = opts;
  const { west, east, south, north } = bounds;

  const spanLon = east - west;
  const spanLat = north - south;
  const maxSpan = Math.max(spanLon, spanLat);

  const interval = opts.intervalDeg ?? pickInterval(maxSpan);

  // Helpers: geo → page coords
  const geoToX = (lon: number) => mapX + ((lon - west) / spanLon) * mapW;
  const geoToY = (lat: number) => mapY + ((lat - south) / spanLat) * mapH;

  // First gridline values
  const lon0 = Math.ceil(west  / interval) * interval;
  const lat0 = Math.ceil(south / interval) * interval;

  const lineColor = rgb(0.55, 0.55, 0.55);

  // Longitude lines (vertical)
  for (let lon = lon0; lon < east; lon = +(lon + interval).toFixed(8)) {
    const px = geoToX(lon);
    if (px < mapX || px > mapX + mapW) continue;
    drawDashedLine(page, px, mapY, px, mapY + mapH, [3, 3], lineColor, 0.4);
    // Label at bottom edge
    const lbl = formatLon(lon);
    const lw  = font.widthOfTextAtSize(lbl, 5);
    page.drawText(lbl, {
      x: px - lw / 2, y: mapY - 9,
      font, size: 5, color: GREY,
    });
    // Label at top edge
    page.drawText(lbl, {
      x: px - lw / 2, y: mapY + mapH + 2,
      font, size: 5, color: GREY,
    });
  }

  // Latitude lines (horizontal)
  for (let lat = lat0; lat < north; lat = +(lat + interval).toFixed(8)) {
    const py = geoToY(lat);
    if (py < mapY || py > mapY + mapH) continue;
    drawDashedLine(page, mapX, py, mapX + mapW, py, [3, 3], lineColor, 0.4);
    // Left label
    const lbl = formatLat(lat);
    const lh  = 5;
    page.drawText(lbl, {
      x: mapX - font.widthOfTextAtSize(lbl, lh) - 2, y: py - 2,
      font, size: lh, color: GREY,
    });
    // Right label
    page.drawText(lbl, {
      x: mapX + mapW + 2, y: py - 2,
      font, size: lh, color: GREY,
    });
  }

  // Datum note
  page.drawText("WGS84", {
    x: mapX + 2, y: mapY + 2,
    font, size: 4.5, color: GREY,
  });
}

// ---------------------------------------------------------------------------
// Disclaimer block (mandatory §6.3)
// ---------------------------------------------------------------------------

export function drawDisclaimerBlock(
  page: PDFPage,
  x: number, y: number, width: number, height: number,
  disclaimerText: string,
  font: PDFFont,
  fontBold: PDFFont,
) {
  page.drawRectangle({
    x, y, width, height,
    color: rgb(1.0, 0.97, 0.97),
    borderColor: rgb(0.75, 0.15, 0.15),
    borderWidth: 0.5,
  });

  const maxW   = width - 16;
  const fSize  = 6.5;
  const lineH  = fSize * 1.4;
  const lines  = wrapText(disclaimerText, font, fSize, maxW);
  const label  = "WARNING: ";
  const labelW = fontBold.widthOfTextAtSize(label, fSize);

  let ty = y + height - 5 - fSize;
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      page.drawText(label, { x: x + 8, y: ty, font: fontBold, size: fSize, color: RED });
      page.drawText(lines[i], { x: x + 8 + labelW, y: ty, font, size: fSize, color: RED });
    } else {
      page.drawText(lines[i], { x: x + 8 + labelW, y: ty, font, size: fSize, color: RED });
    }
    ty -= lineH;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function filledTriangle(
  page: PDFPage,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  fill: ReturnType<typeof rgb>,
  border: ReturnType<typeof rgb>,
) {
  // pdf-lib drawSvgPath uses SVG coords (y increases downward) placed at (x, y) in PDF space.
  // svg_x = pdf_x - minX,  svg_y = maxY - pdf_y
  const minX = Math.min(p1.x, p2.x, p3.x);
  const maxY = Math.max(p1.y, p2.y, p3.y);
  const sx = (p: { x: number; y: number }) => (p.x - minX).toFixed(2);
  const sy = (p: { x: number; y: number }) => (maxY - p.y).toFixed(2);
  const path = `M ${sx(p1)} ${sy(p1)} L ${sx(p2)} ${sy(p2)} L ${sx(p3)} ${sy(p3)} Z`;
  try {
    page.drawSvgPath(path, { x: minX, y: maxY, color: fill, borderColor: border, borderWidth: 0.3 });
  } catch {
    page.drawLine({ start: p1, end: p2, thickness: 1, color: fill });
    page.drawLine({ start: p2, end: p3, thickness: 1, color: fill });
    page.drawLine({ start: p3, end: p1, thickness: 1, color: fill });
  }
}

function drawArrow(
  page: PDFPage,
  cx: number, cy: number,
  angleDeg: number,   // 0 = north = up
  length: number,
  halfBase: number,
  colorN: ReturnType<typeof rgb>,
  colorS: ReturnType<typeof rgb>,
) {
  const rad  = (angleDeg * Math.PI) / 180;
  const dx   =  Math.sin(rad);
  const dy   =  Math.cos(rad);
  const px   = -dy;
  const py   =  dx;
  const tip  = { x: cx + dx * length,         y: cy + dy * length };
  const base = { x: cx - dx * (length * 0.3), y: cy - dy * (length * 0.3) };
  const lft  = { x: base.x + px * halfBase,   y: base.y + py * halfBase };
  const rgt  = { x: base.x - px * halfBase,   y: base.y - py * halfBase };
  const cnt  = { x: cx,                        y: cy };

  filledTriangle(page, tip, lft, cnt, colorN, BLACK);
  filledTriangle(page, tip, rgt, cnt, colorS, BLACK);
}

function drawDashedLine(
  page: PDFPage,
  x1: number, y1: number,
  x2: number, y2: number,
  dash: [number, number],
  color: ReturnType<typeof rgb>,
  thickness: number,
) {
  const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  if (len === 0) return;
  const dx  = (x2 - x1) / len;
  const dy  = (y2 - y1) / len;
  let t = 0;
  let drawing = true;
  while (t < len) {
    const segLen = Math.min(dash[drawing ? 0 : 1], len - t);
    if (drawing) {
      page.drawLine({
        start: { x: x1 + dx * t,           y: y1 + dy * t },
        end:   { x: x1 + dx * (t + segLen), y: y1 + dy * (t + segLen) },
        thickness, color,
      });
    }
    t += segLen;
    drawing = !drawing;
  }
}

function pickInterval(spanDeg: number): number {
  if (spanDeg < 0.15)  return 0.05;
  if (spanDeg < 0.4)   return 0.1;
  if (spanDeg < 1.0)   return 0.25;
  if (spanDeg < 3.0)   return 0.5;
  return 1.0;
}

function formatLat(deg: number): string {
  const d = Math.abs(deg);
  const dd = Math.floor(d);
  const mm = Math.round((d - dd) * 60);
  return `${dd}°${mm.toString().padStart(2, "0")}'${deg >= 0 ? "N" : "S"}`;
}

function formatLon(deg: number): string {
  const d = Math.abs(deg);
  const dd = Math.floor(d);
  const mm = Math.round((d - dd) * 60);
  return `${dd}°${mm.toString().padStart(2, "0")}'${deg >= 0 ? "E" : "W"}`;
}

export function hexToRgb(hex: string): ReturnType<typeof rgb> {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
