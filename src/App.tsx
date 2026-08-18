import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/ipc";
import { hasModKey } from "./lib/platform";
import Database from "@tauri-apps/plugin-sql";
import { AppHeader } from "./components/AppHeader";
import { SettingsModal } from "./components/SettingsModal";
import { DataScreen } from "./screens/DataScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import "./App.css";

type Screen =
  | { kind: "projects" }
  | { kind: "workspace"; projectId: string }
  | { kind: "data"; initialStateId?: string | null };

interface StorageStatus {
  dataDir: string;
  dbReady: boolean;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "projects" });
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const initDone = useRef(false);

  // Cmd+, on macOS / Ctrl+, elsewhere → open settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasModKey(e) && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Custom event fired by the Swift app's menu item via evaluateJavaScript
  useEffect(() => {
    const handler = () => setShowSettings(true);
    document.addEventListener("open-settings", handler);
    return () => document.removeEventListener("open-settings", handler);
  }, []);

  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;
    (async () => {
      try {
        const dataDir = await invoke<string>("get_data_dir");
        const db = await Database.load("sqlite:catalog.db");
        await db.select("SELECT key FROM settings LIMIT 1");
        await db.close();
        setStorage({ dataDir, dbReady: true });
      } catch (err) {
        setStorageError(String(err));
        console.error("Storage init error:", err);
      }
    })();
  }, []);

  function openProject(id: string) {
    setScreen({ kind: "workspace", projectId: id });
  }

  function openData(initialStateId?: string | null) {
    setScreen({ kind: "data", initialStateId });
  }

  function goHome() {
    setScreen({ kind: "projects" });
  }

  const statusText = storageError
    ? `Storage error: ${storageError}`
    : storage
    ? `Data: ${storage.dataDir}`
    : "Initialising storage…";

  const statusClass = storageError
    ? "status-error"
    : storage
    ? "status-ok"
    : "status-loading";

  return (
    <div className="app">
      <AppHeader onOpenSettings={() => setShowSettings(true)} />
      {screen.kind === "projects" ? (
        <ProjectsScreen onOpen={openProject} onOpenData={openData} />
      ) : screen.kind === "data" ? (
        <DataScreen initialStateId={screen.initialStateId} onBack={goHome} />
      ) : (
        <WorkspaceScreen
          projectId={screen.projectId}
          onBack={goHome}
          onOpenData={openData}
          onOpenProject={openProject}
        />
      )}
      <div className="status-bar">
        <span className={statusClass}>{statusText}</span>
      </div>
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
