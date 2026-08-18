import { invoke } from "./ipc";

/// Appends a line to the app log shown in Settings → Log.
/// Logging is best-effort diagnostics: a failure here must never surface to the
/// user or interrupt the action being logged.
export function logEvent(message: string): void {
  invoke("write_app_log", { message }).catch(() => {});
}
