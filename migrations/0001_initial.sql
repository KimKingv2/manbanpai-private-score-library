PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  key_signature TEXT NOT NULL DEFAULT '',
  time_signature TEXT NOT NULL DEFAULT '',
  tempo_bpm TEXT NOT NULL DEFAULT '',
  measure_count TEXT NOT NULL DEFAULT '',
  file_url TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('piano','guitar-vocal','guitar-fingerstyle')),
  category TEXT NOT NULL DEFAULT '未分類',
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  updated_at INTEGER NOT NULL,
  source_file_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_scores_title ON scores(title);
CREATE INDEX IF NOT EXISTS idx_scores_category ON scores(category);
CREATE INDEX IF NOT EXISTS idx_scores_favorite ON scores(favorite);

CREATE TABLE IF NOT EXISTS score_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.recordare.musicxml+xml',
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_assets (
  object_key TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  license_name TEXT NOT NULL,
  attribution TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
