import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../lib/ipc";
import { modKeyLabel } from "../lib/platform";
import { logEvent } from "../lib/log";
import { invalidatePendingSaves, isStaleGenerationError } from "../lib/saveEpoch";
import { ProjectMeta } from "../types/project";
import { FormatTab } from "../tabs/FormatTab";
import { LayersTab } from "../tabs/LayersTab";
import { AreaTab } from "../tabs/AreaTab";
import { ExportTab } from "../tabs/ExportTab";
import { PreviewTab } from "../tabs/PreviewTab";
import { NotesTab } from "../tabs/NotesTab";
import { MissingCountyBanner } from "../components/MissingCountyBanner";
import type { MissingCounty } from "../components/MissingCountyBanner";
import type { StateManifestEntry } from "../types/layers";
import type { Bounds } from "../types/area";
import type { LayerManifestEntry } from "../types/data";
import type { SnapshotEntry } from "../types/snapshot";
import type { PresetEntry } from "../types/preset";
import "../components/MissingCountyBanner.css";
import "./WorkspaceScreen.css";

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

// Area comes before Layers: the print area determines what the layers are
// even rendered against (LayersTab centers its map on the saved area), so
// picking the area first, then toggling layers on it, is the order that
// actually makes sense to look at.
const TABS = [
  { id: 1, key: "format",  label: "Format",  desc: "Paper size, orientation, margins, and scale",         stage: 6  },
  { id: 2, key: "area",    label: "Area",    desc: "Position and size the print area on the map",          stage: 8  },
  { id: 3, key: "layers",  label: "Layers",  desc: "Choose which map layers appear on your map",           stage: 7  },
  { id: 4, key: "preview", label: "Preview", desc: "See exactly what will export, page by page",           stage: 14, needsArea: true },
  { id: 5, key: "export",  label: "Export",  desc: "Set DPI and filename, then generate the PDF",          stage: 15 },
  { id: 6, key: "notes",   label: "Notes",   desc: "Plain-text notes saved with this project",             stage: 16 },
] as const;

type TabKey = typeof TABS[number]["key"];

const TAB_ICONS: Record<TabKey, string> = {
  format:  "📐",
  layers:  "🗂",
  area:    "⬜",
  preview: "👁",
  export:  "📤",
  notes:   "📝",
};

// ---------------------------------------------------------------------------
// Geo helpers for coverage check
// ---------------------------------------------------------------------------

function featureBbox(feature: any): [number, number, number, number] {
  const coords: number[][] = [];
  function collect(c: any) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") { coords.push(c as number[]); return; }
    c.forEach(collect);
  }
  collect(feature.geometry?.coordinates);
  if (coords.length === 0) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenData: (stateId?: string | null) => void;
  onOpenProject: (id: string) => void;
}

// ---------------------------------------------------------------------------
// WorkspaceScreen
// ---------------------------------------------------------------------------

