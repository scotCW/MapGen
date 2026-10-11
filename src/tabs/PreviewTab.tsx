/**
 * Tab 4 — Preview
 * Page-by-page preview of the finished map. Pages are drawn by the same code
 * as the PDF exporter (cartography.ts through an SVG painter), so the preview
 * is the export — layout, fonts, and which elements appear.
 *
 * Element checkboxes are staged: "Save & Apply" persists them to the project
 * (the exporter reads them from there) and re-renders.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../lib/ipc";
import { isStaleGenerationError } from "../lib/saveEpoch";
import { useExperience } from "../theme/ExperienceContext";
import { renderMapImage } from "../lib/renderMapImage";
import { drawMapPage } from "../lib/cartography";
import { SvgPainter } from "../lib/painter";
import {
  planPages, pagePixelSize, pageSpec, collectRasterLayers, collectLegend,
} from "../lib/mapJob";
import type { MapPlan, SpecContext } from "../lib/mapJob";
import type { NationalLayerConfig } from "../types/layers";
import type { ProjectMeta } from "../types/project";
import type { MapElements } from "../types/elements";
import { normalizeElements, elementsEqual } from "../types/elements";
import "./PreviewTab.css";

const PREV_DPI = 110;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];

interface Props {
  projectId: string;
  isActive:  boolean;
}

interface Rendered {
  /** Project + elements the images were rendered for. */
  project: ProjectMeta;
  plan: MapPlan;
  ctx: SpecContext;
  images: (string | null)[];
}

