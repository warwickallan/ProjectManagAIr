/**
 * Deterministic two-phase packet application — packet-internal relationship
 * resolution.
 *
 * The limitation this suite exists to remove: register categories are applied
 * in a fixed order (`Decisions` before `Open_Questions`, and so on), so a
 * relationship asserted by a row in an earlier category could never name a row
 * the same packet created in a later one. The target did not exist yet when
 * its own category was reached, so the relationship was silently dropped and
 * a second extraction pass — another provider call, another changeset — was
 * needed purely because of an internal ordering artefact.
 *
 * The real-world case is completely ordinary: ONE meeting raises a question at
 * ten past the hour and answers it at half past. Nothing about that should
 * cost two AI calls or two reviews.
 *
 * Everything here is synthetic — an invented project, invented people,
 * invented content. No real customer data. No real provider call: the
 * deterministic `FakeStructuredExtractionProvider` throws if asked twice, so
 * "zero extra provider calls" is enforced by the harness, not merely asserted
 * afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import { FakeStructuredExtractionProvider, type SourcePacketRow, type StructuredExtractionRequest } from '../src/extractionProvider';
import { confirmSourceMetadata, createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import { runSourceExtractionJob, type SourcePipelineEvent } from '../src/sourcePipeline';
import { applyReviewedChangeset, reviewChangeset } from '../src/sourceIntelligence';
import { rebuildProjection } from '../src/registerProjection';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/**
 * ONE meeting. The question is raised in the second cue and answered in the
 * fifth — deliberately far enough apart that the two rows must carry different
 * anchors, so "the original question kept its earlier anchor" is a real check
 * and not an artefact of both rows citing the same segment.
 */
const SINGLE_MEETING_VTT = [
  'WEBVTT',
  'NOTE Recorded: 2026-08-05',
  '',
  '00:00:01.000 --> 00:00:06.000',
  'Alex: Right, first item on the agenda is the excavation permit paperwork.',
  '',
  '00:00:07.000 --> 00:00:13.000',
  'Jordan: We still need to confirm how long an excavation permit should last before work starts.',
  '',
  '00:00:14.000 --> 00:00:19.000',
  'Alex: Let me check the standing instruction while we work through the other items.',
  '',
  '00:00:20.000 --> 00:00:25.000',
  'Jordan: Moving on, the site induction pack needs reprinting before the next mobilisation.',
  '',
  '00:00:26.000 --> 00:00:33.000',
  'Alex: Coming back to permits, the standing instruction confirms five working days for an excavation permit.',
  '',
  '00:00:34.000 --> 00:00:39.000',
  'Jordan: Good, that settles the permit duration question we raised at the start of this meeting.',
].join('\n');

async function newProject(dir: string, code: string) {
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 'acceptance.db'));
  openDatabases.push(context.db);
  await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  const project = createProject(context.db, {
    code, name: 'Synthetic Concerto Rollout', customer: 'Synthetic Customer Ltd', description: 'Synthetic packet-internal relationship fixture.', status: 'active', owner: 'Casey',
  });
  return { context, project };
}

function anchorFor(db: DatabaseSync, sourceId: string, matchText: string) {
  const rows = db.prepare('SELECT * FROM source_segments WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<Record<string, unknown>>;
  const row = rows.find((entry) => String(entry.text).includes(matchText));
  if (!row) throw new Error(`No segment in ${sourceId} contains "${matchText}"`);
  return { segment_seq: Number(row.seq), speaker: row.speaker ? String(row.speaker) : null, t_ms: row.t_start_ms === null ? null : Number(row.t_start_ms), quote: String(row.text) };
}

function baseRow(overrides: Partial<SourcePacketRow> & Pick<SourcePacketRow, 'client_ref' | 'title' | 'summary' | 'anchors' | 'source_ref'>): SourcePacketRow {
  return {
    op: 'add', target_id: null, proposed_id: '$ALLOC', status: 'open', record_type: null, owner: 'Casey', due_date_raw: null,
    related_refs: [], supersedes: [], derivation: 'fact', reasoning: null, confidence: 'high', discharges_markers: [], details: {},
    ...overrides,
  };
}

function coverage(request: StructuredExtractionRequest, populated: Set<string>) {
  return {
    windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'populated' as const, itemCount: 1, explanation: null })),
    categoryCoverage: request.categories.map((key) => ({
      key, status: populated.has(key) ? 'populated' as const : 'none-found' as const, itemCount: populated.has(key) ? 1 : 0,
      explanation: populated.has(key) ? null : `No ${key} found in the synthetic source.`,
    })),
  };
}

