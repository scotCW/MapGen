use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::storage::base_data_dir;

// ---------------------------------------------------------------------------
// Data types (serialised to project.json and returned to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkedFrom {
    pub id: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// Format settings (Tab 1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatSettings {
    pub paper_size: String,          // "letter" | "legal" | "tabloid" | "a4" | "a3" | "custom"
    pub paper_width_in: f64,         // effective width (inches); only meaningful for "custom"
    pub paper_height_in: f64,        // effective height (inches); only meaningful for "custom"
    pub orientation: String,         // "portrait" | "landscape"
    pub margins: String,             // "narrow" | "normal" | "wide"
    pub sheet_layout: String,        // "1" | "2" | "4" | "6" | "custom" | "auto"
    pub sheets_across: u32,          // for "custom" grid
    pub sheets_down: u32,            // for "custom" grid
    pub sheets_split: String,        // "side-by-side" | "stacked" (2-sheet sub-option)
    pub sheets_arrangement: String,  // "3x2" | "2x3" (6-sheet sub-option)
    pub scale: u32,                  // ratio denominator (e.g. 24000 for 1:24,000)
    pub scale_custom: Option<u32>,   // non-null only when paper_size == "custom"
    pub scale_lock: String,          // "scale" | "sheet-count" | "both"
    pub freeform_draw: bool,
}

