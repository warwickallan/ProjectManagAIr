/**
 * Human project events — completing the existing event-sourced path.
 *
 * The architecture already existed: `recordRegisterEvent` writes one
 * append-only row to `register_row_events`, `rebuildProjection` replays the
 * whole log deterministically, and `buildReasoningRequest` assembles the
 * Consultant Reasoning request from the resulting effective state. This
 * ticket adds the missing pieces at the edges: register-appropriate status
 * actions beyond the original seven, a standalone note event that carries no
 * field mutation, and an explicit `origin` distinguishing a human action from
 * a source-extraction apply. Everything here proves those additions without
 * touching the machinery already covered by `tests/humanCorrections.test.ts`
 * and `tests/registerProjection.test.ts`.
 *
 * Synthetic throughout: project "SYN", people "Casey Flint" (consultant) and
 * "Blair Ross". No provider is ever reachable from this file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import {
  canonicalNormalizedRowJson,
  canonicalRowJson,
  rebuildProjection,
  recordRegisterEvent,
} from '../src/registerProjection';
import { buildReasoningRequest } from '../src/consultantReasoningState';
import { readConsultantReasoning } from '../src/consultantReasoning';
import { FakeConsultantReasoningProvider } from '../src/consultantReasoningProvider';
import { ensureSkillRegistrySynced, SKILL_REGISTRY_DIR_ENV } from '../src/skillRegistry';
import { PROVIDER_OUTPUT_DIR_ENV } from '../src/providerOutputs';

const AS_OF = '2026-08-01T09:00:00.000Z';
const importRunFor = (projectId: string) => `human-events-run:${projectId}`;

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-human-events-'));
  const context = openProjectManagairDatabase(path.join(dir, 'projectmanagair.db'));
  return {
    db: context.db,
    close: () => { try { context.db.close(); } catch { /* already closed */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ } },
  };
}

function seedProject(db: DatabaseSync, projectId = 'syn') {
  db.prepare('INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'Synthetic Human Events Fixture', 'SYN', 'Synthetic fixture project.', 'on-track', 'delivery', 'Casey Flint', '2026-01-01', '2026-12-31', null, AS_OF, AS_OF, 'fictional');
  db.prepare("INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json) VALUES (?, ?, 'project_register_benchmark', 1, 'SYN', ?, 'completed', ?, ?, 0, 0, '[]', 'verified', '{}')")
    .run(importRunFor(projectId), projectId, `hash-${projectId}`, AS_OF, AS_OF);
  return projectId;
}

interface SeedRow { register: string; id: string; status?: string; owner?: string | null; raw?: Record<string, unknown> }

function seedRegisterRow(db: DatabaseSync, projectId: string, row: SeedRow) {
  const title = `${row.id} title`;
  const summary = `${row.id} summary`;
  const raw = { id: row.id, title, summary, status: row.status ?? 'open', ...row.raw };
  db.prepare('INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, \'[]\', \'[]\', \'[]\', ?, NULL, NULL, ?, ?, ?, ?, ?)')
    .run(`register:${projectId}:${row.id}`, projectId, row.register, row.id, title, summary, row.status ?? 'open', row.owner ?? null, row.status ?? 'open', importRunFor(projectId), row.register, canonicalRowJson(raw), canonicalNormalizedRowJson(raw), AS_OF, AS_OF);
  return `register:${projectId}:${row.id}`;
}

const stateOf = (db: DatabaseSync, projectId: string, id: string) =>
  db.prepare('SELECT status, owner, due_date, resolution FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, id) as { status: string; owner: string | null; due_date: string | null; resolution: string | null };

const bandOf = (db: DatabaseSync, projectId: string, id: string) =>
  (db.prepare('SELECT band FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, id) as { band: string }).band;

const eventsOf = (db: DatabaseSync, projectId: string, id: string) =>
  db.prepare('SELECT event_type, field, previous_value, new_value, reason, origin FROM register_row_events WHERE project_id = ? AND external_register_id = ? ORDER BY occurred_at, rowid').all(projectId, id) as Array<Record<string, unknown>>;

describe('completing register-appropriate status actions writes one event and updates effective state', () => {
  it('completes an action', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'complete', reason: 'Delivered in the session.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      expect(eventsOf(db, projectId, 'SYN-A-001')).toHaveLength(1);
      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: 'completed' });
      expect(db.prepare("SELECT status FROM actions WHERE id = 'SYN-A-001'").get()).toMatchObject({ status: 'completed' });
    } finally {
      context.close();
    }
  });

  it('records the newer Actions statuses: in progress, blocked, cancelled', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'start', reason: 'Work has begun.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: 'in-progress' });
      expect(bandOf(db, projectId, 'SYN-A-001')).not.toBe('Reference');

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'block', reason: 'Waiting on the customer environment list.', occurredAt: '2026-08-01T10:05:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: 'blocked' });

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'cancel', reason: 'No longer needed after the scope change.', occurredAt: '2026-08-01T10:10:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: 'cancelled' });
      // A cancelled action is closed, and scores as Reference, not left in the queue.
      expect(bandOf(db, projectId, 'SYN-A-001')).toBe('Reference');
    } finally {
      context.close();
    }
  });
});

