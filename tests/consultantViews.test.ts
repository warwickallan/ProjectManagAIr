/**
 * Deterministic consultant views and on-demand synthesis.
 *
 * The most important assertions here are negative: that opening, reading,
 * re-reading and re-selecting cost ZERO provider calls, and that a failure never
 * produces something that looks generated. A synthetic provider that counts its
 * own invocations is the only honest way to prove that, and it costs nothing.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase, readProjectData } from '../src/db';
import { FakeGroundedBriefProvider, type GroundedBriefProvider, type GroundedBriefRequest, type GroundedBriefResult } from '../src/briefProvider';
import { canonicalNormalizedRowJson, canonicalRowJson, rebuildProjection } from '../src/registerProjection';
import { ensureSkillRegistrySynced, promoteSkillRevision, uploadSkillDraft } from '../src/skillRegistry';
import { buildConsultantBrief } from '../src/sourceIntelligence';
import { buildProjectThemes } from '../src/projectThemes';
import {
  buildDeterministicConsultantView,
  generateConsultantView,
  readConsultantView,
  renderSynthesisMarkdown,
} from '../src/consultantViews';

const AS_OF = '2026-07-30T09:00:00.000Z';
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'projectmanagair-consultant-'));
  directories.push(directory);
  mkdirSync(path.join(directory, 'Projects'), { recursive: true });
  const context = openProjectManagairDatabase(path.join(directory, 'projectmanagair.db'));
  ensureSkillRegistrySynced(context.db);
  return { db: context.db, directory };
}

function seedProject(db: DatabaseSync, projectId = 'proj-consultant'): string {
  db.prepare('INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(projectId, 'Consultant View Fixture', 'CVF', 'Synthetic fixture.', 'on-track', 'delivery', 'Casey Flint', '2026-01-01', '2026-12-31', null, AS_OF, AS_OF, 'fictional');
  db.prepare("INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json) VALUES (?, ?, 'project_register_benchmark', 1, 'CVF', 'h', 'completed', ?, ?, 0, 0, '[]', 'verified', '{}')")
    .run(`import:${projectId}`, projectId, AS_OF, AS_OF);
  return projectId;
}

interface SeedRow {
  register: string;
  id: string;
  title: string;
  summary?: string;
  status?: string;
  owner?: string | null;
  dueDate?: string | null;
  related?: string[];
  workPackages?: string[];
  details?: Record<string, unknown>;
}

function seedRow(db: DatabaseSync, projectId: string, row: SeedRow) {
  const raw = { id: row.id, title: row.title, summary: row.summary ?? '', status: row.status ?? 'open', details: row.details ?? {} };
  db.prepare(`INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, '[]', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`)
    .run(`register:${projectId}:${row.id}`, projectId, row.register, row.id, row.title, row.summary ?? '', row.status ?? 'open', row.owner ?? null, row.dueDate ?? null,
      row.status ?? 'open', JSON.stringify(row.related ?? []), JSON.stringify(row.workPackages ?? []), `import:${projectId}`, row.register,
      canonicalRowJson(raw), canonicalNormalizedRowJson(raw), AS_OF, AS_OF);
  // The typed detail tables are where `blocking` and `severity` actually live;
  // the projector reads them, not the raw row. Seeding them keeps the fixture
  // honest about how a real applied changeset writes a row.
  if (row.register === 'Open_Questions') {
    db.prepare('INSERT OR REPLACE INTO register_open_question_details (register_row_id, question, parked_with, unblocked_by, blocking) VALUES (?, ?, NULL, NULL, ?)')
      .run(`register:${projectId}:${row.id}`, String(row.details?.question ?? row.title), row.details?.blocking ? 1 : 0);
  }
  if (row.register === 'Risks_Issues') {
    db.prepare('INSERT OR REPLACE INTO register_risk_issue_details (register_row_id, driver, evidence, impact, mitigation, likelihood, severity) VALUES (?, NULL, NULL, NULL, NULL, NULL, ?)')
      .run(`register:${projectId}:${row.id}`, row.details?.severity ? String(row.details.severity) : null);
  }
}

/**
 * A project with one genuine theme (PPM data readiness: a decision, two actions,
 * a milestone and a blocking question, joined by explicit relationships) and two
 * unrelated rows that share only generic project vocabulary.
 */