impl Default for FormatSettings {
    fn default() -> Self {
        Self {
            paper_size: "letter".into(),
            paper_width_in: 8.5,
            paper_height_in: 11.0,
            orientation: "portrait".into(),
            margins: "normal".into(),
            sheet_layout: "1".into(),
            sheets_across: 2,
            sheets_down: 2,
            sheets_split: "side-by-side".into(),
            sheets_arrangement: "3x2".into(),
            scale: 24000,
            scale_custom: None,
            scale_lock: "scale".into(),
            freeform_draw: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Layer settings (Tab 2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSettings {
    /// ID of the active basemap layer (radio group — only one at a time)
    pub active_basemap: String,
    /// IDs of non-basemap layers that are enabled
    pub enabled_layers: Vec<String>,
    /// Per-layer opacity overrides (0.0–1.0); absent keys use the config default
    pub layer_opacities: HashMap<String, f64>,
}

impl Default for LayerSettings {
    fn default() -> Self {
        Self {
            active_basemap: "usgs_topo".into(),
            enabled_layers: vec![],
            layer_opacities: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Area settings (Tab 3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaSettings {
    /// Map longitude of the print-box centre
    pub center_lng: f64,
    /// Map latitude of the print-box centre
    pub center_lat: f64,
}

impl Default for AreaSettings {
    fn default() -> Self {
        Self {
            center_lng: -105.7, // central Colorado
            center_lat: 39.0,
        }
    }
}

/// Full project definition — stored in project.json.
/// Human-readable and hand-editable; never use opaque binary formats.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub state: Option<String>,
    pub counties: Vec<String>,
    pub area_size_km2: Option<f64>,
    pub sheet_count: u32,
    pub last_modified: String,   // ISO-8601 UTC
    pub created_at: String,      // ISO-8601 UTC
    pub forked_from: Option<ForkedFrom>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub notes_settings: NotesSettings,
    #[serde(default)]
    pub format: FormatSettings,
    #[serde(default)]
    pub layers: LayerSettings,
    #[serde(default)]
    pub area: AreaSettings,
    /// Bumped only when the whole document is rewritten from outside the tabs
    /// (snapshot restore, preset apply). The settings tabs send the generation
    /// they loaded with every save; a mismatch means their value was computed
    /// before that rewrite, so the write is refused rather than clobbering it.
    ///
    /// Deliberately *not* bumped by the per-field saves themselves — those touch
    /// disjoint parts of the document, and bumping there would make one tab's
    /// save spuriously invalidate another's.
    #[serde(default)]
    pub settings_generation: u64,
}

/// Error returned when a save is refused for being based on pre-rewrite state.
/// The frontend matches on this to drop the write quietly instead of surfacing
/// it as a failure — being superseded is expected, not an error condition.
pub const STALE_GENERATION: &str = "STALE_GENERATION";

/// Serialises the read-check-write cycle on project.json. Without it the
/// generation check and the write are two separate steps that another command
/// could interleave with, which would defeat the point of checking.
static PROJECT_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Applies a partial settings update, but only if the caller's view of the
/// document is still current. Returns the generation the write landed on.
fn guarded_update<F>(
    app: &AppHandle,
    id: &str,
    expected_generation: u64,
    apply: F,
) -> Result<u64, String>
where
    F: FnOnce(&mut ProjectMeta),
{
    let dir = project_dir(app, id)?;
    guarded_update_at(&dir, expected_generation, apply)
}

/// The logic behind [`guarded_update`], separated from AppHandle path
/// resolution so it can be exercised directly in tests.
fn guarded_update_at<F>(
    dir: &Path,
    expected_generation: u64,
    apply: F,
) -> Result<u64, String>
where
    F: FnOnce(&mut ProjectMeta),
{
    let _guard = PROJECT_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_project_json(dir)?;
    if meta.settings_generation != expected_generation {
        return Err(STALE_GENERATION.to_string());
    }
    apply(&mut meta);
    meta.last_modified = now_iso();
    write_project_json(dir, &meta)?;
    Ok(meta.settings_generation)
}

/// Mutates project.json under the same lock as the guarded writes, without
/// touching the generation. For edits that are neither a settings save nor a
/// wholesale rewrite — renaming, say, which must not invalidate a tab's pending
/// save, but equally must not lose one by interleaving with it.
fn locked_update<F>(app: &AppHandle, id: &str, apply: F) -> Result<(), String>
where
    F: FnOnce(&mut ProjectMeta),
{
    let _guard = PROJECT_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = project_dir(app, id)?;
    let mut meta = read_project_json(&dir)?;
    apply(&mut meta);
    meta.last_modified = now_iso();
    write_project_json(&dir, &meta)
}

/// Rewrites the document wholesale and bumps the generation, invalidating any
/// save still in flight from before. Used by snapshot restore and preset apply.
pub fn rewrite_with_new_generation<F>(
    app: &AppHandle,
    id: &str,
    apply: F,
) -> Result<u64, String>
where
    F: FnOnce(&mut ProjectMeta),
{
    let dir = project_dir(app, id)?;
    rewrite_with_new_generation_at(&dir, apply)
}

/// The logic behind [`rewrite_with_new_generation`], separated from AppHandle
/// path resolution so it can be exercised directly in tests.
fn rewrite_with_new_generation_at<F>(dir: &Path, apply: F) -> Result<u64, String>
where
    F: FnOnce(&mut ProjectMeta),
{
    let _guard = PROJECT_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut meta = read_project_json(dir)?;
    apply(&mut meta);
    meta.settings_generation = meta.settings_generation.wrapping_add(1);
    meta.last_modified = now_iso();
    write_project_json(dir, &meta)?;
    Ok(meta.settings_generation)
}

// ---------------------------------------------------------------------------
// Notes settings (Tab 6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesSettings {
    /// Whether to include the notes text on the multi-sheet overview page.
    pub print_on_overview: bool,
    /// Font size (pt) used when printing notes on the overview sheet.
    pub printed_font_size: u32,
}

impl Default for NotesSettings {
    fn default() -> Self {
        Self {
            print_on_overview: false,
            printed_font_size: 8,
        }
    }
}

/// Lightweight summary used by the Projects screen grid.
/// Derived from ProjectMeta; no extra I/O needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub state: Option<String>,
    pub counties: Vec<String>,
    pub area_size_km2: Option<f64>,
    pub sheet_count: u32,
    pub last_modified: String,
    pub created_at: String,
    pub forked_from_id: Option<String>,
    pub forked_from_name: Option<String>,
    pub has_thumbnail: bool,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    base_data_dir(app).map(|d| d.join("projects"))
}

fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    projects_dir(app).map(|d| d.join(id))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn meta_to_summary(meta: ProjectMeta, dir: &Path) -> ProjectSummary {
    let has_thumbnail = dir.join("thumbnail.png").exists();
    ProjectSummary {
        forked_from_id: meta.forked_from.as_ref().map(|f| f.id.clone()),
        forked_from_name: meta.forked_from.as_ref().map(|f| f.name.clone()),
        id: meta.id,
        name: meta.name,
        state: meta.state,
        counties: meta.counties,
        area_size_km2: meta.area_size_km2,
        sheet_count: meta.sheet_count,
        last_modified: meta.last_modified,
        created_at: meta.created_at,
        has_thumbnail,
    }
}

fn write_project_json(dir: &Path, meta: &ProjectMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(dir.join("project.json"), json).map_err(|e| e.to_string())
}

fn read_project_json(dir: &Path) -> Result<ProjectMeta, String> {
    let text = fs::read_to_string(dir.join("project.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Public wrapper used by the `presets` module.
pub fn read_project_json_pub(dir: &Path) -> Result<ProjectMeta, String> {
    read_project_json(dir)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns all projects sorted by last-modified descending.
/// Scans the projects/ directory so the filesystem is always the source of truth.
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let base = projects_dir(&app)?;
    let mut summaries = Vec::new();

    for entry in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let json_path = dir.join("project.json");
        if !json_path.exists() {
            continue;
        }
        match read_project_json(&dir) {
            Ok(meta) => summaries.push(meta_to_summary(meta, &dir)),
            Err(e) => eprintln!("Skipping malformed project at {:?}: {}", dir, e),
        }
    }

    summaries.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(summaries)
}

/// Creates a new project folder and project.json, returns its summary.
#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectSummary, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let dir = project_dir(&app, &id)?;

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("snapshots")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("exports")).map_err(|e| e.to_string())?;

    let meta = ProjectMeta {
        version: 1,
        id: id.clone(),
        name: name.clone(),
        state: None,
        counties: vec![],
        area_size_km2: None,
        sheet_count: 1,
        last_modified: now.clone(),
        created_at: now.clone(),
        forked_from: None,
        notes: String::new(),
        notes_settings: NotesSettings::default(),
        format: FormatSettings::default(),
        layers: LayerSettings::default(),
        area: AreaSettings::default(),
        settings_generation: 0,
    };

    write_project_json(&dir, &meta)?;
    Ok(meta_to_summary(meta, &dir))
}

/// Forks a project: creates a fully independent copy with forkedFrom lineage.
#[tauri::command]
pub fn fork_project(app: AppHandle, source_id: String, new_name: String) -> Result<ProjectSummary, String> {
    let source_dir = project_dir(&app, &source_id)?;
    let source = read_project_json(&source_dir)?;

    let new_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let new_dir = project_dir(&app, &new_id)?;

    fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(new_dir.join("snapshots")).map_err(|e| e.to_string())?;
    fs::create_dir_all(new_dir.join("exports")).map_err(|e| e.to_string())?;

    let forked = ProjectMeta {
        version: 1,
        id: new_id.clone(),
        name: new_name,
        state: source.state,
        counties: source.counties,
        area_size_km2: source.area_size_km2,
        sheet_count: source.sheet_count,
        last_modified: now.clone(),
        created_at: now,
        forked_from: Some(ForkedFrom {
            id: source.id,
            name: source.name,
        }),
        notes: String::new(),
        notes_settings: NotesSettings::default(),
        format: source.format,
        layers: source.layers,
        area: source.area,
        settings_generation: 0,
    };

    write_project_json(&new_dir, &forked)?;
    Ok(meta_to_summary(forked, &new_dir))
}

/// Renames a project in-place and updates last_modified.
#[tauri::command]
pub fn rename_project(app: AppHandle, id: String, name: String) -> Result<(), String> {
    locked_update(&app, &id, |meta| meta.name = name)
}

/// Deletes the project folder entirely (no recovery — caller should confirm).
#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let dir = project_dir(&app, &id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the full project.json for a specific project.
#[tauri::command]
pub fn get_project(app: AppHandle, id: String) -> Result<ProjectMeta, String> {
    let dir = project_dir(&app, &id)?;
    read_project_json(&dir)
}

/// Persists format settings into project.json and bumps last_modified.
#[tauri::command]
pub fn save_format_settings(
    app: AppHandle,
    id: String,
    format: FormatSettings,
    expected_generation: u64,
) -> Result<u64, String> {
    guarded_update(&app, &id, expected_generation, |meta| meta.format = format)
}

/// Persists layer settings into project.json and bumps last_modified.
#[tauri::command]
pub fn save_layer_settings(
    app: AppHandle,
    id: String,
    layers: LayerSettings,
    expected_generation: u64,
) -> Result<u64, String> {
    guarded_update(&app, &id, expected_generation, |meta| meta.layers = layers)
}

/// Persists area settings (print-box centre) into project.json and bumps last_modified.
#[tauri::command]
pub fn save_area_settings(
    app: AppHandle,
    id: String,
    area: AreaSettings,
    expected_generation: u64,
) -> Result<u64, String> {
    guarded_update(&app, &id, expected_generation, |meta| meta.area = area)
}

/// Persists the selected state and county list for a project.
#[tauri::command]
pub fn save_state_selection(
    app: AppHandle,
    id: String,
    state: Option<String>,
    counties: Vec<String>,
    expected_generation: u64,
) -> Result<u64, String> {
    guarded_update(&app, &id, expected_generation, |meta| {
        meta.state = state;
        meta.counties = counties;
    })
}

/// Persists the plain-text notes (and notes display settings) for a project.
#[tauri::command]
pub fn save_notes(
    app: AppHandle,
    id: String,
    notes: String,
    print_on_overview: bool,
    printed_font_size: u32,
    expected_generation: u64,
) -> Result<u64, String> {
    guarded_update(&app, &id, expected_generation, |meta| {
        meta.notes = notes;
        meta.notes_settings.print_on_overview = print_on_overview;
        meta.notes_settings.printed_font_size = printed_font_size.clamp(6, 24);
    })
}

// ---------------------------------------------------------------------------
// Export history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryEntry {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub date: String,        // ISO-8601 UTC
    pub dpi: u32,
    pub pages: u32,
    pub file_size_bytes: u64,
    pub output_folder: String,
}

fn history_path(exports_dir: &Path) -> PathBuf {
    exports_dir.join("_history.json")
}

fn read_history(exports_dir: &Path) -> Vec<ExportHistoryEntry> {
    let path = history_path(exports_dir);
    if !path.exists() { return vec![]; }
    let text = match fs::read_to_string(&path) { Ok(t) => t, Err(_) => return vec![] };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_history(exports_dir: &Path, entries: &[ExportHistoryEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(history_path(exports_dir), json).map_err(|e| e.to_string())
}

fn prepend_history(exports_dir: &Path, entry: ExportHistoryEntry) -> Result<(), String> {
    let mut entries = read_history(exports_dir);
    entries.insert(0, entry);
    entries.truncate(50);
    write_history(exports_dir, &entries)
}

/// Saves a base64-encoded PDF into the given folder (or the default exports dir).
/// Records the export in the project's history. Returns the absolute path.
#[tauri::command]
pub fn save_export(
    app: AppHandle,
    project_id: String,
    filename: String,
    data_base64: String,
    output_folder: Option<String>,
    dpi: u32,
    pages: u32,
) -> Result<String, String> {
    use std::io::Write as _;

    let base = base_data_dir(&app)?;
    let exports_dir = base.join("projects").join(&project_id).join("exports");
    fs::create_dir_all(&exports_dir)
        .map_err(|e| format!("Cannot create exports directory: {e}"))?;

    let pdf_bytes = base64_decode(&data_base64)?;

    let safe_name: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();

    // Resolve destination folder — fall back to project exports/ if custom path is invalid
    let dest_dir = if let Some(ref folder) = output_folder {
        let p = std::path::Path::new(folder);
        if p.is_dir() { p.to_path_buf() } else { exports_dir.clone() }
    } else {
        exports_dir.clone()
    };

    let out_path = dest_dir.join(&safe_name);
    let file_size_bytes = pdf_bytes.len() as u64;

    let mut file = fs::File::create(&out_path)
        .map_err(|e| format!("Cannot create file: {e}"))?;
    file.write_all(&pdf_bytes)
        .map_err(|e| format!("Cannot write PDF: {e}"))?;

    let path_str   = out_path.to_string_lossy().into_owned();
    let folder_str = dest_dir.to_string_lossy().into_owned();

    let entry = ExportHistoryEntry {
        id: Uuid::new_v4().to_string(),
        filename: safe_name,
        path: path_str.clone(),
        date: now_iso(),
        dpi,
        pages,
        file_size_bytes,
        output_folder: folder_str,
    };
    let _ = prepend_history(&exports_dir, entry);

    Ok(path_str)
}

/// Returns the export history for a project (newest first, up to 50 entries).
#[tauri::command]
pub fn get_export_history(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<ExportHistoryEntry>, String> {
    let base = base_data_dir(&app)?;
    let exports_dir = base.join("projects").join(&project_id).join("exports");
    Ok(read_history(&exports_dir))
}

/// Opens the operating system's file manager at the item's location.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Cannot reveal file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Cannot open folder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("Cannot reveal file: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Snapshots (Stage 21)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: String,
    pub label: String,
    pub project_name: String,
    pub saved_at: String,
}

/// Full snapshot file stored on disk — contains the entry fields plus the full meta.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    pub id: String,
    pub label: String,
    pub project_name: String,
    pub saved_at: String,
    pub meta: ProjectMeta,
}

fn snap_dir(dir: &Path) -> PathBuf {
    dir.join("snapshots")
}

/// Saves the current project state as a named snapshot.
#[tauri::command]
pub fn save_snapshot(
    app: AppHandle,
    project_id: String,
    label: Option<String>,
) -> Result<SnapshotEntry, String> {
    let dir = project_dir(&app, &project_id)?;
    let meta = read_project_json(&dir)?;
    let sdir = snap_dir(&dir);
    fs::create_dir_all(&sdir).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let saved_at = now_iso();
    let label = label.unwrap_or_default();

    let snap = SnapshotFile {
        id: id.clone(),
        label: label.clone(),
        project_name: meta.name.clone(),
        saved_at: saved_at.clone(),
        meta,
    };
    let json = serde_json::to_string_pretty(&snap).map_err(|e| e.to_string())?;
    fs::write(sdir.join(format!("{id}.json")), json).map_err(|e| e.to_string())?;

    prune_snapshots(&app, &sdir)?;

    Ok(SnapshotEntry { id, label, project_name: snap.project_name, saved_at })
}

/// Deletes the oldest snapshots beyond the `snapshotRetention` setting.
fn prune_snapshots(app: &AppHandle, sdir: &Path) -> Result<(), String> {
    let keep = crate::storage::get_settings(app.clone())
        .map(|s| s.snapshot_retention as usize)
        .unwrap_or(20)
        .max(1);

    let mut files: Vec<(String, PathBuf)> = fs::read_dir(sdir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|p| {
            let text = fs::read_to_string(&p).ok()?;
            let snap: SnapshotFile = serde_json::from_str(&text).ok()?;
            Some((snap.saved_at, p))
        })
        .collect();

    if files.len() <= keep {
        return Ok(());
    }

    // Newest first, then drop everything past the retention count.
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// Lists all snapshots for a project, newest first.
#[tauri::command]
pub fn list_snapshots(app: AppHandle, project_id: String) -> Result<Vec<SnapshotEntry>, String> {
    let dir = project_dir(&app, &project_id)?;
    let sdir = snap_dir(&dir);
    if !sdir.exists() { return Ok(vec![]); }

    let mut entries: Vec<SnapshotEntry> = fs::read_dir(&sdir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let text = fs::read_to_string(e.path()).ok()?;
            let snap: SnapshotFile = serde_json::from_str(&text).ok()?;
            Some(SnapshotEntry {
                id: snap.id,
                label: snap.label,
                project_name: snap.project_name,
                saved_at: snap.saved_at,
            })
        })
        .collect();

    entries.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(entries)
}

/// Restores a snapshot: overwrites the project's settings/notes/format/layers/area
/// while preserving its current id, name, and last_modified timestamp.
#[tauri::command]
pub fn restore_snapshot(
    app: AppHandle,
    project_id: String,
    snapshot_id: String,
) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    let snap_path = snap_dir(&dir).join(format!("{snapshot_id}.json"));
    let text = fs::read_to_string(&snap_path).map_err(|e| format!("Cannot read snapshot: {e}"))?;
    let snap: SnapshotFile = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    // Bumps the generation, so any tab save still in flight — including one
    // scheduled while this restore was being awaited — is refused rather than
    // landing on top of the restored values.
    rewrite_with_new_generation(&app, &project_id, |current| {
        current.notes = snap.meta.notes;
        current.notes_settings = snap.meta.notes_settings;
        current.format = snap.meta.format;
        current.layers = snap.meta.layers;
        current.area = snap.meta.area;
        current.state = snap.meta.state;
        current.counties = snap.meta.counties;
    })?;
    Ok(())
}

/// Permanently deletes a snapshot.
#[tauri::command]
pub fn delete_snapshot(
    app: AppHandle,
    project_id: String,
    snapshot_id: String,
) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    let path = snap_dir(&dir).join(format!("{snapshot_id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// .huntmap export / import (Stage 21)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HuntmapBundle {
    pub version: u32,
    pub exported_at: String,
    pub meta: ProjectMeta,
}

/// Opens a system save dialog and writes the project as a .huntmap bundle.
/// Returns the path where the file was saved, or null if cancelled.
///
/// Must stay `async`: Tauri runs sync commands on the main thread, and the file
/// dialog needs that thread to pump its event loop — awaiting from the async
/// runtime instead of blocking is what keeps this from deadlocking.
#[tauri::command]
pub async fn export_huntmap(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dir = project_dir(&app, &project_id)?;
    let meta = read_project_json(&dir)?;

    let safe_name: String = meta.name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == ' ' { c } else { '_' })
        .collect();

    let bundle = HuntmapBundle { version: 1, exported_at: now_iso(), meta };
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<std::path::PathBuf>>();
    app.dialog()
        .file()
        .add_filter("Hunting Map", &["huntmap"])
        .set_file_name(format!("{safe_name}.huntmap"))
        .save_file(move |file_path| {
            let _ = tx.send(file_path.and_then(|fp| fp.into_path().ok()));
        });

    match rx.await.map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(path) => {
            fs::write(&path, json).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
    }
}

/// Opens a system file-picker and imports a .huntmap bundle as a new project.
/// Returns the new ProjectSummary, or null if the user cancelled.
///
/// Must stay `async` — see the note on [`export_huntmap`].
#[tauri::command]
pub async fn import_huntmap(app: AppHandle) -> Result<Option<ProjectSummary>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<std::path::PathBuf>>();
    app.dialog()
        .file()
        .add_filter("Hunting Map", &["huntmap"])
        .pick_file(move |file_path| {
            let _ = tx.send(file_path.and_then(|fp| fp.into_path().ok()));
        });

    let path = match rx.await.map_err(|e| e.to_string())? {
        None => return Ok(None),
        Some(p) => p,
    };

    let text = fs::read_to_string(&path).map_err(|e| format!("Cannot read .huntmap file: {e}"))?;
    let bundle: HuntmapBundle = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid .huntmap format: {e}"))?;

    let new_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let new_dir = project_dir(&app, &new_id)?;
    fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(new_dir.join("snapshots")).map_err(|e| e.to_string())?;
    fs::create_dir_all(new_dir.join("exports")).map_err(|e| e.to_string())?;

    let imported = ProjectMeta {
        version: 1,
        id: new_id.clone(),
        name: bundle.meta.name,
        state: bundle.meta.state,
        counties: bundle.meta.counties,
        area_size_km2: bundle.meta.area_size_km2,
        sheet_count: bundle.meta.sheet_count,
        last_modified: now.clone(),
        created_at: now,
        forked_from: bundle.meta.forked_from,
        notes: bundle.meta.notes,
        notes_settings: bundle.meta.notes_settings,
        format: bundle.meta.format,
        layers: bundle.meta.layers,
        area: bundle.meta.area,
        settings_generation: 0,
    };

    write_project_json(&new_dir, &imported)?;
    Ok(Some(meta_to_summary(imported, &new_dir)))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    // std doesn't have base64; implement a simple decoder.
    const INVALID: u8 = 0xFF;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [INVALID; 256];
    for (i, &b) in alphabet.iter().enumerate() {
        table[b as usize] = i as u8;
    }

    let mut out = Vec::with_capacity(s.len() * 3 / 4 + 3);
    let mut buf = 0u32;
    let mut bits = 0u32;

    for byte in s.bytes() {
        // Padding and ASCII whitespace carry no data. Anything else outside the
        // alphabet means the payload isn't what we think it is — decoding it
        // regardless would write a silently corrupt PDF, which is a worse
        // outcome than refusing the export.
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = table[byte as usize];
        if value == INVALID {
            return Err(format!(
                "Invalid base64 character in export payload: {:?}",
                byte as char
            ));
        }
        buf = (buf << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }

    Ok(out)
}

#[cfg(test)]
mod generation_tests {
    use super::*;

    fn setup(name: &str, generation: u64) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mapgen_gentest_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let json = format!(
            r#"{{"version":1,"id":"t","name":"t","state":null,"counties":[],"areaSizeKm2":null,
                 "sheetCount":1,"lastModified":"x","createdAt":"x","forkedFrom":null,
                 "notes":"original","settingsGeneration":{generation}}}"#
        );
        fs::write(dir.join("project.json"), json).unwrap();
        dir
    }

    /// A save whose expected generation matches is applied.
    #[test]
    fn current_generation_write_is_applied() {
        let dir = setup("ok", 0);
        let got = guarded_update_at(&dir, 0, |m| m.notes = "edited".into()).unwrap();
        assert_eq!(got, 0);
        assert_eq!(read_project_json(&dir).unwrap().notes, "edited");
    }

    /// THE RACE: a tab loads at generation G, a restore bumps to G+1, and the
    /// tab's in-flight save — scheduled before *or during* the restore — must be
    /// refused rather than overwriting the restored values.
    #[test]
    fn save_scheduled_before_restore_is_refused() {
        let dir = setup("race", 0);
        let tab_view = read_project_json(&dir).unwrap().settings_generation;

        rewrite_with_new_generation_at(&dir, |m| m.notes = "restored".into()).unwrap();

        let err = guarded_update_at(&dir, tab_view, |m| m.notes = "stale tab value".into())
            .unwrap_err();
        assert_eq!(err, STALE_GENERATION);
        assert_eq!(
            read_project_json(&dir).unwrap().notes,
            "restored",
            "the restore must survive the losing write"
        );
    }

    /// After reloading, the tab can save again normally.
    #[test]
    fn save_succeeds_again_after_reloading_generation() {
        let dir = setup("reload", 0);
        rewrite_with_new_generation_at(&dir, |m| m.notes = "restored".into()).unwrap();
        let fresh = read_project_json(&dir).unwrap().settings_generation;
        guarded_update_at(&dir, fresh, |m| m.notes = "new edit".into()).unwrap();
        assert_eq!(read_project_json(&dir).unwrap().notes, "new edit");
    }

    /// Per-field saves must NOT bump the generation, or one tab's save would
    /// spuriously invalidate another tab's pending save.
    #[test]
    fn partial_saves_do_not_invalidate_other_tabs() {
        let dir = setup("nobump", 0);
        let shared = read_project_json(&dir).unwrap().settings_generation;
        // Two tabs loaded at the same generation; both must be able to save.
        guarded_update_at(&dir, shared, |m| m.notes = "from tab A".into()).unwrap();
        guarded_update_at(&dir, shared, |m| m.state = Some("CO".into())).unwrap();
        let meta = read_project_json(&dir).unwrap();
        assert_eq!(meta.notes, "from tab A");
        assert_eq!(meta.state.as_deref(), Some("CO"));
        assert_eq!(meta.settings_generation, shared);
    }

    /// Restores are cumulative, so an old generation never becomes valid again.
    #[test]
    fn repeated_restores_keep_old_generation_invalid() {
        let dir = setup("repeat", 0);
        let old = 0;
        rewrite_with_new_generation_at(&dir, |_| {}).unwrap();
        rewrite_with_new_generation_at(&dir, |_| {}).unwrap();
        assert_eq!(
            guarded_update_at(&dir, old, |m| m.notes = "zombie".into()).unwrap_err(),
            STALE_GENERATION
        );
    }

    /// A project.json written before this field existed loads at 0 rather than
    /// failing to parse, so upgrading doesn't break existing projects.
    #[test]
    fn legacy_project_without_generation_loads_at_zero() {
        let dir = std::env::temp_dir().join("mapgen_gentest_legacy");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("project.json"), r#"{"version":1,"id":"t","name":"t","state":null,
            "counties":[],"areaSizeKm2":null,"sheetCount":1,"lastModified":"x",
            "createdAt":"x","forkedFrom":null}"#).unwrap();
        assert_eq!(read_project_json(&dir).unwrap().settings_generation, 0);
        // and it can still be saved
        guarded_update_at(&dir, 0, |m| m.notes = "works".into()).unwrap();
    }
}

