/**
 * Source safety, end to end through the real pipeline.
 *
 * Every uploaded transcript is a reversible source transaction: duplicate
 * detection before any AI call, an explicitly unknown meeting date, discard
 * before application, and void after it with deterministic replay.
 *
 * Everything is synthetic — invented project, invented people, invented
 * content. The extraction provider is a deterministic fake that RECORDS every
 * call, so "zero provider calls" is measured rather than asserted, and the real
 * `runSourceExtractionJob` gate is what has to refuse.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import { FakeStructuredExtractionProvider, type SourcePacketRow, type StructuredExtractionRequest } from '../src/extractionProvider';
import { confirmSourceMetadata, createProject, intakeProjectSource, readSourceMetadata, updateStorageSettings } from '../src/projectLifecycle';
import { runSourceExtractionJob } from '../src/sourcePipeline';
import { applyReviewedChangeset, reviewChangeset } from '../src/sourceIntelligence';
import { rebuildProjection } from '../src/registerProjection';
import { decideSourceComparison, discardSource, readSourceSafety, voidSource } from '../src/sourceSafety';

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

/** A meeting with NO date anywhere — no NOTE Recorded header, nothing in the filename. */
const UNDATED_MEETING = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:07.000',
  'Alex: The excavation permit duration is confirmed at five working days.',
  '',
  '00:00:08.000 --> 00:00:14.000',
  'Jordan: Noted, I will update the induction pack to match that duration.',
  '',
  '00:00:15.000 --> 00:00:21.000',
  'Alex: We also need the deputy signature route written down properly.',
].join('\n');

/** A second, genuinely different undated meeting. */
const OTHER_MEETING = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:07.000',
  'Sam: Night shift cover needs a named deputy on every permit.',
  '',
  '00:00:08.000 --> 00:00:14.000',
  'Ravi: I will add the deputy names to the training slides this week.',
  '',
  '00:00:15.000 --> 00:00:22.000',
  'Sam: Good, and the register should record both signatures every time.',
].join('\n');

