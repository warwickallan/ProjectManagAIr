import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import {
  FakeStructuredExtractionProvider,
  ProviderError,
  type ProviderErrorKind,
  type SourcePacketRow,
  type StructuredExtractionRequest,
  type StructuredExtractionResult,
} from '../src/extractionProvider';
import { confirmSourceMetadata, createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import {
  WatchedInboxScanner,
  retrySourceJob,
  runSourceExtractionJob,
  sourceJobId,
  startSourceJobSweeper,
  sweepStalledSourceJobs,
  type SourcePipelineEvent,
  type WatchedInboxEvent,
} from '../src/sourcePipeline';

const temporaryDirectories: string[] = [];
const openDatabases: Array<{ db: DatabaseSync }> = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.db.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

interface Harness {
  db: DatabaseSync;
  projectId: string;
  ingest: (name: string, text: string) => Promise<{ sourceId: string; intakeId: string; jobId: string; contentHash: string }>;
}

async function harness(prefix = 'projectmanagair-recovery-'): Promise<Harness> {
  const directory = temporaryDirectory(prefix);
  const projectsRoot = path.join(directory, 'Projects');
  mkdirSync(projectsRoot, { recursive: true });
  const context = openProjectManagairDatabase(path.join(directory, 'recovery.db'));
  openDatabases.push(context);
  await updateStorageSettings(context.db, { projectsRoot });
  const project = createProject(context.db, {
    code: 'REC',
    name: 'Synthetic Recovery',
    customer: 'Synthetic Customer',
    description: 'Synthetic recovery fixture.',
    status: 'on-track',
    owner: 'Tester',
  });
  return {
    db: context.db,
    projectId: project.projectId,
    ingest: async (name, text) => {
      const intake = await intakeProjectSource(context.db, project.projectId, {
        name,
        dataBase64: Buffer.from(text, 'utf8').toString('base64'),
      }) as unknown as { sourceId: string; intakeSourceId: string };
      const row = context.db.prepare('SELECT content_hash, intake_source_id FROM source_documents WHERE id = ?').get(intake.sourceId) as { content_hash: string; intake_source_id: string };
      confirmSourceMetadata(context.db, project.projectId, intake.sourceId, {
        actor: 'tester',
        meetingSubject: `Synthetic meeting for ${name}`,
        eventDate: '2026-01-01',
        primaryWorkPackage: 'General',
      });
      return {
        sourceId: intake.sourceId,
        intakeId: String(row.intake_source_id),
        jobId: sourceJobId(project.projectId, String(row.content_hash)),
        contentHash: String(row.content_hash),
      };
    },
  };
}

function jobRow(db: DatabaseSync, jobId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM source_processing_jobs WHERE id = ?').get(jobId) as Record<string, unknown>;
}

function intakeRow(db: DatabaseSync, intakeId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM project_source_intake WHERE id = ?').get(intakeId) as Record<string, unknown>;
}

function packetRow(sourceId: string, text: string, recordType: 'action' | 'source'): SourcePacketRow {
  return {
    client_ref: `${recordType}-1`,
    op: 'add',
    target_id: null,
    proposed_id: '$ALLOC',
    title: recordType === 'action' ? 'Follow up with the synthetic owner' : 'Synthetic source note',
    summary: 'Follow up with the synthetic owner',
    status: 'open',
    record_type: recordType,
    owner: null,
    due_date_raw: null,
    source_ref: sourceId,
    related_refs: [],
    supersedes: [],
    anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: text }],
    derivation: 'fact',
    reasoning: null,
    confidence: 'high',
    discharges_markers: [],
    details: recordType === 'source' ? { source_type: 'text-note' } : {},
  };
}

/** A deterministic provider that never touches a model: it returns a valid, anchored packet. */
function goodProvider(text: string, onCall?: () => void) {
  return new FakeStructuredExtractionProvider((request: StructuredExtractionRequest): StructuredExtractionResult => {
    onCall?.();
    return {
      output: {
        rows: [
          { registerName: 'Actions', row: packetRow(request.source.sourceId, text, 'action') },
          { registerName: 'Sources', row: packetRow(request.source.sourceId, text, 'source') },
        ],
        windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'populated', itemCount: 2, explanation: null })),
        categoryCoverage: request.categories.map((key) => ({
          key,
          status: key === 'Actions' || key === 'Sources' ? 'populated' : 'none-found',
          itemCount: key === 'Actions' || key === 'Sources' ? 1 : 0,
          explanation: key === 'Actions' || key === 'Sources' ? null : `No ${key} found in the synthetic source.`,
        })),
      },
      usage: { inputTokens: 100, outputTokens: 40, sourceTokens: 10, inputTokenSource: 'provider-reported', outputTokenSource: 'estimated' },
    };
  });
}

