PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO app_config (key, value) VALUES
  ('current_user_id', 'current-user'),
  ('current_user_display_name', NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  summary TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  stage TEXT NOT NULL,
  owner TEXT NOT NULL,
  start_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  next_milestone_id TEXT,
  updated_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  data_classification TEXT NOT NULL DEFAULT 'operational-reference',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  label TEXT NOT NULL,
  external_path TEXT NOT NULL,
  last_seen_at TEXT,
  data_classification TEXT NOT NULL DEFAULT 'operational-reference'
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  priority TEXT NOT NULL,
  due_date TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT,
  attention_reason TEXT
);

CREATE TABLE IF NOT EXISTS risks_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  likelihood TEXT,
  impact TEXT NOT NULL,
  response TEXT NOT NULL,
  target_resolution_date TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  change_type TEXT NOT NULL,
  impact TEXT NOT NULL,
  decision_id TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT,
  attention_reason TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  decision_status TEXT NOT NULL,
  decision_needed_by TEXT,
  options_summary TEXT NOT NULL,
  outcome TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT
);

CREATE TABLE IF NOT EXISTS open_questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_needed_by TEXT,
  blocking INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_date TEXT NOT NULL,
  milestone_status TEXT NOT NULL,
  completion_percent INTEGER NOT NULL,
  work_package_ids_json TEXT NOT NULL DEFAULT '[]',
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT
);

CREATE TABLE IF NOT EXISTS work_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  work_package_status TEXT NOT NULL,
  lead TEXT NOT NULL,
  start_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  completion_percent INTEGER NOT NULL,
  blocker_summary TEXT,
  milestone_id TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor TEXT NOT NULL,
  related_entity_type TEXT NOT NULL,
  related_entity_id TEXT NOT NULL,
  data_classification TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  summary TEXT NOT NULL,
  deliverable_type TEXT NOT NULL,
  external_path TEXT,
  due_date TEXT,
  needs_user_attention INTEGER NOT NULL DEFAULT 0,
  attention_owner TEXT,
  attention_reason TEXT
);

CREATE TABLE IF NOT EXISTS ai_writes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  related_entity_type TEXT NOT NULL,
  related_entity_id TEXT NOT NULL,
  write_status TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  verification_method TEXT,
  last_attempt_at TEXT,
  verified_at TEXT,
  verified_by TEXT,
  status_detail TEXT NOT NULL,
  attention_owner TEXT,
  data_classification TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ai_write_id TEXT REFERENCES ai_writes(id) ON DELETE SET NULL,
  verification_status TEXT NOT NULL,
  method TEXT,
  checked_at TEXT,
  checked_by TEXT,
  summary TEXT NOT NULL,
  data_classification TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance_file_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  external_path TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  captured_at TEXT,
  data_classification TEXT NOT NULL DEFAULT 'operational-reference'
);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  importer_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  records_written INTEGER NOT NULL DEFAULT 0,
  source_label TEXT,
  source_external_path TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);
CREATE INDEX IF NOT EXISTS idx_risks_issues_project ON risks_issues(project_id);
CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_open_questions_project ON open_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_work_packages_project ON work_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_project_time ON activity_events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_writes_project ON ai_writes(project_id);
CREATE INDEX IF NOT EXISTS idx_provenance_project_entity ON provenance_file_refs(project_id, entity_type, entity_id);
