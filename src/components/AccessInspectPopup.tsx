import { useEffect, useRef } from "react";
import {
  CATEGORY_MAP,
  ACC_CATEGORY,
  ACC_RULE_NOTE,
  ACC_DATASET,
  ACCESS_NOTE,
} from "../types/access";
import type { CategoryId } from "../types/access";
import "./AccessInspectPopup.css";

export interface InspectTarget {
  /** Pixel position on screen */
  screenX: number;
  screenY: number;
  /** GeoJSON feature properties (must include _acc_* fields) */
  props: Record<string, unknown>;
}

interface Props {
  target: InspectTarget;
  onClose: () => void;
}

export function AccessInspectPopup({ target, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape or click outside
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
    };
  }, [onClose]);

  const catId = (target.props[ACC_CATEGORY] as CategoryId | undefined) ?? "unknown";
  const cat   = CATEGORY_MAP.get(catId) ?? CATEGORY_MAP.get("unknown")!;
  const note  = (target.props[ACC_RULE_NOTE] as string | null) ?? null;
  const ds    = (target.props[ACC_DATASET]   as string | null) ?? null;

  // Clamp position so popup stays inside the viewport
  const W = 280;
  const leftRaw = target.screenX + 12;
  const left = Math.min(leftRaw, window.innerWidth - W - 12);
  const top  = target.screenY + 12;

  return (
    <div
      ref={ref}
      className="acc-popup"
      role="dialog"
      aria-label="Land access classification"
      style={{ left, top }}
    >
      <button className="acc-popup-close" onClick={onClose} aria-label="Close">×</button>

      <div className="acc-popup-header">
        <span
          className="acc-popup-swatch"
          style={{ background: cat.color }}
          aria-hidden="true"
        />
        <div>
          <div className="acc-popup-cat-num">Category {cat.number}</div>
          <div className="acc-popup-cat-label">{cat.label}</div>
        </div>
      </div>

      <p className="acc-popup-desc">{cat.description}</p>

      {note && (
        <div className="acc-popup-section">
          <div className="acc-popup-section-title">Why this color?</div>
          <p className="acc-popup-note">{note}</p>
        </div>
      )}

      {ds && (
        <div className="acc-popup-section">
          <div className="acc-popup-section-title">Source dataset</div>
          <p className="acc-popup-note">{ds}</p>
        </div>
      )}

      {!note && !ds && (
        <div className="acc-popup-section">
          <div className="acc-popup-section-title">Classification</div>
          <p className="acc-popup-note">
            No rule matched — defaulted to Unknown. Access status is not determinable
            from available public data.
          </p>
        </div>
      )}

      <div className="acc-popup-warning" role="note">
        <span aria-hidden="true">⚠</span> {ACCESS_NOTE}
      </div>
    </div>
  );
}
