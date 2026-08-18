interface MissingCounty {
  id: string;
  name: string;
}

interface Props {
  missingCounties: MissingCounty[];
  downloadedLayerCount: number;
  totalLayerCount: number;
  onDownloadNow: () => void;
  onWorkOnline: () => void;
  onDismiss: () => void;
}

export function MissingCountyBanner({
  missingCounties,
  downloadedLayerCount,
  totalLayerCount,
  onDownloadNow,
  onWorkOnline,
  onDismiss,
}: Props) {
  const missingCount = missingCounties.length;
  const names =
    missingCount <= 3
      ? missingCounties.map((c) => c.name).join(", ")
      : `${missingCounties
          .slice(0, 2)
          .map((c) => c.name)
          .join(", ")} and ${missingCount - 2} more`;

  const layersNeeded = totalLayerCount - downloadedLayerCount;

  return (
    <div className="mcb-banner" role="alert" aria-live="polite">
      <span className="mcb-icon" aria-hidden="true">⚠</span>
      <span className="mcb-text">
        <strong>
          {missingCount === 1
            ? `${names} County has`
            : `${names} have`}{" "}
          no offline data.
        </strong>{" "}
        {layersNeeded > 0
          ? `${layersNeeded} layer${layersNeeded === 1 ? "" : "s"} not yet downloaded.`
          : "Some data may be outdated."}{" "}
        The map will use live tiles when online.
      </span>
      <div className="mcb-actions">
        <button className="mcb-btn mcb-btn--primary" onClick={onDownloadNow}>
          Download Data
        </button>
        <button className="mcb-btn" onClick={onWorkOnline}>
          Work Online
        </button>
        <button className="mcb-btn mcb-btn--dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}

export type { MissingCounty };
