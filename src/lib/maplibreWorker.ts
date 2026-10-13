// MapLibre v6 runs its parsing (GeoJSON sources, vector tiles) in a separate
// module worker, and only works out that worker's URL itself when the page is
// served over http(s). The packaged apps aren't — macOS Tauri uses tauri://
// and the Swift build a custom scheme — so it got an empty URL, every worker
// failed to load, and no GeoJSON overlay drew. Vite bundles the worker (and
// the shared chunk it imports) into one file and hands us its URL instead.
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
