/**
 * Cartographic elements, drawn through the Painter interface so the exported
 * PDF and the Preview tab render from exactly the same code.
 *
 * All coordinates are PDF points: (0,0) = bottom-left, y increases upward.
 * Positions come from pageLayout.ts — nothing here invents its own band sizes.
 */

import type { Painter, RGB } from "./painter";
import type { Bounds } from "./geo";
import type { Box, PageLayout } from "./pageLayout";
import {
  textWidth, fitText,
  LABEL_FONT, LABEL_GAP, NEAT_PAD,
  DISC_FONT, DISC_LINE_H, DISC_PAD, DISC_LABEL,
} from "./pageLayout";
import type { SheetCell, SheetGrid } from "./sheetGrid";
import type { MapElements } from "../types/elements";
import { WMM_MODEL_YEAR } from "./wmm";

// ---------------------------------------------------------------------------
// Palette (print is always light)
// ---------------------------------------------------------------------------

const BLACK:  RGB = [0, 0, 0];
const WHITE:  RGB = [1, 1, 1];
const GREY:   RGB = [0.40, 0.40, 0.40];
const MGREY:  RGB = [0.55, 0.55, 0.55];
const LGREY:  RGB = [0.82, 0.82, 0.82];
const RED:    RGB = [0.66, 0.07, 0.07];
const DKBLUE: RGB = [0.04, 0.22, 0.52];
const HILITE: RGB = [0.18, 0.44, 0.76];

export interface LegendEntry {
  label: string;
  color: string;   // hex "#rrggbb"
  dash?: boolean;  // draw as a line sample instead of a fill swatch
}

// ---------------------------------------------------------------------------
// Whole page
// ---------------------------------------------------------------------------

export interface MapPageSpec {
  kind: "single" | "sheet" | "overview";
  layout: PageLayout;
  elements: MapElements;
  /** Painter image id for the rendered map raster. */
  imageId: string;
  /** Geographic extent of the map raster. */
  bounds: Bounds;
  title: string;
  subtitle: string;
  scale: number;
  dateStr: string;
  /** "Sheet A1 — Page 2 of 5" etc.; shown when sheetReference is on. */
  pageLabel: string;
  declDeg: number;
  declEpoch: string;
  legend: LegendEntry[];
  grid?: SheetGrid;
  cell?: SheetCell;
}

export function drawMapPage(p: Painter, s: MapPageSpec) {
  const { layout: L, elements: el } = s;
  const m = L.map;

  p.rect(0, 0, L.pageW, L.pageH, { fill: WHITE });
  p.image(s.imageId, m.x, m.y, m.w, m.h);

  if (s.kind === "overview" && s.grid) drawOverviewGrid(p, m, s.grid);

  if (el.gridLines) {
    drawLatLonGrid(p, m, s.bounds, L.coordLabels, el.neatline);
  }

  if (el.neatline) drawNeatline(p, m);

  if (el.compassRose) {
    const r = Math.max(18, Math.min(34, Math.min(m.w, m.h) * 0.09));
    drawCompassRose(p, m.x + m.w - r - 8, m.y + m.h - r - 8, r, s.declDeg, s.declEpoch);
  }

  if (s.kind === "sheet" && s.cell && el.edgeMatchMarkers) {
    drawEdgeMatchMarkers(p, m, s.cell);
  }

  if (L.title) {
    drawTitleBlock(p, L.title, {
      title: s.title,
      info: [
        s.subtitle,
        `Scale 1:${s.scale.toLocaleString("en-US")}`,
        s.dateStr,
        el.sheetReference ? s.pageLabel : "",
      ].filter(Boolean),
    });
  }

  if (L.scaleBand) {
    const showInset = s.kind === "sheet" && el.indexInset && !!s.grid && !!s.cell;
    drawScaleBand(p, L.scaleBand, {
      scale: s.scale,
      scaleBar: el.scaleBar,
      ratio: el.ratioScale,
      legend: el.legend ? s.legend : [],
      inset: showInset ? { grid: s.grid!, cell: s.cell! } : null,
    });
  }

  if (L.disclaimer) drawDisclaimerBlock(p, L.disclaimer, L.disclaimerLines);
}

