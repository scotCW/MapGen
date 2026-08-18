import { useState, useRef, useEffect } from "react";
import { ProjectSummary } from "../types/project";
import { timeAgo } from "../utils/time";
import "./ProjectCard.css";

interface Props {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onRename: (id: string, currentName: string) => void;
  onFork: (id: string, currentName: string) => void;
  onDelete: (id: string, name: string) => void;
  onExport: (id: string) => void;
}

export function ProjectCard({ project, onOpen, onRename, onFork, onDelete, onExport }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  function handleMenuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <div className="project-card" onDoubleClick={() => onOpen(project.id)}>
      <div className="project-card__thumb" aria-label="Map thumbnail">
        {project.hasThumbnail ? (
          <img src={`thumbnail://${project.id}`} alt="" className="project-card__thumb-img" />
        ) : (
          <div className="project-card__thumb-placeholder">
            <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
              <rect x="4" y="4" width="40" height="40" rx="4" fill="currentColor" opacity=".08" />
              <path d="M8 36 L18 24 L26 30 L34 18 L40 28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".4" />
              <circle cx="14" cy="20" r="3" fill="currentColor" opacity=".25" />
            </svg>
          </div>
        )}
      </div>

      <div className="project-card__body">
        <div className="project-card__name" title={project.name}>{project.name}</div>
        <div className="project-card__meta">
          {project.state
            ? `${project.state}${project.counties.length > 0 ? ` · ${project.counties.length} ${project.counties.length === 1 ? "county" : "counties"}` : ""}`
            : "No area selected"}
        </div>
        <div className="project-card__time" title={new Date(project.lastModified).toLocaleString()}>
          {timeAgo(project.lastModified)}
        </div>
        {project.forkedFromName && (
          <div className="project-card__fork-badge" title={`Forked from ${project.forkedFromName}`}>
            Fork
          </div>
        )}
      </div>

      <div className="project-card__actions" ref={menuRef}>
        <button
          className="project-card__menu-btn"
          aria-label="Project options"
          aria-expanded={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        >
          ···
        </button>
        {menuOpen && (
          <div className="project-card__menu" role="menu">
            <button role="menuitem" onClick={() => handleMenuAction(() => onOpen(project.id))}>Open</button>
            <button role="menuitem" onClick={() => handleMenuAction(() => onFork(project.id, project.name))}>Fork</button>
            <button role="menuitem" onClick={() => handleMenuAction(() => onRename(project.id, project.name))}>Rename</button>
            <button role="menuitem" onClick={() => handleMenuAction(() => onExport(project.id))}>Export .huntmap</button>
            <div className="project-card__menu-divider" />
            <button role="menuitem" className="project-card__menu-danger" onClick={() => handleMenuAction(() => onDelete(project.id, project.name))}>Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
