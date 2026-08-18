import { ThemeToggle } from "./ThemeToggle";
import { modKeyLabel } from "../lib/platform";
import "./AppHeader.css";

interface Props {
  onOpenSettings: () => void;
}

export function AppHeader({ onOpenSettings }: Props) {
  const shortcutLabel = `Settings (${modKeyLabel()},)`;
  return (
    <header className="app-header">
      <span className="app-header-title">Hunting Map Generator</span>
      <div className="app-header-actions">
        <ThemeToggle />
        <button
          className="app-header-settings-btn"
          onClick={onOpenSettings}
          aria-label={shortcutLabel}
          title={shortcutLabel}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