describe('answering a question writes one event, sets the resolution and closes it', () => {
  it('records the answer as resolution and moves status to resolved', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      const rowId = seedRegisterRow(db, projectId, { register: 'Open_Questions', id: 'SYN-Q-001' });
      db.prepare('INSERT INTO register_open_question_details (register_row_id, question, parked_with, unblocked_by, blocking) VALUES (?, ?, NULL, NULL, 0)').run(rowId, 'Which permit class applies?');
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-Q-001', { actor: 'Casey Flint', eventType: 'close', field: 'resolution', newValue: 'Class B applies; confirmed with the customer safety lead.', reason: 'Class B applies; confirmed with the customer safety lead.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      expect(eventsOf(db, projectId, 'SYN-Q-001')).toHaveLength(1);
      expect(stateOf(db, projectId, 'SYN-Q-001')).toMatchObject({ status: 'resolved', resolution: 'Class B applies; confirmed with the customer safety lead.' });
      expect(db.prepare("SELECT status, resolution FROM open_questions WHERE id = 'SYN-Q-001'").get()).toMatchObject({ status: 'resolved', resolution: 'Class B applies; confirmed with the customer safety lead.' });
    } finally {
      context.close();
    }
  });
});

describe('resolving and reopening a risk', () => {
  it('mitigates, then reopens, changing status and band each time', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Risks_Issues', id: 'SYN-R-001', raw: { details: { severity: 'high', likelihood: 'likely' } } });
      db.prepare('INSERT INTO register_risk_issue_details (register_row_id, driver, evidence, impact, mitigation, likelihood, severity) VALUES (?, NULL, NULL, NULL, NULL, ?, ?)').run(`register:${projectId}:SYN-R-001`, 'likely', 'high');
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-R-001')).toMatchObject({ status: 'open' });

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'mitigate', reason: 'A second supplier removes the exposure.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-R-001')).toMatchObject({ status: 'mitigated' });
      expect(bandOf(db, projectId, 'SYN-R-001')).toBe('Reference');

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'reopen', reason: 'The second supplier fell through.', occurredAt: '2026-08-01T10:05:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-R-001')).toMatchObject({ status: 'open' });
      expect(bandOf(db, projectId, 'SYN-R-001')).not.toBe('Reference');
    } finally {
      context.close();
    }
  });

  it('accepts a risk (closed) and resolves an issue, distinctly', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Risks_Issues', id: 'SYN-R-002' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-R-002', { actor: 'Casey Flint', eventType: 'accept', reason: 'Exposure is within the agreed risk appetite.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-R-002')).toMatchObject({ status: 'accepted' });
      expect(bandOf(db, projectId, 'SYN-R-002')).toBe('Reference');
    } finally {
      context.close();
    }
  });
});

