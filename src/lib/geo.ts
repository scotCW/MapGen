import type { FormatSettings } from "../types/format";
import { effectivePaper } from "../types/format";

export interface Bounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

const DEG_PER_M_LAT = 1 / 111319.9;

function degPerMLng(lat: number): number {
  return 1 / (111319.9 * Math.cos((lat * Math.PI) / 180));
}

/**
 * Bounds for ONE sheet at the given format's paper size and scale.
 * Used by the single-sheet PDF exporter (Stage 11).
 */
export function singleSheetBounds(
  centerLng: number,
  centerLat: number,
  fmt: FormatSettings,
): Bounds {
  const paper = effectivePaper(fmt);
  const scale = fmt.scaleCustom ?? fmt.scale;
  const IN_TO_M = 0.0254;
  const groundW = paper.w * scale * IN_TO_M;
  const groundH = paper.h * scale * IN_TO_M;
  const dLng = (groundW / 2) * degPerMLng(centerLat);
  const dLat = (groundH / 2) * DEG_PER_M_LAT;
  return {
    west:  centerLng - dLng,
    east:  centerLng + dLng,
    south: centerLat - dLat,
    north: centerLat + dLat,
  };
}

/**
 * Bounds for an explicit map area (width/height in inches) at the given scale.
 * Stage 12+ uses this so the map image dimensions can differ from full paper usable area
 * (some vertical space is reserved for title block, scale bar, etc.).
 */
export function mapAreaBounds(
  centerLng: number,
  centerLat: number,
  mapWidthIn: number,
  mapHeightIn: number,
  scale: number,
): Bounds {
  const IN_TO_M = 0.0254;
  const groundW = mapWidthIn  * scale * IN_TO_M;
  const groundH = mapHeightIn * scale * IN_TO_M;
  const dLng = (groundW / 2) * degPerMLng(centerLat);
  const dLat = (groundH / 2) * DEG_PER_M_LAT;
  return {
    west:  centerLng - dLng,
    east:  centerLng + dLng,
    south: centerLat - dLat,
    north: centerLat + dLat,
  };
}

export { degPerMLng, DEG_PER_M_LAT };
