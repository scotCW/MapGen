import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { invoke } from "../lib/ipc";
import { captureSaveEpoch, isSaveEpochCurrent, isStaleGenerationError } from "../lib/saveEpoch";
import {
  effectivePaper,
  MARGIN_SIZES,
  PAPER_SIZES,
  STANDARD_SCALES,
  getSheetGrid,
  FORMAT_DEFAULTS,
} from "../types/format";
import type { FormatSettings } from "../types/format";
import type { AreaSettings } from "../types/area";
import { DEFAULT_AREA } from "../types/area";
import { CATEGORIES, ACCESS_ACK_KEY } from "../types/access";
import type { CategoryId } from "../types/access";
import { AccessFirstRunModal } from "../components/AccessFirstRunModal";
import { AccessInspectPopup } from "../components/AccessInspectPopup";
import type { InspectTarget } from "../components/AccessInspectPopup";
import { CustomFormatConfirmDialog } from "../components/CustomFormatConfirmDialog";
import "./AreaTab.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  isActive: boolean;
  onBoundsChange?: (bounds: Bounds | null) => void;
  // Called after a confirmed custom-format switch. FormatTab holds its own
  // independent copy of project.format loaded once on mount, so without this
  // it keeps showing the pre-switch scale/lock state until the user happens
  // to leave and return to that tab — misleading right after a dialog that
  // just told them the format changed. WorkspaceScreen remounts the tabs to
  // force a fresh read, the same mechanism already used after a snapshot
  // restore for the same kind of cross-tab staleness.
  onFormatChangedExternally?: () => void;
}

interface Bounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

type InputMode = "box" | "draw" | "corners" | "coords";

type BoxHandle =
  | "body"
  | "nw" | "n" | "ne"
  | "e" | "se" | "s"
  | "sw" | "w";

const BOX_HANDLES: BoxHandle[] = [
  "body",
  "nw", "n", "ne",
  "e", "se", "s",
  "sw", "w",
];

const HANDLE_CURSOR: Record<BoxHandle, string> = {
  body: "move",
  nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize",
  e: "ew-resize", se: "nwse-resize", s: "ns-resize",
  sw: "nesw-resize", w: "ew-resize",
};

interface CornerPt { lat: number; lng: number; }

interface SearchResult { name: string; lat: number; lon: number; }

// Corner indices: 0=NW 1=NE 2=SE 3=SW
const CORNER_LABELS = ["NW", "NE", "SE", "SW"];

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

const DEG_PER_M_LAT = 1 / 111319.9;

function degPerMLng(lat: number): number {
  return 1 / (111319.9 * Math.cos((lat * Math.PI) / 180));
}

function boundsFromCenter(lng: number, lat: number, fmt: FormatSettings): Bounds {
  const paper = effectivePaper(fmt);
  const [across, down] = getSheetGrid(fmt);
  const scale = fmt.scaleCustom ?? fmt.scale;
  const IN_TO_M = 0.0254;
  const groundW = paper.w * across * scale * IN_TO_M;
  const groundH = paper.h * down  * scale * IN_TO_M;
  const dLng = (groundW / 2) * degPerMLng(lat);
  const dLat = (groundH / 2) * DEG_PER_M_LAT;
  return { west: lng - dLng, east: lng + dLng, south: lat - dLat, north: lat + dLat };
}

function backComputeScale(b: Bounds, fmt: FormatSettings): number {
  const paper = effectivePaper(fmt);
  const [across, down] = getSheetGrid(fmt);
  const midLat = (b.south + b.north) / 2;
  const groundWIn = ((b.east - b.west) / degPerMLng(midLat)) / 0.0254;
  const groundHIn = ((b.north - b.south) / DEG_PER_M_LAT)   / 0.0254;
  const scaleW = groundWIn / (paper.w * across);
  const scaleH = groundHIn / (paper.h * down);
  return Math.round((scaleW + scaleH) / 2);
}

function computeAreaKm2(b: Bounds): number {
  const midLat = (b.south + b.north) / 2;
  const widthM  = (b.east - b.west) / degPerMLng(midLat);
  const heightM = (b.north - b.south) / DEG_PER_M_LAT;
  return (widthM * heightM) / 1_000_000;
}

function boundsFromPoints(pts: CornerPt[]): Bounds {
  const lats = pts.map(p => p.lat);
  const lngs = pts.map(p => p.lng);
  return {
    west: Math.min(...lngs), east: Math.max(...lngs),
    south: Math.min(...lats), north: Math.max(...lats),
  };
}

// Produce 4 corners in [NW, NE, SE, SW] order from bounds
function cornersFromBounds(b: Bounds): CornerPt[] {
  return [
    { lat: b.north, lng: b.west },
    { lat: b.north, lng: b.east },
    { lat: b.south, lng: b.east },
    { lat: b.south, lng: b.west },
  ];
}

// ---------------------------------------------------------------------------
// Coordinate parsing (decimal degrees or DMS, with optional N/S/E/W suffix)
// ---------------------------------------------------------------------------

function parseDeg(s: string): number | null {
  s = s.trim();
  if (!s) return null;
  // Decimal: "39.5", "-106.0", "39.5N", "106.5W"
  const dec = s.match(/^(-?\d+\.?\d*)\s*([NSEWnsew])?$/);
  if (dec) {
    let v = parseFloat(dec[1]);
    const dir = dec[2]?.toUpperCase();
    if (dir === "S" || dir === "W") v = -v;
    return isFinite(v) ? v : null;
  }
  // DMS: "39 30 0 N" or "39°30'0\"N"
  const dms = s.match(/^(\d+)[°d\s]+(\d+)[''m\s]+(\d+\.?\d*)[""s\s]*([NSEWnsew])?/i);
  if (dms) {
    let v = +dms[1] + +dms[2] / 60 + +dms[3] / 3600;
    const dir = dms[4]?.toUpperCase();
    if (dir === "S" || dir === "W") v = -v;
    return isFinite(v) ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GeoJSON generators
// ---------------------------------------------------------------------------

function makeDimmingFC(b: Bounds) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
            // CW hole — print box
            [
              [b.west, b.south], [b.west, b.north],
              [b.east, b.north], [b.east, b.south],
              [b.west, b.south],
            ],
          ],
        },
      },
    ],
  };
}

