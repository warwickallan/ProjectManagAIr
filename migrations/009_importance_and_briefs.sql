CREATE TABLE IF NOT EXISTS scoring_config (
  version TEXT PRIMARY KEY,
  weights_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO scoring_config (version, weights_json, active, created_at)
VALUES (
  'source-intelligence-score-v1',
  '{"type":{"blocker":100,"decision-needed":90,"risk-issue":80,"action":70,"question":60,"config-change":40,"milestone":40,"uncertainty":30,"entity":10,"source":0},"severity":{"critical":40,"high":25,"medium":10,"low":0},"likelihood":{"almost-certain":15,"likely":10,"possible":5,"unlikely":0},"blocking":35,"urgency":{"overdue":50,"threeDays":30,"sevenDays":15,"fourteenDays":5},"ownership":{"consultant":20,"customer":10},"latestSource":25,"supersession":40,"conflict":45,"uncertainty":15,"staleness":10,"closure":-200}',
  1,
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS register_row_scores (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_register_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  scoring_version TEXT NOT NULL REFERENCES scoring_config(version),
  computed_at TEXT NOT NULL,
  PRIMARY KEY(project_id, external_register_id)
);

CREATE TABLE IF NOT EXISTS project_overview_pins (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT,
  pinned_at TEXT,
  pinned_by TEXT
);

CREATE TABLE IF NOT EXISTS consultant_briefs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  brief_markdown TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, mode, selection_hash)
);

CREATE INDEX IF NOT EXISTS idx_register_scores_project_band ON register_row_scores(project_id, band, score DESC);
CREATE INDEX IF NOT EXISTS idx_consultant_briefs_project_mode ON consultant_briefs(project_id, mode, generated_at DESC);