#[cfg(test)]
mod base64_tests {
    use super::*;

    /// Reference encoder, used only to round-trip against the decoder that every
    /// exported PDF passes through.
    fn encode(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(A[(n >> 18) as usize & 63] as char);
            out.push(A[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
        }
        out
    }

    #[test]
    fn decodes_known_vectors() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("SGVsbG8sIFdvcmxkIQ==").unwrap(), b"Hello, World!");
    }

    /// Every payload length hits a different padding case; a PDF is arbitrary
    /// binary, so all three must round-trip byte-for-byte.
    #[test]
    fn round_trips_all_lengths_and_all_byte_values() {
        for len in 0..=300usize {
            let data: Vec<u8> = (0..len).map(|i| ((i * 37 + 11) % 256) as u8).collect();
            let decoded = base64_decode(&encode(&data)).unwrap();
            assert_eq!(decoded, data, "round-trip failed at length {len}");
        }
    }

    /// A PDF header must survive intact — this is the first thing a reader checks.
    #[test]
    fn round_trips_a_pdf_header() {
        let pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n";
        assert_eq!(base64_decode(&encode(pdf)).unwrap(), pdf);
    }

    /// Line-wrapped input decodes rather than silently corrupting.
    #[test]
    fn tolerates_whitespace() {
        assert_eq!(base64_decode("SGVs\nbG8s\r\n IFdvcmxkIQ==").unwrap(), b"Hello, World!");
    }

    /// A payload that isn't base64 is refused instead of producing a corrupt
    /// file that reports success.
    #[test]
    fn rejects_invalid_characters() {
        assert!(base64_decode("data:application/pdf;base64,TWFu").is_err());
        assert!(base64_decode("TW*u").is_err());
    }
}
