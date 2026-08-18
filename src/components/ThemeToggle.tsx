import { ThemeMode, useTheme } from "../theme/ThemeContext";
import "./ThemeToggle.css";

const OPTIONS: { value: ThemeMode; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Light mode" },
  { value: "dark",  label: "Dark",  title: "Dark mode" },
  { value: "system", label: "Auto", title: "Match system setting" },
];

export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {OPTIONS.map(({ value, label, title }) => (
        <button
          key={value}
          className={`theme-toggle-btn${mode === value ? " active" : ""}`}
          onClick={() => setMode(value)}
          aria-pressed={mode === value}
          title={title}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
