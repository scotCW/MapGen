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
    /// Bytes received so far for the current item.
    #[serde(default)]
    pub current_bytes: u64,
    /// Content-Length of the current item, when the server sends one.
    #[serde(default)]
    pub current_total_bytes: Option<u64>,
    /// "connecting" | "downloading" | "" — lets the UI say something useful
    /// while a slow server hasn't sent the first byte yet.
    #[serde(default)]
    pub phase: String,
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
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    pub layer_id: String,
    pub layer_name: String,
    pub download_url: String,
    /// Further sources merged into the same FeatureCollection — for datasets
    /// a publisher splits across services (e.g. Wyoming state surface land).
    #[serde(default)]
    pub additional_download_urls: Vec<String>,
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
                p.current_bytes = 0;
                p.current_total_bytes = None;
                p.phase = "connecting".into();
            }

            match download_one(&app, &state_id, &item, &ds_arc).await {
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
                    p.phase = String::new();
                    p.error = Some(if e == "cancelled" {
                        "Download cancelled".into()
                    } else {
                        format!("{}: {}", item.layer_name, e)
                    });
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
        p.phase = String::new();
    });

    Ok(())
}

/// Features requested per page from an ArcGIS query endpoint. Services cap a
/// page at their maxRecordCount (2000 for the state agency layers); a smaller
/// page keeps each request short on a slow connection.
const ARCGIS_PAGE_SIZE: usize = 1000;
/// Hard stop for a runaway paging loop (1000 × 500 = 500k features).
const ARCGIS_MAX_PAGES: usize = 500;

/// Downloads a single layer to disk; returns the byte count written.
///
/// There is no overall time limit — a large layer on a slow connection can
/// legitimately take many minutes — only a connect timeout and a stall
/// timeout (no data for 90s), which is what actually indicates a dead
/// connection. ArcGIS feature-service query URLs are paged and merged into
/// one FeatureCollection; anything else is saved as served.
async fn download_one(
    app: &AppHandle,
    state_id: &str,
    item: &DownloadItem,
    ds: &Arc<DownloadState>,
) -> Result<u64, String> {
    let dir = state_data_dir(app, state_id)?;
    let dest = dir.join(format!("{}.geojson", item.layer_id));
    let tmp = dir.join(format!("{}.geojson.part", item.layer_id));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let body = if item.additional_download_urls.is_empty() {
        if is_arcgis_query(&item.download_url) {
            let features = download_arcgis_features(&client, &item.download_url, ds, 0).await?;
            feature_collection(features)?
        } else {
            fetch_body(&client, &item.download_url, ds, 0).await?
        }
    } else {
        // Several sources: fetch each and merge their features.
        let mut features = Vec::new();
        let mut received = 0u64;
        for url in std::iter::once(&item.download_url).chain(&item.additional_download_urls) {
            if is_arcgis_query(url) {
                let f = download_arcgis_features(&client, url, ds, received).await?;
                received += serde_json::to_vec(&f).map(|v| v.len() as u64).unwrap_or(0);
                features.extend(f);
            } else {
                let body = fetch_body(&client, url, ds, received).await?;
                received += body.len() as u64;
                let doc: serde_json::Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("server returned something other than GeoJSON ({e})"))?;
                features.extend(parse_arcgis_page(doc)?.0);
            }
        }
        feature_collection(features)?
    };

    let size = body.len() as u64;
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(size)
}

/// Fetches one URL into memory, reporting `base_bytes + received` as progress
/// and honouring cancellation between chunks.
async fn fetch_body(
    client: &reqwest::Client,
    url: &str,
    ds: &Arc<DownloadState>,
    base_bytes: u64,
) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(describe_net_error)?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if let Ok(mut p) = ds.progress.lock() {
        p.phase = "downloading".into();
        p.current_total_bytes = if base_bytes == 0 {
            response.content_length()
        } else {
            None // paged: the total isn't known up front
        };
    }

    let mut body = Vec::new();
    loop {
        if ds.cancel.lock().map(|c| *c).unwrap_or(false) {
            return Err("cancelled".into());
        }
        match response.chunk().await.map_err(describe_net_error)? {
            Some(chunk) => {
                body.extend_from_slice(&chunk);
                if let Ok(mut p) = ds.progress.lock() {
                    p.current_bytes = base_bytes + body.len() as u64;
                }
            }
            None => break,
        }
    }
    Ok(body)
}

/// Pages through an ArcGIS `/query?...&f=geojson` endpoint and returns all
/// of its features. `base_bytes` offsets the progress readout when this is
/// one of several sources for a layer.
async fn download_arcgis_features(
    client: &reqwest::Client,
    url: &str,
    ds: &Arc<DownloadState>,
    base_bytes: u64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut features: Vec<serde_json::Value> = Vec::new();
    let mut received: u64 = base_bytes;
    for page in 0..ARCGIS_MAX_PAGES {
        let page_url = arcgis_page_url(url, page * ARCGIS_PAGE_SIZE, ARCGIS_PAGE_SIZE);
        let body = fetch_body(client, &page_url, ds, received).await?;
        received += body.len() as u64;
        let doc: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| format!("server returned something other than GeoJSON ({e})"))?;
        let (page_features, more) = parse_arcgis_page(doc)?;
        let count = page_features.len();
        features.extend(page_features);
        if count == 0 || !more {
            break;
        }
    }
    Ok(features)
}

