/**
 * Page planning shared by the Preview tab and the PDF exporter: which pages a
 * project produces, the geographic extent and pixel size of each page's map
 * raster, and the MapPageSpec used to draw it. Keeping this in one place is
 * what guarantees the preview shows exactly what will export.
 */

import type { ProjectMeta } from "../types/project";
import type { NationalLayerConfig } from "../types/layers";
import type { MapElements } from "../types/elements";
import { normalizeElements } from "../types/elements";
import type { Bounds } from "./geo";
import { DEG_PER_M_LAT, degPerMLng } from "./geo";
import type { RasterLayer } from "./renderMapImage";
import type { LegendEntry, MapPageSpec } from "./cartography";
import type { PageLayout } from "./pageLayout";
import { computePageLayout } from "./pageLayout";
import type { SheetCell, SheetGrid } from "./sheetGrid";
import { computeSheetGrid, DEFAULT_OVERLAP_IN } from "./sheetGrid";
import { getMagneticDeclination, currentDecimalYear, declinationEpochLabel } from "./wmm";

export interface PageJob {
  kind: "single" | "sheet" | "overview";
  layout: PageLayout;
  bounds: Bounds;
  cell?: SheetCell;
  pageLabel: string;
}

export interface MapPlan {
  scale: number;
  elements: MapElements;
  grid: SheetGrid;
  isMulti: boolean;
  layout: PageLayout;
  pages: PageJob[];
}

export function projectScale(project: ProjectMeta): number {
  return project.format.scaleCustom ?? project.format.scale;
}

/** The ground extent that actually prints (all sheets, outer edges). */
export function printedBounds(project: ProjectMeta, elements?: MapElements): Bounds {
  const el = elements ?? normalizeElements(project.elements);
  return computeSheetGrid(
    project.format, DEFAULT_OVERLAP_IN,
    project.area.centerLng, project.area.centerLat,
    projectScale(project), el,
  ).totalBounds;
}

export function planPages(project: ProjectMeta, elements?: MapElements): MapPlan {
  const el    = elements ?? normalizeElements(project.elements);
  const scale = projectScale(project);
  const grid  = computeSheetGrid(
    project.format, DEFAULT_OVERLAP_IN,
    project.area.centerLng, project.area.centerLat, scale, el,
  );
  const isMulti = grid.totalSheets > 1;
  const layout  = computePageLayout(project.format, el, isMulti);
  const pages: PageJob[] = [];

  if (!isMulti) {
    pages.push({ kind: "single", layout, bounds: grid.cells[0].bounds, pageLabel: "Sheet 1 of 1" });
  } else {
    const withOverview = el.overviewSheet;
    const total = grid.totalSheets + (withOverview ? 1 : 0);
    if (withOverview) {
      pages.push({
        kind: "overview",
        layout: overviewLayout(layout, grid.totalBounds),
        bounds: grid.totalBounds,
        pageLabel: `Overview — Page 1 of ${total}`,
      });
    }
    grid.cells.forEach((cell, i) => {
      const page = i + 1 + (withOverview ? 1 : 0);
      pages.push({
        kind: "sheet", layout, bounds: cell.bounds, cell,
        pageLabel: `Sheet ${cell.ref} — Page ${page} of ${total}`,
      });
    });
  }

  return { scale, elements: el, grid, isMulti, layout, pages };
}

/**
 * The overview shows the whole tiled area on one page. Its ground aspect
 * rarely matches a single sheet's map box (a 2×1 layout is twice as wide), so
 * fit it inside the box instead of stretching it — the old exporter drew a
 * 2×1 overview squashed to half its true width.
 */
function overviewLayout(base: PageLayout, b: Bounds): PageLayout {
  const midLat = (b.south + b.north) / 2;
  const groundW = (b.east - b.west) / degPerMLng(midLat);
  const groundH = (b.north - b.south) / DEG_PER_M_LAT;
  const aspect = groundW / groundH;
  const m = base.map;
  let w = m.w, h = m.w / aspect;
  if (h > m.h) { h = m.h; w = m.h * aspect; }
  const map = { x: m.x + (m.w - w) / 2, y: m.y + (m.h - h) / 2, w, h };
  return { ...base, map, mapWidthIn: w / 72, mapHeightIn: h / 72 };
}

export function pagePixelSize(job: PageJob, dpi: number): { pixelW: number; pixelH: number } {
  return {
    pixelW: Math.max(1, Math.round(job.layout.mapWidthIn * dpi)),
    pixelH: Math.max(1, Math.round(job.layout.mapHeightIn * dpi)),
  };
}

export function collectRasterLayers(layers: ProjectMeta["layers"], cfg: NationalLayerConfig): RasterLayer[] {
  const out: RasterLayer[] = [];
  for (const group of cfg.groups) {
    const base = group.layers.find(
      (l) => l.id === layers.activeBasemap && l.sourceType === "xyz" && l.tiles,
    );
    if (base) { out.push({ id: base.id, tiles: base.tiles!, tileSize: base.tileSize }); break; }
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

export function collectLegend(layers: ProjectMeta["layers"], cfg: NationalLayerConfig): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const group of cfg.groups) {
    for (const layer of group.layers) {
      if (layer.id === layers.activeBasemap) {
        out.push({ label: layer.name, color: "#888888" });
      } else if (layers.enabledLayers.includes(layer.id)) {
        const color = layer.style?.fillColor ?? layer.style?.strokeColor ?? "#666666";
        out.push({ label: layer.name, color, dash: layer.renderType === "line" });
      }
    }
  }
  return out;
}

export function projectSubtitle(project: ProjectMeta): string {
  return [project.state, ...(project.counties ?? [])].filter(Boolean).join(" · ") || "Hunting Map";
}

export function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export interface SpecContext {
  project: ProjectMeta;
  plan: MapPlan;
  legend: LegendEntry[];
}

export function pageSpec(job: PageJob, imageId: string, ctx: SpecContext): MapPageSpec {
  const { project, plan } = ctx;
  const year = currentDecimalYear();
  const cLat = (job.bounds.north + job.bounds.south) / 2;
  const cLng = (job.bounds.east + job.bounds.west) / 2;
  return {
    kind: job.kind,
    layout: job.layout,
    elements: plan.elements,
    imageId,
    bounds: job.bounds,
    title: project.name,
    subtitle: projectSubtitle(project),
    scale: plan.scale,
    dateStr: todayStr(),
    pageLabel: job.pageLabel,
    declDeg: getMagneticDeclination(cLat, cLng, 0, year),
    declEpoch: declinationEpochLabel(year),
    legend: ctx.legend,
    grid: plan.isMulti ? plan.grid : undefined,
    cell: job.cell,
  };
}
