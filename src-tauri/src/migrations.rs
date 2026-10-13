//! SQLite catalog migrations, plus a repair for line-ending-dependent
//! checksums.
//!
//! sqlx stores a SHA-384 of each migration's exact SQL text and refuses to
//! start ("migration 1 was previously applied but has been modified") if the
//! embedded text later hashes differently. `include_str!` embeds whatever
//! line endings the checkout has, and a Windows checkout with
//! `core.autocrlf=true` turns LF into CRLF — so the v0.0.2–v0.0.4 Windows
//! builds embedded a CRLF copy and couldn't open catalogs created by LF
//! builds (and vice versa).

use std::path::Path;
use std::sync::OnceLock;

use sha2::{Digest, Sha384};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row};
use tauri::{AppHandle, Manager};

const INITIAL_SQL_RAW: &str = include_str!("../migrations/001_initial.sql");

/// Migration 1 with LF line endings, whatever the checkout used. LF is the
/// canonical form: it's what the repository stores and what the macOS and
/// pre-0.0.2 builds embedded.
pub fn initial_sql() -> &'static str {
    static SQL: OnceLock<String> = OnceLock::new();
    SQL.get_or_init(|| INITIAL_SQL_RAW.replace("\r\n", "\n"))
}

fn sha384(text: &str) -> Vec<u8> {
    Sha384::digest(text.as_bytes()).to_vec()
}

/// Rewrites migration 1's stored checksum from the CRLF variant to the LF
/// one, so catalogs created by a CRLF-embedding build open again. Only ever
/// swaps one known checksum for the other — any other mismatch is left for
/// sqlx to report. Returns true if a row was repaired.
pub fn repair_line_ending_checksum(db_path: &Path) -> Result<bool, String> {
    if !db_path.exists() {
        return Ok(false);
    }
    let lf = initial_sql();
    let crlf = lf.replace('\n', "\r\n");
    let (lf_sum, crlf_sum) = (sha384(lf), sha384(&crlf));
    let path = db_path.to_path_buf();

    tauri::async_runtime::block_on(async move {
        let mut conn = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false)
            .connect()
            .await
            .map_err(|e| e.to_string())?;

        let has_table = sqlx::query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
        )
        .fetch_optional(&mut conn)
        .await
        .map_err(|e| e.to_string())?
        .is_some();
        if !has_table {
            conn.close().await.ok();
            return Ok(false);
        }

        let stored: Option<Vec<u8>> =
            sqlx::query("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                .fetch_optional(&mut conn)
                .await
                .map_err(|e| e.to_string())?
                .map(|row| row.get::<Vec<u8>, _>(0));

        let repaired = if stored.as_deref() == Some(crlf_sum.as_slice()) {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
                .bind(lf_sum)
                .execute(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            true
        } else {
            false
        };
        conn.close().await.ok();
        Ok(repaired)
    })
}

/// Runs the repair on the catalog tauri-plugin-sql opens for
/// "sqlite:catalog.db" (it resolves that against the app config dir).
pub fn repair_catalog(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    match repair_line_ending_checksum(&dir.join("catalog.db")) {
        Ok(true) => eprintln!("catalog.db: repaired migration 1 checksum (CRLF build)"),
        Ok(false) => {}
        Err(e) => eprintln!("catalog.db: checksum repair skipped: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_sql_is_lf_only() {
        assert!(!initial_sql().contains('\r'));
        assert!(initial_sql().contains("CREATE TABLE IF NOT EXISTS projects"));
    }

    fn temp_db(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("hmg-mig-{}-{name}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn seed(path: &Path, checksum: Vec<u8>) {
        let path = path.to_path_buf();
        tauri::async_runtime::block_on(async move {
            let mut conn = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT, \
                 installed_on TIMESTAMP, success BOOLEAN, checksum BLOB, execution_time BIGINT)",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            sqlx::query("INSERT INTO _sqlx_migrations VALUES (1, 'initial_schema', 0, 1, ?, 0)")
                .bind(checksum)
                .execute(&mut conn)
                .await
                .unwrap();
            conn.close().await.unwrap();
        });
    }

    fn stored(path: &Path) -> Vec<u8> {
        let path = path.to_path_buf();
        tauri::async_runtime::block_on(async move {
            let mut conn = SqliteConnectOptions::new()
                .filename(&path)
                .connect()
                .await
                .unwrap();
            let v: Vec<u8> = sqlx::query("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .get(0);
            conn.close().await.unwrap();
            v
        })
    }

    #[test]
    fn crlf_checksum_is_rewritten_to_lf() {
        let db = temp_db("crlf");
        seed(&db, sha384(&initial_sql().replace('\n', "\r\n")));
        assert!(repair_line_ending_checksum(&db).unwrap());
        assert_eq!(stored(&db), sha384(initial_sql()));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn lf_and_unknown_checksums_are_left_alone() {
        let db = temp_db("lf");
        seed(&db, sha384(initial_sql()));
        assert!(!repair_line_ending_checksum(&db).unwrap());
        let _ = std::fs::remove_file(&db);

        let db = temp_db("other");
        seed(&db, vec![1, 2, 3]);
        assert!(!repair_line_ending_checksum(&db).unwrap());
        assert_eq!(stored(&db), vec![1, 2, 3]);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn missing_db_is_a_no_op() {
        assert!(!repair_line_ending_checksum(&temp_db("missing")).unwrap());
    }
}
