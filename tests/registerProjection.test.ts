import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import {
  canonicalNormalizedRowJson,
  canonicalNormalizedValue,
  canonicalRowJson,
  canonicalValueJson,
  decisionStatus,
  isUnownedOwner,
  milestoneStatus,
  readActiveScoringConfig,
  rebuildProjection,
  recordRegisterEvent,
  SCORING_VERSION,
} from '../src/registerProjection';
import { importProjectRegisterBenchmark, recomputeRegisterFieldParity } from '../src/projectRegisters';

/* ------------------------------------------------------------------------- *
 * Fixtures. Every register row is seeded through plain SQL so the projector is
 * exercised on its own, without the import path deciding what it sees.
 * ------------------------------------------------------------------------- */

const AS_OF = '2026-07-30T09:00:00.000Z';
const importRunFor = (projectId: string) => `test-import-run:${projectId}`;

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-projection-'));
  const context = openProjectManagairDatabase(path.join(dir, 'projectmanagair.db'));
  return { dir, db: context.db, close: () => { context.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DatabaseSync, projectId = 'proj', owner = 'Casey Flint') {
  db.prepare('INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'Synthetic Projection Fixture', 'SYN', 'Synthetic fixture project.', 'on-track', 'delivery', owner, '2026-01-01', '2026-12-31', null, AS_OF, AS_OF, 'fictional');
  db.prepare("INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json) VALUES (?, ?, 'project_register_benchmark', 1, 'SYN', ?, 'completed', ?, ?, 0, 0, '[]', 'verified', '{}')")
    .run(importRunFor(projectId), projectId, `hash-${projectId}`, AS_OF, AS_OF);
  return projectId;
}

interface SeedRow {
  register: string;
  id: string;
  status?: string;
  owner?: string | null;
  raw?: Record<string, unknown>;
  createdAt?: string;
}

function seedRegisterRow(db: DatabaseSync, projectId: string, row: SeedRow) {
  const raw = { id: row.id, title: `${row.id} title`, status: row.status ?? 'open', ...row.raw };
  db.prepare('INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, \'[]\', \'[]\', \'[]\', ?, NULL, NULL, ?, ?, ?, ?, ?)')
    .run(`register:${projectId}:${row.id}`, projectId, row.register, row.id, String(raw.title), `${row.id} summary`, row.status ?? 'open', row.owner ?? null, row.status ?? 'open', importRunFor(projectId), row.register, canonicalRowJson(raw), canonicalNormalizedRowJson(raw), row.createdAt ?? AS_OF, row.createdAt ?? AS_OF);
}

function insertEvent(db: DatabaseSync, projectId: string, externalId: string, id: string, occurredAt: string, field: string | null, newValue: string | null, eventType = 'note') {
  db.prepare('INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)')
    .run(id, projectId, externalId, occurredAt, 'Casey Flint', eventType, field, newValue, 'Synthetic human event.');
}

/** Every table the projector writes, serialised in a stable order. */
function dumpProjection(db: DatabaseSync, projectId: string) {
  const tables: Array<[string, string]> = [
    ['actions', 'id'], ['decisions', 'id'], ['risks_issues', 'id'], ['changes', 'id'], ['open_questions', 'id'],
    ['milestones', 'id'], ['project_sources', 'id'], ['register_row_state', 'external_register_id'], ['register_row_scores', 'external_register_id'],
  ];
  return JSON.stringify(tables.map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${order}`).all(projectId)]));
}

/* ------------------------------------------------------------------------- *
 * C3 — the projector owns only what it produced.
 * ------------------------------------------------------------------------- */

describe('rebuildProjection ownership (C3)', () => {
  it('preserves independently imported operational rows and leaves no dangling milestone references', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);

      // Rows written directly by importProjectPayload / the M365 projection /
      // the E2E fixture loader. The projector did not create these and must
      // never touch them.
      db.prepare("INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES ('src-m365', ?, 'm365-folder', 'Connected folder', 'Cloud/Folder', ?, 'fictional')").run(projectId, AS_OF);
      db.prepare("INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES ('fixture-action', ?, 'Fixture action', 'open', 'Avery Lane', ?, 'fictional', 'Fixture action summary.', 'medium', NULL, 0, NULL, NULL)").run(projectId, AS_OF);
      db.prepare("INSERT INTO milestones (id, project_id, title, status, owner, updated_at, data_classification, summary, target_date, milestone_status, completion_percent, work_package_ids_json, needs_user_attention, attention_owner) VALUES ('fixture-milestone', ?, 'Fixture milestone', 'open', 'Avery Lane', ?, 'fictional', 'Fixture milestone summary.', '2026-09-01', 'not-started', 0, '[]', 0, NULL)").run(projectId, AS_OF);
      db.prepare("INSERT INTO work_packages (id, project_id, title, status, owner, updated_at, data_classification, summary, work_package_status, lead, start_date, target_date, completion_percent, blocker_summary, milestone_id, needs_user_attention, attention_owner) VALUES ('fixture-wp', ?, 'Fixture work package', 'open', 'Avery Lane', ?, 'fictional', 'Fixture work package.', 'in-progress', 'Avery Lane', '2026-01-01', '2026-09-01', 10, NULL, 'fixture-milestone', 0, NULL)").run(projectId, AS_OF);
      db.prepare("UPDATE projects SET next_milestone_id = 'fixture-milestone' WHERE id = ?").run(projectId);

      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Avery Lane' });
      seedRegisterRow(db, projectId, { register: 'Milestones', id: 'SYN-M-001' });
      seedRegisterRow(db, projectId, { register: 'Sources', id: 'SYN-S-001' });

      rebuildProjection(db, projectId, AS_OF);
      rebuildProjection(db, projectId, AS_OF);

      // The rows the projector does not own survive, exactly once each.
      expect(db.prepare("SELECT count(*) AS count FROM project_sources WHERE id = 'src-m365'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM actions WHERE id = 'fixture-action'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM milestones WHERE id = 'fixture-milestone'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT title FROM actions WHERE id = 'fixture-action'").get()).toMatchObject({ title: 'Fixture action' });

      // The rows it does own are projected once, not duplicated by the rebuild.
      expect(db.prepare('SELECT count(*) AS count FROM actions WHERE project_id = ?').get(projectId)).toMatchObject({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM milestones WHERE project_id = ?').get(projectId)).toMatchObject({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM project_sources WHERE project_id = ?').get(projectId)).toMatchObject({ count: 2 });

      // No reference is left pointing at a milestone that no longer exists.
      const dangling = db.prepare("SELECT count(*) AS count FROM work_packages WHERE project_id = ? AND milestone_id IS NOT NULL AND milestone_id <> '' AND milestone_id NOT IN (SELECT id FROM milestones)").get(projectId);
      expect(dangling).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT milestone_id FROM work_packages WHERE id = 'fixture-wp'").get()).toMatchObject({ milestone_id: 'fixture-milestone' });
      expect(db.prepare('SELECT next_milestone_id FROM projects WHERE id = ?').get(projectId)).toMatchObject({ next_milestone_id: 'fixture-milestone' });
    } finally {
      context.close();
    }
  });

  it('retires a projected row that leaves the register and repairs the references it leaves behind', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Milestones', id: 'SYN-M-001' });
      rebuildProjection(db, projectId, AS_OF);

      db.prepare("INSERT INTO work_packages (id, project_id, title, status, owner, updated_at, data_classification, summary, work_package_status, lead, start_date, target_date, completion_percent, blocker_summary, milestone_id, needs_user_attention, attention_owner) VALUES ('wp-1', ?, 'Work package', 'open', 'Avery Lane', ?, 'fictional', 'Work package.', 'in-progress', 'Avery Lane', '2026-01-01', '2026-09-01', 10, NULL, 'SYN-M-001', 0, NULL)").run(projectId, AS_OF);
      db.prepare("UPDATE projects SET next_milestone_id = 'SYN-M-001' WHERE id = ?").run(projectId);
      // A rebuild while the row is still in the register must not disturb the
      // reference: the row is rewritten in place, never deleted and re-added.
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT milestone_id FROM work_packages WHERE id = 'wp-1'").get()).toMatchObject({ milestone_id: 'SYN-M-001' });

      db.prepare('DELETE FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').run(projectId, 'SYN-M-001');
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT count(*) AS count FROM milestones WHERE id = 'SYN-M-001'").get()).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT milestone_id FROM work_packages WHERE id = 'wp-1'").get()).toMatchObject({ milestone_id: null });
      expect(db.prepare('SELECT next_milestone_id FROM projects WHERE id = ?').get(projectId)).toMatchObject({ next_milestone_id: null });
    } finally {
      context.close();
    }
  });

  it('refuses to project a register row over an operational row owned by another project', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db, 'proj-a');
      seedProject(db, 'proj-b');
      db.prepare("INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES ('SHARED-A-001', 'proj-b', 'Other project action', 'open', 'Avery Lane', ?, 'fictional', 'Other project.', 'medium', NULL, 0, NULL, NULL)").run(AS_OF);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SHARED-A-001' });
      expect(() => rebuildProjection(db, projectId, AS_OF)).toThrow(/already belongs to project proj-b/);
      expect(db.prepare("SELECT project_id FROM actions WHERE id = 'SHARED-A-001'").get()).toMatchObject({ project_id: 'proj-b' });
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * C5 — scoring is a function of the as-of timestamp, not the wall clock.
 * ------------------------------------------------------------------------- */

describe('deterministic scoring (C5)', () => {
  it('rebuilds byte-identically and derives staleness from the as-of timestamp, not Date.now()', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      // Created long before any plausible wall clock, so the old
      // `Date.now() - createdAt > 21 days` test would always fire.
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Avery Lane', createdAt: '2020-01-01T00:00:00.000Z' });

      rebuildProjection(db, projectId, AS_OF);
      const first = dumpProjection(db, projectId);
      rebuildProjection(db, projectId, AS_OF);
      expect(dumpProjection(db, projectId)).toBe(first);

      const stalenessWeight = readActiveScoringConfig(db).weights.staleness;
      const inputsAt = (asOf: string) => {
        rebuildProjection(db, projectId, asOf);
        const row = db.prepare('SELECT inputs_json FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001') as { inputs_json: string };
        return JSON.parse(row.inputs_json) as Record<string, number>;
      };

      // Ten days after creation: not yet stale, whatever today happens to be.
      expect(inputsAt('2020-01-11T00:00:00.000Z').staleness).toBe(0);
      // Thirty days after creation: stale, by the same rule.
      expect(inputsAt('2020-01-31T00:00:00.000Z').staleness).toBe(stalenessWeight);
      expect(inputsAt('2020-01-11T00:00:00.000Z').staleness).toBe(0);
    } finally {
      context.close();
    }
  });

  it('has no implicit clock read left in the scoring or projection path', () => {
    const source = readFileSync(path.resolve('src', 'registerProjection.ts'), 'utf8');
    // The only permitted clock read is the default as-of instant.
    expect(source).not.toMatch(/Date\.now\(\)/);
    const constructions = [...source.matchAll(/new Date\((.*?)\)/g)].map((match) => match[1]);
    expect(constructions.filter((argument) => argument.trim() === '')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- *
 * C6 — equal timestamps project deterministically.
 * ------------------------------------------------------------------------- */

describe('event ordering (C6)', () => {
  it('projects the same state whichever order two equal-timestamp events are inserted, every time', () => {
    const owners = new Set<string>();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      for (const order of [['first', 'second'], ['second', 'first']] as const) {
        const context = tempDb();
        try {
          const db = context.db;
          const projectId = seedProject(db);
          seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
          for (const which of order) {
            recordRegisterEvent(db, projectId, 'SYN-A-001', {
              actor: 'Casey Flint',
              eventType: 'update',
              field: 'owner',
              newValue: which === 'first' ? 'Avery Lane' : 'Blair Ross',
              reason: 'Synthetic equal-timestamp event.',
              occurredAt: '2026-07-20T10:00:00.000Z',
            });
          }
          const state = db.prepare('SELECT owner FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-A-001') as { owner: string };
          // The second event recorded wins, in both insertion orders.
          expect(state.owner).toBe(order[1] === 'first' ? 'Avery Lane' : 'Blair Ross');
          owners.add(`${order.join('>')}:${state.owner}`);
        } finally {
          context.close();
        }
      }
    }
    expect([...owners].sort()).toEqual(['first>second:Blair Ross', 'second>first:Avery Lane']);
  });

  it('rests on a rowid that is monotonic on insert and order-preserving across VACUUM', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      const ids = ['zzz-inserted-first', 'aaa-inserted-second', 'mmm-inserted-third'];
      ids.forEach((id, index) => insertEvent(db, projectId, 'SYN-A-001', id, '2026-07-20T10:00:00.000Z', 'owner', `Owner ${index}`));
      const order = () => (db.prepare('SELECT id FROM register_row_events ORDER BY occurred_at, rowid').all() as Array<{ id: string }>).map((row) => row.id);
      const rowids = (db.prepare('SELECT rowid AS rid FROM register_row_events ORDER BY rowid').all() as Array<{ rid: number }>).map((row) => row.rid);
      expect(rowids).toEqual([...rowids].sort((a, b) => a - b));
      expect(order()).toEqual(ids);
      db.exec('VACUUM;');
      expect(order()).toEqual(ids);
      // And the ordering is genuinely not the id ordering, so the test would
      // have caught the old `ORDER BY occurred_at, id` clause.
      expect(order()).not.toEqual([...ids].sort());
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * C10 — unowned high-priority rows reach the queue.
 * ------------------------------------------------------------------------- */

describe('attention for unowned rows (C10)', () => {
  it('puts an unowned Now-band action in front of the consultant with a reason', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: null, raw: { due_date: '2026-01-01' } });
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-002', owner: 'Unassigned', raw: { due_date: '2026-01-01' } });
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-003', owner: 'Blair Ross (customer)', raw: { due_date: '2026-01-01' } });
      rebuildProjection(db, projectId, AS_OF);

      for (const id of ['SYN-A-001', 'SYN-A-002']) {
        const score = db.prepare('SELECT band FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, id) as { band: string };
        expect(score.band).toBe('Now');
        const action = db.prepare('SELECT owner, needs_user_attention, attention_owner, attention_reason FROM actions WHERE id = ?').get(id) as { owner: string; needs_user_attention: number; attention_owner: string; attention_reason: string };
        expect(action.needs_user_attention).toBe(1);
        expect(action.attention_owner).toBe('current-user');
        expect(action.attention_reason).toMatch(/Now band/);
        expect(action.attention_reason).toMatch(/no owner recorded/);
        // The sentinel survives only where the column forbids NULL.
        expect(action.owner).toBe('Unassigned');
        expect(db.prepare('SELECT owner FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, id)).toMatchObject({ owner: null });
      }

      // A customer-owned row is still not the consultant's queue.
      const owned = db.prepare("SELECT needs_user_attention, owner FROM actions WHERE id = 'SYN-A-003'").get() as { needs_user_attention: number; owner: string };
      expect(owned.needs_user_attention).toBe(0);
      expect(owned.owner).toBe('Blair Ross (customer)');
    } finally {
      context.close();
    }
  });

  it('treats the sentinel and its common spellings as unowned', () => {
    for (const value of [null, undefined, '', '  ', 'Unassigned', 'unassigned.', 'TBC', 'not stated', 'n/a', '-', 'Unknown']) {
      expect(isUnownedOwner(value)).toBe(true);
    }
    for (const value of ['Avery Lane', 'Consultant', 'Unassigned Team Ltd']) {
      expect(isUnownedOwner(value)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * C17 — status mapping.
 * ------------------------------------------------------------------------- */

describe('status mapping (C17)', () => {
  it('projects a decision closed by a human resolve event as decided, not awaiting-user', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Decisions', id: 'SYN-D-001', status: 'proposed' });
      rebuildProjection(db, projectId, AS_OF);
      expect(db.prepare("SELECT decision_status FROM decisions WHERE id = 'SYN-D-001'").get()).toMatchObject({ decision_status: 'proposed' });

      recordRegisterEvent(db, projectId, 'SYN-D-001', { actor: 'Casey Flint', eventType: 'resolve', reason: 'Closed in the playback session.', occurredAt: '2026-07-21T10:00:00.000Z' });
      expect(db.prepare('SELECT status FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-D-001')).toMatchObject({ status: 'resolved' });
      expect(db.prepare("SELECT decision_status FROM decisions WHERE id = 'SYN-D-001'").get()).toMatchObject({ decision_status: 'decided' });

      recordRegisterEvent(db, projectId, 'SYN-D-001', { actor: 'Casey Flint', eventType: 'close', reason: 'Closed again.', occurredAt: '2026-07-22T10:00:00.000Z' });
      expect(db.prepare("SELECT decision_status FROM decisions WHERE id = 'SYN-D-001'").get()).toMatchObject({ decision_status: 'decided' });
    } finally {
      context.close();
    }
  });

  it('maps every closure verb the event log can produce', () => {
    expect(decisionStatus('resolved')).toMatchObject({ value: 'decided', recognised: true });
    expect(decisionStatus('completed')).toMatchObject({ value: 'decided', recognised: true });
    expect(decisionStatus('ratified')).toMatchObject({ value: 'ratified', recognised: true });
    expect(decisionStatus('rejected')).toMatchObject({ value: 'rejected', recognised: true });
    expect(decisionStatus('parked')).toMatchObject({ value: 'parked', recognised: true });
    expect(decisionStatus('agreed')).toMatchObject({ value: 'agreed', recognised: true });
    expect(decisionStatus('agreed in principle')).toMatchObject({ value: 'agreed-in-principle', recognised: true });
    expect(milestoneStatus('completed')).toMatchObject({ value: 'achieved', recognised: true });
    expect(milestoneStatus('resolved')).toMatchObject({ value: 'achieved', recognised: true });
    expect(milestoneStatus('open')).toMatchObject({ value: 'not-started', recognised: true });
  });

  it('makes an unreadable status visibly unknown instead of silently defaulting', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Decisions', id: 'SYN-D-002', status: 'retained - confirm final state', owner: 'Blair Ross' });
      rebuildProjection(db, projectId, AS_OF);
      const mapping = decisionStatus('retained - confirm final state');
      expect(mapping.recognised).toBe(false);
      const inputs = JSON.parse((db.prepare('SELECT inputs_json FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-D-002') as { inputs_json: string }).inputs_json) as Record<string, unknown>;
      expect(inputs.unrecognisedStatus).toBe('retained - confirm final state');
      const decision = db.prepare("SELECT needs_user_attention, attention_owner FROM decisions WHERE id = 'SYN-D-002'").get() as { needs_user_attention: number; attention_owner: string };
      expect(decision.needs_user_attention).toBe(1);
      expect(decision.attention_owner).toBe('current-user');
      // The raw wording is never overwritten by the classification.
      expect(db.prepare('SELECT status FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, 'SYN-D-002')).toMatchObject({ status: 'retained - confirm final state' });
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * C18 — scoring_config is the scorer's actual input.
 * ------------------------------------------------------------------------- */

describe('scoring configuration (C18)', () => {
  function scoreOf(db: DatabaseSync, projectId: string, id: string) {
    return db.prepare('SELECT score, band, scoring_version FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, id) as { score: number; band: string; scoring_version: string };
  }

  it('changes scores and the recorded scoring version when the configuration changes', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Blair Ross' });
      const result = rebuildProjection(db, projectId, AS_OF);
      const before = scoreOf(db, projectId, 'SYN-A-001');
      const active = readActiveScoringConfig(db);
      expect(before.scoring_version).toBe(active.version);
      expect(result.scoringVersion).toBe(active.version);
      expect(SCORING_VERSION).toBe(active.version);
      expect(before.score).toBe(active.weights.register.Actions + active.weights.ownership.customer);

      const weights = { ...structuredClone(active.weights), register: { ...active.weights.register, Actions: active.weights.register.Actions + 100 } };
      db.prepare("INSERT INTO scoring_config (version, weights_json, active, created_at) VALUES ('synthetic-score-v9', ?, 1, ?)").run(JSON.stringify(weights), AS_OF);
      db.prepare("UPDATE scoring_config SET active = 0 WHERE version <> 'synthetic-score-v9'").run();

      rebuildProjection(db, projectId, AS_OF);
      const after = scoreOf(db, projectId, 'SYN-A-001');
      expect(after.score).toBe(before.score + 100);
      expect(after.scoring_version).toBe('synthetic-score-v9');
      expect(SCORING_VERSION).toBe('synthetic-score-v9');
    } finally {
      context.close();
    }
  });

  it('drives the band thresholds from the configuration', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001', owner: 'Blair Ross' });
      const active = readActiveScoringConfig(db);
      const raise = (bands: { now: number; soon: number; watch: number }) => {
        db.prepare("UPDATE scoring_config SET weights_json = ? WHERE version = ?").run(JSON.stringify({ ...active.weights, bands }), active.version);
        rebuildProjection(db, projectId, AS_OF);
        return scoreOf(db, projectId, 'SYN-A-001').band;
      };
      const score = active.weights.register.Actions + active.weights.ownership.customer;
      expect(raise({ now: score, soon: score - 1, watch: score - 2 })).toBe('Now');
      expect(raise({ now: score + 1, soon: score, watch: score - 1 })).toBe('Soon');
      expect(raise({ now: score + 2, soon: score + 1, watch: score })).toBe('Watch');
      expect(raise({ now: score + 3, soon: score + 2, watch: score + 1 })).toBe('Reference');
    } finally {
      context.close();
    }
  });

  it('fails loudly when no configuration is active or the active one is unusable', () => {
    const context = tempDb();
    try {
      const db = context.db;
      const projectId = seedProject(db);
      seedRegisterRow(db, projectId, { register: 'Actions', id: 'SYN-A-001' });
      db.prepare('UPDATE scoring_config SET active = 0').run();
      expect(() => rebuildProjection(db, projectId, AS_OF)).toThrow(/No active scoring_config row/);
      expect(() => readActiveScoringConfig(db)).toThrow(/importance scoring cannot run/);

      db.prepare('UPDATE scoring_config SET active = 1').run();
      if ((db.prepare('SELECT count(*) AS count FROM scoring_config').get() as { count: number }).count > 1) {
        expect(() => rebuildProjection(db, projectId, AS_OF)).toThrow(/Ambiguous scoring configuration/);
      }
      db.prepare("UPDATE scoring_config SET active = 0").run();
      db.prepare("UPDATE scoring_config SET active = 1, weights_json = '{\"register\":{}}' WHERE version = (SELECT version FROM scoring_config ORDER BY version DESC LIMIT 1)").run();
      expect(() => rebuildProjection(db, projectId, AS_OF)).toThrow(/is unusable/);
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * C11 — one canonical serialisation pair for both writers.
 * ------------------------------------------------------------------------- */

describe('canonical value serialisation (C11)', () => {
  it('round-trips scalars, arrays, nested objects, null and undefined', () => {
    const cases: unknown[] = [
      'plain text',
      '  padded  ',
      42,
      0,
      -1.5,
      true,
      false,
      null,
      [],
      ['a', 'b'],
      [1, null, 'x'],
      {},
      { x: 1 },
      { b: 2, a: 1 },
      { outer: { inner: ['a', { deep: true }] } },
    ];
    for (const value of cases) {
      expect(JSON.parse(canonicalValueJson(value))).toEqual(value);
    }
    expect(canonicalValueJson(undefined)).toBe('null');
    expect(JSON.parse(canonicalValueJson({ a: undefined }))).toEqual({ a: null });
  });

  it('is key-order stable and locale independent', () => {
    expect(canonicalValueJson({ b: 1, a: 2 })).toBe(canonicalValueJson({ a: 2, b: 1 }));
    // `'ID'.localeCompare('id')` is +1 while code-unit order gives -1, which is
    // how two hosts with different ICU data produced different hashes (C19).
    expect(canonicalValueJson({ ID: 1, id: 2 })).toBe('{"ID":1,"id":2}');
  });

  it('normalises arrays and objects instead of stringifying them as [object Object]', () => {
    expect(canonicalNormalizedValue(['a', 'b'])).toBe('a; b');
    expect(canonicalNormalizedValue({ x: 1 })).toBe('{"x":1}');
    expect(canonicalNormalizedValue({ x: 1 })).not.toContain('object object');
    expect(canonicalNormalizedValue('  Mixed   Case\nText ')).toBe('mixed case text');
    expect(canonicalNormalizedValue(null)).toBe('');
    expect(canonicalNormalizedValue(undefined)).toBe('');
    expect(canonicalNormalizedValue([])).toBe('');
    expect(canonicalNormalizedValue(0)).toBe('0');
    expect(canonicalNormalizedValue(false)).toBe('false');
  });

  it('keeps the import behaviour it replaced for the values a workbook actually holds', () => {
    for (const value of ['Open', 'Casey Flint', '2026-08-01', 42, true, null]) {
      expect(canonicalValueJson(value)).toBe(JSON.stringify(value ?? null));
      expect(canonicalNormalizedValue(value)).toBe(String(value ?? '').trim().toLowerCase());
    }
  });

  it('serialises a whole row and its normalised projection consistently', () => {
    const row = { b: ['x', 'y'], a: 'Text', c: { k: 1 } };
    expect(canonicalRowJson(row)).toBe('{"a":"Text","b":["x","y"],"c":{"k":1}}');
    expect(JSON.parse(canonicalNormalizedRowJson(row))).toEqual({ a: 'text', b: 'x; y', c: '{"k":1}' });
  });
});

/* ------------------------------------------------------------------------- *
 * Live parity regression.
 *
 * Runs against a copy of the operational snapshot when one is present. The
 * snapshot lives outside the repository and is never modified: it is copied to
 * a temporary path first. Paths and identifiers are discovered rather than
 * written down, so no live customer identifier enters this file.
 * ------------------------------------------------------------------------- */

const snapshotDir = process.env.PROJECTMANAGAIR_SNAPSHOT_DIR ?? path.resolve('/root/work/data');
const snapshotDb = path.join(snapshotDir, 'live.db');
const benchmarkFile = existsSync(snapshotDir) ? readdirSync(snapshotDir).find((name) => name.endsWith('_register_benchmark_canonical.json')) ?? null : null;
const canRunParity = existsSync(snapshotDb) && benchmarkFile !== null;

describe.skipIf(!canRunParity)('live register parity regression', () => {
  it('imports the canonical benchmark into the operational snapshot at full row and field parity', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-parity-'));
    let db: DatabaseSync | null = null;
    try {
      const dbPath = path.join(dir, 'snapshot.db');
      copyFileSync(snapshotDb, dbPath);
      const root = path.join(dir, 'Projects');
      mkdirSync(root, { recursive: true });
      const context = openProjectManagairDatabase(dbPath);
      db = context.db;

      const benchmarkBytes = readFileSync(path.join(snapshotDir, benchmarkFile!));
      const packet = JSON.parse(benchmarkBytes.toString('utf8')) as { project_code: string };
      const project = db.prepare('SELECT id, code FROM projects WHERE code = ?').get(packet.project_code) as { id: string; code: string };
      expect(project).toBeTruthy();

      // Repoint the copy's storage at the temporary directory; the snapshot's
      // own root belongs to a machine that is not this one.
      db.prepare("UPDATE project_storage_settings SET projects_root = ? WHERE id = 'local'").run(root);
      db.prepare('UPDATE projects SET external_path = ? WHERE id = ?').run(path.join(root, 'project'), project.id);

      // An operational row that is not register-derived, of exactly the shape
      // the M365 projection writes. On this snapshot every other operational
      // row happens to share an id with a register row, so without this the
      // C3 loss would be invisible here.
      db.prepare("INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES ('connected-folder-1', ?, 'cloud-folder', 'Connected folder', 'Cloud/Folder', ?, 'operational-reference')").run(project.id, AS_OF);
      db.prepare("INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES ('connector-action-1', ?, 'Connector action', 'open', 'Avery Lane', ?, 'operational-reference', 'Not register derived.', 'medium', NULL, 0, NULL, NULL)").run(project.id, AS_OF);
      const operationalBefore = Object.fromEntries(['actions', 'decisions', 'risks_issues', 'changes', 'open_questions', 'milestones', 'project_sources'].map((table) => [table, (db!.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`).get(project.id) as { count: number }).count]));

      const result = importProjectRegisterBenchmark(db, project.id, { benchmarkFile: { name: benchmarkFile!, dataBase64: benchmarkBytes.toString('base64') } });
      expect(result.recordsImported).toBe(105);
      expect((db.prepare('SELECT count(*) AS count FROM project_register_rows WHERE project_id = ?').get(project.id) as { count: number }).count).toBe(105);

      const parity = db.prepare('SELECT comparison_status, count(*) AS count FROM project_register_comparison_results WHERE project_id = ? GROUP BY comparison_status').all(project.id) as Array<{ comparison_status: string; count: number }>;
      expect(parity).toEqual([{ comparison_status: 'EXACT', count: 866 }]);

      // Recomputed parity agrees with the import-time figure rather than being
      // frozen at import (C11, second half).
      const recomputed = recomputeRegisterFieldParity(db, project.id, { timestamp: AS_OF });
      expect(recomputed).toMatchObject({ rows: 105, compared: 866, exact: 866, normalised: 0, mismatched: 0, missingRows: [] });

      // The import runs a full rebuild. Nothing the projector does not own may
      // have disappeared in the process (C3).
      for (const [table, before] of Object.entries(operationalBefore)) {
        const after = (db.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`).get(project.id) as { count: number }).count;
        expect(after, `${table} lost rows`).toBeGreaterThanOrEqual(before);
      }
      expect(db.prepare("SELECT count(*) AS count FROM project_sources WHERE id = 'connected-folder-1'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM actions WHERE id = 'connector-action-1'").get()).toMatchObject({ count: 1 });
      const dangling = db.prepare("SELECT count(*) AS count FROM work_packages WHERE milestone_id IS NOT NULL AND milestone_id <> '' AND milestone_id NOT IN (SELECT id FROM milestones)").get() as { count: number };
      expect(dangling.count).toBe(0);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
