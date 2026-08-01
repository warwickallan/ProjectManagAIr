/**
 * Consultant Reasoning — integration tests over a real temp SQLite database.
 *
 * Everything here is synthetic: an invented project (`ACME`), invented register
 * IDs, and invented people. No provider is ever contacted: the only reasoning
 * provider used is `FakeConsultantReasoningProvider`, whose handler increments a
 * counter so "zero calls" and "exactly one call" are asserted, not assumed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import {
  ensureSkillRegistrySynced,
  pinProjectSkill,
  readActiveSkillRevision,
  syncSkillRegistry,
  SKILL_REGISTRY_DIR_ENV,
} from '../src/skillRegistry';
import { PROVIDER_OUTPUT_DIR_ENV } from '../src/providerOutputs';
import {
  CONSULTANT_REASONING_SKILL_ID,
  type BriefMode,
  type ReasoningOutput,
} from '../src/consultantReasoningContract';
import {
  allowedRegisterIds,
  buildReasoningRequest,
  reasoningCacheKey,
} from '../src/consultantReasoningState';
import {
  generateConsultantReasoning,
  markReasoningStale,
  readConsultantReasoning,
  readReasoningSkillBody,
  resolveReasoningSkill,
} from '../src/consultantReasoning';
import {
  FakeConsultantReasoningProvider,
  type ReasoningProviderRequest,
} from '../src/consultantReasoningProvider';
import { resolveReasoningEvidence } from '../src/consultantReasoningRender';

/* --------------------------------------------------------------- fixture */

const PROJECT_ID = 'acme';
const PROJECT_CODE = 'ACME';
const CONSULTANT = 'Dana Whitfield';
const CUSTOMER = 'Ravi Chandra';

const DECISION = 'ACME-D-001';
const ACTION_OPEN = 'ACME-A-001';
const ACTION_CLOSED = 'ACME-A-002';
const RISK = 'ACME-R-001';
const QUESTION_SUPERSEDED = 'ACME-Q-001';
const MILESTONE = 'ACME-M-001';

/** Every ID the assembler must supply, in the order `buildReasoningRequest` returns them. */
const ALL_IDS = [ACTION_OPEN, ACTION_CLOSED, DECISION, MILESTONE, QUESTION_SUPERSEDED, RISK];

const SOURCE_ID = 'SRCDOC-ACME-001';
const IMPORT_RUN_ID = 'import-run:acme:001';
const SCORING_VERSION = 'source-intelligence-score-v2';

interface Fixture {
  db: DatabaseSync;
  dir: string;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'consultant-reasoning-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/** A synthetic consultant-reasoning revision held outside the repository. */
function externalRevision(directory: string, version: string, body: string): void {
  const skillDir = path.join(directory, CONSULTANT_REASONING_SKILL_ID);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, `${version}.md`), [
    '---',
    `skillId: ${CONSULTANT_REASONING_SKILL_ID}`,
    `version: ${version}`,
    'promptTemplateVersion: consultant-reasoning-prompt-v1',
    'status: candidate',
    `notes: Synthetic ${version} revision for the reasoning suite.`,
    '---',
    body,
    '',
  ].join('\n'), 'utf8');
}