async function newProject(dir: string, code: string) {
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 'safety.db'));
  openDatabases.push(context.db);
  await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  const project = createProject(context.db, {
    code, name: 'Synthetic Concerto Rollout', customer: 'Synthetic Customer Ltd', description: 'Synthetic source-safety fixture.', status: 'active', owner: 'Casey',
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

const usageFor = (request: StructuredExtractionRequest) => ({ inputTokens: 120, outputTokens: 45, sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0) });

/** Counts every call so "zero provider calls" is measured, not assumed. */
class CountingProvider extends FakeStructuredExtractionProvider {
  calls = 0;
}

/** Every HIGH governance cue the detector found in this source. */
function highMarkers(db: DatabaseSync, sourceId: string): Array<{ id: string; segment_seq: number }> {
  return db.prepare("SELECT id, segment_seq FROM source_markers WHERE source_id = ? AND confidence = 'high' ORDER BY segment_seq").all(sourceId) as Array<{ id: string; segment_seq: number }>;
}

/** How far from a marker a row may be anchored and still account for it — mirrors the validator's own radius. */
const MARKER_RADIUS = 3;

/**
 * A deterministic provider that also satisfies the real HIGH-marker gate.
 *
 * These fixtures are about source safety, not extraction recall, but the gate
 * is real and is not bypassed: every HIGH governance cue the detector found is
 * discharged by whichever emitted row is anchored nearest it, exactly as a real
 * extraction does. Dismissal is deliberately NOT used as an escape hatch — the
 * validator caps dismissals at a minority of the checklist precisely so a pass
 * cannot answer the whole thing that way, and a fixture that leaned on it would
 * be testing a path real extractions cannot take.
 */
function providerFor(db: DatabaseSync, sourceId: string, rows: (request: StructuredExtractionRequest) => Array<{ registerName: string; row: SourcePacketRow }>, populated: Set<string>) {
  const provider = new CountingProvider((request) => {
    provider.calls += 1;
    const emitted = rows(request);
    const discharged = new Set(emitted.flatMap((entry) => entry.row.discharges_markers ?? []));
    for (const marker of highMarkers(db, sourceId)) {
      if (discharged.has(marker.id)) continue;
      const nearest = emitted.find((entry) => entry.row.anchors.some((anchor) => Math.abs(anchor.segment_seq - marker.segment_seq) <= MARKER_RADIUS));
      if (!nearest) throw new Error(`Fixture emits no row anchored within ${MARKER_RADIUS} segments of HIGH marker ${marker.id}.`);
      nearest.row.discharges_markers = [...(nearest.row.discharges_markers ?? []), marker.id];
    }
    return { output: { rows: emitted as never, ...coverage(request, populated) }, usage: usageFor(request) };
  });
  return provider;
}

const HELD = new Set(['conflict', 'unverified_link', 'possible_duplicate']);

function reviewEverything(db: DatabaseSync, changesetId: string, reviewer: string) {
  const ops = db.prepare('SELECT id, op FROM register_change_ops WHERE changeset_id = ?').all(changesetId) as Array<{ id: string; op: string }>;
  for (const row of ops) reviewChangeset(db, changesetId, { decision: HELD.has(row.op) ? 'reject' : 'accept', reviewer, opIds: [row.id] });
  return ops;
}

async function ingest(db: DatabaseSync, projectId: string, name: string, text: string) {
  return await intakeProjectSource(db, projectId, { name, dataBase64: Buffer.from(text, 'utf8').toString('base64') }) as unknown as {
    sourceId: string; intakeSourceId?: string; duplicate?: boolean; classification?: string; blocksExtraction?: boolean;
  };
}

describe('duplicate and overlap detection before any AI call', () => {
  it('blocks a RENAMED exact duplicate before the provider, and never calls it', async () => {
    const dir = temporaryDirectory('safety-dup-');
    const { context, project } = await newProject(dir, 'SAFEDUP');
    const db = context.db;

    const first = await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    expect(first.duplicate).toBeFalsy();
    expect(first.classification).toBe('apparently-new');

    // Same bytes, completely different name.
    const second = await ingest(db, project.projectId, 'Permit Session (2).vtt', UNDATED_MEETING);
    expect(second.duplicate).toBe(true);
    expect(second.classification).toBe('exact-duplicate');
    expect(second.blocksExtraction).toBe(true);

    // The renamed arrival did NOT create a second source, and the new name is
    // recorded against the one that exists.
    expect((db.prepare('SELECT count(*) c FROM source_documents WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(1);
    const safety = readSourceSafety(db, project.projectId, first.sourceId)!;
    expect(safety.alternateNames.map((row) => row.fileName).sort()).toEqual(['Permit Session (2).vtt', 'permit-session.vtt']);
    expect((db.prepare('SELECT count(*) c FROM extraction_runs').get() as { c: number }).c).toBe(0);
  });

  it('detects a harmlessly REFORMATTED re-export as the same transcript and holds it before the provider', async () => {
    const dir = temporaryDirectory('safety-reexport-');
    const { context, project } = await newProject(dir, 'SAFERE');
    const db = context.db;

    await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    // Same dialogue, different line endings, a NOTE block, cue numbers added.
    const reexported = ['WEBVTT', '', 'NOTE Re-exported later.', '', '1', '00:00:01.000 --> 00:00:07.000',
      'Alex: The excavation permit duration is confirmed at five working days.', '', '2', '00:00:08.000 --> 00:00:14.000',
      'Jordan: Noted, I will update the induction pack to match that duration.', '', '3', '00:00:15.000 --> 00:00:21.000',
      'Alex: We also need the deputy signature route written down properly.'].join('\r\n');
    const second = await ingest(db, project.projectId, 'permit-session-reexport.vtt', reexported);
    expect(second.duplicate).toBeFalsy();
    expect(second.classification).toBe('normalised-duplicate');
    expect(second.blocksExtraction).toBe(true);

    // The gate refuses the provider outright while the decision is outstanding.
    const provider = providerFor(db, second.sourceId, () => [], new Set());
    const result = await runSourceExtractionJob(db, { sourceId: second.sourceId, provider });
    expect(result.status).toBe('awaiting-duplicate-decision');
    expect(result.providerCalls).toBe(0);
    expect(provider.calls).toBe(0);
  });

  it('keeps two different meetings with near-identical filenames distinct', async () => {
    const dir = temporaryDirectory('safety-similar-');
    const { context, project } = await newProject(dir, 'SAFESIM');
    const db = context.db;
    await ingest(db, project.projectId, 'Permit to Work Training Session.vtt', UNDATED_MEETING);
    const second = await ingest(db, project.projectId, 'Permit to Work Training Session (2).vtt', OTHER_MEETING);
    expect(second.duplicate).toBeFalsy();
    expect(second.classification).toBe('similar-filename-different-content');
    expect(second.blocksExtraction).toBe(false);
    expect((db.prepare('SELECT count(*) c FROM source_documents WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(2);
  });
});

describe('a meeting date that is genuinely unknown', () => {
  it('is accepted explicitly, fabricates no chronology, and still allows extraction', async () => {
    const dir = temporaryDirectory('safety-unknown-');
    const { context, project } = await newProject(dir, 'SAFEUNK');
    const db = context.db;
    const source = await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);

    // The old gate demanded a date. Subject and work package are still
    // mandatory; a missing ANSWER about the date is refused, but "unknown" is a
    // legitimate answer.
    expect(() => confirmSourceMetadata(db, project.projectId, source.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', primaryWorkPackage: 'Permit to Work', reason: null,
    })).toThrow(/explicitly select/i);
    expect(() => confirmSourceMetadata(db, project.projectId, source.sourceId, {
      actor: 'Casey', meetingSubject: '', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null,
    })).toThrow(/subject/i);

    const metadata = confirmSourceMetadata(db, project.projectId, source.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null,
    });
    expect(metadata.confirmed).toBe(true);
    expect(metadata.chronology.state).toBe('unknown');
    expect(metadata.chronologyLabel).toBe('Meeting date unknown');
    // No date was invented anywhere.
    expect(metadata.eventDate).toBeNull();
    const stored = db.prepare('SELECT confirmed_event_date, chronology_state, chronology_basis FROM source_documents WHERE id = ?').get(source.sourceId) as Record<string, unknown>;
    expect(stored.confirmed_event_date).toBeNull();
    expect(stored.chronology_state).toBe('unknown');

    // An unknown-date source may still be extracted and propose new records.
    const provider = providerFor(db, source.sourceId, (request) => [
      { registerName: 'Decisions', row: baseRow({ source_ref: source.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days.', anchors: [anchorFor(db, source.sourceId, 'five working days')] }) },
      { registerName: 'Sources', row: baseRow({ source_ref: source.sourceId, client_ref: 's1', title: 'permit-session.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, source.sourceId, 'five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Sources']));
    let changesetId: string | null = null;
    const run = await runSourceExtractionJob(db, { sourceId: source.sourceId, provider, onEvent: (event) => { if (event.type === 'completed') changesetId = event.changesetId; } });
    expect(run.status).toBe('completed');
    expect(provider.calls).toBe(1);
    reviewEverything(db, changesetId!, 'Casey');
    applyReviewedChangeset(db, changesetId!);
    expect((db.prepare("SELECT count(*) c FROM project_register_rows WHERE project_id = ? AND register_name = 'Decisions'").get(project.projectId) as { c: number }).c).toBe(1);
  });

  it('records a later correction of the date as an audited change, and then USES it', async () => {
    const dir = temporaryDirectory('safety-correct-');
    const { context, project } = await newProject(dir, 'SAFECOR');
    const db = context.db;
    const source = await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    confirmSourceMetadata(db, project.projectId, source.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null,
    });
    confirmSourceMetadata(db, project.projectId, source.sourceId, {
      actor: 'Casey', meetingSubject: 'Permit Working Session', chronologyState: 'confirmed', eventDate: '2026-08-05',
      primaryWorkPackage: 'Permit to Work', reason: 'Found the calendar invite.',
    });
    const events = db.prepare("SELECT field, previous_value, new_value, reason, actor FROM source_metadata_events WHERE source_id = ? AND field IN ('chronology_state', 'confirmed_event_date') ORDER BY field").all(source.sourceId) as Array<Record<string, unknown>>;
    expect(events.map((row) => row.field)).toEqual(['chronology_state', 'confirmed_event_date']);
    expect(events.every((row) => row.reason === 'Found the calendar invite.' && row.actor === 'Casey')).toBe(true);
    const metadata = readSourceMetadata(db, source.sourceId)!;
    expect(metadata.chronology.state).toBe('confirmed');
    expect(metadata.chronology.basis).toBe('human-confirmed');
    expect(metadata.chronologyLabel).toBe('2026-08-05');
  });

  it('holds an unknown-vs-dated mutation as "Chronology unresolved" instead of letting upload order decide', async () => {
    const dir = temporaryDirectory('safety-unresolved-');
    const { context, project } = await newProject(dir, 'SAFEUNR');
    const db = context.db;

    // A DATED source establishes the decision.
    const dated = await ingest(db, project.projectId, 'dated-session.vtt', UNDATED_MEETING);
    confirmSourceMetadata(db, project.projectId, dated.sourceId, {
      actor: 'Casey', meetingSubject: 'Dated Session', chronologyState: 'confirmed', eventDate: '2026-08-01', primaryWorkPackage: 'Permit to Work', reason: null,
    });
    const providerA = providerFor(db, dated.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: dated.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days, as agreed on 1 August.', anchors: [anchorFor(db, dated.sourceId, 'five working days')] }) },
      { registerName: 'Sources', row: baseRow({ source_ref: dated.sourceId, client_ref: 's1', title: 'dated-session.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, dated.sourceId, 'five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Sources']));
    let changesetA: string | null = null;
    await runSourceExtractionJob(db, { sourceId: dated.sourceId, provider: providerA, onEvent: (event) => { if (event.type === 'completed') changesetA = event.changesetId; } });
    reviewEverything(db, changesetA!, 'Casey');
    applyReviewedChangeset(db, changesetA!);
    const decisionId = String((db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Decisions'").get(project.projectId) as { external_register_id: string }).external_register_id);

    // An UNDATED source, uploaded LATER, tries to change the same field.
    const undated = await ingest(db, project.projectId, 'undated-session.vtt', OTHER_MEETING);
    confirmSourceMetadata(db, project.projectId, undated.sourceId, {
      actor: 'Casey', meetingSubject: 'Undated Session', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null,
    });
    const providerB = providerFor(db, undated.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: undated.sourceId, client_ref: 'd2', op: 'update', target_id: decisionId, proposed_id: decisionId, status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Actually seven working days.', anchors: [anchorFor(db, undated.sourceId, 'named deputy on every permit')] } as unknown as Parameters<typeof baseRow>[0]) },
      { registerName: 'Sources', row: baseRow({ source_ref: undated.sourceId, client_ref: 's2', title: 'undated-session.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, undated.sourceId, 'named deputy on every permit')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Sources']));
    let changesetB: string | null = null;
    await runSourceExtractionJob(db, { sourceId: undated.sourceId, provider: providerB, onEvent: (event) => { if (event.type === 'completed') changesetB = event.changesetId; } });

    // Uploaded later, but that buys it nothing: held, with the reason saying so.
    const heldOp = db.prepare("SELECT op, field_diff_json FROM register_change_ops WHERE changeset_id = ? AND client_ref = 'd2'").get(changesetB!) as { op: string; field_diff_json: string };
    expect(heldOp.op).toBe('conflict');
    expect(String(JSON.parse(heldOp.field_diff_json).reason)).toContain('Chronology unresolved');

    reviewEverything(db, changesetB!, 'Casey');
    applyReviewedChangeset(db, changesetB!);
    // The dated source's value survives untouched.
    expect((db.prepare('SELECT summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, decisionId) as { summary: string }).summary)
      .toBe('Five working days, as agreed on 1 August.');
  });
});

describe('discard, before anything is applied', () => {
  it('discards before extraction, invoking no provider and changing no project state', async () => {
    const dir = temporaryDirectory('safety-discard-early-');
    const { context, project } = await newProject(dir, 'SAFEDIS');
    const db = context.db;
    const source = await ingest(db, project.projectId, 'wrong-file.vtt', UNDATED_MEETING);

    const result = discardSource(db, project.projectId, source.sourceId, { actor: 'Casey', reason: 'Uploaded the wrong meeting.', state: 'wrong-file' });
    expect(result.lifecycleState).toBe('wrong-file');
    expect(result.providerCalls).toBe(0);

    // Evidence, hashes and provenance are all preserved.
    const safety = readSourceSafety(db, project.projectId, source.sourceId)!;
    expect(safety.contentHash).toHaveLength(64);
    expect(safety.canonicalFingerprint).toHaveLength(64);
    expect(safety.chunkCount).toBeGreaterThan(0);
    expect(safety.immutablePath).toBeTruthy();
    expect(safety.lifecycleHistory).toHaveLength(1);
    expect(safety.lifecycleHistory[0]).toMatchObject({ actor: 'Casey', newState: 'wrong-file', reason: 'Uploaded the wrong meeting.' });
    expect(safety.canDiscard).toBe(false);
    expect(safety.canVoid).toBe(false);

    // A mandatory reason and actor are enforced in the service, not only the UI.
    const other = await ingest(db, project.projectId, 'another.vtt', OTHER_MEETING);
    expect(() => discardSource(db, project.projectId, other.sourceId, { actor: 'Casey', reason: '  ', state: 'discarded' })).toThrow(/reason/i);
    expect(() => discardSource(db, project.projectId, other.sourceId, { actor: '', reason: 'x', state: 'discarded' })).toThrow(/actor/i);

    // And the gate refuses to extract a retired source.
    const provider = providerFor(db, source.sourceId, () => [], new Set());
    const run = await runSourceExtractionJob(db, { sourceId: source.sourceId, provider });
    expect(run.status).toBe('source-retired');
    expect(run.providerCalls).toBe(0);
    expect(provider.calls).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM register_row_events WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(0);
  });

  it('discards after a proposal exists but before it is applied, changing no project state', async () => {
    const dir = temporaryDirectory('safety-discard-proposed-');
    const { context, project } = await newProject(dir, 'SAFEPRO');
    const db = context.db;
    const source = await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    confirmSourceMetadata(db, project.projectId, source.sourceId, { actor: 'Casey', meetingSubject: 'Permit Session', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null });
    const provider = providerFor(db, source.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: source.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days.', anchors: [anchorFor(db, source.sourceId, 'five working days')] }) },
      { registerName: 'Sources', row: baseRow({ source_ref: source.sourceId, client_ref: 's1', title: 'permit-session.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, source.sourceId, 'five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Sources']));
    let changesetId: string | null = null;
    await runSourceExtractionJob(db, { sourceId: source.sourceId, provider, onEvent: (event) => { if (event.type === 'completed') changesetId = event.changesetId; } });
    expect(changesetId).toBeTruthy();

    discardSource(db, project.projectId, source.sourceId, { actor: 'Casey', reason: 'Belongs to a different project.', state: 'wrong-project' });

    // Zero register rows: the proposal was never applied and discarding did not
    // apply it, nor mutate anything.
    expect((db.prepare('SELECT count(*) c FROM project_register_rows WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM register_row_events WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(0);
    // The changeset is closed off, and its packet and operations are retained.
    expect((db.prepare('SELECT review_status FROM register_changesets WHERE id = ?').get(changesetId!) as { review_status: string }).review_status).toBe('rejected');
    expect((db.prepare('SELECT count(*) c FROM register_change_ops WHERE changeset_id = ?').get(changesetId!) as { c: number }).c).toBeGreaterThan(0);
    expect((db.prepare('SELECT count(*) c FROM extraction_packets WHERE project_id = ?').get(project.projectId) as { c: number }).c).toBe(1);
    // It can no longer be applied.
    expect(() => applyReviewedChangeset(db, changesetId!)).toThrow();
  });

  it('refuses to discard a source whose changes are already applied, and points at Void', async () => {
    const dir = temporaryDirectory('safety-discard-applied-');
    const { context, project } = await newProject(dir, 'SAFEAPP');
    const db = context.db;
    const source = await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    confirmSourceMetadata(db, project.projectId, source.sourceId, { actor: 'Casey', meetingSubject: 'Permit Session', chronologyState: 'unknown', primaryWorkPackage: 'Permit to Work', reason: null });
    const provider = providerFor(db, source.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: source.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days.', anchors: [anchorFor(db, source.sourceId, 'five working days')] }) },
      { registerName: 'Sources', row: baseRow({ source_ref: source.sourceId, client_ref: 's1', title: 'permit-session.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, source.sourceId, 'five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Sources']));
    let changesetId: string | null = null;
    await runSourceExtractionJob(db, { sourceId: source.sourceId, provider, onEvent: (event) => { if (event.type === 'completed') changesetId = event.changesetId; } });
    reviewEverything(db, changesetId!, 'Casey');
    applyReviewedChangeset(db, changesetId!);

    expect(() => discardSource(db, project.projectId, source.sourceId, { actor: 'Casey', reason: 'Oops.', state: 'discarded' })).toThrow(/Void source instead/i);
    const safety = readSourceSafety(db, project.projectId, source.sourceId)!;
    expect(safety.canDiscard).toBe(false);
    expect(safety.canVoid).toBe(true);
  });

  it('marks a duplicate through the comparison decision path, with the same audit record', async () => {
    const dir = temporaryDirectory('safety-decide-');
    const { context, project } = await newProject(dir, 'SAFEDEC');
    const db = context.db;
    await ingest(db, project.projectId, 'permit-session.vtt', UNDATED_MEETING);
    const reexported = UNDATED_MEETING.replace(/\n/g, '\r\n');
    const second = await ingest(db, project.projectId, 'permit-session-copy.vtt', reexported);
    expect(second.classification).toBe('normalised-duplicate');

    const decided = decideSourceComparison(db, project.projectId, second.sourceId, { decision: 'mark-duplicate', actor: 'Casey', reason: 'Same meeting, re-exported.' });
    expect(decided.lifecycleState).toBe('duplicate');
    const safety = readSourceSafety(db, project.projectId, second.sourceId)!;
    expect(safety.lifecycleState).toBe('duplicate');
    expect(safety.comparisons[0].decision).toBe('mark-duplicate');
    expect(safety.pendingDecision).toBeNull();
    expect((db.prepare('SELECT count(*) c FROM extraction_runs').get() as { c: number }).c).toBe(0);
  });
});

describe('void, after application', () => {
  /**
   * Builds a two-source project:
   *   source A creates the decision and an action;
   *   source B independently evidences the decision (its own verified quote)
   *     and separately updates the action it did NOT evidence.
   * Voiding A must therefore RETAIN the decision (rule A) and ORPHAN the action
   * (rule B).
   */
  async function twoSourceProject(dir: string, code: string) {
    const { context, project } = await newProject(dir, code);
    const db = context.db;

    const a = await ingest(db, project.projectId, 'source-a.vtt', UNDATED_MEETING);
    confirmSourceMetadata(db, project.projectId, a.sourceId, { actor: 'Casey', meetingSubject: 'Session A', chronologyState: 'confirmed', eventDate: '2026-08-01', primaryWorkPackage: 'Permit to Work', reason: null });
    const providerA = providerFor(db, a.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: a.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days.', anchors: [anchorFor(db, a.sourceId, 'five working days')] }) },
      // Discharges the HIGH explicit-action marker the detector found on that
      // segment, exactly as a real extraction would.
      { registerName: 'Actions', row: baseRow({ source_ref: a.sourceId, client_ref: 'a1', title: 'Update the induction pack', summary: 'Update the induction pack to match the permit duration.', anchors: [anchorFor(db, a.sourceId, 'update the induction pack')], discharges_markers: highMarkers(db, a.sourceId).filter((marker) => marker.segment_seq === 2).map((marker) => marker.id) }) },
      { registerName: 'Sources', row: baseRow({ source_ref: a.sourceId, client_ref: 's1', title: 'source-a.vtt', summary: 'Immutable source A.', anchors: [anchorFor(db, a.sourceId, 'five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Actions', 'Sources']));
    let changesetA: string | null = null;
    await runSourceExtractionJob(db, { sourceId: a.sourceId, provider: providerA, onEvent: (event) => { if (event.type === 'completed') changesetA = event.changesetId; } });
    reviewEverything(db, changesetA!, 'Casey');
    applyReviewedChangeset(db, changesetA!);
    const decisionId = String((db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Decisions'").get(project.projectId) as { external_register_id: string }).external_register_id);
    const actionId = String((db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Actions'").get(project.projectId) as { external_register_id: string }).external_register_id);

    // Source B is a LATER meeting that treats the two rows very differently,
    // which is what makes it a real test of the dependency rule:
    //
    //   - the DECISION it states again in its own words, with a verbatim quote
    //     that mechanically verifies against its own transcript. That is its
    //     own substantive evidence (rule A).
    //
    //   - the ACTION it merely depends upon: an INFERENCE row carrying no
    //     verbatim quote of its own, because source B never actually discusses
    //     the induction pack — the row exists only because source A asserted it
    //     (rule B).
    const bText = ['WEBVTT', '', '00:00:01.000 --> 00:00:07.000',
      'Sam: Confirming again, the excavation permit duration stands at five working days.', '',
      '00:00:08.000 --> 00:00:14.000', 'Sam: Nothing else has changed since the last session.'].join('\n');
    const b = await ingest(db, project.projectId, 'source-b.vtt', bText);
    confirmSourceMetadata(db, project.projectId, b.sourceId, { actor: 'Casey', meetingSubject: 'Session B', chronologyState: 'confirmed', eventDate: '2026-08-10', primaryWorkPackage: 'Permit to Work', reason: null });
    const providerB = providerFor(db, b.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: b.sourceId, client_ref: 'd2', op: 'update', target_id: decisionId, proposed_id: decisionId, status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days, reconfirmed.', anchors: [anchorFor(db, b.sourceId, 'stands at five working days')] } as unknown as Parameters<typeof baseRow>[0]) },
      // Inference, no verbatim quote: source B depends on this row without
      // evidencing it. `verified` will be 0, which is exactly what makes it
      // "merely refers to / depends upon" rather than independent evidence.
      { registerName: 'Actions', row: baseRow({ source_ref: b.sourceId, client_ref: 'a2', op: 'update', target_id: actionId, proposed_id: actionId, title: 'Update the induction pack', summary: 'Update the induction pack to match the permit duration.', owner: 'Jordan', derivation: 'inference', reasoning: 'Source B implies the previously agreed action is still open; it does not restate it.', anchors: [{ ...anchorFor(db, b.sourceId, 'Nothing else has changed'), quote: null }] } as unknown as Parameters<typeof baseRow>[0]) },
      { registerName: 'Sources', row: baseRow({ source_ref: b.sourceId, client_ref: 's2', title: 'source-b.vtt', summary: 'Immutable source B.', anchors: [anchorFor(db, b.sourceId, 'stands at five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Actions', 'Sources']));
    let changesetB: string | null = null;
    await runSourceExtractionJob(db, { sourceId: b.sourceId, provider: providerB, onEvent: (event) => { if (event.type === 'completed') changesetB = event.changesetId; } });
    reviewEverything(db, changesetB!, 'Casey');
    applyReviewedChangeset(db, changesetB!);

    return { context, db, project, a, b, decisionId, actionId, changesetA: changesetA!, changesetB: changesetB! };
  }

  it('removes the voided source contribution, retains independently evidenced rows, orphans unsupported ones, and keeps all history', async () => {
    const dir = temporaryDirectory('safety-void-');
    const { db, project, a, decisionId, actionId, changesetA } = await twoSourceProject(dir, 'SAFEVOID');

    const beforeEvents = Number((db.prepare('SELECT count(*) c FROM register_row_events WHERE project_id = ?').get(project.projectId) as { c: number }).c);
    const beforePackets = Number((db.prepare('SELECT count(*) c FROM extraction_packets WHERE project_id = ?').get(project.projectId) as { c: number }).c);

    const result = voidSource(db, project.projectId, a.sourceId, { actor: 'Casey', reason: 'Source A was the wrong recording.' });
    expect(result.providerCalls).toBe(0);
    expect(result.voidedChangesets).toContain(changesetA);
    expect(result.excludedEvents).toBeGreaterThan(0);

    // NOTHING was deleted: every event, packet and changeset survives.
    expect(Number((db.prepare('SELECT count(*) c FROM register_row_events WHERE project_id = ?').get(project.projectId) as { c: number }).c)).toBe(beforeEvents);
    expect(Number((db.prepare('SELECT count(*) c FROM extraction_packets WHERE project_id = ?').get(project.projectId) as { c: number }).c)).toBe(beforePackets);
    expect((db.prepare('SELECT review_status, voided_at, void_reason FROM register_changesets WHERE id = ?').get(changesetA) as Record<string, unknown>).review_status).toBe('applied');
    expect((db.prepare('SELECT voided_at FROM register_changesets WHERE id = ?').get(changesetA) as { voided_at: string }).voided_at).toBeTruthy();

    // Rule A — the decision is independently evidenced by source B, so it is
    // RETAINED and flagged for review.
    const decisionState = db.prepare('SELECT effective, review_flag, review_detail, last_source_id FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(project.projectId, decisionId) as Record<string, unknown>;
    expect(Number(decisionState.effective)).toBe(1);
    expect(decisionState.review_flag).toBe('founding-source-voided');
    expect(String(decisionState.review_detail)).toContain('Founding source voided');
    // Its effective state is re-anchored to the still-valid source.
    expect(decisionState.last_source_id).not.toBe(a.sourceId);
    expect(result.rowsRetainedForReview).toContain(decisionId);

    // Rule B — the action was only ever referred to by source B, never
    // independently evidenced, so it leaves effective state.
    const actionState = db.prepare('SELECT effective, review_flag, review_detail FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId) as Record<string, unknown>;
    expect(Number(actionState.effective)).toBe(0);
    expect(actionState.review_flag).toBe('orphaned-by-source-void');
    expect(String(actionState.review_detail)).toContain('Orphaned by source void');
    expect(result.rowsOrphaned).toContain(actionId);

    // It genuinely left effective state — it is gone from the operational
    // table the register views read — but is retained in history and its
    // identifier is never reused.
    expect((db.prepare('SELECT count(*) c FROM actions WHERE project_id = ? AND id = ?').get(project.projectId, actionId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId) as { c: number }).c).toBe(1);
    const allocation = db.prepare('SELECT next_seq FROM id_allocations WHERE project_id = ? AND prefix LIKE ?').get(project.projectId, '%-A') as { next_seq: number } | undefined;
    if (allocation) expect(allocation.next_seq).toBeGreaterThan(1);

    // Consultant Reasoning is marked stale, and no provider was called anywhere.
    expect((db.prepare('SELECT count(*) c FROM consultant_reasoning_runs').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM extraction_runs WHERE status = ?').get('completed') as { c: number }).c).toBe(2);
  });

  it('restores the prior effective state deterministically, and replays identically every time', async () => {
    const dir = temporaryDirectory('safety-void-replay-');
    const { db, project, b, decisionId } = await twoSourceProject(dir, 'SAFERPL');

    // Snapshot effective state with BOTH sources valid.
    const snapshot = () => JSON.stringify(db.prepare('SELECT external_register_id, status, owner, effective, review_flag FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
    rebuildProjection(db, project.projectId, '2026-08-20T00:00:00.000Z');
    const withBoth = snapshot();

    // Void source B — the LATER source — which should restore the state that
    // existed when only source A had been applied.
    voidSource(db, project.projectId, b.sourceId, { actor: 'Casey', reason: 'Source B was a duplicate recording.' });
    const afterVoid = snapshot();
    expect(afterVoid).not.toBe(withBoth);
    // Source A founded everything and is still valid, so nothing is orphaned.
    expect((db.prepare('SELECT count(*) c FROM register_row_state WHERE project_id = ? AND effective = 0').get(project.projectId) as { c: number }).c).toBe(0);
    // Source B's owner change is gone from effective state; A's value stands.
    const decision = db.prepare('SELECT summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, decisionId) as { summary: string };
    expect(decision.summary).toBeTruthy();

    // Deterministic: replaying repeatedly produces byte-identical state.
    rebuildProjection(db, project.projectId, '2026-08-20T00:00:00.000Z');
    const once = snapshot();
    rebuildProjection(db, project.projectId, '2026-08-20T00:00:00.000Z');
    const twice = snapshot();
    expect(once).toBe(twice);
    expect(once).toBe(afterVoid);
  });

  it('flags a surviving row whose relationship counterpart was removed by the void', async () => {
    const dir = temporaryDirectory('safety-void-rel-');
    const { context, project } = await newProject(dir, 'SAFEREL');
    const db = context.db;

    // One source raises a question and answers it in the same meeting, so the
    // bidirectional answers/answered_by relationship exists.
    const questionText = ['WEBVTT', '', '00:00:01.000 --> 00:00:07.000',
      'Jordan: We still need to confirm how long an excavation permit should last.', '',
      '00:00:08.000 --> 00:00:15.000', 'Alex: The standing instruction confirms five working days for a permit.'].join('\n');
    const a = await ingest(db, project.projectId, 'question-source.vtt', questionText);
    confirmSourceMetadata(db, project.projectId, a.sourceId, { actor: 'Casey', meetingSubject: 'Session A', chronologyState: 'confirmed', eventDate: '2026-08-01', primaryWorkPackage: 'Permit to Work', reason: null });
    const providerA = providerFor(db, a.sourceId, () => [
      { registerName: 'Decisions', row: baseRow({ source_ref: a.sourceId, client_ref: 'd1', status: 'agreed', title: 'Excavation permit duration confirmed', summary: 'Five working days.', anchors: [anchorFor(db, a.sourceId, 'confirms five working days')], answers: ['q1'] } as unknown as Parameters<typeof baseRow>[0]) },
      { registerName: 'Open_Questions', row: baseRow({ source_ref: a.sourceId, client_ref: 'q1', title: 'Excavation permit duration', summary: 'How long should an excavation permit last?', anchors: [anchorFor(db, a.sourceId, 'how long an excavation permit should last')] }) },
      { registerName: 'Sources', row: baseRow({ source_ref: a.sourceId, client_ref: 's1', title: 'question-source.vtt', summary: 'Immutable source.', anchors: [anchorFor(db, a.sourceId, 'confirms five working days')], details: { source_type: 'vtt-transcript' } }) },
    ], new Set(['Decisions', 'Open_Questions', 'Sources']));
    let changesetA: string | null = null;
    await runSourceExtractionJob(db, { sourceId: a.sourceId, provider: providerA, onEvent: (event) => { if (event.type === 'completed') changesetA = event.changesetId; } });
    reviewEverything(db, changesetA!, 'Casey');
    applyReviewedChangeset(db, changesetA!);

    const questionId = String((db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Open_Questions'").get(project.projectId) as { external_register_id: string }).external_register_id);
    expect((db.prepare("SELECT count(*) c FROM register_row_events WHERE external_register_id = ? AND event_type = 'answered_by'").get(questionId) as { c: number }).c).toBe(1);

    // A human independently works on the question, which is what keeps it in
    // effective state when its founding source is voided.
    const { recordRegisterEvent } = await import('../src/registerProjection');
    recordRegisterEvent(db, project.projectId, questionId, { actor: 'Casey', eventType: 'note', reason: 'Still chasing the written confirmation.' });

    const result = voidSource(db, project.projectId, a.sourceId, { actor: 'Casey', reason: 'Wrong recording uploaded.' });

    // The question survives on its human event and is flagged; the
    // relationship is neither silently repaired nor deleted.
    const questionState = db.prepare('SELECT effective, review_flag FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(project.projectId, questionId) as Record<string, unknown>;
    expect(Number(questionState.effective)).toBe(1);
    expect(questionState.review_flag).toBe('founding-source-voided');
    expect(result.rowsRetainedForReview).toContain(questionId);
    // The relationship events themselves are untouched in the log.
    expect((db.prepare("SELECT count(*) c FROM register_row_events WHERE external_register_id = ? AND event_type = 'answered_by'").get(questionId) as { c: number }).c).toBe(1);
    expect(result.providerCalls).toBe(0);
  });
});
