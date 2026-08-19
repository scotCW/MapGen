use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::projects::{FormatSettings, LayerSettings};
use crate::storage::base_data_dir;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetEntry {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub format: FormatSettings,
    pub layers: LayerSettings,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn presets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    base_data_dir(app).map(|d| d.join("presets"))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Saves a project's current format + layer settings as a named preset.
///
/// Settings are read from project.json rather than accepted from the caller —
/// the tabs persist their own state, so a copy held by the frontend can be stale.
#[tauri::command]
pub fn save_preset(
    app: AppHandle,
    name: String,
    project_id: String,
) -> Result<PresetEntry, String> {
    let dir = presets_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let project = crate::projects::read_project_json_pub(
        &base_data_dir(&app)?.join("projects").join(&project_id),
    )?;

    let id = Uuid::new_v4().to_string();
    let entry = PresetEntry {
        id: id.clone(),
        name,
        created_at: now_iso(),
        format: project.format,
        layers: project.layers,
    };

    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.json")), json).map_err(|e| e.to_string())?;

    Ok(entry)
}

/// Lists all saved presets, newest first.
#[tauri::command]
pub fn list_presets(app: AppHandle) -> Result<Vec<PresetEntry>, String> {
    let dir = presets_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<PresetEntry> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let text = fs::read_to_string(e.path()).ok()?;
            serde_json::from_str(&text).ok()
        })
        .collect();

    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
}

/// Applies a preset's format + layer settings to an existing project.
#[tauri::command]
pub fn apply_preset(app: AppHandle, project_id: String, preset_id: String) -> Result<(), String> {
    let preset_path = presets_dir(&app)?.join(format!("{preset_id}.json"));
    let text = fs::read_to_string(&preset_path).map_err(|e| format!("Cannot read preset: {e}"))?;
    let preset: PresetEntry = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    // Bumps the generation for the same reason snapshot restore does: a tab save
    // computed before this point must not land on top of the applied preset.
    crate::projects::rewrite_with_new_generation(&app, &project_id, |meta| {
        meta.format = preset.format;
        meta.layers = preset.layers;
    })?;
    Ok(())
}

/// Permanently deletes a preset.
#[tauri::command]
pub fn delete_preset(app: AppHandle, preset_id: String) -> Result<(), String> {
    let path = presets_dir(&app)?.join(format!("{preset_id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
