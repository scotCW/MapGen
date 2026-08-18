// Types for the Data screen (Stage 19) — download management.

export interface LayerManifestEntry {
  layerId: string;
  layerName: string;
  downloadedAt: string; // ISO-8601
  sizeBytes: number;
  sourceUrl: string;
  isStale: boolean; // > 90 days since download
}

export interface DownloadProgressState {
  active: boolean;
  currentLayerId: string;
  currentLayerName: string;
  overallCompleted: number;
  overallTotal: number;
  error?: string | null;
}

export interface DataDiskUsage {
  totalBytes: number;
  dataDir: string;
}

export interface DownloadItem {
  layerId: string;
  layerName: string;
  downloadUrl: string;
}

// Derived from state config — layers the user can download.
export interface DownloadableLayerInfo {
  id: string;
  name: string;
  groupLabel: string;
  downloadUrl: string;
  estimatedSizeMb: number;
}

// County record built from TIGER GeoJSON + manifest.
export interface CountyRecord {
  id: string;    // GEOID / FIPS (e.g. "08069")
  name: string;  // Display name (e.g. "Larimer")
}

export type CountyDownloadStatus = "current" | "stale" | "partial" | "none";
