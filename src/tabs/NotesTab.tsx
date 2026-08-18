import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc";
import { captureSaveEpoch, isSaveEpochCurrent, isStaleGenerationError } from "../lib/saveEpoch";
import type { ProjectMeta } from "../types/project";
import "./NotesTab.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTOSAVE_DELAY_MS = 800;
const MAX_FONT_SIZE = 24;
const MIN_FONT_SIZE = 6;

// ---------------------------------------------------------------------------
// NotesTab
// ---------------------------------------------------------------------------

export function NotesTab({ projectId, isActive }: Props) {
  const [notes,           setNotes]           = useState("");
  const [printOnOverview, setPrintOnOverview] = useState(false);
  const [printedFontSize, setPrintedFontSize] = useState(8);
  const [saveStatus,      setSaveStatus]      = useState<"saved" | "saving" | "unsaved">("saved");
  const [lastSaved,       setLastSaved]       = useState<Date | null>(null);
  const [loaded,          setLoaded]          = useState(false);

  const timeoutRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Epoch the pending save was scheduled in, for the unmount flush to check.
  const epochRef     = useRef(0);
  // Generation this tab loaded with; the backend refuses saves carrying a stale
  // one, which is how a restore wins the race even if the epoch check passes.
  const generationRef = useRef(0);
  const notesRef     = useRef(notes);
  const printRef     = useRef(printOnOverview);
  const fontSizeRef  = useRef(printedFontSize);

  // Keep refs in sync for use inside timeout callbacks
  notesRef.current    = notes;
  printRef.current    = printOnOverview;
  fontSizeRef.current = printedFontSize;

  // Load project on activation
  useEffect(() => {
    if (!isActive) return;
    invoke<ProjectMeta>("get_project", { id: projectId })
      .then((p) => {
        setNotes(p.notes ?? "");
        setPrintOnOverview(p.notesSettings?.printOnOverview ?? false);
        setPrintedFontSize(p.notesSettings?.printedFontSize ?? 8);
        generationRef.current = p.settingsGeneration ?? 0;
        setSaveStatus("saved");
        setLoaded(true);
      })
      .catch(console.error);
  }, [isActive, projectId]);

  // Flush a pending save on unmount rather than dropping it — cancelling here
  // would silently discard whatever was typed within the autosave window when
  // the user navigates back to Projects.
  useEffect(() => {
    return () => {
      if (!timeoutRef.current) return;
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      // A restore unmounts this tab too, so don't flush stale notes over it.
      if (!isSaveEpochCurrent(epochRef.current)) return;
      // Write directly rather than via doSave: the component is going away, so
      // its status state updates would be no-ops.
      invoke("save_notes", {
        id:              projectId,
        notes:           notesRef.current,
        printOnOverview: printRef.current,
        printedFontSize: fontSizeRef.current,
        expectedGeneration: generationRef.current,
      }).catch((err) => {
        if (isStaleGenerationError(err)) return;
        console.error("Notes flush on unmount failed:", err);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---------------------------------------------------------------------------
  // Save helpers
  // ---------------------------------------------------------------------------

  function scheduleSave() {
    setSaveStatus("unsaved");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const epoch = captureSaveEpoch();
    epochRef.current = epoch;
    timeoutRef.current = setTimeout(() => {
      // Clear first so the unmount flush can tell "save pending" from "already
      // saved" and not issue a redundant write on close.
      timeoutRef.current = null;
      if (!isSaveEpochCurrent(epoch)) return; // superseded by a restore
      doSave(notesRef.current, printRef.current, fontSizeRef.current);
    }, AUTOSAVE_DELAY_MS);
  }

  async function doSave(text: string, print: boolean, fontSize: number) {
    setSaveStatus("saving");
    try {
      generationRef.current = await invoke<number>("save_notes", {
        id:                projectId,
        notes:             text,
        printOnOverview:   print,
        printedFontSize:   fontSize,
        expectedGeneration: generationRef.current,
      });
      setSaveStatus("saved");
      setLastSaved(new Date());
    } catch (err) {
      // Refused because a restore superseded this write — expected, not a
      // failure. The tab is remounting to reload the restored notes anyway.
      if (isStaleGenerationError(err)) return;
      console.error("Notes save failed:", err);
      setSaveStatus("unsaved");
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleNotesChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNotes(e.target.value);
    scheduleSave();
  }

  function handlePrintToggle(checked: boolean) {
    setPrintOnOverview(checked);
    printRef.current = checked;
    doSave(notesRef.current, checked, fontSizeRef.current);
  }

  function handleFontSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parseInt(e.target.value, 10) || MIN_FONT_SIZE));
    setPrintedFontSize(v);
    fontSizeRef.current = v;
    doSave(notesRef.current, printRef.current, v);
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const trimmed   = notes.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const charCount = notes.length;

  const lastSavedLabel = lastSaved
    ? `Saved ${lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : null;

  if (!loaded) {
    return <div className="notes-loading" role="status">Loading…</div>;
  }

  return (
    <div className="notes-tab">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="notes-header">
        <div className="notes-header-left">
          <h2 className="notes-title">Notes</h2>
          <p className="notes-subtitle">
            Why this area, what changed between forks, what to check next season.
          </p>
        </div>
        <div className="notes-save-status" aria-live="polite">
          {saveStatus === "saving"  && <span className="notes-status notes-status--saving">Saving…</span>}
          {saveStatus === "saved"   && lastSavedLabel && <span className="notes-status notes-status--saved">{lastSavedLabel}</span>}
          {saveStatus === "unsaved" && <span className="notes-status notes-status--unsaved">Unsaved</span>}
        </div>
      </div>

      {/* ── Textarea ────────────────────────────────────────────────────────── */}
      <div className="notes-editor-wrap">
        <textarea
          className="notes-editor"
          value={notes}
          onChange={handleNotesChange}
          placeholder="Start typing your notes here…&#10;&#10;Ideas: why you chose this area, access points, changes since last season, what to check next year, GPS waypoints, contact info for landowners."
          spellCheck={true}
          aria-label="Project notes"
        />
      </div>

      {/* ── Footer: counts + print options ──────────────────────────────────── */}
      <div className="notes-footer">

        <div className="notes-counts" aria-live="polite">
          {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          <span className="notes-counts-sep">·</span>
          {charCount.toLocaleString()} {charCount === 1 ? "character" : "characters"}
        </div>

        <div className="notes-print-options">
          <label className="notes-print-toggle">
            <input
              type="checkbox"
              checked={printOnOverview}
              onChange={(e) => handlePrintToggle(e.target.checked)}
            />
            Print on overview sheet
          </label>

          {printOnOverview && (
            <label className="notes-font-size-label">
              Font size
              <input
                type="number"
                className="notes-font-size-input"
                value={printedFontSize}
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                onChange={handleFontSizeChange}
              />
              pt
            </label>
          )}
        </div>

      </div>
    </div>
  );
}