// ---------------------------------------------------------------------------
// Neatline
// ---------------------------------------------------------------------------

function drawNeatline(p: Painter, m: Box) {
  p.rect(m.x, m.y, m.w, m.h, { stroke: BLACK, lineWidth: 1.5 });
  p.rect(m.x - 3, m.y - 3, m.w + 6, m.h + 6, { stroke: BLACK, lineWidth: 0.75 });
}

// ---------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------

function drawTitleBlock(p: Painter, b: Box, o: { title: string; info: string[] }) {
  p.rect(b.x, b.y, b.w, b.h, { fill: WHITE, stroke: LGREY, lineWidth: 0.5 });

  const pad   = 8;
  const brand = "Hunting Map Generator";
  const brandSize = 6.5;
  const brandW = textWidth(brand, brandSize);

  const titleSize = 12;
  const titleY = b.y + b.h - pad - titleSize + 2;
  p.text(fitText(o.title, titleSize, b.w - pad * 3 - brandW, true), b.x + pad, titleY, {
    size: titleSize, bold: true, color: BLACK,
  });
  p.text(brand, b.x + b.w - pad - brandW, titleY + 2, { size: brandSize, color: GREY });

  const infoSize = 7.5;
  p.text(fitText(o.info.join("   |   "), infoSize, b.w - pad * 2), b.x + pad, b.y + pad, {
    size: infoSize, color: GREY,
  });
}

// ---------------------------------------------------------------------------
// Scale band: scale bars + ratio on the left, index inset + legend on the right
// ---------------------------------------------------------------------------

const NICE_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

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

interface ScaleBandOpts {
  scale: number;
  scaleBar: boolean;
  ratio: boolean;
  legend: LegendEntry[];
  inset: { grid: SheetGrid; cell: SheetCell } | null;
}

function drawScaleBand(p: Painter, b: Box, o: ScaleBandOpts) {
  const GAP = 10;
  let right = b.x + b.w;

  // Legend (right-most), multi-column so it always fits the band height.
  if (o.legend.length > 0) {
    const w = legendWidth(o.legend.length, b);
    drawLegend(p, { x: right - w, y: b.y, w, h: b.h }, o.legend);
    right -= w + GAP;
  }

  // Index inset (multi-sheet only), left of the legend.
  if (o.inset) {
    const h = b.h - 6;
    const { rows, cols } = o.inset.grid;
    const w = Math.min(90, Math.max(24, h * (cols / rows)));
    const ih = Math.min(h, w * (rows / cols));
    drawIndexInset(p, { x: right - w, y: b.y + (b.h - ih) / 2, w, h: ih }, o.inset.grid, o.inset.cell);
    right -= w + GAP;
  }

  const left = b.x + 6;
  const avail = right - left;
  const top = b.y + b.h;

  if (o.scaleBar && avail > 60) {
    drawScaleBars(p, left, top, Math.min(200, avail - 26), o.scale);
    if (o.ratio) {
      p.text(`1:${o.scale.toLocaleString("en-US")}`, left, b.y + 6, { size: 8, bold: true, color: BLACK });
    }
  } else if (o.ratio) {
    p.text(`1:${o.scale.toLocaleString("en-US")}`, left, b.y + b.h / 2 - 4, { size: 10, bold: true, color: BLACK });
  }
}

/**
 * Miles bar above a km bar, both hanging from `top`. Vertical budget (pt from
 * top): mile labels 0–7, mile bar 9–15, km bar 17–23, km labels 24–31 — the
 * ratio text sits below at band.y+6 (≥ 14pt clear in the 58pt band).
 */
