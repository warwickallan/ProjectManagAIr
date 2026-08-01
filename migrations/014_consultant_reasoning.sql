-- 014 Consultant Reasoning: the second intelligence.
--
-- Source Intelligence mines a source into granular, anchored register memory.
-- This migration gives the OTHER direction a home: a bounded reasoning pass
-- that reads the whole approved register state and returns consultant-facing
-- judgement, governed exactly as strictly as extraction is.
--
-- Three things the existing schema could not express:
--
--   1. A reasoning run has no source document. `provider_raw_outputs.source_id`
--      is NOT NULL and cascades from `source_documents`, so a reasoning
--      response had nowhere to be preserved. Raw preservation is not optional —
--      a completed provider response is evidence whether or not it later
--      validates — so reasoning gets its own project-scoped raw table with the
--      same before-parsing discipline.
--
--   2. A reasoning result is cached against the STATE IT REASONED OVER, not
--      against a deterministic selection. The project-state hash covers exactly
--      the register content the model was shown, so applying a changeset that
--      moves a row marks the cached brief stale, and a change the model never
--      saw does not. Stale results are KEPT, never deleted: the previous
--      answer is how you tell what changed.
--
--   3. A rejected run is as interesting as an accepted one. Validation
--      outcome, every violation and the raw response are all retained, so a
--      skill revision that produces invalid output is diagnosable without
--      spending the tokens again.

-- ---------------------------------------------------------------------------
-- 1. Raw reasoning responses, written before parsing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultant_reasoning_raw_outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The exact revision that asked the question, recorded at request time so a
  -- later publish or rollback cannot rewrite what produced this response.
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  skill_sha256 TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  mode TEXT NOT NULL,
  project_state_hash TEXT NOT NULL,
  register_revision INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  response_sha256 TEXT NOT NULL,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  -- The complete response on disk, outside the database, exactly as received.
  artefact_path TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  -- 'reported' when the provider told us, 'estimated' when we counted.
  token_source TEXT NOT NULL DEFAULT 'estimated',
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_detail TEXT,
  run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_reasoning_raw_project ON consultant_reasoning_raw_outputs(project_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 2. One row per reasoning attempt, accepted or not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultant_reasoning_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_output_id TEXT REFERENCES consultant_reasoning_raw_outputs(id) ON DELETE SET NULL,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  skill_sha256 TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  mode TEXT NOT NULL,
  project_state_hash TEXT NOT NULL,
  register_revision INTEGER NOT NULL DEFAULT 0,
  request_context_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  -- 'accepted' | 'parse-failed' | 'validation-failed' | 'provider-failed'
  status TEXT NOT NULL,
  -- Every violation, so a failed revision is diagnosable from the record alone.
  violations_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'estimated',
  result_sha256 TEXT,
  -- Provider calls this run actually made. One, or zero on a cache hit.
  provider_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reasoning_runs_project ON consultant_reasoning_runs(project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. The accepted result, cached and staleable.
--
-- `cache_key` covers project, state hash, mode, skill revision, prompt
-- template, provider and model. Anything that could change the answer changes
-- the key, so a cache hit is genuinely the same question asked of the same
-- state by the same reasoner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consultant_reasoning_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES consultant_reasoning_runs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  project_state_hash TEXT NOT NULL,
  register_revision INTEGER NOT NULL DEFAULT 0,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  -- The validated output object, verbatim.
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  -- Register IDs the accepted output cites. Project ManagAIr resolves these to
  -- canonical anchors for display; the model never supplies a quote.
  cited_register_ids_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  stale_at TEXT,
  UNIQUE(project_id, mode, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_reasoning_results_current ON consultant_reasoning_results(project_id, mode, stale, generated_at DESC);
