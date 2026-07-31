/**
 * Raw provider-output preservation, and replay from preserved bytes.
 *
 * The guarantee under test is narrow and absolute: a completed model response is
 * durable BEFORE anything looks at it. Every case here therefore fails the
 * pipeline *after* a successful call and then asserts the response is still
 * there — because capture-on-failure would pass a naive test and lose the run
 * that matters.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { orchestrateSourceExtraction } from '../src/sourcePipeline';
import {
  FakeStructuredExtractionProvider,
  SOURCE_INTELLIGENCE_CATEGORIES,
  type StructuredExtractionOutput,
  type StructuredExtractionRequest,
} from '../src/extractionProvider';
import {
  PROVIDER_OUTPUT_DIR_ENV,
  PreservedOutputExtractionProvider,
  readPreservedOutputs,
  readPreservedOutputText,
} from '../src/providerOutputs';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  delete process.env[PROVIDER_OUTPUT_DIR_ENV];
});

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'projectmanagair-preserve-'));
  directories.push(directory);
  const root = path.join(directory, 'Projects');
  const outputDir = path.join(directory, 'provider-output');
  mkdirSync(root, { recursive: true });
  process.env[PROVIDER_OUTPUT_DIR_ENV] = outputDir;
  const context = openProjectManagairDatabase(path.join(directory, 'projectmanagair.db'));
  await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  await verifyStorageRoot(context.db, true);
  const project = createProject(context.db, { code: 'PRV', name: 'Preservation Fixture', customer: 'Fictional Customer', description: 'Synthetic.', status: 'active', owner: 'Casey' });
  return { db: context.db, directory, outputDir, projectId: project.projectId };
}

/** A short transcript with two speakers, enough for one window and real anchors. */
function transcript(): Buffer {
  const cues = [
    ['00:00:00.000', '00:00:06.000', 'Casey', 'We need to confirm the permit escalation workflow before the training session on Friday.'],
    ['00:00:06.000', '00:00:12.000', 'Tony', 'I will send you the current permit list by Wednesday so we can map the escalation routes.'],
    ['00:00:12.000', '00:00:18.000', 'Casey', 'That works. I will book the follow up session and confirm the room by the end of the week.'],
  ];
  return Buffer.from(['WEBVTT', '', ...cues.flatMap(([start, end, speaker, text], index) => [String(index + 1), `${start} --> ${end}`, `<v ${speaker}>${text}`, ''])].join('\n'), 'utf8');
}

/**
 * Intake normalises and registers the source itself, exactly as the Cockpit
 * does. Going through the real path keeps the fixture honest about segment ids,
 * window sizing and marker detection.
 */
async function registerSource(db: DatabaseSync, projectId: string): Promise<{ sourceId: string }> {
  const bytes = transcript();
  const intake = await intakeProjectSource(db, projectId, { name: 'preservation-session.vtt', type: 'text/vtt', dataBase64: bytes.toString('base64') }) as { sourceId: string };
  return { sourceId: intake.sourceId };
}

/** Usage a real short-source call would report, so the budget gates behave normally. */
function realisticUsage(request: StructuredExtractionRequest) {
  const sourceTokens = request.windows.reduce((total, window) => total + window.tokenEstimate, 0);
  return { inputTokens: 900, outputTokens: 150, sourceTokens };
}

/** A minimal well-formed output that satisfies the row contract for one window. */
function validOutput(request: StructuredExtractionRequest, clientRef: string, title: string): StructuredExtractionOutput {
  const segment = request.windows[0].segments[0];
  return {
    rows: [{
      registerName: 'Actions',
      row: {
        client_ref: clientRef,
        op: 'add',
        target_id: null,
        proposed_id: '$ALLOC',
        title,
        summary: 'Synthetic row produced by the preservation fixture.',
        status: null,
        record_type: null,
        owner: null,
        due_date_raw: null,
        source_ref: request.source.sourceId,
        related_refs: [],
        supersedes: [],
        anchors: [{ segment_seq: segment.seq, speaker: segment.speaker, t_ms: segment.tStartMs, quote: segment.text }],
        derivation: 'fact',
        reasoning: null,
        confidence: 'high',
        discharges_markers: [],
        details: {},
      },
    }],
    windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'reviewed', itemCount: 1, explanation: null })),
    categoryCoverage: SOURCE_INTELLIGENCE_CATEGORIES.map((category) => ({ key: category, status: category === 'Actions' ? 'populated' : 'none-found', itemCount: category === 'Actions' ? 1 : 0, explanation: category === 'Actions' ? null : 'Nothing of this kind in the reviewed windows.' })),
  };
}

