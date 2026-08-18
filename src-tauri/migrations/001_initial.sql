-- Project catalog: fast index for the Projects screen.
-- The canonical data lives in project.json; this is the query layer.
CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    state           TEXT,
    counties        TEXT,           -- JSON array of county names
    area_size_km2   REAL,
    sheet_count     INTEGER NOT NULL DEFAULT 1,
    last_modified   TEXT NOT NULL,  -- ISO-8601
    created_at      TEXT NOT NULL,  -- ISO-8601
    forked_from_id  TEXT,
    forked_from_name TEXT,
    thumbnail_path  TEXT,
    FOREIGN KEY (forked_from_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- Downloaded layer manifest: tracks what's on disk, source dates, checksums.
CREATE TABLE IF NOT EXISTS download_manifest (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    state           TEXT NOT NULL,
    county          TEXT NOT NULL,
    layer           TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    source_date     TEXT,           -- ISO-8601 date from the data provider
    file_size       INTEGER,        -- bytes
    checksum        TEXT,           -- SHA-256 hex
    downloaded_at   TEXT NOT NULL,  -- ISO-8601
    status          TEXT NOT NULL DEFAULT 'complete', -- complete | partial | stale
    UNIQUE(state, county, layer)
);

-- Key/value settings index (mirrors settings.json for fast reads).
-- settings.json is the source of truth; this is kept in sync.
CREATE TABLE IF NOT EXISTS settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL   -- JSON-encoded value
);
