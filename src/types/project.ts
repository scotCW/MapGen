import type { FormatSettings } from "./format";
import type { LayerSettings } from "./layers";
import type { AreaSettings } from "./area";
import type { MapElements } from "./elements";

export interface ForkedFrom {
  id: string;
  name: string;
}

export interface NotesSettings {
  printOnOverview: boolean;
  printedFontSize: number;
}

export interface ProjectMeta {
  version: number;
  id: string;
  name: string;
  state: string | null;
  counties: string[];
  areaSizeKm2: number | null;
  sheetCount: number;
  lastModified: string;
  createdAt: string;
  forkedFrom: ForkedFrom | null;
  notes: string;
  notesSettings: NotesSettings;
  format: FormatSettings;
  layers: LayerSettings;
  area: AreaSettings;
  /// Which map elements print on each sheet (older projects omit it — run it
  /// through normalizeElements before use).
  elements?: Partial<MapElements>;
  /// Bumped by the backend whenever the document is rewritten wholesale
  /// (snapshot restore, preset apply). Tabs send the value they loaded with
  /// every save; the backend refuses writes carrying a stale one.
  settingsGeneration: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  state: string | null;
  counties: string[];
  areaSizeKm2: number | null;
  sheetCount: number;
  lastModified: string;
  createdAt: string;
  forkedFromId: string | null;
  forkedFromName: string | null;
  hasThumbnail: boolean;
}

export type SortField = "lastModified" | "createdAt" | "name";
export type SortDir = "asc" | "desc";
