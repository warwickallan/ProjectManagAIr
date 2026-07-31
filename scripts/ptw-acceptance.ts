/**
 * The governed PTW acceptance run.
 *
 * ONE run, against a COPY of the live database, using the currently published
 * Project Source Extraction revision and the configured structured-extraction
 * provider. Its job is to establish an honest baseline for that revision, not to
 * reach a number: no prompt, skill, benchmark or validation change is permitted
 * while it is running, and a failing result is reported rather than tuned away.
 *
 * Everything it produces is evidence:
 *   - every raw provider response, preserved before parsing (migration 013);
 *   - the frozen packet and its changeset, left UNAPPLIED for human review;
 *   - a deterministic replay, proving zero further provider calls;
 *   - a comparison against the sealed benchmark;
 *   - a benchmark record against the exact skill version that produced it.
 *
 * Usage:
 *   tsx scripts/ptw-acceptance.ts --db <copy.db> --project-code <CODE> \
 *     --source <transcript.vtt> --benchmark <sealed.json> [--workbook <sealed.xlsx>] \
 *     [--benchmark-label "..."] \
 *     [--provider claude|synthetic] [--model opus] [--event-date 2026-07-10] \
 *     [--wall-clock-minutes 45] [--assert-proposal-unchanged <id>] [--replay-only] \
 *     --out <report.json>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openProjectManagairDatabase } from '../src/db.js';
import { compareBlindExtractionToBenchmark } from '../src/blindExtractionComparison.js';
import { ClaudeCodeStructuredExtractionProvider, FakeStructuredExtractionProvider, SOURCE_INTELLIGENCE_CATEGORIES, type StructuredExtractionOutput, type StructuredExtractionRequest, type StructuredExtractionProvider } from '../src/extractionProvider.js';
import { renormalizeSource, replayPacket } from '../src/sourceIntelligence.js';
import { runSourceExtractionJob } from '../src/sourcePipeline.js';
import { PreservedOutputExtractionProvider, readPreservedOutputs, resolveProviderOutputDir } from '../src/providerOutputs.js';
import { ensureSkillRegistrySynced, readSkillRevisions, recordSkillBenchmark, resolveSkillForRun } from '../src/skillRegistry.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const dbPath = path.resolve(arg('db'));
const sourcePath = path.resolve(arg('source'));
const benchmarkPath = path.resolve(arg('benchmark'));
const workbookPath = arg('workbook', '') ? path.resolve(arg('workbook', '')) : null;
const outPath = path.resolve(arg('out'));
const providerKind = arg('provider', 'synthetic');
// The project code and the benchmark label are arguments, never literals: this
// script is tracked by Git and the data boundary forbids naming a customer or
// their artefacts in the repository.
const projectCode = arg('project-code');
const benchmarkLabel = arg('benchmark-label', 'Sealed benchmark (benchmark-informed acceptance)');
/**
 * A pre-existing proposal this run must leave untouched, named by the operator.
 * Passed in rather than hard-coded for the same reason as the project code: the
 * identifier embeds the customer's project id, and the repository must not carry
 * it.
 */
const untouchedProposalId = arg('assert-proposal-unchanged', '');
const model = arg('model', 'opus');
const eventDate = arg('event-date', '2026-07-10');
const wallClockMinutes = Number(arg('wall-clock-minutes', '45'));
const replayOnly = flag('replay-only');

const outputDir = resolveProviderOutputDir();
mkdirSync(outputDir, { recursive: true });

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  dbPath,
  providerOutputDir: outputDir,
  providerKind,
  model: providerKind === 'claude' ? model : null,
  eventDateHint: eventDate,
  wallClockBudgetMinutes: wallClockMinutes,
  replayOnly,
};

const context = openProjectManagairDatabase(dbPath);
const db = context.db;
report.migrationsAppliedNow = context.migrationsApplied;
ensureSkillRegistrySynced(db);

/* ---------------------------------------------------------------- the source */

const project = db.prepare('SELECT id, code FROM projects WHERE code = ?').get(projectCode) as { id: string; code: string };
if (!project) throw new Error(`This database has no project with code ${projectCode}.`);

const bytes = readFileSync(sourcePath);
let sourceId: string;
const existing = db.prepare('SELECT id, normaliser_version FROM source_documents WHERE project_id = ? ORDER BY created_at').all(project.id) as Array<{ id: string; normaliser_version: string }>;
report.sourceDocumentsBefore = existing;

