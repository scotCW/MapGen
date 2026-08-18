// ---------------------------------------------------------------------------
// Area settings — mirrors src-tauri/src/projects.rs AreaSettings
// ---------------------------------------------------------------------------

export interface Bounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface AreaSettings {
  centerLng: number;
  centerLat: number;
}

export const DEFAULT_AREA: AreaSettings = {
  centerLng: -105.7,   // central Colorado — primary target state in spec
  centerLat: 39.0,
};
