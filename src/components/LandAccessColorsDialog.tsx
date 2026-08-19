import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AccessColorScheme, CategoryStyle, RoutesStyle,
  FillPattern, LineStyle, NamedScheme,
} from "../types/colorScheme";
import {
  DEFAULT_SCHEME, BUILT_IN_PRESETS, SCHEME_POLYGON_KEYS,
} from "../types/colorScheme";
import { CATEGORIES } from "../types/access";
import { loadActiveScheme, saveActiveScheme, loadUserPresets, saveUserPresets } from "../lib/colorScheme";
import "./LandAccessColorsDialog.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Category metadata for labels / ordering
// ---------------------------------------------------------------------------

const CAT_META: Record<string, { label: string; defaultLabel: string }> = {
  huntable:   { label: "Open — Hunting Allowed",   defaultLabel: "Open — Hunting Allowed"   },
  no_hunting: { label: "Open — No Hunting",         defaultLabel: "Open — No Hunting"         },
  closed:     { label: "Closed — No Public Entry",  defaultLabel: "Closed — No Public Entry"  },
  private:    { label: "Private Land",              defaultLabel: "Private Land"              },
  unknown:    { label: "Unknown / Unclassified",    defaultLabel: "Unknown / Unclassified"    },
  routes:     { label: "Access Routes (line layer)", defaultLabel: "Access Routes"            },
};

// ---------------------------------------------------------------------------
// SVG pattern helpers
// ---------------------------------------------------------------------------

function patternDef(id: string, color: string, pattern: FillPattern): ReactElement | null {
  if (pattern === "solid" || pattern === "none") return null;
  const s = color;
  if (pattern === "diagonal") {
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width="8" height="8">
        <line x1="0" y1="8" x2="8" y2="0" stroke={s} strokeWidth="1.5" />
        <line x1="-1" y1="1" x2="1" y2="-1" stroke={s} strokeWidth="1.5" />
        <line x1="7" y1="9" x2="9" y2="7" stroke={s} strokeWidth="1.5" />
      </pattern>
    );
  }
  if (pattern === "crosshatch") {
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width="8" height="8">
        <line x1="0" y1="4" x2="8" y2="4" stroke={s} strokeWidth="1" />
        <line x1="4" y1="0" x2="4" y2="8" stroke={s} strokeWidth="1" />
      </pattern>
    );
  }
  if (pattern === "dots") {
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width="8" height="8">
        <circle cx="4" cy="4" r="1.5" fill={s} />
      </pattern>
    );
  }
  return null;
}

function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
}

function CategorySwatch({ id, style }: { id: string; style: CategoryStyle }) {
  const pid = `pat-${id}`;
  const dash =
    style.borderStyle === "dashed" ? "6,3" :
    style.borderStyle === "dotted" ? "2,3" : undefined;

  return (
    <svg className="lac-swatch" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <defs>{patternDef(pid, style.fillColor, style.pattern)}</defs>
      {style.pattern !== "none" && (
        <rect width="48" height="48" fill={hexToRgba(style.fillColor, style.fillOpacity)} />
      )}
      {style.pattern !== "solid" && style.pattern !== "none" && (
        <rect width="48" height="48" fill={`url(#${pid})`} />
      )}
      <rect
        x={style.borderWeight / 2} y={style.borderWeight / 2}
        width={48 - style.borderWeight} height={48 - style.borderWeight}
        fill="none"
        stroke={style.borderColor}
        strokeWidth={style.borderWeight}
        strokeDasharray={dash}
      />
    </svg>
  );
}