function seedProject(db: DatabaseSync): void {
  const at = '2026-07-20T09:00:00.000Z';
  db.prepare(`INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, updated_at, as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(PROJECT_ID, 'Acme Platform Rollout', PROJECT_CODE, 'Acme Industries (synthetic)', 'on-track', 'delivery', CONSULTANT, '2026-05-01', '2026-10-30', at, at);

  db.prepare(`INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, benchmark_json_hash, status, started_at, raw_packet_json)
    VALUES (?, ?, 'project_register_delta', 1, ?, ?, 'complete', ?, '{}')`)
    .run(IMPORT_RUN_ID, PROJECT_ID, PROJECT_CODE, 'f'.repeat(64), at);

  db.prepare(`INSERT INTO source_documents (id, project_id, content_hash, source_type, original_file_name, immutable_path, event_date, word_count, segment_count, normaliser_version, created_at)
    VALUES (?, ?, ?, 'vtt-transcript', 'acme-checkpoint.vtt', '/synthetic/acme-checkpoint.vtt', '2026-07-18', 42, 2, 'normaliser-v1', ?)`)
    .run(SOURCE_ID, PROJECT_ID, 'a'.repeat(64), at);

  const segment = db.prepare(`INSERT INTO source_segments (id, source_id, seq, kind, speaker, t_start_ms, t_end_ms, char_start, char_end, text)
    VALUES (?, ?, ?, 'cue', ?, ?, ?, ?, ?, ?)`);
  segment.run(`${SOURCE_ID}:seg:001`, SOURCE_ID, 1, CONSULTANT, 1000, 5000, 0, 60, 'We will confirm the migration window before the next checkpoint.');
  segment.run(`${SOURCE_ID}:seg:002`, SOURCE_ID, 2, CUSTOMER, 6000, 9000, 61, 120, 'Our side will supply the updated environment list on Friday.');

  db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 7, ?)').run(PROJECT_ID, at);
}

interface SeedRow {
  id: string;
  register: string;
  title: string;
  summary: string;
  recordStatus: string;
  status: string;
  owner: string | null;
  dueDate: string | null;
  band: string;
  score: number;
  inputs: Record<string, unknown>;
  supersedes?: string[];
  related?: string[];
}

const SEED_ROWS: SeedRow[] = [
  {
    id: DECISION, register: 'Decisions', title: 'Adopt the staged cutover approach',
    summary: 'Cutover runs in two staged waves rather than a single switch.',
    recordStatus: 'current', status: 'agreed', owner: CONSULTANT, dueDate: null,
    band: 'now', score: 120, inputs: { severity: 'high', blocking: 1, conflict: 0 },
    related: [ACTION_OPEN],
  },
  {
    id: ACTION_OPEN, register: 'Actions', title: 'Confirm the migration window with Acme operations',
    summary: 'Agree the two-hour migration window for wave one.',
    recordStatus: 'current', status: 'open', owner: CUSTOMER, dueDate: '2026-08-14',
    band: 'now', score: 110, inputs: { severity: 'medium', blocking: 1, conflict: 0 },
  },
  {
    id: ACTION_CLOSED, register: 'Actions', title: 'Publish the environment inventory',
    summary: 'The environment inventory was published and signed off.',
    recordStatus: 'current', status: 'completed', owner: CONSULTANT, dueDate: '2026-07-10',
    band: 'watch', score: 20, inputs: { severity: 'low', blocking: 0, conflict: 0 },
  },
  {
    id: RISK, register: 'Risks_Issues', title: 'Reporting extract may not finish inside the window',
    summary: 'The nightly extract has twice run past its slot.',
    recordStatus: 'current', status: 'open', owner: null, dueDate: null,
    band: 'soon', score: 85, inputs: { severity: 'high', blocking: 0, conflict: 0 },
  },
  {
    id: QUESTION_SUPERSEDED, register: 'Open_Questions', title: 'Which environments are in scope for wave one?',
    summary: 'Answered by the published environment inventory.',
    recordStatus: 'superseded', status: 'closed', owner: CONSULTANT, dueDate: null,
    band: 'watch', score: 5, inputs: { severity: 'low', blocking: 0, conflict: 0 },
    supersedes: [ACTION_CLOSED],
  },
  {
    id: MILESTONE, register: 'Milestones', title: 'Wave one cutover complete',
    summary: 'Target milestone for the first cutover wave.',
    recordStatus: 'current', status: 'planned', owner: CONSULTANT, dueDate: '2026-09-04',
    band: 'watch', score: 40, inputs: { severity: 'medium', blocking: 0, conflict: 0 },
  },
];

function seedRegister(db: DatabaseSync): void {
  const at = '2026-07-20T09:00:00.000Z';
  const insertRow = db.prepare(`INSERT INTO project_register_rows
    (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date,
     source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json,
     import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json,
     created_at, updated_at, derivation, confidence, first_seen_source_id, last_updated_source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, ?, '{}', '{}', ?, ?, 'fact', 'high', ?, ?)`);
  const insertState = db.prepare(`INSERT INTO register_row_state (project_id, external_register_id, register_name, status, owner, due_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertScore = db.prepare(`INSERT INTO register_row_scores (project_id, external_register_id, score, band, inputs_json, scoring_version, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  SEED_ROWS.forEach((row, index) => {
    insertRow.run(`row:${row.id}`, PROJECT_ID, row.register, row.id, row.title, row.summary, row.recordStatus,
      row.owner, row.dueDate, SOURCE_ID, row.status,
      JSON.stringify(row.related ?? []), JSON.stringify(row.supersedes ?? []),
      IMPORT_RUN_ID, SOURCE_ID, index + 1, row.register, at, at, SOURCE_ID, SOURCE_ID);
    insertState.run(PROJECT_ID, row.id, row.register, row.status, row.owner, row.dueDate, at);
    insertScore.run(PROJECT_ID, row.id, row.score, row.band, JSON.stringify(row.inputs), SCORING_VERSION, at);
  });

  // Anchors on two rows only: the decision is deliberately left unanchored so the
  // drill-down has to say so rather than imply evidence that does not exist.
  const insertAnchor = db.prepare(`INSERT INTO register_row_anchors (id, project_id, external_register_id, source_id, segment_id, speaker, t_ms, quote, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertAnchor.run('anchor:acme:001', PROJECT_ID, ACTION_OPEN, SOURCE_ID, `${SOURCE_ID}:seg:001`, CONSULTANT, 1000, 'We will confirm the migration window before the next checkpoint.', 1);
  insertAnchor.run('anchor:acme:002', PROJECT_ID, ACTION_OPEN, SOURCE_ID, `${SOURCE_ID}:seg:002`, CUSTOMER, 6000, 'Our side will supply the updated environment list on Friday.', 0);
  insertAnchor.run('anchor:acme:003', PROJECT_ID, ACTION_CLOSED, SOURCE_ID, `${SOURCE_ID}:seg:002`, CUSTOMER, 6000, 'Our side will supply the updated environment list on Friday.', 1);

  const insertEvent = db.prepare(`INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertEvent.run('event:acme:001', PROJECT_ID, ACTION_CLOSED, '2026-07-19T08:00:00.000Z', CONSULTANT, 'status-change', 'status', 'open', 'completed', 'Inventory published and signed off.');
  insertEvent.run('event:acme:002', PROJECT_ID, QUESTION_SUPERSEDED, '2026-07-19T08:05:00.000Z', CONSULTANT, 'supersession', null, null, null, 'Answered by the published inventory.');
}

beforeEach(() => {
  const dir = temporaryDirectory();
  process.env[PROVIDER_OUTPUT_DIR_ENV] = path.join(dir, 'provider-output');
  const context = openProjectManagairDatabase(path.join(dir, 'reasoning.db'));
  fixture = { db: context.db, dir };
  seedProject(context.db);
  seedRegister(context.db);
  // Registers `skills/consultant-reasoning/1.0.0.md` from disk, as a candidate.
  ensureSkillRegistrySynced(context.db);
});

afterEach(() => {
  try { fixture.db.close(); } catch { /* already closed */ }
  delete process.env[PROVIDER_OUTPUT_DIR_ENV];
  delete process.env[SKILL_REGISTRY_DIR_ENV];
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop()!;
    // Windows holds the WAL files briefly after close; a cleanup EBUSY must not
    // fail an otherwise-passing suite.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY */ }
  }
});

/* -------------------------------------------------------------- providers */

interface CountingProvider {
  provider: FakeConsultantReasoningProvider;
  calls: () => number;
}

function modeOf(request: ReasoningProviderRequest): BriefMode {
  return (/"mode":"([a-z-]+)"/.exec(request.prompt)?.[1] ?? 'meeting') as BriefMode;
}

function countingProvider(respond: (mode: BriefMode, request: ReasoningProviderRequest) => string): CountingProvider {
  let calls = 0;
  const provider = new FakeConsultantReasoningProvider((request) => {
    calls += 1;
    return respond(modeOf(request), request);
  });
  return { provider, calls: () => calls };
}

/** A provider that fails the test if it is ever reached. */
function forbiddenProvider(): CountingProvider {
  return countingProvider(() => { throw new Error('The provider must not be called on this path.'); });
}

/* ------------------------------------------------------- synthetic output */

function validOutput(mode: BriefMode, overrides: { citedId?: string } = {}): Record<string, unknown> {
  const cited = overrides.citedId ?? ACTION_OPEN;
  return {
    brief_type: mode,
    executive_summary: [
      { text: 'The migration window is still unconfirmed and gates wave one.', supporting_register_ids: [cited] },
      { text: 'The staged cutover decision is settled and needs no rediscussion.', supporting_register_ids: [DECISION] },
    ],
    matters: [
      {
        matter_id: 'MAT-01',
        title: 'Staged cutover approach is agreed',
        situation: 'The two-wave cutover was agreed and recorded.',
        why_it_matters: 'It fixes the shape of every downstream plan.',
        recommended_move: 'Restate the agreed approach and move on.',
        classification: 'decision_required',
        priority: 'high',
        state: 'confirmed_current',
        owner_class: 'consultant',
        evidence_strength: 'strong',
        supporting_register_ids: [DECISION],
        reasoning: 'The decision row is current and carries no conflict flag.',
        related_matter_ids: ['MAT-02'],
      },
      {
        matter_id: 'MAT-02',
        title: 'Migration window still needs the customer',
        situation: 'The window remains unconfirmed on the customer side.',
        why_it_matters: 'Wave one cannot be scheduled without it.',
        recommended_move: 'Ask for the window at the next checkpoint.',
        classification: 'customer_dependency',
        priority: 'medium',
        state: 'confirmed_current',
        owner_class: 'customer',
        evidence_strength: 'strong',
        supporting_register_ids: [cited],
        reasoning: 'The action is open and owned outside the delivery team.',
        related_matter_ids: ['MAT-01'],
      },
    ],
    meeting_order: ['MAT-02', 'MAT-01'],
    decisions_required: ['MAT-01'],
    customer_dependencies: ['MAT-02'],
    consultant_next_actions: ['MAT-01'],
    risks_and_blockers: [],
    unanswered_questions: [],
    contradictions_and_state_conflicts: [],
    recent_changes: [],
    confirmation_warnings: [],
    state_observations: [
      { observation: 'The published inventory appears to answer an older open question.', supporting_register_ids: [ACTION_CLOSED, QUESTION_SUPERSEDED] },
    ],
    limitations: [
      { text: 'Only approved register state was supplied; nothing outside it was considered.', supporting_register_ids: [] },
    ],
  };
}

function validJson(mode: BriefMode, overrides?: { citedId?: string }): string {
  return JSON.stringify(validOutput(mode, overrides));
}

function acceptingProvider(): CountingProvider {
  return countingProvider((mode) => validJson(mode));
}

function results(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM consultant_reasoning_results WHERE project_id = ?').all(PROJECT_ID) as Array<Record<string, unknown>>;
}

function runs(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM consultant_reasoning_runs WHERE project_id = ? ORDER BY created_at').all(PROJECT_ID) as Array<Record<string, unknown>>;
}

function rawOutputs(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM consultant_reasoning_raw_outputs WHERE project_id = ?').all(PROJECT_ID) as Array<Record<string, unknown>>;
}

/* ==================================================================== */

describe('state assembly', () => {
  it('supplies every register row rather than a top-N subset', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    expect(request.current_state).toHaveLength(SEED_ROWS.length);
    expect(request.current_state.map((row) => row.register_id)).toEqual(ALL_IDS);
    // Nothing was dropped for being unimportant: the lowest-scoring row is present.
    expect(request.current_state.find((row) => row.register_id === QUESTION_SUPERSEDED)).toBeDefined();
  });

  it('keeps settled and closed rows, marked rather than filtered', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    const closed = request.current_state.find((row) => row.register_id === ACTION_CLOSED)!;
    expect(closed.status).toBe('completed');
    // A due date in the past on a closed row is not overdue; that is what stops
    // the model reopening settled work.
    expect(closed.overdue).toBe(false);
    expect(closed.superseded).toBe(false);
  });

  it('keeps superseded rows and marks them superseded', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    const superseded = request.current_state.find((row) => row.register_id === QUESTION_SUPERSEDED)!;
    expect(superseded.superseded).toBe(true);
    expect(superseded.record_status).toBe('superseded');
    expect(superseded.supersedes).toEqual([ACTION_CLOSED]);
  });

  it('reports evidence availability without reproducing the quote', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    const anchored = request.current_state.find((row) => row.register_id === ACTION_OPEN)!;
    expect(anchored).toMatchObject({ anchor_count: 2, verified_anchor_count: 1 });
    expect(request.current_state.find((row) => row.register_id === DECISION)!.anchor_count).toBe(0);
    expect(JSON.stringify(request)).not.toContain('We will confirm the migration window');
  });

  it('carries the synthetic project envelope and the register revision', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    expect(request.project).toMatchObject({
      project_id: PROJECT_ID,
      code: PROJECT_CODE,
      consultant_identity: CONSULTANT,
      register_revision: 7,
    });
    expect(request.project.customer_identities).toContain(CUSTOMER);
  });

  it('surfaces the most recent per-row events as recent changes', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    expect(request.recent_changes.map((change) => change.register_id).sort()).toEqual([ACTION_CLOSED, QUESTION_SUPERSEDED]);
    expect(request.recent_changes.every((change) => change.actor === CONSULTANT)).toBe(true);
  });

  it('produces a stable project_state_hash across two identical calls', () => {
    const first = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    const second = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    expect(second.project.project_state_hash).toBe(first.project.project_state_hash);
    // The mode is not part of the state, only of the question asked of it.
    const other = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'status' });
    expect(other.project.project_state_hash).toBe(first.project.project_state_hash);
  });

  it('changes the project_state_hash when a register row title changes', () => {
    const before = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash;
    fixture.db.prepare('UPDATE project_register_rows SET title = ? WHERE project_id = ? AND external_register_id = ?')
      .run('Confirm the migration window with Acme operations (revised)', PROJECT_ID, ACTION_OPEN);
    expect(buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash).not.toBe(before);
  });

  it('changes the project_state_hash when a register row status changes', () => {
    const before = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash;
    fixture.db.prepare('UPDATE register_row_state SET status = ? WHERE project_id = ? AND external_register_id = ?')
      .run('blocked', PROJECT_ID, ACTION_OPEN);
    expect(buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash).not.toBe(before);
  });

  it('changes the project_state_hash when a register row owner changes', () => {
    const before = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash;
    fixture.db.prepare('UPDATE register_row_state SET owner = ? WHERE project_id = ? AND external_register_id = ?')
      .run(CONSULTANT, PROJECT_ID, ACTION_OPEN);
    expect(buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash).not.toBe(before);
  });

  it('returns exactly the supplied row IDs as the citation allow-list', () => {
    const request = buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' });
    expect(allowedRegisterIds(request)).toEqual(ALL_IDS);
    expect(allowedRegisterIds(request)).not.toContain('ACME-Z-999');
  });

  it('refuses to assemble state for a project that does not exist', () => {
    expect(() => buildReasoningRequest(fixture.db, 'not-a-project', { mode: 'meeting' })).toThrow(/No project/);
  });
});

/* ==================================================================== */

describe('skill resolution', () => {
  it('resolves the shipped candidate revision when no active revision exists', () => {
    expect(readActiveSkillRevision(fixture.db, CONSULTANT_REASONING_SKILL_ID)).toBeNull();
    const resolved = resolveReasoningSkill(fixture.db, PROJECT_ID)!;
    expect(resolved).toMatchObject({
      skillId: CONSULTANT_REASONING_SKILL_ID,
      version: '1.0.0',
      status: 'candidate',
      promptTemplateVersion: 'consultant-reasoning-prompt-v1',
    });
  });

  it('reads the candidate body from disk and hash-verifies it', () => {
    const body = readReasoningSkillBody(fixture.db, PROJECT_ID)!;
    expect(body.revision.version).toBe('1.0.0');
    expect(body.body.length).toBeGreaterThan(0);
  });

  it('lets a project pin override the resolved revision', () => {
    const externalDir = temporaryDirectory('consultant-reasoning-external-');
    externalRevision(externalDir, '1.1.0', 'A synthetic candidate revision that supersedes nothing automatically.');
    process.env[SKILL_REGISTRY_DIR_ENV] = externalDir;
    syncSkillRegistry(fixture.db, { externalDir });

    expect(resolveReasoningSkill(fixture.db, PROJECT_ID)!.version).toBe('1.1.0');
    pinProjectSkill(fixture.db, { projectId: PROJECT_ID, skillId: CONSULTANT_REASONING_SKILL_ID, version: '1.0.0', actor: CONSULTANT, note: 'Synthetic pin.' });
    expect(resolveReasoningSkill(fixture.db, PROJECT_ID)!.version).toBe('1.0.0');
  });

  it('returns null rather than throwing when the registered sha no longer matches the file', () => {
    fixture.db.prepare('UPDATE extraction_skills SET sha256 = ? WHERE skill_id = ? AND version = ?')
      .run('0'.repeat(64), CONSULTANT_REASONING_SKILL_ID, '1.0.0');
    // The revision still resolves — it is registered — but its body no longer verifies.
    expect(resolveReasoningSkill(fixture.db, PROJECT_ID)!.version).toBe('1.0.0');
    expect(readReasoningSkillBody(fixture.db, PROJECT_ID)).toBeNull();
  });

  it('returns null when no revision of the family is registered at all', () => {
    fixture.db.prepare('DELETE FROM extraction_skills WHERE skill_id = ?').run(CONSULTANT_REASONING_SKILL_ID);
    expect(resolveReasoningSkill(fixture.db, PROJECT_ID)).toBeNull();
    expect(readReasoningSkillBody(fixture.db, PROJECT_ID)).toBeNull();
  });

  it('refuses to generate, without a provider call, when the skill body cannot be verified', async () => {
    fixture.db.prepare('UPDATE extraction_skills SET sha256 = ? WHERE skill_id = ? AND version = ?')
      .run('0'.repeat(64), CONSULTANT_REASONING_SKILL_ID, '1.0.0');
    const fake = forbiddenProvider();
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('skill-unavailable');
    expect(result.providerCalls).toBe(0);
    expect(fake.calls()).toBe(0);
    expect(runs(fixture.db)).toHaveLength(0);
  });
});

/* ==================================================================== */

describe('the zero-call read path', () => {
  it('reports no cached result and zero provider calls on a cold project', () => {
    const fake = forbiddenProvider();
    const view = readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(view.providerCallsThisRequest).toBe(0);
    expect(view.state).toBe('none');
    expect(view.current).toBeNull();
    expect(view.latest).toBeNull();
    expect(fake.calls()).toBe(0);
  });

  it('never invokes the provider however many times it is called', () => {
    const fake = forbiddenProvider();
    for (let index = 0; index < 5; index += 1) {
      expect(readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider).providerCallsThisRequest).toBe(0);
      expect(readConsultantReasoning(fixture.db, PROJECT_ID, 'status', fake.provider).providerCallsThisRequest).toBe(0);
    }
    expect(fake.calls()).toBe(0);
    expect(runs(fixture.db)).toHaveLength(0);
    expect(rawOutputs(fixture.db)).toHaveLength(0);
  });

  it('reports the resolved skill and provider identity without calling anything', () => {
    const fake = forbiddenProvider();
    const view = readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(view.identity).toMatchObject({
      skillId: CONSULTANT_REASONING_SKILL_ID,
      skillVersion: '1.0.0',
      promptTemplateVersion: 'consultant-reasoning-prompt-v1',
      providerId: 'fake-reasoning-provider',
      skillResolved: true,
    });
    expect(view.projectStateHash).toBe(buildReasoningRequest(fixture.db, PROJECT_ID, { mode: 'meeting' }).project.project_state_hash);
    expect(fake.calls()).toBe(0);
  });

  it('still makes no call after a result exists', async () => {
    const generating = acceptingProvider();
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', generating.provider);
    const reading = forbiddenProvider();
    const view = readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', reading.provider);
    expect(view.state).toBe('current');
    expect(view.providerCallsThisRequest).toBe(0);
    expect(reading.calls()).toBe(0);
  });
});

/* ==================================================================== */

describe('the one-call generate path', () => {
  it('makes exactly one provider call and accepts a contract-valid result', async () => {
    const fake = acceptingProvider();
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('accepted');
    expect(result.providerCalls).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(result.violations).toEqual([]);
    expect(result.view.state).toBe('current');
    expect(result.view.current!.citedRegisterIds).toEqual([ACTION_OPEN, ACTION_CLOSED, DECISION, QUESTION_SUPERSEDED].sort());
  });

  it('records an accepted run with its accounting and result hash', async () => {
    const fake = acceptingProvider();
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const [run] = runs(fixture.db);
    expect(run).toMatchObject({
      id: result.runId,
      status: 'accepted',
      provider_calls: 1,
      skill_id: CONSULTANT_REASONING_SKILL_ID,
      skill_version: '1.0.0',
      mode: 'meeting',
    });
    expect(String(run.result_sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(run.input_tokens)).toBeGreaterThan(0);
    expect(JSON.parse(String(run.violations_json))).toEqual([]);
  });

  it('serves a second identical generate from cache with zero provider calls', async () => {
    const fake = acceptingProvider();
    const first = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const second = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(second.outcome).toBe('cache-hit');
    expect(second.providerCalls).toBe(0);
    expect(fake.calls()).toBe(1);
    expect(second.runId).toBe(first.runId);
    expect(results(fixture.db)).toHaveLength(1);
  });

  it('bypasses the cache when force is set and calls again', async () => {
    const fake = acceptingProvider();
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const forced = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider, { mode: 'meeting', force: true });
    expect(forced.outcome).toBe('accepted');
    expect(forced.providerCalls).toBe(1);
    expect(fake.calls()).toBe(2);
    // Same cache key, so the accepted row is updated in place rather than duplicated.
    expect(results(fixture.db)).toHaveLength(1);
    expect(runs(fixture.db)).toHaveLength(2);
  });

  it('preserves the raw response before parsing, even when it is unparseable garbage', async () => {
    const fake = countingProvider(() => 'Sorry — I could not produce a brief for that project.');
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('parse-failed');
    const preserved = rawOutputs(fixture.db);
    expect(preserved).toHaveLength(1);
    expect(Number(preserved[0].response_bytes)).toBeGreaterThan(0);
    expect(String(preserved[0].response_sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(preserved[0].parse_status).toBe('rejected');
  });

  it('records a parse failure as its own run status and links the preserved output', async () => {
    const fake = countingProvider(() => 'not json at all');
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('parse-failed');
    expect(result.providerCalls).toBe(1);
    const [run] = runs(fixture.db);
    expect(run.status).toBe('parse-failed');
    expect(run.raw_output_id).toBe(rawOutputs(fixture.db)[0].id);
    expect(run.error).toBeTruthy();
    expect(results(fixture.db)).toHaveLength(0);
  });

  it('rejects an output citing an invented register id and records the violations', async () => {
    const fake = countingProvider((mode) => validJson(mode, { citedId: 'ACME-A-404' }));
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('validation-failed');
    expect(result.providerCalls).toBe(1);
    expect(result.violations.some((violation) => violation.code === 'unknown_register_id')).toBe(true);

    const [run] = runs(fixture.db);
    expect(run.status).toBe('validation-failed');
    const recorded = JSON.parse(String(run.violations_json)) as Array<{ code: string; detail: string }>;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.some((violation) => violation.code === 'unknown_register_id' && violation.detail.includes('ACME-A-404'))).toBe(true);

    expect(rawOutputs(fixture.db)).toHaveLength(1);
    expect(rawOutputs(fixture.db)[0].parse_status).toBe('rejected');
    // Nothing invalid is ever shown: no result row is written.
    expect(results(fixture.db)).toHaveLength(0);
  });

  it('does not retry a parse failure behind the operator\'s back', async () => {
    const fake = countingProvider(() => 'still not json');
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(fake.calls()).toBe(1);
    expect(runs(fixture.db)).toHaveLength(1);
    expect(rawOutputs(fixture.db)).toHaveLength(1);
  });

  it('does not retry a validation failure behind the operator\'s back', async () => {
    const fake = countingProvider((mode) => validJson(mode, { citedId: 'ACME-A-404' }));
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(fake.calls()).toBe(1);
    expect(runs(fixture.db)).toHaveLength(1);
  });

  it('surfaces a provider that throws as provider-failed, with the call still counted', async () => {
    const fake = countingProvider(() => { throw new Error('synthetic transport failure'); });
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(result.outcome).toBe('provider-failed');
    expect(result.providerCalls).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(runs(fixture.db)[0]).toMatchObject({ status: 'provider-failed', provider_calls: 1 });
    expect(results(fixture.db)).toHaveLength(0);
  });

  it('does not overwrite or invalidate a previously accepted result when a later run fails validation', async () => {
    const accepting = acceptingProvider();
    const accepted = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', accepting.provider);
    const acceptedSha = accepted.view.current!.resultSha256;

    const failing = countingProvider((mode) => validJson(mode, { citedId: 'ACME-A-404' }));
    const failed = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', failing.provider, { mode: 'meeting', force: true });
    expect(failed.outcome).toBe('validation-failed');

    const rows = results(fixture.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].result_sha256).toBe(acceptedSha);
    expect(Number(rows[0].stale)).toBe(0);

    const view = readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', forbiddenProvider().provider);
    expect(view.state).toBe('current');
    expect(view.current!.resultSha256).toBe(acceptedSha);
  });

  it('rejects an output whose brief_type disagrees with the requested mode', async () => {
    const fake = countingProvider(() => validJson('meeting'));
    const result = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'status', fake.provider);
    expect(result.outcome).toBe('validation-failed');
    expect(result.violations.some((violation) => violation.code === 'invalid_mode')).toBe(true);
    expect(fake.calls()).toBe(1);
  });
});

/* ==================================================================== */

describe('cache and staleness', () => {
  it('reports stale once the register moves under an accepted result, and keeps the old brief', async () => {
    const fake = acceptingProvider();
    const accepted = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const acceptedSha = accepted.view.current!.resultSha256;

    fixture.db.prepare('UPDATE register_row_state SET status = ? WHERE project_id = ? AND external_register_id = ?')
      .run('blocked', PROJECT_ID, ACTION_OPEN);

    const view = readConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', forbiddenProvider().provider);
    expect(view.state).toBe('stale');
    expect(view.current).toBeNull();
    expect(view.latest).not.toBeNull();
    expect(view.latest!.resultSha256).toBe(acceptedSha);
    // Results are never deleted.
    expect(results(fixture.db)).toHaveLength(1);
  });

  it('marks non-matching results stale and returns how many it touched', async () => {
    const fake = acceptingProvider();
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const changed = markReasoningStale(fixture.db, PROJECT_ID, 'b'.repeat(64), 'Synthetic changeset applied.');
    expect(changed).toBe(1);
    const [row] = results(fixture.db);
    expect(Number(row.stale)).toBe(1);
    expect(row.stale_reason).toBe('Synthetic changeset applied.');
    expect(row.stale_at).toBeTruthy();
    // Running it again touches nothing: already-stale rows are not re-marked.
    expect(markReasoningStale(fixture.db, PROJECT_ID, 'b'.repeat(64), 'Again.')).toBe(0);
  });

  it('leaves the result matching the current state hash alone', async () => {
    const fake = acceptingProvider();
    const accepted = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const current = accepted.view.projectStateHash;
    expect(markReasoningStale(fixture.db, PROJECT_ID, current, 'Unrelated change.')).toBe(0);
    expect(Number(results(fixture.db)[0].stale)).toBe(0);
  });

  it('changes the cache key when the mode changes, so each mode costs its own call', async () => {
    const fake = acceptingProvider();
    const meeting = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const status = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'status', fake.provider);
    expect(meeting.outcome).toBe('accepted');
    expect(status.outcome).toBe('accepted');
    expect(fake.calls()).toBe(2);
    const rows = results(fixture.db);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => String(row.cache_key))).size).toBe(2);
    // Same state, different question — the state hash is shared.
    expect(new Set(rows.map((row) => String(row.project_state_hash))).size).toBe(1);
  });

  it('changes the cache key when the resolved skill version changes', async () => {
    const fake = acceptingProvider();
    await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(fake.calls()).toBe(1);

    const externalDir = temporaryDirectory('consultant-reasoning-external-');
    externalRevision(externalDir, '1.1.0', 'A synthetic successor revision with a different instruction body.');
    process.env[SKILL_REGISTRY_DIR_ENV] = externalDir;
    syncSkillRegistry(fixture.db, { externalDir });
    pinProjectSkill(fixture.db, { projectId: PROJECT_ID, skillId: CONSULTANT_REASONING_SKILL_ID, version: '1.1.0', actor: CONSULTANT });

    const second = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    expect(second.outcome).toBe('accepted');
    expect(second.providerCalls).toBe(1);
    expect(fake.calls()).toBe(2);
    const rows = results(fixture.db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => String(row.skill_version)).sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('is a pure function of the parts that could change the answer', () => {
    const base = {
      projectId: PROJECT_ID, projectStateHash: 'c'.repeat(64), mode: 'meeting',
      skillId: CONSULTANT_REASONING_SKILL_ID, skillVersion: '1.0.0',
      promptTemplateVersion: 'consultant-reasoning-prompt-v1',
      providerId: 'fake-reasoning-provider', modelLabel: 'synthetic-reasoning-v1',
    };
    expect(reasoningCacheKey(base)).toBe(reasoningCacheKey({ ...base }));
    for (const change of [
      { projectStateHash: 'd'.repeat(64) }, { mode: 'status' }, { skillVersion: '1.1.0' },
      { promptTemplateVersion: 'consultant-reasoning-prompt-v2' }, { modelLabel: 'other-model' },
    ]) {
      expect(reasoningCacheKey({ ...base, ...change })).not.toBe(reasoningCacheKey(base));
    }
  });
});

/* ==================================================================== */

describe('evidence resolution', () => {
  function citing(ids: string[]): ReasoningOutput {
    const output = validOutput('meeting') as unknown as ReasoningOutput;
    output.state_observations = [{ observation: 'Synthetic observation.', supporting_register_ids: ids }];
    return output;
  }

  it('resolves cited register IDs to canonical rows with their anchors', () => {
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, citing([ACTION_OPEN]));
    const row = evidence.rows[ACTION_OPEN];
    expect(row).toMatchObject({ registerId: ACTION_OPEN, register: 'Actions', owner: CUSTOMER, band: 'now', unanchored: false });
    expect(row.anchors).toHaveLength(2);
    expect(row.anchors[0].quote).toBe('We will confirm the migration window before the next checkpoint.');
    expect(row.anchors.map((anchor) => anchor.verified)).toEqual([true, false]);
    expect(evidence.unresolved).toEqual([]);
  });

  it('reports a row that carries no anchor as unanchored', () => {
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, citing([DECISION]));
    expect(evidence.rows[DECISION]).toMatchObject({ unanchored: true });
    expect(evidence.rows[DECISION].anchors).toEqual([]);
  });

  it('marks a superseded cited row as superseded rather than hiding it', () => {
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, citing([QUESTION_SUPERSEDED]));
    expect(evidence.rows[QUESTION_SUPERSEDED]).toMatchObject({ superseded: true, register: 'Open_Questions' });
  });

  it('puts an ID that no longer exists in unresolved rather than throwing', () => {
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, citing(['ACME-A-404', ACTION_OPEN]));
    expect(evidence.unresolved).toEqual(['ACME-A-404']);
    expect(evidence.rows[ACTION_OPEN]).toBeDefined();
    expect(evidence.rows['ACME-A-404']).toBeUndefined();
  });

  it('reports a citation that the register has since deleted as unresolved', () => {
    fixture.db.prepare('DELETE FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').run(PROJECT_ID, RISK);
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, citing([RISK]));
    expect(evidence.unresolved).toEqual([RISK]);
  });

  it('resolves every ID an accepted result actually cited', async () => {
    const fake = acceptingProvider();
    const accepted = await generateConsultantReasoning(fixture.db, PROJECT_ID, 'meeting', fake.provider);
    const cached = accepted.view.current!;
    const evidence = resolveReasoningEvidence(fixture.db, PROJECT_ID, cached.resultJson);
    expect(Object.keys(evidence.rows).sort()).toEqual(cached.citedRegisterIds);
    expect(evidence.unresolved).toEqual([]);
  });

  it('returns nothing at all when the result cites nothing', () => {
    const output = validOutput('meeting') as unknown as ReasoningOutput;
    output.executive_summary = [];
    output.matters = [];
    output.state_observations = [];
    output.limitations = [];
    expect(resolveReasoningEvidence(fixture.db, PROJECT_ID, output)).toEqual({ rows: {}, unresolved: [] });
  });
});
