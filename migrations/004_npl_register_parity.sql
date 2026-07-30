ALTER TABLE projects ADD COLUMN storage_schema_version TEXT NOT NULL DEFAULT 'project-storage-v1';

CREATE TABLE IF NOT EXISTS project_register_import_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  packet_type TEXT NOT NULL,
  packet_version INTEGER NOT NULL,
  project_code TEXT NOT NULL,
  source_workbook_name TEXT,
  source_workbook_hash TEXT,
  benchmark_json_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  records_total INTEGER NOT NULL DEFAULT 0,
  records_imported INTEGER NOT NULL DEFAULT 0,
  blocking_errors_json TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL DEFAULT 'not-started',
  raw_packet_json TEXT NOT NULL,
  UNIQUE(project_id, benchmark_json_hash)
);

CREATE TABLE IF NOT EXISTS project_register_rows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  register_name TEXT NOT NULL,
  external_register_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  record_status TEXT NOT NULL,
  record_type TEXT,
  owner TEXT,
  due_date TEXT,
  source_ref TEXT,
  source_anchor TEXT,
  original_status_wording TEXT,
  related_ids_json TEXT NOT NULL DEFAULT '[]',
  supersession_ids_json TEXT NOT NULL DEFAULT '[]',
  work_package_tags_json TEXT NOT NULL DEFAULT '[]',
  import_run_id TEXT NOT NULL REFERENCES project_register_import_runs(id) ON DELETE CASCADE,
  source_id TEXT,
  original_row_number INTEGER,
  original_tab_name TEXT NOT NULL,
  raw_row_json TEXT NOT NULL,
  normalized_row_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, external_register_id)
);

CREATE TABLE IF NOT EXISTS project_register_row_fields (
  id TEXT PRIMARY KEY,
  register_row_id TEXT NOT NULL REFERENCES project_register_rows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  register_name TEXT NOT NULL,
  external_register_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  original_value_json TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  UNIQUE(register_row_id, field_name)
);

CREATE TABLE IF NOT EXISTS register_decision_details (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  rationale TEXT,
  options_summary TEXT,
  outcome TEXT,
  decision_needed_by TEXT
);

CREATE TABLE IF NOT EXISTS register_risk_issue_details (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  driver TEXT,
  evidence TEXT,
  impact TEXT,
  mitigation TEXT,
  likelihood TEXT,
  severity TEXT
);

CREATE TABLE IF NOT EXISTS register_config_change_details (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  environment TEXT,
  change_type TEXT,
  follow_through TEXT,
  impact TEXT
);

CREATE TABLE IF NOT EXISTS register_open_question_details (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  question TEXT,
  parked_with TEXT,
  unblocked_by TEXT,
  blocking INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS register_milestone_details (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  target_date TEXT,
  milestone_status TEXT,
  conditional_logic TEXT
);

CREATE TABLE IF NOT EXISTS register_entities (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_type TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  alias_confidence TEXT,
  disambiguation_note TEXT,
  UNIQUE(project_id, external_register_id)
);

CREATE TABLE IF NOT EXISTS register_uncertainty (
  register_row_id TEXT PRIMARY KEY REFERENCES project_register_rows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  why_uncertain TEXT NOT NULL,
  resolve_by TEXT,
  status TEXT NOT NULL,
  UNIQUE(project_id, external_register_id)
);

CREATE TABLE IF NOT EXISTS project_register_comparison_results (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES project_register_import_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  register_name TEXT NOT NULL,
  external_register_id TEXT,
  field_name TEXT,
  comparison_status TEXT NOT NULL,
  source_value_json TEXT,
  sqlite_value_json TEXT,
  normalized_source_value TEXT,
  normalized_sqlite_value TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_register_rows_project_register ON project_register_rows(project_id, register_name, external_register_id);
CREATE INDEX IF NOT EXISTS idx_project_register_fields_row ON project_register_row_fields(register_row_id, field_name);
CREATE INDEX IF NOT EXISTS idx_register_comparison_project ON project_register_comparison_results(project_id, register_name, comparison_status);
