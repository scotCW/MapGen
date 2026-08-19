import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import { invoke } from "../lib/ipc";
import type {
  LayerManifestEntry,
  DownloadProgressState,
  DataDiskUsage,
  DownloadItem,
  DownloadableLayerInfo,
  CountyRecord,
} from "../types/data";
import type { StateManifestEntry } from "../types/layers";
import type { NationalLayerConfig, StateLayerConfig, LayerConfig } from "../types/layers";
import "./DataScreen.css";

// ─── View toggle ─────────────────────────────────────────────────────────────

type ViewMode = "map" | "list" | "both";

// ─── County download status ──────────────────────────────────────────────────

type CountyStatus = "current" | "stale" | "none";

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  initialStateId?: string | null;
}

export function DataScreen({ onBack, initialStateId }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoverIdRef = useRef<string | null>(null);

  const [availableStates, setAvailableStates] = useState<StateManifestEntry[]>([]);
  const [selectedStateId, setSelectedStateId] = useState<string>(initialStateId ?? "");

  // Counties loaded from TIGER
  const [counties, setCounties] = useState<CountyRecord[]>([]);
  const [countiesLoading, setCountiesLoading] = useState(false);
  const [countiesError, setCountiesError] = useState<string | null>(null);

  // User-selected counties (for download scope)
  const [selectedCountyIds, setSelectedCountyIds] = useState<Set<string>>(new Set());

  // Downloaded layer manifest
  const [downloadedLayers, setDownloadedLayers] = useState<LayerManifestEntry[]>([]);

  // Downloadable layers from state config
  const [downloadableLayers, setDownloadableLayers] = useState<DownloadableLayerInfo[]>([]);
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());

  // Download progress
  const [progress, setProgress] = useState<DownloadProgressState | null>(null);
  // Cancellation takes effect between layers, so the file already in flight has
  // to finish first. Tracked separately to say so, instead of leaving a button
  // that looks like it did nothing for as long as that download takes.
  const [cancelRequested, setCancelRequested] = useState(false);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // View mode + filter
  const [viewMode, setViewMode] = useState<ViewMode>("both");
  const [countyFilter, setCountyFilter] = useState("");

  // Manage Downloads panel
  const [showManage, setShowManage] = useState(false);
  const [diskUsage, setDiskUsage] = useState<DataDiskUsage | null>(null);

  // State county boundary source config
  const countySourceRef = useRef<{ url: string; nameField: string; fipsField?: string } | null>(null);

  // ── Load available states ──────────────────────────────────────────────────

  useEffect(() => {
    fetch("/regions/_states.json")
      .then((r) => r.json())
      .then((m) => {
        const states: StateManifestEntry[] = m.states ?? [];
        setAvailableStates(states);
        if (!selectedStateId && states.length > 0) {
          setSelectedStateId(states[0].id);
        }
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load state config, then counties, when state changes ──────────────────

  // These two steps used to be separate effects: one loaded the state config
  // and stashed the county-boundary URL in countySourceRef, the other read
  // that ref and fetched counties. Both effects fire synchronously on every
  // selectedStateId change, but the ref is only populated *asynchronously* —
  // by the time the county-fetch effect's guard checked it, it still held
  // whatever the *previous* state left there. Net effect: on the very first
  // state ever selected the ref was null and the fetch silently never ran;
  // on every subsequent switch it fetched the previous state's counties under
  // the newly-selected state's label — indistinguishable from "the list is
  // wrong/incomplete" without knowing to check for it. Chaining the county
  // fetch directly off the resolved config removes the race entirely; the
  // `cancelled` guard below is the separate, standard fix for a slow response
  // from an old selection landing after a newer selection already resolved.
  useEffect(() => {
    if (!selectedStateId) return;
    let cancelled = false;

    setCounties([]);
    setCountiesError(null);
    setDownloadableLayers([]);
    setSelectedLayerIds(new Set());
    setSelectedCountyIds(new Set());

    const entry = availableStates.find((s) => s.id === selectedStateId);
    if (!entry) return;

    fetch(`/regions/${entry.file}.json`)
      .then((r) => r.json())
      .then(async (cfg: StateLayerConfig) => {
        if (cancelled) return;

        // Collect downloadable layers (state-specific, then national ones not
        // already covered).
        const layers: DownloadableLayerInfo[] = [];
        for (const g of cfg.groups) {
          for (const l of g.layers) {
            if (l.downloadable && l.downloadUrl) {
              layers.push({
                id: l.id,
                name: l.name,
                groupLabel: g.label,
                downloadUrl: l.downloadUrl,
                estimatedSizeMb: estimateSizeMb(l),
              });
            }
          }
        }
        try {
          const nat: NationalLayerConfig = await fetch("/regions/_national.json").then((r) => r.json());
          for (const g of nat.groups) {
            for (const l of g.layers) {
              if (l.downloadable && l.downloadUrl && !layers.some((dl) => dl.id === l.id)) {
                layers.push({
                  id: l.id,
                  name: l.name,
                  groupLabel: g.label,
                  downloadUrl: l.downloadUrl,
                  estimatedSizeMb: estimateSizeMb(l),
                });
              }
            }
          }
        } catch {
          // National config is a nice-to-have here; state-specific layers alone are still useful.
        }
        if (cancelled) return;
        setDownloadableLayers(layers);
        setSelectedLayerIds(new Set(layers.map((l) => l.id)));

        // Now that the county-boundary URL is actually known (not a ref that
        // might still hold a previous state's value), fetch counties.
        const src = cfg.countyBoundarySource;
        if (!src) return;
        countySourceRef.current = src;
        setCountiesLoading(true);
        try {
          const r = await fetch(src.url);
          if (!r.ok) throw new Error(`TIGER API returned ${r.status}`);
          const geojson = await r.json();
          if (cancelled) return;
          const nameField = src.nameField;
          const fipsField = src.fipsField ?? "GEOID";
          const records: CountyRecord[] = (geojson.features ?? []).map((f: any) => ({
            id: f.properties?.[fipsField] ?? f.properties?.GEOID ?? String(f.id ?? ""),
            name: f.properties?.[nameField] ?? "Unknown",
          }));
          records.sort((a, b) => a.name.localeCompare(b.name));
          setCounties(records);
          addCountyLayer(geojson, fipsField);
        } catch (e) {
          if (!cancelled) setCountiesError(`Could not load county boundaries: ${e}`);
        } finally {
          if (!cancelled) setCountiesLoading(false);
        }
      })
      .catch((e) => { if (!cancelled) setCountiesError(String(e)); });

    return () => { cancelled = true; };
  }, [selectedStateId, availableStates]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load downloaded layer manifest ────────────────────────────────────────

  const refreshManifest = useCallback(async () => {
    if (!selectedStateId) return;
    try {
      const entries = await invoke<LayerManifestEntry[]>("list_downloaded_layers", {
        stateId: selectedStateId,
      });
      setDownloadedLayers(entries);
      // Update map feature states
      updateMapStatuses(entries);
    } catch (e) {
      console.error("manifest refresh:", e);
    }
  }, [selectedStateId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshManifest();
  }, [refreshManifest]);

  // ── Load disk usage when manage panel opens ───────────────────────────────

  useEffect(() => {
    if (!showManage) return;
    invoke<DataDiskUsage>("get_data_disk_usage")
      .then(setDiskUsage)
      .catch(console.error);
  }, [showManage]);

  // ── Progress polling ──────────────────────────────────────────────────────

  function startProgressPolling() {
    if (progressTimer.current) return;
    progressTimer.current = setInterval(async () => {
      try {
        const p = await invoke<DownloadProgressState>("get_download_progress");
        setProgress(p);
        if (!p.active) {
          stopProgressPolling();
          refreshManifest();
        }
      } catch { stopProgressPolling(); }
    }, 800);
  }

  function stopProgressPolling() {
    if (progressTimer.current) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  }

  useEffect(() => () => stopProgressPolling(), []);

  // ── MapLibre init ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: { version: 8, sources: {}, layers: [] },
      center: [-98.5, 39.5],
      zoom: 3.5,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    map.on("load", () => {
      // Will be populated by addCountyLayer
    });

    // Click handler for county selection
    map.on("click", "county-fill", (e) => {
      const fipsField = countySourceRef.current?.fipsField ?? "GEOID";
      const feature = e.features?.[0];
      if (!feature) return;
      const id = String(feature.properties?.[fipsField] ?? feature.id ?? "");
      if (!id) return;
      setSelectedCountyIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          map.setFeatureState({ source: "counties", id }, { selected: false });
        } else {
          next.add(id);
          map.setFeatureState({ source: "counties", id }, { selected: true });
        }
        return next;
      });
    });

    // Hover
    map.on("mousemove", "county-fill", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const fipsField = countySourceRef.current?.fipsField ?? "GEOID";
      const id = String(e.features?.[0]?.properties?.[fipsField] ?? e.features?.[0]?.id ?? "");
      if (id && id !== hoverIdRef.current) {
        if (hoverIdRef.current) {
          map.setFeatureState({ source: "counties", id: hoverIdRef.current }, { hover: false });
        }
        map.setFeatureState({ source: "counties", id }, { hover: true });
        hoverIdRef.current = id;
      }
    });
    map.on("mouseleave", "county-fill", () => {
      map.getCanvas().style.cursor = "";
      if (hoverIdRef.current) {
        map.setFeatureState({ source: "counties", id: hoverIdRef.current }, { hover: false });
        hoverIdRef.current = null;
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Add county GeoJSON source + layers
  function addCountyLayer(geojson: any, fipsField: string) {
    const map = mapRef.current;
    if (!map) return;
    const add = () => {
      if (map.getSource("counties")) {
        (map.getSource("counties") as maplibregl.GeoJSONSource).setData(geojson);
        return;
      }
      map.addSource("counties", {
        type: "geojson",
        data: geojson,
        promoteId: fipsField,
      });
      // Fill layer — color driven by feature state
      map.addLayer({
        id: "county-fill",
        type: "fill",
        source: "counties",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
              ["case",
                ["==", ["feature-state", "download_status"], "current"], "#1b5e20",
                ["==", ["feature-state", "download_status"], "stale"],  "#e65100",
                "#1565c0"
              ],
            ["case",
              ["==", ["feature-state", "download_status"], "current"], "#388e3c",
              ["==", ["feature-state", "download_status"], "stale"],  "#ef6c00",
              "#9e9e9e"
            ]
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false], 0.55,
            ["boolean", ["feature-state", "selected"], false], 0.45,
            ["case",
              ["in", ["feature-state", "download_status"], ["literal", ["current", "stale"]]], 0.35,
              0.12
            ]
          ],
        },
      });
      // Border layer
      map.addLayer({
        id: "county-line",
        type: "line",
        source: "counties",
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false], "#1565c0",
            "var(--color-border, #aaa)"
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false], 2,
            0.5
          ],
        },
      });
      // Label layer
      map.addLayer({
        id: "county-label",
        type: "symbol",
        source: "counties",
        layout: {
          "text-field": ["get", countySourceRef.current?.nameField ?? "NAME"],
          "text-size": 10,
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#333",
          "text-halo-color": "#fff",
          "text-halo-width": 1,
        },
        minzoom: 5,
      });
    };

    if (map.loaded()) {
      add();
    } else {
      map.once("load", add);
    }
  }

  function updateMapStatuses(entries: LayerManifestEntry[]) {
    const map = mapRef.current;
    if (!map || !map.getSource("counties")) return;
    const downloadedIds = new Set(entries.map((e) => e.layerId));
    const staleIds = new Set(entries.filter((e) => e.isStale).map((e) => e.layerId));
    // For a per-county status, check if any downloaded layer covers this county
    // Since downloads are statewide, all counties in a state share the same status
    const anyDownloaded = downloadedIds.size > 0;
    const anyStale = staleIds.size === downloadedIds.size && downloadedIds.size > 0;
    const status: string = anyDownloaded ? (anyStale ? "stale" : "current") : "none";

    counties.forEach((c) => {
      map.setFeatureState(
        { source: "counties", id: c.id },
        { download_status: status }
      );
    });
  }

  // Re-sync map feature states when counties or downloadedLayers change
  useEffect(() => {
    updateMapStatuses(downloadedLayers);
  }, [counties, downloadedLayers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selected counties to map feature state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("counties")) return;
    counties.forEach((c) => {
      map.setFeatureState(
        { source: "counties", id: c.id },
        { selected: selectedCountyIds.has(c.id) }
      );
    });
  }, [selectedCountyIds, counties]);

  // Fly to state when counties load
  useEffect(() => {
    if (counties.length === 0) return;
    const map = mapRef.current;
    if (!map) return;
    // Rough bounding box based on state
    const stateBounds: Record<string, [number, number, number, number]> = {
      CO: [-109.1, 36.9, -101.9, 41.1],
      WY: [-111.1, 40.9, -104.0, 45.1],
    };
    const bounds = stateBounds[selectedStateId];
    if (bounds) {
      map.fitBounds(bounds as maplibregl.LngLatBoundsLike, { padding: 20, duration: 600 });
    }
  }, [counties, selectedStateId]);

  // ── Bulk selection helpers ────────────────────────────────────────────────

  function selectAll() {
    const all = new Set(counties.map((c) => c.id));
    setSelectedCountyIds(all);
    counties.forEach((c) => {
      mapRef.current?.setFeatureState({ source: "counties", id: c.id }, { selected: true });
    });
  }
  function clearSelection() {
    setSelectedCountyIds(new Set());
    counties.forEach((c) => {
      mapRef.current?.setFeatureState({ source: "counties", id: c.id }, { selected: false });
    });
  }
  function selectDownloaded() {
    const downloadedStatus = new Set(
      downloadedLayers.length > 0 ? counties.map((c) => c.id) : []
    );
    setSelectedCountyIds(downloadedStatus);
    counties.forEach((c) => {
      mapRef.current?.setFeatureState(
        { source: "counties", id: c.id },
        { selected: downloadedStatus.has(c.id) }
      );
    });
  }
  function invertSelection() {
    const inverted = new Set(counties.map((c) => c.id).filter((id) => !selectedCountyIds.has(id)));
    setSelectedCountyIds(inverted);
    counties.forEach((c) => {
      mapRef.current?.setFeatureState(
        { source: "counties", id: c.id },
        { selected: inverted.has(c.id) }
      );
    });
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async function handleDownload() {
    if (!selectedStateId) return;
    const layers = downloadableLayers.filter((l) => selectedLayerIds.has(l.id));
    if (layers.length === 0) return;

    const items: DownloadItem[] = layers.map((l) => ({
      layerId: l.id,
      layerName: l.name,
      downloadUrl: l.downloadUrl,
    }));

    try {
      await invoke("start_download", { stateId: selectedStateId, items });
      setCancelRequested(false);
      setProgress({ active: true, currentLayerId: "", currentLayerName: "", overallCompleted: 0, overallTotal: items.length });
      startProgressPolling();
    } catch (e) {
      alert(`Download failed to start: ${e}`);
    }
  }

  async function handleCancel() {
    setCancelRequested(true);
    try {
      await invoke("cancel_download");
    } catch { /* ok */ }
  }

  async function handleDeleteLayer(layerId: string) {
    if (!selectedStateId) return;
    if (!confirm("Delete this downloaded data? It will need to be re-downloaded to use offline.")) return;
    try {
      await invoke("delete_layer_data", { stateId: selectedStateId, layerId });
      await refreshManifest();
      invoke<DataDiskUsage>("get_data_disk_usage").then(setDiskUsage).catch(() => {});
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const filteredCounties = counties.filter((c) =>
    !countyFilter || c.name.toLowerCase().includes(countyFilter.toLowerCase())
  );

  const countyStatus = (_id: string): CountyStatus => {
    if (downloadedLayers.length === 0) return "none";
    const anyStale = downloadedLayers.some((e) => e.isStale);
    return anyStale ? "stale" : "current";
  };

  const totalEstimatedMb = downloadableLayers
    .filter((l) => selectedLayerIds.has(l.id))
    .reduce((sum, l) => sum + l.estimatedSizeMb, 0);

  const isDownloading = progress?.active === true;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="data-screen">
      {/* Header */}
      <div className="data-header">
        <button className="data-back-btn" onClick={onBack}>
          ‹ Projects
        </button>
        <h1 className="data-title">Download County Data</h1>

        <div className="data-state-wrap">
          <label className="data-state-label" htmlFor="state-select">State</label>
          <select
            id="state-select"
            className="data-state-select"
            value={selectedStateId}
            onChange={(e) => setSelectedStateId(e.target.value)}
            disabled={isDownloading}
          >
            <option value="">Select a state…</option>
            {availableStates.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div className="data-view-toggle" role="group" aria-label="View mode">
          {(["map", "both", "list"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={`data-view-btn ${viewMode === m ? "data-view-btn--active" : ""}`}
              onClick={() => setViewMode(m)}
            >
              {m === "map" ? "Map" : m === "both" ? "Both" : "List"}
            </button>
          ))}
        </div>

        <button
          className={`data-manage-btn ${showManage ? "data-manage-btn--active" : ""}`}
          onClick={() => setShowManage((v) => !v)}
        >
          Manage Downloads
        </button>
      </div>

      {/* Main pane: map + list */}
      {!showManage && (
        <>
          <div className={`data-county-pane data-county-pane--${viewMode}`}>
            {/* Map */}
            {(viewMode === "map" || viewMode === "both") && (
              <div className="data-map-wrap">
                <div ref={mapContainerRef} className="data-map" />

                {countiesLoading && (
                  <div className="data-map-overlay">Loading county boundaries…</div>
                )}
                {countiesError && (
                  <div className="data-map-overlay data-map-overlay--error">{countiesError}</div>
                )}

                {/* Legend */}
                <div className="data-legend">
                  <div className="data-legend-row">
                    <span className="data-legend-dot" style={{ background: "#388e3c" }} />
                    Current
                  </div>
                  <div className="data-legend-row">
                    <span className="data-legend-dot" style={{ background: "#ef6c00" }} />
                    May be outdated
                  </div>
                  <div className="data-legend-row">
                    <span className="data-legend-dot" style={{ background: "#1565c0" }} />
                    Selected
                  </div>
                  <div className="data-legend-row">
                    <span className="data-legend-dot" style={{ background: "#9e9e9e" }} />
                    Not downloaded
                  </div>
                </div>
              </div>
            )}

            {/* List */}
            {(viewMode === "list" || viewMode === "both") && (
              <div className="data-list-wrap">
                <div className="data-list-toolbar">
                  <input
                    className="data-list-filter"
                    placeholder="Filter counties…"
                    value={countyFilter}
                    onChange={(e) => setCountyFilter(e.target.value)}
                  />
                </div>
                <div className="data-county-list">
                  {filteredCounties.map((c) => {
                    const selected = selectedCountyIds.has(c.id);
                    const status = countyStatus(c.id);
                    return (
                      <label
                        key={c.id}
                        className={`data-county-row data-county-row--${status} ${selected ? "data-county-row--selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            setSelectedCountyIds((prev) => {
                              const next = new Set(prev);
                              const map = mapRef.current;
                              if (next.has(c.id)) {
                                next.delete(c.id);
                                map?.setFeatureState({ source: "counties", id: c.id }, { selected: false });
                              } else {
                                next.add(c.id);
                                map?.setFeatureState({ source: "counties", id: c.id }, { selected: true });
                              }
                              return next;
                            });
                          }}
                        />
                        <span className="data-county-status-dot" data-status={status} />
                        <span className="data-county-name">{c.name}</span>
                        {status === "stale" && (
                          <span className="data-county-badge data-county-badge--stale">Outdated</span>
                        )}
                        {status === "current" && (
                          <span className="data-county-badge data-county-badge--current">Current</span>
                        )}
                      </label>
                    );
                  })}
                  {filteredCounties.length === 0 && (
                    <p className="data-list-empty">
                      {counties.length === 0
                        ? selectedStateId
                          ? "Loading counties…"
                          : "Select a state above."
                        : "No counties match the filter."}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Bulk-select buttons */}
          {counties.length > 0 && (
            <div className="data-bulk-bar">
              <button className="data-bulk-btn" onClick={selectAll}>Select All</button>
              <button className="data-bulk-btn" onClick={clearSelection}>Clear</button>
              <button className="data-bulk-btn" onClick={selectDownloaded}>
                Select Downloaded
              </button>
              <button className="data-bulk-btn" onClick={invertSelection}>Invert</button>
              <span className="data-bulk-info">
                {selectedCountyIds.size} of {counties.length} counties selected
              </span>
            </div>
          )}

          {/* Layer selection + download controls */}
          {selectedStateId && (
            <div className="data-download-pane">
              <div className="data-layers-section">
                <h3 className="data-layers-heading">Layers to download</h3>
                {downloadableLayers.length === 0 ? (
                  <p className="data-layers-empty">No downloadable layers for this state.</p>
                ) : (
                  <div className="data-layer-list">
                    {downloadableLayers.map((l) => (
                      <label key={l.id} className="data-layer-row">
                        <input
                          type="checkbox"
                          checked={selectedLayerIds.has(l.id)}
                          disabled={isDownloading}
                          onChange={() => {
                            setSelectedLayerIds((prev) => {
                              const next = new Set(prev);
                              next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                              return next;
                            });
                          }}
                        />
                        <span className="data-layer-name">
                          <span className="data-layer-group">{l.groupLabel}</span>
                          {l.name}
                        </span>
                        <span className="data-layer-size">~{l.estimatedSizeMb} MB</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="data-download-footer">
                {!isDownloading ? (
                  <>
                    <span className="data-download-total">
                      {selectedLayerIds.size > 0
                        ? `Selected: ${selectedLayerIds.size} layer${selectedLayerIds.size === 1 ? "" : "s"} — approximately ${totalEstimatedMb} MB`
                        : "Select layers above to download."}
                    </span>
                    <button
                      className="data-download-btn"
                      disabled={selectedLayerIds.size === 0}
                      onClick={handleDownload}
                    >
                      Download Selected
                    </button>
                  </>
                ) : (
                  <div className="data-progress">
                    <div className="data-progress-label">
                      Downloading: {progress?.currentLayerName || "…"}
                    </div>
                    <div className="data-progress-bar-wrap">
                      <div
                        className="data-progress-bar"
                        style={{
                          width:
                            progress && progress.overallTotal > 0
                              ? `${Math.round((progress.overallCompleted / progress.overallTotal) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                    <div className="data-progress-text">
                      {progress?.overallCompleted ?? 0} of {progress?.overallTotal ?? 0} items
                      {progress?.error && (
                        <span className="data-progress-error"> — {progress.error}</span>
                      )}
                    </div>
                    <button
                      className="data-cancel-btn"
                      onClick={handleCancel}
                      disabled={cancelRequested}
                      title={cancelRequested
                        ? "Finishing the file already downloading, then stopping"
                        : "Stop after the current file finishes"}
                    >
                      {cancelRequested ? "Cancelling…" : "Cancel"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Manage Downloads panel */}
      {showManage && (
        <div className="data-manage-pane">
          <div className="data-manage-header">
            <div className="data-manage-dir">
              <span className="data-manage-dir-label">Data directory:</span>
              <span className="data-manage-dir-path">{diskUsage?.dataDir ?? "…"}</span>
            </div>
            <div className="data-manage-usage">
              Total: <strong>{formatBytes(diskUsage?.totalBytes ?? 0)}</strong>
            </div>
          </div>

          {downloadedLayers.length === 0 ? (
            <div className="data-manage-empty">
              <p>No data downloaded yet.</p>
              <button className="data-bulk-btn" onClick={() => setShowManage(false)}>
                Go to Download
              </button>
            </div>
          ) : (
            <div className="data-manage-list">
              {downloadedLayers.map((entry) => (
                <div
                  key={entry.layerId}
                  className={`data-manage-row ${entry.isStale ? "data-manage-row--stale" : ""}`}
                >
                  <div className="data-manage-row-info">
                    <span className="data-manage-row-name">{entry.layerName}</span>
                    <span className="data-manage-row-meta">
                      {formatBytes(entry.sizeBytes)} · Downloaded{" "}
                      {formatDate(entry.downloadedAt)}
                      {entry.isStale && (
                        <span className="data-manage-stale-flag"> · May be outdated</span>
                      )}
                    </span>
                    <a
                      className="data-manage-source"
                      href="#"
                      title={entry.sourceUrl}
                      onClick={(e) => e.preventDefault()}
                    >
                      {shortUrl(entry.sourceUrl)}
                    </a>
                  </div>
                  <div className="data-manage-row-actions">
                    {entry.isStale && (
                      <button
                        className="data-manage-update-btn"
                        onClick={() => {
                          const layer = downloadableLayers.find((l) => l.id === entry.layerId);
                          if (!layer) return;
                          invoke("start_download", {
                            stateId: selectedStateId,
                            items: [{ layerId: layer.id, layerName: layer.name, downloadUrl: layer.downloadUrl }],
                          }).then(() => startProgressPolling()).catch(console.error);
                          setShowManage(false);
                        }}
                      >
                        Update
                      </button>
                    )}
                    <button
                      className="data-manage-delete-btn"
                      onClick={() => handleDeleteLayer(entry.layerId)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateSizeMb(l: LayerConfig): number {
  if (l.sourceType === "geojson") return 25;
  if (l.sourceType === "shapefile") return 15;
  return 10;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}
