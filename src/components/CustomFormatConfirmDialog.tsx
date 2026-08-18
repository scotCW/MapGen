import "./CustomFormatConfirmDialog.css";

interface Props {
  fromScale: number;
  toScale: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/// Shown when resizing the print-area box would change the scale away from
/// whatever standard/locked value the project was on. Confirms the user means
/// to leave that behind, since the result no longer matches a preset.
export function CustomFormatConfirmDialog({ fromScale, toScale, onConfirm, onCancel }: Props) {
  return (
    <div className="cfc-backdrop" role="dialog" aria-modal="true" aria-labelledby="cfc-title">
      <div className="cfc-modal">
        <h2 id="cfc-title" className="cfc-title">Switch to a custom scale?</h2>
        <p className="cfc-body">
          Resizing the print area changes the scale from <strong>1:{fromScale.toLocaleString()}</strong> to{" "}
          <strong>1:{toScale.toLocaleString()}</strong>, which isn't one of the standard scales. This
          project will switch to a custom format — you can change it back from the Format tab at
          any time.
        </p>
        <div className="cfc-actions">
          <button className="cfc-btn cfc-btn--secondary" onClick={onCancel} autoFocus>
            Keep current size
          </button>
          <button className="cfc-btn cfc-btn--primary" onClick={onConfirm}>
            Use custom format
          </button>
        </div>
      </div>
    </div>
  );
}
