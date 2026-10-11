// ---------------------------------------------------------------------------
// Map elements — which cartographic furniture is printed on each sheet.
// Mirrors src-tauri/src/projects.rs MapElements. Stored per project so the
// Preview tab's checkboxes and the exported PDF always agree.
// ---------------------------------------------------------------------------

export interface MapElements {
  titleBlock:       boolean;
  sheetReference:   boolean;
  neatline:         boolean;
  gridLines:        boolean;
  coordinateLabels: boolean;
  compassRose:      boolean;
  scaleBar:         boolean;
  ratioScale:       boolean;
  legend:           boolean;
  indexInset:       boolean;
  edgeMatchMarkers: boolean;
  overviewSheet:    boolean;
  disclaimer:       boolean;
}

export const ELEMENT_DEFAULTS: MapElements = {
  titleBlock:       true,
  sheetReference:   true,
  neatline:         true,
  gridLines:        true,
  coordinateLabels: true,
  compassRose:      true,
  scaleBar:         true,
  ratioScale:       true,
  legend:           true,
  indexInset:       true,
  edgeMatchMarkers: true,
  overviewSheet:    true,
  disclaimer:       true,
};

/** Fills in any field missing from an older project.json with its default. */
export function normalizeElements(raw: Partial<MapElements> | null | undefined): MapElements {
  const out = { ...ELEMENT_DEFAULTS };
  if (raw) {
    for (const k of Object.keys(ELEMENT_DEFAULTS) as (keyof MapElements)[]) {
      if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
    }
  }
  return out;
}

export function elementsEqual(a: MapElements, b: MapElements): boolean {
  return (Object.keys(ELEMENT_DEFAULTS) as (keyof MapElements)[]).every((k) => a[k] === b[k]);
}
