import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import {
  canonicalNormalizedRowJson,
  canonicalRowJson,
  correctableFields,
  readActiveScoringConfig,
  readTypedDetails,
  rebuildProjection,
  recordRegisterEvent,
} from '../src/registerProjection';

/* ------------------------------------------------------------------------- *
 * N2 — a human correction outside {status, owner, due_date, resolution} was
 * recorded and then silently discarded.
 *
 * `stateFor` applied an event only when `Object.hasOwn(state, field)` held, and
 * `register_row_state` has exactly four columns. So a consultant recording
 * `severity: low` on a risk wrote a permanent row to the append-only event log
 * and changed nothing: the typed detail table, the operational row, the
 * projection and the score all still showed the extracted `high`.
 *
 * It was worse than inert. `contestedFields` in `sourceIntelligence.ts` DOES
 * consider typed-detail keys, so that invisible event permanently converted
 * every later extracted update to `severity` into a `conflict`. The human's
 * edit did nothing except block the machine.
 *
 * These tests pin the repair: corrections to typed-detail fields and to
 * `title`/`summary` are replayed from the event log like every other event,
 * reach the detail tables, the operational tables and the score, and leave
 * `rebuildProjection` idempotent and byte-identical at a fixed as-of instant.
 * ------------------------------------------------------------------------- */

const AS_OF = '2026-07-30T09:00:00.000Z';
const importRunFor = (projectId: string) => `human-corrections-run:${projectId}`;

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-corrections-'));
  const context = openProjectManagairDatabase(path.join(dir, 'projectmanagair.db'));
  return { db: context.db, close: () => { context.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DatabaseSync, projectId = 'proj') {
  db.prepare('INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'Synthetic Correction Fixture', 'SYN', 'Synthetic fixture project.', 'on-track', 'delivery', 'Casey Flint', '2026-01-01', '2026-12-31', null, AS_OF, AS_OF, 'fictional');
  db.prepare("INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json) VALUES (?, ?, 'project_register_benchmark', 1, 'SYN', ?, 'completed', ?, ?, 0, 0, '[]', 'verified', '{}')")
    .run(importRunFor(projectId), projectId, `hash-${projectId}`, AS_OF, AS_OF);
  return projectId;
}

interface SeedRow { register: string; id: string; status?: string; owner?: string | null; raw?: Record<string, unknown>; title?: string; summary?: string }

function seedRegisterRow(db: DatabaseSync, projectId: string, row: SeedRow) {
  const title = row.title ?? `${row.id} title`;
  const summary = row.summary ?? `${row.id} summary`;
  const raw = { id: row.id, title, summary, status: row.status ?? 'open', ...row.raw };
  db.prepare('INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, \'[]\', \'[]\', \'[]\', ?, NULL, NULL, ?, ?, ?, ?, ?)')
    .run(`register:${projectId}:${row.id}`, projectId, row.register, row.id, title, summary, row.status ?? 'open', row.owner ?? null, row.status ?? 'open', importRunFor(projectId), row.register, canonicalRowJson(raw), canonicalNormalizedRowJson(raw), AS_OF, AS_OF);
  return `register:${projectId}:${row.id}`;
}

function seedRisk(db: DatabaseSync, projectId: string, id: string, detail: { severity?: string; likelihood?: string; mitigation?: string; impact?: string; driver?: string } = {}) {
  // `details` also lives in `raw_row_json`, exactly as the apply path writes it,
  // so the test can prove the extracted value survives the correction.
  const rowId = seedRegisterRow(db, projectId, { register: 'Risks_Issues', id, raw: { details: { severity: detail.severity ?? 'high', likelihood: detail.likelihood ?? 'likely', mitigation: detail.mitigation ?? 'Extracted mitigation.' } } });
  db.prepare('INSERT INTO register_risk_issue_details (register_row_id, driver, evidence, impact, mitigation, likelihood, severity) VALUES (?, ?, NULL, ?, ?, ?, ?)')
    .run(rowId, detail.driver ?? 'Extracted driver.', detail.impact ?? 'Extracted impact.', detail.mitigation ?? 'Extracted mitigation.', detail.likelihood ?? 'likely', detail.severity ?? 'high');
  return rowId;
}

const scoreOf = (db: DatabaseSync, projectId: string, id: string) =>
  db.prepare('SELECT score, band, inputs_json FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, id) as { score: number; band: string; inputs_json: string };

/** Everything a correction is supposed to be able to reach, in a stable order. */
function dumpEverything(db: DatabaseSync, projectId: string) {
  const tables: Array<[string, string]> = [
    ['actions', 'id'], ['decisions', 'id'], ['risks_issues', 'id'], ['changes', 'id'], ['open_questions', 'id'],
    ['milestones', 'id'], ['project_sources', 'id'], ['register_row_state', 'external_register_id'], ['register_row_scores', 'external_register_id'],
  ];
  const projected = tables.map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${order}`).all(projectId)]);
  const details = ['register_risk_issue_details', 'register_open_question_details', 'register_decision_details'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY register_row_id`).all()]);
  const rows = db.prepare('SELECT id, title, summary, raw_row_json FROM project_register_rows WHERE project_id = ? ORDER BY id').all(projectId);
  return JSON.stringify([projected, details, rows]);
}

