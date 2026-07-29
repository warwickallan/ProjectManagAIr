ALTER TABLE projects ADD COLUMN external_path TEXT;
ALTER TABLE projects ADD COLUMN folder_name TEXT;

CREATE TABLE IF NOT EXISTS project_storage_settings (
  id TEXT PRIMARY KEY CHECK (id = 'local'),
  projects_root TEXT,
  project_folder_naming_format TEXT NOT NULL DEFAULT '{code} - {name}',
  verified_at TEXT,
  last_write_test_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO project_storage_settings (id, projects_root, project_folder_naming_format, updated_at)
VALUES ('local', NULL, '{code} - {name}', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS project_source_intake (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL,
  original_received_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_type TEXT NOT NULL,
  current_external_path TEXT NOT NULL,
  previous_external_path TEXT,
  processing_status TEXT NOT NULL,
  processor_provider TEXT NOT NULL,
  extracted_item_ids_json TEXT NOT NULL DEFAULT '[]',
  review_state TEXT NOT NULL DEFAULT 'proposed',
  verification_state TEXT NOT NULL DEFAULT 'not-started',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, content_hash)
);

CREATE TABLE IF NOT EXISTS source_processing_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES project_source_intake(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  structured_output_contract TEXT NOT NULL,
  proposed_change_id TEXT
);

CREATE TABLE IF NOT EXISTS proposed_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES project_source_intake(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  proposed_change_id TEXT NOT NULL REFERENCES proposed_changes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES project_source_intake(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS source_file_history (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES project_source_intake(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_external_path TEXT,
  to_external_path TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_entity_provenance (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES project_source_intake(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_source_intake_project ON project_source_intake(project_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_source_processing_jobs_source ON source_processing_jobs(source_id, status);
CREATE INDEX IF NOT EXISTS idx_proposed_changes_project_status ON proposed_changes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_source_entity_provenance_entity ON source_entity_provenance(project_id, entity_type, entity_id);
