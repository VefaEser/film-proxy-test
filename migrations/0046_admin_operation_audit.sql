
-- 0046_admin_operation_audit.sql
-- Yönetici ve yetkili yönetici işlemlerinin denetlenmesi.
-- CSV oturumlarında gerçek dosya boyutunu saklamak.

ALTER TABLE csv_import_sessions
ADD COLUMN file_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS admin_operation_logs (
    operation_id TEXT PRIMARY KEY,
    actor_user_id INTEGER NOT NULL,
    permission TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    requested_count INTEGER NOT NULL DEFAULT 0,
    succeeded_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT NOT NULL DEFAULT '{}',
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_operation_actor
ON admin_operation_logs(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_operation_type
ON admin_operation_logs(operation_type, created_at DESC);
