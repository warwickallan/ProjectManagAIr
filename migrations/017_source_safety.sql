-- 017 Source safety: explicit chronology, content-based source identity,
-- governed discard before application, and governed void after it.
--
-- Every uploaded transcript becomes a reversible source transaction. Four
-- additive groups, each extending a proven mechanism rather than inventing a
-- parallel one. Nothing here deletes, rewrites or constrains existing data.
--
-- 1. CHRONOLOGY. Migration 016 added `confirmed_event_date` and made it
--    mandatory, which forced a consultant to invent a date for a transcript
--    that carries none. Worse, precedence never read it: `humanPrecedenceInstant`
--    read the immutable, evidence-derived `event_date`, which is NULL for a real
--    Teams export, so precedence silently fell back to `created_at` — upload
--    time. A source could become precedent purely by arriving second.
--
--    The date alone cannot express what is actually known, so the state, the
--    precision and the basis are stored SEPARATELY from the value. "3 August,
--    certain", "some time in August", and "genuinely unknown" are now different
--    records rather than the same nullable column. `chronology_basis` records
--    where the value came from, so a filename suggestion can never be mistaken
--    for a human confirmation.
--
-- 2. SOURCE IDENTITY. Identity is content plus provenance: the raw bytes, a
--    canonical transcript fingerprint that survives harmless re-export, and
--    deterministic chunk fingerprints for partial overlap. Never the filename,
--    never the meeting date. `source_alternate_names` records every filename the
--    same content has arrived under, because the same transcript legitimately
--    circulates under several names.
--
-- 3. DISCARD (before application) and 4. VOID (after it) share one append-only
--    `source_lifecycle_events` log, built to the same shape as the proven
--    `register_row_events`/`source_metadata_events` tables. A void is a
--    REPLAY-TIME EXCLUSION, never a compensating write: compensating field
--    writes would land at void-time, after every later valid source and human
--    edit, and would therefore silently overwrite them. Evidence, packets, raw
--    provider responses and changesets are all retained.

/* ---------------------------------------------------------------------------- *
 * 1. Chronology
 * ---------------------------------------------------------------------------- */

-- confirmed | approximate | unknown
ALTER TABLE source_documents ADD COLUMN chronology_state TEXT NOT NULL DEFAULT 'unknown';
-- exact-datetime | date | month | range | none
ALTER TABLE source_documents ADD COLUMN chronology_precision TEXT NOT NULL DEFAULT 'none';
-- human-confirmed | transcript-header | filename-suggestion | file-timestamp-suggestion | absent
ALTER TABLE source_documents ADD COLUMN chronology_basis TEXT NOT NULL DEFAULT 'absent';
-- Inclusive bounds, used when precision is `month` or `range`. A point date
-- leaves both NULL and lives in `confirmed_event_date`.
ALTER TABLE source_documents ADD COLUMN chronology_range_start TEXT;
ALTER TABLE source_documents ADD COLUMN chronology_range_end TEXT;

-- Backfill: a source that already carries a human-confirmed date keeps exactly
-- the meaning it had. Anything else becomes explicitly unknown rather than
-- silently inheriting `created_at` as it did before.
UPDATE source_documents
   SET chronology_state = 'confirmed',
       chronology_precision = CASE WHEN event_time IS NOT NULL AND event_time <> '' THEN 'exact-datetime' ELSE 'date' END,
       chronology_basis = 'human-confirmed'
 WHERE confirmed_event_date IS NOT NULL AND confirmed_event_date <> '';

/* ---------------------------------------------------------------------------- *
 * 2. Content-based source identity
 * ---------------------------------------------------------------------------- */

-- SHA-256 of the canonicalised transcript: line endings and Unicode normalised,
-- WEBVTT headers, cue identifiers and timestamps removed, whitespace collapsed,
-- speaker and dialogue content retained. Two harmlessly re-exported copies of
-- one meeting share this even though their raw bytes differ. Computed
-- deterministically with no model involvement.
ALTER TABLE source_documents ADD COLUMN canonical_fingerprint TEXT;
ALTER TABLE project_source_intake ADD COLUMN canonical_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_source_documents_canonical ON source_documents(project_id, canonical_fingerprint);
CREATE INDEX IF NOT EXISTS idx_source_intake_canonical ON project_source_intake(project_id, canonical_fingerprint);
-- Duplicate detection has always keyed on the raw hash; index it so the check
-- stays cheap once it also runs across projects for the advisory warning.
CREATE INDEX IF NOT EXISTS idx_source_intake_content_hash ON project_source_intake(content_hash);