function RoutesSwatch({ style }: { style: RoutesStyle }) {
  const dash =
    style.lineStyle === "dashed" ? "8,4" :
    style.lineStyle === "dotted" ? "2,4" : undefined;
  return (
    <svg className="lac-swatch" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <rect width="48" height="48" fill="transparent" />
      <line x1="4" y1="24" x2="44" y2="24"
        stroke={style.lineColor}
        strokeWidth={Math.min(style.lineWeight * 2, 6)}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

function MapPreview({ scheme }: { scheme: AccessColorScheme }) {
  const catOrder = SCHEME_POLYGON_KEYS;
  const cols = catOrder.length;
  const W = 300; const H = 80;
  const colW = W / cols;

  return (
    <div className="lac-map-preview">
      <div className="lac-map-preview-label">Sample map preview</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: "block" }} aria-label="Access color preview">
        <defs>
          {catOrder.map((k) => {
            const s = scheme[k as keyof typeof scheme] as CategoryStyle;
            return patternDef(`prev-${k}`, s.fillColor, s.pattern);
          })}
        </defs>
        {catOrder.map((k, i) => {
          const s = scheme[k as keyof typeof scheme] as CategoryStyle;
          const x = i * colW;
          const dash = s.borderStyle === "dashed" ? "4,2" : s.borderStyle === "dotted" ? "1,2" : undefined;
          return (
            <g key={k}>
              {s.pattern !== "none" && (
                <rect x={x} width={colW} height={H} fill={hexToRgba(s.fillColor, s.fillOpacity)} />
              )}
              {s.pattern !== "solid" && s.pattern !== "none" && (
                <rect x={x} width={colW} height={H} fill={`url(#prev-${k})`} />
              )}
              <rect x={x} width={colW} height={H} fill="none"
                stroke={s.borderColor} strokeWidth={0.5} strokeDasharray={dash} />
              <text x={x + colW / 2} y={H - 7} textAnchor="middle"
                fontSize="7" fill={s.borderColor} fontFamily="sans-serif">
                {`Cat ${CATEGORIES.find((c) => c.id === k)?.number ?? "?"}`}
              </text>
            </g>
          );
        })}
        {/* Routes line across top */}
        {(() => {
          const r = scheme.routes;
          const dash = r.lineStyle === "dashed" ? "8,4" : r.lineStyle === "dotted" ? "2,4" : undefined;
          return (
            <line x1="20" y1="12" x2={W - 20} y2="12"
              stroke={r.lineColor} strokeWidth={r.lineWeight}
              strokeDasharray={dash} strokeLinecap="round" />
          );
        })()}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color picker (native input + hex text)
// ---------------------------------------------------------------------------

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => { setHex(value); }, [value]);

  function onHexChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setHex(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
  }

  return (
    <div className="lac-color-picker">
      <input
        type="color"
        className="lac-color-native"
        value={value}
        onChange={(e) => { onChange(e.target.value); setHex(e.target.value); }}
        aria-label="Color"
      />
      <input
        type="text"
        className="lac-color-hex"
        value={hex}
        onChange={onHexChange}
        maxLength={7}
        spellCheck={false}
        aria-label="Hex color"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polygon category row (expandable)
// ---------------------------------------------------------------------------

interface PolyCatRowProps {
  id: string;
  style: CategoryStyle;
  canHideFromLegend: boolean;
  onChange: (next: CategoryStyle) => void;
}

function PolyCatRow({ id, style, canHideFromLegend, onChange }: PolyCatRowProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = CAT_META[id];

  function set<K extends keyof CategoryStyle>(k: K, v: CategoryStyle[K]) {
    onChange({ ...style, [k]: v });
  }

  const dash =
    style.borderStyle === "dashed" ? "6,3" :
    style.borderStyle === "dotted" ? "2,3" : undefined;

  return (
    <div className={`lac-cat-row ${expanded ? "lac-cat-row--expanded" : ""}`}>
      <button
        className="lac-cat-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <CategorySwatch id={id} style={style} />
        <div className="lac-cat-header-text">
          <span className="lac-cat-name">{meta.label}</span>
          <span className="lac-cat-sublabel">{style.labelText}</span>
        </div>
        <span className="lac-cat-chevron" aria-hidden="true">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="lac-cat-body">
          {/* Fill */}
          <div className="lac-row">
            <label className="lac-row-label">Fill color</label>
            <ColorPicker value={style.fillColor} onChange={(v) => set("fillColor", v)} />
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Fill opacity</label>
            <div className="lac-opacity-row">
              <input
                type="range"
                className="lac-slider"
                min={0} max={100} step={1}
                value={style.fillOpacity}
                onChange={(e) => set("fillOpacity", parseInt(e.target.value, 10))}
                aria-label="Fill opacity"
              />
              <span className="lac-opacity-val">{style.fillOpacity}%</span>
            </div>
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Pattern</label>
            <div className="lac-seg" role="group" aria-label="Pattern">
              {(["solid", "diagonal", "crosshatch", "dots", "none"] as FillPattern[]).map((p) => (
                <button
                  key={p}
                  className={`lac-seg-btn ${style.pattern === p ? "lac-seg-btn--active" : ""}`}
                  onClick={() => set("pattern", p)}
                  title={p}
                >
                  {p === "solid" ? "Solid" : p === "diagonal" ? "Diag" : p === "crosshatch" ? "Cross" : p === "dots" ? "Dots" : "None"}
                </button>
              ))}
            </div>
          </div>

          <div className="lac-divider" />

          {/* Border */}
          <div className="lac-row">
            <label className="lac-row-label">Border color</label>
            <ColorPicker value={style.borderColor} onChange={(v) => set("borderColor", v)} />
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Border weight</label>
            <div className="lac-weight-row">
              <input
                type="range"
                className="lac-slider"
                min={0.3} max={5} step={0.25}
                value={style.borderWeight}
                onChange={(e) => set("borderWeight", parseFloat(e.target.value))}
                aria-label="Border weight"
              />
              <span className="lac-opacity-val">{style.borderWeight.toFixed(2)} pt</span>
            </div>
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Border style</label>
            <div className="lac-seg" role="group" aria-label="Border style">
              {(["solid", "dashed", "dotted"] as LineStyle[]).map((ls) => (
                <button
                  key={ls}
                  className={`lac-seg-btn ${style.borderStyle === ls ? "lac-seg-btn--active" : ""}`}
                  onClick={() => set("borderStyle", ls)}
                >
                  <svg width="32" height="10" viewBox="0 0 32 10" aria-hidden="true">
                    <line x1="2" y1="5" x2="30" y2="5"
                      stroke="currentColor" strokeWidth="2"
                      strokeDasharray={ls === "dashed" ? "6,3" : ls === "dotted" ? "2,3" : undefined}
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <div className="lac-divider" />

          {/* Label & legend */}
          <div className="lac-row">
            <label className="lac-row-label">Label on map</label>
            <div className="lac-label-row">
              <input
                type="checkbox"
                checked={style.labelVisible}
                onChange={(e) => set("labelVisible", e.target.checked)}
                aria-label="Show label"
              />
              <input
                type="text"
                className="lac-label-input"
                value={style.labelText}
                onChange={(e) => set("labelText", e.target.value)}
                disabled={!style.labelVisible}
                placeholder={meta.defaultLabel}
                aria-label="Label text"
              />
            </div>
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Show in legend</label>
            {canHideFromLegend ? (
              <input
                type="checkbox"
                checked={style.showInLegend}
                onChange={(e) => set("showInLegend", e.target.checked)}
                aria-label="Show in legend"
              />
            ) : (
              <span className="lac-forced-on" title="Unknown category is always shown per §6.3">On (required)</span>
            )}
          </div>

          {/* Live preview */}
          <div className="lac-row">
            <label className="lac-row-label">Preview</label>
            <svg className="lac-preview-strip" viewBox="0 0 120 30" width="120" height="30" aria-label="Style preview">
              <defs>{patternDef(`live-${id}`, style.fillColor, style.pattern)}</defs>
              {style.pattern !== "none" && (
                <rect width="120" height="30" fill={hexToRgba(style.fillColor, style.fillOpacity)} />
              )}
              {style.pattern !== "solid" && style.pattern !== "none" && (
                <rect width="120" height="30" fill={`url(#live-${id})`} />
              )}
              <rect
                x={style.borderWeight / 2} y={style.borderWeight / 2}
                width={120 - style.borderWeight} height={30 - style.borderWeight}
                fill="none" stroke={style.borderColor} strokeWidth={style.borderWeight}
                strokeDasharray={dash}
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routes row (expandable)
// ---------------------------------------------------------------------------

interface RoutesRowProps {
  style: RoutesStyle;
  onChange: (next: RoutesStyle) => void;
}

function RoutesRow({ style, onChange }: RoutesRowProps) {
  const [expanded, setExpanded] = useState(false);

  function set<K extends keyof RoutesStyle>(k: K, v: RoutesStyle[K]) {
    onChange({ ...style, [k]: v });
  }

  return (
    <div className={`lac-cat-row ${expanded ? "lac-cat-row--expanded" : ""}`}>
      <button
        className="lac-cat-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <RoutesSwatch style={style} />
        <div className="lac-cat-header-text">
          <span className="lac-cat-name">{CAT_META.routes.label}</span>
          <span className="lac-cat-sublabel">{style.labelText}</span>
        </div>
        <span className="lac-cat-chevron" aria-hidden="true">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="lac-cat-body">
          <div className="lac-row">
            <label className="lac-row-label">Line color</label>
            <ColorPicker value={style.lineColor} onChange={(v) => set("lineColor", v)} />
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Line weight</label>
            <div className="lac-weight-row">
              <input
                type="range" className="lac-slider"
                min={0.5} max={6} step={0.25}
                value={style.lineWeight}
                onChange={(e) => set("lineWeight", parseFloat(e.target.value))}
                aria-label="Line weight"
              />
              <span className="lac-opacity-val">{style.lineWeight.toFixed(2)} pt</span>
            </div>
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Line style</label>
            <div className="lac-seg" role="group" aria-label="Line style">
              {(["solid", "dashed", "dotted"] as LineStyle[]).map((ls) => (
                <button
                  key={ls}
                  className={`lac-seg-btn ${style.lineStyle === ls ? "lac-seg-btn--active" : ""}`}
                  onClick={() => set("lineStyle", ls)}
                >
                  <svg width="32" height="10" viewBox="0 0 32 10" aria-hidden="true">
                    <line x1="2" y1="5" x2="30" y2="5"
                      stroke="currentColor" strokeWidth="2"
                      strokeDasharray={ls === "dashed" ? "6,3" : ls === "dotted" ? "2,3" : undefined}
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>
          <div className="lac-divider" />
          <div className="lac-row">
            <label className="lac-row-label">Label on map</label>
            <div className="lac-label-row">
              <input
                type="checkbox"
                checked={style.labelVisible}
                onChange={(e) => set("labelVisible", e.target.checked)}
                aria-label="Show label"
              />
              <input
                type="text"
                className="lac-label-input"
                value={style.labelText}
                onChange={(e) => set("labelText", e.target.value)}
                disabled={!style.labelVisible}
                placeholder="Access Routes"
                aria-label="Label text"
              />
            </div>
          </div>
          <div className="lac-row">
            <label className="lac-row-label">Show in legend</label>
            <input
              type="checkbox"
              checked={style.showInLegend}
              onChange={(e) => set("showInLegend", e.target.checked)}
              aria-label="Show in legend"
            />
          </div>

          {/* Live preview */}
          <div className="lac-row">
            <label className="lac-row-label">Preview</label>
            <svg className="lac-preview-strip" viewBox="0 0 120 30" width="120" height="30">
              <rect width="120" height="30" fill="transparent" />
              <line x1="6" y1="15" x2="114" y2="15"
                stroke={style.lineColor} strokeWidth={style.lineWeight}
                strokeDasharray={style.lineStyle === "dashed" ? "8,4" : style.lineStyle === "dotted" ? "2,4" : undefined}
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function LandAccessColorsDialog({ onClose }: Props) {
  const [scheme,      setScheme]      = useState<AccessColorScheme>(DEFAULT_SCHEME);
  const [userPresets, setUserPresets] = useState<NamedScheme[]>([]);
  const [saveName,    setSaveName]    = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const handleCancel = (e: Event) => { e.preventDefault(); onClose(); };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  useEffect(() => {
    loadActiveScheme().then(setScheme).catch(console.error);
    loadUserPresets().then(setUserPresets).catch(console.error);
  }, []);

  // Persist whenever scheme changes (debounce not strictly needed — invokes are fast)
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  function updateScheme(next: AccessColorScheme) {
    setScheme(next);
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      saveActiveScheme(next).catch(console.error);
    }, 400);
  }

  function applyPreset(preset: AccessColorScheme) {
    updateScheme(preset);
  }

  function updateCat(key: string, next: CategoryStyle) {
    updateScheme({ ...scheme, [key]: next });
  }

  function updateRoutes(next: RoutesStyle) {
    updateScheme({ ...scheme, routes: next });
  }

  async function saveAsPreset() {
    const name = saveName.trim();
    if (!name) return;
    setSaving(true);
    const newPreset: NamedScheme = { name, scheme, isBuiltIn: false };
    const updated = [...userPresets.filter((p) => p.name !== name), newPreset];
    setUserPresets(updated);
    await saveUserPresets(updated).catch(console.error);
    setSaving(false);
    setSaveName("");
    setShowSaveForm(false);
  }

  async function deleteUserPreset(name: string) {
    const updated = userPresets.filter((p) => p.name !== name);
    setUserPresets(updated);
    await saveUserPresets(updated).catch(console.error);
  }

  return (
    <dialog ref={dialogRef} className="lac-dialog" aria-label="Land Access Colors">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="lac-header">
        <div>
          <h2 className="lac-title">Land Access Colors</h2>
          <p className="lac-subtitle">Customize how each access category appears on your maps and in exported PDFs.</p>
        </div>
        <button className="lac-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="lac-body">

        {/* ── Map preview ──────────────────────────────────────────────────── */}
        <MapPreview scheme={scheme} />

        {/* ── Presets ──────────────────────────────────────────────────────── */}
        <section className="lac-section">
          <h3 className="lac-section-title">Presets</h3>
          <div className="lac-presets-row">
            {BUILT_IN_PRESETS.map((p) => (
              <button
                key={p.name}
                className="lac-preset-btn"
                onClick={() => applyPreset(p.scheme)}
                title={p.name}
              >
                {p.name}
              </button>
            ))}
          </div>

          {userPresets.length > 0 && (
            <div className="lac-presets-row lac-presets-row--user">
              {userPresets.map((p) => (
                <div key={p.name} className="lac-user-preset">
                  <button className="lac-preset-btn lac-preset-btn--user" onClick={() => applyPreset(p.scheme)}>
                    {p.name}
                  </button>
                  <button className="lac-preset-delete" onClick={() => deleteUserPreset(p.name)} title="Delete preset" aria-label={`Delete ${p.name}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {!showSaveForm ? (
            <button className="lac-save-preset-link" onClick={() => setShowSaveForm(true)}>
              + Save current as preset…
            </button>
          ) : (
            <div className="lac-save-form">
              <input
                type="text"
                className="lac-save-input"
                placeholder="Preset name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveAsPreset();
                  if (e.key === "Escape") { setShowSaveForm(false); setSaveName(""); }
                }}
                autoFocus
                aria-label="New preset name"
              />
              <button
                className="lac-save-btn"
                onClick={saveAsPreset}
                disabled={!saveName.trim() || saving}
              >
                Save
              </button>
              <button className="lac-cancel-btn" onClick={() => { setShowSaveForm(false); setSaveName(""); }}>
                Cancel
              </button>
            </div>
          )}
        </section>

        {/* ── Category rows ────────────────────────────────────────────────── */}
        <section className="lac-section">
          <h3 className="lac-section-title">Category Styles</h3>
          <div className="lac-cats">
            {SCHEME_POLYGON_KEYS.map((key) => (
              <PolyCatRow
                key={key}
                id={key}
                style={scheme[key as keyof AccessColorScheme] as CategoryStyle}
                canHideFromLegend={key !== "unknown"}
                onChange={(next) => updateCat(key, next)}
              />
            ))}
            <RoutesRow style={scheme.routes} onChange={updateRoutes} />
          </div>
        </section>

        <div className="lac-reset-row">
          <button
            className="lac-reset-btn"
            onClick={() => { if (confirm("Reset all colors to built-in defaults?")) updateScheme(DEFAULT_SCHEME); }}
          >
            Reset to defaults
          </button>
          <span className="lac-auto-save-note">Changes save automatically</span>
        </div>

      </div>
    </dialog>
  );
}
