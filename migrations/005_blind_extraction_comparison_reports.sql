CREATE TABLE IF NOT EXISTS blind_extraction_comparison_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposed_change_id TEXT REFERENCES proposed_changes(id) ON DELETE SET NULL,
  frozen_packet_hash TEXT NOT NULL,
  expected_delta_hash TEXT NOT NULL,
  expected_workbook_hash TEXT,
  comparison_status TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  report_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(project_id, frozen_packet_hash, expected_delta_hash)
);

CREATE INDEX IF NOT EXISTS idx_blind_comparison_project_created ON blind_extraction_comparison_reports(project_id, created_at DESC);
