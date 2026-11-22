-- 0045_resumable_csv_imports.sql
-- Kullanıcı ve admin CSV aktarımlarının dosya özetiyle kaldığı yerden sürdürülmesi.
-- Bu migration yalnızca yeni tablolar ekler; mevcut tabloları silmez/değiştirmez.
CREATE TABLE IF NOT EXISTS csv_import_sessions (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','admin')),
  owner_id INTEGER NOT NULL,
  list_type TEXT NOT NULL DEFAULT '',
  file_hash TEXT NOT NULL,
  file_name TEXT,
  source_dataset TEXT,
  source_revision TEXT,
  total_rows INTEGER NOT NULL,
  next_row INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','stopped','completed','cancelled','failed')),
  added_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  conflict_rows INTEGER NOT NULL DEFAULT 0,
  rated_rows INTEGER NOT NULL DEFAULT 0,
  inserted_rows INTEGER NOT NULL DEFAULT 0,
  error_log TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(owner_type, owner_id, list_type, file_hash)
);
CREATE INDEX IF NOT EXISTS idx_csv_import_sessions_owner
  ON csv_import_sessions(owner_type, owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_csv_import_sessions_status
  ON csv_import_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS csv_import_session_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_row INTEGER NOT NULL,
  end_row INTEGER NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, chunk_index),
  FOREIGN KEY(session_id) REFERENCES csv_import_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_csv_import_chunks_session
  ON csv_import_session_chunks(session_id, chunk_index);