function usageFor(request: StructuredExtractionRequest) {
  return { inputTokens: 140, outputTokens: 60, sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0) };
}

const HELD = new Set(['conflict', 'unverified_link', 'possible_duplicate']);

function reviewEverything(db: DatabaseSync, changesetId: string, reviewer: string) {
  const ops = db.prepare('SELECT id, op FROM register_change_ops WHERE changeset_id = ?').all(changesetId) as Array<{ id: string; op: string }>;
  for (const row of ops) reviewChangeset(db, changesetId, { decision: HELD.has(row.op) ? 'reject' : 'accept', reviewer, opIds: [row.id] });
  return ops;
}

describe('deterministic two-phase packet application', () => {
  it('links a question raised and answered in the SAME meeting inside one packet, one changeset and one provider call', async () => {
    const dir = temporaryDirectory('packet-internal-relationships-');
    const { context, project } = await newProject(dir, 'PKTREL');
    const db = context.db;

    const intake = await intakeProjectSource(db, project.projectId, {
      name: 'single-meeting.vtt', dataBase64: Buffer.from(SINGLE_MEETING_VTT, 'utf8').toString('base64'),
    }) as unknown as { sourceId: string };
    confirmSourceMetadata(db, project.projectId, intake.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', eventDate: '2026-08-05', primaryWorkPackage: 'Permit to Work', reason: null,
    });

    const questionAnchor = anchorFor(db, intake.sourceId, 'how long an excavation permit should last');
    const decisionAnchor = anchorFor(db, intake.sourceId, 'confirms five working days');
    // The two claims genuinely sit at different points in the meeting.
    expect(questionAnchor.segment_seq).toBeLessThan(decisionAnchor.segment_seq);

    // The provider is called exactly once and refuses a second call outright,
    // so an accidental re-extraction fails the test rather than passing it
    // quietly with a higher call count.
    let providerCalls = 0;
    const provider = new FakeStructuredExtractionProvider((request) => {
      providerCalls += 1;
      if (providerCalls > 1) throw new Error('Second provider call attempted; a same-packet relationship must not cost another extraction.');
      return {
        output: {
          rows: [
            // A Decisions row that answers a question created LATER in this
            // same packet's fixed category order. Before two-phase apply this
            // reference resolved to nothing and was silently dropped.
            {
              registerName: 'Decisions' as const,
              row: baseRow({
                source_ref: intake.sourceId, client_ref: 'decision-1', status: 'agreed',
                title: 'Excavation permit duration confirmed',
                summary: 'The standing instruction confirms five working days for an excavation permit.',
                anchors: [decisionAnchor], answers: ['question-1'], work_package_tags: ['Permit to Work'],
              } as unknown as Parameters<typeof baseRow>[0]),
            },
            // The question itself, anchored where it was actually raised.
            {
              registerName: 'Open_Questions' as const,
              row: baseRow({
                source_ref: intake.sourceId, client_ref: 'question-1', status: 'open',
                title: 'Excavation permit duration',
                summary: 'How long should an excavation permit last before work starts?',
                anchors: [questionAnchor], work_package_tags: ['Permit to Work'],
                details: { question: 'How long should an excavation permit last before work starts?' },
              } as unknown as Parameters<typeof baseRow>[0]),
            },
            // A resolve op whose TARGET is a client_ref of a row this same
            // packet creates. This is the effective-status half of the story:
            // the relationship is declarative, the status change is its own
            // reviewed operation.
            {
              registerName: 'Open_Questions' as const,
              row: baseRow({
                source_ref: intake.sourceId, client_ref: 'question-1-resolve', op: 'resolve', target_id: 'question-1', proposed_id: null,
                title: 'Excavation permit duration',
                summary: 'Answered in the same meeting: five working days.',
                status: 'answered', anchors: [anchorFor(db, intake.sourceId, 'settles the permit duration question')],
              } as unknown as Parameters<typeof baseRow>[0]),
            },
            {
              registerName: 'Sources' as const,
              row: baseRow({
                source_ref: intake.sourceId, client_ref: 'source-1', title: 'single-meeting.vtt',
                summary: 'Immutable single-meeting source registered.', anchors: [decisionAnchor], details: { source_type: 'vtt-transcript' },
              }),
            },
          ],
          ...coverage(request, new Set(['Decisions', 'Open_Questions', 'Sources'])),
        },
        usage: usageFor(request),
      };
    });

    const events: SourcePipelineEvent[] = [];
    let changesetId: string | null = null;
    const extracted = await runSourceExtractionJob(db, {
      sourceId: intake.sourceId, provider,
      onEvent: (event) => { events.push(event); if (event.type === 'completed') changesetId = event.changesetId; },
    });
    expect(extracted.status).toBe('completed');
    expect(extracted.providerCalls).toBe(1);
    expect(changesetId).toBeTruthy();

    // ONE changeset. The forward reference did not quarantine the packet and
    // the resolve op targeting a same-packet row was NOT held as an
    // unverified link.
    const reviewedOps = reviewEverything(db, changesetId!, 'Casey');
    expect(reviewedOps.map((row) => row.op).sort()).toEqual(['add', 'add', 'add', 'resolve']);
    const applied = applyReviewedChangeset(db, changesetId!);
    expect(applied.appliedOperations).toBe(4);

    /* ----------------------------------------------------------------- *
     * Proof.
     * ----------------------------------------------------------------- */
    const questionRow = db.prepare("SELECT external_register_id, title, summary FROM project_register_rows WHERE project_id = ? AND register_name = 'Open_Questions'").get(project.projectId) as { external_register_id: string; title: string; summary: string };
    const decisionRow = db.prepare("SELECT external_register_id, summary FROM project_register_rows WHERE project_id = ? AND register_name = 'Decisions'").get(project.projectId) as { external_register_id: string; summary: string };

    // 1. The ORIGINAL question survives as its own durable record — the
    //    answer did not replace it or fold it into the decision.
    expect(questionRow.title).toBe('Excavation permit duration');
    expect(decisionRow.external_register_id).not.toBe(questionRow.external_register_id);

    // 2. It keeps its EARLIER anchor: the moment the question was raised,
    //    not the moment it was answered.
    const questionAnchors = db.prepare('SELECT segment_id, quote FROM register_row_anchors WHERE project_id = ? AND external_register_id = ?').all(project.projectId, questionRow.external_register_id) as Array<{ segment_id: string; quote: string }>;
    expect(questionAnchors.some((row) => row.quote.includes('how long an excavation permit should last'))).toBe(true);

    // 3. The answering decision carries its own, LATER anchor.
    const decisionAnchors = db.prepare('SELECT segment_id, quote FROM register_row_anchors WHERE project_id = ? AND external_register_id = ?').all(project.projectId, decisionRow.external_register_id) as Array<{ segment_id: string; quote: string }>;
    expect(decisionAnchors.some((row) => row.quote.includes('confirms five working days'))).toBe(true);
    const anchorSeq = (segmentId: string) => Number(segmentId.split(':seg:')[1]);
    expect(Math.min(...questionAnchors.map((row) => anchorSeq(row.segment_id)))).toBeLessThan(Math.max(...decisionAnchors.map((row) => anchorSeq(row.segment_id))));

    // 4. Effective answered status — through the reviewed `resolve`
    //    operation, not as a side effect of the relationship.
    rebuildProjection(db, project.projectId, '2026-08-06T00:00:00.000Z');
    const questionState = db.prepare('SELECT status FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(project.projectId, questionRow.external_register_id) as { status: string };
    expect(questionState.status).toBe('resolved');

    // 5. Bidirectional answer relationship, both halves stored, each naming
    //    the other row.
    const answersEvent = db.prepare("SELECT related_external_id, source_id, origin FROM register_row_events WHERE project_id = ? AND external_register_id = ? AND event_type = 'answers'").get(project.projectId, decisionRow.external_register_id) as { related_external_id: string; source_id: string; origin: string } | undefined;
    expect(answersEvent?.related_external_id).toBe(questionRow.external_register_id);
    const answeredByEvent = db.prepare("SELECT related_external_id, source_id, origin FROM register_row_events WHERE project_id = ? AND external_register_id = ? AND event_type = 'answered_by'").get(project.projectId, questionRow.external_register_id) as { related_external_id: string; source_id: string; origin: string } | undefined;
    expect(answeredByEvent?.related_external_id).toBe(decisionRow.external_register_id);

    // 6. Source provenance survives on the relationship itself, not only on
    //    the rows: both halves name the source they came from.
    expect(answersEvent?.source_id).toBe(intake.sourceId);
    expect(answeredByEvent?.source_id).toBe(intake.sourceId);
    expect(answersEvent?.origin).toBe('source');
    expect(answeredByEvent?.origin).toBe('source');

    // 7. ONE reviewed/applied packet — not a first pass plus a follow-up.
    const changesets = db.prepare('SELECT id, review_status FROM register_changesets WHERE project_id = ?').all(project.projectId) as Array<{ id: string; review_status: string }>;
    expect(changesets).toHaveLength(1);
    expect(changesets[0].review_status).toBe('applied');
    const packets = db.prepare('SELECT id FROM extraction_packets WHERE project_id = ?').all(project.projectId);
    expect(packets).toHaveLength(1);

    // 8. ZERO extra provider calls: one extraction run, and no Consultant
    //    Reasoning call was triggered anywhere in the sequence.
    expect(providerCalls).toBe(1);
    expect((db.prepare('SELECT count(*) count FROM extraction_runs WHERE source_id = ?').get(intake.sourceId) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT count(*) count FROM consultant_reasoning_runs').get() as { count: number }).count).toBe(0);

    // 9. Replay stays deterministic with the relationship events in the log.
    rebuildProjection(db, project.projectId, '2026-08-06T00:00:00.000Z');
    const once = JSON.stringify(db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
    rebuildProjection(db, project.projectId, '2026-08-06T00:00:00.000Z');
    const twice = JSON.stringify(db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
    expect(once).toBe(twice);
  });

  it('still holds a forward reference that lands in the wrong register, and refuses a self-reference', async () => {
    const dir = temporaryDirectory('packet-internal-guards-');
    const { context, project } = await newProject(dir, 'PKTGRD');
    const db = context.db;

    const intake = await intakeProjectSource(db, project.projectId, {
      name: 'single-meeting.vtt', dataBase64: Buffer.from(SINGLE_MEETING_VTT, 'utf8').toString('base64'),
    }) as unknown as { sourceId: string };
    confirmSourceMetadata(db, project.projectId, intake.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', eventDate: '2026-08-05', primaryWorkPackage: 'Permit to Work', reason: null,
    });
    const decisionAnchor = anchorFor(db, intake.sourceId, 'confirms five working days');
    const questionAnchor = anchorFor(db, intake.sourceId, 'how long an excavation permit should last');

    const provider = new FakeStructuredExtractionProvider((request) => ({
      output: {
        rows: [
          {
            registerName: 'Open_Questions' as const,
            row: baseRow({ source_ref: intake.sourceId, client_ref: 'question-1', title: 'Excavation permit duration', summary: 'How long should an excavation permit last?', anchors: [questionAnchor] }),
          },
          // A Decisions `resolve` whose target is created by this packet as an
          // Open_Questions row. Relaxing the ordering rule must NOT relax the
          // register rule: this is still an illegal link.
          {
            registerName: 'Decisions' as const,
            row: baseRow({ source_ref: intake.sourceId, client_ref: 'cross-register', op: 'resolve', target_id: 'question-1', proposed_id: null, title: 'Excavation permit duration confirmed', summary: 'The standing instruction confirms five working days.', anchors: [decisionAnchor] } as unknown as Parameters<typeof baseRow>[0]),
          },
          {
            registerName: 'Sources' as const,
            row: baseRow({ source_ref: intake.sourceId, client_ref: 'source-1', title: 'single-meeting.vtt', summary: 'Immutable single-meeting source registered.', anchors: [decisionAnchor], details: { source_type: 'vtt-transcript' } }),
          },
        ],
        ...coverage(request, new Set(['Decisions', 'Open_Questions', 'Sources'])),
      },
      usage: usageFor(request),
    }));

    let changesetId: string | null = null;
    const extracted = await runSourceExtractionJob(db, {
      sourceId: intake.sourceId, provider,
      onEvent: (event) => { if (event.type === 'completed') changesetId = event.changesetId; },
    });
    expect(extracted.status).toBe('completed');
    const ops = db.prepare('SELECT client_ref, op FROM register_change_ops WHERE changeset_id = ?').all(changesetId!) as Array<{ client_ref: string; op: string }>;
    expect(ops.find((row) => row.client_ref === 'cross-register')?.op).toBe('unverified_link');

    // And a held op still cannot be applied directly.
    reviewChangeset(db, changesetId!, { decision: 'reject', reviewer: 'Casey', opIds: [`${changesetId}:op:001`] });
  });
});