if (replayOnly) {
  sourceId = existing.at(-1)!.id;
} else {
  const stale = existing.find((row) => row.normaliser_version !== 'source-normaliser-v2') ?? existing[0];
  if (!stale) throw new Error('No registered source document to re-normalise.');
  // The stored evidence was produced by the v1 normaliser, which discarded every
  // Teams speaker. Re-normalisation is refused once any changeset from a source
  // has been applied; none has.
  const renormalized = renormalizeSource(db, stale.id, { bytes, eventDate });
  sourceId = renormalized.sourceId;
  report.renormalisation = renormalized;
}
report.sourceId = sourceId;

const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(sourceId) as Record<string, unknown>;
report.source = {
  id: String(source.id),
  contentHash: String(source.content_hash),
  originalFileName: String(source.original_file_name),
  normaliserVersion: String(source.normaliser_version),
  eventDate: source.event_date ? String(source.event_date) : null,
  wordCount: Number(source.word_count),
  segmentCount: Number(source.segment_count),
  durationMs: source.duration_ms === null ? null : Number(source.duration_ms),
  participants: JSON.parse(String(source.participants_json)) as string[],
  windows: db.prepare('SELECT seq, start_seq, end_seq, token_estimate FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId),
  markers: db.prepare('SELECT confidence, count(*) count FROM source_markers WHERE source_id = ? GROUP BY confidence').all(sourceId),
};

const resolvedSkill = resolveSkillForRun(db, project.id);
report.skillInForce = {
  skillId: resolvedSkill.skillId,
  version: resolvedSkill.version,
  sha256: resolvedSkill.sha256,
  status: resolvedSkill.status,
  source: resolvedSkill.source,
  promptTemplateVersion: resolvedSkill.promptTemplateVersion,
  packetContractVersion: resolvedSkill.packetContractVersion,
  pinned: resolvedSkill.pinned,
  characters: resolvedSkill.characters,
};
report.registeredSkills = readSkillRevisions(db);

/* -------------------------------------------------------------- the provider */

function syntheticProvider(): StructuredExtractionProvider {
  // A dry-run provider that exercises every downstream stage — window coverage,
  // category coverage, anchors, merge, freeze, replay, comparison — without a
  // model call. Used to prove the harness before any real tokens are spent.
  return new FakeStructuredExtractionProvider((request: StructuredExtractionRequest) => {
    const rows: StructuredExtractionOutput['rows'] = [];
    for (const window of request.windows) {
      const segment = window.segments.find((entry) => entry.text.split(/\s+/).length >= 8) ?? window.segments[0];
      if (!segment) continue;
      rows.push({
        registerName: 'Actions',
        row: {
          client_ref: `Actions-${segment.seq}`,
          op: 'add', target_id: null, proposed_id: '$ALLOC',
          title: `Synthetic dry-run row for segment ${segment.seq}`,
          summary: segment.text.slice(0, 200),
          status: null, record_type: null, owner: null, due_date_raw: null,
          source_ref: request.source.sourceId, related_refs: [], supersedes: [],
          anchors: [{ segment_seq: segment.seq, speaker: segment.speaker, t_ms: segment.tStartMs, quote: segment.text }],
          derivation: 'fact', reasoning: null, confidence: 'medium', discharges_markers: [], details: {},
        },
      });
    }
    return {
      output: {
        rows,
        windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'reviewed' as const, itemCount: rows.filter((row) => row.row.anchors[0].segment_seq >= window.startSeq && row.row.anchors[0].segment_seq <= window.endSeq).length, explanation: 'Synthetic dry run.' })),
        categoryCoverage: SOURCE_INTELLIGENCE_CATEGORIES.map((category) => ({ key: category, status: category === 'Actions' ? 'populated' as const : 'none-found' as const, itemCount: category === 'Actions' ? rows.length : 0, explanation: category === 'Actions' ? null : 'Synthetic dry run produced nothing of this kind.' })),
      },
      usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 500, sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0) },
    };
  });
}

const provider: StructuredExtractionProvider = replayOnly
  ? new PreservedOutputExtractionProvider(db, sourceId)
  : providerKind === 'claude'
    ? new ClaudeCodeStructuredExtractionProvider('claude', { model, timeoutMs: 20 * 60_000 })
    : syntheticProvider();

report.providerIdentity = provider.identity;
report.providerAvailable = provider.isAvailable();
if (!provider.isAvailable()) throw new Error(`Provider ${provider.identity.providerId} is unavailable; the run is not attempted.`);

/* ------------------------------------------------------------------- the run */