-- Deterministic fixed-size chunks of the canonical transcript. Overlap between
-- two sources is the Jaccard-style containment of these sets, so a partial
-- transcript that covers half an existing meeting is detectable without a model
-- and without comparing full text at query time.
CREATE TABLE IF NOT EXISTS source_chunk_fingerprints (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  UNIQUE(source_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_source_chunks_fingerprint ON source_chunk_fingerprints(project_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunk_fingerprints(source_id, seq);

-- Every filename the same content has arrived under. The filename is never
-- identity, but "this arrived before under a different name" is exactly what a
-- consultant needs to see to recognise the file.
CREATE TABLE IF NOT EXISTS source_alternate_names (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE(source_id, file_name)
);

-- The stored comparison verdict for one incoming source against one existing
-- source, computed BEFORE any provider call. `classification` is the machine
-- verdict; `decision` is what the human did about it, and stays NULL until
-- somebody decides.
CREATE TABLE IF NOT EXISTS source_comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The incoming intake row this verdict is about.
  intake_source_id TEXT NOT NULL,
  -- The already-known source it matched, when there is one.
  matched_source_id TEXT,
  matched_project_id TEXT,
  -- exact-duplicate | normalised-duplicate | possible-overlap
  --   | similar-filename-different-content | apparently-new
  --   | previously-voided-duplicate | cross-project-match
  classification TEXT NOT NULL,
  raw_hash_match INTEGER NOT NULL DEFAULT 0,
  canonical_match INTEGER NOT NULL DEFAULT 0,
  overlap_ratio REAL NOT NULL DEFAULT 0,
  filename_similarity REAL NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  -- retain-as-new | mark-duplicate | mark-wrong-project | mark-wrong-file | discard
  decision TEXT,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_comparisons_intake ON source_comparisons(intake_source_id, created_at);
CREATE INDEX IF NOT EXISTS idx_source_comparisons_project ON source_comparisons(project_id, created_at);

/* ---------------------------------------------------------------------------- *
 * 3 & 4. Governed lifecycle: discard before application, void after it
 * ---------------------------------------------------------------------------- */

-- active | duplicate | wrong-project | wrong-file | discarded | voided
--
-- Deliberately distinct from `processing_status` (where the source is in the
-- pipeline) and from the pre-existing "skip because it carries no governance
-- content" operation, which remains a legitimate zero-call extraction outcome
-- and is NOT a discard. A discarded source was never meant to be here; a
-- skipped source was meant to be here and simply had nothing to mine.
ALTER TABLE source_documents ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE source_documents ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE source_documents ADD COLUMN lifecycle_actor TEXT;
ALTER TABLE source_documents ADD COLUMN lifecycle_at TEXT;
-- When this source was retired in favour of another copy of the same content.
ALTER TABLE source_documents ADD COLUMN duplicate_of_source_id TEXT;

ALTER TABLE project_source_intake ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_source_documents_lifecycle ON source_documents(project_id, lifecycle_state);

-- A changeset whose source has been voided is marked, never deleted. The packet,
-- the raw provider response, the operations and every review decision stay
-- exactly as they were: the void changes what is REPLAYED, not what happened.
ALTER TABLE register_changesets ADD COLUMN voided_at TEXT;
ALTER TABLE register_changesets ADD COLUMN voided_by TEXT;
ALTER TABLE register_changesets ADD COLUMN void_reason TEXT;

-- Append-only lifecycle log covering discard, void and un-void. Same shape as
-- `source_metadata_events`: actor, time, before, after, mandatory reason.
CREATE TABLE IF NOT EXISTS source_lifecycle_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  -- discard | void | retain-as-new | mark-duplicate | mark-wrong-project
  --   | mark-wrong-file
  event_type TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_source_lifecycle_events_source ON source_lifecycle_events(source_id, occurred_at);

-- Append-only, exactly like `register_row_events`: a lifecycle decision is
-- history and may never be edited or deleted in place.
CREATE TRIGGER IF NOT EXISTS trg_source_lifecycle_events_no_update
BEFORE UPDATE ON source_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'source_lifecycle_events is append-only.');
END;

CREATE TRIGGER IF NOT EXISTS trg_source_lifecycle_events_no_delete
BEFORE DELETE ON source_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'source_lifecycle_events is append-only.');
END;

/* ---------------------------------------------------------------------------- *
 * Projection output for a voided source's dependants
 * ---------------------------------------------------------------------------- */

-- `register_row_state` is fully deleted and rebuilt by `rebuildProjection` on
-- every replay, so it is the correct home for DERIVED void consequences: they
-- are recomputed from the event log rather than stored as facts anyone could
-- edit out of step with it.
--
-- `effective` is 0 for a row that has left current effective state because the
-- only evidence for it came from a voided source. The row itself is retained in
-- `project_register_rows` and in history — it is excluded, never deleted, and
-- its identifier is never reused.
ALTER TABLE register_row_state ADD COLUMN effective INTEGER NOT NULL DEFAULT 1;
-- founding-source-voided | orphaned-by-source-void | relationship-review
ALTER TABLE register_row_state ADD COLUMN review_flag TEXT;
ALTER TABLE register_row_state ADD COLUMN review_detail TEXT;
