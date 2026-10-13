mod data;
mod migrations;
mod presets;
mod projects;
mod storage;

use std::sync::Arc;
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial_schema",
        // LF-normalised so the checksum sqlx stores doesn't depend on how git
        // checked the file out (see migrations.rs).
        sql: migrations::initial_sql(),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:catalog.db", migrations)
                .build(),
        )
        .manage(Arc::new(data::DownloadState::default()))
        .setup(|app| {
            storage::init_directories(app.handle())
                .map_err(|e| format!("Storage init failed: {e}"))?;
            // Before the frontend opens catalog.db (which runs migrations).
            migrations::repair_catalog(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::get_data_dir,
            storage::get_settings,
            storage::set_setting,
            projects::list_projects,
            projects::create_project,
            projects::fork_project,
            projects::rename_project,
            projects::delete_project,
            projects::get_project,
            projects::save_format_settings,
            projects::save_layer_settings,
            projects::save_area_settings,
            projects::save_map_elements,
            projects::save_state_selection,
            projects::save_notes,
            projects::save_export,
            projects::get_export_history,
            projects::reveal_in_finder,
            projects::save_snapshot,
            projects::list_snapshots,
            projects::restore_snapshot,
            projects::delete_snapshot,
            projects::export_huntmap,
            projects::import_huntmap,
            presets::save_preset,
            presets::list_presets,
            presets::apply_preset,
            presets::delete_preset,
            storage::write_app_log,
            storage::read_app_log,
            data::list_downloaded_layers,
            data::start_download,
            data::get_download_progress,
            data::cancel_download,
            data::delete_layer_data,
            data::read_layer_data,
            data::get_data_disk_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hunting Map Generator");
}