const started = Date.now();
const result = await runSourceExtractionJob(db, {
  sourceId,
  provider,
  // One governed pass. A transport failure that produced no model output is the
  // only thing that may be retried, and that decision is the operator's, not an
  // automatic loop's.
  maxAttempts: 1,
  budget: {
    // The wall-clock budget is an operator parameter, not an acceptance
    // threshold: the validator's cost gate is calls, input tokens and source
    // repetition, none of which is relaxed here. A two-hour transcript costs
    // roughly 25 minutes, which would abort a good run at the design's 20.
    maxWallClockMs: wallClockMinutes * 60_000,
  },
  onEvent: (event) => console.log('[acceptance]', JSON.stringify(event)),
});
report.wallClockMs = Date.now() - started;
report.jobResult = { ok: result.ok, status: result.status, providerCalls: result.providerCalls, attempts: result.attempts, kind: result.kind, message: result.message, recoveryAction: result.recoveryAction };

/* -------------------------------------------------------------- the evidence */

report.preservedOutputs = readPreservedOutputs(db, sourceId).map((record) => ({
  id: record.id, callIndex: record.callIndex, attemptLabel: record.attemptLabel,
  providerId: record.providerId, modelLabel: record.modelLabel,
  skillId: record.skillId, skillVersion: record.skillVersion, skillSha256: record.skillSha256,
  promptTemplateVersion: record.promptTemplateVersion, promptSha256: record.promptSha256,
  packetContractVersion: record.packetContractVersion, windowKeys: record.windowKeys,
  requestedAt: record.requestedAt, receivedAt: record.receivedAt, durationMs: record.durationMs,
  responseSha256: record.responseSha256, responseBytes: record.responseBytes, artefactPath: record.artefactPath,
  inputTokens: record.inputTokens, outputTokens: record.outputTokens,
  inputTokenSource: record.inputTokenSource, outputTokenSource: record.outputTokenSource,
  parseStatus: record.parseStatus, parseDetail: record.parseDetail, runId: record.runId,
}));

