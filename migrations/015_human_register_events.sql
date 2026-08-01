-- 015 Human register events: explicit origin and the standalone note.
--
-- register_row_events already recorded every register mutation append-only,
-- with actor/timestamp/reason/before-after preserved (migration 008), and
-- already carried a nullable `source_id` set only by the source-extraction
-- apply path (src/sourceIntelligence.ts). That was an implicit, inferred
-- signal for "who produced this event" — reliable today only because exactly
-- two writers exist. `origin` makes it explicit instead of inferred, and
-- gives a future system-generated writer somewhere to say so honestly.
--
-- `event_type` was already a free TEXT column with no CHECK constraint, so a
-- standalone human note ('note', no field, no new_value) needed no schema
-- change to be representable — it is just an event that never mutates a
-- register field. This migration only adds the explicit origin.

ALTER TABLE register_row_events ADD COLUMN origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('source', 'human', 'system'));

-- Backfill: every existing event carrying a source_id was written by the
-- source-extraction apply path, never a human at the keyboard. Every other
-- existing event was written by the one other writer that has ever existed,
-- `recordRegisterEvent`, which is the human-facing route.
UPDATE register_row_events SET origin = 'source' WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_register_events_origin ON register_row_events(project_id, external_register_id, origin);
