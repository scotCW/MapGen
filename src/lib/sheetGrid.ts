/**
 * Multi-sheet grid geometry — pure math, no PDF or rendering concerns.
 * Computes per-cell bounds (with overlap), cell references, and adjacency.
 */

import type { FormatSettings } from "../types/format";
import { effectivePaper, MARGIN_SIZES } from "../types/format";
import type { Bounds } from "./geo";
import { DEG_PER_M_LAT, degPerMLng } from "./geo";

// Keep in sync with exportPdf.ts band heights
const PT_PER_IN = 72;
const TITLE_H   = 42;
const SCALE_H   = 54;
const DISC_H    = 44;
const DISC_SCALE_GAP_PT = 10; // must match exportPdf.ts DISC_SCALE_GAP_PT

export interface SheetCell {
  row: number;          // 0 = northernmost row
  col: number;          // 0 = westernmost column
  ref: string;          // "A1", "B2", …
  pageIndex: number;    // 1-indexed page in the PDF (page 1 = overview)
  bounds: Bounds;       // geographic extent including overlap on interior edges
  north?: string;       // ref of adjacent sheet to north
  south?: string;
  east?: string;
  west?: string;
}

export interface SheetGrid {
  rows: number;
  cols: number;
  totalSheets: number;
  overlapIn: number;     // overlap width per shared edge (inches on paper)
  cells: SheetCell[];    // row-major: [A1, A2, …, B1, B2, …]
  totalBounds: Bounds;   // outer extent of the full tiled area (no outer overlap)
  mapWidthIn: number;    // map-area width per sheet in inches
  mapHeightIn: number;   // map-area height per sheet in inches
}

// ---------------------------------------------------------------------------
// Derive columns × rows from FormatSettings
// ---------------------------------------------------------------------------

export function getSheetDimensions(fmt: FormatSettings): { across: number; down: number } {
  switch (fmt.sheetLayout) {
    case "1":
      return { across: 1, down: 1 };
    case "2":
      return fmt.sheetsSplit === "stacked"
        ? { across: 1, down: 2 }
        : { across: 2, down: 1 };
    case "4":
      return { across: 2, down: 2 };
    case "6":
      return fmt.sheetsArrangement === "2x3"
        ? { across: 2, down: 3 }
        : { across: 3, down: 2 };
    case "custom":
      return {
        across: Math.max(1, fmt.sheetsAcross),
        down:   Math.max(1, fmt.sheetsDown),
      };
    default:
      return { across: 1, down: 1 };
  }
}

// ---------------------------------------------------------------------------
// Core grid computation
// ---------------------------------------------------------------------------

/**
 * Computes the full sheet grid centred on (centerLng, centerLat).
 *
 * @param overlapIn  Overlap width on each shared edge (paper inches, default 0.5)
 */
export function computeSheetGrid(
  fmt: FormatSettings,
  overlapIn: number,
  centerLng: number,
  centerLat: number,
  scale: number,
): SheetGrid {
  const { across, down } = getSheetDimensions(fmt);

  const paper    = effectivePaper(fmt);
  const marginIn = MARGIN_SIZES[fmt.margins] ?? 0.5;

  const usableW = paper.w - marginIn * 2;
  const usableH = paper.h - marginIn * 2;

  // Map area (excluding carto bands)
  const mapW = usableW;
  const mapH = usableH - (TITLE_H + SCALE_H + DISC_H + DISC_SCALE_GAP_PT) / PT_PER_IN;

  const IN_TO_M = 0.0254;
  const sheetGW = mapW  * scale * IN_TO_M;  // ground metres covered by one sheet width
  const sheetGH = mapH  * scale * IN_TO_M;
  const ovGW    = overlapIn * scale * IN_TO_M;
  const ovGH    = overlapIn * scale * IN_TO_M;

  // Unique coverage (no repeated overlap)
  const totalGW = across * sheetGW - (across - 1) * ovGW;
  const totalGH = down   * sheetGH - (down   - 1) * ovGH;

  const dLngTotal = (totalGW / 2) * degPerMLng(centerLat);
  const dLatTotal = (totalGH / 2) * DEG_PER_M_LAT;

  const totalBounds: Bounds = {
    west:  centerLng - dLngTotal,
    east:  centerLng + dLngTotal,
    south: centerLat - dLatTotal,
    north: centerLat + dLatTotal,
  };

  // Step between adjacent cell origins in degrees
  const stepLng = (sheetGW - ovGW) * degPerMLng(centerLat);
  const stepLat = (sheetGH - ovGH) * DEG_PER_M_LAT;

  // Sheet dimensions in degrees
  const cellDLng = sheetGW * degPerMLng(centerLat);
  const cellDLat = sheetGH * DEG_PER_M_LAT;

  const cells: SheetCell[] = [];
  let pageIndex = 2; // page 1 = overview

  for (let row = 0; row < down; row++) {
    for (let col = 0; col < across; col++) {
      const cellWest  = totalBounds.west  + col * stepLng;
      const cellNorth = totalBounds.north - row * stepLat;
      const cellEast  = cellWest  + cellDLng;
      const cellSouth = cellNorth - cellDLat;

      cells.push({
        row, col,
        ref: cellRef(row, col),
        pageIndex: pageIndex++,
        bounds: { west: cellWest, east: cellEast, south: cellSouth, north: cellNorth },
        north: row > 0         ? cellRef(row - 1, col) : undefined,
        south: row < down - 1  ? cellRef(row + 1, col) : undefined,
        west:  col > 0         ? cellRef(row, col - 1) : undefined,
        east:  col < across - 1 ? cellRef(row, col + 1) : undefined,
      });
    }
  }

  return { rows: down, cols: across, totalSheets: down * across, overlapIn, cells, totalBounds, mapWidthIn: mapW, mapHeightIn: mapH };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "A1", "B2", etc. — row 0 = A, col 0 = 1 */
export function cellRef(row: number, col: number): string {
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}
