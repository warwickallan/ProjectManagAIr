-- 013 Raw provider-output preservation, prompt-registry management, and cached
--     on-demand consultant synthesis.
--
-- Three things this migration makes possible, none of which the schema could
-- express before:
--
--   1. A completed provider response is DURABLE EVIDENCE in its own right.
--      Until now the only trace of a model response that failed downstream was a
--      sha256 on `extraction_runs` and a best-effort file on disk with no
--      metadata attached. A merge or gate defect after several completed calls
--      therefore destroyed the model's work irrecoverably — which is exactly
--      what happened during the previous acceptance attempt. A raw output is now
--      recorded the instant it is received, BEFORE any parsing, with everything
--      needed to identify, grade and replay it.
--
--   2. The extraction-skill registry becomes MANAGEABLE rather than merely
--      auditable: revisions carry a human-readable name and purpose, uploads
--      create drafts, and benchmark results are recorded against the exact
--      version they graded.
--
--   3. A consultant synthesis is cached against the FULL identity of what
--      produced it — deterministic selection, skill version, prompt template,
--      provider, model and packet contract — so reopening an unchanged view
--      costs zero provider calls and a changed selection marks the old view
--      stale instead of silently regenerating it.

-- ---------------------------------------------------------------------------
-- 1. Raw provider outputs
--
-- Written before parsing, so a parser, schema or merge defect can never lose a
-- completed provider response again. `run_id` is filled in afterwards because
-- the run row cannot exist until the call has returned; everything else is
-- known at the moment of receipt and is immutable from that moment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_raw_outputs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Which call of which stage produced this. `call_index` is the slice number
  -- inside one extraction pass; `attempt_label` distinguishes passes.
  stage TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  -- Never NULL: NULLs compare distinct in a SQLite unique index, which would
  -- silently let the same response be recorded twice for one call.
  attempt_label TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  -- The contract this response was produced under, in full.
  skill_id TEXT,
  skill_version TEXT,
  skill_sha256 TEXT NOT NULL,
  prompt_template_version TEXT,
  prompt_sha256 TEXT NOT NULL,
  packet_contract_version INTEGER,
  -- Which part of the source was in front of the model.
  window_keys_json TEXT NOT NULL DEFAULT '[]',
  -- Timing and size.
  requested_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  response_sha256 TEXT NOT NULL,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  -- Where the bytes themselves live. Outside Git and outside the database,
  -- because a raw response is source-derived customer material.
  artefact_path TEXT,
  -- Honest token accounting, labelled by origin exactly as extraction_runs does.
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_token_source TEXT NOT NULL DEFAULT 'estimated',
  output_token_source TEXT NOT NULL DEFAULT 'estimated',
  -- 'received' the instant the bytes arrive; then one of 'parsed',
  -- 'parsed-with-exclusions' or 'rejected' once the parser has spoken.
  parse_status TEXT NOT NULL DEFAULT 'received'
    CHECK (parse_status IN ('received', 'parsed', 'parsed-with-exclusions', 'rejected')),
  parse_detail TEXT,
  run_id TEXT,
  UNIQUE(source_id, stage, attempt_label, call_index, response_sha256)
);

CREATE INDEX IF NOT EXISTS idx_provider_raw_outputs_source ON provider_raw_outputs(source_id, received_at);
CREATE INDEX IF NOT EXISTS idx_provider_raw_outputs_run ON provider_raw_outputs(run_id);

-- The response and its identity are immutable. Only the fields that are
-- genuinely unknown at receipt — the run it became, and what the parser made of
-- it — may be completed afterwards.
DROP TRIGGER IF EXISTS trg_provider_raw_outputs_immutable;
CREATE TRIGGER trg_provider_raw_outputs_immutable
BEFORE UPDATE ON provider_raw_outputs
FOR EACH ROW WHEN (
  OLD.source_id <> NEW.source_id
  OR OLD.project_id <> NEW.project_id
  OR OLD.stage <> NEW.stage
  OR OLD.call_index <> NEW.call_index
  OR OLD.provider_id <> NEW.provider_id
  OR OLD.model_label <> NEW.model_label
  OR OLD.skill_sha256 <> NEW.skill_sha256
  OR OLD.prompt_sha256 <> NEW.prompt_sha256
  OR OLD.response_sha256 <> NEW.response_sha256
  OR OLD.received_at <> NEW.received_at
  OR COALESCE(OLD.artefact_path, '') <> COALESCE(NEW.artefact_path, '')
)
BEGIN
  SELECT RAISE(ABORT, 'provider_raw_outputs rows are preserved model evidence and cannot be rewritten');
END;

-- Deliberately NO delete trigger. The only legitimate deleter is the foreign-key
-- cascade from `source_documents`, which is how a deliberate re-normalisation
-- discards a source and everything derived from it — and re-normalisation is
-- already refused once any changeset from that source has been applied. An
-- append-only delete guard here would repeat the open N9 defect, where a
-- protective trigger makes a legitimate cascade impossible; the preserved bytes
-- on disk survive that cascade in any case.

