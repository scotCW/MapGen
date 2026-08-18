// Theme CSS must load before React renders to prevent a flash
import "./theme/theme.css";
import "./index.css";
import "maplibre-gl/dist/maplibre-gl.css";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeContext";
import { ExperienceProvider } from "./theme/ExperienceContext";

// TEMPORARY — see src/lib/devMockIpc.ts. Dead-code-eliminated in production.
if (import.meta.env.DEV) {
  await import("./lib/devMockIpc");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ExperienceProvider>
        <App />
      </ExperienceProvider>
    </ThemeProvider>
  </React.StrictMode>
);
