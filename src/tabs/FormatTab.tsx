import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc";
import { useExperience } from "../theme/ExperienceContext";
import { captureSaveEpoch, isSaveEpochCurrent, isStaleGenerationError } from "../lib/saveEpoch";
import { ProjectMeta } from "../types/project";
import {
  FormatSettings,
  FORMAT_DEFAULTS,
  PAPER_SIZES,
  STANDARD_SCALES,
  effectivePaper,
  sheetCoverageMiles,
  milesToKm,
  describeLayout,
} from "../types/format";
import "./FormatTab.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  units: "imperial" | "metric";
}

// ---------------------------------------------------------------------------
// FormatTab
// ---------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 600;

export function FormatTab({ projectId, units }: Props) {
  const { atLeast } = useExperience();
  const [fmt, setFmt] = useState<FormatSettings>(FORMAT_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest value, so the unmount flush can save without stale closure capture.
  const fmtRef = useRef(fmt);
  useEffect(() => { fmtRef.current = fmt; }, [fmt]);
  // Set only by user edits. Loading the project changes `fmt` too, and saving
  // that back would rewrite project.json — and bump lastModified — every time a
  // project is merely opened, reordering the Projects list.
  const dirtyRef = useRef(false);
  // Epoch the pending save was scheduled in, for the unmount flush to check.
  const epochRef = useRef(0);
  // Generation this tab loaded with; the backend refuses saves carrying a stale
  // one, which is how a restore wins the race even if the epoch check passes.
  const generationRef = useRef(0);

  // Load from project.json on mount
  useEffect(() => {
    invoke<ProjectMeta>("get_project", { id: projectId }).then((p) => {
      setFmt(p.format ?? FORMAT_DEFAULTS);
      generationRef.current = p.settingsGeneration ?? 0;
      setLoaded(true);
    });
  }, [projectId]);

  // Debounced auto-save whenever format changes
  useEffect(() => {
    if (!loaded || !dirtyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const epoch = captureSaveEpoch();
    epochRef.current = epoch;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (!isSaveEpochCurrent(epoch)) return; // superseded by a restore
      saveFormat();
    }, SAVE_DEBOUNCE_MS);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [fmt, loaded, projectId]);

  // Flush rather than drop a pending save when the tab goes away — otherwise an
  // edit made within the debounce window is silently lost on navigating back.
  // A restore also unmounts this tab (it remounts them to reload from disk), so
  // the epoch check keeps the flush from overwriting what was just restored.
  useEffect(() => () => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!isSaveEpochCurrent(epochRef.current)) return;
    saveFormat();
  }, [projectId]);

  /// Single write path, so the generation handshake can't be applied to one
  /// caller and forgotten in the other.
  function saveFormat() {
    invoke<number>("save_format_settings", {
      id: projectId,
      format: fmtRef.current,
      expectedGeneration: generationRef.current,
    })
      .then((generation) => { generationRef.current = generation; })
      .catch((err) => {
        // Refused because a restore superseded this write — expected, not a
        // failure. The tab is remounting to reload the restored values anyway.
        if (isStaleGenerationError(err)) return;
        console.error("Format save failed:", err);
      });
  }

  function patch(partial: Partial<FormatSettings>) {
    dirtyRef.current = true;
    setFmt((prev) => ({ ...prev, ...partial }));
  }

  if (!loaded) {
    return <div className="fmt-loading">Loading…</div>;
  }

  const effective = effectivePaper(fmt);
  const coverage = sheetCoverageMiles(fmt);
  const totalSheets = fmt.sheetLayout === "custom"
    ? fmt.sheetsAcross * fmt.sheetsDown
    : fmt.sheetLayout === "auto" ? null
    : parseInt(fmt.sheetLayout, 10);

  const coverageW = units === "imperial" ? `${coverage.w.toFixed(2)} mi` : `${milesToKm(coverage.w).toFixed(2)} km`;
  const coverageH = units === "imperial" ? `${coverage.h.toFixed(2)} mi` : `${milesToKm(coverage.h).toFixed(2)} km`;

  const paperLabel = PAPER_SIZES.find((p) => p.id === fmt.paperSize)?.label ?? fmt.paperSize;
  const scaleSpec   = STANDARD_SCALES.find((s) => s.value === fmt.scale);

  return (
    <div className="fmt-tab">

      {/* ── Section 1: Paper ── */}
      <section className="fmt-section">
        <h3 className="fmt-section-title">Paper</h3>

        {/* Size */}
        <div className="fmt-field">
          <label className="fmt-label">Size</label>
          <div className="fmt-chip-row">
            {PAPER_SIZES.filter((p) => p.id !== "custom" || atLeast("advanced")).map((p) => (
              <button
                key={p.id}
                className={`fmt-chip ${fmt.paperSize === p.id ? "fmt-chip--active" : ""}`}
                onClick={() => patch({ paperSize: p.id })}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fmt.paperSize === "custom" && atLeast("advanced") && (
            <div className="fmt-custom-paper">
              <label className="fmt-sublabel">Width (in)</label>
              <input
                type="number"
                className="fmt-number-input"
                min={3} max={48} step={0.25}
                value={fmt.paperWidthIn}
                onChange={(e) => patch({ paperWidthIn: parseFloat(e.target.value) || 8.5 })}
              />
              <span className="fmt-x">×</span>
              <label className="fmt-sublabel">Height (in)</label>
              <input
                type="number"
                className="fmt-number-input"
                min={3} max={48} step={0.25}
                value={fmt.paperHeightIn}
                onChange={(e) => patch({ paperHeightIn: parseFloat(e.target.value) || 11 })}
              />
            </div>
          )}
        </div>

        {/* Orientation + Margins — side by side */}
        <div className="fmt-row">
          <div className="fmt-field fmt-field--half">
            <label className="fmt-label">Orientation</label>
            <div className="fmt-chip-row">
              {(["portrait", "landscape"] as const).map((o) => (
                <button
                  key={o}
                  className={`fmt-chip fmt-chip--orient ${fmt.orientation === o ? "fmt-chip--active" : ""}`}
                  onClick={() => patch({ orientation: o })}
                  title={o === "portrait" ? `${effective.w.toFixed(1)}" wide × ${effective.h.toFixed(1)}" tall` : `${effective.h.toFixed(1)}" wide × ${effective.w.toFixed(1)}" tall`}
                >
                  <span className={`fmt-orient-icon fmt-orient-icon--${o}`} aria-hidden="true" />
                  {o.charAt(0).toUpperCase() + o.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {atLeast("intermediate") && (
            <div className="fmt-field fmt-field--half">
              <label className="fmt-label">Margins</label>
              <div className="fmt-chip-row">
                {(["narrow", "normal", "wide"] as const).map((m) => (
                  <button
                    key={m}
                    className={`fmt-chip ${fmt.margins === m ? "fmt-chip--active" : ""}`}
                    onClick={() => patch({ margins: m })}
                  >
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
              <p className="fmt-hint">
                {fmt.margins === "narrow" ? "¼\" — maximum print area" :
                 fmt.margins === "normal" ? "½\" — balanced" :
                 "1\" — comfortable white space"}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── Section 2: How many maps? ── */}
      <section className="fmt-section">
        <h3 className="fmt-section-title">How many maps?</h3>
        <p className="fmt-section-desc">Each sheet prints on one page. Choose based on area size and field convenience.</p>

        <div className="fmt-layout-grid">
          {[
            { id: "1",      label: "1 sheet",    sub: "Whole area on one page",       icon: "▪" },
            { id: "2",      label: "2 sheets",   sub: "Split in two",                  icon: "▪▪" },
            { id: "4",      label: "4 sheets",   sub: "2 × 2 grid",                   icon: "⊞" },
            { id: "6",      label: "6 sheets",   sub: "3 × 2 or 2 × 3",              icon: "⋮▪" },
            { id: "custom", label: "Custom",     sub: "Enter columns × rows",          icon: "⊡", min: "advanced" as const },
            { id: "auto",   label: "Auto",       sub: "Scale decides sheet count",     icon: "↔" },
          ].filter((card) => !card.min || atLeast(card.min)).map((card) => (
            <button
              key={card.id}
              className={`fmt-layout-card ${fmt.sheetLayout === card.id ? "fmt-layout-card--active" : ""}`}
              onClick={() => patch({ sheetLayout: card.id })}
            >
              <span className="fmt-layout-icon" aria-hidden="true">{card.icon}</span>
              <span className="fmt-layout-label">{card.label}</span>
              <span className="fmt-layout-sub">{card.sub}</span>
            </button>
          ))}
        </div>

        {/* Sub-options */}
        {fmt.sheetLayout === "2" && (
          <div className="fmt-sub-opts">
            <label className="fmt-label">Split direction</label>
            <div className="fmt-chip-row">
              {(["side-by-side", "stacked"] as const).map((s) => (
                <button
                  key={s}
                  className={`fmt-chip ${fmt.sheetsSplit === s ? "fmt-chip--active" : ""}`}
                  onClick={() => patch({ sheetsSplit: s })}
                >
                  {s === "side-by-side" ? "Side by side" : "Stacked"}
                </button>
              ))}
            </div>
          </div>
        )}
        {fmt.sheetLayout === "6" && (
          <div className="fmt-sub-opts">
            <label className="fmt-label">Arrangement</label>
            <div className="fmt-chip-row">
              {(["3x2", "2x3"] as const).map((a) => (
                <button
                  key={a}
                  className={`fmt-chip ${fmt.sheetsArrangement === a ? "fmt-chip--active" : ""}`}
                  onClick={() => patch({ sheetsArrangement: a })}
                >
                  {a === "3x2" ? "3 across × 2 down" : "2 across × 3 down"}
                </button>
              ))}
            </div>
          </div>
        )}
        {fmt.sheetLayout === "custom" && (
          <div className="fmt-sub-opts">
            <label className="fmt-label">Grid</label>
            <div className="fmt-custom-grid">
              <input
                type="number" min={1} max={20}
                className="fmt-number-input"
                value={fmt.sheetsAcross}
                onChange={(e) => patch({ sheetsAcross: Math.max(1, parseInt(e.target.value) || 1) })}
              />
              <span className="fmt-x">across ×</span>
              <input
                type="number" min={1} max={20}
                className="fmt-number-input"
                value={fmt.sheetsDown}
                onChange={(e) => patch({ sheetsDown: Math.max(1, parseInt(e.target.value) || 1) })}
              />
              <span className="fmt-x">down</span>
            </div>
          </div>
        )}
      </section>

      {/* ── Section 3: Scale ── */}
      <section className="fmt-section">
        <h3 className="fmt-section-title">Scale</h3>

        <div className="fmt-scale-grid">
          {STANDARD_SCALES.map((s) => (
            <button
              key={s.value}
              className={`fmt-scale-btn ${fmt.scale === s.value && !fmt.scaleCustom ? "fmt-scale-btn--active" : ""}`}
              onClick={() => patch({ scale: s.value, scaleCustom: null })}
            >
              <span className="fmt-scale-ratio">{s.label}</span>
              <span className="fmt-scale-plain">{s.plainLabel}</span>
            </button>
          ))}
          {atLeast("advanced") && (
            <button
              className={`fmt-scale-btn ${fmt.scaleCustom ? "fmt-scale-btn--active" : ""}`}
              onClick={() => patch({ scaleCustom: fmt.scale, scale: fmt.scale })}
            >
              <span className="fmt-scale-ratio">Custom</span>
              <span className="fmt-scale-plain">Enter any ratio</span>
            </button>
          )}
        </div>

        {fmt.scaleCustom !== null && atLeast("advanced") && (
          <div className="fmt-custom-scale">
            <span className="fmt-x">1 :</span>
            <input
              type="number" min={1000} max={1000000} step={100}
              className="fmt-number-input fmt-number-input--wide"
              value={fmt.scaleCustom ?? fmt.scale}
              onChange={(e) => {
                const v = parseInt(e.target.value) || 24000;
                patch({ scaleCustom: v, scale: v });
              }}
            />
          </div>
        )}

        {/* Scale lock */}
        {atLeast("advanced") && (
          <div className="fmt-lock-row">
            <label className="fmt-label">Lock</label>
            <div className="fmt-chip-row">
              <button
                className={`fmt-chip ${fmt.scaleLock === "scale" ? "fmt-chip--active" : ""}`}
                onClick={() => patch({ scaleLock: "scale" })}
              >
                Scale locked
              </button>
              <button
                className={`fmt-chip ${fmt.scaleLock === "sheet-count" ? "fmt-chip--active" : ""}`}
                onClick={() => patch({ scaleLock: "sheet-count" })}
              >
                Sheet count locked
              </button>
              <button
                className={`fmt-chip ${fmt.scaleLock === "both" ? "fmt-chip--active" : ""}`}
                onClick={() => patch({ scaleLock: "both" })}
              >
                Both locked
              </button>
            </div>
            <p className="fmt-hint">
              {fmt.scaleLock === "scale"
                ? "Scale locked — the box on the map is a fixed ground size. Making the area bigger adds sheets."
                : fmt.scaleLock === "sheet-count"
                ? "Sheet count locked — the box resizes freely and the scale adjusts to fit. Dragging a bigger area gives a smaller scale."
                : "Both locked — neither gives way automatically. Resizing the box on the map will ask to switch this project to a custom scale instead."}
            </p>
          </div>
        )}
      </section>

      {/* ── Section 4: Freeform ── */}
      {atLeast("advanced") && (
        <section className="fmt-section">
          <div className="fmt-toggle-row">
            <div>
              <div className="fmt-label">Draw my own area instead</div>
              <p className="fmt-hint">Drag any rectangle on the map; the app reports the resulting scale and sheet count afterward.</p>
            </div>
            <button
              role="switch"
              aria-checked={fmt.freeformDraw}
              className={`fmt-toggle ${fmt.freeformDraw ? "fmt-toggle--on" : ""}`}
              onClick={() => patch({ freeformDraw: !fmt.freeformDraw })}
            >
              <span className="fmt-toggle-knob" />
            </button>
          </div>
        </section>
      )}

      {/* ── Live readout ── */}
      <div className="fmt-readout">
        <span className="fmt-readout-label">Each sheet covers</span>
        <strong className="fmt-readout-value">{coverageW} × {coverageH}</strong>
        <span className="fmt-readout-label">at</span>
        <strong className="fmt-readout-value">
          {scaleSpec ? scaleSpec.label : `1:${fmt.scale.toLocaleString()}`}
        </strong>
        <span className="fmt-readout-label">on</span>
        <strong className="fmt-readout-value">{paperLabel}</strong>
        <span className="fmt-readout-sep">·</span>
        <span className="fmt-readout-label">{describeLayout(fmt)}</span>
        {totalSheets !== null && (
          <>
            <span className="fmt-readout-sep">·</span>
            <span className="fmt-readout-label">{totalSheets} page{totalSheets !== 1 ? "s" : ""} total</span>
          </>
        )}
        <span className="fmt-readout-sep">·</span>
        <span className="fmt-readout-area-hint">Set area in the Area tab to see full coverage</span>
      </div>

    </div>
  );
}
