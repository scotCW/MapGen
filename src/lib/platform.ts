// Platform detection for keyboard-shortcut labels and modifier-key checks.
// Both build paths (Tauri, Swift/WKWebView) run in a webview, so there's no
// native OS API for this — `navigator.platform` is deprecated but still the
// only cross-browser signal available, and WKWebView (Safari-based) doesn't
// support the newer navigator.userAgentData replacement.
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");
}

/// The modifier key label to show in shortcut hints — "⌘" on macOS, "Ctrl"
/// everywhere else (Windows, Linux).
export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/// True if the event's platform modifier key is held — Cmd on macOS, Ctrl
/// elsewhere. Checking both metaKey and ctrlKey unconditionally (as some
/// shortcuts in this codebase already did) works too, but means a Mac user
/// holding Ctrl or a Windows user holding the Windows key also triggers the
/// shortcut — harmless here, but this is the precise version.
export function hasModKey(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}
