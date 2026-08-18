import { useState } from "react";
import { CATEGORIES, ACCESS_DISCLAIMER, ACCESS_ACK_KEY } from "../types/access";
import { invoke } from "../lib/ipc";
import "./AccessFirstRunModal.css";

interface Props {
  onAck: () => void;
}

export function AccessFirstRunModal({ onAck }: Props) {
  const [checked, setChecked] = useState(false);

  function handleContinue() {
    if (!checked) return;
    // Persist via app settings (reliable in both Tauri and Swift/WKWebView builds).
    // localStorage alone is not reliable with custom URL schemes on some macOS versions.
    invoke("set_setting", { key: ACCESS_ACK_KEY, value: "1" }).catch(console.error);
    try { localStorage.setItem(ACCESS_ACK_KEY, "1"); } catch { /* private mode */ }
    onAck();
  }

  return (
    <div className="acc-modal-backdrop" role="dialog" aria-modal="true"
         aria-labelledby="acc-modal-title">
      <div className="acc-modal">
        <h2 id="acc-modal-title" className="acc-modal-title">
          About Land Access Classification
        </h2>

        <p className="acc-modal-intro">
          This app color-codes land polygons to help you plan a hunt. Colors are derived
          from public government datasets using a rules engine — not a verified legal record.
        </p>

        <div className="acc-modal-categories">
          {CATEGORIES.map((cat) => (
            <div key={cat.id} className="acc-modal-cat">
              <span
                className="acc-modal-swatch"
                style={{ background: cat.color }}
                aria-hidden="true"
              />
              <div className="acc-modal-cat-text">
                <strong className="acc-modal-cat-label">
                  {cat.number}. {cat.label}
                </strong>
                <span className="acc-modal-cat-desc">{cat.description}</span>
              </div>
            </div>
          ))}
          <div className="acc-modal-cat">
            <span
              className="acc-modal-swatch acc-modal-swatch--route"
              aria-hidden="true"
            />
            <div className="acc-modal-cat-text">
              <strong className="acc-modal-cat-label">Public Access Routes</strong>
              <span className="acc-modal-cat-desc">
                Roads, trails, and easements the public may legally travel
              </span>
            </div>
          </div>
        </div>

        <div className="acc-modal-disclaimer" role="note" aria-label="Mandatory disclaimer">
          <div className="acc-modal-disclaimer-icon" aria-hidden="true">⚠</div>
          <p>{ACCESS_DISCLAIMER}</p>
        </div>

        <label className="acc-modal-ack-label">
          <input
            type="checkbox"
            className="acc-modal-ack-checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>
            I understand these categories are estimates for planning purposes only, and
            I will verify land access with the appropriate managing agency before hunting.
          </span>
        </label>

        <button
          className="acc-modal-continue"
          disabled={!checked}
          onClick={handleContinue}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
