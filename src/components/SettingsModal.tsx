import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeContext";
import type { ThemeMode } from "../theme/ThemeContext";
import { useExperience } from "../theme/ExperienceContext";
import type { ExperienceLevel } from "../theme/ExperienceContext";
import { invoke } from "../lib/ipc";
import {
  setAppSetting,
  TEXT_SCALES, TEXT_SCALE_KEY, parseTextScale, applyTextScale,
  WIDE_LAYOUT_KEY, parseWideMode, applyWideMode, detectWideScreen,
} from "../lib/appSettings";
import type { TextScale, WideMode } from "../lib/appSettings";
import { LandAccessColorsDialog } from "./LandAccessColorsDialog";
import type { PresetEntry } from "../types/preset";
import "./SettingsModal.css";

type Units = "imperial" | "metric";

// The exact phrase the user must type to unlock the safety-warning toggle.
const UNLOCK_CODE = "VERIFY";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const { mode, setMode } = useTheme();
  const { level, setLevel } = useExperience();
  const [units, setUnitsState] = useState<Units>("imperial");
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Presets
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  // Log viewer
  const [logText, setLogText] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  // Active settings tab: "general" | "presets" | "log" | "about"
  const [activeTab, setActiveTab] = useState<"general" | "presets" | "log" | "about">("general");

  // Safety warning toggle state
  const [hideDisclaimer, setHideDisclaimer] = useState(false);
  // Display
  const [textScale, setTextScale] = useState<TextScale>(parseTextScale(undefined));
  const [wideMode, setWideMode] = useState<WideMode>("auto");
  const [showColorEditor, setShowColorEditor] = useState(false);
  // Unlock flow: "locked" | "entering" | "unlocked"
  const [unlockState, setUnlockState] = useState<"locked" | "entering" | "unlocked">("locked");
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState(false);
  const unlockInputRef = useRef<HTMLInputElement>(null);

  // Open the native modal (focus trap, Escape, ::backdrop)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  // Load presets when Presets tab opens
  useEffect(() => {
    if (activeTab !== "presets") return;
    invoke<PresetEntry[]>("list_presets")
      .then(setPresets)
      .catch(console.error);
  }, [activeTab]);

  // Load log when Log tab opens
  useEffect(() => {
    if (activeTab !== "log") return;
    setLogLoading(true);
    invoke<string>("read_app_log", { lines: 300 })
      .then(setLogText)
      .catch((e) => setLogText(String(e)))
      .finally(() => setLogLoading(false));
  }, [activeTab]);

  // Load saved settings on mount
  useEffect(() => {
    invoke<Record<string, unknown>>("get_settings")
      .then((s) => {
        if (s.units === "imperial" || s.units === "metric") {
          setUnitsState(s.units as Units);
        }
        setHideDisclaimer(s.hide_access_disclaimer === true);
        setTextScale(parseTextScale(s[TEXT_SCALE_KEY]));
        setWideMode(parseWideMode(s[WIDE_LAYOUT_KEY]));
      })
      .catch(console.error);
  }, []);

  // Focus the unlock input when it appears
  useEffect(() => {
    if (unlockState === "entering") {
      setTimeout(() => unlockInputRef.current?.focus(), 50);
    }
  }, [unlockState]);

  function setUnits(u: Units) {
    setUnitsState(u);
    invoke("set_setting", { key: "units", value: u }).catch(console.error);
  }

  function handleUnlockSubmit() {
    if (unlockInput.trim().toUpperCase() === UNLOCK_CODE) {
      setUnlockState("unlocked");
      setUnlockError(false);
      setUnlockInput("");
    } else {
      setUnlockError(true);
      setUnlockInput("");
      unlockInputRef.current?.focus();
    }
  }

  function toggleDisclaimer(hidden: boolean) {
    setHideDisclaimer(hidden);
    // Broadcast so the open Layers tab hides/shows the note right away.
    setAppSetting("hide_access_disclaimer", hidden).catch(console.error);
  }

  function changeTextScale(pct: TextScale) {
    setTextScale(pct);
    applyTextScale(pct);
    setAppSetting(TEXT_SCALE_KEY, pct).catch(console.error);
  }

  function changeWideMode(mode: WideMode) {
    setWideMode(mode);
    applyWideMode(mode);
    setAppSetting(WIDE_LAYOUT_KEY, mode).catch(console.error);
  }

  const TEXT_LABELS: Record<TextScale, string> = { 100: "Normal", 115: "Large", 130: "Larger", 150: "Largest" };

  return (
    <>
    <dialog ref={dialogRef} className="settings-dialog" aria-label="Settings">
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <button
          className="settings-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>

      {/* Settings tab bar */}
      <div className="settings-tabbar">
        {(["general", "presets", "log", "about"] as const).map((t) => (
          <button
            key={t}
            className={`settings-tab ${activeTab === t ? "settings-tab--active" : ""}`}
            onClick={() => setActiveTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {/* ── General ──────────────────────────────────────── */}
        {activeTab !== "general" ? null : <>
        <section className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>
          <div className="settings-row">
            <span className="settings-label">Theme</span>
            <div className="settings-btn-group" role="group" aria-label="Theme">
              {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  className={`settings-btn${mode === m ? " active" : ""}`}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                >
                  {m === "system" ? "Auto" : m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Display</h3>
          <div className="settings-row">
            <span className="settings-label">Text size</span>
            <div className="settings-btn-group" role="group" aria-label="Text size">
              {TEXT_SCALES.map((pct) => (
                <button
                  key={pct}
                  className={`settings-btn${textScale === pct ? " active" : ""}`}
                  onClick={() => changeTextScale(pct)}
                  aria-pressed={textScale === pct}
                  title={`${pct}%`}
                >
                  {TEXT_LABELS[pct]}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Wide / curved screen</span>
            <div className="settings-btn-group" role="group" aria-label="Wide screen layout">
              {(["auto", "on", "off"] as WideMode[]).map((m) => (
                <button
                  key={m}
                  className={`settings-btn${wideMode === m ? " active" : ""}`}
                  onClick={() => changeWideMode(m)}
                  aria-pressed={wideMode === m}
                >
                  {m === "auto" ? "Auto" : m === "on" ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>
          <p className="settings-hint">
            Wide layout keeps the app in a centred column so controls aren't pushed to the far edges
            of an ultrawide or curved monitor.{" "}
            {wideMode === "auto" && (detectWideScreen()
              ? "Auto: an ultrawide screen was detected, so it's on."
              : "Auto: this screen isn't ultrawide, so it's off.")}
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Experience Level</h3>
          <div className="settings-row">
            <span className="settings-label">Shown controls</span>
            <div className="settings-btn-group" role="group" aria-label="Experience level">
              {(["beginner", "intermediate", "advanced"] as ExperienceLevel[]).map((l) => (
                <button
                  key={l}
                  className={`settings-btn${level === l ? " active" : ""}`}
                  onClick={() => setLevel(l)}
                  aria-pressed={level === l}
                >
                  {l.charAt(0).toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <p className="settings-hint">
            {level === "beginner"
              ? "Only the essentials: paper, scale, and basic layers. Everything else uses sensible defaults."
              : level === "intermediate"
              ? "Adds margins, map element toggles (grid, compass, legend), and output options."
              : "Everything, including scale/sheet locks, custom DPI, and filename patterns."}
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Units</h3>
          <div className="settings-row">
            <span className="settings-label">Measurement</span>
            <div className="settings-btn-group" role="group" aria-label="Units">
              {(["imperial", "metric"] as Units[]).map((u) => (
                <button
                  key={u}
                  className={`settings-btn${units === u ? " active" : ""}`}
                  onClick={() => setUnits(u)}
                  aria-pressed={units === u}
                >
                  {u.charAt(0).toUpperCase() + u.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── Land Access Colors ──────────────────────────────────────────── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Land Access Colors</h3>
          <div className="settings-row">
            <span className="settings-label">Color scheme</span>
            <button
              className="settings-open-editor-btn"
              onClick={() => setShowColorEditor(true)}
            >
              Open Color Editor…
            </button>
          </div>
        </section>

        {/* ── Safety Warnings ─────────────────────────────────────────────── */}
        <section className="settings-section settings-section--danger">
          <h3 className="settings-section-title">Safety Warnings</h3>

          <div className="settings-danger-row">
            <div className="settings-danger-label">
              <span className="settings-danger-icon" aria-hidden="true">⚠</span>
              <div>
                <div className="settings-danger-name">
                  Access disclaimer note
                  {unlockState !== "unlocked" && (
                    <span className="settings-lock-badge" aria-label="locked">🔒</span>
                  )}
                </div>
                <div className="settings-danger-desc">
                  The "verify before you hunt" note shown at the bottom of the Layers panel.
                  To remove the warning band from printed maps, untick <strong>Access disclaimer</strong> in
                  Preview → Map Elements and press Save &amp; Apply.
                </div>
              </div>
            </div>

            {/* Locked state */}
            {unlockState === "locked" && (
              <button
                className="settings-unlock-btn"
                onClick={() => setUnlockState("entering")}
              >
                Unlock
              </button>
            )}

            {/* Code entry state */}
            {unlockState === "entering" && (
              <div className="settings-unlock-form">
                <label className="settings-unlock-prompt" htmlFor="settings-unlock-input">
                  Type <strong>{UNLOCK_CODE}</strong> to unlock:
                </label>
                <div className="settings-unlock-row">
                  <input
                    id="settings-unlock-input"
                    ref={unlockInputRef}
                    className={`settings-unlock-input${unlockError ? " settings-unlock-input--error" : ""}`}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={UNLOCK_CODE}
                    value={unlockInput}
                    onChange={(e) => { setUnlockInput(e.target.value); setUnlockError(false); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUnlockSubmit();
                      if (e.key === "Escape") { setUnlockState("locked"); setUnlockInput(""); }
                    }}
                    aria-label="Unlock code"
                    aria-invalid={unlockError}
                    aria-describedby={unlockError ? "unlock-err" : undefined}
                  />
                  <button className="settings-unlock-go" onClick={handleUnlockSubmit}>
                    OK
                  </button>
                </div>
                {unlockError && (
                  <div id="unlock-err" className="settings-unlock-error" role="alert">
                    Incorrect code.
                  </div>
                )}
              </div>
            )}

            {/* Unlocked state — show the actual toggle */}
            {unlockState === "unlocked" && (
              <div className="settings-btn-group" role="group" aria-label="Access disclaimer visibility">
                <button
                  className={`settings-btn${!hideDisclaimer ? " active" : ""}`}
                  onClick={() => toggleDisclaimer(false)}
                  aria-pressed={!hideDisclaimer}
                >
                  Show
                </button>
                <button
                  className={`settings-btn settings-btn--warn${hideDisclaimer ? " active" : ""}`}
                  onClick={() => toggleDisclaimer(true)}
                  aria-pressed={hideDisclaimer}
                >
                  Hide
                </button>
              </div>
            )}
          </div>
        </section>
        </> }

        {/* ── Presets ──────────────────────────────────────── */}
        {activeTab === "presets" && (
          <section className="settings-section">
            <h3 className="settings-section-title">Saved Presets</h3>
            <p className="settings-hint">
              Presets save your Format and Layers settings. Apply one to any project from the workspace.
            </p>
            {presets.length === 0 ? (
              <div className="settings-presets-empty">
                No presets yet. Save one from the workspace.
              </div>
            ) : (
              <ul className="settings-preset-list">
                {presets.map((p) => (
                  <li key={p.id} className="settings-preset-item">
                    <div className="settings-preset-info">
                      <span className="settings-preset-name">{p.name}</span>
                      <span className="settings-preset-date">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <button
                      className="settings-preset-delete"
                      onClick={async () => {
                        await invoke("delete_preset", { presetId: p.id });
                        setPresets((prev) => prev.filter((x) => x.id !== p.id));
                      }}
                      aria-label={`Delete preset ${p.name}`}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── Log ──────────────────────────────────────────── */}
        {activeTab === "log" && (
          <section className="settings-section settings-section--log">
            <h3 className="settings-section-title">App Log</h3>
            {logLoading ? (
              <div className="settings-log-loading">Loading…</div>
            ) : (
              <pre className="settings-log-view">
                {logText || "(no log entries yet)"}
              </pre>
            )}
          </section>
        )}

        {/* ── About ────────────────────────────────────────── */}
        {activeTab === "about" && (
          <section className="settings-section">
            <h3 className="settings-section-title">Hunting Map Generator</h3>
            <p className="settings-about-line">
              A desktop tool for creating custom hunting maps from public geographic data.
            </p>
            <p className="settings-about-line settings-about-line--subtle">
              Built on Tauri v2 · MapLibre GL · React · Rust
            </p>

            <h3 className="settings-section-title" style={{ marginTop: "20px" }}>Data Sources</h3>
            <ul className="settings-credits-list">
              <li>
                <strong>USGS National Map</strong> — Topographic tiles, imagery, hillshade.{" "}
                Public domain, U.S. Geological Survey.
              </li>
              <li>
                <strong>U.S. Census Bureau TIGER</strong> — County and state boundaries.{" "}
                Public domain.
              </li>
              <li>
                <strong>Protected Areas Database (PAD-US)</strong> — Federal and state land ownership.{" "}
                USGS, public domain.
              </li>
              <li>
                <strong>USFS Motor Vehicle Use Maps</strong> — Road and trail classification.{" "}
                U.S. Forest Service, public domain.
              </li>
              <li>
                <strong>NOAA WMM2025</strong> — Magnetic declination coefficients.{" "}
                National Oceanic and Atmospheric Administration, public domain.
              </li>
            </ul>

            <h3 className="settings-section-title" style={{ marginTop: "20px" }}>License</h3>
            <p className="settings-about-line settings-about-line--subtle">
              Application source is proprietary. Map data are public-domain government datasets.
              Verify land access independently before entering any area.
            </p>
          </section>
        )}
      </div>

      <div className="settings-footer">
        <span className="settings-footer-note">
          Changes apply immediately. All data should be independently verified before use.
        </span>
        <button className="settings-done-btn" onClick={onClose}>Save &amp; Close</button>
      </div>
    </dialog>

    {showColorEditor && (
      <LandAccessColorsDialog onClose={() => setShowColorEditor(false)} />
    )}
  </>
  );
}
