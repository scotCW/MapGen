// IPC bridge — auto-detects Tauri vs Swift/WKWebView at runtime.
// This file is shared by both build paths so React components import from here,
// never directly from @tauri-apps/api/core.
//
// Agent 2 (swift-app) will expand this with the WebKit message-handler path
// once the Swift build is complete. For now it delegates entirely to Tauri.

let callbackId = 0;
const pending = new Map<number, { resolve: Function; reject: Function }>();

if (typeof window !== "undefined") {
  (window as any).__ipcCallback = (
    id: number,
    success: boolean,
    valueJson: string
  ) => {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    if (success) cb.resolve(JSON.parse(valueJson));
    else cb.reject(new Error(valueJson));
  };
}

export function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // Dev-only mock hook (see src/lib/devMockIpc.ts). `import.meta.env.DEV` is
  // statically false in production builds, so Vite strips this branch and the
  // window flag it checks is never set outside a local `vite dev` session.
  if (import.meta.env.DEV && (window as any).__DEV_MOCK_IPC__) {
    return (window as any).__DEV_MOCK_IPC__(cmd, args ?? {});
  }

  // Tauri runtime (desktop app via Tauri build)
  if ((window as any).__TAURI_INTERNALS__) {
    return import("@tauri-apps/api/core").then((m) => m.invoke<T>(cmd, args));
  }

  // Swift/WKWebView runtime (Xcode build)
  if ((window as any).webkit?.messageHandlers?.invoke) {
    return new Promise<T>((resolve, reject) => {
      const id = ++callbackId;
      pending.set(id, { resolve, reject });
      (window as any).webkit.messageHandlers.invoke.postMessage(
        JSON.stringify({ cmd, args: args ?? {}, id })
      );
    });
  }

  // Browser dev preview — Tauri IPC not available
  return Promise.reject(
    new Error(
      `IPC unavailable (cmd: ${cmd}). Run inside the Tauri app or Swift app.`
    )
  );
}
