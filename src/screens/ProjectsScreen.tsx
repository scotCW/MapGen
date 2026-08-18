import { useEffect, useState, useCallback } from "react";
import { invoke } from "../lib/ipc";
import { ProjectSummary, SortField, SortDir } from "../types/project";
import { ProjectCard } from "../components/ProjectCard";
import "./ProjectsScreen.css";

interface Props {
  onOpen: (id: string) => void;
  onOpenData: (initialStateId?: string | null) => void;
}

type Modal =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "rename"; id: string; currentName: string }
  | { kind: "fork"; id: string; currentName: string }
  | { kind: "confirmDelete"; id: string; name: string };

export function ProjectsScreen({ onOpen, onOpenData }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("lastModified");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [modalInput, setModalInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await invoke<ProjectSummary[]>("list_projects");
      setProjects(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // --- filtering + sorting ---
  const visible = projects
    .filter((p) =>
      !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.state ?? "").toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      let va = a[sortField] as string;
      let vb = b[sortField] as string;
      const cmp = va.localeCompare(vb);
      return sortDir === "asc" ? cmp : -cmp;
    });

  // --- sort toggle ---
  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  }

  // --- modal actions ---
  function openCreate() { setModalInput(""); setModal({ kind: "create" }); }
  function openRename(id: string, currentName: string) {
    setModalInput(currentName); setModal({ kind: "rename", id, currentName });
  }
  function openFork(id: string, currentName: string) {
    setModalInput(`${currentName} (copy)`); setModal({ kind: "fork", id, currentName });
  }
  function openDelete(id: string, name: string) {
    setModal({ kind: "confirmDelete", id, name });
  }
  function closeModal() { setModal({ kind: "none" }); }

  async function importHuntmap() {
    if (busy) return;
    setBusy(true);
    try {
      const p = await invoke<{ id: string } | null>("import_huntmap");
      if (p) {
        await load();
        onOpen(p.id);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportHuntmap(id: string) {
    try {
      await invoke("export_huntmap", { projectId: id });
    } catch (e) {
      setError(String(e));
    }
  }

  async function submitModal() {
    if (busy) return;
    setBusy(true);
    try {
      if (modal.kind === "create") {
        const name = modalInput.trim();
        if (!name) return;
        const p = await invoke<ProjectSummary>("create_project", { name });
        closeModal();
        onOpen(p.id);
      } else if (modal.kind === "rename") {
        const name = modalInput.trim();
        if (!name) return;
        await invoke("rename_project", { id: modal.id, name });
        closeModal();
        await load();
      } else if (modal.kind === "fork") {
        const name = modalInput.trim();
        if (!name) return;
        const p = await invoke<ProjectSummary>("fork_project", { sourceId: modal.id, newName: name });
        closeModal();
        onOpen(p.id);
      } else if (modal.kind === "confirmDelete") {
        await invoke("delete_project", { id: modal.id });
        closeModal();
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") submitModal();
    if (e.key === "Escape") closeModal();
  }

  const sortLabel = (f: SortField, label: string) => {
    const active = sortField === f;
    const arrow = active ? (sortDir === "asc" ? " ↑" : " ↓") : "";
    return label + arrow;
  };

  return (
    <div className="projects-screen">
      {/* Toolbar */}
      <div className="projects-toolbar">
        <input
          className="projects-search"
          type="search"
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search projects"
        />
        <div className="projects-sort">
          <span className="projects-sort__label">Sort:</span>
          <button className={sortField === "lastModified" ? "active" : ""} onClick={() => toggleSort("lastModified")}>{sortLabel("lastModified", "Modified")}</button>
          <button className={sortField === "createdAt" ? "active" : ""} onClick={() => toggleSort("createdAt")}>{sortLabel("createdAt", "Created")}</button>
          <button className={sortField === "name" ? "active" : ""} onClick={() => toggleSort("name")}>{sortLabel("name", "Name")}</button>
        </div>
        <button className="projects-data-btn" onClick={() => onOpenData()}>Download County Data</button>
        <button className="projects-import-btn" onClick={importHuntmap}>Import .huntmap</button>
        <button className="projects-new-btn" onClick={openCreate}>+ New Project</button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="projects-error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Grid */}
      <div className="projects-content">
        {loading ? (
          <div className="projects-empty">
            <p>Loading projects…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="projects-empty">
            {search ? (
              <>
                <div className="projects-empty__icon" aria-hidden="true">🔍</div>
                <p>No projects match <strong>{search}</strong></p>
                <button onClick={() => setSearch("")}>Clear search</button>
              </>
            ) : (
              <>
                <div className="projects-empty__icon" aria-hidden="true">🗺️</div>
                <p>No projects yet</p>
                <button onClick={openCreate}>Create your first project</button>
              </>
            )}
          </div>
        ) : (
          <div className="projects-grid" role="list">
            {visible.map((p) => (
              <div key={p.id} role="listitem">
                <ProjectCard
                  project={p}
                  onOpen={onOpen}
                  onRename={openRename}
                  onFork={openFork}
                  onDelete={openDelete}
                  onExport={exportHuntmap}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal overlay */}
      {modal.kind !== "none" && (
        <div className="modal-scrim" onClick={closeModal} role="dialog" aria-modal="true">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {modal.kind === "confirmDelete" ? (
              <>
                <h2>Delete project?</h2>
                <p className="modal__body">
                  <strong>{modal.name}</strong> will be permanently deleted. This cannot be undone.
                </p>
                <div className="modal__actions">
                  <button className="btn-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
                  <button className="btn-danger" onClick={submitModal} disabled={busy}>
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>
                  {modal.kind === "create" && "New project"}
                  {modal.kind === "rename" && "Rename project"}
                  {modal.kind === "fork" && "Fork project"}
                </h2>
                <input
                  className="modal__input"
                  type="text"
                  value={modalInput}
                  autoFocus
                  placeholder="Project name"
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <div className="modal__actions">
                  <button className="btn-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
                  <button className="btn-primary" onClick={submitModal} disabled={busy || !modalInput.trim()}>
                    {busy ? "…" :
                      modal.kind === "create" ? "Create" :
                      modal.kind === "rename" ? "Rename" :
                      "Fork"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