export function PreviewTab({ projectId, isActive }: Props) {
  const { atLeast } = useExperience();
  const [project,    setProject]    = useState<ProjectMeta | null>(null);
  const [layerCfg,   setLayerCfg]   = useState<NationalLayerConfig | null>(null);
  const [draft,      setDraft]      = useState<MapElements | null>(null);
  const [rendered,   setRendered]   = useState<Rendered | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [rendering,  setRendering]  = useState<{ done: number; total: number } | null>(null);
  const [renderErr,  setRenderErr]  = useState<string | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [saveErr,    setSaveErr]    = useState<string | null>(null);
  const renderSeq = useRef(0);

  const saved = useMemo(() => normalizeElements(project?.elements), [project]);
  const dirty = !!draft && !elementsEqual(draft, saved);

  // ── Load project + layer config on every activation ──────────────────────
  // Re-fetching each time means changes made on Format/Area/Layers since the
  // last visit are picked up instead of previewing a stale copy.
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    invoke<ProjectMeta>("get_project", { id: projectId })
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        // Keep unsaved checkbox edits across tab switches.
        setDraft((d) => d ?? normalizeElements(p.elements));
      })
      .catch(console.error);
    if (!layerCfg) {
      fetch("/regions/_national.json")
        .then((r) => r.json() as Promise<NationalLayerConfig>)
        .then((c) => { if (!cancelled) setLayerCfg(c); })
        .catch(console.error);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, projectId]);

  // ── Render ────────────────────────────────────────────────────────────────
  const doRender = useCallback(async (proj: ProjectMeta, cfg: NationalLayerConfig) => {
    const seq = ++renderSeq.current;
    setRenderErr(null);

    const rasters = collectRasterLayers(proj.layers, cfg);
    if (rasters.length === 0) {
      setRenderErr("No streamable layers are enabled. Enable a basemap in Online mode.");
      return;
    }

    const plan = planPages(proj);
    const ctx: SpecContext = { project: proj, plan, legend: collectLegend(proj.layers, cfg) };
    const images: (string | null)[] = plan.pages.map(() => null);
    setRendered({ project: proj, plan, ctx, images: [...images] });
    setCurrentIdx((i) => Math.min(i, plan.pages.length - 1));
    setRendering({ done: 0, total: plan.pages.length });

    let failed = 0;
    for (let i = 0; i < plan.pages.length; i++) {
      const job = plan.pages[i];
      const { pixelW, pixelH } = pagePixelSize(job, PREV_DPI);
      const base = pagePixelSize(job, 96);
      try {
        images[i] = await renderMapImage({
          bounds: job.bounds, pixelW, pixelH, rasterLayers: rasters,
          timeoutMs: Math.round(60_000 * Math.max(1, (pixelW * pixelH) / (base.pixelW * base.pixelH))),
        });
      } catch (e) {
        failed++;
        console.error(`[preview] page ${i + 1} failed`, e);
      }
      if (seq !== renderSeq.current) return; // superseded by a newer render
      setRendered({ project: proj, plan, ctx, images: [...images] });
      setRendering({ done: i + 1, total: plan.pages.length });
    }

    setRendering(null);
    if (failed > 0) {
      setRenderErr(`${failed} of ${plan.pages.length} page${plan.pages.length === 1 ? "" : "s"} failed to render (tile timeout — slow or no connection?). Click Refresh to retry.`);
    }
  }, []);

  // First render once everything is loaded; afterwards only on demand
  // (Refresh / Save & Apply) so a slow connection isn't hammered on every
  // tab switch.
  useEffect(() => {
    if (!isActive || !project || !layerCfg || rendered || rendering) return;
    doRender(project, layerCfg);
  }, [isActive, project, layerCfg, rendered, rendering, doRender]);

  // Settings that change the printed pages, compared against what's rendered.
  const renderedStale = useMemo(() => {
    if (!project || !rendered) return false;
    const a = rendered.project, b = project;
    return JSON.stringify([a.format, a.area, a.layers, a.name, normalizeElements(a.elements)])
        !== JSON.stringify([b.format, b.area, b.layers, b.name, normalizeElements(b.elements)]);
  }, [project, rendered]);

  function refresh() {
    if (!project || !layerCfg) return;
    doRender(project, layerCfg);
  }

  async function saveAndApply() {
    if (!project || !draft || !layerCfg || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      // Always re-read first: another tab may have saved since we loaded.
      const latest = await invoke<ProjectMeta>("get_project", { id: projectId });
      const generation = await invoke<number>("save_map_elements", {
        id: projectId,
        elements: draft,
        expectedGeneration: latest.settingsGeneration ?? 0,
      });
      const next: ProjectMeta = { ...latest, elements: { ...draft }, settingsGeneration: generation };
      setProject(next);
      doRender(next, layerCfg);
    } catch (e) {
      if (isStaleGenerationError(e)) {
        setSaveErr("The project was changed elsewhere (restore or preset). Reloaded — please apply again.");
        const p = await invoke<ProjectMeta>("get_project", { id: projectId }).catch(() => null);
        if (p) setProject(p);
      } else {
        setSaveErr(`Could not save: ${String(e)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setDraft(saved);
    setSaveErr(null);
  }

  function toggle(key: keyof MapElements, value: boolean) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // ── Keyboard: page navigation ─────────────────────────────────────────────
  const totalPages = rendered?.plan.pages.length ?? 0;
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "PageDown" || (e.key === "ArrowRight" && !e.ctrlKey)) {
        setCurrentIdx((i) => Math.min(i + 1, totalPages - 1));
      } else if (e.key === "PageUp" || (e.key === "ArrowLeft" && !e.ctrlKey)) {
        setCurrentIdx((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, totalPages]);

  if (!project || !draft) {
    return <div className="preview-loading" role="status">Loading project…</div>;
  }

  const isMulti = (rendered?.plan.isMulti) ?? false;
  const job     = rendered?.plan.pages[currentIdx];
  const image   = rendered?.images[currentIdx] ?? null;

  return (
    <div className="preview-tab">

      {/* ── Sidebar: element checkboxes ─────────────────────────────────── */}
      <aside className="preview-sidebar" aria-label="Map elements">
        <div className="preview-sidebar-header">Map Elements</div>

        {atLeast("intermediate") ? (
          <>
            <ElementGroup label="Layout">
              <CheckRow label="Title block"      checked={draft.titleBlock}     onChange={(v) => toggle("titleBlock", v)} />
              <CheckRow label="Sheet reference"  checked={draft.sheetReference} disabled={!draft.titleBlock}
                        onChange={(v) => toggle("sheetReference", v)} />
              <CheckRow label="Neatline (frame)" checked={draft.neatline}       onChange={(v) => toggle("neatline", v)} />
            </ElementGroup>

            <ElementGroup label="Cartographic">
              <CheckRow label="Compass rose" checked={draft.compassRose} onChange={(v) => toggle("compassRose", v)} />
              <CheckRow label="Scale bar"    checked={draft.scaleBar}    onChange={(v) => toggle("scaleBar",    v)} />
              <CheckRow label="Ratio scale"  checked={draft.ratioScale}  onChange={(v) => toggle("ratioScale",  v)} />
              <CheckRow label="Legend"       checked={draft.legend}      onChange={(v) => toggle("legend",      v)} />
            </ElementGroup>

            <ElementGroup label="Grid">
              <CheckRow label="Lat / Lon grid lines" checked={draft.gridLines} onChange={(v) => toggle("gridLines", v)} />
              <CheckRow label="Coordinate labels" checked={draft.coordinateLabels} disabled={!draft.gridLines}
                        onChange={(v) => toggle("coordinateLabels", v)} />
            </ElementGroup>

            {isMulti && (
              <ElementGroup label="Multi-sheet">
                <CheckRow label="Index inset"      checked={draft.indexInset}       onChange={(v) => toggle("indexInset",       v)} />
                <CheckRow label="Edge match marks" checked={draft.edgeMatchMarkers} onChange={(v) => toggle("edgeMatchMarkers", v)} />
                <CheckRow label="Overview sheet"   checked={draft.overviewSheet}    onChange={(v) => toggle("overviewSheet",    v)} />
              </ElementGroup>
            )}

            <ElementGroup label="Safety">
              <CheckRow label="Access disclaimer" checked={draft.disclaimer} onChange={(v) => toggle("disclaimer", v)} />
              {!draft.disclaimer && (
                <p className="preview-warn-note" role="note">
                  Printed maps won't carry the land-access warning. Verify access independently before you hunt.
                </p>
              )}
            </ElementGroup>
          </>
        ) : (
          <ElementGroup label="Map elements">
            <p className="preview-beginner-note">
              Every map element is included. Switch to Intermediate or Advanced in Settings to turn
              individual elements (title block, grid, legend, disclaimer…) on or off.
            </p>
          </ElementGroup>
        )}

        <div className="preview-actions">
          {dirty && <div className="preview-dirty-note" role="status">Unsaved changes</div>}
          <button
            className="preview-apply-btn"
            onClick={saveAndApply}
            disabled={saving || (!dirty && !renderedStale)}
            title="Save these elements to the project (export uses them) and re-render the preview"
          >
            {saving ? "Saving…" : "Save & Apply"}
          </button>
          {dirty && (
            <button className="preview-revert-btn" onClick={revert} disabled={saving}>
              Discard changes
            </button>
          )}
          {saveErr && <div className="preview-save-err" role="alert">{saveErr}</div>}
          <button
            className="preview-refresh-btn"
            onClick={refresh}
            disabled={!!rendering}
            aria-busy={!!rendering}
          >
            {rendering ? `Rendering ${rendering.done}/${rendering.total}…` : "Refresh Preview"}
          </button>
          {renderedStale && !dirty && !rendering && (
            <div className="preview-dirty-note">Project settings changed — refresh to update.</div>
          )}
        </div>
      </aside>

      {/* ── Main: thumbnail strip + page viewer ─────────────────────────── */}
      <div className="preview-main">
        {totalPages > 1 && rendered && (
          <div className="preview-thumbstrip" role="list" aria-label="Page thumbnails">
            {rendered.plan.pages.map((p, i) => {
              const label = p.kind === "overview" ? "Overview" : p.cell ? `Sheet ${p.cell.ref}` : `Page ${i + 1}`;
              const img = rendered.images[i];
              return (
                <button
                  key={i}
                  role="listitem"
                  className={`preview-thumb ${currentIdx === i ? "preview-thumb--active" : ""}`}
                  onClick={() => setCurrentIdx(i)}
                  title={label}
                  aria-current={currentIdx === i ? "true" : undefined}
                >
                  {img
                    ? <img src={img} alt={label} className="preview-thumb-img" />
                    : <div className="preview-thumb-img preview-thumb-img--pending" />}
                  <span className="preview-thumb-label">{label}</span>
                </button>
              );
            })}
          </div>
        )}

        {renderErr && (
          <div className="preview-error" role="alert">
            <strong>Preview problem:</strong> {renderErr}
            <button className="preview-retry-btn" onClick={refresh}>Try again</button>
          </div>
        )}

        {rendered && job ? (
          <PageViewer
            key={rendered.plan.layout.pageW + "x" + rendered.plan.layout.pageH}
            pageW={job.layout.pageW}
            pageH={job.layout.pageH}
            loading={!image && !!rendering}
            isActive={isActive}
            renderPage={(images) => {
              const painter = new SvgPainter(job.layout.pageH, images);
              drawMapPage(painter, pageSpec(job, "map", rendered.ctx));
              return painter.nodes;
            }}
            image={image}
          />
        ) : (
          <div className="preview-viewer">
            {rendering ? (
              <div className="preview-status" role="status" aria-live="polite">
                <div className="preview-spinner" aria-hidden="true" />
                Rendering preview…
              </div>
            ) : !renderErr && (
              <div className="preview-status">
                Press <strong>Refresh Preview</strong> to render the map.
              </div>
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="preview-nav" aria-label="Page navigation">
            <button
              className="preview-nav-btn"
              onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              disabled={currentIdx === 0}
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="preview-nav-label">{currentIdx + 1} / {totalPages}</span>
            <button
              className="preview-nav-btn"
              onClick={() => setCurrentIdx((i) => Math.min(totalPages - 1, i + 1))}
              disabled={currentIdx === totalPages - 1}
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageViewer — zoomable / pannable SVG page
// ---------------------------------------------------------------------------

interface ViewerProps {
  pageW: number;
  pageH: number;
  image: string | null;
  loading: boolean;
  isActive: boolean;
  renderPage: (images: Record<string, string>) => React.ReactNode[];
}

function PageViewer({ pageW, pageH, image, loading, isActive, renderPage }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // zoom is relative to "fit whole page"; 1 = fit.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingAnchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const PAD = 24;
  const fit = box.w > 0 ? Math.min((box.w - PAD * 2) / pageW, (box.h - PAD * 2) / pageH) : 1;
  const fitWidth = box.w > 0 ? (box.w - PAD * 2) / pageW : 1;
  const px = Math.max(0.05, fit) * zoom; // CSS px per pt
  const w = pageW * px;
  const h = pageH * px;

  // Keep the point under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const a = pendingAnchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    pendingAnchor.current = null;
    el.scrollLeft = a.fx * (w + PAD * 2) - a.cx;
    el.scrollTop  = a.fy * (h + PAD * 2) - a.cy;
  }, [w, h]);

  const applyZoom = useCallback((next: number, clientX?: number, clientY?: number) => {
    const el = scrollRef.current;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (el) {
      const r = el.getBoundingClientRect();
      const cx = clientX !== undefined ? clientX - r.left : el.clientWidth / 2;
      const cy = clientY !== undefined ? clientY - r.top  : el.clientHeight / 2;
      pendingAnchor.current = {
        fx: (el.scrollLeft + cx) / Math.max(1, el.scrollWidth),
        fy: (el.scrollTop  + cy) / Math.max(1, el.scrollHeight),
        cx, cy,
      };
    }
    setZoom(z);
  }, []);

  const stepZoom = useCallback((dir: 1 | -1) => {
    const z = zoomRef.current;
    const next = dir > 0
      ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX
      : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN;
    applyZoom(next);
  }, [applyZoom]);

  // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0025);
      applyZoom(zoomRef.current * factor, e.clientX, e.clientY);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  // Keyboard: Ctrl/Cmd +/-/0
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoom(1); }
      else if (e.key === "-") { e.preventDefault(); stepZoom(-1); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, stepZoom]);

  const canPan = w + PAD * 2 > box.w || h + PAD * 2 > box.h;

  return (
    <div className="preview-viewer-wrap">
      <div className="preview-zoombar" role="toolbar" aria-label="Zoom">
        <button className="preview-zoom-btn" onClick={() => stepZoom(-1)} aria-label="Zoom out" title="Zoom out (Ctrl −)">−</button>
        <span className="preview-zoom-label" aria-live="polite">{Math.round(px * 100 * 72 / 96)}%</span>
        <button className="preview-zoom-btn" onClick={() => stepZoom(1)} aria-label="Zoom in" title="Zoom in (Ctrl +)">+</button>
        <button className="preview-zoom-btn preview-zoom-btn--text" onClick={() => setZoom(1)} title="Fit whole page (Ctrl 0)">Fit page</button>
        <button className="preview-zoom-btn preview-zoom-btn--text" onClick={() => setZoom(fitWidth / Math.max(0.05, fit))} title="Fit page width">Fit width</button>
        <button className="preview-zoom-btn preview-zoom-btn--text" onClick={() => setZoom((96 / 72) / Math.max(0.05, fit))} title="Actual printed size">100%</button>
        <span className="preview-zoom-hint">Ctrl + scroll to zoom · drag to pan</span>
      </div>
      <div
        ref={scrollRef}
        className={`preview-viewer preview-viewer--zoomable ${canPan ? "preview-viewer--pan" : ""}`}
        onPointerDown={(e) => {
          if (!canPan || e.button !== 0) return;
          const el = scrollRef.current!;
          drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const el = scrollRef.current!;
          el.scrollLeft = d.sl - (e.clientX - d.x);
          el.scrollTop  = d.st - (e.clientY - d.y);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <div className="preview-canvas" style={{ width: w + PAD * 2, height: h + PAD * 2, padding: PAD }}>
          <svg
            className="preview-page-svg"
            width={w}
            height={h}
            viewBox={`0 0 ${pageW} ${pageH}`}
            role="img"
            aria-label="Printed page preview"
          >
            {renderPage(image ? { map: image } : {})}
          </svg>
          {loading && (
            <div className="preview-page-loading" role="status">
              <div className="preview-spinner" aria-hidden="true" />
              Rendering map…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar helpers
// ---------------------------------------------------------------------------

function ElementGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="preview-group">
      <div className="preview-group-label">{label}</div>
      {children}
    </div>
  );
}

function CheckRow({
  label, checked, disabled, onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = `prev-el-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <label className={`preview-check-row ${disabled ? "preview-check-row--disabled" : ""}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="preview-checkbox"
      />
      <span className="preview-check-label">{label}</span>
    </label>
  );
}
