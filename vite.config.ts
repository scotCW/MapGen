import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // The frontend is embedded in the Tauri binary, so bundle size is app size.
    // Both builds run in WKWebView on macOS 12+, which is Safari 15 — targeting
    // it directly avoids shipping downlevel helpers for syntax the webview
    // already supports.
    target: "safari15",
    minify: "esbuild",
    sourcemap: false,
    // Warn only for genuinely large chunks; maplibre-gl alone is ~1 MB.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