fn feature_collection(features: Vec<serde_json::Value>) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&serde_json::json!({
        "type": "FeatureCollection",
        "features": features,
    }))
    .map_err(|e| e.to_string())
}

fn is_arcgis_query(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("/query?") && lower.contains("f=geojson")
}

fn arcgis_page_url(base: &str, offset: usize, count: usize) -> String {
    format!("{base}&resultOffset={offset}&resultRecordCount={count}")
}

/// Splits one page into its features and whether more pages follow.
/// ArcGIS reports errors with HTTP 200 and an `error` object, and flags a
/// truncated page with `exceededTransferLimit` (top level, or under
/// `properties` in GeoJSON responses).
fn parse_arcgis_page(doc: serde_json::Value) -> Result<(Vec<serde_json::Value>, bool), String> {
    if let Some(err) = doc.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("map service error: {msg}"));
    }
    let more = doc
        .get("exceededTransferLimit")
        .or_else(|| {
            doc.get("properties")
                .and_then(|p| p.get("exceededTransferLimit"))
        })
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let features = match doc.get("features") {
        Some(serde_json::Value::Array(f)) => f.clone(),
        _ => return Err("server response has no features list".into()),
    };
    Ok((features, more))
}

fn describe_net_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out — the connection stalled. Check your network and try again.".into()
    } else if e.is_connect() {
        format!("could not connect ({e}). Check your network and try again.")
    } else {
        e.to_string()
    }
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

/// Returns a downloaded layer's GeoJSON as raw bytes, for the map to draw.
/// Sent as a binary IPC response so multi-megabyte state datasets aren't
/// re-encoded as a JSON string on the way across.
#[tauri::command]
pub fn read_layer_data(
    app: AppHandle,
    state_id: String,
    layer_id: String,
) -> Result<tauri::ipc::Response, String> {
    // Both ids become path components; refuse anything that could leave the
    // state's data directory.
    let safe = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !safe(&state_id) || !safe(&layer_id) {
        return Err("Invalid layer id".into());
    }
    let dir = state_data_dir(&app, &state_id)?;
    let file = dir.join(format!("{}.geojson", layer_id));
    let bytes = std::fs::read(&file).map_err(|e| format!("{layer_id} is not downloaded ({e})"))?;
    Ok(tauri::ipc::Response::new(bytes))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend sends `items` exactly like this (src/types/data.ts
    /// DownloadItem). Tauri only renames top-level command arguments, so the
    /// nested fields must deserialize from camelCase themselves — before
    /// 0.0.4 this failed with "missing field `layer_id`" and every download
    /// was rejected.
    #[test]
    fn download_items_deserialize_from_frontend_camel_case() {
        let json = r#"[{"layerId":"padus","layerName":"PAD-US","downloadUrl":"https://example.com/a.geojson"}]"#;
        let items: Vec<DownloadItem> = serde_json::from_str(json).expect("camelCase payload");
        assert_eq!(items[0].layer_id, "padus");
        assert_eq!(items[0].layer_name, "PAD-US");
        assert_eq!(items[0].download_url, "https://example.com/a.geojson");
        assert!(items[0].additional_download_urls.is_empty());

        let json = r#"[{"layerId":"x","layerName":"X","downloadUrl":"https://a","additionalDownloadUrls":["https://b"]}]"#;
        let items: Vec<DownloadItem> = serde_json::from_str(json).unwrap();
        assert_eq!(
            items[0].additional_download_urls,
            vec!["https://b".to_string()]
        );
    }

    #[test]
    fn detects_arcgis_geojson_queries() {
        assert!(is_arcgis_query(
            "https://x/FeatureServer/5/query?where=1%3D1&outFields=*&f=geojson"
        ));
        assert!(!is_arcgis_query("https://x/data.geojson"));
        assert!(!is_arcgis_query(
            "https://x/FeatureServer/5/query?where=1%3D1&f=json"
        ));
        assert_eq!(
            arcgis_page_url("https://x/query?f=geojson", 2000, 1000),
            "https://x/query?f=geojson&resultOffset=2000&resultRecordCount=1000"
        );
    }

    #[test]
    fn parses_arcgis_pages() {
        let page = serde_json::json!({
            "type": "FeatureCollection",
            "features": [{"type": "Feature"}, {"type": "Feature"}],
            "properties": {"exceededTransferLimit": true}
        });
        let (f, more) = parse_arcgis_page(page).unwrap();
        assert_eq!((f.len(), more), (2, true));

        let last =
            serde_json::json!({"type": "FeatureCollection", "features": [{"type": "Feature"}]});
        assert!(!parse_arcgis_page(last).unwrap().1);

        // ArcGIS returns errors with HTTP 200.
        let err = serde_json::json!({"error": {"code": 400, "message": "Invalid query"}});
        assert!(parse_arcgis_page(err)
            .unwrap_err()
            .contains("Invalid query"));
    }
}
