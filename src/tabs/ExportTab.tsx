import { useEffect, useRef, useState } from "react";
// @tauri-apps/plugin-dialog is only available in the Tauri build; the Swift
// build routes through the pick_folder IPC command instead (see pickFolder()).

import { invoke } from "../lib/ipc";
import { useExperience } from "../theme/ExperienceContext";
import { mapAreaBounds } from "../lib/geo";
import { renderMapImage } from "../lib/renderMapImage";
import { buildCartographicPdf, buildMultiSheetPdf } from "../lib/exportPdf";
import { getSheetDimensions, computeSheetGrid } from "../lib/sheetGrid";
import type { LegendEntry } from "../lib/cartography";
import type { FormatSettings } from "../types/format";
import { effectivePaper, MARGIN_SIZES } from "../types/format";
import type { NationalLayerConfig } from "../types/layers";
import type { ProjectMeta } from "../types/project";
import "./ExportTab.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutputMode = "single" | "per-sheet";

interface ExportHistoryEntry {
  id: string;
  filename: string;
  path: string;
  date: string;
  dpi: number;
  pages: number;
  fileSizeBytes: number;
  outputFolder: string;
}

type ExportStatus =
  | { kind: "idle" }
  | { kind: "rendering"; detail?: string; current?: number; total?: number }
  | { kind: "composing" }
  | { kind: "saving" }
  | { kind: "done"; path: string; folder: string; count: number }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PT_PER_IN   = 72;
const TITLE_H_PT  = 42;
const SCALE_H_PT  = 54;
const DISC_H_PT   = 44;
const DISC_SCALE_GAP_PT = 10; // must match exportPdf.ts DISC_SCALE_GAP_PT
const OVERLAP_IN  = 0.5;

const DPI_MIN = 72;
const DPI_MAX = 600;
const DPI_PRESETS = [150, 200, 300, 400];

function nearestDpiPreset(v: number): number {
  return DPI_PRESETS.reduce((best, p) => Math.abs(p - v) < Math.abs(best - v) ? p : best);
}

function dpiDescription(v: number): string {
  if (v <= 150) return "Fast, smallest file";
  if (v <= 200) return "Balanced";
  if (v <= 300) return "High quality, slower";
  return "Maximum quality, slowest";
}

function resolveFilename(pattern: string, projectName: string, scale: number, sheet?: string): string {
  const date    = new Date().toISOString().slice(0, 10);
  const safePrj = projectName
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40) || "map";
  let s = pattern
    .replace(/\{project\}/g, safePrj)
    .replace(/\{date\}/g,    date)
    .replace(/\{scale\}/g,   String(scale));
  if (sheet) s = s.replace(/\{sheet\}/g, sheet);
  else       s = s.replace(/\{sheet\}/g, "");
  s = s
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/, "");
  return s + ".pdf";
}

function parseDpi(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!isFinite(n)) return 150;
  return Math.min(DPI_MAX, Math.max(DPI_MIN, n));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function formatBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

function formatDateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatScaleLabel(scale: number): string {
  return `1:${scale.toLocaleString()}`;
}

function formatPaperLabel(project: ProjectMeta): string {
  const fmt = project.format;
  const p = effectivePaper(fmt);
  return `${fmt.paperSize.charAt(0).toUpperCase() + fmt.paperSize.slice(1)} — ${p.w}" × ${p.h}" ${fmt.orientation}`;
}

// ---------------------------------------------------------------------------
// ExportTab
// ---------------------------------------------------------------------------