function drawScaleBars(p: Painter, x: number, top: number, targetPts: number, scale: number) {
  const SEGMENTS = 4;
  const BAR_H = 6;
  const LBL = 5.5;
  const ptsPerMile = 72 * 63360 / scale;
  const ptsPerKm   = 72 * 39370.08 / scale;

  const bar = (y: number, unit: number, ptsPerUnit: number, labelAbove: boolean, darkFirst: boolean, name: string) => {
    const seg = unit * ptsPerUnit;
    for (let i = 0; i < SEGMENTS; i++) {
      p.rect(x + i * seg, y, seg, BAR_H, {
        fill: (i % 2 === 0) === darkFirst ? BLACK : WHITE,
        stroke: BLACK, lineWidth: 0.4,
      });
    }
    for (let i = 0; i <= SEGMENTS; i++) {
      const lbl = formatUnitLabel(i * unit);
      const lw = textWidth(lbl, LBL);
      p.text(lbl, x + i * seg - lw / 2, labelAbove ? y + BAR_H + 2 : y - LBL - 1.5, { size: LBL, color: BLACK });
    }
    p.text(name, x + seg * SEGMENTS + 4, y + 0.5, { size: 6, color: BLACK });
  };

  const mileUnit = niceScaleUnit(targetPts / ptsPerMile / SEGMENTS);
  const kmUnit   = niceScaleUnit(targetPts / ptsPerKm / SEGMENTS);
  bar(top - 15, mileUnit, ptsPerMile, true,  true,  "Miles");
  bar(top - 23, kmUnit,   ptsPerKm,   false, false, "km");
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const LEG_TITLE_H = 13;
const LEG_ROW_H   = 9.5;
const LEG_SWATCH  = 7;
const LEG_FONT    = 6.5;
const LEG_PAD     = 4;
const LEG_COL_W   = 92;

function legendLayout(count: number, h: number) {
  const rows = Math.max(1, Math.floor((h - LEG_TITLE_H - LEG_PAD) / LEG_ROW_H));
  const cols = Math.ceil(count / rows);
  return { rows, cols };
}

function legendWidth(count: number, band: Box): number {
  const { cols } = legendLayout(count, band.h);
  return Math.min(band.w * 0.5, Math.max(110, cols * LEG_COL_W + LEG_PAD * 2));
}

function drawLegend(p: Painter, b: Box, entries: LegendEntry[]) {
  p.rect(b.x, b.y, b.w, b.h, { fill: WHITE, stroke: LGREY, lineWidth: 0.5 });
  p.text("Legend", b.x + LEG_PAD, b.y + b.h - LEG_PAD - 6, { size: 7, bold: true, color: BLACK });

  const { rows, cols } = legendLayout(entries.length, b.h);
  const colW = (b.w - LEG_PAD * 2) / cols;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const col = Math.floor(i / rows);
    const row = i % rows;
    const ex = b.x + LEG_PAD + col * colW;
    const ey = b.y + b.h - LEG_TITLE_H - (row + 1) * LEG_ROW_H + 1.5;
    const c = hexToRgb(e.color);
    if (e.dash) {
      p.line(ex, ey + LEG_SWATCH / 2, ex + LEG_SWATCH + 2, ey + LEG_SWATCH / 2, { color: c, width: 1.4, dash: [2, 1.2] });
    } else {
      p.rect(ex, ey, LEG_SWATCH, LEG_SWATCH, { fill: c, stroke: BLACK, lineWidth: 0.4 });
    }
    const labelX = ex + LEG_SWATCH + 5;
    p.text(fitText(e.label, LEG_FONT, colW - LEG_SWATCH - 8), labelX, ey + 1, { size: LEG_FONT, color: BLACK });
  }
}

// ---------------------------------------------------------------------------
// Index inset (which sheet of the set this is)
// ---------------------------------------------------------------------------