function makeMarginFC(b: Bounds, fmt: FormatSettings) {
  const paper = effectivePaper(fmt);
  const [across, down] = getSheetGrid(fmt);
  const margin = MARGIN_SIZES[fmt.margins] ?? 0.5;
  const mwF = margin / (paper.w * across);
  const mhF = margin / (paper.h * down);
  const dLng = (b.east - b.west) * mwF;
  const dLat = (b.north - b.south) * mhF;
  const iw = b.west + dLng, ie = b.east - dLng;
  const is_ = b.south + dLat, in_ = b.north - dLat;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [b.west, b.south], [b.east, b.south],
              [b.east, b.north], [b.west, b.north],
              [b.west, b.south],
            ],
            [
              [iw, is_], [iw, in_],
              [ie, in_], [ie, is_],
              [iw, is_],
            ],
          ],
        },
      },
    ],
  };
}

// Compass rose position, mirroring exportPdf.ts exactly: a 34pt-radius rose
// centered 8pt in from the top-right corner of the map image on the
// top-right sheet of the layout (src/lib/exportPdf.ts ROSE_R/ROSE_GAP). Ground
// distances are derived from the print scale (1 paper inch = `scale` ground
// inches) so this stays accurate at any scale or sheet layout, then converted
// to degrees per-axis the same way the rest of this file's overlays do —
// a geographic "circle" is really an ellipse in raw lng/lat once you're
// accounting for a true ground radius in both directions.
function makeCompassFC(b: Bounds, fmt: FormatSettings) {
  const margin = MARGIN_SIZES[fmt.margins] ?? 0.5;
  const scale = fmt.scaleCustom ?? fmt.scale;

  const ROSE_R_PT = 34;
  const ROSE_GAP_PT = 8;
  const PT_PER_IN = 72;
  const IN_TO_M = 0.0254;

  const metersPerIn = scale * IN_TO_M;
  const marginM  = margin * metersPerIn;
  const insetM   = marginM + ((ROSE_R_PT + ROSE_GAP_PT) / PT_PER_IN) * metersPerIn;
  const radiusM  = (ROSE_R_PT / PT_PER_IN) * metersPerIn;

  // Sheets tile flush edge-to-edge, so the top-right sheet's own top-right
  // corner is simply the overall box's north/east edge — no need to divide
  // out the sheet grid to find it.
  const lat = b.north;
  const insetLng  = insetM  * degPerMLng(lat);
  const insetLat  = insetM  * DEG_PER_M_LAT;
  const radiusLng = radiusM * degPerMLng(lat);
  const radiusLat = radiusM * DEG_PER_M_LAT;

  const cx = b.east  - insetLng;
  const cy = b.north - insetLat;

  const steps = 48;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    ring.push([cx + radiusLng * Math.cos(theta), cy + radiusLat * Math.sin(theta)]);
  }

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Polygon" as const, coordinates: [ring] },
      },
    ],
  };
}

function makeNeatlineFC(b: Bounds) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [b.west, b.south], [b.east, b.south],
            [b.east, b.north], [b.west, b.north],
            [b.west, b.south],
          ],
        },
      },
    ],
  };
}

function makeDivisionsFC(b: Bounds, fmt: FormatSettings) {
  const [across, down] = getSheetGrid(fmt);
  const paper = effectivePaper(fmt);
  const w = b.east - b.west;
  const h = b.north - b.south;
  const divFeatures: object[] = [];
  const overlapFeatures: object[] = [];
  const OVERLAP_IN = 0.1;
  const overlapFracW = OVERLAP_IN / (paper.w * across);
  const overlapFracH = OVERLAP_IN / (paper.h * down);
  const odLng = (w * overlapFracW) / 2;
  const odLat = (h * overlapFracH) / 2;

  for (let col = 1; col < across; col++) {
    const x = b.west + (w * col) / across;
    divFeatures.push({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: [[x, b.south], [x, b.north]] },
    });
    overlapFeatures.push({
      type: "Feature", properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[x - odLng, b.south], [x + odLng, b.south],
                        [x + odLng, b.north], [x - odLng, b.north],
                        [x - odLng, b.south]]],
      },
    });
  }
  for (let row = 1; row < down; row++) {
    const y = b.south + (h * row) / down;
    divFeatures.push({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: [[b.west, y], [b.east, y]] },
    });
    overlapFeatures.push({
      type: "Feature", properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[b.west, y - odLat], [b.east, y - odLat],
                        [b.east, y + odLat], [b.west, y + odLat],
                        [b.west, y - odLat]]],
      },
    });
  }
  return {
    divFC:     { type: "FeatureCollection" as const, features: divFeatures     as GeoJSON.Feature[] },
    overlapFC: { type: "FeatureCollection" as const, features: overlapFeatures as GeoJSON.Feature[] },
  };
}

// ---------------------------------------------------------------------------
// Readout text
// ---------------------------------------------------------------------------

function buildReadout(fmt: FormatSettings, scale: number): string {
  const [across, down] = getSheetGrid(fmt);
  const total = across * down;
  const paperLabel =
    PAPER_SIZES.find((p) => p.id === fmt.paperSize)?.label ??
    `${fmt.paperWidthIn}″×${fmt.paperHeightIn}″`;
  const sheets =
    total === 1 ? "1 sheet" : `${total} sheets (${across}×${down})`;
  return `${sheets} at 1:${scale.toLocaleString()} on ${paperLabel}`;
}

function fmtArea(km2: number, units: "imperial" | "metric"): string {
  if (units === "metric") {
    return km2 >= 1 ? `${km2.toFixed(1)} km²` : `${(km2 * 1000).toFixed(0)} ha`;
  }
  const mi2 = km2 / 2.58999;
  return mi2 >= 1 ? `${mi2.toFixed(1)} mi²` : `${(mi2 * 640).toFixed(0)} ac`;
}

// ---------------------------------------------------------------------------
// Source IDs
// ---------------------------------------------------------------------------

const SRC = {
  dimming:  "area-dimming",
  margin:   "area-margin",
  neatline: "area-neatline",
  divs:     "area-divs",
  overlap:  "area-overlap",
  compass:  "area-compass",
};

// Access layer MapLibre source IDs (one per category + routes)
const ACC_SRC: Record<CategoryId | "routes", string> = {
  huntable:   "acc-huntable",
  no_hunting: "acc-no-hunting",
  closed:     "acc-closed",
  private:    "acc-private",
  unknown:    "acc-unknown",
  routes:     "acc-routes",
};

// ---------------------------------------------------------------------------
// AreaTab
// ---------------------------------------------------------------------------

