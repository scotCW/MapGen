// ---------------------------------------------------------------------------
// TEMPORARY dev-only IPC mock — for visual QA of a bug-fix pass, not a
// permanent feature. Safe to delete; nothing else depends on it.
//
// Only ever imported from main.tsx behind `if (import.meta.env.DEV)`, so
// Vite dead-code-eliminates this entire module from `tauri build` / `vite
// build` output. It has zero effect on the shipped Tauri or Swift apps.
//
// Lets the Projects/Workspace screens render in a plain browser (no real
// Tauri or Swift host) by answering the handful of `invoke()` calls they
// need with realistic in-memory fixture data.
// ---------------------------------------------------------------------------

import type { ProjectMeta, ProjectSummary } from "../types/project";
import { FORMAT_DEFAULTS } from "../types/format";
import { LAYER_SETTINGS_DEFAULT } from "../types/layers";

const project: ProjectMeta = {
  version: 1,
  id: "mock-project-1",
  name: "Mock Elk Unit 12",
  state: "CO",
  counties: ["Larimer"],
  areaSizeKm2: 42,
  sheetCount: 1,
  lastModified: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  forkedFrom: null,
  notes: "",
  notesSettings: { printOnOverview: false, printedFontSize: 8 },
  // Deliberately NOT the default (24000) — this project claims to be at
  // 1:50,000 from the start, so any UI that shows "24,000" regardless is
  // caught immediately rather than needing a live scale change to notice.
  format: { ...FORMAT_DEFAULTS, scale: 50000 },
  layers: { ...LAYER_SETTINGS_DEFAULT, enabledLayers: ["usfs_mvum", "land_access"] },
  area: { centerLng: -105.5, centerLat: 40.5 },
  settingsGeneration: 0,
};

function summary(p: ProjectMeta): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    state: p.state,
    counties: p.counties,
    areaSizeKm2: p.areaSizeKm2,
    sheetCount: p.sheetCount,
    lastModified: p.lastModified,
    createdAt: p.createdAt,
    forkedFromId: p.forkedFrom?.id ?? null,
    forkedFromName: p.forkedFrom?.name ?? null,
    hasThumbnail: false,
  };
}

async function handle(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  console.debug(`[devMockIpc] ${cmd}`, args);
  switch (cmd) {
    case "list_projects":
      return [summary(project)];
    case "get_project":
      return project;
    case "get_settings":
      return {
        theme: "system",
        units: "imperial",
        hide_access_disclaimer: false,
        default_dpi: 200,
      };
    case "set_setting":
    case "save_format_settings":
    case "save_layer_settings":
    case "save_area_settings":
    case "save_state_selection":
    case "save_notes":
      if (args.format) Object.assign(project.format, args.format);
      if (args.layers) Object.assign(project.layers, args.layers);
      if (args.area) Object.assign(project.area, args.area);
      return project.settingsGeneration;
    case "list_downloaded_layers":
      return [];
    case "list_snapshots":
      return [];
    case "list_presets":
      return [];
    case "get_export_history":
      return [];
    case "get_data_disk_usage":
      return { totalBytes: 0, dataDir: "/mock/data" };
    case "get_download_progress":
      return { active: false, currentLayerId: "", currentLayerName: "", overallCompleted: 0, overallTotal: 0 };
    default:
      console.warn(`[devMockIpc] unhandled command "${cmd}", returning null`);
      return null;
  }
}

(window as any).__DEV_MOCK_IPC__ = handle;
console.info("[devMockIpc] active — this build path never ships (import.meta.env.DEV only)");