function seedRealisticProject(db: DatabaseSync): string {
  const projectId = seedProject(db);
  seedRow(db, projectId, { register: 'Decisions', id: 'CVF-D-001', title: 'Decide the PPM asset hierarchy depth', summary: 'Choose between three-level and four-level asset hierarchy for PPM.', status: 'awaiting-user', related: ['CVF-A-001', 'CVF-A-002', 'CVF-M-001'], workPackages: ['PPM data readiness'] });
  seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-001', title: 'Extract PPM asset register from the legacy system', summary: 'Pull the asset register so the hierarchy can be mapped.', owner: 'Casey Flint', dueDate: '2026-06-01', workPackages: ['PPM data readiness'] });
  seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-002', title: 'Map PPM asset hierarchy into the load template', summary: 'Populate the load template once the hierarchy depth is agreed.', owner: null, dueDate: '2026-08-20', workPackages: ['PPM data readiness'] });
  seedRow(db, projectId, { register: 'Milestones', id: 'CVF-M-001', title: 'PPM asset data loaded', summary: 'Asset data present in the target environment.', dueDate: '2026-09-01', workPackages: ['PPM data readiness'] });
  seedRow(db, projectId, { register: 'Open_Questions', id: 'CVF-Q-001', title: 'Who signs off the PPM asset extract?', summary: 'Extract cannot be requested until an owner is named.', owner: 'Customer Programme Office', workPackages: ['PPM data readiness'], details: { blocking: 1, question: 'Who signs off the PPM asset extract?' } });
  // Two rows that share only generic project vocabulary with everything else.
  seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-003', title: 'Update the project status report', summary: 'Update the weekly project status report for the customer.', owner: 'Casey Flint' });
  seedRow(db, projectId, { register: 'Risks_Issues', id: 'CVF-R-001', title: 'Training room booking not confirmed', summary: 'The training room for the customer session is not confirmed.', owner: 'Customer Programme Office', details: { severity: 'medium' } });
  rebuildProjection(db, projectId, AS_OF);
  return projectId;
}


/** A source document and its segments, so anchors can satisfy their foreign keys. */
function seedSource(db: DatabaseSync, projectId: string, sourceId: string, segmentSeqs: number[], segmentIdFor: (seq: number) => string) {
  db.prepare("INSERT INTO source_documents (id, project_id, intake_source_id, content_hash, source_type, original_file_name, immutable_path, event_date, duration_ms, word_count, segment_count, participants_json, normaliser_version, created_at) VALUES (?, ?, NULL, ?, 'transcript', 'fixture.vtt', '/tmp/fixture.vtt', NULL, NULL, 10, ?, '[]', 'source-normaliser-v2', ?)")
    .run(sourceId, projectId, `${sourceId}${'0'.repeat(64)}`.slice(0, 64), segmentSeqs.length, AS_OF);
  for (const seq of segmentSeqs) {
    db.prepare("INSERT INTO source_segments (id, source_id, seq, kind, speaker, t_start_ms, t_end_ms, message_id, sender, sent_at, page, section, para_index, char_start, char_end, text, window_id) VALUES (?, ?, ?, 'cue', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, NULL)")
      .run(segmentIdFor(seq), sourceId, seq, `Segment ${seq}.`);
  }
}

