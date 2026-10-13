/**
 * Downloaded vector layers: loading the merged layer config, reading a
 * layer's GeoJSON back from the data directory, and turning a layer's config
 * style into MapLibre layers. Shared by the Layers tab (interactive map) and
 * the Preview/Export renderers so all three draw the same thing.
 */

import type * as maplibregl from "maplibre-gl";
import { invoke } from "./ipc";
import type { LayerConfig, LayerSettings, NationalLayerConfig, StateLayerConfig } from "../types/layers";
import { mergeStateConfig } from "../types/layers";
import type { LayerManifestEntry } from "../types/data";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** National layer config merged with the project's state config, if any. */
export async function loadLayerConfig(stateId: string | null | undefined): Promise<NationalLayerConfig> {
  const natRes = await fetch("/regions/_national.json");
  if (!natRes.ok) throw new Error(`HTTP ${natRes.status} loading _national.json`);
  let cfg: NationalLayerConfig = await natRes.json();
  if (!stateId) return cfg;
  try {
    const manifestRes = await fetch("/regions/_states.json");
    if (!manifestRes.ok) return cfg;
    const manifest = await manifestRes.json();
    const entry = manifest.states?.find((s: { id: string }) => s.id === stateId);
    if (!entry?.file) return cfg;
    const stateRes = await fetch(`/regions/${entry.file}.json`);
    if (stateRes.ok) cfg = mergeStateConfig(cfg, (await stateRes.json()) as StateLayerConfig);
  } catch {
    // State config load failure is non-fatal — national layers still work.
    console.warn(`Could not load state config for ${stateId}`);
  }
  return cfg;
}

/** True for layers drawn from a downloaded GeoJSON file rather than tiles. */
export function isVectorLayer(layer: LayerConfig): boolean {
  return layer.sourceType === "geojson" && layer.renderType !== "raster";
}

// ---------------------------------------------------------------------------
// Downloaded data
// ---------------------------------------------------------------------------

export async function listDownloaded(stateId: string | null | undefined): Promise<LayerManifestEntry[]> {
  if (!stateId) return [];
  try {
    return await invoke<LayerManifestEntry[]>("list_downloaded_layers", { stateId });
  } catch {
    return [];
  }
}

// Parsed GeoJSON is cached per file version (downloadedAt), so switching tabs
// or re-rendering doesn't re-read and re-parse tens of megabytes each time.
const cache = new Map<string, Promise<GeoJSON.FeatureCollection>>();

export function loadLayerData(stateId: string, entry: LayerManifestEntry): Promise<GeoJSON.FeatureCollection> {
  const key = `${stateId}/${entry.layerId}@${entry.downloadedAt}`;
  let p = cache.get(key);
  if (!p) {
    p = invoke<ArrayBuffer | number[]>("read_layer_data", { stateId, layerId: entry.layerId }).then((raw) => {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
      return JSON.parse(new TextDecoder().decode(bytes)) as GeoJSON.FeatureCollection;
    });
    // A failed read shouldn't be cached forever.
    p.catch(() => cache.delete(key));
    for (const k of cache.keys()) {
      if (k.startsWith(`${stateId}/${entry.layerId}@`) && k !== key) cache.delete(k);
    }
    cache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/**
 * MapLibre layers for one vector layer, drawn from the same `style` block the
 * Layers panel swatch shows. `opacity` is the per-project slider value (fill
 * opacity for polygons, line opacity for line layers); `pxPerPt` converts
 * the config's point stroke widths to pixels at the target resolution.
 */
export function vectorStyleLayers(
  layer: LayerConfig,
  sourceId: string,
  opacity: number,
  pxPerPt: number,
): maplibregl.LayerSpecification[] {
  const s = layer.style ?? {};
  const stroke = s.strokeColor ?? s.fillColor ?? "#555555";
  const widthPx = Math.max(0.5, (s.strokeWidth ?? 1) * pxPerPt);
  const linePaint: Record<string, unknown> = { "line-color": stroke, "line-width": widthPx };
  // MapLibre dash lengths are multiples of the line width; config dashes are in points.
  if (s.strokeDash?.length) linePaint["line-dasharray"] = s.strokeDash.map((d) => (d * pxPerPt) / widthPx);

  const out: maplibregl.LayerSpecification[] = [];
  if (layer.renderType === "fill") {
    out.push({
      id: `${sourceId}-fill`, type: "fill", source: sourceId,
      filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
      paint: { "fill-color": s.fillColor ?? stroke, "fill-opacity": opacity },
    });
    out.push({
      id: `${sourceId}-line`, type: "line", source: sourceId,
      paint: { ...linePaint, "line-opacity": Math.min(1, opacity + 0.4) } as maplibregl.LineLayerSpecification["paint"],
    });
  } else if (layer.renderType === "line") {
    out.push({
      id: `${sourceId}-line`, type: "line", source: sourceId,
      paint: { ...linePaint, "line-opacity": opacity } as maplibregl.LineLayerSpecification["paint"],
    });
  } else if (layer.renderType === "circle") {
    out.push({
      id: `${sourceId}-circle`, type: "circle", source: sourceId,
      paint: {
        "circle-color": s.fillColor ?? stroke, "circle-opacity": opacity,
        "circle-radius": 3 * pxPerPt, "circle-stroke-color": stroke, "circle-stroke-width": widthPx,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering (Preview / Export)
// ---------------------------------------------------------------------------

export interface VectorLayer {
  id: string;
  config: LayerConfig;
  data: GeoJSON.FeatureCollection;
  opacity: number;
}

/**
 * The enabled, downloaded vector layers for a project, in config order
 * (bottom to top), with their data loaded. Layers that fail to load are
 * skipped with a warning rather than failing the whole render.
 */
export async function collectVectorLayers(
  stateId: string | null | undefined,
  layers: LayerSettings,
  cfg: NationalLayerConfig,
): Promise<VectorLayer[]> {
  if (!stateId) return [];
  const downloaded = new Map((await listDownloaded(stateId)).map((e) => [e.layerId, e]));
  const out: VectorLayer[] = [];
  for (const group of cfg.groups) {
    for (const layer of group.layers) {
      const entry = downloaded.get(layer.id);
      if (!entry || !isVectorLayer(layer) || !layers.enabledLayers.includes(layer.id)) continue;
      try {
        const data = await loadLayerData(stateId, entry);
        out.push({ id: layer.id, config: layer, data, opacity: layers.layerOpacities[layer.id] ?? layer.defaultOpacity });
      } catch (e) {
        console.warn(`Could not load downloaded layer ${layer.id}:`, e);
      }
    }
  }
  return out;
}