-- ---------------------------------------------------------------------------
-- 2. Prompt registry management
--
-- The registry from migration 012 is extended, not replaced. There is exactly
-- one registry, one version model and one audit trail.
-- ---------------------------------------------------------------------------
ALTER TABLE extraction_skills ADD COLUMN name TEXT;
ALTER TABLE extraction_skills ADD COLUMN purpose TEXT;
-- Which provider profile a revision is written for, when it is provider
-- specific. NULL means "any provider that honours the packet contract".
ALTER TABLE extraction_skills ADD COLUMN provider_profile TEXT;
ALTER TABLE extraction_skills ADD COLUMN packet_contract_version INTEGER;
-- Where the body actually lives, so the UI can offer View / Copy / Download
-- without the server guessing at a path. Never a customer path: it is always
-- inside the seed directory or the configured registry directory.
ALTER TABLE extraction_skills ADD COLUMN body_path TEXT;
ALTER TABLE extraction_skills ADD COLUMN body_characters INTEGER;
ALTER TABLE extraction_skills ADD COLUMN uploaded_by TEXT;

UPDATE extraction_skills SET packet_contract_version = 1 WHERE packet_contract_version IS NULL;

-- Benchmark results recorded against the exact revision they graded. A result
-- is evidence about a version, so it is append-only like the audit trail.
CREATE TABLE IF NOT EXISTS extraction_skill_benchmarks (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  project_id TEXT,
  source_id TEXT,
  packet_id TEXT,
  benchmark_label TEXT NOT NULL,
  verdict TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  note TEXT,
  FOREIGN KEY (skill_id, version) REFERENCES extraction_skills(skill_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_extraction_skill_benchmarks_version
  ON extraction_skill_benchmarks(skill_id, version, recorded_at DESC);

DROP TRIGGER IF EXISTS trg_extraction_skill_benchmarks_append_only;
CREATE TRIGGER trg_extraction_skill_benchmarks_append_only
BEFORE UPDATE ON extraction_skill_benchmarks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_skill_benchmarks is an append-only record of graded evidence');
END;

DROP TRIGGER IF EXISTS trg_extraction_skill_benchmarks_no_delete;
CREATE TRIGGER trg_extraction_skill_benchmarks_no_delete
BEFORE DELETE ON extraction_skill_benchmarks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_skill_benchmarks is an append-only record of graded evidence');
END;

-- Consultant-brief runs gain the same provenance every extraction run records,
-- so "which skill version wrote this narrative" is answerable from the run.
ALTER TABLE consultant_brief_runs ADD COLUMN skill_id TEXT;
ALTER TABLE consultant_brief_runs ADD COLUMN skill_version TEXT;
ALTER TABLE consultant_brief_runs ADD COLUMN skill_sha256 TEXT;
ALTER TABLE consultant_brief_runs ADD COLUMN prompt_template_version TEXT;
ALTER TABLE consultant_brief_runs ADD COLUMN packet_contract_version INTEGER;
ALTER TABLE consultant_brief_runs ADD COLUMN mode TEXT;
ALTER TABLE consultant_brief_runs ADD COLUMN cache_key TEXT;

CREATE INDEX IF NOT EXISTS idx_consultant_brief_runs_skill
  ON consultant_brief_runs(skill_id, skill_version, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Consultant views: cache identity and honest staleness
--
-- `consultant_briefs` was unique on (project_id, mode, selection_hash), which
-- cannot hold two syntheses of the same selection produced by different skill
-- versions or models — and a cache that cannot tell them apart would serve one
-- while reporting the other's provenance. The table is rebuilt with the full
-- cache key. It is a regenerable cache, so no evidence is at risk; the rows
-- that exist are carried across unchanged.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultant_briefs_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  -- sha256 over the deterministic selection PLUS skill id and version, prompt
  -- template version, provider, model and packet contract version. Two views
  -- that differ in any of those are different artefacts and cache separately.
  cache_key TEXT NOT NULL,
  brief_markdown TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  selected_ids_json TEXT NOT NULL DEFAULT '[]',
  themes_json TEXT NOT NULL DEFAULT '[]',
  provider_id TEXT NOT NULL,
  model_label TEXT,
  skill_id TEXT,
  skill_version TEXT,
  prompt_template_version TEXT,
  packet_contract_version INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  -- Why it is stale, in words a consultant can act on. A stale view that cannot
  -- say what changed is just a warning badge.
  stale_reason TEXT,
  stale_at TEXT,
  UNIQUE(project_id, mode, cache_key)
);

INSERT OR IGNORE INTO consultant_briefs_v2
  (id, project_id, mode, selection_hash, cache_key, brief_markdown, citations_json, selected_ids_json, themes_json,
   provider_id, model_label, skill_id, skill_version, prompt_template_version, packet_contract_version,
   input_tokens, output_tokens, generated_at, stale, stale_reason, stale_at)
SELECT id, project_id, mode, selection_hash, 'legacy:' || selection_hash, brief_markdown, citations_json, '[]', '[]',
       provider_id, NULL, NULL, NULL, NULL, NULL, 0, 0, generated_at, stale,
       CASE WHEN stale = 1 THEN 'Marked stale before migration 013; the reason was not recorded.' ELSE NULL END,
       CASE WHEN stale = 1 THEN generated_at ELSE NULL END
FROM consultant_briefs;

DROP TABLE consultant_briefs;
ALTER TABLE consultant_briefs_v2 RENAME TO consultant_briefs;

CREATE INDEX IF NOT EXISTS idx_consultant_briefs_project_mode
  ON consultant_briefs(project_id, mode, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultant_briefs_selection
  ON consultant_briefs(project_id, selection_hash);