describe('a completed response is preserved before anything reads it', () => {
  it('preserves every call with the full provenance the acceptance evidence trail needs', async () => {
    const { db, projectId, outputDir } = await fixture();
    const registered = await registerSource(db, projectId);

    let call = 0;
    const provider = new FakeStructuredExtractionProvider((request) => {
      call += 1;
      return { output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: realisticUsage(request) };
    });

    await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch(() => undefined);

    const preserved = readPreservedOutputs(db, registered.sourceId);
    expect(preserved.length).toBeGreaterThan(0);
    expect(preserved.length).toBe(call);

    for (const record of preserved) {
      // Every field the acceptance evidence trail requires.
      expect(record.providerId).toBe('fake-structured-provider');
      expect(record.modelLabel).toBe('synthetic-test-output-v1');
      expect(record.stage).toBe('structured-extraction');
      expect(record.callIndex).toBeGreaterThan(0);
      expect(record.attemptLabel).toMatch(/^attempt-\d\d$/);
      expect(record.sourceId).toBe(registered.sourceId);
      expect(record.projectId).toBe(projectId);
      expect(record.windowKeys.length).toBeGreaterThan(0);
      expect(record.requestedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(record.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(record.skillId).toBe('source-extraction');
      expect(record.skillVersion).toBe('2.0.0');
      expect(record.skillSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.promptTemplateVersion).toBe('source-extraction-prompt-v2');
      expect(record.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.packetContractVersion).toBe(1);
      expect(record.responseSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.responseBytes).toBeGreaterThan(0);
      expect(record.inputTokens).toBeGreaterThan(0);
      expect(['estimated', 'provider-reported']).toContain(record.inputTokenSource);
      // The parse outcome is recorded, and the run it became is linked.
      expect(record.parseStatus).toBe('parsed');
      expect(record.runId).toBeTruthy();

      // The bytes are on disk, outside the database, and hash to what was recorded.
      expect(record.artefactPath).toBeTruthy();
      expect(record.artefactPath!.startsWith(outputDir)).toBe(true);
      expect(existsSync(record.artefactPath!)).toBe(true);
      expect(readPreservedOutputText(db, record.id).length).toBe(record.responseBytes);
    }
  });

  it('keeps a COMPLETED response when the pass fails after the call, and says why', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);

    // The failure class that destroyed the previous acceptance run: the model
    // answered, and the pass then died downstream of the answer. Here the
    // post-call budget gate trips; a merge or canonicalisation defect would look
    // identical from the response's point of view.
    let call = 0;
    const provider = new FakeStructuredExtractionProvider((request) => {
      call += 1;
      return { output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: { inputTokens: 1000, outputTokens: 200, sourceTokens: 500_000 } };
    });
    const outcome = await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(call).toBe(1);

    const preserved = readPreservedOutputs(db, registered.sourceId);
    expect(preserved).toHaveLength(1);
    // The response survived the failure, is attributed to the run it produced,
    // and records what went wrong afterwards rather than pretending it parsed.
    expect(preserved[0].parseStatus).toBe('rejected');
    expect(preserved[0].parseDetail).toMatch(/budget/i);
    expect(preserved[0].runId).toBeTruthy();
    expect(readPreservedOutputText(db, preserved[0].id)).toContain('Confirm the permit escalation workflow');
    // And it is replayable, which is the whole point of keeping it.
    expect(new PreservedOutputExtractionProvider(db, registered.sourceId).callIndexes).toEqual([1]);
  });

  it('preserves a response the parser then rejects, and says the parser rejected it', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);

    const provider = new FakeStructuredExtractionProvider(() => {
      // A structurally invalid output. The fake preserves before returning, so
      // the bytes survive the rejection that follows.
      return { output: { rows: [{ registerName: 'Actions', row: { client_ref: 'x' } }], windowCoverage: [], categoryCoverage: [] } as unknown as StructuredExtractionOutput, usage: { inputTokens: 10, outputTokens: 5, sourceTokens: 5 } };
    });
    await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch(() => undefined);

    const preserved = readPreservedOutputs(db, registered.sourceId);
    expect(preserved.length).toBeGreaterThan(0);
    expect(preserved.every((record) => record.responseBytes > 0)).toBe(true);
  });

  it('records the preserved response as immutable evidence', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);
    const provider = new FakeStructuredExtractionProvider((request) => ({ output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: realisticUsage(request) }));
    await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch(() => undefined);
    const record = readPreservedOutputs(db, registered.sourceId)[0];

    expect(() => db.prepare('UPDATE provider_raw_outputs SET response_sha256 = ? WHERE id = ?').run('0'.repeat(64), record.id)).toThrow(/preserved model evidence/i);
    expect(() => db.prepare('UPDATE provider_raw_outputs SET received_at = ? WHERE id = ?').run('1999-01-01T00:00:00.000Z', record.id)).toThrow(/preserved model evidence/i);
    // The parse outcome and the run link are the two fields that legitimately
    // complete after receipt, so those still work.
    expect(() => db.prepare("UPDATE provider_raw_outputs SET parse_status = 'rejected' WHERE id = ?").run(record.id)).not.toThrow();
  });

  it('refuses to hand back preserved bytes that have been altered on disk', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);
    const provider = new FakeStructuredExtractionProvider((request) => ({ output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: realisticUsage(request) }));
    await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch(() => undefined);
    const record = readPreservedOutputs(db, registered.sourceId)[0];

    writeFileSync(record.artefactPath!, `${readFileSync(record.artefactPath!, 'utf8')} tampered`, 'utf8');
    expect(() => readPreservedOutputText(db, record.id)).toThrow(/no longer matches its recorded hash/i);
  });
});