export function AreaTab({ projectId, isActive, onBoundsChange, onFormatChangedExternally }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [format, setFormat] = useState<FormatSettings>(FORMAT_DEFAULTS);
  const [center, setCenter] = useState<{ lng: number; lat: number }>({
    lng: DEFAULT_AREA.centerLng,
    lat: DEFAULT_AREA.centerLat,
  });
  const [liveScale,  setLiveScale]  = useState<number>(FORMAT_DEFAULTS.scale);
  const [liveAreaKm, setLiveAreaKm] = useState<number>(0);
  const [units, setUnits] = useState<"imperial" | "metric">("imperial");

  // First-run modal — shown once until acknowledged
  const [showFirstRun, setShowFirstRun] = useState(false);
  // Click-to-inspect popup
  const [inspectTarget, setInspectTarget] = useState<InspectTarget | null>(null);

  // Pending confirmation for a box/corner resize that would change the scale
  // away from a standard preset — see commitResizedBounds below.
  const [customConfirm, setCustomConfirm] = useState<{
    bounds: Bounds;
    revertBounds: Bounds;
    fromScale: number;
    toScale: number;
  } | null>(null);

  // Input mode
  const [inputMode, setInputMode] = useState<InputMode>("box");
  const inputModeRef = useRef<InputMode>("box");

  // Mode 3 — corners (up to 4 clicked points; 4 = bounding box set)
  const [corners, setCorners] = useState<CornerPt[]>([]);
  const cornersRef = useRef<CornerPt[]>([]);

  // Mode 4 — coordinate entry fields
  const [coordFields, setCoordFields] = useState({ n: "", s: "", e: "", w: "" });
  const focusedFieldRef = useRef<string | null>(null);

  // Place search
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mutable refs
  const boundsRef  = useRef<Bounds | null>(null);
  const formatRef  = useRef<FormatSettings>(FORMAT_DEFAULTS);

  // Drag state — box mode
  const dragRef = useRef<{
    handle: BoxHandle;
    startX: number; startY: number;
    startBounds: Bounds;
  } | null>(null);

  // Drag state — corner mode (index 0-3 or null)
  const cornerDragRef = useRef<{
    index: number;
    startX: number; startY: number;
    startCorners: CornerPt[];
  } | null>(null);

  // Draw mode
  const rubberBandRef   = useRef<HTMLDivElement>(null);
  const drawStartRef    = useRef<{ x: number; y: number } | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Save timer
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation this tab loaded with; the backend refuses saves carrying a
  // stale one, which is how a restore wins the race regardless of timing.
  const generationRef = useRef(0);

  // ── 1. Load project format + area + units ─────────────────────────────────

  useEffect(() => {
    invoke<{ format?: FormatSettings; area?: AreaSettings }>(
      "get_project",
      { id: projectId }
    )
      .then((proj) => {
        generationRef.current = (proj as any).settingsGeneration ?? 0;
        const fmt  = (proj.format as FormatSettings | undefined) ?? FORMAT_DEFAULTS;
        const area = (proj.area  as AreaSettings   | undefined) ?? DEFAULT_AREA;
        setFormat(fmt);
        formatRef.current = fmt;
        setCenter({ lng: area.centerLng, lat: area.centerLat });
        setLiveScale(fmt.scaleCustom ?? fmt.scale);
      })
      .catch(console.error);
    invoke<{ units: string }>("get_settings")
      .then((s) => setUnits(s.units === "metric" ? "metric" : "imperial"))
      .catch(() => {});
  }, [projectId]);

  // ── 1b. Re-sync format on switching back to this tab ───────────────────────

  // This tab only ever loaded `format` once, on mount ([projectId] above) —
  // so changing the scale on the Format tab and switching here left the
  // bottom-bar label (and the box's actual on-map size) showing whatever was
  // true when the Area tab first mounted, one change behind. Live-verified:
  // changing scale on Format then switching to Area kept showing the old
  // value. Re-fetching on every activation (matching PreviewTab's pattern)
  // would be the obvious fix, but this tab — unlike Preview — has live
  // interactive state (an in-progress drag, a pending debounced save), so a
  // blind refetch on every switch risks clobbering an edit the user just
  // made with whatever was last persisted. Gating on "no save currently
  // pending" keeps this to exactly the case that was actually broken: format
  // changed *elsewhere* while this tab sat idle in the background.
  useEffect(() => {
    if (!isActive || saveTimer.current) return;
    invoke<{ format?: FormatSettings; settingsGeneration?: number }>("get_project", { id: projectId })
      .then((proj) => {
        const fmt = proj.format as FormatSettings | undefined;
        if (!fmt) return;
        generationRef.current = proj.settingsGeneration ?? generationRef.current;
        setFormat(fmt);
        formatRef.current = fmt;
        setLiveScale(fmt.scaleCustom ?? fmt.scale);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, projectId]);

  // ── 2. Reposition overlay elements from current map state ─────────────────

  const repositionOverlayElements = useCallback(() => {
    const map = mapRef.current;
    const b   = boundsRef.current;
    if (!map || !b) return;

    const [across, down] = getSheetGrid(formatRef.current);
    const w = b.east - b.west;
    const h = b.north - b.south;
    const midLng = (b.west + b.east) / 2;
    const midLat = (b.south + b.north) / 2;

    // Box-mode handles
    const pts: Record<BoxHandle, [number, number]> = {
      body: [midLng, midLat],
      nw: [b.west, b.north], n: [midLng, b.north], ne: [b.east, b.north],
      e:  [b.east, midLat],
      se: [b.east, b.south], s: [midLng, b.south], sw: [b.west, b.south],
      w:  [b.west, midLat],
    };
    for (const handle of BOX_HANDLES) {
      const el = document.getElementById(`area-h-${handle}`);
      if (!el) continue;
      if (handle === "body") {
        // Spans the whole print box (not just a dot at its center) so
        // dragging to reposition it works from anywhere inside, matching
        // how a print-area box is expected to behave.
        const nwPx = map.project([b.west, b.north]);
        const sePx = map.project([b.east, b.south]);
        el.style.left   = `${Math.min(nwPx.x, sePx.x)}px`;
        el.style.top    = `${Math.min(nwPx.y, sePx.y)}px`;
        el.style.width  = `${Math.abs(sePx.x - nwPx.x)}px`;
        el.style.height = `${Math.abs(sePx.y - nwPx.y)}px`;
      } else {
        const { x, y } = map.project(pts[handle] as [number, number]);
        el.style.left = `${x}px`;
        el.style.top  = `${y}px`;
      }
    }

    // Corner-mode handles (4 corners: NW, NE, SE, SW)
    const cPts = cornersFromBounds(b);
    for (let i = 0; i < 4; i++) {
      const el = document.getElementById(`area-corner-${i}`);
      if (el) {
        const { x, y } = map.project([cPts[i].lng, cPts[i].lat]);
        el.style.left = `${x}px`;
        el.style.top  = `${y}px`;
      }
    }

    // Corner-mode click markers (during placement)
    for (let i = 0; i < 4; i++) {
      const el = document.getElementById(`area-cpt-${i}`);
      if (el) {
        const c = cornersRef.current[i];
        if (c) {
          const { x, y } = map.project([c.lng, c.lat]);
          el.style.left    = `${x}px`;
          el.style.top     = `${y}px`;
          el.style.display = "block";
        } else {
          el.style.display = "none";
        }
      }
    }

    // Sheet labels
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let row = 0; row < down; row++) {
      for (let col = 0; col < across; col++) {
        const el = document.getElementById(`area-lbl-${col}-${row}`);
        if (el) {
          const lblLng = b.west + (col + 0.5) * w / across;
          const lblLat = b.north - (row + 0.5) * h / down;
          const { x, y } = map.project([lblLng, lblLat]);
          el.style.left = `${x}px`;
          el.style.top  = `${y}px`;
          el.textContent = `${letters[col]}${row + 1}`;
        }
      }
    }
  }, []);

  // ── 3. Update MapLibre sources + overlay ──────────────────────────────────

  const applyBounds = useCallback((b: Bounds) => {
    boundsRef.current = b;
    const map = mapRef.current;
    const fmt = formatRef.current;
    if (!map) return;

    (map.getSource(SRC.dimming)  as maplibregl.GeoJSONSource)?.setData(makeDimmingFC(b));
    (map.getSource(SRC.margin)   as maplibregl.GeoJSONSource)?.setData(makeMarginFC(b, fmt));
    (map.getSource(SRC.neatline) as maplibregl.GeoJSONSource)?.setData(makeNeatlineFC(b));
    const { divFC, overlapFC } = makeDivisionsFC(b, fmt);
    (map.getSource(SRC.divs)     as maplibregl.GeoJSONSource)?.setData(divFC);
    (map.getSource(SRC.overlap)  as maplibregl.GeoJSONSource)?.setData(overlapFC);
    (map.getSource(SRC.compass)  as maplibregl.GeoJSONSource)?.setData(makeCompassFC(b, fmt));

    repositionOverlayElements();
    onBoundsChange?.(b);

    const newScale = backComputeScale(b, fmt);
    setLiveScale(newScale);
    setLiveAreaKm(computeAreaKm2(b));

    // Sync coord fields when in coords mode (skip focused field)
    if (inputModeRef.current === "coords") {
      setCoordFields((prev) => ({
        n: focusedFieldRef.current === "n" ? prev.n : b.north.toFixed(5),
        s: focusedFieldRef.current === "s" ? prev.s : b.south.toFixed(5),
        e: focusedFieldRef.current === "e" ? prev.e : b.east.toFixed(5),
        w: focusedFieldRef.current === "w" ? prev.w : b.west.toFixed(5),
      }));
    }

    // Sync corners when in corners mode (editing, not placing)
    if (inputModeRef.current === "corners" && cornersRef.current.length === 4) {
      const cs = cornersFromBounds(b);
      cornersRef.current = cs;
      setCorners(cs);
    }
  }, [repositionOverlayElements]);

  // ── 4. Init MapLibre ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          usgs: {
            type: "raster",
            tiles: [
              "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            maxzoom: 16,
            attribution:
              "Tiles: USGS National Map (public domain)",
          },
        },
        layers: [{ id: "usgs-topo", type: "raster", source: "usgs" }],
      },
      center: [center.lng, center.lat],
      zoom: 10,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right"
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-left"
    );

    map.on("load", () => {
      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

      // ── Access layers (below area overlay) ─────────────────────────────────
      for (const id of Object.values(ACC_SRC)) {
        map.addSource(id, { type: "geojson", data: empty });
      }

      // Diagonal hatch pattern for Unknown (Cat 5)
      const hatchCanvas = document.createElement("canvas");
      hatchCanvas.width = hatchCanvas.height = 16;
      const hatchCtx = hatchCanvas.getContext("2d")!;
      hatchCtx.strokeStyle = "#757575";
      hatchCtx.lineWidth = 1.5;
      for (const [x1, y1, x2, y2] of [[-4, 12, 12, -4], [4, 20, 20, 4], [12, 28, 28, 12]] as [number, number, number, number][]) {
        hatchCtx.beginPath(); hatchCtx.moveTo(x1, y1); hatchCtx.lineTo(x2, y2); hatchCtx.stroke();
      }
      const hatchPixels = hatchCtx.getImageData(0, 0, 16, 16);
      map.addImage("hatch-unknown", {
        width: 16, height: 16,
        data: new Uint8Array(hatchPixels.data.buffer),
      });

      for (const cat of CATEGORIES) {
        const src = ACC_SRC[cat.id];
        map.addLayer({
          id: `acc-${cat.id}-fill`,
          type: "fill",
          source: src,
          paint: {
            "fill-color":   cat.color,
            "fill-opacity": cat.fillOpacity,
          },
        });
        map.addLayer({
          id: `acc-${cat.id}-line`,
          type: "line",
          source: src,
          paint: {
            "line-color": cat.outlineColor,
            "line-width": 0.6,
            "line-opacity": 0.5,
          },
        });
      }

      // Unknown category — overlay hatch pattern on top of the fill
      map.addLayer({
        id: "acc-unknown-hatch",
        type: "fill",
        source: ACC_SRC.unknown,
        paint: {
          "fill-pattern": "hatch-unknown",
          "fill-opacity": 0.55,
        },
      });

      // Public access routes — purple dashed line (source already added above)
      map.addLayer({
        id: "acc-routes-line",
        type: "line",
        source: ACC_SRC.routes,
        paint: {
          "line-color": "#6a1b9a",
          "line-width": 2,
          "line-dasharray": [4, 3],
        },
      });

      // Click-to-inspect on any access fill layer
      const accFillIds = CATEGORIES.map((c) => `acc-${c.id}-fill`);
      for (const layerId of accFillIds) {
        map.on("click", layerId, (e) => {
          const feat = e.features?.[0];
          if (!feat) return;
          setInspectTarget({
            screenX: e.originalEvent.clientX,
            screenY: e.originalEvent.clientY,
            props: (feat.properties ?? {}) as Record<string, unknown>,
          });
        });
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      // ── Area overlay sources ────────────────────────────────────────────────
      for (const id of Object.values(SRC)) map.addSource(id, { type: "geojson", data: empty });

      map.addLayer({ id: "area-dimming-fill",  type: "fill",   source: SRC.dimming,
        paint: { "fill-color": "#000", "fill-opacity": 0.45 } });
      map.addLayer({ id: "area-margin-fill",   type: "fill",   source: SRC.margin,
        paint: { "fill-color": "#888", "fill-opacity": 0.25 } });
      map.addLayer({ id: "area-overlap-fill",  type: "fill",   source: SRC.overlap,
        paint: { "fill-color": "#4466cc", "fill-opacity": 0.18 } });
      map.addLayer({ id: "area-divs-line",     type: "line",   source: SRC.divs,
        paint: { "line-color": "#4466cc", "line-width": 1.5, "line-dasharray": [6, 4] } });
      map.addLayer({ id: "area-neatline-line", type: "line",   source: SRC.neatline,
        paint: { "line-color": "#222", "line-width": 2.5 } });
      map.addLayer({ id: "area-compass-fill",  type: "fill",   source: SRC.compass,
        paint: { "fill-color": "#e67e22", "fill-opacity": 0.18 } });
      map.addLayer({ id: "area-compass-line",  type: "line",   source: SRC.compass,
        paint: { "line-color": "#e67e22", "line-width": 1.5, "line-dasharray": [3, 2] } });

      setMapReady(true);
    });

    map.on("move", repositionOverlayElements);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 5. Apply bounds whenever format or center changes ─────────────────────

  // The map is constructed once with whatever `center` happens to be at mount
  // (initially DEFAULT_AREA), then the real saved center arrives asynchronously
  // from get_project and only updates the *overlay* — nothing moved the camera
  // to match, so a project with a saved area opened showing Colorado's default
  // center with the actual print box invisible, off-screen. `center` state only
  // ever changes for that one project-load transition (dragging the box updates
  // a ref, not this state), so guarding with a ref gives an exactly-once camera
  // sync without re-centering every time the user changes format afterward.
  const cameraSyncedRef = useRef(false);

  useEffect(() => {
    if (!mapReady) return;
    formatRef.current = format;
    const b = boundsFromCenter(center.lng, center.lat, format);
    applyBounds(b);

    if (!cameraSyncedRef.current) {
      cameraSyncedRef.current = true;
      mapRef.current?.fitBounds(
        [[b.west, b.south], [b.east, b.north]],
        { padding: 80, duration: 0 }
      );
    }
  }, [mapReady, format, center, applyBounds]);

  // ── 5b. Show first-run modal once on first Area tab visit ─────────────────

  useEffect(() => {
    if (!isActive) return;
    // Check app settings first (reliable across both build paths), fall back to
    // localStorage for any previously acknowledged sessions before this change.
    invoke<Record<string, unknown>>("get_settings")
      .then((s) => {
        if (!s[ACCESS_ACK_KEY]) {
          try {
            if (!localStorage.getItem(ACCESS_ACK_KEY)) setShowFirstRun(true);
          } catch {
            setShowFirstRun(true);
          }
        }
      })
      .catch(() => {
        try {
          if (!localStorage.getItem(ACCESS_ACK_KEY)) setShowFirstRun(true);
        } catch { /* skip */ }
      });
  }, [isActive]);

  // ── 6. Resize map when tab becomes active ─────────────────────────────────

  useEffect(() => {
    if (isActive && mapRef.current) {
      requestAnimationFrame(() => {
        mapRef.current?.resize();
        repositionOverlayElements();
      });
    }
  }, [isActive, repositionOverlayElements]);

  // ── 7. Save helper ────────────────────────────────────────────────────────

  const scheduleSave = useCallback((b: Bounds, onSaved?: () => void) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // This timer deliberately survives unmount so a last-moment reposition still
    // lands; the epoch check is what stops it landing on top of a restore. It
    // matters doubly here because this writes format settings (scale) as well.
    const epoch = captureSaveEpoch();
    saveTimer.current = setTimeout(() => {
      if (!isSaveEpochCurrent(epoch)) return; // superseded by a restore
      const lng = (b.west + b.east)   / 2;
      const lat = (b.south + b.north) / 2;
      const newScale = backComputeScale(b, formatRef.current);
      // A resize that lands off every standard preset is a custom scale,
      // full stop — mark it so the Format tab's Scale section actually shows
      // "Custom" selected instead of highlighting nothing. This applies
      // regardless of whether the caller routed through the confirmation
      // dialog below; draw/coords/initial-placement don't, but should still
      // end up with a self-consistent saved format.
      const isStandard = STANDARD_SCALES.some((s) => s.value === newScale);
      const generation = generationRef.current;

      // Neither write bumps the generation (only full-document rewrites do), so
      // both legs of this save carry the same one. Sequenced rather than fired
      // in parallel so a refusal short-circuits the second write too.
      const onFailure = (err: unknown) => {
        if (isStaleGenerationError(err)) return; // superseded by a restore
        console.error("Area save failed:", err);
      };

      invoke<number>("save_area_settings", {
        id: projectId,
        area: { centerLng: lng, centerLat: lat } satisfies AreaSettings,
        expectedGeneration: generation,
      })
        .then(() =>
          invoke<number>("save_format_settings", {
            id: projectId,
            format: {
              ...formatRef.current,
              scale: newScale,
              scaleCustom: isStandard ? null : newScale,
            },
            expectedGeneration: generation,
          })
        )
        .then((g) => { generationRef.current = g; onSaved?.(); })
        .catch(onFailure);
    }, 600);
  }, [projectId]);

  // Wraps scheduleSave for interactions that *resize an existing box*
  // (drag handles, corner drag) rather than create a fresh one (draw, coords
  // entry, initial corner placement) — resizing an already-set area is the
  // one that's easy to do by accident, so it's the one worth a confirmation
  // when it lands on a non-standard scale. `revertBounds` is what the box
  // snaps back to if the user cancels.
  const commitResizedBounds = useCallback((b: Bounds, revertBounds: Bounds) => {
    const toScale = backComputeScale(b, formatRef.current);
    const fromScale = formatRef.current.scaleCustom ?? formatRef.current.scale;
    const scaleChanged = toScale !== fromScale;
    const goingCustom = !STANDARD_SCALES.some((s) => s.value === toScale);
    // Once already on a custom scale, further resizes that stay custom don't
    // need re-confirming each time — only the standard→custom transition does.
    const alreadyCustom = formatRef.current.scaleCustom !== null;
    // "Both locked" means neither the scale nor the sheet count is allowed to
    // give way silently — so unlike the other two lock modes, ANY resize here
    // needs confirmation, not just ones that land off a standard preset.
    const bothLocked = formatRef.current.scaleLock === "both";

    if (scaleChanged && (bothLocked || (goingCustom && !alreadyCustom))) {
      setCustomConfirm({ bounds: b, revertBounds, fromScale, toScale });
      return;
    }
    scheduleSave(b);
  }, [scheduleSave]);

  function confirmCustomFormat() {
    if (!customConfirm) return;
    // Wait for the save to actually land before telling WorkspaceScreen to
    // refresh the other tabs — remounting immediately would race the 600ms
    // debounce and FormatTab would re-read the *pre*-switch data.
    scheduleSave(customConfirm.bounds, onFormatChangedExternally);
    setCustomConfirm(null);
  }

  function cancelCustomFormat() {
    if (!customConfirm) return;
    applyBounds(customConfirm.revertBounds);
    // In corner mode the four draggable corner dots are tracked separately
    // from the box overlay — without this they'd stay at the rejected
    // positions even though the box itself snapped back.
    if (cornersRef.current.length === 4) {
      const revertedCorners = cornersFromBounds(customConfirm.revertBounds);
      cornersRef.current = revertedCorners;
      setCorners(revertedCorners);
    }
    scheduleSave(customConfirm.revertBounds); // persist the reverted size
    setCustomConfirm(null);
  }

  // ── 8. Box-mode drag ──────────────────────────────────────────────────────

  const startBoxDrag = useCallback((handle: BoxHandle, clientX: number, clientY: number) => {
    const b = boundsRef.current;
    if (!b) return;
    dragRef.current = { handle, startX: clientX, startY: clientY, startBounds: { ...b } };
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current || !mapRef.current) return;
      const map = mapRef.current;
      const { handle, startX, startY, startBounds: sb } = dragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let { west, east, south, north } = sb;
      const midLng = (sb.west + sb.east) / 2;
      const midLat = (sb.south + sb.north) / 2;

      if (handle === "body") {
        const origin = map.project([midLng, midLat]);
        const { lng, lat } = map.unproject([origin.x + dx, origin.y + dy]);
        const dLng = lng - midLng;
        const dLat = lat - midLat;
        west  = sb.west  + dLng; east  = sb.east  + dLng;
        south = sb.south + dLat; north = sb.north + dLat;
      } else {
        const swPx = map.project([sb.west, sb.south]);
        const nePx = map.project([sb.east, sb.north]);
        if (handle.includes("w")) { west  = Math.min(map.unproject([swPx.x + dx, swPx.y]).lng, east  - 0.002); }
        if (handle.includes("e")) { east  = Math.max(map.unproject([nePx.x + dx, nePx.y]).lng, west  + 0.002); }
        if (handle.includes("n")) { north = Math.max(map.unproject([nePx.x, nePx.y + dy]).lat, south + 0.002); }
        if (handle.includes("s")) { south = Math.min(map.unproject([swPx.x, swPx.y + dy]).lat, north - 0.002); }
      }
      applyBounds({ west, east, south, north });
    }
    function onUp() {
      if (!dragRef.current) return;
      const b = boundsRef.current;
      const { handle, startBounds } = dragRef.current;
      // Only a resize (not a pure body reposition) can change the scale, so
      // only resizes go through the confirm-before-save path.
      if (b) {
        if (handle === "body") scheduleSave(b);
        else commitResizedBounds(b, startBounds);
      }
      dragRef.current = null;
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [applyBounds, scheduleSave]);

  // ── 9. Draw-mode rubber-band ──────────────────────────────────────────────

  function updateRubberBand(sx: number, sy: number, ex: number, ey: number) {
    const el = rubberBandRef.current;
    if (!el) return;
    const left   = Math.min(sx, ex);
    const top    = Math.min(sy, ey);
    const width  = Math.abs(ex - sx);
    const height = Math.abs(ey - sy);
    el.style.left    = `${left}px`;
    el.style.top     = `${top}px`;
    el.style.width   = `${width}px`;
    el.style.height  = `${height}px`;
    el.style.display = (width > 4 && height > 4) ? "block" : "none";
  }

  function clearRubberBand() {
    const el = rubberBandRef.current;
    if (el) el.style.display = "none";
  }

  // ── 10. Corner-mode drag (editing 4 bounding box corners) ─────────────────

  const startCornerDrag = useCallback((index: number, clientX: number, clientY: number) => {
    const cs = cornersRef.current;
    if (cs.length !== 4) return;
    cornerDragRef.current = {
      index,
      startX: clientX, startY: clientY,
      startCorners: [...cs],
    };
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!cornerDragRef.current || !mapRef.current) return;
      const map = mapRef.current;
      const { index, startX, startY, startCorners } = cornerDragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Corner indices: 0=NW 1=NE 2=SE 3=SW
      const sc = startCorners[index];
      const startPx = map.project([sc.lng, sc.lat]);
      const newPt   = map.unproject([startPx.x + dx, startPx.y + dy]);

      const updated = [...startCorners];
      updated[index] = { lat: newPt.lat, lng: newPt.lng };

      const b = boundsFromPoints(updated);
      if (b.east - b.west < 0.002 || b.north - b.south < 0.002) return;

      const newCorners = cornersFromBounds(b);
      cornersRef.current = newCorners;
      setCorners(newCorners);
      applyBounds(b);
    }
    function onUp() {
      if (!cornerDragRef.current) return;
      const b = boundsRef.current;
      if (b) {
        const revertBounds = boundsFromPoints(cornerDragRef.current.startCorners);
        commitResizedBounds(b, revertBounds);
      }
      cornerDragRef.current = null;
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [applyBounds, commitResizedBounds]);

  // ── 11. Switch mode ───────────────────────────────────────────────────────

  function switchMode(mode: InputMode) {
    inputModeRef.current = mode;
    setInputMode(mode);
    clearRubberBand();
    setIsDrawing(false);

    const b = boundsRef.current;
    if (mode === "coords" && b) {
      setCoordFields({
        n: b.north.toFixed(5),
        s: b.south.toFixed(5),
        e: b.east.toFixed(5),
        w: b.west.toFixed(5),
      });
    }
    if (mode === "corners") {
      if (b) {
        // Pre-populate 4 corners from current box
        const cs = cornersFromBounds(b);
        cornersRef.current = cs;
        setCorners(cs);
      } else {
        cornersRef.current = [];
        setCorners([]);
      }
    }
    if (mode === "draw" || mode === "box") {
      // Clear corner placement state
      cornersRef.current = [];
      setCorners([]);
    }
  }

  // ── 12. Coordinate entry → apply bounds ───────────────────────────────────

  function handleCoordChange(field: "n" | "s" | "e" | "w", value: string) {
    setCoordFields((prev) => ({ ...prev, [field]: value }));
    const b = boundsRef.current;
    if (!b) return;
    const parsed = parseDeg(value);
    if (parsed === null) return;
    let { west, east, south, north } = b;
    if (field === "n") north = parsed;
    if (field === "s") south = parsed;
    if (field === "e") east  = parsed;
    if (field === "w") west  = parsed;
    if (north <= south || east <= west) return;
    if (east - west < 0.002 || north - south < 0.002) return;
    applyBounds({ west, east, south, north });
    scheduleSave({ west, east, south, north });
  }

  // ── 13. Corner click placement ─────────────────────────────────────────────

  // Map click handler — only active in "corners" mode before 4 points are set
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (inputMode !== "corners") return;

    function onClick(e: maplibregl.MapMouseEvent) {
      // Only add corners during placement phase
      if (cornersRef.current.length >= 4) return;
      const { lng, lat } = e.lngLat;
      const updated = [...cornersRef.current, { lat, lng }];
      cornersRef.current = updated;
      setCorners([...updated]);
      repositionOverlayElements();

      if (updated.length === 4) {
        // Compute bounding box from the 4 clicked points
        const b = boundsFromPoints(updated);
        const cs = cornersFromBounds(b);
        cornersRef.current = cs;
        setCorners(cs);
        applyBounds(b);
        scheduleSave(b);
      }
    }

    map.on("click", onClick);
    return () => { map.off("click", onClick); };
  }, [mapReady, inputMode, applyBounds, scheduleSave, repositionOverlayElements]);

  // Change cursor when corner mode is placing
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const placing = inputMode === "corners" && corners.length < 4;
    map.getCanvas().style.cursor = placing ? "crosshair" : "";
  }, [inputMode, corners.length]);

  // ── 14. Place search ──────────────────────────────────────────────────────

  function handleSearchInput(q: string) {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => runSearch(q), 500);
  }

  async function runSearch(q: string) {
    q = q.trim();
    if (!q) return;

    // Try parsing as "lat, lng" coordinate pair
    const coordM = q.match(/^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/);
    if (coordM) {
      const lat = parseFloat(coordM[1]);
      const lng = parseFloat(coordM[2]);
      if (isFinite(lat) && isFinite(lng)) {
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 10 });
        setSearchResults([]);
        return;
      }
    }

    setSearchLoading(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      const data: Array<{ display_name: string; lat: string; lon: string }> = await resp.json();
      setSearchResults(data.map((d) => ({
        name: d.display_name,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
      })));
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  function flyToResult(r: SearchResult) {
    mapRef.current?.flyTo({ center: [r.lon, r.lat], zoom: 10 });
    setSearchResults([]);
    setSearchQuery("");
  }

  // ── Sheet label grid ───────────────────────────────────────────────────────

  const [across, down] = getSheetGrid(format);
  const labelSlots: { col: number; row: number }[] = [];
  for (let row = 0; row < down; row++)
    for (let col = 0; col < across; col++)
      labelSlots.push({ col, row });

  // ── Render ─────────────────────────────────────────────────────────────────

  const placingCorners = inputMode === "corners" && corners.length < 4;
  const editingCorners = inputMode === "corners" && corners.length === 4;

  return (
    <div className="area-tab">
      {/* Full-screen map */}
      <div ref={mapContainerRef} className="area-map" />

      {/* Draw-mode capture layer (sits above map, below panel) */}
      {inputMode === "draw" && (
        <div
          className="area-draw-capture"
          onMouseDown={(e) => {
            e.preventDefault();
            const rect = mapContainerRef.current!.getBoundingClientRect();
            drawStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            setIsDrawing(true);
          }}
          onMouseMove={(e) => {
            if (!drawStartRef.current || !isDrawing) return;
            const rect = mapContainerRef.current!.getBoundingClientRect();
            const ex = e.clientX - rect.left;
            const ey = e.clientY - rect.top;
            updateRubberBand(drawStartRef.current.x, drawStartRef.current.y, ex, ey);
          }}
          onMouseUp={(e) => {
            if (!drawStartRef.current || !mapRef.current || !isDrawing) return;
            const rect   = mapContainerRef.current!.getBoundingClientRect();
            const ex     = e.clientX - rect.left;
            const ey     = e.clientY - rect.top;
            const { x: sx, y: sy } = drawStartRef.current;
            // Need at least 10px in both directions to register as a draw.
            // The drag only picks a location — the box itself keeps the
            // paper/scale/sheet-count already selected on the Format tab
            // (matching how Box mode's own drag behaves), rather than
            // stretching to whatever arbitrary rectangle was dragged.
            if (Math.abs(ex - sx) > 10 && Math.abs(ey - sy) > 10) {
              const { lng, lat } = mapRef.current.unproject([(sx + ex) / 2, (sy + ey) / 2]);
              const b = boundsFromCenter(lng, lat, formatRef.current);
              applyBounds(b);
              scheduleSave(b);
            }
            clearRubberBand();
            drawStartRef.current = null;
            setIsDrawing(false);
          }}
          onMouseLeave={() => {
            if (isDrawing) {
              clearRubberBand();
              drawStartRef.current = null;
              setIsDrawing(false);
            }
          }}
        />
      )}

      {/* HTML overlay — handles, corner handles, sheet labels, rubber band */}
      <div className="area-overlay" aria-hidden="true">
        {/* Box-mode handles */}
        {inputMode === "box" && BOX_HANDLES.map((h) => (
          <div
            key={h}
            id={`area-h-${h}`}
            className={`area-handle area-handle--${h === "body" ? "body" : "edge"}`}
            style={{ cursor: HANDLE_CURSOR[h] }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              document.body.style.cursor = HANDLE_CURSOR[h];
              startBoxDrag(h, e.clientX, e.clientY);
            }}
          />
        ))}

        {/* Corner-mode: numbered corner handles (editing phase) */}
        {editingCorners && [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            id={`area-corner-${i}`}
            className="area-corner-handle"
            title={CORNER_LABELS[i]}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              document.body.style.cursor = "nwse-resize";
              startCornerDrag(i, e.clientX, e.clientY);
            }}
          >
            {i + 1}
          </div>
        ))}

        {/* Corner-mode: click-placement markers (placement phase) */}
        {placingCorners && [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            id={`area-cpt-${i}`}
            className="area-click-marker"
            style={{ display: "none" }}
          >
            {i + 1}
          </div>
        ))}

        {/* Sheet reference labels */}
        {labelSlots.map(({ col, row }) => (
          <div
            key={`${col}-${row}`}
            id={`area-lbl-${col}-${row}`}
            className="area-sheet-label"
          />
        ))}

        {/* Rubber band (draw mode) */}
        <div ref={rubberBandRef} className="area-rubber-band" style={{ display: "none" }} />
      </div>

      {/* ── Control panel ── */}
      <div className="area-panel" role="complementary" aria-label="Area input controls">

        {/* Search */}
        <div className="area-search-wrap">
          <input
            className="area-search-input"
            type="search"
            placeholder="Search place or enter lat, lng…"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(searchQuery); }}
            aria-label="Search places"
          />
          {searchLoading && <span className="area-search-spinner" aria-hidden="true" />}
          {searchResults.length > 0 && (
            <ul className="area-search-results" role="listbox">
              {searchResults.map((r, i) => (
                <li
                  key={i}
                  role="option"
                  aria-selected={false}
                  className="area-search-result"
                  onClick={() => flyToResult(r)}
                >
                  {r.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Mode selector */}
        <div className="area-mode-bar" role="group" aria-label="Input method">
          {(["box", "draw", "corners", "coords"] as InputMode[]).map((m) => (
            <button
              key={m}
              className={`area-mode-btn${inputMode === m ? " area-mode-btn--active" : ""}`}
              onClick={() => switchMode(m)}
              title={
                m === "box"     ? "Position the format box" :
                m === "draw"    ? "Draw a box by dragging" :
                m === "corners" ? "Click 4 corners to define area" :
                "Enter coordinates"
              }
            >
              {m === "box" ? "Box" : m === "draw" ? "Draw" : m === "corners" ? "4 Pt" : "Coords"}
            </button>
          ))}
        </div>

        {/* Mode-specific content */}
        <div className="area-mode-content">
          {inputMode === "box" && (
            <p className="area-mode-hint">
              Drag the box or edge handles to reposition and resize the print area.
            </p>
          )}

          {inputMode === "draw" && (
            <p className="area-mode-hint">
              {isDrawing
                ? "Release to set the area."
                : "Drag anywhere on the map to draw the print area."}
            </p>
          )}

          {inputMode === "corners" && placingCorners && (
            <div>
              <p className="area-mode-hint">
                Click the map to place corner {corners.length + 1} of 4.
              </p>
              {corners.length > 0 && (
                <ul className="area-corner-list">
                  {corners.map((c, i) => (
                    <li key={i} className="area-corner-row placed">
                      <span className="area-corner-num">{i + 1}</span>
                      <span className="area-corner-coord">
                        {c.lat.toFixed(4)}°, {c.lng.toFixed(4)}°
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {corners.length > 0 && (
                <button
                  className="area-clear-btn"
                  onClick={() => { cornersRef.current = []; setCorners([]); repositionOverlayElements(); }}
                >
                  Clear corners
                </button>
              )}
            </div>
          )}

          {inputMode === "corners" && editingCorners && (
            <div>
              <p className="area-mode-hint">
                Drag a corner handle to reshape. The box snaps north-up.
              </p>
              <ul className="area-corner-list">
                {corners.map((c, i) => (
                  <li key={i} className="area-corner-row placed">
                    <span className="area-corner-num">{i + 1}</span>
                    <span className="area-corner-label">{CORNER_LABELS[i]}</span>
                    <span className="area-corner-coord">
                      {c.lat.toFixed(4)}°, {c.lng.toFixed(4)}°
                    </span>
                  </li>
                ))}
              </ul>
              <button
                className="area-clear-btn"
                onClick={() => { cornersRef.current = []; setCorners([]); repositionOverlayElements(); }}
              >
                Reset corners
              </button>
            </div>
          )}

          {inputMode === "coords" && (
            <div className="area-coord-grid" aria-label="Bounding coordinates">
              {(["n", "s", "e", "w"] as const).map((f) => {
                const labels = { n: "North", s: "South", e: "East", w: "West" };
                const placeholder = {
                  n: "e.g. 40.0000", s: "e.g. 39.5000",
                  e: "e.g. -105.00", w: "e.g. -106.00",
                }[f];
                return (
                  <div key={f} className="area-coord-row">
                    <label className="area-coord-label" htmlFor={`area-coord-${f}`}>
                      {labels[f]}
                    </label>
                    <input
                      id={`area-coord-${f}`}
                      className="area-coord-input"
                      type="text"
                      inputMode="decimal"
                      value={coordFields[f]}
                      placeholder={placeholder}
                      onFocus={() => { focusedFieldRef.current = f; }}
                      onBlur={() => { focusedFieldRef.current = null; }}
                      onChange={(e) => handleCoordChange(f, e.target.value)}
                      aria-label={`${labels[f]} boundary`}
                    />
                  </div>
                );
              })}
              <p className="area-coord-hint">Decimal degrees or DMS (e.g. 39°30′0″N)</p>
            </div>
          )}
        </div>

        {/* Area size readout */}
        {liveAreaKm > 0 && (
          <div className="area-size-row">
            <span className="area-size-label">Area</span>
            <span className="area-size-value">{fmtArea(liveAreaKm, units)}</span>
            {units === "imperial"
              ? <span className="area-size-secondary">({fmtArea(liveAreaKm, "metric")})</span>
              : <span className="area-size-secondary">({fmtArea(liveAreaKm, "imperial")})</span>}
          </div>
        )}

        {/* Counties placeholder */}
        <div className="area-counties-placeholder">
          <span className="area-counties-icon" aria-hidden="true">🗺</span>
          <span className="area-counties-text">County detection in Stage 19</span>
        </div>
      </div>

      {/* Scale readout pill */}
      <div className="area-readout" aria-live="polite">
        {buildReadout(format, liveScale)}
      </div>

      {/* Click-to-inspect popup */}
      {inspectTarget && (
        <AccessInspectPopup
          target={inspectTarget}
          onClose={() => setInspectTarget(null)}
        />
      )}

      {/* First-run access disclaimer modal (§6.3) */}
      {showFirstRun && (
        <AccessFirstRunModal onAck={() => setShowFirstRun(false)} />
      )}

      {/* Confirm before a box/corner resize switches the project to a custom scale */}
      {customConfirm && (
        <CustomFormatConfirmDialog
          fromScale={customConfirm.fromScale}
          toScale={customConfirm.toScale}
          onConfirm={confirmCustomFormat}
          onCancel={cancelCustomFormat}
        />
      )}
    </div>
  );
}
