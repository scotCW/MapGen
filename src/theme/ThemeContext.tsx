import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { invoke } from "../lib/ipc";

export type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function detectSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(detectSystemTheme);

  const resolvedTheme: ResolvedTheme = mode === "system" ? systemTheme : mode;

  // Apply immediately whenever resolved changes
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Load saved preference from settings.json on mount
  useEffect(() => {
    invoke<{ theme?: string }>("get_settings")
      .then((s) => {
        const saved = s.theme as ThemeMode | undefined;
        if (saved && ["light", "dark", "system"].includes(saved)) {
          setModeState(saved);
        }
      })
      .catch((err) => console.error("Failed to load theme setting:", err));
  }, []);

  // Track OS theme changes in real time
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setSystemTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    invoke("set_setting", { key: "theme", value: next }).catch((err) =>
      console.error("Failed to persist theme:", err)
    );
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolvedTheme, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
