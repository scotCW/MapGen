/**
 * App-wide settings helpers: persisting a setting and broadcasting the change
 * so already-mounted screens react immediately, plus the display settings
 * (text size, wide-screen layout) that are applied at the document level.
 */

import { invoke } from "./ipc";

/** Fired on window after any setting is saved; detail = { key, value }. */
export const SETTINGS_CHANGED_EVENT = "app-settings-changed";

export async function setAppSetting(key: string, value: unknown): Promise<void> {
  await invoke("set_setting", { key, value });
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { key, value } }));
}

// ---------------------------------------------------------------------------
// Text size
// ---------------------------------------------------------------------------

export const TEXT_SCALE_KEY = "ui_text_scale";
export const TEXT_SCALES = [100, 115, 130, 150] as const;
export type TextScale = typeof TEXT_SCALES[number];
export const DEFAULT_TEXT_SCALE: TextScale = 115;

export function parseTextScale(v: unknown): TextScale {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return (TEXT_SCALES as readonly number[]).includes(n) ? (n as TextScale) : DEFAULT_TEXT_SCALE;
}

/**
 * Scales the whole UI. In the Tauri build this is the webview's native zoom
 * (like browser zoom — maps and pointer coordinates stay correct); elsewhere
 * it falls back to CSS zoom.
 */
export async function applyTextScale(pct: TextScale): Promise<void> {
  const factor = pct / 100;
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(factor);
      document.documentElement.style.removeProperty("zoom");
      return;
    } catch (e) {
      console.warn("Native zoom unavailable, falling back to CSS zoom:", e);
    }
  }
  document.documentElement.style.setProperty("zoom", String(factor));
}

// ---------------------------------------------------------------------------
// Wide / curved screen layout
// ---------------------------------------------------------------------------

export const WIDE_LAYOUT_KEY = "wide_layout";
export type WideMode = "auto" | "on" | "off";

export function parseWideMode(v: unknown): WideMode {
  return v === "on" || v === "off" ? v : "auto";
}

/** Ultrawide monitors are 21:9 (≈2.33) or 32:9 (≈3.56); 16:9 is ≈1.78. */
export function detectWideScreen(): boolean {
  const w = window.screen?.width ?? window.innerWidth;
  const h = window.screen?.height ?? window.innerHeight;
  return h > 0 && w / h >= 2.0;
}

let wideMode: WideMode = "auto";
let wideListener: (() => void) | null = null;

/**
 * "Wide" centres the app in a comfortable-width column so controls aren't
 * pushed out to the far edges of an ultrawide / curved display. Auto
 * re-checks when the window moves to another monitor (resize fires then).
 */
export function applyWideMode(mode: WideMode): void {
  wideMode = mode;
  const update = () => {
    const on = wideMode === "on" || (wideMode === "auto" && detectWideScreen());
    document.documentElement.toggleAttribute("data-wide", on);
  };
  update();
  if (!wideListener) {
    wideListener = update;
    window.addEventListener("resize", () => wideListener?.());
  } else {
    wideListener = update;
  }
}

export function isWideActive(): boolean {
  return document.documentElement.hasAttribute("data-wide");
}

/** Applies persisted display settings; call once at startup. */
export async function initDisplaySettings(): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    applyWideMode(parseWideMode(s[WIDE_LAYOUT_KEY]));
    await applyTextScale(parseTextScale(s[TEXT_SCALE_KEY]));
  } catch (e) {
    applyWideMode("auto");
    await applyTextScale(DEFAULT_TEXT_SCALE);
    console.error("Failed to load display settings:", e);
  }
}
