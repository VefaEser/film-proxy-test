-- Persist the still-frame source policy so legacy image sets are rebuilt once,
-- and successful/empty source checks are not repeated on every gallery request.
CREATE TABLE IF NOT EXISTS visual_sample_sets (
  movie_id TEXT PRIMARY KEY,
  policy_version INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_visual_sample_sets_checked
  ON visual_sample_sets(checked_at);
