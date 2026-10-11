import { useEffect, useRef, useState } from "react";
// @tauri-apps/plugin-dialog is only available in the Tauri build; the Swift
// build routes through the pick_folder IPC command instead (see pickFolder()).

import { invoke } from "../lib/ipc";
import { useExperience } from "../theme/ExperienceContext";
import { renderMapImage } from "../lib/renderMapImage";
import { buildMapPdf } from "../lib/exportPdf";
import type { RenderedPage } from "../lib/exportPdf";
import { getSheetDimensions } from "../lib/sheetGrid";
import { planPages, pagePixelSize, pageSpec, collectRasterLayers, collectLegend } from "../lib/mapJob";
import type { PageJob, SpecContext } from "../lib/mapJob";
import { isMac } from "../lib/platform";
import { effectivePaper, MARGIN_SIZES } from "../types/format";
import type { NationalLayerConfig } from "../types/layers";
import type { ProjectMeta } from "../types/project";
import { normalizeElements } from "../types/elements";
import "./ExportTab.css";

const REVEAL_LABEL = isMac() ? "Show in Finder" : "Show in folder";

/** Directory part of a path, handling both / and \ separators (Windows). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(i + 1);
}

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
    setStatus({ kind: "rendering", detail: "Preparing…" });

    try {
      // Re-read the project so settings changed on other tabs since this tab
      // was opened (scale, area, map elements) are what gets exported.
      const fresh = await invoke<ProjectMeta>("get_project", { id: projectId });
      setProject(fresh);

      const rasterLayers = collectRasterLayers(fresh.layers, layerCfg);
      if (rasterLayers.length === 0) {
        setStatus({ kind: "error", message: "No streamable layers are enabled. Enable at least the basemap and switch to Online mode." });
        return;
      }

      const plan = planPages(fresh);
      const ctx: SpecContext = { project: fresh, plan, legend: collectLegend(fresh.layers, layerCfg) };
      const folder = outputFolder || null;

      if (plan.isMulti && outputMode === "per-sheet") {
        // One PDF per sheet — the overview is a whole-set page, so it isn't
        // emitted in this mode.
        const sheetJobs = plan.pages.filter((p) => p.kind === "sheet");
        let lastPath = "";
        for (let i = 0; i < sheetJobs.length; i++) {
          const job = sheetJobs[i];
          const page = await renderPage(job, ctx, `Sheet ${job.cell!.ref} (${i + 1}/${sheetJobs.length})`, i, sheetJobs.length);
          if (!page) return;
          setStatus({ kind: "composing" });
          const pdfBytes = await buildMapPdf([page], fresh.name);
          if (abortRef.current) return;
          setStatus({ kind: "saving" });
          lastPath = await invoke<string>("save_export", {
            projectId,
            filename: resolveFilename(pattern, fresh.name, plan.scale, job.cell!.ref),
            dataBase64: uint8ToBase64(pdfBytes),
            outputFolder: folder,
            dpi,
            pages: 1,
          });
        }
        await refreshHistory();
        const folderPath = dirOf(lastPath) || outputFolder;
        if (autoOpen && folderPath) invoke("reveal_in_finder", { path: folderPath }).catch(() => {});
        setStatus({ kind: "done", path: lastPath, folder: folderPath, count: sheetJobs.length });
        return;
      }

      // Single PDF (one sheet, or every sheet + optional overview)
      const rendered: RenderedPage[] = [];
      for (let i = 0; i < plan.pages.length; i++) {
        const job = plan.pages[i];
        const label = job.kind === "overview"
          ? "Rendering overview sheet…"
          : job.kind === "sheet"
          ? `Rendering sheet ${job.cell!.ref} (${i + 1} of ${plan.pages.length})…`
          : "Rendering map tiles…";
        const page = await renderPage(job, ctx, label, i, plan.pages.length);
        if (!page) return;
        rendered.push(page);
      }

      setStatus({ kind: "composing" });
      const pdfBytes = await buildMapPdf(rendered, fresh.name);
      if (abortRef.current) return;

      setStatus({ kind: "saving" });
      const path = await invoke<string>("save_export", {
        projectId,
        filename: resolveFilename(pattern, fresh.name, plan.scale),
        dataBase64: uint8ToBase64(pdfBytes),
        outputFolder: folder,
        dpi,
        pages: rendered.length,
      });

      await refreshHistory();
      if (autoOpen) invoke("reveal_in_finder", { path }).catch(() => {});
      setStatus({ kind: "done", path, folder: dirOf(path), count: 1 });
    } catch (err) {
      if (!abortRef.current) {
        setStatus({ kind: "error", message: String(err) });
      }
    }
  }

  /** Renders one page's map raster; returns null if the export was cancelled. */
  async function renderPage(
    job: PageJob, ctx: SpecContext, detail: string, current: number, total: number,
  ): Promise<RenderedPage | null> {
    if (abortRef.current) return null;
    setStatus({ kind: "rendering", detail, current, total });
    const { pixelW, pixelH } = pagePixelSize(job, dpi);
    const base = pagePixelSize(job, 96);
    // Bigger rasters need more tiles; scale the timeout with pixel area so
    // high-DPI or overview renders on a slow connection aren't cut off early.
    const timeoutMs = Math.round(60_000 * Math.max(1, (pixelW * pixelH) / (base.pixelW * base.pixelH)));
    const jpegUrl = await renderMapImage({
      bounds: job.bounds, pixelW, pixelH,
      rasterLayers: collectRasterLayers(ctx.project.layers, layerCfg!),
      timeoutMs,
    });
    if (abortRef.current) return null;
    return { spec: pageSpec(job, `page-${current}`, ctx), jpegUrl };
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
  const withOverview = normalizeElements(project.elements).overviewSheet;
  const overviewNote = withOverview ? " + overview" : "";
  const pageCount    = totalSheets + (withOverview ? 1 : 0);

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
            Open output folder after export
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
                : `${sheetDims.across} × ${sheetDims.down} (${totalSheets} sheets${overviewNote})`
            } />
            <InfoRow label="Output"      value={
              !isMulti
                ? "1 PDF file"
                : outputMode === "per-sheet"
                  ? `${totalSheets} PDF files`
                  : `1 PDF file (${pageCount} pages)`
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
                    <div className="export-done-path">{baseName(status.path)}</div>
                    <div className="export-done-fullpath">{status.path}</div>
                  </>
                )}
              </div>
              <div className="export-done-actions">
                <button
                  className="export-reveal-btn"
                  onClick={() => handleReveal(status.count > 1 ? status.folder : status.path)}
                >{REVEAL_LABEL}</button>
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
                  >{REVEAL_LABEL}</button>
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
