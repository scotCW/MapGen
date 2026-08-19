use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::storage::base_data_dir;

// ─── Shared download state ───────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DownloadProgressState {
    pub active: bool,
    pub current_layer_id: String,
    pub current_layer_name: String,
    pub overall_completed: usize,
    pub overall_total: usize,
    pub error: Option<String>,
}

pub struct DownloadState {
    pub progress: Mutex<DownloadProgressState>,
    pub cancel: Mutex<bool>,
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            progress: Mutex::new(DownloadProgressState::default()),
            cancel: Mutex::new(false),
        }
    }
}

// ─── Manifest types ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct LayerManifestEntry {
    pub layer_id: String,
    pub layer_name: String,
    pub downloaded_at: String,
    pub size_bytes: u64,
    pub source_url: String,
    pub is_stale: bool,
}

#[derive(Serialize, Deserialize, Default)]
pub struct LayerManifest {
    pub layers: Vec<LayerManifestEntry>,
}

#[derive(Serialize)]
pub struct DataDiskUsage {
    pub total_bytes: u64,
    pub data_dir: String,
}

#[derive(Deserialize)]
pub struct DownloadItem {
    pub layer_id: String,
    pub layer_name: String,
    pub download_url: String,
}

// ─── Path helpers ────────────────────────────────────────────────────────────

const STALE_DAYS: i64 = 90;

fn state_data_dir(app: &AppHandle, state_id: &str) -> Result<PathBuf, String> {
    let dir = base_data_dir(app)?
        .join("data")
        .join(state_id.to_lowercase());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = base_data_dir(app)?.join("data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ─── Manifest helpers ────────────────────────────────────────────────────────

fn read_manifest(dir: &Path) -> LayerManifest {
    let path = dir.join("manifest.json");
    if !path.exists() {
        return LayerManifest::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, manifest: &LayerManifest) -> Result<(), String> {
    let path = dir.join("manifest.json");
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn stale_check(downloaded_at: &str) -> bool {
    DateTime::parse_from_rfc3339(downloaded_at)
        .map(|dt| {
            let age = Utc::now().signed_duration_since(dt.with_timezone(&Utc));
            age.num_days() > STALE_DAYS
        })
        .unwrap_or(false)
}

fn dir_size_bytes(path: &PathBuf) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size_bytes(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Returns what's currently on disk for a given state.
#[tauri::command]
pub fn list_downloaded_layers(
    app: AppHandle,
    state_id: String,
) -> Result<Vec<LayerManifestEntry>, String> {
    let dir = state_data_dir(&app, &state_id)?;
    let mut manifest = read_manifest(&dir);
    // Drop entries whose files no longer exist, refresh stale flag
    manifest
        .layers
        .retain(|e| dir.join(format!("{}.geojson", e.layer_id)).exists());
    for entry in &mut manifest.layers {
        entry.is_stale = stale_check(&entry.downloaded_at);
    }
    Ok(manifest.layers)
}

/// Kicks off a background download for the given items.
/// Items are downloaded sequentially; progress is readable via `get_download_progress`.
#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    ds: tauri::State<'_, Arc<DownloadState>>,
    state_id: String,
    items: Vec<DownloadItem>,
) -> Result<(), String> {
    {
        let p = ds.progress.lock().map_err(|e| e.to_string())?;
        if p.active {
            return Err("Download already in progress".into());
        }
    }
    {
        *ds.cancel.lock().map_err(|e| e.to_string())? = false;
    }
    {
        let mut p = ds.progress.lock().map_err(|e| e.to_string())?;
        *p = DownloadProgressState {
            active: true,
            overall_total: items.len(),
            ..Default::default()
        };
    }

    let ds_arc = Arc::clone(&ds);
    tauri::async_runtime::spawn(async move {
        let total = items.len();
        for (i, item) in items.into_iter().enumerate() {
            // Check cancel flag
            let cancelled = ds_arc.cancel.lock().map(|c| *c).unwrap_or(false);
            if cancelled {
                let mut p = ds_arc.progress.lock().unwrap();
                p.active = false;
                p.error = Some("Download cancelled".into());
                return;
            }

            // Update progress
            {
                let mut p = ds_arc.progress.lock().unwrap();
                p.current_layer_id = item.layer_id.clone();
                p.current_layer_name = item.layer_name.clone();
                p.overall_completed = i;
            }

            match download_one(&app, &state_id, &item).await {
                Ok(size_bytes) => {
                    // Update manifest
                    let Ok(dir) = state_data_dir(&app, &state_id) else {
                        continue;
                    };
                    let mut manifest = read_manifest(&dir);
                    manifest.layers.retain(|e| e.layer_id != item.layer_id);
                    manifest.layers.push(LayerManifestEntry {
                        layer_id: item.layer_id.clone(),
                        layer_name: item.layer_name.clone(),
                        downloaded_at: Utc::now().to_rfc3339(),
                        size_bytes,
                        source_url: item.download_url.clone(),
                        is_stale: false,
                    });
                    let _ = write_manifest(&dir, &manifest);
                }
                Err(e) => {
                    let mut p = ds_arc.progress.lock().unwrap();
                    p.active = false;
                    p.error = Some(format!("{}: {}", item.layer_name, e));
                    return;
                }
            }
        }

        // All done
        let mut p = ds_arc.progress.lock().unwrap();
        p.active = false;
        p.overall_completed = total;
        p.current_layer_id = String::new();
        p.current_layer_name = String::new();
    });

    Ok(())
}

/// Downloads a single layer to disk; returns the byte count written.
async fn download_one(app: &AppHandle, state_id: &str, item: &DownloadItem) -> Result<u64, String> {
    let dir = state_data_dir(app, state_id)?;
    let dest = dir.join(format!("{}.geojson", item.layer_id));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&item.download_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let size = bytes.len() as u64;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(size)
}

/// Returns current download progress (safe to poll every second from the UI).
#[tauri::command]
pub fn get_download_progress(
    ds: tauri::State<'_, Arc<DownloadState>>,
) -> Result<DownloadProgressState, String> {
    ds.progress
        .lock()
        .map(|p| p.clone())
        .map_err(|e| e.to_string())
}

/// Signals the background download to stop after the current item finishes.
#[tauri::command]
pub fn cancel_download(ds: tauri::State<'_, Arc<DownloadState>>) -> Result<(), String> {
    *ds.cancel.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Removes a downloaded layer's file and manifest entry.
#[tauri::command]
pub fn delete_layer_data(app: AppHandle, state_id: String, layer_id: String) -> Result<(), String> {
    let dir = state_data_dir(&app, &state_id)?;
    let file = dir.join(format!("{}.geojson", layer_id));
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    let mut manifest = read_manifest(&dir);
    manifest.layers.retain(|e| e.layer_id != layer_id);
    write_manifest(&dir, &manifest)
}

/// Returns total data directory size in bytes + path.
#[tauri::command]
pub fn get_data_disk_usage(app: AppHandle) -> Result<DataDiskUsage, String> {
    let root = data_root(&app)?;
    let total_bytes = dir_size_bytes(&root);
    Ok(DataDiskUsage {
        total_bytes,
        data_dir: root.to_string_lossy().into_owned(),
    })
}
