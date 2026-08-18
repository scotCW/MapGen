import type { FormatSettings } from "./format";
import type { LayerSettings } from "./layers";

export interface PresetEntry {
  id: string;
  name: string;
  createdAt: string;
  format: FormatSettings;
  layers: LayerSettings;
}
