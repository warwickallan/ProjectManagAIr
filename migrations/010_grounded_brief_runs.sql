CREATE TABLE IF NOT EXISTS consultant_brief_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brief_id TEXT,
  selection_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consultant_brief_runs_project_selection
ON consultant_brief_runs(project_id, selection_hash, created_at DESC);