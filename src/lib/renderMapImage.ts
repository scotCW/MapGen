import * as maplibregl from "maplibre-gl";
import type { Bounds } from "./geo";

export interface RasterLayer {
  id: string;
  tiles: string[];
  tileSize?: number;
  opacity?: number;
}

export interface RenderOptions {
  bounds: Bounds;
  pixelW: number;
  pixelH: number;
  /** Layers in draw order (index 0 = bottom). Only raster XYZ layers supported. */
  rasterLayers: RasterLayer[];
  timeoutMs?: number;
}

/**
 * Renders a MapLibre GL JS map to a JPEG data URL using an offscreen DOM element.
 * The map is fitted exactly to `bounds` within `pixelW × pixelH` pixels at pixelRatio=1.
 */
export async function renderMapImage(opts: RenderOptions): Promise<string> {
  const { bounds, pixelW, pixelH, rasterLayers, timeoutMs = 40_000 } = opts;

  if (rasterLayers.length === 0) {
    throw new Error("No raster layers provided for map render");
  }

  const container = document.createElement("div");
  container.style.cssText =
    `width:${pixelW}px;height:${pixelH}px;` +
    "position:absolute;top:-999999px;left:-999999px;visibility:hidden;";
  document.body.appendChild(container);

  const sources: Record<string, maplibregl.RasterSourceSpecification> = {};
  const layers: maplibregl.LayerSpecification[] = [
    { id: "bg", type: "background", paint: { "background-color": "#f0ece5" } },
  ];

  for (const rl of rasterLayers) {
    sources[rl.id] = {
      type: "raster",
      tiles: rl.tiles,
      tileSize: rl.tileSize ?? 256,
    };
    layers.push({
      id: rl.id,
      type: "raster",
      source: rl.id,
      paint: rl.opacity != null ? { "raster-opacity": rl.opacity } : {},
    });
  }

  let map: maplibregl.Map | null = null;
  try {
    map = new maplibregl.Map({
      container,
      style: { version: 8, sources, layers },
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      fitBoundsOptions: { padding: 0, animate: false },
      canvasContextAttributes: { preserveDrawingBuffer: true },
      interactive: false,
      attributionControl: false,
      pixelRatio: 1,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Map render timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
      map!.once("idle", () => { clearTimeout(timer); resolve(); });
      map!.once("error", (e) => { clearTimeout(timer); reject(e.error ?? new Error("Map error")); });
    });

    return map.getCanvas().toDataURL("image/jpeg", 0.92);
  } finally {
    map?.remove();
    container.remove();
  }
}
