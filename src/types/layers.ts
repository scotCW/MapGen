// Layer config schema — mirrors public/regions/_national.json (and region overrides).
// Never hardcode layer definitions into UI or map logic; derive everything from these types.

export interface LayerStyle {
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  strokeDash?: number[];
  pattern?: "solid" | "diagonal-hatch" | "cross-hatch" | "dots" | "none";
}

export interface LayerConfig {
  id: string;
  name: string;
  description: string;
  sourceType: "xyz" | "wmts" | "geojson" | "shapefile";
  renderType: "raster" | "fill" | "line" | "circle";
  // XYZ / WMTS raster sources
  tiles?: string[];
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  // Attribution and license (always surfaced)
  attribution: string;
  license: string;
  // Defaults for new projects
  defaultOn: boolean;
  defaultOpacity: number;
  // Availability
  onlineOnly: boolean;
  downloadable: boolean;
  downloadUrl?: string;
  requiresDownload?: boolean;
  // Land access specific
  accessCategory?: number; // 0 = access routes, 1-5 = categories
  style?: LayerStyle;
}

export interface LayerGroup {
  id: string;
  label: string;
  description: string;
  controlType: "radio" | "checkbox";
  special?: "land_access";
  layers: LayerConfig[];
}

export interface NationalLayerConfig {
  schemaVersion: number;
  region: string;
  description: string;
  groups: LayerGroup[];
}

export interface CountyBoundarySource {
  url: string;
  nameField: string;
  fipsField?: string;
  stateFips: string;
  attribution: string;
  license: string;
}

export interface StateLayerConfig {
  schemaVersion: number;
  stateId: string;    // e.g. "CO", "WY"
  stateName: string;
  description: string;
  countyBoundarySource?: CountyBoundarySource;
  groups: LayerGroup[];
}

export interface StateManifestEntry {
  id: string;   // "CO"
  name: string; // "Colorado"
  file: string; // "colorado"
}

export interface StatesManifest {
  schemaVersion: number;
  states: StateManifestEntry[];
}

/** Merge a state config's groups into the national config groups.
 *  State groups with a matching id extend the national group's layer list;
 *  novel group ids are appended after the national groups. */
export function mergeStateConfig(
  national: NationalLayerConfig,
  state: StateLayerConfig,
): NationalLayerConfig {
  const merged: LayerGroup[] = national.groups.map((g) => {
    const stateGroup = state.groups.find((sg) => sg.id === g.id);
    if (!stateGroup) return g;
    return { ...g, layers: [...g.layers, ...stateGroup.layers] };
  });
  const newGroups = state.groups.filter(
    (sg) => !national.groups.some((g) => g.id === sg.id),
  );
  return { ...national, groups: [...merged, ...newGroups] };
}

// Per-project layer state, persisted in project.json
export interface LayerSettings {
  activeBasemap: string;
  enabledLayers: string[];
  layerOpacities: Record<string, number>;
}

export const LAYER_SETTINGS_DEFAULT: LayerSettings = {
  activeBasemap: "usgs_topo",
  enabledLayers: [],
  layerOpacities: {},
};

// Layers that can stream tiles live without any local download
export const STREAMABLE_RENDER_TYPES = new Set<string>(["raster"]);

export function isLayerAvailable(layer: LayerConfig, online: boolean): boolean {
  if (layer.requiresDownload) return false; // needs local data regardless of online mode
  if (layer.onlineOnly && !online) return false;
  return true;
}
