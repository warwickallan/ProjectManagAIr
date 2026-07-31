CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  skill_sha256 TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  output_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS extraction_packets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  packet_contract_version INTEGER NOT NULL,
  source_normaliser_version TEXT NOT NULL,
  database_schema_version TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  reconciliation_engine_version TEXT NOT NULL,
  current_state_projector_version TEXT NOT NULL,
  scoring_configuration_version TEXT NOT NULL,
  skill_sha256 TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  assembled_at TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  validation_report_json TEXT NOT NULL,
  base_register_revision INTEGER NOT NULL,
  UNIQUE(project_id, packet_sha256)
);

CREATE TABLE IF NOT EXISTS packet_coverage (
  packet_id TEXT NOT NULL REFERENCES extraction_packets(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  explanation TEXT,
  PRIMARY KEY(packet_id, scope, key)
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_source_stage ON extraction_runs(source_id, stage);
CREATE INDEX IF NOT EXISTS idx_extraction_packets_project_created ON extraction_packets(project_id, assembled_at DESC);
