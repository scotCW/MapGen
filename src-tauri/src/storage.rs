use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/// `serde(default)` matters here beyond tidiness: settings.json is documented as
/// hand-editable, and `base_data_dir` silently falls back to the default
/// location when this fails to parse. Without per-field defaults, one missing
/// key would make a relocated data directory — and every project in it — appear
/// to vanish. It also keeps older settings files loading as fields are added.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub version: u32,
    pub theme: String,                   // "light" | "dark" | "system"
    pub units: String,                   // "imperial" | "metric"
    pub difficulty: String,              // "beginner" | "intermediate" | "advanced"
    pub data_location: Option<String>,   // null → use OS app-data dir
    pub online_by_default: bool,
    pub snapshot_retention: u32,         // number of snapshots to keep
    pub currency_warning_months: u32,    // flag data older than this
    pub default_dpi: u32,               // 150 | 200 | 300 | 400
    pub auto_open_folder_after_export: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: 1,
            theme: "system".into(),
            units: "imperial".into(),
            difficulty: "beginner".into(),
            data_location: None,
            online_by_default: true,
            snapshot_retention: 20,
            currency_warning_months: 12,
            default_dpi: 200,
            auto_open_folder_after_export: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Returns the base data directory.
/// Always reads from the settings.json in the DEFAULT app-data dir first,
/// so we know where to look even when the user has relocated data.
pub fn base_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot determine app data directory: {e}"))?;

    let settings_path = default_dir.join("settings").join("settings.json");
    if settings_path.exists() {
        if let Ok(text) = fs::read_to_string(&settings_path) {
            if let Ok(s) = serde_json::from_str::<AppSettings>(&text) {
                if let Some(custom) = s.data_location {
                    let p = PathBuf::from(&custom);
                    if p.exists() {
                        return Ok(p);
                    }
                }
            }
        }
    }

    Ok(default_dir)
}

// ---------------------------------------------------------------------------
// Startup initialisation
// ---------------------------------------------------------------------------

/// Creates the full directory tree and a default settings.json on first run.
/// Safe to call on every launch — already-existing dirs are skipped.
pub fn init_directories(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let base = app.path().app_data_dir()?;

    for sub in &[
        "projects",
        "data",
        "settings",
        "presets",
        "regions",
        "access-rules",
        "logs",
    ] {
        fs::create_dir_all(base.join(sub))?;
    }

    // Write default settings.json only on first launch
    let settings_path = base.join("settings").join("settings.json");
    if !settings_path.exists() {
        let json = serde_json::to_string_pretty(&AppSettings::default())?;
        fs::write(&settings_path, json)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    base_data_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = base.join("settings").join("settings.json");

    if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    } else {
        Ok(AppSettings::default())
    }
}

// ---------------------------------------------------------------------------
// App log (Stage 22)
// ---------------------------------------------------------------------------

/// Appends a timestamped line to logs/app.log (max 2000 lines retained).
#[tauri::command]
pub fn write_app_log(app: AppHandle, message: String) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_path = base.join("logs").join("app.log");
    fs::create_dir_all(log_path.parent().unwrap()).map_err(|e| e.to_string())?;

    let ts = Utc::now().to_rfc3339();
    let line = format!("[{ts}] {message}\n");

    use std::io::{Read, Write};
    let mut content = String::new();
    if log_path.exists() {
        let mut f = std::fs::File::open(&log_path).map_err(|e| e.to_string())?;
        f.read_to_string(&mut content).map_err(|e| e.to_string())?;
    }
    content.push_str(&line);

    // Trim to last 2000 lines
    let lines: Vec<&str> = content.lines().collect();
    let trimmed = if lines.len() > 2000 {
        lines[lines.len() - 2000..].join("\n") + "\n"
    } else {
        content
    };

    let mut f = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    f.write_all(trimmed.as_bytes()).map_err(|e| e.to_string())
}

/// Returns the last N lines of the app log (default 200).
#[tauri::command]
pub fn read_app_log(app: AppHandle, lines: Option<usize>) -> Result<String, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_path = base.join("logs").join("app.log");
    if !log_path.exists() {
        return Ok(String::new());
    }
    let content = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let n = lines.unwrap_or(200);
    let all: Vec<&str> = content.lines().collect();
    let slice = if all.len() > n { &all[all.len() - n..] } else { &all[..] };
    Ok(slice.join("\n"))
}

/// Merges a single key/value pair into settings.json.
#[tauri::command]
pub fn set_setting(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = base.join("settings").join("settings.json");

    let mut doc: serde_json::Value = if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())?
    } else {
        serde_json::to_value(AppSettings::default()).map_err(|e| e.to_string())?
    };

    if let serde_json::Value::Object(ref mut map) = doc {
        map.insert(key, value);
    }

    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    /// settings.json is documented as hand-editable, and a parse failure makes
    /// `base_data_dir` silently ignore a relocated data directory. A file
    /// missing keys must therefore still load.
    #[test]
    fn partial_settings_file_loads_with_defaults() {
        let json = r#"{"dataLocation":"/Volumes/Maps","units":"metric"}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.data_location.as_deref(), Some("/Volumes/Maps"),
            "a relocated data directory must survive a partial file");
        assert_eq!(s.units, "metric");
        // everything absent falls back to the defaults
        assert_eq!(s.theme, "system");
        assert_eq!(s.snapshot_retention, 20);
        assert_eq!(s.default_dpi, 200);
    }

    /// An empty object is still valid and yields defaults throughout.
    #[test]
    fn empty_settings_file_loads_defaults() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.theme, AppSettings::default().theme);
        assert_eq!(s.data_location, None);
    }

    /// Unknown keys (set_setting writes app-specific ones like
    /// hide_access_disclaimer) must not break parsing.
    #[test]
    fn unknown_keys_are_ignored() {
        let json = r#"{"theme":"dark","hide_access_disclaimer":true,"somethingNew":42}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.theme, "dark");
    }

    /// A full round-trip still works, so writing then reading is stable.
    #[test]
    fn round_trips_full_settings() {
        let original = AppSettings {
            data_location: Some("/tmp/x".into()),
            snapshot_retention: 5,
            ..AppSettings::default()
        };
        let text = serde_json::to_string(&original).unwrap();
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.data_location, original.data_location);
        assert_eq!(back.snapshot_retention, 5);
    }
}
