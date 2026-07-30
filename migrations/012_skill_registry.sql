-- 012 Versioned extraction skill registry.
--
-- The extraction skill stops being a TypeScript constant and becomes governed data:
-- revisions are registered, benchmarked, promoted, pinned and rolled back without a
-- code change, and every pass records which revision produced it.
--
-- What the registry may govern is only the *instructional* content sent to the model.
-- The packet schema, coverage, anchor and evidence rules, validation, reconciliation,
-- human review and deterministic replay stay in code and are unreachable from here.

-- ---------------------------------------------------------------------------
-- Revisions and their lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_skills (
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  -- sha256 of the revision BODY, which is what is sent to the model and what lands in
  -- extraction_runs.skill_sha256. The body itself is never stored: a revision held in the
  -- external registry directory is customer-adjacent and stays outside the database.
  sha256 TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'active', 'retired')),
  source TEXT NOT NULL CHECK (source IN ('seed', 'external')),
  notes TEXT,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  retired_at TEXT,
  PRIMARY KEY (skill_id, version)
);

-- At most one active revision per skill id, enforced by the database rather than by every
-- future writer remembering to check. A partial unique index is the whole rule.
CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_skills_one_active
  ON extraction_skills(skill_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_extraction_skills_status ON extraction_skills(skill_id, status);

-- ---------------------------------------------------------------------------
-- Per-project pinning: hold one project on one revision while others move on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_skill_pins (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (project_id, skill_id),
  FOREIGN KEY (skill_id, version) REFERENCES extraction_skills(skill_id, version) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Audit trail. Every lifecycle transition is an explicit, attributed event; there is no
-- implicit promotion, so there is no unattributed row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_skill_events (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  project_id TEXT,
  event TEXT NOT NULL CHECK (event IN ('registered', 'refreshed', 'promoted', 'retired', 'rolled-back', 'pinned', 'unpinned')),
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  note TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_skill_events_lookup ON extraction_skill_events(skill_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_extraction_skill_events_append_only;
CREATE TRIGGER trg_extraction_skill_events_append_only
BEFORE UPDATE ON extraction_skill_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_skill_events is an append-only audit trail and cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_extraction_skill_events_no_delete;
CREATE TRIGGER trg_extraction_skill_events_no_delete
BEFORE DELETE ON extraction_skill_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_skill_events is an append-only audit trail and cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- Provenance per run (§3): skill id, skill version, skill sha256, prompt template
-- version, assembled prompt sha256, provider, model, packet contract version.
-- skill_sha256, prompt_sha256, provider_id and model_label already exist on the table.
-- ---------------------------------------------------------------------------
ALTER TABLE extraction_runs ADD COLUMN skill_id TEXT;
ALTER TABLE extraction_runs ADD COLUMN skill_version TEXT;
ALTER TABLE extraction_runs ADD COLUMN prompt_template_version TEXT;
ALTER TABLE extraction_runs ADD COLUMN packet_contract_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_extraction_runs_skill ON extraction_runs(skill_id, skill_version, started_at DESC);

-- ---------------------------------------------------------------------------
-- The same provenance on the frozen packet, so an artefact records which skill produced
-- it without a join through runs that may be pruned. packet_contract_version already
-- exists on extraction_packets.
-- ---------------------------------------------------------------------------
ALTER TABLE extraction_packets ADD COLUMN skill_id TEXT;
ALTER TABLE extraction_packets ADD COLUMN skill_version TEXT;
ALTER TABLE extraction_packets ADD COLUMN prompt_template_version TEXT;

-- Backfilling an existing packet is not a rewrite of evidence: it names the revision that
-- already produced it, taken from that packet's own runs. The immutability trigger from
-- migration 011 is dropped for the length of the backfill and restored verbatim after it,
-- so no other path can write to a frozen packet.
DROP TRIGGER IF EXISTS trg_extraction_packets_immutable;

UPDATE extraction_packets
SET skill_id = COALESCE(skill_id, (
      SELECT r.skill_id FROM extraction_runs r
      WHERE r.source_id = extraction_packets.source_id AND r.skill_sha256 = extraction_packets.skill_sha256 AND r.skill_id IS NOT NULL
      ORDER BY r.started_at LIMIT 1)),
    skill_version = COALESCE(skill_version, (
      SELECT r.skill_version FROM extraction_runs r
      WHERE r.source_id = extraction_packets.source_id AND r.skill_sha256 = extraction_packets.skill_sha256 AND r.skill_id IS NOT NULL
      ORDER BY r.started_at LIMIT 1)),
    prompt_template_version = COALESCE(prompt_template_version, (
      SELECT r.prompt_template_version FROM extraction_runs r
      WHERE r.source_id = extraction_packets.source_id AND r.skill_sha256 = extraction_packets.skill_sha256 AND r.skill_id IS NOT NULL
      ORDER BY r.started_at LIMIT 1))
WHERE skill_id IS NULL;

CREATE TRIGGER trg_extraction_packets_immutable
BEFORE UPDATE ON extraction_packets
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_packets are frozen artefacts and cannot be updated');
END;

CREATE INDEX IF NOT EXISTS idx_extraction_packets_skill ON extraction_packets(skill_id, skill_version);
