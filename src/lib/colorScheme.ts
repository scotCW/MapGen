// Load/save helpers for the active access color scheme and user presets.

import { invoke } from "./ipc";
import type { AccessColorScheme, NamedScheme } from "../types/colorScheme";
import { DEFAULT_SCHEME } from "../types/colorScheme";

const ACTIVE_KEY  = "access_color_scheme";
const PRESETS_KEY = "access_color_presets";

// ---------------------------------------------------------------------------
// Load / save active scheme
// ---------------------------------------------------------------------------

export async function loadActiveScheme(): Promise<AccessColorScheme> {
  try {
    const s = await invoke<Record<string, string>>("get_settings");
    if (s[ACTIVE_KEY]) {
      return { ...DEFAULT_SCHEME, ...JSON.parse(s[ACTIVE_KEY]) } as AccessColorScheme;
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_SCHEME;
}

export async function saveActiveScheme(scheme: AccessColorScheme): Promise<void> {
  await invoke("set_setting", {
    key: ACTIVE_KEY,
    value: JSON.stringify(scheme),
  });
}

// ---------------------------------------------------------------------------
// Load / save user presets
// ---------------------------------------------------------------------------

export async function loadUserPresets(): Promise<NamedScheme[]> {
  try {
    const s = await invoke<Record<string, string>>("get_settings");
    if (s[PRESETS_KEY]) {
      return JSON.parse(s[PRESETS_KEY]) as NamedScheme[];
    }
  } catch {
    // Fall through
  }
  return [];
}

export async function saveUserPresets(presets: NamedScheme[]): Promise<void> {
  await invoke("set_setting", {
    key: PRESETS_KEY,
    value: JSON.stringify(presets),
  });
}
