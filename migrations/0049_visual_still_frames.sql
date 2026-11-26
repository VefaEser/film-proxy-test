-- Visual analysis: selected source images are film stills, not posters/backdrops.
-- Rebuild the two CHECK-constrained tables to admit the new still_frame type.
CREATE TABLE visual_profile_fields_new (
  movie_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL,
  sample_count INTEGER DEFAULT 1,
  source_type TEXT NOT NULL CHECK(source_type IN ('poster','backdrop','promotional_image','trailer','clip','full_film','still_frame')),
  model_name TEXT,
  model_version TEXT,
  analyzed_at INTEGER NOT NULL,
  PRIMARY KEY (movie_id, field_name)
);
INSERT INTO visual_profile_fields_new SELECT * FROM visual_profile_fields;
DROP TABLE visual_profile_fields;
ALTER TABLE visual_profile_fields_new RENAME TO visual_profile_fields;
CREATE INDEX IF NOT EXISTS idx_visual_fields_movie ON visual_profile_fields(movie_id);
CREATE INDEX IF NOT EXISTS idx_visual_fields_name ON visual_profile_fields(field_name);

CREATE TABLE visual_samples_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('poster','backdrop','promotional_image','trailer','clip','full_film','still_frame')),
  source_url TEXT NOT NULL,
  source_id TEXT,
  source_name TEXT,
  license TEXT,
  attribution TEXT,
  match_confidence REAL,
  image_hash TEXT,
  sample_timestamp REAL,
  created_at INTEGER NOT NULL
);
INSERT INTO visual_samples_new SELECT * FROM visual_samples;
DROP TABLE visual_samples;
ALTER TABLE visual_samples_new RENAME TO visual_samples;
CREATE INDEX IF NOT EXISTS idx_visual_samples_movie ON visual_samples(movie_id, source_type);
CREATE INDEX IF NOT EXISTS idx_visual_samples_hash ON visual_samples(image_hash);
CREATE INDEX IF NOT EXISTS idx_visual_samples_movie_order ON visual_samples(movie_id, id);
