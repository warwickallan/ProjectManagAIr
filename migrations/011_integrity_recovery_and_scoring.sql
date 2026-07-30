-- 011 Integrity, recovery and scoring configuration.
--
-- Closes independent-review findings C1, C4, C5, C9, C18 and D1/D2 at the
-- database layer. Application code enforces the same rules, but evidence
-- integrity must not depend on every future writer remembering to.

-- ---------------------------------------------------------------------------
-- Operational recovery and visibility (D1, D2)
-- ---------------------------------------------------------------------------
ALTER TABLE source_processing_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN last_error_at TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN error_kind TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN error_detail_json TEXT;
ALTER TABLE source_processing_jobs ADD COLUMN recovery_action TEXT;

ALTER TABLE project_source_intake ADD COLUMN processing_stage TEXT;
ALTER TABLE project_source_intake ADD COLUMN processing_error TEXT;
ALTER TABLE project_source_intake ADD COLUMN processing_recovery_action TEXT;
ALTER TABLE project_source_intake ADD COLUMN processing_updated_at TEXT;

-- Honest cost evidence: record whether a token count was reported by the
-- provider or estimated by us (D6).
ALTER TABLE extraction_runs ADD COLUMN input_token_source TEXT;
ALTER TABLE extraction_runs ADD COLUMN output_token_source TEXT;

ALTER TABLE register_changesets ADD COLUMN acknowledged_by TEXT;

CREATE INDEX IF NOT EXISTS idx_extraction_runs_project_started ON extraction_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_jobs_status ON source_processing_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_register_row_events_lookup ON register_row_events(project_id, external_register_id, field, occurred_at);

-- ---------------------------------------------------------------------------
-- Immutable evidence (C4)
--
-- source_documents / source_segments / extraction_packets are declared
-- immutable by the design. Deliberate removal of a whole source (for example
-- re-normalisation under a new normaliser version) is still permitted via
-- DELETE on source_documents, which cascades; what is forbidden is silently
-- rewriting evidence in place so that a stored hash no longer describes it.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_source_documents_immutable;
CREATE TRIGGER trg_source_documents_immutable
BEFORE UPDATE ON source_documents
FOR EACH ROW WHEN (
  OLD.project_id <> NEW.project_id
  OR OLD.content_hash <> NEW.content_hash
  OR OLD.source_type <> NEW.source_type
  OR OLD.original_file_name <> NEW.original_file_name
  OR OLD.immutable_path <> NEW.immutable_path
  OR OLD.normaliser_version <> NEW.normaliser_version
  OR OLD.created_at <> NEW.created_at
  OR OLD.word_count <> NEW.word_count
  OR OLD.segment_count <> NEW.segment_count
  OR COALESCE(OLD.event_date, '') <> COALESCE(NEW.event_date, '')
  OR COALESCE(OLD.duration_ms, -1) <> COALESCE(NEW.duration_ms, -1)
  OR COALESCE(OLD.participants_json, '') <> COALESCE(NEW.participants_json, '')
)
BEGIN
  SELECT RAISE(ABORT, 'source_documents rows are immutable evidence and cannot be rewritten');
END;

DROP TRIGGER IF EXISTS trg_source_segments_immutable;
CREATE TRIGGER trg_source_segments_immutable
BEFORE UPDATE ON source_segments
FOR EACH ROW WHEN (
  OLD.source_id <> NEW.source_id
  OR OLD.seq <> NEW.seq
  OR OLD.text <> NEW.text
  OR OLD.kind <> NEW.kind
  OR OLD.char_start <> NEW.char_start
  OR OLD.char_end <> NEW.char_end
  OR COALESCE(OLD.speaker, '') <> COALESCE(NEW.speaker, '')
  OR COALESCE(OLD.t_start_ms, -1) <> COALESCE(NEW.t_start_ms, -1)
  OR COALESCE(OLD.t_end_ms, -1) <> COALESCE(NEW.t_end_ms, -1)
  -- window_id is assigned once, immediately after insert, inside the same
  -- transaction; re-pointing an already assigned window is a rewrite.
  OR (OLD.window_id IS NOT NULL AND COALESCE(NEW.window_id, '') <> OLD.window_id)
)
BEGIN
  SELECT RAISE(ABORT, 'source_segments rows are immutable evidence and cannot be rewritten');
END;

DROP TRIGGER IF EXISTS trg_source_segments_no_delete;
CREATE TRIGGER trg_source_segments_no_delete
BEFORE DELETE ON source_segments
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM source_documents WHERE id = OLD.source_id)
BEGIN
  SELECT RAISE(ABORT, 'source_segments cannot be deleted while their source document exists');
END;