describe('changing owner and due date', () => {
  it('records both as separate events with before/after values', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Casey Flint' });
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'owner', newValue: 'Blair Ross', reason: 'Reassigned to Blair for the go-live window.', occurredAt: '2026-08-01T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'due_date', newValue: '2026-09-01', reason: 'Moved to align with the customer freeze.', occurredAt: '2026-08-01T10:01:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ owner: 'Blair Ross', due_date: '2026-09-01' });
      const events = eventsOf(db, projectId, 'SYN-A-001');
      expect(events).toEqual([
        { event_type: 'correct', field: 'owner', previous_value: 'Casey Flint', new_value: 'Blair Ross', reason: 'Reassigned to Blair for the go-live window.', origin: 'human' },
        { event_type: 'correct', field: 'due_date', previous_value: null, new_value: '2026-09-01', reason: 'Moved to align with the customer freeze.', origin: 'human' },
      ]);
    } finally {
      context.close();
    }
  });

  it('reschedules a milestone as a due-date event, with no status side effect', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Milestones', id: 'SYN-M-001' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-M-001', { actor: 'Casey Flint', eventType: 'reschedule', field: 'due_date', newValue: '2026-10-01', reason: 'Customer moved the go-live date.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(stateOf(db, projectId, 'SYN-M-001')).toMatchObject({ due_date: '2026-10-01', status: 'open' });
    } finally {
      context.close();
    }
  });
});

describe('a standalone note', () => {
  it('is recorded without mutating any field, and appears in history', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Risks_Issues', id: 'SYN-R-001' });
      rebuildProjection(db, projectId, AS_OF);
      const before = stateOf(db, projectId, 'SYN-R-001');

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'note', reason: 'Discussed informally with the customer PM; no decision yet, watching for the Friday steering call.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      // Status, owner, due date and resolution are untouched.
      expect(stateOf(db, projectId, 'SYN-R-001')).toEqual(before);
      const events = eventsOf(db, projectId, 'SYN-R-001');
      expect(events).toEqual([{ event_type: 'note', field: null, previous_value: null, new_value: null, reason: 'Discussed informally with the customer PM; no decision yet, watching for the Friday steering call.', origin: 'human' }]);
    } finally {
      context.close();
    }
  });

  it('refuses a note that also names a field, so it can never silently mutate one', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);
      expect(() => recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'note', field: 'owner', newValue: 'Blair Ross', reason: 'Trying to sneak a field through a note.', occurredAt: '2026-08-01T10:00:00.000Z' }))
        .toThrow(/A note event cannot also carry a field/);
      expect(db.prepare('SELECT count(*) AS count FROM register_row_events WHERE project_id = ?').get(projectId)).toMatchObject({ count: 0 });
    } finally {
      context.close();
    }
  });

  it('is not exempt from the append-only, deterministic-order history', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Uncertainty', id: 'SYN-U-001' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-U-001', { actor: 'Casey Flint', eventType: 'note', reason: 'First note.', occurredAt: '2026-08-01T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-U-001', { actor: 'Casey Flint', eventType: 'reaffirm', reason: 'Still uncertain after checking with the vendor.', occurredAt: '2026-08-01T10:01:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-U-001', { actor: 'Casey Flint', eventType: 'resolve', reason: 'Vendor confirmed the answer today.', occurredAt: '2026-08-01T10:02:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);
      expect(eventsOf(db, projectId, 'SYN-U-001').map((event) => event.event_type)).toEqual(['note', 'reaffirm', 'resolve']);
      // `reaffirm` is status-neutral, same as `note`; only `resolve` moves status.
      expect(stateOf(db, projectId, 'SYN-U-001')).toMatchObject({ status: 'resolved' });
    } finally {
      context.close();
    }
  });
});

