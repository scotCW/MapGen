/**
 * Tab 4 — Preview
 * Page-by-page preview of the finished map with live element checkboxes.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc";
import { useExperience } from "../theme/ExperienceContext";
import { renderMapImage } from "../lib/renderMapImage";
import { computeSheetGrid } from "../lib/sheetGrid";
import type { SheetCell, SheetGrid } from "../lib/sheetGrid";
import { getMagneticDeclination, currentDecimalYear } from "../lib/wmm";
import type { NationalLayerConfig } from "../types/layers";
import { effectivePaper, MARGIN_SIZES } from "../types/format";
import type { ProjectMeta } from "../types/project";
import "./PreviewTab.css";

// ---------------------------------------------------------------------------
// Constants (must match exportPdf.ts band heights)
// ---------------------------------------------------------------------------

const PT_PER_IN  = 72;
const TITLE_H_PT = 42;
const SCALE_H_PT = 54;
const DISC_H_PT  = 44;
const DISC_SCALE_GAP_PT = 10; // must match exportPdf.ts DISC_SCALE_GAP_PT
const PREV_DPI   = 96;
const OVERLAP_IN = 0.5;

// ---------------------------------------------------------------------------
// Element toggle state
// ---------------------------------------------------------------------------

export interface PreviewElements {
  gridLines:          boolean;
  gridType:           "none" | "lat-lon";
  coordinateLabels:   boolean;
  compassRose:        boolean;
  scaleBar:           boolean;
  ratioScale:         boolean;
  legend:             boolean;
  titleBlock:         boolean;
  neatline:           boolean;
  sheetReference:     boolean;
  indexInset:         boolean;
  edgeMatchMarkers:   boolean;
  overviewSheet:      boolean;
  // disclaimer: always true, locked — not in this object
}

const DEFAULT_ELEMENTS: PreviewElements = {
  gridLines:        true,
  gridType:         "lat-lon",
  coordinateLabels: true,
  compassRose:      true,
  scaleBar:         true,
  ratioScale:       true,
  legend:           true,
  titleBlock:       true,
  neatline:         true,
  sheetReference:   true,
  indexInset:       true,
  edgeMatchMarkers: true,
  overviewSheet:    true,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  isActive:  boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RasterLayer { id: string; tiles: string[]; tileSize?: number; opacity?: number; }

function collectRasterLayers(layers: ProjectMeta["layers"], cfg: NationalLayerConfig): RasterLayer[] {
  const out: RasterLayer[] = [];
  for (const group of cfg.groups) {
    for (const layer of group.layers) {
      if (layer.id === layers.activeBasemap && layer.sourceType === "xyz" && layer.tiles) {
        out.push({ id: layer.id, tiles: layer.tiles, tileSize: layer.tileSize });
      }
    }
  }
  for (const group of cfg.groups) {
    for (const layer of group.layers) {
      if (
        layer.id !== layers.activeBasemap &&
        layers.enabledLayers.includes(layer.id) &&
        layer.sourceType === "xyz" &&
        layer.renderType === "raster" &&
        layer.tiles
      ) {
        const opacity = layers.layerOpacities[layer.id] ?? layer.defaultOpacity;
        out.push({ id: layer.id, tiles: layer.tiles, tileSize: layer.tileSize, opacity });
      }
    }
  }
  return out;
}

interface LegendEntry { label: string; color: string; dash?: boolean; }

function collectLegend(layers: ProjectMeta["layers"], cfg: NationalLayerConfig): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const group of cfg.groups) {
    for (const layer of group.layers) {
      if (layer.id === layers.activeBasemap) {
        out.push({ label: layer.name, color: "#888888" });
      } else if (layers.enabledLayers.includes(layer.id)) {
        const color = (layer.style?.fillColor ?? layer.style?.strokeColor) ?? "#666666";
        out.push({ label: layer.name, color, dash: layer.renderType === "line" });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PreviewTab
// ---------------------------------------------------------------------------

export function PreviewTab({ projectId, isActive }: Props) {
  const { atLeast } = useExperience();
  const [project,    setProject]    = useState<ProjectMeta | null>(null);
  const [layerCfg,   setLayerCfg]   = useState<NationalLayerConfig | null>(null);
  const [elements,   setElements]   = useState<PreviewElements>(DEFAULT_ELEMENTS);
  const [grid,       setGrid]       = useState<SheetGrid | null>(null);
  const [mapImages,  setMapImages]  = useState<string[]>([]);
  const [legend,     setLegend]     = useState<LegendEntry[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [rendering,  setRendering]  = useState(false);
  const [renderErr,  setRenderErr]  = useState<string | null>(null);
  const hasRendered = useRef(false);

  // Load project + layer config when tab first activates
  useEffect(() => {
    if (!isActive) return;
    invoke<ProjectMeta>("get_project", { id: projectId })
      .then(setProject).catch(console.error);
    fetch("/regions/_national.json")
      .then((r) => r.json() as Promise<NationalLayerConfig>)
      .then(setLayerCfg).catch(console.error);
  }, [isActive, projectId]);

  // Recompute grid whenever project changes
  useEffect(() => {
    if (!project) return;
    const scale = project.format.scaleCustom ?? project.format.scale;
    setGrid(computeSheetGrid(project.format, OVERLAP_IN, project.area.centerLng, project.area.centerLat, scale));
  }, [project]);

  // Auto-render once when everything is ready
  useEffect(() => {
    if (!isActive || !project || !layerCfg || !grid || hasRendered.current) return;
    hasRendered.current = true;
    doRender(project, layerCfg, grid, elements);
  }, [isActive, project, layerCfg, grid]);

  // Keyboard navigation
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setCurrentIdx((i) => Math.min(i + 1, mapImages.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setCurrentIdx((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, mapImages.length]);

  async function doRender(
    proj: ProjectMeta,
    cfg: NationalLayerConfig,
    g: SheetGrid,
    els: PreviewElements,
  ) {
    setRendering(true);
    setRenderErr(null);

    const rasters = collectRasterLayers(proj.layers, cfg);
    if (rasters.length === 0) {
      setRenderErr("No streamable layers are enabled. Enable a basemap in Online mode.");
      setRendering(false);
      return;
    }

    const pixelW = Math.round(g.mapWidthIn  * PREV_DPI);
    const pixelH = Math.round(g.mapHeightIn * PREV_DPI);
    const images: string[] = [];

    try {
      const isMulti = g.totalSheets > 1;

      // The overview spans every sheet at once, so it needs far more tiles
      // than a single cell — scale its timeout to its pixel area instead of
      // reusing the per-cell default, and don't let its failure take the
      // per-sheet renders down with it.
      if (isMulti && els.overviewSheet) {
        const ovW = Math.round(g.mapWidthIn  * g.cols * PREV_DPI);
        const ovH = Math.round(g.mapHeightIn * g.rows * PREV_DPI);
        const areaRatio = (ovW * ovH) / (pixelW * pixelH);
        const overviewTimeoutMs = Math.round(40_000 * Math.max(1, areaRatio));
        try {
          images.push(await renderMapImage({
            bounds: g.totalBounds, pixelW: ovW, pixelH: ovH, rasterLayers: rasters,
            timeoutMs: overviewTimeoutMs,
          }));
        } catch (e) {
          console.error("[doRender] overview sheet failed, continuing without it", e);
        }
      }

      let failedCells = 0;
      for (const cell of g.cells) {
        try {
          images.push(await renderMapImage({ bounds: cell.bounds, pixelW, pixelH, rasterLayers: rasters, timeoutMs: 60_000 }));
        } catch (e) {
          failedCells++;
          console.error(`[doRender] sheet ${cell.ref} failed, continuing`, e);
        }
      }

      setLegend(collectLegend(proj.layers, cfg));
      setMapImages(images);
      setCurrentIdx(0);
      if (failedCells > 0) {
        setRenderErr(`${failedCells} of ${g.cells.length} sheet${g.cells.length === 1 ? "" : "s"} failed to render (tile timeout). Click Refresh to retry.`);
      }
    } catch (e) {
      setRenderErr(String(e));
    } finally {
      setRendering(false);
    }
  }

  function refresh() {
    if (!project || !layerCfg || !grid || rendering) return;
    doRender(project, layerCfg, grid, elements);
  }

  function toggle<K extends keyof PreviewElements>(key: K, value: PreviewElements[K]) {
    setElements((prev) => ({ ...prev, [key]: value }));
  }

  // Determine which sheet/page is being previewed
  const isMulti    = (grid?.totalSheets ?? 1) > 1;
  const hasOverview = isMulti && elements.overviewSheet;
  const sheetOffset = hasOverview ? 1 : 0;
  const isOverview  = hasOverview && currentIdx === 0;

  let currentCell: SheetCell | undefined;
  if (!isOverview && grid) {
    currentCell = grid.cells[currentIdx - sheetOffset];
  }

  const scale = project ? (project.format.scaleCustom ?? project.format.scale) : 24000;
  const decl  = project
    ? getMagneticDeclination(project.area.centerLat, project.area.centerLng, 0, currentDecimalYear())
    : 0;

  if (!project) {
    return <div className="preview-loading" role="status">Loading project…</div>;
  }

  const paper     = effectivePaper(project.format);
  const marginIn  = MARGIN_SIZES[project.format.margins] ?? 0.5;
  const usableH   = paper.h - marginIn * 2;
  const mapH_in   = usableH - (TITLE_H_PT + SCALE_H_PT + DISC_H_PT + DISC_SCALE_GAP_PT) / PT_PER_IN;

  // Band fractions (of total page height)
  const titleFrac  = (TITLE_H_PT / PT_PER_IN) / paper.h;
  const scaleFrac  = (SCALE_H_PT / PT_PER_IN) / paper.h;
  const discFrac   = (DISC_H_PT  / PT_PER_IN) / paper.h;
  const mapFrac    = mapH_in / paper.h;
  const marginFracX = marginIn / paper.w;
  const marginFracY = marginIn / paper.h;
  const usableWFrac = (paper.w - marginIn * 2) / paper.w;

  const totalPages = mapImages.length;

  return (
    <div className="preview-tab">

      {/* ── Sidebar: element checkboxes ─────────────────────────────────── */}
      <aside className="preview-sidebar" aria-label="Map elements">
        <div className="preview-sidebar-header">Map Elements</div>

        {atLeast("intermediate") ? (
          <>
            <ElementGroup label="Cartographic">
              <CheckRow label="Compass rose" checked={elements.compassRose} onChange={(v) => toggle("compassRose", v)} />
              <CheckRow label="Scale bar"    checked={elements.scaleBar}    onChange={(v) => toggle("scaleBar",    v)} />
              <CheckRow label="Ratio scale"  checked={elements.ratioScale}  onChange={(v) => toggle("ratioScale",  v)} />
              <CheckRow label="Legend"       checked={elements.legend}      onChange={(v) => toggle("legend",      v)} />
              <CheckRow label="Neatline"     checked={elements.neatline}    onChange={(v) => toggle("neatline",    v)} />
              <CheckRow label="Title block"  checked={elements.titleBlock}  onChange={(v) => toggle("titleBlock",  v)} />
            </ElementGroup>

            <ElementGroup label="Grid">
              <CheckRow
                label="Grid lines"
                checked={elements.gridLines && elements.gridType !== "none"}
                onChange={(v) => toggle("gridLines", v)}
              />
              {elements.gridLines && (
                <div className="preview-grid-type">
                  <label className="preview-radio">
                    <input
                      type="radio"
                      checked={elements.gridType === "lat-lon"}
                      onChange={() => toggle("gridType", "lat-lon")}
                    /> Lat / Lon
                  </label>
                  <label className="preview-radio">
                    <input
                      type="radio"
                      checked={elements.gridType === "none"}
                      onChange={() => toggle("gridType", "none")}
                    /> None
                  </label>
                </div>
              )}
              <CheckRow
                label="Coordinate labels"
                checked={elements.coordinateLabels}
                disabled={!elements.gridLines || elements.gridType === "none"}
                onChange={(v) => toggle("coordinateLabels", v)}
              />
            </ElementGroup>

            {isMulti && (
              <ElementGroup label="Multi-sheet">
                <CheckRow label="Sheet reference"  checked={elements.sheetReference}   onChange={(v) => toggle("sheetReference",   v)} />
                <CheckRow label="Index inset"      checked={elements.indexInset}       onChange={(v) => toggle("indexInset",       v)} />
                <CheckRow label="Edge match marks" checked={elements.edgeMatchMarkers} onChange={(v) => toggle("edgeMatchMarkers", v)} />
                <CheckRow label="Overview sheet"   checked={elements.overviewSheet}    onChange={(v) => toggle("overviewSheet",    v)} />
              </ElementGroup>
            )}
          </>
        ) : (
          <ElementGroup label="Map elements">
            <p className="preview-beginner-note">
              Compass rose, scale bar, legend, and grid lines are all included by default.
              Switch to Intermediate or Advanced in Settings to customize which ones appear.
            </p>
          </ElementGroup>
        )}

        <ElementGroup label="Required">
          <div className="preview-locked-row">
            <span className="preview-locked-check" aria-hidden="true">✓</span>
            <span className="preview-locked-label">Access disclaimer</span>
            <span className="preview-locked-badge">Required</span>
          </div>
        </ElementGroup>

        <button
          className="preview-refresh-btn"
          onClick={refresh}
          disabled={rendering}
          aria-busy={rendering}
        >
          {rendering ? "Rendering…" : "Refresh Preview"}
        </button>
      </aside>

      {/* ── Main: thumbnail strip + page viewer ─────────────────────────── */}
      <div className="preview-main">

        {/* Thumbnail strip (shown when multi-sheet or when images loaded) */}
        {totalPages > 1 && (
          <div className="preview-thumbstrip" role="list" aria-label="Sheet thumbnails">
            {mapImages.map((img, i) => {
              const isOv  = hasOverview && i === 0;
              const label = isOv ? "Overview" : `Sheet ${grid?.cells[i - sheetOffset]?.ref ?? (i + 1)}`;
              return (
                <button
                  key={i}
                  role="listitem"
                  className={`preview-thumb ${currentIdx === i ? "preview-thumb--active" : ""}`}
                  onClick={() => setCurrentIdx(i)}
                  title={label}
                  aria-current={currentIdx === i ? "true" : undefined}
                >
                  <img src={img} alt={label} className="preview-thumb-img" />
                  <span className="preview-thumb-label">{label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Page viewer */}
        <div className="preview-viewer">
          {rendering && mapImages.length === 0 && (
            <div className="preview-status" role="status" aria-live="polite">
              <div className="preview-spinner" aria-hidden="true" />
              Rendering preview…
            </div>
          )}

          {renderErr && (
            <div className="preview-error" role="alert">
              <strong>Preview failed:</strong> {renderErr}
              <button className="preview-retry-btn" onClick={refresh}>Try again</button>
            </div>
          )}

          {!rendering && !renderErr && mapImages.length === 0 && (
            <div className="preview-status">
              Press <strong>Refresh Preview</strong> to render the map.
            </div>
          )}

          {mapImages[currentIdx] && (
            <PagePreview
              mapImage={mapImages[currentIdx]}
              paper={paper}
              marginIn={marginIn}
              mapFrac={mapFrac}
              titleFrac={titleFrac}
              scaleFrac={scaleFrac}
              discFrac={discFrac}
              marginFracX={marginFracX}
              marginFracY={marginFracY}
              usableWFrac={usableWFrac}
              elements={elements}
              legend={legend}
              scale={scale}
              projectName={project.name}
              cell={currentCell}
              grid={grid ?? undefined}
              isOverview={isOverview}
              declDeg={decl}
              totalPages={totalPages}
              currentPage={currentIdx + 1}
              sheetOffset={sheetOffset}
            />
          )}
        </div>

        {/* Navigation controls */}
        {totalPages > 1 && (
          <div className="preview-nav" aria-label="Sheet navigation">
            <button
              className="preview-nav-btn"
              onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              disabled={currentIdx === 0}
              aria-label="Previous sheet"
            >
              ‹
            </button>
            <span className="preview-nav-label">
              {currentIdx + 1} / {totalPages}
            </span>
            <button
              className="preview-nav-btn"
              onClick={() => setCurrentIdx((i) => Math.min(totalPages - 1, i + 1))}
              disabled={currentIdx === totalPages - 1}
              aria-label="Next sheet"
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
// PagePreview — renders one sheet as HTML with overlays
// ---------------------------------------------------------------------------

interface PagePreviewProps {
  mapImage:      string;
  paper:         { w: number; h: number };
  marginIn:      number;
  mapFrac:       number;
  titleFrac:     number;
  scaleFrac:     number;
  discFrac:      number;
  marginFracX:   number;
  marginFracY:   number;
  usableWFrac:   number;
  elements:      PreviewElements;
  legend:        LegendEntry[];
  scale:         number;
  projectName:   string;
  cell?:         SheetCell;
  grid?:         SheetGrid;
  isOverview:    boolean;
  declDeg:       number;
  totalPages:    number;
  currentPage:   number;
  sheetOffset:   number;
}

function PagePreview(props: PagePreviewProps) {
  const {
    mapImage, paper, marginFracX, marginFracY, usableWFrac,
    mapFrac, titleFrac, scaleFrac, discFrac,
    elements, legend, scale, projectName,
    cell, grid, isOverview, declDeg, totalPages, currentPage,
  } = props;

  // CSS aspect-ratio takes width/height (the inverse of the old padding-top
  // hack, which needed height/width) — see the comment on .page-preview.
  const aspectRatioCss = `${paper.w} / ${paper.h}`;

  // Positions as % of page
  const marginXPct  = marginFracX * 100;
  const marginYPct  = marginFracY * 100;
  const usableWPct  = usableWFrac * 100;

  // Bands from bottom (in % of page height):
  const gapPct         = (DISC_SCALE_GAP_PT / PT_PER_IN / paper.h) * 100;
  const discBottomPct  = marginYPct;
  const discHeightPct  = discFrac  * 100;
  const scaleBottomPct = discBottomPct + discHeightPct + gapPct;
  const scaleHeightPct = scaleFrac  * 100;
  const mapBottomPct   = scaleBottomPct + scaleHeightPct;
  const mapHeightPct   = mapFrac    * 100;
  const titleBottomPct = mapBottomPct + mapHeightPct;
  const titleHeightPct = titleFrac   * 100;

  const sheetRef = cell ? (isOverview ? "Overview" : cell.ref) : "1";
  const pageLabel = `Sheet ${sheetRef} — Page ${currentPage} of ${totalPages}`;

  return (
    <div className="page-preview" style={{ aspectRatio: aspectRatioCss }}>
      <div className="page-preview-inner">

        {/* White page background */}
        <div className="page-bg" />

        {/* ── Map image ───────────────────────────────────── */}
        <img
          className="page-map-image"
          src={mapImage}
          alt="Map preview"
          style={{
            left:   `${marginXPct}%`,
            bottom: `${mapBottomPct}%`,
            width:  `${usableWPct}%`,
            height: `${mapHeightPct}%`,
          }}
        />

        {/* ── Grid overlay ─────────────────────────────────── */}
        {elements.gridLines && elements.gridType !== "none" && (
          <GridOverlay
            left={marginXPct} bottom={mapBottomPct}
            width={usableWPct} height={mapHeightPct}
          />
        )}

        {/* ── Neatline ─────────────────────────────────────── */}
        {elements.neatline && (
          <div
            className="page-neatline"
            style={{
              left:   `${marginXPct}%`,
              bottom: `${mapBottomPct}%`,
              width:  `${usableWPct}%`,
              height: `${mapHeightPct}%`,
            }}
          />
        )}

        {/* ── Compass rose (top-right corner of map) ────────── */}
        {elements.compassRose && (
          <CompassRoseSvg
            right={`${marginXPct + 0.5}%`}
            // titleBottomPct is already the map's top edge, measured from the
            // page bottom (= mapBottomPct + mapHeightPct); CSS `top` measures
            // from the page top, so 100 - titleBottomPct is the correct
            // conversion. The previous formula subtracted titleHeightPct and
            // a second mapHeightPct on top of that — both spurious — which
            // pushed the rose well above the map, and off the page entirely
            // in single-sheet layouts where the title band alone is a large
            // fraction of page height.
            top={`${100 - titleBottomPct + 0.5}%`}
            declDeg={declDeg}
          />
        )}

        {/* ── Overview grid overlay ─────────────────────────── */}
        {isOverview && grid && (
          <OverviewGridOverlay
            grid={grid}
            left={marginXPct} bottom={mapBottomPct}
            width={usableWPct} height={mapHeightPct}
          />
        )}

        {/* ── Edge match markers ────────────────────────────── */}
        {elements.edgeMatchMarkers && cell && !isOverview && (
          <>
            {cell.north && <div className="page-edgematch page-edgematch--north">↑ Sheet {cell.north}</div>}
            {cell.south && <div className="page-edgematch page-edgematch--south">↓ Sheet {cell.south}</div>}
            {cell.west  && <div className="page-edgematch page-edgematch--west" >← Sheet {cell.west}</div>}
            {cell.east  && <div className="page-edgematch page-edgematch--east" >→ Sheet {cell.east}</div>}
          </>
        )}

        {/* ── Title block band ─────────────────────────────── */}
        {elements.titleBlock && (
          <div
            className="page-title-block"
            style={{
              left:   `${marginXPct}%`,
              bottom: `${titleBottomPct}%`,
              width:  `${usableWPct}%`,
              height: `${titleHeightPct}%`,
            }}
          >
            <span className="page-title-name">{projectName}</span>
            {elements.sheetReference && (
              <span className="page-title-ref">{pageLabel}</span>
            )}
          </div>
        )}

        {/* ── Scale / legend band ───────────────────────────── */}
        <div
          className="page-scale-band"
          style={{
            left:   `${marginXPct}%`,
            bottom: `${scaleBottomPct}%`,
            width:  `${usableWPct}%`,
            height: `${scaleHeightPct}%`,
          }}
        >
          {elements.scaleBar && <ScaleBarEl scale={scale} />}
          {elements.ratioScale && (
            <span className="page-ratio-scale">1:{scale.toLocaleString()}</span>
          )}
          {elements.legend && legend.length > 0 && (
            <LegendEl entries={legend} />
          )}
          {elements.indexInset && grid && cell && !isOverview && (
            <IndexInsetEl grid={grid} cell={cell} />
          )}
        </div>

        {/* ── Disclaimer band (always shown, locked) ────────── */}
        <div
          className="page-disclaimer"
          style={{
            left:   `${marginXPct}%`,
            bottom: `${discBottomPct}%`,
            width:  `${usableWPct}%`,
            height: `${discHeightPct}%`,
          }}
        >
          <span className="page-disclaimer-warn">WARNING: </span>
          Land access shown is approximate and derived from public datasets. It is for planning only
          and is not legal authority. Verify current regulations and closures before hunting.
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function GridOverlay({ left, bottom, width, height }: { left: number; bottom: number; width: number; height: number }) {
  // `bottom`/`height` come in as CSS bottom-relative percentages (distance up
  // from the page's bottom edge — the same convention the map <img> itself
  // uses). This SVG's viewBox is top-origin (Y=0 at the top), so any Y value
  // needs `100 - ...` to convert. The horizontal lines' *position* already
  // did this correctly; the vertical lines' *extent* didn't, which drew them
  // from y=bottom to y=bottom+height directly — the correct span, but shifted
  // down by `2*bottom + height - 100`. For a typical single-sheet layout
  // that's ~15-20 percentage points: enough to miss the top of the map
  // entirely and run on past its bottom edge into the scale/disclaimer bands.
  const svgTop    = 100 - bottom - height;
  const svgBottom = 100 - bottom;
  const lines: React.ReactNode[] = [];
  const N = 4; // number of intervals
  for (let i = 1; i < N; i++) {
    const xPct = left + (i / N) * width;
    const yPct = bottom + (i / N) * height;
    lines.push(
      <line
        key={`v${i}`}
        x1={`${xPct}%`} y1={`${svgTop}%`}
        x2={`${xPct}%`} y2={`${svgBottom}%`}
        stroke="#666" strokeWidth="0.3%" strokeDasharray="1%,1%"
      />,
      <line
        key={`h${i}`}
        x1={`${left}%`} y1={`${100 - yPct}%`}
        x2={`${left + width}%`} y2={`${100 - yPct}%`}
        stroke="#666" strokeWidth="0.3%" strokeDasharray="1%,1%"
      />,
    );
  }
  return (
    <svg className="page-grid-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
      {lines}
    </svg>
  );
}

function OverviewGridOverlay({ grid, left, bottom, width, height }: {
  grid: SheetGrid; left: number; bottom: number; width: number; height: number;
}) {
  const { rows, cols, cells } = grid;
  const cellW = width / cols;
  const cellH = height / rows;

  return (
    <svg className="page-grid-overlay page-grid-overlay--overview" viewBox="0 0 100 100" preserveAspectRatio="none">
      {/* Division lines */}
      {Array.from({ length: cols - 1 }, (_, c) => {
        const x = left + (c + 1) * cellW;
        return (
          <line
            key={`v${c}`}
            x1={`${x}%`} y1={`${100 - bottom - height}%`}
            x2={`${x}%`} y2={`${100 - bottom}%`}
            stroke="#333" strokeWidth="0.4%"
          />
        );
      })}
      {Array.from({ length: rows - 1 }, (_, r) => {
        const y = bottom + (r + 1) * cellH;
        return (
          <line
            key={`h${r}`}
            x1={`${left}%`}          y1={`${100 - y}%`}
            x2={`${left + width}%`}  y2={`${100 - y}%`}
            stroke="#333" strokeWidth="0.4%"
          />
        );
      })}
      {/* Cell labels */}
      {cells.map((cell) => {
        const cx = left + (cell.col + 0.5) * cellW;
        const cy = 100 - bottom - (rows - cell.row - 0.5) * cellH;
        return (
          <text
            key={cell.ref}
            x={`${cx}%`} y={`${cy}%`}
            textAnchor="middle" dominantBaseline="middle"
            fontSize="2.5%" fontWeight="bold" fill="#111"
            stroke="white" strokeWidth="0.4%" paintOrder="stroke"
          >
            {cell.ref}
          </text>
        );
      })}
    </svg>
  );
}

function CompassRoseSvg({ right, top, declDeg }: { right: string; top: string; declDeg: number }) {
  const mAngle = declDeg; // degrees clockwise from north = degrees east
  return (
    <div className="page-compass" style={{ right, top }}>
      <svg viewBox="-12 -12 24 24" xmlns="http://www.w3.org/2000/svg">
        {/* Circle */}
        <circle r="11" fill="white" stroke="#ccc" strokeWidth="0.4" />
        {/* True north arrow */}
        <polygon points="0,-9 -2.5,0 0,-1 2.5,0" fill="#222" />
        <polygon points="0,9 -2.5,0 0,1 2.5,0"  fill="#ccc" />
        {/* Magnetic north dashed line */}
        <line
          x1="0" y1="0"
          x2={`${Math.sin(mAngle * Math.PI / 180) * 7}`}
          y2={`${-Math.cos(mAngle * Math.PI / 180) * 7}`}
          stroke="#1a3d7a" strokeWidth="0.6" strokeDasharray="1.5,1"
        />
        {/* Labels */}
        <text x="0" y="-9.5" textAnchor="middle" fontSize="3.5" fontWeight="bold" fill="#111">N</text>
        <text x="0" y="11"   textAnchor="middle" fontSize="2.5" fill="#555">{declDeg >= 0 ? `${Math.abs(declDeg).toFixed(1)}°E` : `${Math.abs(declDeg).toFixed(1)}°W`}</text>
      </svg>
    </div>
  );
}

// Matches the "always land on a fixed segment count with a nice round
// per-segment distance" fix in cartography.ts's drawScaleBar — the previous
// `Math.max(1, Math.round(...))` collapsed to a single segment at ordinary
// topo scales (1:24,000 already puts ~1 mile inside the target width), which
// is the "just one black box" symptom.
const SCALE_BAR_SEGMENTS = 4;
const SCALE_BAR_NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function niceScaleUnit(target: number): number {
  let best = SCALE_BAR_NICE_STEPS[0];
  for (const step of SCALE_BAR_NICE_STEPS) {
    if (step <= target) best = step; else break;
  }
  return best;
}

function formatUnitLabel(value: number): string {
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function ScaleBarEl({ scale }: { scale: number }) {
  const PT_PER_IN = 72;
  const ptsPerMile = PT_PER_IN * 63360 / scale;
  // Same 80pt target the old single-segment version used — this element is a
  // compact on-screen indicator, not a geometrically precise ruler, so it
  // doesn't need to track the page's actual rendered pixel size.
  const mileUnit = niceScaleUnit(80 / ptsPerMile / SCALE_BAR_SEGMENTS);
  const totalMiles = mileUnit * SCALE_BAR_SEGMENTS;
  return (
    <div className="page-scalebar">
      {Array.from({ length: SCALE_BAR_SEGMENTS }, (_, i) => (
        <div key={i} className={`page-scalebar-seg ${i % 2 === 0 ? "page-scalebar-seg--dark" : "page-scalebar-seg--light"}`} />
      ))}
      <span className="page-scalebar-unit">{formatUnitLabel(totalMiles)} mi</span>
    </div>
  );
}

function LegendEl({ entries }: { entries: LegendEntry[] }) {
  return (
    <div className="page-legend">
      <div className="page-legend-title">Legend</div>
      {entries.slice(0, 6).map((e, i) => (
        <div key={i} className="page-legend-row">
          <span
            className="page-legend-swatch"
            style={{ background: e.color, borderStyle: e.dash ? "dashed" : "solid" }}
          />
          <span className="page-legend-name">{e.label}</span>
        </div>
      ))}
    </div>
  );
}

function IndexInsetEl({ grid, cell }: { grid: SheetGrid; cell: SheetCell }) {
  const { rows, cols, cells } = grid;
  return (
    <div className="page-index" style={{ width: `${Math.max(24, cols * 10)}px`, height: `${Math.max(24, rows * 10)}px` }}>
      {cells.map((c) => {
        const isThis = c.row === cell.row && c.col === cell.col;
        return (
          <div
            key={c.ref}
            className={`page-index-cell ${isThis ? "page-index-cell--active" : ""}`}
            style={{
              gridColumn: c.col + 1,
              gridRow:    c.row + 1,
            }}
            title={c.ref}
          />
        );
      })}
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
  const id = `prev-el-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <label className={`preview-check-row ${disabled ? "preview-check-row--disabled" : ""}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="preview-checkbox"
      />
      <span className="preview-check-label">{label}</span>
    </label>
  );
}