DROP TRIGGER IF EXISTS trg_extraction_packets_immutable;
CREATE TRIGGER trg_extraction_packets_immutable
BEFORE UPDATE ON extraction_packets
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'extraction_packets are frozen artefacts and cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_extraction_packets_no_delete;
CREATE TRIGGER trg_extraction_packets_no_delete
BEFORE DELETE ON extraction_packets
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM source_documents WHERE id = OLD.source_id)
BEGIN
  SELECT RAISE(ABORT, 'frozen extraction packets cannot be deleted while their source exists');
END;

-- ---------------------------------------------------------------------------
-- Append-only human event log (C4)
--
-- source_id may be cleared by the ON DELETE SET NULL action when a source is
-- deliberately removed; nothing else about a recorded human event may change.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_register_row_events_append_only;
CREATE TRIGGER trg_register_row_events_append_only
BEFORE UPDATE ON register_row_events
FOR EACH ROW WHEN (
  OLD.project_id <> NEW.project_id
  OR OLD.external_register_id <> NEW.external_register_id
  OR OLD.occurred_at <> NEW.occurred_at
  OR OLD.actor <> NEW.actor
  OR OLD.event_type <> NEW.event_type
  OR COALESCE(OLD.field, '') <> COALESCE(NEW.field, '')
  OR COALESCE(OLD.previous_value, '') <> COALESCE(NEW.previous_value, '')
  OR COALESCE(OLD.new_value, '') <> COALESCE(NEW.new_value, '')
  OR COALESCE(OLD.reason, '') <> COALESCE(NEW.reason, '')
  OR COALESCE(OLD.evidence_ref, '') <> COALESCE(NEW.evidence_ref, '')
  OR (NEW.source_id IS NOT NULL AND COALESCE(OLD.source_id, '') <> NEW.source_id)
)
BEGIN
  SELECT RAISE(ABORT, 'register_row_events is append-only and cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_register_row_events_no_delete;
CREATE TRIGGER trg_register_row_events_no_delete
BEFORE DELETE ON register_row_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'register_row_events is append-only and cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- Changeset lifecycle (C1)
--
-- Re-submitting a packet must never be able to erase human review or move an
-- applied changeset backwards.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_changeset_no_regression;
CREATE TRIGGER trg_changeset_no_regression
BEFORE UPDATE ON register_changesets
FOR EACH ROW WHEN (
  (OLD.review_status = 'applied' AND NEW.review_status <> 'applied')
  OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'An applied changeset cannot return to an earlier review state');
END;

DROP TRIGGER IF EXISTS trg_change_ops_reviewed_no_delete;
CREATE TRIGGER trg_change_ops_reviewed_no_delete
BEFORE DELETE ON register_change_ops
FOR EACH ROW WHEN (
  OLD.status <> 'pending'
  OR COALESCE((SELECT review_status FROM register_changesets WHERE id = OLD.changeset_id), 'pending') IN ('ready-to-apply', 'applied')
)
BEGIN
  SELECT RAISE(ABORT, 'Reviewed or applied changeset operations cannot be discarded');
END;

DROP TRIGGER IF EXISTS trg_change_ops_applied_immutable;
CREATE TRIGGER trg_change_ops_applied_immutable
BEFORE UPDATE ON register_change_ops
FOR EACH ROW WHEN (
  COALESCE((SELECT review_status FROM register_changesets WHERE id = OLD.changeset_id), 'pending') = 'applied'
  AND (OLD.status <> NEW.status OR COALESCE(OLD.allocated_external_id, '') <> COALESCE(NEW.allocated_external_id, ''))
  AND OLD.allocated_external_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Applied changeset operations are part of the audit record and cannot be rewritten');
END;

-- ---------------------------------------------------------------------------
-- Scoring configuration becomes real (C18)
--
-- v1 was seeded but never read; weights lived in TypeScript literals keyed by
-- register name while the config was keyed by an unrelated vocabulary. v2 is
-- keyed the way the projector actually scores, and the projector now reads it.
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO scoring_config (version, weights_json, active, created_at)
VALUES (
  'source-intelligence-score-v2',
  '{"register":{"Decisions":90,"Actions":70,"Risks_Issues":80,"Config_Changes":40,"Open_Questions":60,"Milestones":40,"Entities":10,"Sources":0,"Uncertainty":30},"severity":{"critical":40,"high":25,"medium":10,"low":0},"likelihood":{"almost-certain":15,"likely":10,"possible":5,"unlikely":0},"blocking":35,"urgency":{"overdue":50,"threeDays":30,"sevenDays":15,"fourteenDays":5},"ownership":{"consultant":20,"customer":10},"latestSource":25,"supersession":40,"conflict":45,"uncertainty":15,"staleness":10,"stalenessDays":21,"closure":-200,"bands":{"now":120,"soon":80,"watch":40}}',
  1,
  '2026-07-30T00:00:00.000Z'
);

UPDATE scoring_config SET active = 0 WHERE version <> 'source-intelligence-score-v2';
