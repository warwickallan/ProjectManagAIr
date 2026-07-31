ALTER TABLE project_register_rows ADD COLUMN derivation TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE project_register_rows ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE project_register_rows ADD COLUMN first_seen_source_id TEXT;
ALTER TABLE project_register_rows ADD COLUMN last_updated_source_id TEXT;
ALTER TABLE project_register_rows ADD COLUMN due_date_raw TEXT;
ALTER TABLE project_register_rows ADD COLUMN due_date_confidence TEXT NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS project_register_revisions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS register_changesets (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL REFERENCES extraction_packets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  gate_verdict TEXT NOT NULL,
  gate_report_json TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  acknowledged_at TEXT,
  applied_at TEXT,
  base_register_revision INTEGER NOT NULL,
  deterministic_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS register_change_ops (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES register_changesets(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL,
  register_name TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  target_external_id TEXT,
  allocated_external_id TEXT,
  proposed_row_json TEXT NOT NULL,
  field_diff_json TEXT NOT NULL,
  anchors_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  derivation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  UNIQUE(changeset_id, seq)
);

CREATE TABLE IF NOT EXISTS register_row_anchors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  speaker TEXT,
  t_ms INTEGER,
  quote TEXT,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS register_row_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  field TEXT,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  evidence_ref TEXT,
  source_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS register_row_state (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  register_name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  resolution TEXT,
  last_human_event_at TEXT,
  last_source_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, external_register_id)
);

CREATE TABLE IF NOT EXISTS id_allocations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  PRIMARY KEY(project_id, prefix)
);

CREATE INDEX IF NOT EXISTS idx_changesets_project_review ON register_changesets(project_id, review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_ops_changeset_status ON register_change_ops(changeset_id, status);
CREATE INDEX IF NOT EXISTS idx_register_anchors_row ON register_row_anchors(project_id, external_register_id);
CREATE INDEX IF NOT EXISTS idx_register_events_row_time ON register_row_events(project_id, external_register_id, occurred_at);