/** A provider that counts every call and never touches the network. */
function countingProvider(handler?: (request: GroundedBriefRequest) => GroundedBriefResult): { provider: GroundedBriefProvider; calls: () => number } {
  let calls = 0;
  const provider = new FakeGroundedBriefProvider((request) => {
    calls += 1;
    return handler ? handler(request) : {
      markdown: '## Do first\n- Everything hangs on the hierarchy depth decision [CVF-D-001] [CVF-A-002]\n',
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  });
  return { provider, calls: () => calls };
}

/* ------------------------------------------------------------------ zero-call guarantee */

describe('the default views cost nothing', () => {
  it('builds Meeting Brief and Needs Warwick with zero provider calls, however many times they are read', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider();

    for (let repeat = 0; repeat < 5; repeat += 1) {
      for (const mode of ['meeting', 'needs-warwick'] as const) {
        const deterministic = buildDeterministicConsultantView(db, projectId, mode);
        expect(deterministic.providerCalls).toBe(0);
        expect(deterministic.sections.length).toBeGreaterThan(0);
        const view = readConsultantView(db, projectId, mode, provider);
        expect(view.providerCallsThisRequest).toBe(0);
      }
      // Reading the whole project payload — which is what opening a project,
      // changing a tab or refreshing the page does — is also free.
      readProjectData(db, projectId);
    }
    expect(calls()).toBe(0);
  });

  it('renders the same deterministic view byte for byte on repeated builds', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const first = buildDeterministicConsultantView(db, projectId, 'meeting');
    const second = buildDeterministicConsultantView(db, projectId, 'meeting');
    expect(second.selectionHash).toBe(first.selectionHash);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('surfaces what a meeting must not end without touching', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const view = buildDeterministicConsultantView(db, projectId, 'meeting');
    const section = (key: string) => view.sections.find((entry) => entry.key === key)!;
    expect(section('decisions-needed').rowIds).toContain('CVF-D-001');
    expect(section('unresolved-questions').rowIds).toContain('CVF-Q-001');
    expect(section('customer-owned-blockers').rowIds).toContain('CVF-Q-001');
    expect(view.sections.map((entry) => entry.key)).toEqual([
      'themes-to-challenge', 'customer-owned-blockers', 'decisions-needed', 'unresolved-questions',
      'high-risks-issues', 'milestones-at-risk', 'recent-changes',
    ]);
  });

  it('ranks what the consultant personally owns, and what unlocks the most', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const view = buildDeterministicConsultantView(db, projectId, 'needs-warwick');
    const section = (key: string) => view.sections.find((entry) => entry.key === key)!;
    // The customer-owned blocking question is not the consultant's to do.
    expect(section('consultant-actions').rowIds).not.toContain('CVF-Q-001');
    expect(section('consultant-actions').rowIds).toContain('CVF-A-001');
    // The hierarchy decision unlocks the rest of its theme.
    expect(section('high-leverage').rowIds).toContain('CVF-D-001');
    expect(view.records.find((record) => record.id === 'CVF-D-001')!.unlocks).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ themes */

describe('deterministic themes', () => {
  it('groups on real structure and refuses to group on generic project words', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { themes, ungroupedIds } = buildProjectThemes(db, projectId);

    const ppm = themes.find((theme) => theme.memberIds.includes('CVF-D-001'))!;
    expect(ppm.memberIds.sort()).toEqual(['CVF-A-001', 'CVF-A-002', 'CVF-D-001', 'CVF-M-001', 'CVF-Q-001']);
    expect(ppm.label).toBe('PPM data readiness');
    expect(ppm.actionCount).toBe(2);
    expect(ppm.milestoneCount).toBe(1);
    expect(ppm.unresolvedDecisionCount).toBe(1);
    expect(ppm.customerDependency).toBe(true);
    expect(ppm.basis.some((entry) => entry.kind === 'work-package')).toBe(true);
    expect(ppm.basis.some((entry) => entry.kind === 'related-id')).toBe(true);

    // "Update the project status report" and "Training room booking not
    // confirmed" both talk about the customer and the project. Neither joins the
    // PPM theme, and neither joins the other.
    expect(ungroupedIds).toContain('CVF-A-003');
    expect(ungroupedIds).toContain('CVF-R-001');
    for (const theme of themes) {
      expect(theme.memberIds.includes('CVF-A-003') && theme.memberIds.includes('CVF-R-001')).toBe(false);
    }
  });

  it('does not group two rows that share only project-generic vocabulary', () => {
    const { db } = fixture();
    const projectId = seedProject(db);
    // Eight rows, every one of them about "the customer project data update".
    for (let index = 1; index <= 8; index += 1) {
      seedRow(db, projectId, { register: 'Actions', id: `CVF-A-10${index}`, title: `Customer project data update ${index}`, summary: 'Customer project data update.' });
    }
    rebuildProjection(db, projectId, AS_OF);
    const { themes } = buildProjectThemes(db, projectId);
    // Every shared token is generic across the whole project, so nothing groups.
    expect(themes).toEqual([]);
  });

  it('names a theme from distinctive vocabulary when there is no work package', () => {
    const { db } = fixture();
    const projectId = seedProject(db);
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-201', title: 'Configure permit escalation workflow', summary: 'Permit escalation workflow needs configuring.', related: ['CVF-A-202'] });
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-202', title: 'Test permit escalation workflow', summary: 'Permit escalation workflow needs testing.' });
    for (let index = 1; index <= 6; index += 1) {
      seedRow(db, projectId, { register: 'Actions', id: `CVF-A-30${index}`, title: `Unrelated activity ${index}`, summary: 'Something else entirely.' });
    }
    rebuildProjection(db, projectId, AS_OF);
    const theme = buildProjectThemes(db, projectId).themes.find((entry) => entry.memberIds.includes('CVF-A-201'))!;
    expect(theme.label).toMatch(/permit|escalation|workflow/);
  });
});

/* ------------------------------------------------------------------ generation */

describe('generating a consultant view', () => {
  it('makes exactly one call per press, and none at all on a cache hit', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider();

    return (async () => {
      const first = await generateConsultantView(db, projectId, 'needs-warwick', provider);
      expect(first.synthesisState).toBe('current');
      expect(first.providerCallsThisRequest).toBe(1);
      expect(calls()).toBe(1);

      // Reopening the unchanged view: cache hit, no call.
      const reopened = await generateConsultantView(db, projectId, 'needs-warwick', provider);
      expect(reopened.providerCallsThisRequest).toBe(0);
      expect(reopened.synthesisState).toBe('current');
      expect(calls()).toBe(1);
      expect(readConsultantView(db, projectId, 'needs-warwick', provider).synthesisState).toBe('current');
      expect(calls()).toBe(1);

      // An explicit Refresh is one more call, and one only.
      await generateConsultantView(db, projectId, 'needs-warwick', provider, { force: true });
      expect(calls()).toBe(2);
    })();
  });

  it('marks a changed selection stale, keeps the old narrative, and regenerates nothing on its own', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider();
    const generated = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    const originalMarkdown = generated.synthesis!.briefMarkdown;
    expect(calls()).toBe(1);

    // The selection moves.
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-999', title: 'Newly discovered consultant action', summary: 'Changes the deterministic selection.', owner: 'Casey Flint', dueDate: '2026-08-05' });
    rebuildProjection(db, projectId, AS_OF);

    const after = readConsultantView(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(0 + 1); // still one: nothing regenerated
    expect(after.synthesisState).toBe('stale');
    expect(after.synthesis!.briefMarkdown).toBe(originalMarkdown);
    expect(after.synthesis!.staleReason).toMatch(/selection has changed/i);
    expect(after.synthesis!.staleAt).toBeTruthy();

    // Reading it repeatedly still costs nothing.
    readConsultantView(db, projectId, 'needs-warwick', provider);
    readConsultantView(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);
  });

  it('caches separately per skill version, provider and model', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const first = countingProvider();
    await generateConsultantView(db, projectId, 'needs-warwick', first.provider);
    expect(first.calls()).toBe(1);

    // A different model is a different artefact, so it does not hit the cache.
    const second = countingProvider();
    Object.defineProperty(second.provider, 'identity', { value: Object.freeze({ providerId: 'fake-brief-provider', modelLabel: 'a-different-model' }) });
    await generateConsultantView(db, projectId, 'needs-warwick', second.provider);
    expect(second.calls()).toBe(1);

    // Both syntheses are retained, each naming the model that produced it.
    const rows = db.prepare('SELECT model_label FROM consultant_briefs WHERE project_id = ? AND mode = ? ORDER BY model_label').all(projectId, 'needs-warwick') as Array<{ model_label: string | null }>;
    expect(rows.map((row) => row.model_label)).toEqual(['a-different-model', 'synthetic-brief-v1']);
  });

  it('rejects a narrative whose factual lines cite nothing, and keeps the deterministic view honest', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider(() => ({
      markdown: '## Do first\n- The project is in excellent shape and nothing needs attention.\n- Everything is on track.\n',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    const result = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);
    expect(result.synthesisState).toBe('failed');
    expect(result.failure!.message).toMatch(/citation validation/i);
    // Nothing was cached, and the deterministic view is present and is not
    // presented as generated.
    expect(result.synthesis).toBeNull();
    expect(result.deterministic.providerCalls).toBe(0);
    expect(db.prepare("SELECT count(*) count FROM consultant_briefs WHERE project_id = ? AND provider_id <> 'deterministic-template'").get(projectId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM consultant_brief_runs WHERE project_id = ?").all(projectId)).toEqual([{ status: 'citation-rejected' }]);
  });

  it('rejects a narrative that cites an identifier outside its selection', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider } = countingProvider(() => ({
      markdown: '## Do first\n- Something about a record that was never selected [CVF-Z-999]\n',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const result = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(result.synthesisState).toBe('failed');
    expect(result.failure!.message).toMatch(/CVF-Z-999/);
  });

  it('keeps the deterministic view and never masquerades it as generated when the provider fails', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    let attempts = 0;
    const provider: GroundedBriefProvider = {
      identity: Object.freeze({ providerId: 'unavailable-provider', modelLabel: 'none' }),
      isAvailable: () => false,
      availability: () => ({ available: false, kind: 'cli-missing', detail: 'The CLI is not installed.', version: null, checkedAt: 0 }),
      generate: () => { attempts += 1; throw new Error('must never be reached'); },
    };

    const result = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(attempts).toBe(0);
    expect(result.synthesisState).toBe('failed');
    expect(result.failure!.message).toMatch(/unavailable/i);
    expect(result.failure!.recoveryAction).toMatch(/press Generate again|Install or sign in/i);
    expect(result.deterministic.sections.length).toBeGreaterThan(0);
    expect(result.synthesis).toBeNull();

    // A second attempt is a second deliberate act. Nothing loops.
    const again = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(again.synthesisState).toBe('failed');
    expect(attempts).toBe(0);
  });

  it('records a failed call once and does not retry it', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    let attempts = 0;
    const provider = new FakeGroundedBriefProvider(() => { attempts += 1; throw new Error('provider exploded'); });
    const result = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(attempts).toBe(1);
    expect(result.synthesisState).toBe('failed');
    expect(result.failure!.message).toMatch(/provider exploded/);
    expect(db.prepare('SELECT status, error FROM consultant_brief_runs WHERE project_id = ?').all(projectId)).toEqual([{ status: 'failed', error: 'provider exploded' }]);
  });
});

/* ------------------------------------------------------------------ download */

describe('the downloadable consultant view', () => {
  it('carries the narrative, its citations and the provenance that makes it answerable', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider } = countingProvider();
    await generateConsultantView(db, projectId, 'needs-warwick', provider);
    const markdown = renderSynthesisMarkdown(readConsultantView(db, projectId, 'needs-warwick', provider));

    expect(markdown).toContain('Consultant view');
    expect(markdown).toContain('CVF-D-001');
    expect(markdown).toContain('fake-brief-provider');
    expect(markdown).toContain('consultant-brief 1.0.0');
    expect(markdown).toMatch(/Cited records: .*CVF-D-001/);
    expect(markdown).toContain('Deterministic selection:');
    expect(markdown).toContain('## Themes');
  });

  it('says plainly that it contains only the deterministic view when nothing was generated', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider } = countingProvider();
    const markdown = renderSynthesisMarkdown(readConsultantView(db, projectId, 'needs-warwick', provider));
    expect(markdown).toContain('Generated reasoning: none');
  });
});