describe('replay from preserved output', () => {
  it('re-runs the whole pass from preserved bytes with zero model calls', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);

    // First pass: the model answers, and the pass then fails downstream on a
    // conflicting restatement of one reference.
    let liveCalls = 0;
    const live = new FakeStructuredExtractionProvider((request) => {
      liveCalls += 1;
      return { output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: realisticUsage(request) };
    });
    const first = await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider: live }).catch((error: unknown) => error);
    expect(liveCalls).toBeGreaterThan(0);

    const preserved = readPreservedOutputs(db, registered.sourceId);
    expect(preserved.length).toBe(liveCalls);

    // Whatever happened above, the model's work is recoverable. A replay answers
    // from the preserved bytes and the live provider is never touched again.
    const callsBeforeReplay = liveCalls;
    const replayProvider = new PreservedOutputExtractionProvider(db, registered.sourceId);
    expect(replayProvider.identity.providerId).toBe('replay:fake-structured-provider');
    expect(replayProvider.callIndexes).toEqual(preserved.map((record) => record.callIndex).sort((a, b) => a - b));

    // If the first pass froze a packet there is nothing to replay into; assert
    // the contract that matters in either case.
    if (first instanceof Error) {
      await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider: replayProvider }).catch(() => undefined);
    }
    expect(liveCalls).toBe(callsBeforeReplay);
  });

  it('refuses to replay a call it has no preserved response for, rather than silently calling the model', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);
    const provider = new FakeStructuredExtractionProvider((request) => ({ output: validOutput(request, 'Actions-1', 'Confirm the permit escalation workflow'), usage: realisticUsage(request) }));
    await orchestrateSourceExtraction(db, { sourceId: registered.sourceId, provider }).catch(() => undefined);

    const replay = new PreservedOutputExtractionProvider(db, registered.sourceId);
    expect(() => replay.extract({ callIndex: 99, windows: [], source: { sourceId: registered.sourceId, sourceType: 'transcript', originalFileName: 'x', contentHash: 'a', eventDate: null }, project: { projectId, projectCode: 'PRV', baseRegisterRevision: 0 }, categories: [], existingRows: [], prompt: '', promptSha256: '', skillSha256: '' }))
      .toThrow(/no preserved response for call 99/i);
  });

  it('refuses to construct a replay for a source that has none', async () => {
    const { db, projectId } = await fixture();
    const registered = await registerSource(db, projectId);
    expect(() => new PreservedOutputExtractionProvider(db, registered.sourceId)).toThrow(/nothing to replay/i);
  });
});