/* ------------------------------------------------------------------------- *
 * The reviewer's reproduction, end to end.
 * ------------------------------------------------------------------------- */

describe('N2 — a correction to a typed-detail field reaches the projection, the detail table and the score', () => {
  it('changes severity everywhere it is read, and rescores the row', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      const rowId = seedRisk(db, projectId, 'SYN-R-001');
      rebuildProjection(db, projectId, AS_OF);

      const active = readActiveScoringConfig(db);
      const weights = active.weights;
      // Pin the bands either side of the two scores, so the demotion the
      // correction causes is visible as a band change and not only as a number.
      const highScore = weights.register.Risks_Issues + weights.severity.high + weights.likelihood.likely;
      db.prepare('UPDATE scoring_config SET weights_json = ? WHERE version = ?').run(JSON.stringify({ ...weights, bands: { now: highScore + 1, soon: highScore, watch: 0 } }), active.version);
      rebuildProjection(db, projectId, AS_OF);
      const before = scoreOf(db, projectId, 'SYN-R-001');
      expect(db.prepare('SELECT severity FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ severity: 'high' });
      expect(db.prepare("SELECT severity FROM risks_issues WHERE id = 'SYN-R-001'").get()).toMatchObject({ severity: 'high' });
      expect(JSON.parse(before.inputs_json)).toMatchObject({ severity: 'high' });
      expect(before.band).toBe('Soon');

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: 'low', reason: 'Reassessed with the customer; the exposure is bounded.', occurredAt: '2026-07-30T10:00:00.000Z' });
      rebuildProjection(db, projectId, AS_OF);

      // The typed detail table — the row the reviewer found unchanged.
      expect(db.prepare('SELECT severity FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ severity: 'low' });
      // Every canonical reader of typed detail.
      expect(readTypedDetails(db, 'Risks_Issues', rowId)).toMatchObject({ severity: 'low' });
      // The operational row the cockpit renders.
      expect(db.prepare("SELECT severity FROM risks_issues WHERE id = 'SYN-R-001'").get()).toMatchObject({ severity: 'low' });

      // And the score, which is what actually moves the row in the queue.
      const after = scoreOf(db, projectId, 'SYN-R-001');
      expect(JSON.parse(after.inputs_json)).toMatchObject({ severity: 'low' });
      expect(after.score).toBe(before.score - weights.severity.high + weights.severity.low);
      // `high` and `critical` force the `Soon` band outright; with the corrected
      // severity the row is banded on its score, and drops out of Soon.
      expect(after.band).toBe('Watch');

      // The extracted value is not destroyed: it stays in the immutable record
      // of what the source asserted, and on the event that replaced it.
      const raw = JSON.parse((db.prepare('SELECT raw_row_json FROM project_register_rows WHERE id = ?').get(rowId) as { raw_row_json: string }).raw_row_json) as { details: Record<string, unknown> };
      expect(raw.details.severity).toBe('high');
      expect(db.prepare("SELECT previous_value, new_value FROM register_row_events WHERE project_id = ? AND field = 'severity'").get(projectId)).toMatchObject({ previous_value: 'high', new_value: 'low' });
    } finally {
      context.close();
    }
  });

  it('records the value it replaced on the event, instead of a null previous_value', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRisk(db, projectId, 'SYN-R-001');
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: 'low', reason: 'Reassessed with the customer.', occurredAt: '2026-07-30T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'title', newValue: 'Permit counts understated', reason: 'The transcript mis-heard the risk title.', occurredAt: '2026-07-30T10:05:00.000Z' });

      const events = db.prepare('SELECT field, previous_value, new_value FROM register_row_events WHERE project_id = ? ORDER BY occurred_at').all(projectId) as Array<Record<string, unknown>>;
      expect(events).toEqual([
        { field: 'severity', previous_value: 'high', new_value: 'low' },
        { field: 'title', previous_value: 'SYN-R-001 title', new_value: 'Permit counts understated' },
      ]);
    } finally {
      context.close();
    }
  });

  it('carries a mitigation correction into the operational response column', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      const rowId = seedRisk(db, projectId, 'SYN-R-001');
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT response FROM risks_issues WHERE id = 'SYN-R-001'").get()).toMatchObject({ response: 'Extracted mitigation.' });

      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'mitigation', newValue: 'Second supplier engaged and the permits are pre-cleared.', reason: 'The mitigation agreed in the session was not the one extracted.', occurredAt: '2026-07-30T10:00:00.000Z' });

      expect(db.prepare('SELECT mitigation FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ mitigation: 'Second supplier engaged and the permits are pre-cleared.' });
      expect(db.prepare("SELECT response FROM risks_issues WHERE id = 'SYN-R-001'").get()).toMatchObject({ response: 'Second supplier engaged and the permits are pre-cleared.' });
    } finally {
      context.close();
    }
  });

  it('corrects title and summary on the register row and everywhere they are projected', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Avery Lane' });
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT title, summary FROM actions WHERE id = 'SYN-A-001'").get()).toMatchObject({ title: 'SYN-A-001 title', summary: 'SYN-A-001 summary' });

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'title', newValue: 'Confirm the permit mapping', reason: 'The extracted title named the wrong artefact.', occurredAt: '2026-07-30T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'summary', newValue: 'Confirm the mapping with the permit authority before the pilot.', reason: 'The summary omitted the dependency.', occurredAt: '2026-07-30T10:01:00.000Z' });

      expect(db.prepare("SELECT title, summary FROM actions WHERE id = 'SYN-A-001'").get()).toMatchObject({ title: 'Confirm the permit mapping', summary: 'Confirm the mapping with the permit authority before the pilot.' });
      expect(db.prepare('SELECT title, summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001'))
        .toMatchObject({ title: 'Confirm the permit mapping', summary: 'Confirm the mapping with the permit authority before the pilot.' });

      // The verbatim record of what the source asserted is untouched: it is the
      // `before` side of every field diff and the workbook parity baseline.
      const raw = JSON.parse((db.prepare('SELECT raw_row_json FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001') as { raw_row_json: string }).raw_row_json) as Record<string, unknown>;
      expect(raw).toMatchObject({ title: 'SYN-A-001 title', summary: 'SYN-A-001 summary' });
    } finally {
      context.close();
    }
  });

  it('coerces a correction to an integer detail column instead of writing a string into it', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      const rowId = seedRegisterRow(db, projectId, { register: 'Open_Questions', id: 'SYN-Q-001' });
      db.prepare('INSERT INTO register_open_question_details (register_row_id, question, parked_with, unblocked_by, blocking) VALUES (?, ?, NULL, NULL, 0)').run(rowId, 'Which permit class applies?');
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT blocking FROM open_questions WHERE id = 'SYN-Q-001'").get()).toMatchObject({ blocking: 0 });

      recordRegisterEvent(db, projectId, 'SYN-Q-001', { actor: 'Casey Flint', eventType: 'mark-blocking', field: 'blocking', newValue: 'true', reason: 'Nothing downstream can start until this is answered.', occurredAt: '2026-07-30T10:00:00.000Z' });

      expect(db.prepare('SELECT blocking FROM register_open_question_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ blocking: 1 });
      expect(db.prepare("SELECT blocking FROM open_questions WHERE id = 'SYN-Q-001'").get()).toMatchObject({ blocking: 1 });
      // Blocking is a band override, so the correction has to move the row.
      expect(scoreOf(db, projectId, 'SYN-Q-001').band).toBe('Now');
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Determinism. The whole point of replaying from the event log.
 * ------------------------------------------------------------------------- */

describe('N2 — corrections replay deterministically', () => {
  it('rebuilds byte-identically at a fixed as-of instant, however many times it runs', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRisk(db, projectId, 'SYN-R-001');
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Avery Lane' });
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: 'low', reason: 'Reassessed.', occurredAt: '2026-07-30T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'title', newValue: 'Corrected action title', reason: 'Mis-transcribed.', occurredAt: '2026-07-30T10:01:00.000Z' });

      rebuildProjection(db, projectId, AS_OF);
      const first = dumpEverything(db, projectId);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        rebuildProjection(db, projectId, AS_OF);
        expect(dumpEverything(db, projectId)).toBe(first);
      }
    } finally {
      context.close();
    }
  });

  it('resolves two corrections to the same field by recorded order, whichever way round they arrive', () => {
    for (const order of [['low', 'medium'], ['medium', 'low']] as const) {
      const context = tempDb();
      try {
        const db = context.db;
        const projectId = seedProject(db);
        const rowId = seedRisk(db, projectId, 'SYN-R-001');
        rebuildProjection(db, projectId, AS_OF);
        for (const value of order) {
          recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: value, reason: 'Reassessed.', occurredAt: '2026-07-30T10:00:00.000Z' });
        }
        // Equal timestamps: the event recorded second wins, in both orders (C6).
        expect(db.prepare('SELECT severity FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ severity: order[1] });
        rebuildProjection(db, projectId, AS_OF);
        expect(db.prepare('SELECT severity FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ severity: order[1] });
      } finally {
        context.close();
      }
    }
  });

  it('survives a source restating the value the human replaced', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      const rowId = seedRisk(db, projectId, 'SYN-R-001');
      rebuildProjection(db, projectId, AS_OF);
      recordRegisterEvent(db, projectId, 'SYN-R-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: 'low', reason: 'Reassessed.', occurredAt: '2026-07-30T10:00:00.000Z' });

      // Exactly what `writeTyped` does when a later changeset applies: it
      // rewrites the detail row from the packet's assertion. The correction is
      // restored by the rebuild that follows every apply, because the event log
      // — not the detail table — is the record of the human's decision.
      db.prepare('UPDATE register_risk_issue_details SET severity = ? WHERE register_row_id = ?').run('high', rowId);
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare('SELECT severity FROM register_risk_issue_details WHERE register_row_id = ?').get(rowId)).toMatchObject({ severity: 'low' });
    } finally {
      context.close();
    }
  });

  it('leaves the four state fields behaving exactly as they did', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Avery Lane' });
      rebuildProjection(db, projectId, AS_OF);

      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'update', field: 'owner', newValue: 'Blair Ross', reason: 'Reassigned.', occurredAt: '2026-07-30T10:00:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'update', field: 'due_date', newValue: '2026-08-14', reason: 'Moved with the customer.', occurredAt: '2026-07-30T10:01:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'complete', reason: 'Delivered in the session.', occurredAt: '2026-07-30T10:02:00.000Z' });
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'update', field: 'resolution', newValue: 'Mapping signed off.', reason: 'Recorded the outcome.', occurredAt: '2026-07-30T10:03:00.000Z' });

      expect(db.prepare('SELECT status, owner, due_date, resolution FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001'))
        .toMatchObject({ status: 'completed', owner: 'Blair Ross', due_date: '2026-08-14', resolution: 'Mapping signed off.' });
      expect(db.prepare("SELECT status, owner, due_date FROM actions WHERE id = 'SYN-A-001'").get())
        .toMatchObject({ status: 'completed', owner: 'Blair Ross', due_date: '2026-08-14' });

      // An `owner` correction still normalises the unowned sentinel to NULL.
      recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'update', field: 'owner', newValue: 'TBC', reason: 'Owner left the programme.', occurredAt: '2026-07-30T10:04:00.000Z' });
      expect(db.prepare('SELECT owner FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001')).toMatchObject({ owner: null });
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * A field the projector cannot reach must not be recorded at all.
 * ------------------------------------------------------------------------- */