function drawIndexInset(p: Painter, b: Box, grid: SheetGrid, current: SheetCell) {
  const { rows, cols } = grid;
  const cw = b.w / cols;
  const ch = b.h / rows;
  p.rect(b.x, b.y, b.w, b.h, { fill: WHITE, stroke: BLACK, lineWidth: 0.5 });
  for (const cell of grid.cells) {
    const isThis = cell.row === current.row && cell.col === current.col;
    const cx = b.x + cell.col * cw;
    const cy = b.y + (rows - 1 - cell.row) * ch;
    p.rect(cx, cy, cw, ch, { fill: isThis ? HILITE : LGREY, stroke: BLACK, lineWidth: 0.3 });
    if (cw > 12 && ch > 7) {
      const lw = textWidth(cell.ref, 4.5);
      p.text(cell.ref, cx + cw / 2 - lw / 2, cy + ch / 2 - 1.6, { size: 4.5, color: isThis ? WHITE : BLACK });
    }
  }
}

// ---------------------------------------------------------------------------
// Compass rose
// ---------------------------------------------------------------------------

function drawCompassRose(p: Painter, cx: number, cy: number, R: number, declDeg: number, epoch: string) {
  const d2r = (d: number) => d * Math.PI / 180;
  const k = R / 34; // font scale relative to the full-size rose

  p.circle(cx, cy, R + 4, { fill: WHITE, stroke: LGREY, lineWidth: 0.5 });

  // True north arrow (two-tone)
  const len = R * 0.85, half = R * 0.13;
  const tip  = { x: cx, y: cy + len };
  const base = { x: cx, y: cy - len * 0.3 };
  const lft  = { x: base.x - half, y: base.y };
  const rgt  = { x: base.x + half, y: base.y };
  const cnt  = { x: cx, y: cy };
  p.polygon([tip, lft, cnt], { fill: BLACK, stroke: BLACK });
  p.polygon([tip, rgt, cnt], { fill: WHITE, stroke: BLACK });
  const nSize = 8 * k;
  p.text("N", cx - textWidth("N", nSize, true) / 2, cy + len + 2, { size: nSize, bold: true, color: BLACK });

  // Magnetic north (dashed)
  const a = d2r(declDeg);
  const dx = Math.sin(a), dy = Math.cos(a);
  const mn = R * 0.72;
  const mt = { x: cx + dx * mn, y: cy + dy * mn };
  p.line(cx, cy, mt.x, mt.y, { color: DKBLUE, width: 0.8, dash: [3, 2] });
  const px = -dy * R * 0.07, py = dx * R * 0.07;
  p.line(mt.x, mt.y, mt.x - dx * R * 0.12 + px, mt.y - dy * R * 0.12 + py, { color: DKBLUE, width: 0.7 });
  p.line(mt.x, mt.y, mt.x - dx * R * 0.12 - px, mt.y - dy * R * 0.12 - py, { color: DKBLUE, width: 0.7 });
  // "MN" sits beside the arrow tip, on the side it leans toward — placing it
  // beyond the tip put it on top of the "N" label for small declinations.
  const mnSize = 5 * k;
  const mnW = textWidth("MN", mnSize, true);
  p.text("MN", declDeg >= 0 ? mt.x + 2.5 * k : mt.x - mnW - 2.5 * k, mt.y - mnSize * 0.9, {
    size: mnSize, bold: true, color: DKBLUE,
  });

  // E / W spokes and a short S spoke (its label would collide with the
  // declination readout below centre).
  for (const [deg, lbl, len] of [[90, "E", 0.55], [270, "W", 0.55], [180, "", 0.25]] as [number, string, number][]) {
    const r = d2r(deg);
    const sx = Math.sin(r), sy = Math.cos(r);
    p.line(cx, cy, cx + sx * R * len, cy + sy * R * len, { color: MGREY, width: 0.6 });
    if (!lbl) continue;
    const sz = 6 * k;
    p.text(lbl, cx + sx * R * 0.68 - textWidth(lbl, sz) / 2, cy - sz / 2.8, { size: sz, color: GREY });
  }

  // Declination + model/epoch, inside the circle below centre
  const decLabel = `${Math.abs(declDeg).toFixed(1)}°${declDeg >= 0 ? "E" : "W"}`;
  const dSize = 6.5 * k;
  p.text(decLabel, cx - textWidth(decLabel, dSize) / 2, cy - R * 0.32 - dSize * 0.7, { size: dSize, bold: true, color: DKBLUE });
  const model = `${WMM_MODEL_YEAR} · ${epoch}`;
  const mSize = 4.5 * k;
  p.text(model, cx - textWidth(model, mSize) / 2, cy - R * 0.32 - dSize * 0.7 - 7 * k, { size: mSize, color: GREY });
}

