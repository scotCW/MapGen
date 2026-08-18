// ---------------------------------------------------------------------------
// Format settings — mirrors src-tauri/src/projects.rs FormatSettings
// ---------------------------------------------------------------------------

export interface FormatSettings {
  paperSize: string;         // "letter" | "legal" | "tabloid" | "a4" | "a3" | "custom"
  paperWidthIn: number;
  paperHeightIn: number;
  orientation: string;       // "portrait" | "landscape"
  margins: string;           // "narrow" | "normal" | "wide"
  sheetLayout: string;       // "1" | "2" | "4" | "6" | "custom" | "auto"
  sheetsAcross: number;
  sheetsDown: number;
  sheetsSplit: string;       // "side-by-side" | "stacked"
  sheetsArrangement: string; // "3x2" | "2x3"
  scale: number;             // ratio denominator
  scaleCustom: number | null;
  scaleLock: string;         // "scale" | "sheet-count" | "both"
  freeformDraw: boolean;
}

export const FORMAT_DEFAULTS: FormatSettings = {
  paperSize: "letter",
  paperWidthIn: 8.5,
  paperHeightIn: 11.0,
  orientation: "portrait",
  margins: "normal",
  sheetLayout: "1",
  sheetsAcross: 2,
  sheetsDown: 2,
  sheetsSplit: "side-by-side",
  sheetsArrangement: "3x2",
  scale: 24000,
  scaleCustom: null,
  scaleLock: "scale",
  freeformDraw: false,
};

// ---------------------------------------------------------------------------
// Paper sizes — intrinsic portrait dimensions (width × height in inches)
// ---------------------------------------------------------------------------

export interface PaperSpec {
  id: string;
  label: string;
  widthIn: number;
  heightIn: number;
}

export const PAPER_SIZES: PaperSpec[] = [
  { id: "letter",  label: "Letter",  widthIn: 8.5,  heightIn: 11.0  },
  { id: "legal",   label: "Legal",   widthIn: 8.5,  heightIn: 14.0  },
  { id: "tabloid", label: "Tabloid", widthIn: 11.0, heightIn: 17.0  },
  { id: "a4",      label: "A4",      widthIn: 8.27, heightIn: 11.69 },
  { id: "a3",      label: "A3",      widthIn: 11.69,heightIn: 16.54 },
  { id: "custom",  label: "Custom",  widthIn: 0,    heightIn: 0     },
];

export const MARGIN_SIZES: Record<string, number> = {
  narrow: 0.25,
  normal: 0.5,
  wide:   1.0,
};

// ---------------------------------------------------------------------------
// Standard scales with human-readable labels
// ---------------------------------------------------------------------------

export interface ScaleSpec {
  value: number;
  label: string;      // "1:24,000"
  plainLabel: string; // "about 2.6 inches per mile"
}

export const STANDARD_SCALES: ScaleSpec[] = [
  { value: 12000,  label: "1:12,000",  plainLabel: "about 5.3 in / mile" },
  { value: 24000,  label: "1:24,000",  plainLabel: "about 2.6 in / mile — USGS standard" },
  { value: 31680,  label: "1:31,680",  plainLabel: "exactly 2 in / mile" },
  { value: 50000,  label: "1:50,000",  plainLabel: "about 1.25 in / mile" },
  { value: 63360,  label: "1:63,360",  plainLabel: "exactly 1 in / mile" },
  { value: 100000, label: "1:100,000", plainLabel: "about 0.6 in / mile" },
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Returns the effective paper dimensions after applying orientation. */
export function effectivePaper(fmt: FormatSettings): { w: number; h: number } {
  const spec = PAPER_SIZES.find((p) => p.id === fmt.paperSize);
  const w = fmt.paperSize === "custom" ? fmt.paperWidthIn  : (spec?.widthIn  ?? 8.5);
  const h = fmt.paperSize === "custom" ? fmt.paperHeightIn : (spec?.heightIn ?? 11.0);
  return fmt.orientation === "landscape" ? { w: Math.max(w, h), h: Math.min(w, h) }
                                         : { w: Math.min(w, h), h: Math.max(w, h) };
}

/** Returns the usable (inside-margin) dimensions in inches. */
export function usablePaper(fmt: FormatSettings): { w: number; h: number } {
  const m = MARGIN_SIZES[fmt.margins] ?? 0.5;
  const e = effectivePaper(fmt);
  return { w: Math.max(0, e.w - m * 2), h: Math.max(0, e.h - m * 2) };
}

/** Ground coverage of one sheet at the chosen scale, in miles. */
export function sheetCoverageMiles(fmt: FormatSettings): { w: number; h: number } {
  const u = usablePaper(fmt);
  const INCHES_PER_MILE = 63360;
  return {
    w: (u.w * fmt.scale) / INCHES_PER_MILE,
    h: (u.h * fmt.scale) / INCHES_PER_MILE,
  };
}

export function milesToKm(miles: number): number {
  return miles * 1.60934;
}

/** Returns the [across, down] sheet grid for a given format. */
export function getSheetGrid(fmt: FormatSettings): [number, number] {
  switch (fmt.sheetLayout) {
    case "1":    return [1, 1];
    case "2":    return fmt.sheetsSplit === "stacked" ? [1, 2] : [2, 1];
    case "4":    return [2, 2];
    case "6": {
      const [a, d] = (fmt.sheetsArrangement ?? "3x2").split("x").map(Number);
      return [a ?? 3, d ?? 2];
    }
    case "custom": return [fmt.sheetsAcross ?? 2, fmt.sheetsDown ?? 2];
    default:     return [1, 1];
  }
}

/** Describes the selected sheet grid, e.g. "2 sheets (side by side)". */
export function describeLayout(fmt: FormatSettings): string {
  switch (fmt.sheetLayout) {
    case "1": return "1 sheet";
    case "2": return `2 sheets (${fmt.sheetsSplit === "side-by-side" ? "side by side" : "stacked"})`;
    case "4": return "4 sheets (2 × 2)";
    case "6": return `6 sheets (${fmt.sheetsArrangement})`;
    case "custom": return `${fmt.sheetsAcross} × ${fmt.sheetsDown} sheets`;
    case "auto": return "Auto (scale decides)";
    default: return fmt.sheetLayout;
  }
}