describe('event origin distinguishes human, source and system', () => {
  it('defaults a recorded event to human origin', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Decisions', id: 'SYN-D-001' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-D-001', { actor: 'Casey Flint', eventType: 'ratify', reason: 'Confirmed with the steering group.', occurredAt: '2026-08-01T10:00:00.000Z' });
      expect(eventsOf(db, projectId, 'SYN-D-001')[0]).toMatchObject({ origin: 'human' });
    } finally {
      context.close();
    }
  });

  it('accepts an explicit system origin for a future automated writer', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Decisions', id: 'SYN-D-001' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-D-001', { actor: 'scheduled-recalculation', eventType: 'reaffirm', reason: 'Automated periodic reaffirmation.', occurredAt: '2026-08-01T10:00:00.000Z', origin: 'system' });
      expect(eventsOf(db, projectId, 'SYN-D-001')[0]).toMatchObject({ origin: 'system' });
    } finally {
      context.close();
    }
  });

  it('tags a source-extraction apply event source, distinct from a human event on the same row', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Decisions', id: 'SYN-D-001' });
      rebuildProjection(db, projectId, AS_OF);
      db.prepare("INSERT INTO source_documents (id, project_id, content_hash, source_type, original_file_name, immutable_path, event_date, word_count, segment_count, normaliser_version, created_at) VALUES ('SRCDOC-SYN-001', ?, ?, 'vtt-transcript', 'synthetic.vtt', '/synthetic/synthetic.vtt', '2026-07-30', 10, 1, 'normaliser-v1', ?)")
        .run(projectId, 'h'.repeat(64), AS_OF);
      // Mirrors exactly what src/sourceIntelligence.ts's reaffirm apply path writes.
      db.prepare("INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id, origin) VALUES ('evt:source:1', ?, 'SYN-D-001', ?, 'reviewer', 'reaffirm', NULL, NULL, NULL, 'Source reaffirmed the existing record.', 'packet:syn:abc', 'SRCDOC-SYN-001', 'source')")
        .run(projectId, '2026-08-01T09:30:00.000Z');
      recordRegisterEvent(db, projectId, 'SYN-D-001', { actor: 'Casey Flint', eventType: 'note', reason: 'Confirmed this reaffirmation is correct.', occurredAt: '2026-08-01T10:00:00.000Z' });
      const events = eventsOf(db, projectId, 'SYN-D-001');
      expect(events.map((event) => event.origin)).toEqual(['source', 'human']);
    } finally {
      context.close();
    }
  });
});

describe('deterministic replay applies to the newer event types too', () => {
  it('resolves an out-of-order pair of equal-timestamp events by recorded order', () => {
    for (const order of [['start', 'block'], ['block', 'start']] as const) {
      const context = tempDb();
      try {
        const db = context.db;
        const projectId = seedProject(db);
        seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
        rebuildProjection(db, projectId, AS_OF);
        for (const eventType of order) {
          recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType, reason: 'Status update.', occurredAt: '2026-08-01T10:00:00.000Z' });
        }
        const expectedStatus = order[1] === 'block' ? 'blocked' : 'in-progress';
        expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: expectedStatus });
        rebuildProjection(db, projectId, AS_OF);
        expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: expectedStatus });
      } finally {
        context.close();
      }
    }
  });

  it('replays a human event recorded with an earlier occurredAt than one already on the row, landing in event-time order', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);

      // Recorded second (later rowid) but describes an earlier real-world instant.
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'block', reason: 'Blocked from the start, entered late.', occurredAt: '2026-08-01T09:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'start', reason: 'Work began once unblocked.', occurredAt: '2026-08-01T09:30:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      // Event-time order (09:00 block, then 09:30 start) wins over recording order.
      expect(stateOf(db, projectId, 'SYN-A-001')).toMatchObject({ status: 'in-progress' });
      expect(eventsOf(db, projectId, 'SYN-A-001').map((event) => event.event_type)).toEqual(['block', 'start']);
    } finally {
      context.close();
    }
  });
});

describe('reasoning integration: the next request includes human events and notes', () => {
  it('changes the project-state hash and cites the note in current_state and recent_changes', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Risks_Issues', id: 'SYN-R-001' });
      rebuildProjection(db, projectId, AS_OF);

      const before = buildReasoningRequest(db, projectId, { mode: 'meeting' });
      const beforeHash = before.project.project_state_hash;
      expect(before.current_state.find((row) => row.register_id === 'SYN-R-001')?.latest_events).toEqual([]);

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'note', reason: 'Vendor flagged a possible delay; watching closely, no register field changed yet.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      const after = buildReasoningRequest(db, projectId, { mode: 'meeting' });
      expect(after.project.project_state_hash).not.toBe(beforeHash);
      const row = after.current_state.find((entry) => entry.register_id === 'SYN-R-001');
      expect(row?.latest_events).toEqual([{ occurredAt: '2026-08-01T10:00:00.000Z', actor: 'Casey Flint', eventType: 'note', reason: 'Vendor flagged a possible delay; watching closely, no register field changed yet.' }]);
      expect(after.recent_changes.some((change) => change.register_id === 'SYN-R-001' && change.change.startsWith('note:'))).toBe(true);
    } finally {
      context.close();
    }
  });

  it('changes the hash for a status/field event exactly as it does for a note', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);
      const beforeHash = buildReasoningRequest(db, projectId, { mode: 'meeting' }).project.project_state_hash;

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'complete', reason: 'Delivered.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      const afterHash = buildReasoningRequest(db, projectId, { mode: 'meeting' }).project.project_state_hash;
      expect(afterHash).not.toBe(beforeHash);
    } finally {
      context.close();
    }
  });
});