export function WorkspaceScreen({ projectId, onBack, onOpenData, onOpenProject }: Props) {
  const [project, setProject]         = useState<ProjectMeta | null>(null);
  const [activeTab, setActiveTab]     = useState<TabKey>("format");
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [online, setOnline]           = useState(true);
  const [renaming, setRenaming]       = useState(false);
  const [nameInput, setNameInput]     = useState("");
  const [saveStatus, setSaveStatus]   = useState<"saved" | "saving">("saved");
  const [units, setUnits]             = useState<"imperial" | "metric">("imperial");
  const [statePickerOpen, setStatePickerOpen] = useState(false);
  const [availableStates, setAvailableStates] = useState<StateManifestEntry[]>([]);
  const renameRef = useRef<HTMLInputElement>(null);
  const statePickerRef = useRef<HTMLDivElement>(null);

  // Fork modal
  const [forkOpen, setForkOpen] = useState(false);
  const [forkName, setForkName] = useState("");
  const [forking, setForking] = useState(false);

  // Snapshot panel
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [savingSnap, setSavingSnap] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaved, setPresetSaved] = useState(false);
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);

  // Bumped on snapshot restore to force the tabs to remount and re-read from disk
  const [reloadToken, setReloadToken] = useState(0);

  // Coverage check state
  const [printBounds, setPrintBounds] = useState<Bounds | null>(null);
  const [missingCounties, setMissingCounties] = useState<MissingCounty[]>([]);
  // Which set of missing counties the user dismissed the banner for, so it stays
  // dismissed while the area is nudged but returns when the counties change.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const boundsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [downloadedLayerCount, setDownloadedLayerCount] = useState(0);
  const [totalLayerCount, setTotalLayerCount] = useState(0);
  const [missingCountyGeoJSON, setMissingCountyGeoJSON] = useState<any>(null);
  const tigerCacheRef = useRef<Record<string, any>>({});

  // Load project + global units + available states on open
  useEffect(() => {
    invoke<ProjectMeta>("get_project", { id: projectId })
      .then(setProject)
      .catch(console.error);
    invoke<{ units: string }>("get_settings")
      .then((s) => setUnits(s.units === "metric" ? "metric" : "imperial"))
      .catch(() => {});
    fetch("/regions/_states.json")
      .then((r) => r.json())
      .then((m) => setAvailableStates(m.states ?? []))
      .catch(() => {});
  }, [projectId]);

  // Close state picker on outside click
  useEffect(() => {
    if (!statePickerOpen) return;
    function onDown(e: MouseEvent) {
      if (statePickerRef.current && !statePickerRef.current.contains(e.target as Node)) {
        setStatePickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [statePickerOpen]);

  async function selectState(stateId: string | null) {
    if (!project) return;
    setStatePickerOpen(false);
    setSaveStatus("saving");
    try {
      const generation = await invoke<number>("save_state_selection", {
        id: projectId,
        state: stateId,
        counties: [],
        expectedGeneration: project.settingsGeneration ?? 0,
      });
      setProject((p) =>
        p ? { ...p, state: stateId, counties: [], settingsGeneration: generation } : p
      );
    } catch (e) {
      if (isStaleGenerationError(e)) return; // superseded by a restore
      console.error("State save failed:", e);
    } finally {
      setSaveStatus("saved");
    }
  }

  // Coverage check: runs whenever printBounds or project.state changes
  useEffect(() => {
    const stateId = project?.state;
    if (!printBounds || !stateId) {
      setMissingCounties([]);
      setMissingCountyGeoJSON(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        // 1. Load state config to get TIGER URL and downloadable layer count
        const stateEntry = availableStates.find((s) => s.id === stateId);
        if (!stateEntry) return;
        const cfgRes = await fetch(`/regions/${stateEntry.file}.json`);
        if (!cfgRes.ok) return;
        const cfg = await cfgRes.json();
        const src = cfg.countyBoundarySource;
        if (!src?.url) return;

        // Count downloadable layers for this state
        let layerCount = 0;
        for (const g of cfg.groups ?? []) {
          for (const l of g.layers ?? []) {
            if (l.downloadable && l.downloadUrl) layerCount++;
          }
        }
        setTotalLayerCount(layerCount);

        // 2. Fetch TIGER county boundaries (cached per state)
        let geojson = tigerCacheRef.current[stateId];
        if (!geojson) {
          const r = await fetch(src.url);
          if (!r.ok) return;
          geojson = await r.json();
          tigerCacheRef.current[stateId] = geojson;
        }

        if (cancelled) return;

        // 3. Compute which county features intersect the print bbox
        const pb: [number, number, number, number] = [
          printBounds.west, printBounds.south, printBounds.east, printBounds.north,
        ];
        const fipsField = src.fipsField ?? "GEOID";
        const nameField = src.nameField ?? "NAME";

        const intersecting = (geojson.features ?? []).filter((f: any) =>
          bboxIntersects(pb, featureBbox(f))
        );

        // 4. Check what's downloaded
        const manifest = await invoke<LayerManifestEntry[]>("list_downloaded_layers", { stateId });
        if (cancelled) return;
        setDownloadedLayerCount(manifest.length);

        // 5. Determine missing counties
        if (manifest.length >= layerCount && layerCount > 0) {
          // All layers downloaded — no missing counties
          setMissingCounties([]);
          setMissingCountyGeoJSON(null);
        } else {
          const missing: MissingCounty[] = intersecting.map((f: any) => ({
            id: String(f.properties?.[fipsField] ?? f.id ?? ""),
            name: String(f.properties?.[nameField] ?? "Unknown"),
          }));
          setMissingCounties(missing);
          setMissingCountyGeoJSON(
            missing.length > 0
              ? { type: "FeatureCollection", features: intersecting }
              : null
          );
        }
      } catch (e) {
        console.warn("Coverage check failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [printBounds, project?.state, availableStates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load snapshots + presets when history panel opens
  useEffect(() => {
    if (!historyOpen) return;
    invoke<SnapshotEntry[]>("list_snapshots", { projectId })
      .then(setSnapshots)
      .catch(console.error);
    invoke<PresetEntry[]>("list_presets")
      .then(setPresets)
      .catch(console.error);
  }, [historyOpen, projectId]);

  async function applyPreset(presetId: string, name: string) {
    try {
      invalidatePendingSaves(); // same race as restoreSnapshot
      await invoke("apply_preset", { projectId, presetId });
      const refreshed = await invoke<ProjectMeta>("get_project", { id: projectId });
      setProject(refreshed);
      setReloadToken((n) => n + 1); // same remount reason as restoreSnapshot
      logEvent(`Applied preset "${name}"`);
      setHistoryOpen(false);
    } catch (e) {
      console.error("Apply preset failed:", e);
    }
  }

  // Close history panel on outside click
  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen]);

  async function doFork() {
    if (!project || forking) return;
    const name = forkName.trim();
    if (!name) return;
    setForking(true);
    try {
      const forked = await invoke<{ id: string }>("fork_project", { sourceId: projectId, newName: name });
      logEvent(`Forked project "${project.name}" → "${name}"`);
      setForkOpen(false);
      onOpenProject(forked.id);
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForking(false);
    }
  }

  async function saveSnapshot() {
    if (savingSnap) return;
    setSavingSnap(true);
    try {
      const entry = await invoke<SnapshotEntry>("save_snapshot", {
        projectId,
        label: snapshotLabel.trim() || null,
      });
      setSnapshots((prev) => [entry, ...prev]);
      logEvent(`Saved snapshot${entry.label ? ` "${entry.label}"` : ""}`);
      setSnapshotLabel("");
    } catch (e) {
      console.error("Snapshot save failed:", e);
    } finally {
      setSavingSnap(false);
    }
  }

  async function restoreSnapshot(snapId: string) {
    try {
      // Drop writes the tabs already have in flight — they were computed from
      // the pre-restore state and would land on top of what we're restoring.
      invalidatePendingSaves();
      await invoke("restore_snapshot", { projectId, snapshotId: snapId });
      logEvent(`Restored snapshot ${snapId}`);
      const refreshed = await invoke<ProjectMeta>("get_project", { id: projectId });
      setProject(refreshed);
      // The tabs hold their own copies of the settings and only load them on
      // mount; without a remount they would keep showing pre-restore values and
      // overwrite the restored file on their next debounced save.
      setReloadToken((n) => n + 1);
      setHistoryOpen(false);
    } catch (e) {
      console.error("Restore failed:", e);
    }
  }

  async function deleteSnapshot(snapId: string) {
    try {
      await invoke("delete_snapshot", { projectId, snapshotId: snapId });
      setSnapshots((prev) => prev.filter((s) => s.id !== snapId));
    } catch (e) {
      console.error("Delete snapshot failed:", e);
    }
  }

  async function exportHuntmap() {
    try {
      const path = await invoke<string | null>("export_huntmap", { projectId });
      if (path) logEvent(`Exported .huntmap → ${path}`);
    } catch (e) {
      console.error("Export failed:", e);
    }
  }

  // The backend reads the current settings straight from project.json, so a
  // stale copy in this screen's `project` state can't be captured by mistake.
  async function savePreset(name: string) {
    try {
      await invoke("save_preset", { name, projectId });
    } catch (e) {
      console.error("Save preset failed:", e);
    }
  }

  // Coalesce the stream of bounds updates the Area tab emits while dragging —
  // each one otherwise triggers a full county-intersection scan and an IPC call.
  const handleBoundsChange = useCallback((b: Bounds | null) => {
    if (boundsTimer.current) clearTimeout(boundsTimer.current);
    boundsTimer.current = setTimeout(() => setPrintBounds(b), 400);
  }, []);

  useEffect(() => () => {
    if (boundsTimer.current) clearTimeout(boundsTimer.current);
  }, []);

  // Cmd/Ctrl + 1-6 to switch tabs
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 6) {
        e.preventDefault();
        setActiveTab(TABS[n - 1].key);
        setDrawerOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const switchTab = useCallback((key: TabKey) => {
    setActiveTab(key);
    setDrawerOpen(false);
  }, []);

  // --- rename helpers ---
  function startRename() {
    if (!project) return;
    setNameInput(project.name);
    setRenaming(true);
    // focus fires after render via ref
  }

  async function commitRename() {
    setRenaming(false);
    if (!project) return;
    const name = nameInput.trim();
    if (!name || name === project.name) return;
    setSaveStatus("saving");
    try {
      await invoke("rename_project", { id: projectId, name });
      setProject((p) => p ? { ...p, name } : p);
    } catch (e) {
      console.error("Rename failed:", e);
    } finally {
      setSaveStatus("saved");
    }
  }

  // Area tab is now implemented — preview can render once an area is set.
  // Default area is always initialized, so treat as "has area".
  const hasArea = true;

  if (!project) {
    return (
      <div className="workspace-loading" role="status">
        Loading project…
      </div>
    );
  }

  const activeTabDef = TABS.find((t) => t.key === activeTab)!;

  // Identifies the current gap so a dismissal sticks until the gap itself changes.
  const missingKey = missingCounties.map((c) => c.id).sort().join(",");

  return (
    <div className="workspace">

      {/* ── Workspace header ── */}
      <div className="workspace-header">
        <button className="ws-back-btn" onClick={onBack} aria-label="Back to projects">
          ‹ Projects
        </button>

        <div className="ws-project-info">
          {renaming ? (
            <input
              ref={renameRef}
              className="ws-rename-input"
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              aria-label="Project name"
            />
          ) : (
            <button
              className="ws-project-name"
              onClick={startRename}
              title="Click to rename"
            >
              {project.name}
            </button>
          )}
          <div className="ws-location-wrap" ref={statePickerRef}>
            <button
              className="ws-location-btn"
              onClick={() => setStatePickerOpen((v) => !v)}
              title="Change state"
              aria-haspopup="listbox"
              aria-expanded={statePickerOpen}
            >
              {project.state
                ? `${availableStates.find((s) => s.id === project.state)?.name ?? project.state}${project.counties.length ? ` · ${project.counties.length} ${project.counties.length === 1 ? "county" : "counties"}` : ""}`
                : "No state selected"}
              <span className="ws-location-caret" aria-hidden="true">▾</span>
            </button>
            {statePickerOpen && (
              <div className="ws-state-picker" role="listbox" aria-label="Select state">
                {availableStates.map((s) => (
                  <button
                    key={s.id}
                    className={`ws-state-option ${project.state === s.id ? "ws-state-option--active" : ""}`}
                    role="option"
                    aria-selected={project.state === s.id}
                    onClick={() => selectState(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
                {project.state && (
                  <button
                    className="ws-state-option ws-state-option--clear"
                    role="option"
                    aria-selected={false}
                    onClick={() => selectState(null)}
                  >
                    Clear state
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="ws-header-actions">
          <span className={`ws-save ${saveStatus === "saving" ? "ws-save--busy" : ""}`}>
            {saveStatus === "saving" ? "Saving…" : "Saved"}
          </span>
          <button
            className={`ws-online-toggle ${online ? "ws-online-toggle--on" : "ws-online-toggle--off"}`}
            onClick={() => setOnline((v) => !v)}
            title={online ? "Switch to Offline mode" : "Switch to Online mode"}
            aria-pressed={online}
          >
            <span className="ws-online-dot" />
            {online ? "Online" : "Offline"}
          </button>
          <button
            className="ws-fork-btn"
            title="Fork this project (create an independent copy)"
            onClick={() => { setForkName(project.name + " (copy)"); setForkOpen(true); }}
          >
            Fork
          </button>

          {/* History / snapshot panel */}
          <div className="ws-history-wrap" ref={historyRef}>
            <button
              className={`ws-history-btn ${historyOpen ? "ws-history-btn--active" : ""}`}
              title="Project snapshots — save and restore settings checkpoints"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              History
            </button>
            {historyOpen && (
              <div className="ws-history-panel" role="dialog" aria-label="Snapshot history">
                <div className="ws-history-save">
                  <input
                    className="ws-history-label-input"
                    type="text"
                    placeholder="Label (optional)"
                    value={snapshotLabel}
                    onChange={(e) => setSnapshotLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveSnapshot(); }}
                    aria-label="Snapshot label"
                  />
                  <button
                    className="ws-history-save-btn"
                    onClick={saveSnapshot}
                    disabled={savingSnap}
                  >
                    {savingSnap ? "Saving…" : "Save Snapshot"}
                  </button>
                </div>
                {snapshots.length === 0 ? (
                  <div className="ws-history-empty">No snapshots yet</div>
                ) : (
                  <ul className="ws-history-list">
                    {snapshots.map((s) => (
                      <li key={s.id} className="ws-history-item">
                        <div className="ws-history-item-info">
                          <span className="ws-history-item-label">
                            {s.label || s.projectName}
                          </span>
                          <span className="ws-history-item-date">
                            {new Date(s.savedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="ws-history-item-actions">
                          <button
                            className="ws-history-restore"
                            onClick={() => restoreSnapshot(s.id)}
                            title="Restore this snapshot"
                          >
                            Restore
                          </button>
                          <button
                            className="ws-history-delete"
                            onClick={() => deleteSnapshot(s.id)}
                            title="Delete snapshot"
                            aria-label="Delete snapshot"
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Saved presets — apply format + layers to this project */}
                {presets.length > 0 && (
                  <ul className="ws-history-list ws-history-list--presets">
                    {presets.map((p) => (
                      <li key={p.id} className="ws-history-item">
                        <div className="ws-history-item-info">
                          <span className="ws-history-item-label">{p.name}</span>
                          <span className="ws-history-item-date">Preset</span>
                        </div>
                        <button
                          className="ws-history-restore"
                          onClick={() => applyPreset(p.id, p.name)}
                          title="Apply this preset's format and layer settings"
                        >
                          Apply
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Preset save */}
                <div className="ws-history-preset-row">
                  <input
                    className="ws-history-label-input"
                    type="text"
                    placeholder="Preset name"
                    value={presetName}
                    onChange={(e) => { setPresetName(e.target.value); setPresetSaved(false); }}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && presetName.trim()) {
                        await savePreset(presetName.trim());
                        setPresetName("");
                        setPresetSaved(true);
                        setTimeout(() => setPresetSaved(false), 2000);
                      }
                    }}
                    aria-label="Preset name"
                  />
                  <button
                    className="ws-history-save-btn ws-history-save-btn--secondary"
                    disabled={!presetName.trim()}
                    onClick={async () => {
                      await savePreset(presetName.trim());
                      setPresetName("");
                      setPresetSaved(true);
                      setTimeout(() => setPresetSaved(false), 2000);
                    }}
                  >
                    {presetSaved ? "Saved!" : "Save Preset"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            className="ws-export-huntmap-btn"
            title="Export project as .huntmap file for sharing or backup"
            onClick={exportHuntmap}
          >
            Export…
          </button>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="workspace-tabbar" role="tablist" aria-label="Project tabs">
        {TABS.map((tab) => {
          const dot = tab.key === "preview" && !hasArea;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={active}
              aria-controls={`tabpanel-${tab.key}`}
              className={`ws-tab ${active ? "ws-tab--active" : ""}`}
              onClick={() => switchTab(tab.key)}
              title={`${tab.label} — ${modKeyLabel()}${tab.id}`}
            >
              {tab.label}
              {dot && (
                <span
                  className="ws-tab-dot"
                  aria-label="Needs area before this tab is usable"
                  title="Set an area in the Area tab first"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Missing-county banner (non-blocking) ── */}
      {missingCounties.length > 0 && dismissedKey !== missingKey && (
        <MissingCountyBanner
          missingCounties={missingCounties}
          downloadedLayerCount={downloadedLayerCount}
          totalLayerCount={totalLayerCount}
          onDownloadNow={() => onOpenData(project.state)}
          onWorkOnline={() => setDismissedKey(missingKey)}
          onDismiss={() => setDismissedKey(missingKey)}
        />
      )}

      {/* ── Body: tab content + optional settings drawer ── */}
      <div className="workspace-body">
        <div className="workspace-content">
          {/* Gear button — opens this tab's settings drawer */}
          <button
            className={`ws-gear-btn ${drawerOpen ? "ws-gear-btn--active" : ""}`}
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={`${activeTabDef.label} tab settings`}
            aria-expanded={drawerOpen}
            title={`${activeTabDef.label} settings`}
          >
            ⚙
          </button>

          {/* All panels mounted simultaneously; CSS shows only the active one */}
          {TABS.map((tab) => (
            <div
              key={`${tab.key}-${reloadToken}`}
              id={`tabpanel-${tab.key}`}
              role="tabpanel"
              aria-labelledby={`tab-${tab.key}`}
              className={`ws-panel ${activeTab === tab.key ? "ws-panel--active" : ""}`}
            >
              {tab.key === "format"
                ? <FormatTab projectId={projectId} units={units} />
                : tab.key === "layers"
                ? <LayersTab
                    projectId={projectId}
                    isActive={activeTab === "layers"}
                    online={online}
                    projectState={project.state}
                    missingCountyGeoJSON={missingCountyGeoJSON}
                  />
                : tab.key === "area"
                ? <AreaTab
                    projectId={projectId}
                    isActive={activeTab === "area"}
                    onBoundsChange={handleBoundsChange}
                    onFormatChangedExternally={() => setReloadToken((n) => n + 1)}
                  />
                : tab.key === "preview"
                ? <PreviewTab
                    projectId={projectId}
                    isActive={activeTab === "preview"}
                  />
                : tab.key === "export"
                ? <ExportTab
                    projectId={projectId}
                    isActive={activeTab === "export"}
                  />
                : tab.key === "notes"
                ? <NotesTab
                    projectId={projectId}
                    isActive={activeTab === "notes"}
                  />
                : <TabPlaceholder tab={tab} />}
            </div>
          ))}
        </div>

        {/* Settings drawer — slides in from right */}
        <div
          className={`ws-drawer ${drawerOpen ? "ws-drawer--open" : ""}`}
          aria-label={`${activeTabDef.label} settings`}
          aria-hidden={!drawerOpen}
        >
          <div className="ws-drawer-header">
            <span className="ws-drawer-title">{activeTabDef.label} Settings</span>
            <button
              className="ws-drawer-close"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close settings drawer"
            >
              ×
            </button>
          </div>
          <div className="ws-drawer-body">
            <DrawerPlaceholder tabLabel={activeTabDef.label} stage={activeTabDef.stage} />
          </div>
        </div>
      </div>
      {/* ── Fork modal ── */}
      {forkOpen && (
        <div className="modal-scrim" onClick={() => setForkOpen(false)} role="dialog" aria-modal="true">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Fork project</h2>
            <p className="modal__body">
              Creates an independent copy that tracks its origin.
            </p>
            <input
              className="modal__input"
              type="text"
              autoFocus
              value={forkName}
              placeholder="Project name"
              onChange={(e) => setForkName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doFork();
                if (e.key === "Escape") setForkOpen(false);
              }}
            />
            <div className="modal__actions">
              <button className="btn-secondary" onClick={() => setForkOpen(false)} disabled={forking}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={doFork}
                disabled={forking || !forkName.trim()}
              >
                {forking ? "Forking…" : "Fork"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab placeholder content
// ---------------------------------------------------------------------------

function TabPlaceholder({ tab }: { tab: typeof TABS[number] }) {
  return (
    <div className="tab-placeholder">
      <div className="tab-placeholder-icon" aria-hidden="true">
        {TAB_ICONS[tab.key]}
      </div>
      <h2 className="tab-placeholder-name">
        Tab {tab.id} — {tab.label}
      </h2>
      <p className="tab-placeholder-desc">{tab.desc}</p>
      <p className="tab-placeholder-stage">
        Content arrives in Stage {tab.stage}
      </p>
    </div>
  );
}

function DrawerPlaceholder({ tabLabel, stage }: { tabLabel: string; stage: number }) {
  return (
    <div className="drawer-placeholder">
      <p>
        Per-project settings for <strong>{tabLabel}</strong> will appear here.
      </p>
      <p className="drawer-placeholder-stage">Wired up in Stage {stage}.</p>
    </div>
  );
}
