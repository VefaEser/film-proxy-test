-- Durable per-record work items for resumable administrator bulk operations.
-- Execution is at-least-once; handlers must remain idempotent.
CREATE TABLE IF NOT EXISTS admin_task_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(task_id, item_key),
  FOREIGN KEY(task_id) REFERENCES admin_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_task_items_claim
  ON admin_task_items(status, lease_until, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_task_items_task_status
  ON admin_task_items(task_id, status, created_at);
