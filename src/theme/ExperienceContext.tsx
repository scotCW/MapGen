import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { invoke } from "../lib/ipc";

export type ExperienceLevel = "beginner" | "intermediate" | "advanced";

const LEVELS: ExperienceLevel[] = ["beginner", "intermediate", "advanced"];
const RANK: Record<ExperienceLevel, number> = { beginner: 0, intermediate: 1, advanced: 2 };

interface ExperienceContextValue {
  level: ExperienceLevel;
  setLevel: (level: ExperienceLevel) => void;
  /** True when the current level is at or above `min` — use to gate a control's visibility. */
  atLeast: (min: ExperienceLevel) => boolean;
}

const ExperienceContext = createContext<ExperienceContextValue | null>(null);

export function ExperienceProvider({ children }: { children: ReactNode }) {
  const [level, setLevelState] = useState<ExperienceLevel>("intermediate");

  useEffect(() => {
    invoke<{ experience_level?: string }>("get_settings")
      .then((s) => {
        const saved = s.experience_level as ExperienceLevel | undefined;
        if (saved && LEVELS.includes(saved)) setLevelState(saved);
      })
      .catch((err) => console.error("Failed to load experience level:", err));
  }, []);

  const setLevel = useCallback((next: ExperienceLevel) => {
    setLevelState(next);
    invoke("set_setting", { key: "experience_level", value: next }).catch((err) =>
      console.error("Failed to persist experience level:", err)
    );
  }, []);

  const atLeast = useCallback((min: ExperienceLevel) => RANK[level] >= RANK[min], [level]);

  return (
    <ExperienceContext.Provider value={{ level, setLevel, atLeast }}>
      {children}
    </ExperienceContext.Provider>
  );
}

export function useExperience(): ExperienceContextValue {
  const ctx = useContext(ExperienceContext);
  if (!ctx) throw new Error("useExperience must be used inside <ExperienceProvider>");
  return ctx;
}