function throwingProvider(kind: ProviderErrorKind, headline: string, onCall?: () => void) {
  return new FakeStructuredExtractionProvider(() => {
    onCall?.();
    throw new ProviderError({
      kind,
      providerId: 'fake-structured-provider',
      headline,
      command: 'fake --extract',
      exitCode: 1,
      stdout: '{"error":"synthetic"}',
      stderr: headline,
    });
  });
}

const SOURCE_TEXT = 'Follow up with the synthetic owner.';

describe('source job crash recovery', () => {
  it('reclaims a job whose lease expired and leaves a live lease alone', async () => {
    const context = await harness();
    const stalled = await context.ingest('stalled-note.txt', 'Stalled synthetic source about the owner.');
    const healthy = await context.ingest('healthy-note.txt', 'Healthy synthetic source about the owner.');
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 600_000).toISOString();
    context.db.prepare("UPDATE source_processing_jobs SET status = 'processing', current_stage = 'extracting', attempt_count = 1, max_attempts = 2, lease_owner = 'worker:dead', lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(past, past, stalled.jobId);
    context.db.prepare("UPDATE source_processing_jobs SET status = 'processing', current_stage = 'extracting', attempt_count = 1, max_attempts = 2, lease_owner = 'worker:alive', lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(future, past, healthy.jobId);

    const reclaimed = sweepStalledSourceJobs(context.db);

    expect(reclaimed.map((entry) => entry.jobId)).toEqual([stalled.jobId]);
    expect(reclaimed[0]).toMatchObject({ action: 'requeued', attemptCount: 1, maxAttempts: 2 });
    const reclaimedJob = jobRow(context.db, stalled.jobId);
    expect(reclaimedJob).toMatchObject({ status: 'queued', current_stage: 'reclaimed', lease_owner: null, lease_expires_at: null });
    expect(String(reclaimedJob.error_message)).toMatch(/stopped without completing/i);
    expect(String(reclaimedJob.recovery_action)).toMatch(/attempt 2 of 2/);
    expect(intakeRow(context.db, stalled.intakeId)).toMatchObject({ processing_status: 'awaiting_processing', processing_stage: 'reclaimed' });

    expect(jobRow(context.db, healthy.jobId)).toMatchObject({ status: 'processing', lease_owner: 'worker:alive' });
  });

  it('quarantines a reclaimed job whose retry budget is already spent', async () => {
    const context = await harness();
    const stalled = await context.ingest('spent-note.txt', 'Spent synthetic source about the owner.');
    const past = new Date(Date.now() - 60_000).toISOString();
    context.db.prepare("UPDATE source_processing_jobs SET status = 'processing', attempt_count = 2, max_attempts = 2, lease_owner = 'worker:dead', lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(past, past, stalled.jobId);

    const reclaimed = sweepStalledSourceJobs(context.db);

    expect(reclaimed[0]).toMatchObject({ action: 'quarantined' });
    const job = jobRow(context.db, stalled.jobId);
    expect(job).toMatchObject({ status: 'quarantined', current_stage: 'quarantined', error_kind: 'transient' });
    expect(String(job.recovery_action)).toMatch(/retry this source from the quarantine lane/i);
    expect(intakeRow(context.db, stalled.intakeId)).toMatchObject({ processing_status: 'failed', processing_stage: 'quarantined' });
  });

  it('sweeps once at startup, reports what it reclaimed, and leaves queued jobs alone', async () => {
    const context = await harness();
    const stalled = await context.ingest('startup-note.txt', 'Startup synthetic source about the owner.');
    const queued = await context.ingest('queued-note.txt', 'Queued synthetic source about the owner.');
    const past = new Date(Date.now() - 60_000).toISOString();
    context.db.prepare("UPDATE source_processing_jobs SET status = 'processing', attempt_count = 0, lease_owner = 'worker:dead', lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(past, past, stalled.jobId);
    context.db.prepare("UPDATE source_processing_jobs SET status = 'queued', current_stage = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(past, queued.jobId);

    const reported: string[] = [];
    const sweeper = startSourceJobSweeper(context.db, { intervalMs: 3_600_000, onReclaim: (jobs) => reported.push(...jobs.map((job) => `${job.action}:${job.jobId}`)) });
    try {
      expect(reported).toEqual([`requeued:${stalled.jobId}`]);
      expect(jobRow(context.db, queued.jobId)).toMatchObject({ status: 'queued', current_stage: 'queued', error_message: null });
      expect(sweeper.sweepNow()).toEqual([]);
    } finally {
      sweeper.stop();
    }
  });

  it('does not reclaim a job the current process has just claimed', async () => {
    const context = await harness();
    const source = await context.ingest('claimed-note.txt', 'Claimed synthetic source about the owner.');
    let calls = 0;
    const provider = new FakeStructuredExtractionProvider(async (request) => {
      calls += 1;
      // The sweep runs while the provider call is in flight, exactly as the periodic timer would.
      expect(sweepStalledSourceJobs(context.db)).toEqual([]);
      return goodProvider(SOURCE_TEXT).extract(request);
    });

    const result = await runSourceExtractionJob(context.db, { sourceId: source.sourceId, provider, onEvent: () => undefined });

    expect(calls).toBe(1);
    expect(result.status).toBe('completed');
  });
});

describe('bounded retry', () => {
  it('increments attempts, stops at max_attempts and records why with a recovery action', async () => {
    const context = await harness();
    const source = await context.ingest('transient-note.txt', SOURCE_TEXT);
    let calls = 0;
    const provider = throwingProvider('transient', 'The provider timed out.', () => { calls += 1; });
    const events: SourcePipelineEvent[] = [];

    const result = await runSourceExtractionJob(context.db, {
      sourceId: source.sourceId,
      provider,
      maxAttempts: 3,
      onEvent: (event) => events.push(event),
    });

    expect(calls).toBe(3);
    expect(result).toMatchObject({ ok: false, status: 'quarantined', kind: 'transient', attempts: 3 });
    const job = jobRow(context.db, source.jobId);
    expect(job).toMatchObject({ status: 'quarantined', current_stage: 'quarantined', attempt_count: 3, max_attempts: 3, error_kind: 'transient', lease_owner: null });
    expect(String(job.error_message)).toMatch(/timed out/i);
    expect(String(job.recovery_action)).toMatch(/retry budget \(attempt 3 of 3\) is spent/i);
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'failed' && event.willRetry)).toHaveLength(2);
    const runs = context.db.prepare("SELECT status FROM extraction_runs WHERE source_id = ?").all(source.sourceId) as Array<{ status: string }>;
    expect(runs.filter((run) => run.status === 'failed')).toHaveLength(3);
  });

  it.each<[ProviderErrorKind, RegExp]>([
    ['cli-too-old', /upgrade/i],
    ['model-unsupported', /model/i],
  ])('never retries %s', async (kind, recoveryPattern) => {
    const context = await harness();
    const source = await context.ingest(`${kind}-note.txt`, SOURCE_TEXT);
    let calls = 0;
    const provider = throwingProvider(kind, `Synthetic ${kind} failure.`, () => { calls += 1; });

    const result = await runSourceExtractionJob(context.db, {
      sourceId: source.sourceId,
      provider,
      maxAttempts: 4,
      onEvent: () => undefined,
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, status: 'quarantined', kind, attempts: 1 });
    const job = jobRow(context.db, source.jobId);
    expect(job).toMatchObject({ status: 'quarantined', attempt_count: 1, error_kind: kind });
    expect(String(job.recovery_action)).toMatch(recoveryPattern);
    expect(String(job.recovery_action)).toMatch(/will fail identically/i);
  });
});

describe('failure visibility', () => {
  it('writes a readable error, kind, structured detail and recovery action to both the job row and the intake row', async () => {
    const context = await harness();
    const source = await context.ingest('auth-note.txt', SOURCE_TEXT);
    const provider = throwingProvider('auth', 'Not logged in; run the provider login command.');

    const result = await runSourceExtractionJob(context.db, { sourceId: source.sourceId, provider, maxAttempts: 2, onEvent: () => undefined });

    expect(result.status).toBe('quarantined');
    const job = jobRow(context.db, source.jobId);
    expect(job.status).toBe('quarantined');
    expect(job.error_kind).toBe('auth');
    expect(String(job.error_message)).toMatch(/Not logged in/);
    expect(String(job.recovery_action)).toMatch(/Sign in to .*then retry this source/i);
    expect(job.last_error_at).toBeTruthy();
    const detail = JSON.parse(String(job.error_detail_json)) as Record<string, unknown>;
    expect(detail).toMatchObject({ kind: 'auth', providerId: 'fake-structured-provider', exitCode: 1 });
    expect(String(detail.stderr)).toMatch(/Not logged in/);

    const intake = intakeRow(context.db, source.intakeId);
    expect(intake.processing_status).toBe('failed');
    expect(intake.processing_stage).toBe('quarantined');
    expect(String(intake.processing_error)).toMatch(/Not logged in/);
    expect(String(intake.processing_recovery_action)).toMatch(/Sign in to/i);
    expect(intake.processing_updated_at).toBeTruthy();
  });

  it('quarantines malformed provider output instead of leaving the job in processing', async () => {
    const context = await harness();
    const nullRows = await context.ingest('null-rows.txt', SOURCE_TEXT);
    // The shape a CLI actually produced: `{"rows": null}` cast straight to the output type.
    const castingProvider = new FakeStructuredExtractionProvider((request) => ({
      output: { rows: null, windowCoverage: null, categoryCoverage: [] } as never,
      usage: { inputTokens: 10, outputTokens: 0, sourceTokens: request.windows.length },
    }));

    const castResult = await runSourceExtractionJob(context.db, { sourceId: nullRows.sourceId, provider: castingProvider, maxAttempts: 1, onEvent: () => undefined });

    expect(castResult.ok).toBe(false);
    const castJob = jobRow(context.db, nullRows.jobId);
    expect(castJob.status).toBe('quarantined');
    expect(castJob.current_stage).toBe('quarantined');
    expect(String(castJob.error_message).length).toBeGreaterThan(0);
    expect(String(castJob.recovery_action).length).toBeGreaterThan(0);
    expect(intakeRow(context.db, nullRows.intakeId).processing_status).toBe('failed');

    // The current providers validate with zod and raise a typed malformed-output error.
    const typed = await context.ingest('malformed.txt', 'A different synthetic source about the owner.');
    const events: SourcePipelineEvent[] = [];
    const typedResult = await runSourceExtractionJob(context.db, {
      sourceId: typed.sourceId,
      provider: throwingProvider('malformed-output', 'rows: expected array, received null'),
      maxAttempts: 2,
      onEvent: (event) => events.push(event),
    });

    expect(typedResult).toMatchObject({ ok: false, status: 'quarantined', kind: 'malformed-output' });
    const typedJob = jobRow(context.db, typed.jobId);
    expect(typedJob).toMatchObject({ status: 'quarantined', error_kind: 'malformed-output', attempt_count: 2 });
    expect(String(typedJob.recovery_action)).toMatch(/error_detail_json/);
    expect(events.some((event) => event.type === 'failed' && /expected array/.test(event.message))).toBe(true);
  });

  it('records whether each token count was provider-reported or estimated', async () => {
    const context = await harness();
    const source = await context.ingest('tokens.txt', SOURCE_TEXT);

    const result = await runSourceExtractionJob(context.db, { sourceId: source.sourceId, provider: goodProvider(SOURCE_TEXT), onEvent: () => undefined });

    expect(result.status).toBe('completed');
    const run = context.db.prepare('SELECT input_token_source, output_token_source FROM extraction_runs WHERE source_id = ?').get(source.sourceId) as Record<string, unknown>;
    expect(run).toMatchObject({ input_token_source: 'provider-reported', output_token_source: 'estimated' });
    expect(intakeRow(context.db, source.intakeId)).toMatchObject({ processing_status: 'awaiting_review', processing_stage: 'awaiting_review' });
  });
});

describe('replay safety', () => {
  it('retrying a job whose packet is already frozen performs zero provider calls', async () => {
    const context = await harness();
    const source = await context.ingest('frozen.txt', SOURCE_TEXT);
    const first = await runSourceExtractionJob(context.db, { sourceId: source.sourceId, provider: goodProvider(SOURCE_TEXT), onEvent: () => undefined });
    expect(first.status).toBe('completed');
    const packetsBefore = context.db.prepare('SELECT COUNT(*) AS total FROM extraction_packets WHERE source_id = ?').get(source.sourceId) as { total: number };

    let calls = 0;
    const retry = await retrySourceJob(context.db, {
      sourceId: source.sourceId,
      provider: goodProvider(SOURCE_TEXT, () => { calls += 1; }),
      onEvent: () => undefined,
    });

    expect(calls).toBe(0);
    expect(retry).toMatchObject({ ok: true, status: 'already-frozen', providerCalls: 0 });
    expect(context.db.prepare('SELECT COUNT(*) AS total FROM extraction_packets WHERE source_id = ?').get(source.sourceId)).toEqual(packetsBefore);
    expect(jobRow(context.db, source.jobId)).toMatchObject({ status: 'awaiting_review', lease_owner: null });
  });

  it('retries a quarantined job from stored segments with no re-upload and without stealing a live lease', async () => {
    const context = await harness();
    const source = await context.ingest('recoverable.txt', SOURCE_TEXT);
    const failed = await runSourceExtractionJob(context.db, {
      sourceId: source.sourceId,
      provider: throwingProvider('transient', 'Synthetic outage.'),
      maxAttempts: 1,
      onEvent: () => undefined,
    });
    expect(failed.status).toBe('quarantined');

    const live = new Date(Date.now() + 600_000).toISOString();
    context.db.prepare("UPDATE source_processing_jobs SET status = 'processing', lease_owner = 'worker:other', lease_expires_at = ? WHERE id = ?").run(live, source.jobId);
    const blocked = await retrySourceJob(context.db, { sourceId: source.sourceId, provider: goodProvider(SOURCE_TEXT), onEvent: () => undefined });
    expect(blocked.status).toBe('lease-held');

    context.db.prepare('UPDATE source_processing_jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?').run(source.jobId);
    const retried = await retrySourceJob(context.db, { sourceId: source.sourceId, provider: goodProvider(SOURCE_TEXT), onEvent: () => undefined });

    expect(retried).toMatchObject({ ok: true, status: 'completed' });
    const job = jobRow(context.db, source.jobId);
    expect(job).toMatchObject({ status: 'awaiting_review', attempt_count: 1, error_message: null, lease_owner: null });
    expect(intakeRow(context.db, source.intakeId)).toMatchObject({ processing_status: 'awaiting_review' });
  });
});

describe('watched Inbox resilience', () => {
  it('bounds enqueue retries after a failure and reports every failure on the event stream', async () => {
    const root = temporaryDirectory('projectmanagair-watch-fail-');
    writeFileSync(path.join(root, 'broken.txt'), 'Synthetic bytes that cannot be enqueued.', 'utf8');
    let time = 0;
    let attempts = 0;
    const events: WatchedInboxEvent[] = [];
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: root,
      stabilityMs: 0,
      minimumStableScans: 2,
      failureBackoffMs: 1_000,
      maxEnqueueAttempts: 3,
      now: () => time,
      enqueue: async () => {
        attempts += 1;
        throw new Error('Projects root is not configured.');
      },
    });

    for (let scan = 0; scan < 40; scan += 1) {
      time = scan * 100;
      events.push(...await scanner.scan());
    }

    expect(attempts).toBe(3);
    const failures = events.filter((event) => event.status === 'failed');
    expect(failures).toHaveLength(3);
    expect(failures[0].detail).toMatch(/attempt 1 of 3.*Projects root is not configured/s);
    expect(failures[2].detail).toMatch(/no further attempts will be made/i);
    expect(events.filter((event) => event.status === 'abandoned')).toHaveLength(1);
    expect(events.some((event) => event.status === 'unstable' && /Backing off/.test(event.detail ?? ''))).toBe(true);
    expect(events.filter((event) => event.status === 'enqueued')).toHaveLength(0);
  });

  it('never files a stalled writer\'s truncated document, and enqueues the finished file exactly once', async () => {
    const root = temporaryDirectory('projectmanagair-watch-partial-');
    const target = path.join(root, 'slow-copy.docx');
    // A .docx is a ZIP: a copy interrupted mid-transfer has no end-of-central-directory
    // record. The stall lasts several polls, so every timing-based rule is satisfied.
    const truncated = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2_048, 7)]);
    const completeDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18, 0)]);
    writeFileSync(target, truncated);
    let time = 0;
    const enqueued: number[] = [];
    const events: WatchedInboxEvent[] = [];
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: root,
      stabilityMs: 100,
      minimumStableScans: 2,
      now: () => time,
      enqueue: async (_projectId, file) => {
        enqueued.push(Buffer.from(file.dataBase64, 'base64').length);
        return { duplicate: false, sourceId: 'synthetic-source' };
      },
    });

    for (let scan = 0; scan < 8; scan += 1) {
      time = scan * 200;
      events.push(...await scanner.scan());
    }
    expect(enqueued).toEqual([]);
    const refusals = events.filter((event) => event.status === 'failed');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].detail).toMatch(/Refused as an incomplete source: the ZIP end-of-central-directory record is missing/);

    // The writer resumes and completes the file; the watcher re-opens the question.
    writeFileSync(target, completeDocx);
    for (let scan = 8; scan < 16; scan += 1) {
      time = scan * 200;
      events.push(...await scanner.scan());
    }

    expect(enqueued).toEqual([completeDocx.length]);
    expect(events.filter((event) => event.status === 'enqueued')).toHaveLength(1);
  });

  it('refuses a transcript truncated inside a cue and accepts it once the writer finishes', async () => {
    const root = temporaryDirectory('projectmanagair-watch-vtt-');
    const target = path.join(root, 'meeting.vtt');
    writeFileSync(target, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n', 'utf8');
    let time = 0;
    const enqueued: string[] = [];
    const events: WatchedInboxEvent[] = [];
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: root,
      stabilityMs: 0,
      minimumStableScans: 2,
      now: () => time,
      enqueue: async (_projectId, file) => {
        enqueued.push(Buffer.from(file.dataBase64, 'base64').toString('utf8'));
        return { duplicate: false, sourceId: 'synthetic-source' };
      },
    });

    for (let scan = 0; scan < 6; scan += 1) {
      time = scan * 100;
      events.push(...await scanner.scan());
    }
    expect(enqueued).toEqual([]);
    expect(events.some((event) => event.status === 'failed' && /cue-timing line/.test(event.detail ?? ''))).toBe(true);

    const complete = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Tester>Synthetic line.\n';
    writeFileSync(target, complete, 'utf8');
    for (let scan = 6; scan < 12; scan += 1) {
      time = scan * 100;
      events.push(...await scanner.scan());
    }
    expect(enqueued).toEqual([complete]);
  });

  it('keeps polling an inbox path that does not exist yet and starts ingesting when it appears', async () => {
    const root = temporaryDirectory('projectmanagair-watch-late-');
    const inbox = path.join(root, '00_Inbox', 'Unsorted');
    let time = 0;
    const enqueued: string[] = [];
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: inbox,
      stabilityMs: 0,
      minimumStableScans: 2,
      now: () => time,
      enqueue: async (_projectId, file) => {
        enqueued.push(file.name);
        return { duplicate: false, sourceId: 'synthetic-source' };
      },
    });

    const missing = await scanner.scan();
    expect(missing).toHaveLength(1);
    expect(missing[0].status).toBe('inbox-missing');
    expect(scanner.inboxAvailable).toBe(false);
    time = 100;
    expect(await scanner.scan()).toEqual([]);

    mkdirSync(inbox, { recursive: true });
    writeFileSync(path.join(inbox, 'late-note.txt'), 'Synthetic note that arrived after the mount.', 'utf8');
    time = 200;
    const ready = await scanner.scan();
    expect(ready[0].status).toBe('inbox-ready');
    expect(scanner.inboxAvailable).toBe(true);
    time = 300;
    await scanner.scan();
    time = 400;
    await scanner.scan();
    expect(enqueued).toEqual(['late-note.txt']);
  });
});
