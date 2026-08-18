// ---------------------------------------------------------------------------
// Save epoch
// ---------------------------------------------------------------------------
//
// The settings tabs persist their own state through a debounced write. That
// creates a race with anything that rewrites project.json underneath them —
// restoring a snapshot, or applying a preset:
//
//   1. user toggles a layer          → save scheduled for +800ms
//   2. user restores a snapshot      → project.json rewritten on disk
//   3. the scheduled save fires      → pre-restore values overwrite the restore
//
// Rather than have each tab register a cancel callback (a lifecycle that has to
// stay in sync across mount, unmount and remount), every scheduled write simply
// carries the epoch it was computed in. A restore bumps the epoch, so writes
// derived from now-stale state are dropped when they fire.
//
// This keeps the desirable behaviour intact: on an ordinary unmount the epoch is
// unchanged, so a pending save still lands and no edit is lost.

let epoch = 0;

/// Epoch to stamp a pending write with. Call when *scheduling* a save, not when
/// it fires — the point is to capture the state the value was derived from.
export function captureSaveEpoch(): number {
  return epoch;
}

/// True if a write stamped with `captured` is still safe to perform.
export function isSaveEpochCurrent(captured: number): boolean {
  return captured === epoch;
}

/// Invalidates every save scheduled so far. Call immediately before rewriting
/// project.json from outside the tabs (snapshot restore, preset apply).
export function invalidatePendingSaves(): void {
  epoch++;
}

// ---------------------------------------------------------------------------
// Backend enforcement
// ---------------------------------------------------------------------------
//
// The epoch above is a client-side fast path: it stops a doomed write before it
// costs an IPC round-trip. It cannot be the guarantee, because it only covers
// saves scheduled *before* a restore starts — one scheduled while the restore is
// still being awaited would carry the current epoch and pass.
//
// The authority is the backend, which stores a generation on project.json and
// refuses any save whose expected generation no longer matches, with the
// read-check-write cycle held under a lock. Restore and preset-apply bump it.

/// Matches the `STALE_GENERATION` constant in both backends.
const STALE_GENERATION = "STALE_GENERATION";

/// True if a rejected save was refused for being superseded. That is an
/// expected outcome, not a failure — the caller should drop the write silently
/// rather than logging it as an error or retrying it.
export function isStaleGenerationError(err: unknown): boolean {
  return String(err).includes(STALE_GENERATION);
}