export function ExportTab({ projectId, isActive }: Props) {
  const { atLeast } = useExperience();
  const [project,      setProject]     = useState<ProjectMeta | null>(null);
  const [layerCfg,     setLayerCfg]    = useState<NationalLayerConfig | null>(null);
  const [dpi,          setDpi]         = useState<number>(150);
  const [dpiLocked,    setDpiLocked]   = useState(true);
  const [outputMode,   setOutputMode]  = useState<OutputMode>("single");
  const [outputFolder, setOutputFolder] = useState<string>("");
  const [pattern,      setPattern]     = useState("{project}_{date}_1-{scale}");
  const [autoOpen,     setAutoOpen]    = useState(false);
  const [history,      setHistory]     = useState<ExportHistoryEntry[]>([]);
  const [status,       setStatus]      = useState<ExportStatus>({ kind: "idle" });

  const abortRef = useRef(false);
  const isBusy   = status.kind === "rendering" || status.kind === "composing" || status.kind === "saving";

  // Load project, settings and history on first activation
  useEffect(() => {
    if (!isActive) return;

    invoke<ProjectMeta>("get_project", { id: projectId })
      .then(setProject)
      .catch(console.error);

    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        setDpi(parseDpi(s["export_dpi"]));
        setDpiLocked(s["export_dpi_locked"] !== "false");
        setOutputMode(s["export_output_mode"] === "per-sheet" ? "per-sheet" : "single");
        setOutputFolder(s["export_folder"] ?? "");
        setPattern(s["export_filename_pattern"] ?? "{project}_{date}_1-{scale}");
        setAutoOpen(s["export_auto_open"] === "true");
      })
      .catch(console.error);

    fetch("/regions/_national.json")
      .then((r) => r.json() as Promise<NationalLayerConfig>)
      .then(setLayerCfg)
      .catch(console.error);

    invoke<ExportHistoryEntry[]>("get_export_history", { projectId })
      .then(setHistory)
      .catch(() => {});
  }, [isActive, projectId]);

  // Persist a single setting
  async function saveSetting(key: string, value: string) {
    invoke("set_setting", { key, value }).catch(console.error);
  }

  // Folder picker — uses Tauri dialog plugin in the Tauri build, or the
  // pick_folder IPC command in the Swift/WKWebView build.
  async function pickFolder() {
    let result: string | null = null;
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const r = await open({ directory: true, multiple: false, title: "Choose export output folder" });
        result = typeof r === "string" ? r : null;
      } else {
        result = await invoke<string | null>("pick_folder", { title: "Choose export output folder" });
      }
    } catch {
      result = null;
    }
    if (result) {
      setOutputFolder(result);
      saveSetting("export_folder", result);
    }
  }

  function clearFolder() {
    setOutputFolder("");
    saveSetting("export_folder", "");
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async function handleExport() {
    if (!project || !layerCfg || isBusy) return;

    abortRef.current = false;
    setStatus({ kind: "rendering" });

    try {
      const fmt   = project.format;
      const area  = project.area;
      const scale = fmt.scaleCustom ?? fmt.scale;

      // ── Collect raster layers ──────────────────────────────────────────────
      const rasterLayers: Array<{ id: string; tiles: string[]; tileSize?: number; opacity?: number }> = [];

      for (const group of layerCfg.groups) {
        for (const layer of group.layers) {
          if (layer.id === project.layers.activeBasemap && layer.sourceType === "xyz" && layer.tiles) {
            rasterLayers.push({ id: layer.id, tiles: layer.tiles, tileSize: layer.tileSize });
            break;
          }
        }
      }
      for (const group of layerCfg.groups) {
        for (const layer of group.layers) {
          if (
            layer.id !== project.layers.activeBasemap &&
            project.layers.enabledLayers.includes(layer.id) &&
            layer.sourceType === "xyz" &&
            layer.renderType === "raster" &&
            layer.tiles
          ) {
            const opacity = project.layers.layerOpacities[layer.id] ?? layer.defaultOpacity;
            rasterLayers.push({ id: layer.id, tiles: layer.tiles, tileSize: layer.tileSize, opacity });
          }
        }
      }

      if (rasterLayers.length === 0) {
        setStatus({ kind: "error", message: "No streamable layers are enabled. Enable at least the basemap and switch to Online mode." });
        return;
      }

      // ── Shared legend entries ──────────────────────────────────────────────
      const legendEntries: LegendEntry[] = [];
      for (const group of layerCfg.groups) {
        for (const layer of group.layers) {
          if (layer.id === project.layers.activeBasemap) {
            legendEntries.push({ label: layer.name, color: "#888888" });
          } else if (project.layers.enabledLayers.includes(layer.id)) {
            const color = layer.style?.fillColor ?? layer.style?.strokeColor ?? "#666666";
            legendEntries.push({ label: layer.name, color, dash: layer.renderType === "line" });
          }
        }
      }

      const subtitle  = [project.state, ...(project.counties ?? [])].filter(Boolean).join(" · ") || "Hunting Map";
      const paper     = effectivePaper(fmt);
      const marginIn  = MARGIN_SIZES[fmt.margins] ?? 0.5;
      const usableW_in = paper.w - marginIn * 2;
      const usableH_in = paper.h - marginIn * 2;
      const mapH_in    = usableH_in - (TITLE_H_PT + SCALE_H_PT + DISC_H_PT + DISC_SCALE_GAP_PT) / PT_PER_IN;

      const sheetDims  = getSheetDimensions(fmt);
      const isMulti    = sheetDims.across > 1 || sheetDims.down > 1;
      const folder     = outputFolder || null;

      // ── Branch: per-sheet vs single PDF ───────────────────────────────────
      if (isMulti && outputMode === "per-sheet") {
        await exportPerSheet({
          fmt, scale, area, project, subtitle,
          rasterLayers, legendEntries, folder,
          usableW_in, mapH_in,
        });
      } else if (isMulti) {
        await exportMultiSheet({
          fmt, scale, area, project, subtitle,
          rasterLayers, legendEntries, folder,
          usableW_in, mapH_in,
        });
      } else {
        await exportSingleSheet({
          fmt, scale, area, project, subtitle,
          rasterLayers, legendEntries, folder,
          usableW_in, mapH_in,
        });
      }
    } catch (err) {
      if (!abortRef.current) {
        setStatus({ kind: "error", message: String(err) });
      }
    }
  }

  // ── Single-sheet ────────────────────────────────────────────────────────────
  async function exportSingleSheet({ fmt, scale, area, project, subtitle, rasterLayers, legendEntries, folder, usableW_in, mapH_in }: ExportShared) {
    const pixelW  = Math.round(usableW_in * dpi);
    const pixelH  = Math.round(mapH_in    * dpi);
    const bounds  = mapAreaBounds(area.centerLng, area.centerLat, usableW_in, mapH_in, scale);

    setStatus({ kind: "rendering", detail: "Rendering map tiles…", current: 0, total: 1 });
    const mapJpegUrl = await renderMapImage({ bounds, pixelW, pixelH, rasterLayers });
    if (abortRef.current) return;

    setStatus({ kind: "composing" });
    const pdfBytes = await buildCartographicPdf({
      mapJpegUrl, fmt, scale,
      projectName: project.name, subtitle,
      centerLng: area.centerLng,
      centerLat: area.centerLat,
      bounds, legendEntries,
    });
    if (abortRef.current) return;

    setStatus({ kind: "saving" });
    const filename = resolveFilename(pattern, project.name, scale);
    const path     = await invoke<string>("save_export", {
      projectId,
      filename,
      dataBase64:    uint8ToBase64(pdfBytes),
      outputFolder:  folder,
      dpi,
      pages:         1,
    });

    await refreshHistory();
    if (autoOpen) invoke("reveal_in_finder", { path }).catch(() => {});
    const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    setStatus({ kind: "done", path, folder: folderPath, count: 1 });
  }

  // ── Multi-sheet (single PDF) ─────────────────────────────────────────────────
  async function exportMultiSheet({ fmt, scale, area, project, subtitle, rasterLayers, legendEntries, folder }: ExportShared) {
    const grid = computeSheetGrid(fmt, OVERLAP_IN, area.centerLng, area.centerLat, scale);

    const pdfBytes = await buildMultiSheetPdf({
      fmt, scale,
      projectName: project.name, subtitle,
      centerLng: area.centerLng,
      centerLat: area.centerLat,
      legendEntries, rasterLayers,
      dpi,
      onProgress: (detail, current, total) => {
        if (!abortRef.current) setStatus({ kind: "rendering", detail, current, total });
      },
    });
    if (abortRef.current) return;

    setStatus({ kind: "saving" });
    const filename = resolveFilename(pattern, project.name, scale);
    const path     = await invoke<string>("save_export", {
      projectId,
      filename,
      dataBase64:   uint8ToBase64(pdfBytes),
      outputFolder: folder,
      dpi,
      pages:        1 + grid.totalSheets, // overview + sheets
    });

    await refreshHistory();
    if (autoOpen) invoke("reveal_in_finder", { path }).catch(() => {});
    const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    setStatus({ kind: "done", path, folder: folderPath, count: 1 });
  }

  // ── Per-sheet (separate PDFs) ────────────────────────────────────────────────
  async function exportPerSheet({ fmt, scale, area, project, subtitle, rasterLayers, legendEntries, folder }: ExportShared) {
    const grid   = computeSheetGrid(fmt, OVERLAP_IN, area.centerLng, area.centerLat, scale);
    const pixelW = Math.round(grid.mapWidthIn  * dpi);
    const pixelH = Math.round(grid.mapHeightIn * dpi);
    let lastPath = "";

    for (let i = 0; i < grid.cells.length; i++) {
      if (abortRef.current) return;
      const cell   = grid.cells[i];
      const detail = `Sheet ${cell.ref} (${i + 1}/${grid.totalSheets})`;
      setStatus({ kind: "rendering", detail, current: i, total: grid.totalSheets });

      const mapJpegUrl = await renderMapImage({
        bounds: cell.bounds, pixelW, pixelH, rasterLayers,
      });
      if (abortRef.current) return;

      setStatus({ kind: "composing" });
      const cellSubtitle = grid.totalSheets > 1
        ? `Sheet ${cell.ref} — ${subtitle}`
        : subtitle;
      const pdfBytes = await buildCartographicPdf({
        mapJpegUrl, fmt, scale,
        projectName: project.name,
        subtitle:    cellSubtitle,
        centerLng:   (cell.bounds.east + cell.bounds.west) / 2,
        centerLat:   (cell.bounds.north + cell.bounds.south) / 2,
        bounds:      cell.bounds,
        legendEntries,
      });
      if (abortRef.current) return;

      setStatus({ kind: "saving" });
      const filename = resolveFilename(pattern, project.name, scale, cell.ref);
      lastPath = await invoke<string>("save_export", {
        projectId,
        filename,
        dataBase64:   uint8ToBase64(pdfBytes),
        outputFolder: folder,
        dpi,
        pages:        1,
      });
    }

    await refreshHistory();
    const folderPath = lastPath.includes("/") ? lastPath.slice(0, lastPath.lastIndexOf("/")) : outputFolder;
    if (autoOpen && folderPath) invoke("reveal_in_finder", { path: folderPath }).catch(() => {});
    setStatus({ kind: "done", path: lastPath, folder: folderPath, count: grid.cells.length });
  }

  async function refreshHistory() {
    invoke<ExportHistoryEntry[]>("get_export_history", { projectId })
      .then(setHistory)
      .catch(() => {});
  }

  function handleReveal(path: string) {
    invoke("reveal_in_finder", { path }).catch(console.error);
  }

  function reset() {
    abortRef.current = true;
    setStatus({ kind: "idle" });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!project) {
    return <div className="export-loading" role="status">Loading project…</div>;
  }

  const fmt          = project.format;
  const scale        = fmt.scaleCustom ?? fmt.scale;
  const marginIn     = MARGIN_SIZES[fmt.margins] ?? 0.5;
  const sheetDims    = getSheetDimensions(fmt);
  const isMulti      = sheetDims.across > 1 || sheetDims.down > 1;
  const totalSheets  = sheetDims.across * sheetDims.down;

  // Filename preview
  const previewSheet = outputMode === "per-sheet" && isMulti ? "A1" : undefined;
  const filenamePreview = resolveFilename(pattern, project.name, scale, previewSheet);

  return (
    <div className="export-tab">
      <div className="export-inner">

        {/* ── Export options ───────────────────────────────────────────────── */}
        <section className="export-section" aria-label="Export options">
          <h2 className="export-section-title">Export Options</h2>

          {/* DPI */}
          <div className="export-field">
            <div className="export-dpi-header">
              <label className="export-field-label" htmlFor="export-dpi-slider">Render quality (DPI)</label>
              {atLeast("advanced") && (
                <label className="export-dpi-lock">
                  <input
                    type="checkbox"
                    checked={dpiLocked}
                    disabled={isBusy}
                    onChange={(e) => {
                      const locked = e.target.checked;
                      setDpiLocked(locked);
                      saveSetting("export_dpi_locked", String(locked));
                      if (locked) {
                        const snapped = nearestDpiPreset(dpi);
                        setDpi(snapped);
                        saveSetting("export_dpi", String(snapped));
                      }
                    }}
                  />
                  Lock to standard values
                </label>
              )}
            </div>

            {/* Below Advanced, custom values aren't offered at all — the slider
                always snaps to the standard presets regardless of the saved
                dpiLocked preference. */}
            <input
              id="export-dpi-slider"
              className="export-dpi-slider"
              type="range"
              min={DPI_MIN}
              max={DPI_MAX}
              step={1}
              value={dpi}
              disabled={isBusy}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10);
                const v = (dpiLocked || !atLeast("advanced")) ? nearestDpiPreset(raw) : raw;
                setDpi(v);
                saveSetting("export_dpi", String(v));
              }}
              aria-describedby="export-dpi-readout"
            />

            <div className="export-dpi-ticks" aria-hidden="true">
              {DPI_PRESETS.map((v) => (
                <span
                  key={v}
                  className={`export-dpi-tick${dpi === v ? " export-dpi-tick--active" : ""}`}
                  style={{ left: `${((v - DPI_MIN) / (DPI_MAX - DPI_MIN)) * 100}%` }}
                >
                  {v}
                </span>
              ))}
            </div>

            <div id="export-dpi-readout" className="export-dpi-readout">
              <strong>{dpi} DPI</strong> — {dpiDescription(dpi)}
            </div>
          </div>

          {/* Output mode */}
          {atLeast("intermediate") && (
            <div className="export-field">
              <label className="export-field-label">
                Output mode
                {!isMulti && <span className="export-field-note"> (single-sheet layout)</span>}
              </label>
              <div className="export-mode-row">
                {(["single", "per-sheet"] as OutputMode[]).map((m) => (
                  <label
                    key={m}
                    className={`export-mode-opt ${!isMulti ? "export-mode-opt--disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="output-mode"
                      value={m}
                      checked={outputMode === m}
                      disabled={!isMulti || isBusy}
                      onChange={() => {
                        setOutputMode(m);
                        saveSetting("export_output_mode", m);
                      }}
                    />
                    {m === "single" ? "Single PDF (all sheets)" : "One PDF per sheet"}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Output folder */}
          <div className="export-field">
            <label className="export-field-label">Output folder</label>
            <div className="export-folder-row">
              <span className="export-folder-path" title={outputFolder}>
                {outputFolder || <em className="export-folder-default">Default (project exports folder)</em>}
              </span>
              <button
                className="export-folder-btn"
                onClick={pickFolder}
                disabled={isBusy}
              >
                Browse…
              </button>
              {outputFolder && (
                <button
                  className="export-folder-clear"
                  onClick={clearFolder}
                  disabled={isBusy}
                  title="Reset to default"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Filename pattern */}
          {atLeast("intermediate") ? (
            <div className="export-field">
              <label className="export-field-label" htmlFor="export-pattern">Filename pattern</label>
              <input
                id="export-pattern"
                className="export-pattern-input"
                type="text"
                value={pattern}
                disabled={isBusy}
                onChange={(e) => setPattern(e.target.value)}
                onBlur={() => saveSetting("export_filename_pattern", pattern)}
                spellCheck={false}
              />
              <div className="export-token-row">
                {["{project}", "{date}", "{scale}"].concat(isMulti && outputMode === "per-sheet" ? ["{sheet}"] : []).map((tok) => (
                  <button
                    key={tok}
                    className="export-token-btn"
                    onClick={() => setPattern((p) => p + tok)}
                    disabled={isBusy}
                  >
                    {tok}
                  </button>
                ))}
              </div>
              <div className="export-pattern-preview">
                <span className="export-pattern-preview-label">Preview: </span>
                {filenamePreview}
                {outputMode === "per-sheet" && isMulti && (
                  <span className="export-pattern-preview-note"> (first sheet shown)</span>
                )}
              </div>
            </div>
          ) : (
            <div className="export-field">
              <label className="export-field-label">File name</label>
              <div className="export-pattern-preview">{filenamePreview}</div>
            </div>
          )}

          {/* Auto-open */}
          <label className="export-autoopen">
            <input
              type="checkbox"
              checked={autoOpen}
              disabled={isBusy}
              onChange={(e) => {
                setAutoOpen(e.target.checked);
                saveSetting("export_auto_open", String(e.target.checked));
              }}
            />
            Open output folder in Finder after export
          </label>
        </section>

        {/* ── Map summary ──────────────────────────────────────────────────── */}
        <section className="export-section" aria-label="Map summary">
          <h2 className="export-section-title">Map Summary</h2>
          <div className="export-info-grid">
            <InfoRow label="Paper"       value={formatPaperLabel(project)} />
            <InfoRow label="Scale"       value={formatScaleLabel(scale)} />
            <InfoRow label="Margins"     value={`${marginIn}" (${fmt.margins})`} />
            <InfoRow label="Sheet layout" value={
              totalSheets === 1
                ? "Single sheet"
                : `${sheetDims.across} × ${sheetDims.down} (${totalSheets} sheets + overview)`
            } />
            <InfoRow label="Output"      value={
              !isMulti
                ? "1 PDF file"
                : outputMode === "per-sheet"
                  ? `${totalSheets} PDF files`
                  : `1 PDF file (${1 + totalSheets} pages)`
            } />
          </div>
        </section>

        {/* ── Generate / progress ──────────────────────────────────────────── */}
        <section className="export-section">
          {status.kind === "idle" && (
            <button
              className="export-generate-btn"
              onClick={handleExport}
              disabled={!layerCfg}
            >
              {layerCfg ? "Generate PDF" : "Loading layer config…"}
            </button>
          )}

          {isBusy && (() => {
            const k      = status.kind;
            const detail = k === "rendering" ? (status.detail ?? "Rendering map…") : undefined;
            const pct    = k === "rendering" && status.total
              ? Math.round(((status.current ?? 0) + 1) / status.total * 100)
              : undefined;
            return (
              <div className="export-progress" role="status" aria-live="polite">
                <div className="export-progress-spinner" aria-hidden="true" />
                <div className="export-progress-steps">
                  <ProgressStep
                    label={detail ?? "Rendering map tiles…"}
                    active={k === "rendering"}
                    done={k === "composing" || k === "saving"}
                    pct={pct}
                  />
                  <ProgressStep label="Composing PDF…" active={k === "composing"} done={k === "saving"} />
                  <ProgressStep label="Saving file…"   active={k === "saving"}    done={false} />
                </div>
                <button className="export-cancel-btn" onClick={reset}>Cancel</button>
              </div>
            );
          })()}

          {status.kind === "done" && (
            <div className="export-done">
              <div className="export-done-icon" aria-hidden="true">✓</div>
              <div className="export-done-body">
                {status.count > 1 ? (
                  <>
                    <div className="export-done-label">{status.count} PDF files saved</div>
                    <div className="export-done-path" title={status.folder}>{status.folder || "Project exports folder"}</div>
                  </>
                ) : (
                  <>
                    <div className="export-done-label">PDF saved</div>
                    <div className="export-done-path">{status.path.split("/").pop()}</div>
                    <div className="export-done-fullpath">{status.path}</div>
                  </>
                )}
              </div>
              <div className="export-done-actions">
                <button
                  className="export-reveal-btn"
                  onClick={() => handleReveal(status.count > 1 ? status.folder : status.path)}
                >
                  Show in Finder
                </button>
                <button className="export-again-btn" onClick={reset}>Export again</button>
              </div>
            </div>
          )}

          {status.kind === "error" && (
            <div className="export-error" role="alert">
              <div className="export-error-title">Export failed</div>
              <div className="export-error-msg">{status.message}</div>
              <button className="export-retry-btn" onClick={reset}>Try again</button>
            </div>
          )}
        </section>

        {/* ── Export history ───────────────────────────────────────────────── */}
        {history.length > 0 && (
          <section className="export-section" aria-label="Export history">
            <h2 className="export-section-title">Export History</h2>
            <div className="export-history">
              {history.slice(0, 15).map((entry) => (
                <div key={entry.id} className="export-history-row">
                  <div className="export-history-info">
                    <span className="export-history-filename" title={entry.path}>
                      {entry.filename}
                    </span>
                    <span className="export-history-meta">
                      {formatDateLabel(entry.date)}
                      &ensp;·&ensp;{entry.dpi} DPI
                      &ensp;·&ensp;{entry.pages} {entry.pages === 1 ? "page" : "pages"}
                      &ensp;·&ensp;{formatBytes(entry.fileSizeBytes)}
                    </span>
                  </div>
                  <button
                    className="export-history-reveal"
                    onClick={() => handleReveal(entry.path)}
                    title={entry.path}
                  >
                    Show in Finder
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExportShared — passed between the three export branches
// ---------------------------------------------------------------------------

interface ExportShared {
  fmt: FormatSettings;
  scale: number;
  area: { centerLng: number; centerLat: number };
  project: ProjectMeta;
  subtitle: string;
  rasterLayers: Array<{ id: string; tiles: string[]; tileSize?: number; opacity?: number }>;
  legendEntries: LegendEntry[];
  folder: string | null;
  usableW_in: number;
  mapH_in: number;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="export-info-row">
      <span className="export-info-label">{label}</span>
      <span className="export-info-value">{value}</span>
    </div>
  );
}

function ProgressStep({
  label, active, done, pct,
}: {
  label: string; active: boolean; done: boolean; pct?: number;
}) {
  return (
    <div className={`export-step ${active ? "export-step--active" : ""} ${done ? "export-step--done" : ""}`}>
      <span className="export-step-indicator" aria-hidden="true">
        {done ? "✓" : active ? "›" : "○"}
      </span>
      {label}
      {pct !== undefined && active && (
        <span className="export-step-pct">{pct}%</span>
      )}
    </div>
  );
}