// ---------------------------------------------------------------------------
// Lat/Lon grid — lines inside the map, labels outside the neatline
// ---------------------------------------------------------------------------

// Minute-based intervals so labels are always whole minutes.
const GRID_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 300];

function pickInterval(spanDeg: number): number {
  const target = spanDeg / 4; // aim for ~3–5 lines across the longer side
  for (const m of GRID_MINUTES) {
    if (m / 60 >= target) return m / 60;
  }
  return 5;
}

function formatDM(deg: number, pos: string, neg: string): string {
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  let mm = Math.round((abs - d) * 60);
  if (mm === 60) { d += 1; mm = 0; }
  return `${d}°${String(mm).padStart(2, "0")}'${deg >= 0 ? pos : neg}`;
}

function drawLatLonGrid(p: Painter, m: Box, b: Bounds, labels: boolean, neatline: boolean) {
  const spanLon = b.east - b.west;
  const spanLat = b.north - b.south;
  if (spanLon <= 0 || spanLat <= 0) return;
  const interval = pickInterval(Math.max(spanLon, spanLat));
  const gx = (lon: number) => m.x + ((lon - b.west) / spanLon) * m.w;
  const gy = (lat: number) => m.y + ((lat - b.south) / spanLat) * m.h;
  const style = { color: MGREY, width: 0.4, dash: [3, 3] };
  const off = (neatline ? NEAT_PAD : 0) + LABEL_GAP;

  // Longitude (vertical) lines; labels below and above the frame.
  let lastRight = -Infinity;
  for (let lon = Math.ceil(b.west / interval) * interval; lon < b.east; lon = +(lon + interval).toFixed(8)) {
    const x = gx(lon);
    if (x <= m.x + 0.5 || x >= m.x + m.w - 0.5) continue;
    p.line(x, m.y, x, m.y + m.h, style);
    if (!labels) continue;
    const lbl = formatDM(lon, "E", "W");
    const lw = textWidth(lbl, LABEL_FONT);
    const lx = Math.max(m.x, Math.min(m.x + m.w - lw, x - lw / 2));
    if (lx < lastRight + 4) continue;
    lastRight = lx + lw;
    p.text(lbl, lx, m.y - off - LABEL_FONT, { size: LABEL_FONT, color: GREY });
    p.text(lbl, lx, m.y + m.h + off, { size: LABEL_FONT, color: GREY });
  }

  // Latitude (horizontal) lines; labels left and right of the frame.
  let lastTop = -Infinity;
  for (let lat = Math.ceil(b.south / interval) * interval; lat < b.north; lat = +(lat + interval).toFixed(8)) {
    const y = gy(lat);
    if (y <= m.y + 0.5 || y >= m.y + m.h - 0.5) continue;
    p.line(m.x, y, m.x + m.w, y, style);
    if (!labels) continue;
    const ly = Math.max(m.y, Math.min(m.y + m.h - LABEL_FONT, y - LABEL_FONT / 2.8));
    if (ly < lastTop + 3) continue;
    lastTop = ly + LABEL_FONT;
    const lbl = formatDM(lat, "N", "S");
    const lw = textWidth(lbl, LABEL_FONT);
    p.text(lbl, m.x - off - lw, ly, { size: LABEL_FONT, color: GREY });
    p.text(lbl, m.x + m.w + off, ly, { size: LABEL_FONT, color: GREY });
  }

  if (labels) {
    p.text("WGS84", m.x + 3, m.y + 3, { size: 4.5, color: GREY });
  }
}

// ---------------------------------------------------------------------------
// Multi-sheet helpers
// ---------------------------------------------------------------------------

