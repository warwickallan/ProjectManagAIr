-- 016 Mandatory source metadata, event chronology, and formal answers/
-- relationship lineage for a second and subsequent source.
--
-- Three additive changes, each extending an existing, proven mechanism rather
-- than inventing a parallel one:
--
-- 1. `source_documents` gains the meeting-level fields a VTT's own timestamps
--    cannot be trusted to supply (subject, work package, timezone) plus a
--    confirmation marker on `project_source_intake`. `source_metadata_events`
--    is the audit trail for corrections after the fact, built identically to
--    the proven `register_row_events` shape (append-only, actor/reason/
--    before-after) rather than a new mechanism.
--
-- 2. `register_row_events.related_external_id` names the OTHER register row a
--    relationship event is about (what this event answers, supersedes or
--    reaffirms), so "what answered this question" becomes a stored fact
--    instead of an inference made at render time.
--
-- Nothing here changes `project_state_hash` computation inputs beyond what
-- already flows through `register_row_events` (the new column is additive
-- metadata on the same table, read the same way `origin` was in migration 015).

ALTER TABLE source_documents ADD COLUMN meeting_subject TEXT;
-- `confirmed_event_date` is deliberately a NEW, separate column from the
-- existing (evidence-derived, hash-relevant) `event_date` rather than reusing
-- it: `event_date` is protected by `trg_source_documents_immutable` below and
-- must keep meaning "what the source's own evidence says", while a human
-- confirmation/correction of the actual meeting date is a distinct, more
-- authoritative fact that must remain correctable (each correction audited
-- via `source_metadata_events`) without ever touching evidence integrity.
ALTER TABLE source_documents ADD COLUMN confirmed_event_date TEXT;
ALTER TABLE source_documents ADD COLUMN event_time TEXT;
ALTER TABLE source_documents ADD COLUMN timezone TEXT;
ALTER TABLE source_documents ADD COLUMN primary_work_package TEXT;
ALTER TABLE source_documents ADD COLUMN additional_work_packages_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE source_documents ADD COLUMN recording_gap_notes TEXT;
-- Same reasoning as `confirmed_event_date`: the existing `participants_json`
-- is immutability-guarded evidence from the transcript itself; a human-
-- confirmed/added participant list is a separate, correctable fact.
ALTER TABLE source_documents ADD COLUMN confirmed_participants_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE project_source_intake ADD COLUMN metadata_confirmed_at TEXT;
ALTER TABLE project_source_intake ADD COLUMN metadata_confirmed_by TEXT;

-- Append-only audit trail for source metadata corrections, mirroring
-- `register_row_events` (migration 008) exactly: a correction never
-- overwrites the record silently, it adds one more event.
CREATE TABLE IF NOT EXISTS source_metadata_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  field TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_metadata_events_source ON source_metadata_events(source_id, occurred_at);

DROP TRIGGER IF EXISTS trg_source_metadata_events_append_only;
CREATE TRIGGER trg_source_metadata_events_append_only
BEFORE UPDATE ON source_metadata_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'source_metadata_events is an append-only audit trail and cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_source_metadata_events_no_delete;
CREATE TRIGGER trg_source_metadata_events_no_delete
BEFORE DELETE ON source_metadata_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'source_metadata_events is an append-only audit trail and cannot be deleted');
END;

-- The other register row a relationship event concerns: who this event
-- answers, supersedes or reaffirms. NULL for a plain status/field/note event.
ALTER TABLE register_row_events ADD COLUMN related_external_id TEXT;

CREATE INDEX IF NOT EXISTS idx_register_events_related ON register_row_events(project_id, related_external_id) WHERE related_external_id IS NOT NULL;