/* ------------------------------------------------------------------ regressions
 *
 * Every case below reproduces a defect an adversarial reviewer demonstrated on
 * this branch. They are written to fail if the fix is reverted.
 * ---------------------------------------------------------------------------- */

describe('regressions found by adversarial review', () => {
  it('serves the cache when a selection moves away and comes back, instead of paying to regenerate it', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider();
    const before = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    const originalMarkdown = before.synthesis!.briefMarkdown;
    const originalHash = before.deterministic.selectionHash;
    expect(calls()).toBe(1);

    // The selection moves...
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-777', title: 'Transient consultant action', summary: 'Appears and disappears.', owner: 'Casey Flint' });
    rebuildProjection(db, projectId, AS_OF);
    expect(readConsultantView(db, projectId, 'needs-warwick', provider).synthesisState).toBe('stale');

    // ...and comes back.
    db.prepare('DELETE FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').run(projectId, 'CVF-A-777');
    rebuildProjection(db, projectId, AS_OF);
    expect(buildDeterministicConsultantView(db, projectId, 'needs-warwick').selectionHash).toBe(originalHash);

    // The cached narrative describes the current selection again, so it is
    // served unchanged and nothing is spent.
    const after = await generateConsultantView(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);
    expect(after.synthesisState).toBe('current');
    expect(after.synthesis!.briefMarkdown).toBe(originalMarkdown);
  });

  it('does not invalidate the legacy brief cache from a zero-call read', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider, calls } = countingProvider(() => ({ markdown: '## Do first\n- Legacy narrative [CVF-D-001]\n', usage: { inputTokens: 10, outputTokens: 5 } }));

    await buildConsultantBrief(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);
    await buildConsultantBrief(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);

    // A documented zero-call read must not cause a paid call anywhere else.
    readConsultantView(db, projectId, 'needs-warwick', provider);
    readProjectData(db, projectId);
    await buildConsultantBrief(db, projectId, 'needs-warwick', provider);
    expect(calls()).toBe(1);
  });

  it('never serves a legacy-route narrative as the consultant view synthesis', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider } = countingProvider(() => ({ markdown: '## Do first\n- Legacy narrative from the old route [CVF-D-001]\n', usage: { inputTokens: 10, outputTokens: 5 } }));
    await buildConsultantBrief(db, projectId, 'needs-warwick', provider);

    const view = readConsultantView(db, projectId, 'needs-warwick', provider);
    // The legacy brief exists in the same table and records no skill provenance.
    expect(db.prepare("SELECT count(*) count FROM consultant_briefs WHERE project_id = ? AND skill_id IS NULL AND provider_id <> 'deterministic-template'").get(projectId)).toEqual({ count: 1 });
    expect(view.synthesis).toBeNull();
    expect(view.synthesisState).toBe('none');
  });

  it('reports a narrative superseded by a new skill version as stale, with a reason', async () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    const { provider } = countingProvider();
    await generateConsultantView(db, projectId, 'needs-warwick', provider);

    // The selection is unchanged; the identity is not.
    db.prepare("UPDATE extraction_skills SET version = '9.9.9' WHERE skill_id = 'consultant-brief'").run();

    const view = readConsultantView(db, projectId, 'needs-warwick', provider);
    expect(view.synthesisState).toBe('stale');
    // The panel badges the narrative from these fields. They must agree with the
    // state, or the same artefact reads "Stale" in one place and "Current" in
    // another.
    expect(view.synthesis!.stale).toBe(true);
    expect(view.synthesis!.staleReason).toMatch(/Consultant Brief revision moved/i);
  });

  it('caches separately per skill version, not only per model', async () => {
    const { db, directory } = fixture();
    const registryDir = path.join(directory, 'registry');
    mkdirSync(path.join(registryDir, 'consultant-brief'), { recursive: true });
    process.env.PROJECTMANAGAIR_SKILL_REGISTRY_DIR = registryDir;
    try {
      const projectId = seedRealisticProject(db);
      const first = countingProvider();
      await generateConsultantView(db, projectId, 'needs-warwick', first.provider);
      expect(first.calls()).toBe(1);

      // A genuinely different published revision of the same skill. Same
      // selection, same provider, same model — a different artefact.
      uploadSkillDraft(db, {
        text: [
          '---', 'skillId: consultant-brief', 'name: Consultant Brief', 'version: 1.1.0',
          'promptTemplateVersion: consultant-brief-prompt-v1', 'status: draft',
          'purpose: Second revision used by the cache-separation regression test.',
          'notes: Second revision for the cache-separation regression test.', '---',
          'Return markdown only. Cite every factual line with a selected register id.',
        ].join('\n'),
        actor: 'test',
      });
      promoteSkillRevision(db, { skillId: 'consultant-brief', version: '1.1.0', actor: 'test' });

      const second = countingProvider();
      await generateConsultantView(db, projectId, 'needs-warwick', second.provider);
      expect(second.calls()).toBe(1);
      expect(db.prepare('SELECT count(*) count FROM consultant_briefs WHERE project_id = ? AND skill_id IS NOT NULL').get(projectId)).toEqual({ count: 2 });
      // ...and the earlier narrative is retained, naming the revision that wrote it.
      expect((db.prepare('SELECT skill_version FROM consultant_briefs WHERE project_id = ? AND skill_id IS NOT NULL ORDER BY skill_version').all(projectId) as Array<{ skill_version: string }>).map((row) => row.skill_version)).toEqual(['1.0.0', '1.1.0']);
    } finally {
      delete process.env.PROJECTMANAGAIR_SKILL_REGISTRY_DIR;
    }
  });

  it('drops an anchor whose segment id carries no sequence rather than putting it at segment zero', () => {
    const { db } = fixture();
    const projectId = seedProject(db);
    const unrelated = [
      ['CVF-A-400', 'Book the training room'],
      ['CVF-A-401', 'Rewrite the data migration script'],
      ['CVF-A-402', 'Chase the invoice from finance'],
      ['CVF-A-403', 'Agree the go-live comms plan'],
      ['CVF-A-404', 'Replace the broken laptop'],
    ] as const;
    seedSource(db, projectId, 'SRC-9', [12], () => 'SRC-9/segment/12');
    for (const [id, title] of unrelated) {
      seedRow(db, projectId, { register: 'Actions', id, title, summary: `${title}.` });
      // A segment id shape the parser cannot read. Defaulting it to zero used to
      // place every one of these at the same point of the same source, and
      // `shared-source-passage` is a structural edge trusted outright.
      db.prepare('INSERT INTO register_row_anchors (id, project_id, external_register_id, source_id, segment_id, speaker, t_ms, quote, verified) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0)')
        .run(`anchor:${id}`, projectId, id, 'SRC-9', 'SRC-9/segment/12');
    }
    rebuildProjection(db, projectId, AS_OF);
    const { themes, ungroupedIds } = buildProjectThemes(db, projectId);
    expect(themes).toEqual([]);
    expect(ungroupedIds.sort()).toEqual(unrelated.map(([id]) => id).sort());
  });

  it('produces the same selection hash whatever order the anchors were physically inserted', () => {
    const hashes = ['forward', 'reverse'].map((order) => {
      const { db } = fixture();
      const projectId = seedProject(db);
      seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-500', title: 'Anchored action', summary: 'Two anchors in one source.' });
      seedSource(db, projectId, 'SRC-1', [3, 11], (seq) => `SRC-1:seg:${String(seq).padStart(5, '0')}`);
      const anchors = [['a', 3], ['b', 11]] as const;
      for (const [suffix, seq] of order === 'forward' ? anchors : [...anchors].reverse()) {
        db.prepare('INSERT INTO register_row_anchors (id, project_id, external_register_id, source_id, segment_id, speaker, t_ms, quote, verified) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0)')
          .run(`anchor:${suffix}`, projectId, 'CVF-A-500', 'SRC-1', `SRC-1:seg:${String(seq).padStart(5, '0')}`);
      }
      rebuildProjection(db, projectId, AS_OF);
      return buildDeterministicConsultantView(db, projectId, 'needs-warwick').selectionHash;
    });
    // Re-applying a source deletes and re-inserts its anchors, so physical row
    // order changes for logically identical data. The hash must not.
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('does not join two records because a short entity name appears inside longer words', () => {
    const { db } = fixture();
    const projectId = seedProject(db);
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-600', title: 'Book the venue for the two workshops', summary: 'Venue booking.' });
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-601', title: 'Order replacement laptops for the site team', summary: 'Hardware order.' });
    seedRow(db, projectId, { register: 'Entities', id: 'CVF-E-600', title: 'Ops', summary: 'The operations team.' });
    db.prepare("INSERT INTO register_entities (register_row_id, project_id, external_register_id, entity_name, entity_type, aliases_json, alias_confidence, disambiguation_note) VALUES (?, ?, 'CVF-E-600', 'Ops', 'team', '[]', NULL, NULL)")
      .run(`register:${projectId}:CVF-E-600`, projectId);
    rebuildProjection(db, projectId, AS_OF);
    const { themes } = buildProjectThemes(db, projectId);
    // "Ops" is a substring of both "workshops" and "laptops" and of nothing else
    // they share.
    expect(themes.filter((theme) => theme.memberIds.includes('CVF-A-600') && theme.memberIds.includes('CVF-A-601'))).toEqual([]);
  });

  it('draws no lexical edge in a project too small for document frequency to mean anything', () => {
    const { db } = fixture();
    const projectId = seedProject(db);
    seedRow(db, projectId, { register: 'Actions', id: 'CVF-A-700', title: 'Customer data system update', summary: 'Customer data system update.' });
    seedRow(db, projectId, { register: 'Risks_Issues', id: 'CVF-R-700', title: 'Update customer system data', summary: 'Update customer system data.' });
    rebuildProjection(db, projectId, AS_OF);
    // With two rows every token is "rare", so the distinctiveness guard measures
    // nothing and these would group on exactly the vocabulary it exists to ignore.
    expect(buildProjectThemes(db, projectId).themes).toEqual([]);
  });

  it('survives a JSON array column stored as an empty string', () => {
    const { db } = fixture();
    const projectId = seedRealisticProject(db);
    db.prepare("UPDATE project_register_rows SET work_package_tags_json = '', related_ids_json = '' WHERE project_id = ?").run(projectId);
    // A malformed value means "no tags", not "this view cannot be built". The
    // wider project read has its own JSON parsing in `projectRegisters` and
    // `registerProjection` that predates this branch and is unchanged; this
    // asserts only that the theme engine no longer adds a new way for one bad
    // column to take a route down.
    expect(() => buildDeterministicConsultantView(db, projectId, 'meeting')).not.toThrow();
    expect(buildProjectThemes(db, projectId).rows.every((row) => row.workPackages.length === 0)).toBe(true);
  });
});
