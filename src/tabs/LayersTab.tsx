import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import { invoke } from "../lib/ipc";
import { captureSaveEpoch, isSaveEpochCurrent, isStaleGenerationError } from "../lib/saveEpoch";
import type {
  NationalLayerConfig,
  StateLayerConfig,
  LayerConfig,
  LayerGroup,
  LayerSettings,
} from "../types/layers";
import { isLayerAvailable, mergeStateConfig } from "../types/layers";
import "./LayersTab.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  isActive: boolean;
  online: boolean;
  projectState?: string | null; // "CO", "WY", etc.
  missingCountyGeoJSON?: any | null; // counties with no offline data, for gap overlay
}

// ---------------------------------------------------------------------------
// Raster source IDs that can be streamed live without a local download
// ---------------------------------------------------------------------------

const RASTER_IDS = new Set(["usgs_topo", "usgs_imagery", "usgs_imagery_topo", "hillshade"]);

// ---------------------------------------------------------------------------
// LayersTab
// ---------------------------------------------------------------------------

export function LayersTab({ projectId, isActive, online, projectState, missingCountyGeoJSON }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Layer config loaded from regions/_national.json
  const [config, setConfig] = useState<NationalLayerConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // Per-project layer state
  const [activeBasemap, setActiveBasemap] = useState("usgs_topo");
  const [enabledLayers, setEnabledLayers] = useState<Set<string>>(new Set());
  const [opacities, setOpacities] = useState<Record<string, number>>({});

  // The project's saved print-area center, once loaded — used to move the
  // camera there so toggling a layer shows it on the user's actual selected
  // area rather than on the map's hardcoded initial view (see below).
  const [projectCenter, setProjectCenter] = useState<{ lng: number; lat: number } | null>(null);
  const cameraSyncedRef = useRef(false);

  // Bumped after raster basemap sources/layers are added (see effect 4a), to
  // retrigger the visibility-sync effect for layers that didn't exist yet the
  // last time it ran.
  const [basemapSourcesVersion, setBasemapSourcesVersion] = useState(0);

  // Keep a ref so the debounced save can read current values
  const stateRef = useRef({ activeBasemap, enabledLayers, opacities });
  useEffect(() => { stateRef.current.activeBasemap = activeBasemap; }, [activeBasemap]);
  useEffect(() => { stateRef.current.enabledLayers = enabledLayers; }, [enabledLayers]);
  useEffect(() => { stateRef.current.opacities = opacities; }, [opacities]);

  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation this tab loaded with; the backend refuses saves carrying a
  // stale one, which is how a restore wins the race regardless of timing.
  const generationRef = useRef(0);

  // Whether the user has hidden the persistent disclaimer via Settings
  const [hideDisclaimer, setHideDisclaimer] = useState(false);

  // ------------------------------------------------------------------
  // 0. Load user settings (disclaimer visibility, etc.)
  // ------------------------------------------------------------------

  useEffect(() => {
    invoke<Record<string, unknown>>("get_settings")
      .then((s) => {
        if (s.hide_access_disclaimer === true) setHideDisclaimer(true);
      })
      .catch(console.error);
  }, []);

  // ------------------------------------------------------------------
  // 1. Load config (national + optional state overlay)
  // ------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadConfigs() {
      // 1a. Always load national config.
      const natRes = await fetch("/regions/_national.json");
      if (!natRes.ok) throw new Error(`HTTP ${natRes.status} loading _national.json`);
      let cfg: NationalLayerConfig = await natRes.json();

      // 1b. If a state is selected, load its config and merge.
      if (projectState) {
        // Look up file name from the states manifest.
        try {
          const manifestRes = await fetch("/regions/_states.json");
          if (manifestRes.ok) {
            const manifest = await manifestRes.json();
            const entry = manifest.states?.find((s: { id: string }) => s.id === projectState);
            if (entry?.file) {
              const stateRes = await fetch(`/regions/${entry.file}.json`);
              if (stateRes.ok) {
                const stateCfg: StateLayerConfig = await stateRes.json();
                cfg = mergeStateConfig(cfg, stateCfg);
              }
            }
          }
        } catch {
          // State config load failure is non-fatal — national layers still work.
          console.warn(`Could not load state config for ${projectState}`);
        }
      }

      if (cancelled) return;
      setConfig(cfg);
      // Seed per-layer opacity defaults from merged config.
      const defaults: Record<string, number> = {};
      for (const g of cfg.groups) {
        for (const l of g.layers) defaults[l.id] = l.defaultOpacity;
      }
      setOpacities((prev) => ({ ...defaults, ...prev }));
    }

    loadConfigs().catch((e) => setConfigError(String(e)));
    return () => { cancelled = true; };
  }, [projectState]);

  // ------------------------------------------------------------------
  // 2. Load saved layer state from project.json
  // ------------------------------------------------------------------

  useEffect(() => {
    invoke<{ layers?: LayerSettings }>("get_project", { id: projectId })
      .then((proj) => {
        // Must be captured before the early return below: leaving it at 0 while
        // the file is on a later generation would get every save refused.
        generationRef.current = (proj as any).settingsGeneration ?? 0;
        const area = (proj as any).area as { centerLng: number; centerLat: number } | undefined;
        if (area) setProjectCenter({ lng: area.centerLng, lat: area.centerLat });
        const ls = (proj as any).layers as LayerSettings | undefined;
        if (!ls) return;
        if (ls.activeBasemap) setActiveBasemap(ls.activeBasemap);
        if (ls.enabledLayers) setEnabledLayers(new Set(ls.enabledLayers));
        if (ls.layerOpacities && Object.keys(ls.layerOpacities).length > 0) {
          setOpacities((prev) => ({ ...prev, ...ls.layerOpacities }));
        }
      })
      .catch(console.error);
  }, [projectId]);

  // ------------------------------------------------------------------
  // 3. Debounced save
  // ------------------------------------------------------------------

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // This timer deliberately survives unmount so a last-moment toggle still
    // lands; the epoch check is what stops it landing on top of a restore.
    const epoch = captureSaveEpoch();
    saveTimer.current = setTimeout(() => {
      if (!isSaveEpochCurrent(epoch)) return; // superseded by a restore
      const { activeBasemap, enabledLayers, opacities } = stateRef.current;
      invoke<number>("save_layer_settings", {
        id: projectId,
        layers: {
          activeBasemap,
          enabledLayers: [...enabledLayers],
          layerOpacities: opacities,
        } satisfies LayerSettings,
        expectedGeneration: generationRef.current,
      })
        .then((generation) => { generationRef.current = generation; })
        .catch((err) => {
          // Refused because a restore superseded this write — expected.
          if (isStaleGenerationError(err)) return;
          console.error("Layer save failed:", err);
        });
    }, 800);
  }, [projectId]);

  // ------------------------------------------------------------------
  // 4. Initialise MapLibre map
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      // CONUS centre — a placeholder until the project's saved area loads and
      // effect 4b below moves the camera. Never recentering here at all was
      // the actual bug: toggling a layer showed nothing recognizable, because
      // the map was permanently sitting over central Kansas regardless of
      // which project or state was open.
      style: { version: 8, sources: {}, layers: [] },
      center: [-98.5795, 39.8283],
      zoom: 4,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-left"
    );

    map.on("load", () => {
      setMapReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------
  // 4a. Add raster basemap sources once the map AND the layer config are
  //     both ready
  // ------------------------------------------------------------------

  // This used to run inside the map's one-time "load" listener above, which
  // is registered exactly once at mount (empty deps) and so closes over
  // whatever `config` was at that first render — always null, since the
  // config fetch is a separate async effect that hasn't resolved yet. The
  // "load" event almost always fires before that fetch completes, so this
  // silently never added the basemap at all: the raster source/layer simply
  // didn't exist, regardless of which basemap radio was selected. A proper
  // effect keyed on [mapReady, config] re-runs when config actually arrives,
  // instead of relying on a closure that's stuck at its mount-time value.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !config) return;

    for (const id of RASTER_IDS) {
      if (map.getSource(id)) continue;
      const layer = findLayerById(id, config);
      if (!layer?.tiles) continue;
      map.addSource(id, {
        type: "raster",
        tiles: layer.tiles,
        tileSize: layer.tileSize ?? 256,
        maxzoom: layer.maxZoom ?? 16,
        attribution: layer.attribution,
      });
      map.addLayer({
        id,
        type: "raster",
        source: id,
        layout: { visibility: "none" },
        paint: { "raster-opacity": layer.defaultOpacity },
      });
    }
    // Newly-added layers start hidden (visibility: "none"); re-run the same
    // sync effect 5 relies on to show whichever one is actually selected.
    setBasemapSourcesVersion((v) => v + 1);
  }, [mapReady, config]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize map when tab becomes active (it was hidden by CSS)
  useEffect(() => {
    if (isActive && mapRef.current) {
      // requestAnimationFrame ensures the panel has actually become visible
      requestAnimationFrame(() => mapRef.current?.resize());
    }
  }, [isActive]);

  // ------------------------------------------------------------------
  // 4b. Move the camera to the project's saved area, once
  // ------------------------------------------------------------------

  // Exactly-once guard, same reasoning as AreaTab's cameraSyncedRef: this only
  // needs to fire on the transition from the map's placeholder center to the
  // real loaded one, not every time projectCenter's object identity happens
  // to change on a re-render.
  //
  // Deliberately waits on `config` too, not just `mapReady`/`projectCenter`:
  // this is also where the "tiles never render" bug (see effect 4a's comment)
  // gets its actual fix. Sources/layers added while the camera sits still
  // don't trigger a tile-load pass on their own — confirmed by testing, a
  // fully "visible" raster layer with a real tile source issued zero tile
  // requests until the camera moved again. Earlier attempts at fixing that
  // *inside* effect 4a (resize/triggerRepaint, then a same-value jumpTo, then
  // a nudge) all failed for the same reason: this effect used to run
  // independently and would land on the project's *exact* saved coordinates
  // afterward with no nudge, silently overwriting whatever 4a had done.
  // Gating on `config` here means this is always the last camera move once
  // both are ready, so its nudge is the one that sticks.
  useEffect(() => {
    if (!mapReady || !config || !projectCenter || cameraSyncedRef.current) return;
    cameraSyncedRef.current = true;
    // A sub-meter nudge (0.00001°) forces MapLibre to recompute tile coverage
    // for sources that didn't exist the last time the transform changed —
    // jumpTo no-ops when center/zoom exactly match the current transform, so
    // landing precisely on projectCenter left the newly-added basemap source
    // permanently unrequested. The offset is imperceptible at any zoom used
    // here (real zoom used is 12, i.e. ~30m/px).
    mapRef.current?.jumpTo({
      center: [projectCenter.lng + 0.00001, projectCenter.lat],
      zoom: 12,
    });
  }, [mapReady, config, projectCenter]);

  // ------------------------------------------------------------------
  // 5. Sync map when layer state changes
  // ------------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    for (const id of RASTER_IDS) {
      if (!map.getLayer(id)) continue;

      let visible = false;
      if (id === activeBasemap) {
        visible = true;
      } else if (enabledLayers.has(id)) {
        visible = true;
      }

      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      const opacity = opacities[id] ?? 1.0;
      map.setPaintProperty(id, "raster-opacity", opacity);
    }
    // basemapSourcesVersion: raster layers start hidden when effect 4a adds
    // them, so this needs to re-run once they exist to show whichever one is
    // actually selected — it's otherwise unused, only bumped to retrigger this.
  }, [mapReady, activeBasemap, enabledLayers, opacities, basemapSourcesVersion]);

  // ------------------------------------------------------------------
  // 6. Offline gap overlay — hatched fill on counties with no local data
  // ------------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const SRC = "offline-gap-source";
    const FILL = "offline-gap-fill";
    const LINE = "offline-gap-line";

    if (missingCountyGeoJSON && !online) {
      // Upsert source
      if (map.getSource(SRC)) {
        (map.getSource(SRC) as maplibregl.GeoJSONSource).setData(missingCountyGeoJSON);
      } else {
        map.addSource(SRC, { type: "geojson", data: missingCountyGeoJSON });
      }
      // Fill layer — semi-transparent orange hatch effect via solid colour
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: "fill",
          source: SRC,
          paint: { "fill-color": "#ff6d00", "fill-opacity": 0.12 },
        });
      }
      // Outline
      if (!map.getLayer(LINE)) {
        map.addLayer({
          id: LINE,
          type: "line",
          source: SRC,
          paint: { "line-color": "#ff6d00", "line-width": 1.5, "line-dasharray": [4, 3] },
        });
      }
    } else {
      // Remove layers when online or no missing counties
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getSource(SRC)) map.removeSource(SRC);
    }
  }, [mapReady, missingCountyGeoJSON, online]);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function findLayerById(id: string, cfg: NationalLayerConfig | null): LayerConfig | undefined {
    const source = cfg ?? config;
    if (!source) return undefined;
    for (const g of source.groups) {
      const l = g.layers.find((l) => l.id === id);
      if (l) return l;
    }
    return undefined;
  }

  function handleBasemapChange(id: string) {
    setActiveBasemap(id);
    scheduleSave();
  }

  function handleCheckboxChange(id: string, checked: boolean) {
    setEnabledLayers((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
    scheduleSave();
  }

  function handleOpacityChange(id: string, val: number) {
    setOpacities((prev) => ({ ...prev, [id]: val }));
    scheduleSave();
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="layers-tab">
      {/* Full-screen map */}
      <div ref={mapContainerRef} className="layers-map" />

      {/* Floating layer panel */}
      <div className={`lyr-panel ${panelCollapsed ? "lyr-panel--collapsed" : ""}`}>
        <div className="lyr-panel-header">
          <span className="lyr-panel-title">Layers</span>
          <button
            className="lyr-panel-collapse"
            onClick={() => setPanelCollapsed((v) => !v)}
            aria-label={panelCollapsed ? "Expand layers panel" : "Collapse layers panel"}
          >
            {panelCollapsed ? "›" : "‹"}
          </button>
        </div>

        {!panelCollapsed && (
          <div className="lyr-panel-body">
            {configError && (
              <div className="lyr-error">
                Could not load layer config: {configError}
              </div>
            )}

            {config &&
              config.groups.map((group) => (
                <LayerGroupSection
                  key={group.id}
                  group={group}
                  activeBasemap={activeBasemap}
                  enabledLayers={enabledLayers}
                  opacities={opacities}
                  online={online}
                  onBasemapChange={handleBasemapChange}
                  onCheckboxChange={handleCheckboxChange}
                  onOpacityChange={handleOpacityChange}
                />
              ))}

            {/* Persistent land access disclaimer (§6.3). User may hide via Settings > Safety Warnings. */}
            {config && !hideDisclaimer && (
              <div className="lyr-disclaimer" role="note">
                <span className="lyr-disclaimer-icon" aria-hidden="true">⚠</span>
                <span>
                  Access categories are estimates — verify before you hunt.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LayerGroupSection
// ---------------------------------------------------------------------------

interface GroupProps {
  group: LayerGroup;
  activeBasemap: string;
  enabledLayers: Set<string>;
  opacities: Record<string, number>;
  online: boolean;
  onBasemapChange: (id: string) => void;
  onCheckboxChange: (id: string, checked: boolean) => void;
  onOpacityChange: (id: string, val: number) => void;
}

function LayerGroupSection({
  group,
  activeBasemap,
  enabledLayers,
  opacities,
  online,
  onBasemapChange,
  onCheckboxChange,
  onOpacityChange,
}: GroupProps) {
  const isRadio = group.controlType === "radio";

  return (
    <div className="lyr-group">
      <div className="lyr-group-header">{group.label}</div>

      {group.layers.map((layer) => {
        const available = isLayerAvailable(layer, online);
        const checked = isRadio
          ? activeBasemap === layer.id
          : enabledLayers.has(layer.id);
        const opacity = opacities[layer.id] ?? layer.defaultOpacity;

        return (
          <LayerRow
            key={layer.id}
            layer={layer}
            isRadio={isRadio}
            checked={checked}
            opacity={opacity}
            available={available}
            groupId={group.id}
            onToggle={() => {
              if (!available) return;
              if (isRadio) {
                onBasemapChange(layer.id);
              } else {
                onCheckboxChange(layer.id, !checked);
              }
            }}
            onOpacity={(val) => onOpacityChange(layer.id, val)}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LayerRow
// ---------------------------------------------------------------------------

interface RowProps {
  layer: LayerConfig;
  isRadio: boolean;
  checked: boolean;
  opacity: number;
  available: boolean;
  groupId: string;
  onToggle: () => void;
  onOpacity: (val: number) => void;
}

function LayerRow({
  layer,
  isRadio,
  checked,
  opacity,
  available,
  groupId,
  onToggle,
  onOpacity,
}: RowProps) {
  const unavailableReason = !available
    ? layer.requiresDownload
      ? "Download county data first (Data screen)"
      : "Not available in Offline mode"
    : null;

  const inputId = `lyr-${layer.id}`;

  return (
    <div className={`lyr-row ${!available ? "lyr-row--disabled" : ""}`}>
      <label
        className="lyr-row-label"
        htmlFor={inputId}
        title={unavailableReason ?? layer.description}
      >
        <input
          id={inputId}
          type={isRadio ? "radio" : "checkbox"}
          name={isRadio ? `basemap-${groupId}` : undefined}
          checked={checked}
          disabled={!available}
          onChange={onToggle}
          className="lyr-row-input"
        />

        {/* Style swatch — a quick "what this looks like on the map" cue.
            Only raster layers (basemaps, hillshade) have no style to show;
            every line/fill layer's config already carries real render colors,
            so this is drawn from the same values MapLibre actually paints
            with, not a separate guess at what the layer looks like. */}
        {layer.style && (layer.style.fillColor || layer.style.strokeColor) && (
          layer.renderType === "line" ? (
            <span
              className="lyr-swatch lyr-swatch--line"
              style={{
                borderTopColor: layer.style.strokeColor ?? "#888",
                borderTopStyle: layer.style.strokeDash ? "dashed" : "solid",
              }}
              aria-hidden="true"
            />
          ) : (
            <span
              className="lyr-swatch"
              style={{
                background: layer.style.fillColor ?? layer.style.strokeColor ?? "#888",
                border: layer.style.strokeColor
                  ? `1.5px solid ${layer.style.strokeColor}`
                  : undefined,
              }}
              aria-hidden="true"
            />
          )
        )}

        <span className="lyr-row-name">{layer.name}</span>

        {!available && (
          <span className="lyr-badge lyr-badge--offline" aria-label={unavailableReason ?? undefined}>
            {layer.requiresDownload ? "Download" : "Offline"}
          </span>
        )}
      </label>

      {/* Opacity slider — only visible when layer is on */}
      {checked && available && (
        <div className="lyr-opacity">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opacity}
            onChange={(e) => onOpacity(parseFloat(e.target.value))}
            aria-label={`${layer.name} opacity`}
            className="lyr-opacity-slider"
          />
          <span className="lyr-opacity-val">{Math.round(opacity * 100)}%</span>
        </div>
      )}
    </div>
  );
}