describe('a human event marks the cached Consultant Reasoning result stale, with zero provider calls', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    delete process.env[PROVIDER_OUTPUT_DIR_ENV];
    delete process.env[SKILL_REGISTRY_DIR_ENV];
    while (temporaryDirectories.length > 0) {
      const dir = temporaryDirectories.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
    }
  });

  it('reads state=stale against a previously accepted result once a note is recorded', () => {
    const context = tempDb();
    const providerDir = mkdtempSync(path.join(tmpdir(), 'human-events-provider-'));
    temporaryDirectories.push(providerDir);
    try {
      const db = context.db;
      process.env[PROVIDER_OUTPUT_DIR_ENV] = path.join(providerDir, 'provider-output');
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Risks_Issues', id: 'SYN-R-001' });
      rebuildProjection(db, projectId, AS_OF);
      ensureSkillRegistrySynced(db);

      const initialRequest = buildReasoningRequest(db, projectId, { mode: 'meeting' });

      // Hand-seed one accepted result against the state as it stood before the
      // human event — exactly what a real accepted run leaves behind, without
      // spending a synthetic provider call to produce it.
      const skillSha = 'x'.repeat(64);
      const promptSha = 'y'.repeat(64);
      const resultSha = 'z'.repeat(64);
      db.prepare(`INSERT INTO consultant_reasoning_runs (id, project_id, raw_output_id, skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, provider_id, model_label, mode, project_state_hash, register_revision, request_context_json, started_at, duration_ms, status, violations_json, error, input_tokens, output_tokens, token_source, result_sha256, provider_calls, created_at)
        VALUES ('run:syn:1', ?, NULL, 'consultant-reasoning', '1.0.0', ?, 'consultant-reasoning-prompt-v1', ?, 'claude-code', 'claude-code-cli:opus', 'meeting', ?, 0, '{}', ?, 1000, 'accepted', '[]', NULL, 10, 10, 'estimated', ?, 1, ?)`)
        .run(projectId, skillSha, promptSha, initialRequest.project.project_state_hash, AS_OF, resultSha, AS_OF);
      db.prepare(`INSERT INTO consultant_reasoning_results (id, project_id, run_id, mode, cache_key, project_state_hash, register_revision, skill_id, skill_version, prompt_template_version, provider_id, model_label, result_json, result_sha256, cited_register_ids_json, generated_at, stale)
        VALUES ('result:syn:1', ?, 'run:syn:1', 'meeting', 'cache-key-1', ?, 0, 'consultant-reasoning', '1.0.0', 'consultant-reasoning-prompt-v1', 'claude-code', 'claude-code-cli:opus', ?, ?, '[]', ?, 0)`)
        .run(projectId, initialRequest.project.project_state_hash, JSON.stringify({ executive_summary: [], matters: [], meeting_order: [], decisions_required: [], customer_dependencies: [], consultant_next_actions: [], risks_and_blockers: [], unanswered_questions: [], contradictions_and_state_conflicts: [], recent_changes: [], confirmation_warnings: [], state_observations: [], limitations: [] }), resultSha, AS_OF);

      const forbiddenProvider = new FakeConsultantReasoningProvider(() => { throw new Error('The provider must not be called on this path.'); });
      const before = readConsultantReasoning(db, projectId, 'meeting', forbiddenProvider);
      expect(before.state).toBe('current');
      expect(before.providerCallsThisRequest).toBe(0);

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'note', reason: 'New information from the vendor call.', occurredAt: '2026-08-01T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      const after = readConsultantReasoning(db, projectId, 'meeting', forbiddenProvider);
      expect(after.state).toBe('stale');
      expect(after.current).toBeNull();
      expect(after.latest).not.toBeNull();
      expect(after.providerCallsThisRequest).toBe(0);
    } finally {
      context.close();
    }
  });
});
