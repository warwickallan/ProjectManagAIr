CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intake_source_id TEXT REFERENCES project_source_intake(id) ON DELETE SET NULL,
  content_hash TEXT NOT NULL,
  source_type TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  immutable_path TEXT NOT NULL,
  event_date TEXT,
  duration_ms INTEGER,
  word_count INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  participants_json TEXT NOT NULL DEFAULT '[]',
  normaliser_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, content_hash)
);

CREATE TABLE IF NOT EXISTS source_segments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  speaker TEXT,
  t_start_ms INTEGER,
  t_end_ms INTEGER,
  message_id TEXT,
  sender TEXT,
  sent_at TEXT,
  page INTEGER,
  section TEXT,
  para_index INTEGER,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  window_id TEXT,
  UNIQUE(source_id, seq)
);

CREATE TABLE IF NOT EXISTS source_windows (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  explanation TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_id, seq)
);

CREATE TABLE IF NOT EXISTS source_markers (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  segment_seq INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  marker_type TEXT NOT NULL,
  matched_text TEXT NOT NULL,
  discharged_by_item_ref TEXT,
  dismissal_reason TEXT
);

ALTER TABLE source_processing_jobs ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE source_processing_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_processing_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 2;
ALTER TABLE source_processing_jobs ADD COLUMN queued_at TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN updated_at TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN packet_id TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN changeset_id TEXT;

CREATE INDEX IF NOT EXISTS idx_source_documents_project_created ON source_documents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_segments_source_seq ON source_segments(source_id, seq);
CREATE INDEX IF NOT EXISTS idx_source_windows_source_seq ON source_windows(source_id, seq);
CREATE INDEX IF NOT EXISTS idx_source_markers_source_confidence ON source_markers(source_id, confidence);