describe('N2 — an unprojectable field is refused rather than silently discarded', () => {
  it('rejects a field this register cannot carry, and writes no event', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      rebuildProjection(db, projectId, AS_OF);

      // `severity` is a Risks_Issues field; an Actions row cannot hold it.
      expect(() => recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'severity', newValue: 'low', reason: 'Wrong register.', occurredAt: '2026-07-30T10:00:00.000Z' }))
        .toThrow(/not a correctable field on a Actions row/);
      expect(() => recordRegisterEvent(db, projectId, 'SYN-A-001', { actor: 'Casey Flint', eventType: 'correct', field: 'nonsense', newValue: 'x', reason: 'Typo in the client.', occurredAt: '2026-07-30T10:00:00.000Z' }))
        .toThrow(/Correctable fields: due_date, owner, resolution, status, summary, title/);
      expect(db.prepare('SELECT count(*) AS count FROM register_row_events WHERE project_id = ?').get(projectId)).toMatchObject({ count: 0 });
    } finally {
      context.close();
    }
  });

  it('publishes the correctable set from the schema, per register', () => {
    const context = tempDb();
    try {
      const db = context.db;
      expect(correctableFields(db, 'Risks_Issues')).toEqual(['driver', 'due_date', 'evidence', 'impact', 'likelihood', 'mitigation', 'owner', 'resolution', 'severity', 'status', 'summary', 'title']);
      expect(correctableFields(db, 'Open_Questions')).toEqual(['blocking', 'due_date', 'owner', 'parked_with', 'question', 'resolution', 'status', 'summary', 'title', 'unblocked_by']);
      // A register with no typed detail table still carries the common set.
      expect(correctableFields(db, 'Actions')).toEqual(['due_date', 'owner', 'resolution', 'status', 'summary', 'title']);
      // `aliases_json` holds a structured value a single new_value string
      // cannot express, so it is deliberately not correctable this way.
      expect(correctableFields(db, 'Entities')).not.toContain('aliases');
      expect(correctableFields(db, 'Entities')).not.toContain('aliases_json');
    } finally {
      context.close();
    }
  });
});
