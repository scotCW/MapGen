/**
 * Page layout — the single source of truth for where every band of a printed
 * sheet sits. The PDF exporter, the Preview tab, the sheet-grid geometry and
 * the Area/Layers overlays all read from here, so toggling an element (or
 * changing paper/margins) moves everything together instead of each caller
 * keeping its own copy of the band heights.
 *
 * Units are PDF points (1/72 in), origin bottom-left, y up — pdf-lib's
 * convention. The SVG preview flips y itself.
 */

import { StandardFontEmbedder, StandardFonts } from "pdf-lib";
import type { FormatSettings } from "../types/format";
import { effectivePaper, MARGIN_SIZES } from "../types/format";
import type { MapElements } from "../types/elements";
import { ACCESS_DISCLAIMER } from "../types/access";

export const PT_PER_IN = 72;

// Band sizes (pt)
export const TITLE_H        = 40;
export const SCALE_H        = 58;
export const BAND_GAP       = 8;   // between stacked bands
export const NEAT_PAD       = 5;   // room for the outer neatline (offset 3pt)
export const LABEL_FONT     = 5.5; // coordinate labels
export const LABEL_GAP      = 3;   // label clearance outside the outer neatline
export const DISC_FONT      = 6.5;
export const DISC_LINE_H    = DISC_FONT * 1.4;
export const DISC_PAD       = 6;
export const DISC_LABEL     = "WARNING: ";

// ---------------------------------------------------------------------------
// Font metrics (Helvetica — the standard-14 font the PDF embeds; Arial, used
// by the SVG preview, is metric-compatible)
// ---------------------------------------------------------------------------

// StandardFonts values are the standard-14 font names FontNames expects; the
// two enums just aren't declared as related.
type FontName = Parameters<typeof StandardFontEmbedder.for>[0];
const HELV   = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as FontName);
const HELV_B = StandardFontEmbedder.for(StandardFonts.HelveticaBold as unknown as FontName);
const encodable = new Map<string, boolean>();

/**
 * Replaces characters the standard-14 fonts can't encode (emoji, most
 * non-Latin scripts) with "?". pdf-lib throws on them otherwise — a project
 * named with an emoji would make every export fail.
 */
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    let ok = encodable.get(ch);
    if (ok === undefined) {
      try { HELV.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; }
      encodable.set(ch, ok);
    }
    out += ok ? ch : "?";
  }
  return out;
}

export function textWidth(text: string, size: number, bold = false): number {
  return (bold ? HELV_B : HELV).widthOfTextAtSize(pdfSafe(text), size);
}

export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (textWidth(test, size, bold) <= maxWidth || !current) {
      current = test;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Shortens `text` with a trailing "..." until it fits `maxWidth`. */
export function fitText(text: string, size: number, maxWidth: number, bold = false): string {
  const safe = pdfSafe(text);
  if (textWidth(safe, size, bold) <= maxWidth) return safe;
  let s = safe;
  while (s.length > 1 && textWidth(`${s}...`, size, bold) > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

// Widest latitude label we ever print ("00°00'N" style), for the side gutter.
const LAT_LABEL_W = textWidth("88°88'N", LABEL_FONT);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Box { x: number; y: number; w: number; h: number; }

export interface PageLayout {
  pageW: number;
  pageH: number;
  margin: number;
  usable: Box;
  /** The map image itself (inside the neatline). */
  map: Box;
  title: Box | null;
  scaleBand: Box | null;
  disclaimer: Box | null;
  /** Pre-wrapped disclaimer lines (hanging indent after the WARNING label). */
  disclaimerLines: string[];
  /** Whether coordinate labels are drawn outside the map frame. */
  coordLabels: boolean;
  mapWidthIn: number;
  mapHeightIn: number;
}

export function hasScaleBand(el: MapElements, isMulti: boolean): boolean {
  return el.scaleBar || el.ratioScale || el.legend || (isMulti && el.indexInset);
}

export function computePageLayout(fmt: FormatSettings, el: MapElements, isMulti: boolean): PageLayout {
  const paper  = effectivePaper(fmt);
  const pageW  = paper.w * PT_PER_IN;
  const pageH  = paper.h * PT_PER_IN;
  const margin = (MARGIN_SIZES[fmt.margins] ?? 0.5) * PT_PER_IN;
  const usable: Box = { x: margin, y: margin, w: pageW - margin * 2, h: pageH - margin * 2 };

  let bottom = usable.y;
  let top    = usable.y + usable.h;

  // ── Disclaimer (bottom) ──────────────────────────────────────────────────
  let disclaimer: Box | null = null;
  let disclaimerLines: string[] = [];
  if (el.disclaimer) {
    const labelW = textWidth(DISC_LABEL, DISC_FONT, true);
    disclaimerLines = wrapText(ACCESS_DISCLAIMER, DISC_FONT, usable.w - DISC_PAD * 2 - labelW);
    const h = DISC_PAD * 2 + DISC_FONT + (disclaimerLines.length - 1) * DISC_LINE_H;
    disclaimer = { x: usable.x, y: bottom, w: usable.w, h };
    bottom += h + BAND_GAP;
  }

  // ── Scale / legend band ──────────────────────────────────────────────────
  let scaleBand: Box | null = null;
  if (hasScaleBand(el, isMulti)) {
    scaleBand = { x: usable.x, y: bottom, w: usable.w, h: SCALE_H };
    bottom += SCALE_H + BAND_GAP;
  }

  // ── Title block (top) ────────────────────────────────────────────────────
  let title: Box | null = null;
  if (el.titleBlock) {
    title = { x: usable.x, y: top - TITLE_H, w: usable.w, h: TITLE_H };
    top -= TITLE_H + BAND_GAP;
  }

  // ── Map frame: leave room for the neatline and the coordinate labels ─────
  const coordLabels = el.gridLines && el.coordinateLabels;
  const frame  = el.neatline ? NEAT_PAD : 0;
  const vPad   = coordLabels ? frame + LABEL_GAP + LABEL_FONT + 1 : frame;
  const hPad   = coordLabels ? frame + LABEL_GAP + LAT_LABEL_W + 1 : frame;

  const mapX = usable.x + hPad;
  const mapW = Math.max(36, usable.w - hPad * 2);
  const mapY = bottom + vPad;
  const mapH = Math.max(36, top - vPad - mapY);

  return {
    pageW, pageH, margin, usable,
    map: { x: mapX, y: mapY, w: mapW, h: mapH },
    title, scaleBand, disclaimer, disclaimerLines, coordLabels,
    mapWidthIn:  mapW / PT_PER_IN,
    mapHeightIn: mapH / PT_PER_IN,
  };
}