report.extractionRuns = db.prepare('SELECT id, stage, provider_id, model_label, skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, packet_contract_version, status, input_tokens, output_tokens, source_tokens, input_token_source, output_token_source, started_at, duration_ms, error, output_sha256 FROM extraction_runs WHERE source_id = ? ORDER BY started_at').all(sourceId);
report.windowStatuses = db.prepare('SELECT seq, status, item_count, explanation FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId);
report.markers = {
  byConfidence: db.prepare('SELECT confidence, count(*) count FROM source_markers WHERE source_id = ? GROUP BY confidence').all(sourceId),
  highTotal: db.prepare("SELECT count(*) count FROM source_markers WHERE source_id = ? AND confidence = 'high'").get(sourceId),
  highDischarged: db.prepare("SELECT count(*) count FROM source_markers WHERE source_id = ? AND confidence = 'high' AND discharged_by_item_ref IS NOT NULL").get(sourceId),
  highDismissed: db.prepare("SELECT count(*) count FROM source_markers WHERE source_id = ? AND confidence = 'high' AND dismissal_reason IS NOT NULL").get(sourceId),
  outstanding: db.prepare("SELECT id, segment_seq, marker_type FROM source_markers WHERE source_id = ? AND confidence = 'high' AND discharged_by_item_ref IS NULL AND dismissal_reason IS NULL ORDER BY segment_seq").all(sourceId),
};

const packet = db.prepare('SELECT * FROM extraction_packets WHERE source_id = ? ORDER BY assembled_at DESC LIMIT 1').get(sourceId) as Record<string, unknown> | undefined;
if (packet) {
  report.packet = {
    id: String(packet.id), packetSha256: String(packet.packet_sha256), validationStatus: String(packet.validation_status),
    skillId: packet.skill_id ? String(packet.skill_id) : null, skillVersion: packet.skill_version ? String(packet.skill_version) : null,
    promptTemplateVersion: packet.prompt_template_version ? String(packet.prompt_template_version) : null,
    packetContractVersion: Number(packet.packet_contract_version), baseRegisterRevision: Number(packet.base_register_revision),
    validationReport: JSON.parse(String(packet.validation_report_json)) as unknown,
    coverage: db.prepare('SELECT scope, key, status, item_count, explanation FROM packet_coverage WHERE packet_id = ? ORDER BY scope, key').all(String(packet.id)),
  };
  const changeset = db.prepare('SELECT * FROM register_changesets WHERE packet_id = ? ORDER BY created_at DESC LIMIT 1').get(String(packet.id)) as Record<string, unknown> | undefined;
  if (changeset) {
    report.changeset = {
      id: String(changeset.id), gateVerdict: String(changeset.gate_verdict), reviewStatus: String(changeset.review_status),
      appliedAt: changeset.applied_at ? String(changeset.applied_at) : null, deterministicHash: String(changeset.deterministic_hash),
      operationCounts: db.prepare('SELECT op, count(*) count FROM register_change_ops WHERE changeset_id = ? GROUP BY op ORDER BY op').all(String(changeset.id)),
      operationsByRegister: db.prepare('SELECT register_name, count(*) count FROM register_change_ops WHERE changeset_id = ? GROUP BY register_name ORDER BY register_name').all(String(changeset.id)),
      totalOperations: db.prepare('SELECT count(*) count FROM register_change_ops WHERE changeset_id = ?').get(String(changeset.id)),
      pendingOperations: db.prepare("SELECT count(*) count FROM register_change_ops WHERE changeset_id = ? AND status = 'pending'").get(String(changeset.id)),
    };
  }

  /* ---------------------------------------------------------------- replay */
  const replayStarted = Date.now();
  const replay = replayPacket(db, String(packet.id));
  report.replay = { ...replay, measuredWallClockMs: Date.now() - replayStarted };

  /* ------------------------------------------------------------ comparison */
  const frozenPacketJson = String(packet.packet_json);
  const comparison = compareBlindExtractionToBenchmark(db, project.id, {
    frozenPacketFile: { name: 'frozen-packet.json', dataBase64: Buffer.from(frozenPacketJson, 'utf8').toString('base64') },
    expectedDeltaFile: { name: path.basename(benchmarkPath), dataBase64: readFileSync(benchmarkPath).toString('base64') },
    ...(workbookPath && existsSync(workbookPath) ? { expectedWorkbookFile: { name: path.basename(workbookPath), dataBase64: readFileSync(workbookPath).toString('base64') } } : {}),
  });
  report.comparison = { id: comparison.id, comparisonStatus: comparison.comparisonStatus, report: comparison.report };

  /* ------------------------------------------------- benchmark against the skill */
  const totals = (comparison.report as { totals: { metrics: Record<string, unknown>; expectedRows: number; extractedRows: number; exactMatches: number; semanticMatches: number; missingItems: number; additionalItems: number } }).totals;
  const factRecall = Number(totals.metrics.distinctFactRecall ?? 0);
  report.skillBenchmark = recordSkillBenchmark(db, {
    skillId: resolvedSkill.skillId,
    version: resolvedSkill.version,
    projectId: project.id,
    sourceId,
    packetId: String(packet.id),
    benchmarkLabel,
    verdict: factRecall >= 0.7 ? 'pass' : 'fail',
    metrics: {
      distinctFactRecall: totals.metrics.distinctFactRecall,
      registerRowRecall: totals.metrics.registerRowRecall,
      precision: totals.metrics.precision,
      expectedRows: totals.expectedRows,
      extractedRows: totals.extractedRows,
      exactMatches: totals.exactMatches,
      semanticMatches: totals.semanticMatches,
      missingItems: totals.missingItems,
      additionalItems: totals.additionalItems,
      providerCalls: result.providerCalls,
      gateVerdict: report.changeset ? (report.changeset as { gateVerdict: string }).gateVerdict : String(packet.validation_status),
    },
    recordedBy: 'ptw-acceptance-script',
    note: `Honest baseline for the published revision on ${new Date().toISOString().slice(0, 10)}. Recorded whatever the result; the revision was not tuned during this run.`,
  });
}

/* ------------------------------------------------ database integrity after the run */

report.integrity = {
  quickCheck: db.prepare('PRAGMA quick_check').all(),
  foreignKeyCheck: db.prepare('PRAGMA foreign_key_check').all(),
  registerRowCount: db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(project.id),
  proposedChanges: db.prepare('SELECT id, status, reviewed_at, applied_at FROM proposed_changes ORDER BY id').all(),
  assertedUnchangedProposal: untouchedProposalId
    ? db.prepare('SELECT id, status, reviewed_at, applied_at FROM proposed_changes WHERE id = ?').get(untouchedProposalId)
    : null,
  appliedChangesets: db.prepare("SELECT count(*) count FROM register_changesets WHERE review_status = 'applied'").get(),
};
report.finishedAt = new Date().toISOString();

writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`[acceptance] report written to ${outPath}`);
db.close();