function drawOverviewGrid(p: Painter, m: Box, grid: SheetGrid) {
  const { rows, cols, cells } = grid;
  const cw = m.w / cols;
  const ch = m.h / rows;
  const dark: RGB = [0.25, 0.25, 0.25];
  for (let c = 1; c < cols; c++) {
    p.line(m.x + c * cw, m.y, m.x + c * cw, m.y + m.h, { color: dark, width: 1, dash: [4, 3] });
  }
  for (let r = 1; r < rows; r++) {
    p.line(m.x, m.y + r * ch, m.x + m.w, m.y + r * ch, { color: dark, width: 1, dash: [4, 3] });
  }
  for (const cell of cells) {
    const cx = m.x + cell.col * cw + cw / 2;
    const cy = m.y + (rows - 1 - cell.row) * ch + ch / 2;
    const size = Math.max(8, Math.min(16, Math.min(cw, ch) * 0.18));
    const lw = textWidth(cell.ref, size, true);
    p.rect(cx - lw / 2 - 3, cy - size * 0.35 - 3, lw + 6, size + 4, { fill: WHITE, stroke: dark, lineWidth: 0.4 });
    p.text(cell.ref, cx - lw / 2, cy - size * 0.35, { size, bold: true, color: [0.1, 0.1, 0.1] });
  }
}

/** Adjoining-sheet labels, inside the map edge on a white tab so they never
 *  collide with the coordinate labels outside the frame. */
function drawEdgeMatchMarkers(p: Painter, m: Box, cell: SheetCell) {
  const sz = 6.5;
  const tab = (lbl: string, x: number, y: number, rotate = 0) => {
    const w = textWidth(lbl, sz, true);
    if (rotate === 0) {
      p.rect(x - 3, y - 2.5, w + 6, sz + 4, { fill: WHITE, stroke: MGREY, lineWidth: 0.4 });
    } else {
      // rotated ±90°: the tab is tall and narrow
      const rx = rotate > 0 ? x - sz - 1.5 : x - 2.5;
      const ry = rotate > 0 ? y - 3 : y - w - 3;
      p.rect(rx, ry, sz + 4, w + 6, { fill: WHITE, stroke: MGREY, lineWidth: 0.4 });
    }
    p.text(lbl, x, y, { size: sz, bold: true, color: GREY, rotate });
  };
  if (cell.north) {
    const l = `^ ${cell.north}`;
    tab(l, m.x + m.w / 2 - textWidth(l, sz, true) / 2, m.y + m.h - sz - 5);
  }
  if (cell.south) {
    const l = `v ${cell.south}`;
    tab(l, m.x + m.w / 2 - textWidth(l, sz, true) / 2, m.y + 6);
  }
  if (cell.west) {
    const l = `< ${cell.west}`;
    tab(l, m.x + sz + 5, m.y + m.h / 2 - textWidth(l, sz, true) / 2, 90);
  }
  if (cell.east) {
    const l = `> ${cell.east}`;
    tab(l, m.x + m.w - sz - 5, m.y + m.h / 2 + textWidth(l, sz, true) / 2, -90);
  }
}

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

function drawDisclaimerBlock(p: Painter, b: Box, lines: string[]) {
  p.rect(b.x, b.y, b.w, b.h, { fill: [1, 0.97, 0.97], stroke: [0.75, 0.15, 0.15], lineWidth: 0.5 });
  const labelW = textWidth(DISC_LABEL, DISC_FONT, true);
  let ty = b.y + b.h - DISC_PAD - DISC_FONT + 1;
  p.text(DISC_LABEL, b.x + DISC_PAD, ty, { size: DISC_FONT, bold: true, color: RED });
  for (const line of lines) {
    p.text(line, b.x + DISC_PAD + labelW, ty, { size: DISC_FONT, color: RED });
    ty -= DISC_LINE_H;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): RGB {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((ch) => ch + ch).join("") : c;
  const n = (i: number) => {
    const v = parseInt(full.slice(i, i + 2), 16);
    return Number.isFinite(v) ? v / 255 : 0.5;
  };
  return [n(0), n(2), n(4)];
}
