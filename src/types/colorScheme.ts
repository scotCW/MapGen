// Land access color scheme types — Section 12.4 of the spec.

import type { CategoryId } from "./access";

export type FillPattern  = "solid" | "diagonal" | "crosshatch" | "dots" | "none";
export type LineStyle    = "solid" | "dashed" | "dotted";

// ---------------------------------------------------------------------------
// Per-category style (polygon fill layers)
// ---------------------------------------------------------------------------

export interface CategoryStyle {
  fillColor:    string;      // hex, e.g. "#2e7d32"
  fillOpacity:  number;      // 0–100 (%)
  pattern:      FillPattern;
  borderColor:  string;      // hex
  borderWeight: number;      // pt, 0.3–5
  borderStyle:  LineStyle;
  labelVisible: boolean;
  labelText:    string;      // user-editable display name
  showInLegend: boolean;
}

// Access-routes is a line layer — fill properties don't apply.
export interface RoutesStyle {
  lineColor:    string;
  lineWeight:   number;      // pt
  lineStyle:    LineStyle;
  labelVisible: boolean;
  labelText:    string;
  showInLegend: boolean;
}

// ---------------------------------------------------------------------------
// Full scheme
// ---------------------------------------------------------------------------

export interface AccessColorScheme {
  huntable:   CategoryStyle;
  no_hunting: CategoryStyle;
  closed:     CategoryStyle;
  private:    CategoryStyle;
  unknown:    CategoryStyle;
  routes:     RoutesStyle;
}

// Named scheme (built-in or user-saved)
export interface NamedScheme {
  name:      string;
  scheme:    AccessColorScheme;
  isBuiltIn: boolean;
}

// ---------------------------------------------------------------------------
// Default category styles
// ---------------------------------------------------------------------------

function cat(
  fillColor: string,
  fillOpacity: number,
  borderColor: string,
  labelText: string,
  pattern: FillPattern = "solid",
): CategoryStyle {
  return {
    fillColor, fillOpacity, pattern,
    borderColor, borderWeight: 0.75, borderStyle: "solid",
    labelVisible: true, labelText, showInLegend: true,
  };
}

export const DEFAULT_SCHEME: AccessColorScheme = {
  huntable:   cat("#2e7d32", 38, "#1b5e20", "Open — Hunting Allowed"),
  no_hunting: cat("#1565c0", 38, "#0d47a1", "Open — No Hunting"),
  closed:     cat("#c62828", 38, "#b71c1c", "Closed — No Public Entry"),
  private:    cat("#e65100", 32, "#bf360c", "Private Land"),
  unknown:    cat("#757575", 22, "#424242", "Unknown / Unclassified", "diagonal"),
  routes: {
    lineColor: "#33691e", lineWeight: 1.5, lineStyle: "dashed",
    labelVisible: true, labelText: "Access Routes", showInLegend: true,
  },
};

export const COLORBLIND_SAFE_SCHEME: AccessColorScheme = {
  huntable:   cat("#009E73", 40, "#00695c", "Open — Hunting Allowed"),
  no_hunting: cat("#56B4E9", 40, "#0277BD", "Open — No Hunting"),
  closed:     cat("#D55E00", 40, "#BF360C", "Closed — No Public Entry"),
  private:    cat("#E69F00", 35, "#E65100", "Private Land"),
  unknown:    cat("#999999", 25, "#555555", "Unknown / Unclassified", "diagonal"),
  routes: {
    lineColor: "#004D40", lineWeight: 1.5, lineStyle: "dashed",
    labelVisible: true, labelText: "Access Routes", showInLegend: true,
  },
};

export const BW_PRINT_SCHEME: AccessColorScheme = {
  huntable:   { fillColor: "#ffffff", fillOpacity: 90, pattern: "diagonal",  borderColor: "#000000", borderWeight: 1,    borderStyle: "solid", labelVisible: true, labelText: "Open — Hunting Allowed",   showInLegend: true },
  no_hunting: { fillColor: "#ffffff", fillOpacity: 90, pattern: "crosshatch", borderColor: "#000000", borderWeight: 1,    borderStyle: "solid", labelVisible: true, labelText: "Open — No Hunting",          showInLegend: true },
  closed:     { fillColor: "#000000", fillOpacity: 70, pattern: "solid",     borderColor: "#000000", borderWeight: 1.5,  borderStyle: "solid", labelVisible: true, labelText: "Closed — No Public Entry",   showInLegend: true },
  private:    { fillColor: "#ffffff", fillOpacity: 90, pattern: "dots",      borderColor: "#000000", borderWeight: 1,    borderStyle: "solid", labelVisible: true, labelText: "Private Land",               showInLegend: true },
  unknown:    { fillColor: "#ffffff", fillOpacity: 10, pattern: "none",      borderColor: "#888888", borderWeight: 0.5,  borderStyle: "dashed", labelVisible: true, labelText: "Unknown / Unclassified",    showInLegend: true },
  routes: {
    lineColor: "#000000", lineWeight: 1.5, lineStyle: "dashed",
    labelVisible: true, labelText: "Access Routes", showInLegend: true,
  },
};

export const HIGH_CONTRAST_SCHEME: AccessColorScheme = {
  huntable:   cat("#00C853", 60, "#1B5E20", "Open — Hunting Allowed"),
  no_hunting: cat("#2962FF", 60, "#0D47A1", "Open — No Hunting"),
  closed:     cat("#D50000", 65, "#7F0000", "Closed — No Public Entry"),
  private:    cat("#FF6D00", 55, "#BF360C", "Private Land"),
  unknown:    cat("#9E9E9E", 40, "#424242", "Unknown / Unclassified", "diagonal"),
  routes: {
    lineColor: "#1B5E20", lineWeight: 2.5, lineStyle: "solid",
    labelVisible: true, labelText: "Access Routes", showInLegend: true,
  },
};

export const SUBTLE_SCHEME: AccessColorScheme = {
  huntable:   cat("#81C784", 20, "#4CAF50", "Open — Hunting Allowed"),
  no_hunting: cat("#64B5F6", 20, "#2196F3", "Open — No Hunting"),
  closed:     cat("#EF9A9A", 20, "#F44336", "Closed — No Public Entry"),
  private:    cat("#FFCC80", 18, "#FF9800", "Private Land"),
  unknown:    cat("#E0E0E0", 15, "#9E9E9E", "Unknown / Unclassified"),
  routes: {
    lineColor: "#66BB6A", lineWeight: 1, lineStyle: "dashed",
    labelVisible: true, labelText: "Access Routes", showInLegend: true,
  },
};

export const BUILT_IN_PRESETS: NamedScheme[] = [
  { name: "Default",         scheme: DEFAULT_SCHEME,         isBuiltIn: true },
  { name: "Colorblind Safe", scheme: COLORBLIND_SAFE_SCHEME, isBuiltIn: true },
  { name: "B&W Print",       scheme: BW_PRINT_SCHEME,        isBuiltIn: true },
  { name: "High Contrast",   scheme: HIGH_CONTRAST_SCHEME,   isBuiltIn: true },
  { name: "Subtle",          scheme: SUBTLE_SCHEME,          isBuiltIn: true },
];

// The ordered list of polygon categories
export const SCHEME_POLYGON_KEYS: CategoryId[] = [
  "huntable", "no_hunting", "closed", "private", "unknown",
];
