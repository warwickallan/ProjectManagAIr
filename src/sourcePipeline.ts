import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  SOURCE_EXTRACTION_SKILL,
  SOURCE_INTELLIGENCE_CATEGORIES,
  buildStructuredExtractionPrompt,
  estimateTokens,
  sha256,
  type CoverageStatus,
  type ExtractionCoverage,
  type ExtractionWindowInput,
  type SourceIntelligenceCategory,
  type SourcePacketRow,
  type StructuredExtractionOutput,
  type StructuredExtractionProvider,
  type StructuredExtractionRequest,
} from './extractionProvider.js';
import { intakeProjectSource, type IntakeFileInput } from './projectLifecycle.js';
import {
  freezePacketAndCreateChangeset,
  registerNormalizedSource,
  type SourceIntelligencePacket,
} from './sourceIntelligence.js';

export const SOURCE_PIPELINE_CONTRACT = 'projectmanagair-source-intelligence-v1';

export interface ExtractionBudget {
  maxCalls: number;
  maxInputTokens: number;
  maxSourceRepetition: number;
  maxWallClockMs: number;
  maxTokensPerCall: number;
}

export interface ExtractionSlice {
  callIndex: number;
  windows: ExtractionWindowInput[];
  estimatedSourceTokens: number;
}

export interface MarkerDismissal {
  markerId: string;
  reason: string;
}

export interface SourceExtractionOptions {
  sourceId: string;
  provider?: StructuredExtractionProvider;
  budget?: Partial<ExtractionBudget>;
  skipWindows?: Array<{ seq: number; reason: string }>;
  markerDismissals?: MarkerDismissal[];
  signal?: AbortSignal;
}

interface SourceDocumentRow {
  id: string;
  project_id: string;
  intake_source_id: string | null;
  content_hash: string;
  source_type: string;
  original_file_name: string;
  event_date: string | null;
  duration_ms: number | null;
  word_count: number;
  participants_json: string;
}

interface SourceWindowRow {
  id: string;
  seq: number;
  start_seq: number;
  end_seq: number;
  token_estimate: number;
}

interface RegisterRow {
  register_name: string;
  external_register_id: string;
  title: string;
  record_status: string;
  owner: string | null;
  due_date: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function defaultExtractionBudget(sourceType: string, wordCount: number): ExtractionBudget {
  const shortSource = sourceType === 'email-message' || sourceType === 'text-note' || wordCount <= 4_000;
  return {
    maxCalls: shortSource ? 4 : 12,
    maxInputTokens: shortSource ? 20_000 : 200_000,
    maxSourceRepetition: 2.5,
    maxWallClockMs: shortSource ? 5 * 60_000 : 20 * 60_000,
    maxTokensPerCall: shortSource ? 8_000 : 18_000,
  };
}

function resolvedBudget(sourceType: string, wordCount: number, override?: Partial<ExtractionBudget>): ExtractionBudget {
  const budget = { ...defaultExtractionBudget(sourceType, wordCount), ...override };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Extraction budget ${name} must be positive.`);
  }
  return budget;
}

export function planExtractionSlices(windows: ExtractionWindowInput[], budget: ExtractionBudget): ExtractionSlice[] {
  const slices: ExtractionSlice[] = [];
  let current: ExtractionWindowInput[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length === 0) return;
    slices.push({ callIndex: slices.length + 1, windows: current, estimatedSourceTokens: currentTokens });
    current = [];
    currentTokens = 0;
  };
  for (const window of windows) {
    if (window.tokenEstimate > budget.maxTokensPerCall) {
      throw new Error(`Window ${window.seq} exceeds the per-call extraction budget and must be re-windowed.`);
    }
    if (current.length > 0 && currentTokens + window.tokenEstimate > budget.maxTokensPerCall) flush();
    current.push(window);
    currentTokens += window.tokenEstimate;
  }
  flush();
  if (slices.length > budget.maxCalls) {
    throw new Error(`Extraction requires ${slices.length} calls but the configured limit is ${budget.maxCalls}.`);
  }
  return slices;
}

function readWindow(db: DatabaseSync, sourceId: string, row: SourceWindowRow): ExtractionWindowInput {
  const segments = db.prepare('SELECT seq, text, speaker, t_start_ms FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ? ORDER BY seq')
    .all(sourceId, row.start_seq, row.end_seq) as Array<{ seq: number; text: string; speaker: string | null; t_start_ms: number | null }>;
  return {
    id: row.id,
    seq: row.seq,
    startSeq: row.start_seq,
    endSeq: row.end_seq,
    tokenEstimate: row.token_estimate,
    segments: segments.map((segment) => ({
      seq: Number(segment.seq),
      text: String(segment.text),
      speaker: segment.speaker === null ? null : String(segment.speaker),
      tStartMs: segment.t_start_ms === null ? null : Number(segment.t_start_ms),
    })),
  };
}

export function prepareSourceIntelligenceJob(db: DatabaseSync, input: { projectId: string; intakeSourceId: string; contentHash: string }): string {
  const jobId = `source-job:${input.projectId}:${input.contentHash.slice(0, 16)}`;
  const timestamp = nowIso();
  db.prepare(`INSERT INTO source_processing_jobs
    (id, source_id, project_id, provider, status, started_at, completed_at, error_message, structured_output_contract, proposed_change_id, current_stage, attempt_count, max_attempts, queued_at, updated_at, packet_id, changeset_id)
    VALUES (?, ?, ?, 'unassigned', 'queued', ?, NULL, NULL, ?, NULL, 'queued', 0, 2, ?, ?, NULL, NULL)
    ON CONFLICT(id) DO UPDATE SET status = 'queued', current_stage = 'queued', error_message = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at`)
    .run(jobId, input.intakeSourceId, input.projectId, timestamp, SOURCE_PIPELINE_CONTRACT, timestamp, timestamp);
  return jobId;
}

export function registerIntakeForSourceIntelligence(db: DatabaseSync, input: {
  projectId: string;
  intakeSourceId: string;
  fileName: string;
  immutablePath: string;
  contentHash: string;
  bytes?: Buffer;
  eventDate?: string | null;
}) {
  prepareSourceIntelligenceJob(db, input);
  return registerNormalizedSource(db, input);
}

export function dismissSourceMarkers(db: DatabaseSync, sourceId: string, dismissals: MarkerDismissal[]): void {
  const update = db.prepare('UPDATE source_markers SET dismissal_reason = ? WHERE id = ? AND source_id = ?');
  for (const dismissal of dismissals) {
    const reason = dismissal.reason.trim();
    if (!reason) throw new Error(`Marker ${dismissal.markerId} needs an explicit dismissal reason.`);
    const result = update.run(reason, dismissal.markerId, sourceId);
    if (Number(result.changes) !== 1) throw new Error(`Marker ${dismissal.markerId} does not belong to source ${sourceId}.`);
  }
}

function setJobState(db: DatabaseSync, source: SourceDocumentRow, status: string, stage: string, error: string | null): void {
  const jobId = `source-job:${source.project_id}:${source.content_hash.slice(0, 16)}`;
  db.prepare(`UPDATE source_processing_jobs
    SET status = ?, current_stage = ?, error_message = ?, updated_at = ?,
        completed_at = CASE WHEN ? IN ('quarantined', 'failed') THEN ? ELSE completed_at END
    WHERE id = ?`)
    .run(status, stage, error, nowIso(), status, nowIso(), jobId);
}

export function quarantineSourceJob(db: DatabaseSync, sourceId: string, reason: string): void {
  const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(sourceId) as SourceDocumentRow | undefined;
  if (!source) throw new Error(`Source document ${sourceId} was not found.`);
  setJobState(db, source, 'quarantined', 'quarantined', reason);
  db.prepare("UPDATE source_windows SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END, explanation = COALESCE(explanation, ?) WHERE source_id = ?")
    .run(reason, sourceId);
}

function insertRun(db: DatabaseSync, input: {
  source: SourceDocumentRow;
  projectId: string;
  providerId: string;
  modelLabel: string;
  skillSha256: string;
  promptSha256: string;
  usage: { inputTokens: number; outputTokens: number; sourceTokens: number };
  startedAt: string;
  durationMs: number;
  status: string;
  error: string | null;
  outputSha256: string | null;
  stage?: string;
}): string {
  const id = `extract:${input.source.id}:${randomUUID()}`;
  db.prepare(`INSERT INTO extraction_runs
    (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.source.id, input.projectId, input.stage ?? 'structured-extraction', input.providerId, input.modelLabel,
      input.skillSha256, input.promptSha256, input.usage.inputTokens, input.usage.outputTokens, input.usage.sourceTokens,
      input.startedAt, input.durationMs, input.status, input.error, input.outputSha256);
  return id;
}

function aggregateCategoryCoverage(
  rows: Array<{ registerName: SourceIntelligenceCategory; row: SourcePacketRow }>,
  entries: ExtractionCoverage[],
): ExtractionCoverage[] {
  return SOURCE_INTELLIGENCE_CATEGORIES.map((category) => {
    const categoryEntries = entries.filter((entry) => entry.key === category);
    const itemCount = rows.filter((row) => row.registerName === category).length;
    const statuses = new Set(categoryEntries.map((entry) => entry.status));
    let status: CoverageStatus;
    if (statuses.has('failed') || categoryEntries.length === 0) status = 'failed';
    else if (statuses.has('uncertain')) status = 'uncertain';
    else if (itemCount > 0) status = 'populated';
    else if ([...statuses].every((value) => value === 'no-governance-content')) status = 'no-governance-content';
    else status = 'none-found';
    const explanations = categoryEntries.map((entry) => entry.explanation).filter((value): value is string => Boolean(value));
    const explanation = explanations.length > 0 ? [...new Set(explanations)].join(' ') : itemCount === 0 ? `No ${category} items were found in the reviewed source windows.` : null;
    return { key: category, status, itemCount, explanation };
  });
}

function skippedSourceRow(source: SourceDocumentRow, firstSegment: { seq: number; text: string; speaker: string | null; t_start_ms: number | null }): SourcePacketRow {
  return {
    client_ref: `source-${source.id}`,
    op: 'add',
    target_id: null,
    proposed_id: '$ALLOC',
    title: source.original_file_name,
    summary: 'Source retained and deterministically classified as containing no project-governance content.',
    status: 'reviewed',
    record_type: 'source',
    owner: null,
    due_date_raw: null,
    source_ref: source.id,
    related_refs: [],
    supersedes: [],
    anchors: [{ segment_seq: Number(firstSegment.seq), speaker: firstSegment.speaker, t_ms: firstSegment.t_start_ms, quote: firstSegment.text }],
    derivation: 'fact',
    reasoning: null,
    confidence: 'high',
    discharges_markers: [],
    details: { source_type: source.source_type },
  };
}

function assertIdentity(provider: StructuredExtractionProvider): void {
  if (!provider.identity.providerId.trim() || !provider.identity.modelLabel.trim()) {
    throw new Error('Structured extraction provider identity must be controlled by the provider implementation.');
  }
}

export async function orchestrateSourceExtraction(db: DatabaseSync, options: SourceExtractionOptions) {
  const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(options.sourceId) as SourceDocumentRow | undefined;
  if (!source) throw new Error(`Source document ${options.sourceId} was not found.`);
  const project = db.prepare('SELECT id, code FROM projects WHERE id = ?').get(source.project_id) as { id: string; code: string } | undefined;
  if (!project) throw new Error(`Project ${source.project_id} was not found.`);
  const provider = options.provider;
  if (provider) assertIdentity(provider);
  const budget = resolvedBudget(source.source_type, Number(source.word_count), options.budget);
  const started = Date.now();
  const skillSha256 = sha256(SOURCE_EXTRACTION_SKILL);
  const skipReasons = new Map((options.skipWindows ?? []).map((entry) => [entry.seq, entry.reason.trim()]));
  if ([...skipReasons.values()].some((reason) => !reason)) throw new Error('Skipped windows require an explicit comprehension reason.');
  if (options.markerDismissals?.length) dismissSourceMarkers(db, source.id, options.markerDismissals);

  const windowRows = db.prepare('SELECT * FROM source_windows WHERE source_id = ? ORDER BY seq').all(source.id) as unknown as SourceWindowRow[];
  const windows = windowRows.map((window) => readWindow(db, source.id, window));
  if (windows.length === 0) throw new Error('Source has no normalized extraction windows.');
  const extractWindows = windows.filter((window) => !skipReasons.has(window.seq));
  let slices: ExtractionSlice[];
  try {
    slices = planExtractionSlices(extractWindows, budget);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Extraction planning exceeded its budget.';
    quarantineSourceJob(db, source.id, message);
    throw error;
  }
  if (slices.length > 0 && (!provider || !provider.isAvailable())) {
    const message = `Provider ${provider?.identity.providerId ?? 'none'} is unavailable; source remains quarantined for retry or explicit comprehension skip.`;
    quarantineSourceJob(db, source.id, message);
    throw new Error(message);
  }

  setJobState(db, source, 'processing', 'extracting', null);
  const revision = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(project.id) as { revision: number } | undefined)?.revision ?? 0);
  const registerRows = db.prepare('SELECT register_name, external_register_id, title, record_status, owner, due_date FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id')
    .all(project.id) as unknown as RegisterRow[];
  const existingRows = registerRows.map((row) => ({
    registerName: row.register_name,
    externalId: row.external_register_id,
    title: row.title,
    status: row.record_status,
    owner: row.owner,
    dueDate: row.due_date,
  }));
  const runIds: string[] = [];
  const outputs: StructuredExtractionOutput[] = [];
  let totalInputTokens = 0;
  let totalSourceTokens = 0;
  const sourceTokens = Math.max(1, Math.ceil(Number(source.word_count) * 1.35));

  for (const slice of slices) {
    const partialRequest = {
      source: {
        sourceId: source.id,
        sourceType: source.source_type,
        originalFileName: source.original_file_name,
        contentHash: source.content_hash,
        eventDate: source.event_date,
      },
      project: { projectId: project.id, projectCode: project.code, baseRegisterRevision: revision },
      windows: slice.windows,
      categories: [...SOURCE_INTELLIGENCE_CATEGORIES],
      existingRows,
      callIndex: slice.callIndex,
    };
    const prompt = buildStructuredExtractionPrompt(partialRequest);
    const promptSha256 = sha256(prompt);
    const request: StructuredExtractionRequest = { ...partialRequest, prompt, promptSha256, skillSha256 };
    const projectedInput = totalInputTokens + estimateTokens(prompt);
    const projectedRepetition = (totalSourceTokens + slice.estimatedSourceTokens) / sourceTokens;
    if (projectedInput > budget.maxInputTokens || projectedRepetition > budget.maxSourceRepetition || Date.now() - started > budget.maxWallClockMs) {
      const message = `Extraction budget would be exceeded before call ${slice.callIndex}.`;
      quarantineSourceJob(db, source.id, message);
      throw new Error(message);
    }
    const callStarted = Date.now();
    const startedAt = nowIso();
    let completedRunRecorded = false;
    try {
      const result = await provider!.extract(request, options.signal);
      const durationMs = Date.now() - callStarted;
      totalInputTokens += result.usage.inputTokens;
      totalSourceTokens += result.usage.sourceTokens;
      const outputJson = stable(result.output);
      const runId = insertRun(db, {
        source,
        projectId: project.id,
        providerId: provider!.identity.providerId,
        modelLabel: provider!.identity.modelLabel,
        skillSha256,
        promptSha256,
        usage: result.usage,
        startedAt,
        durationMs,
        status: 'completed',
        error: null,
        outputSha256: sha256(outputJson),
      });
      runIds.push(runId);
      completedRunRecorded = true;
      outputs.push(result.output);
      if (totalInputTokens > budget.maxInputTokens || totalSourceTokens / sourceTokens > budget.maxSourceRepetition || Date.now() - started > budget.maxWallClockMs) {
        const message = `Provider telemetry exceeded the configured extraction budget after call ${slice.callIndex}.`;
        quarantineSourceJob(db, source.id, message);
        throw new Error(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Structured provider call failed.';
      if (!completedRunRecorded) {
        insertRun(db, {
          source,
          projectId: project.id,
          providerId: provider!.identity.providerId,
          modelLabel: provider!.identity.modelLabel,
          skillSha256,
          promptSha256,
          usage: { inputTokens: estimateTokens(prompt), outputTokens: 0, sourceTokens: slice.estimatedSourceTokens },
          startedAt,
          durationMs: Date.now() - callStarted,
          status: 'failed',
          error: message,
          outputSha256: null,
        });
      }
      quarantineSourceJob(db, source.id, message);
      throw error;
    }
  }

  const allSkipped = slices.length === 0;
  if (allSkipped) {
    const firstSegment = db.prepare('SELECT seq, text, speaker, t_start_ms FROM source_segments WHERE source_id = ? ORDER BY seq LIMIT 1').get(source.id) as { seq: number; text: string; speaker: string | null; t_start_ms: number | null };
    const row = skippedSourceRow(source, firstSegment);
    const output: StructuredExtractionOutput = {
      rows: [{ registerName: 'Sources', row }],
      windowCoverage: windows.map((window) => ({ key: String(window.seq), status: 'no-governance-content', itemCount: 0, explanation: skipReasons.get(window.seq) ?? 'Explicitly skipped after comprehension review.' })),
      categoryCoverage: SOURCE_INTELLIGENCE_CATEGORIES.map((category) => ({
        key: category,
        status: category === 'Sources' ? 'populated' : 'no-governance-content',
        itemCount: category === 'Sources' ? 1 : 0,
        explanation: category === 'Sources' ? null : 'Explicit comprehension review found no project-governance content.',
      })),
    };
    const outputJson = stable(output);
    runIds.push(insertRun(db, {
      source,
      projectId: project.id,
      providerId: 'deterministic-comprehension-skip',
      modelLabel: 'code-path-v1',
      skillSha256,
      promptSha256: sha256('deterministic-comprehension-skip-v1'),
      usage: { inputTokens: 0, outputTokens: 0, sourceTokens: 0 },
      startedAt: nowIso(),
      durationMs: Date.now() - started,
      status: 'completed',
      error: null,
      outputSha256: sha256(outputJson),
      stage: 'comprehension-skip',
    }));
    outputs.push(output);
  }

  const rowsByRef = new Map<string, { registerName: SourceIntelligenceCategory; row: SourcePacketRow; serialized: string }>();
  for (const entry of outputs.flatMap((output) => output.rows)) {
    const serialized = stable(entry);
    const existing = rowsByRef.get(entry.row.client_ref);
    if (existing && existing.serialized !== serialized) {
      const message = `Provider emitted conflicting rows for client_ref ${entry.row.client_ref}.`;
      quarantineSourceJob(db, source.id, message);
      throw new Error(message);
    }
    rowsByRef.set(entry.row.client_ref, { ...entry, serialized });
  }
  const rows = [...rowsByRef.values()].map(({ registerName, row }) => ({ registerName, row }));
  const windowCoverageByKey = new Map<string, ExtractionCoverage>();
  for (const output of outputs) for (const coverage of output.windowCoverage) windowCoverageByKey.set(coverage.key, coverage);
  for (const window of windows) {
    const skippedReason = skipReasons.get(window.seq);
    if (skippedReason) windowCoverageByKey.set(String(window.seq), { key: String(window.seq), status: 'no-governance-content', itemCount: 0, explanation: skippedReason });
    if (!windowCoverageByKey.has(String(window.seq))) windowCoverageByKey.set(String(window.seq), { key: String(window.seq), status: 'failed', itemCount: 0, explanation: 'Provider omitted explicit coverage for this window.' });
  }
  const categoryCoverage = aggregateCategoryCoverage(rows, outputs.flatMap((output) => output.categoryCoverage));
  const sheets = Object.fromEntries(SOURCE_INTELLIGENCE_CATEGORIES.map((category) => [category, { rows: rows.filter((entry) => entry.registerName === category).map((entry) => entry.row) }])) as SourceIntelligencePacket['sheets'];
  const packet: SourceIntelligencePacket = {
    packet_type: 'project_register_delta',
    packet_version: 1,
    project_code: project.code,
    base_register_revision: revision,
    source: {
      source_id: source.id,
      content_hash: source.content_hash,
      source_type: source.source_type,
      original_file_name: source.original_file_name,
      event_date: source.event_date,
      duration_ms: source.duration_ms,
      participants: JSON.parse(source.participants_json) as string[],
    },
    sheets,
    coverage: {
      windows: windows.map((window) => {
        const entry = windowCoverageByKey.get(String(window.seq))!;
        return { key: entry.key, status: entry.status, item_count: entry.itemCount, explanation: entry.explanation };
      }),
      categories: categoryCoverage.map((entry) => ({ key: entry.key, status: entry.status, item_count: entry.itemCount, explanation: entry.explanation })),
    },
    execution: { runs: runIds },
  };
  const handoff = freezePacketAndCreateChangeset(db, packet);
  return {
    ...handoff,
    sourceId: source.id,
    provider: provider?.identity ?? { providerId: 'deterministic-comprehension-skip', modelLabel: 'code-path-v1' },
    runs: runIds,
    calls: slices.length,
    inputTokens: totalInputTokens,
    sourceTokenRepetition: Number((totalSourceTokens / sourceTokens).toFixed(3)),
    durationMs: Date.now() - started,
    suggestedMarkerDismissals: outputs.flatMap((output) => output.markerDismissals ?? []),
  };
}

export async function skipSourceAfterComprehension(db: DatabaseSync, input: { sourceId: string; reason: string; markerDismissals?: MarkerDismissal[] }) {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Comprehension skip requires an explicit reason.');
  const windows = db.prepare('SELECT seq FROM source_windows WHERE source_id = ? ORDER BY seq').all(input.sourceId) as unknown as Array<{ seq: number }>;
  if (windows.length === 0) throw new Error(`Source ${input.sourceId} has no normalized windows to skip.`);
  return orchestrateSourceExtraction(db, {
    sourceId: input.sourceId,
    skipWindows: windows.map((window) => ({ seq: Number(window.seq), reason })),
    markerDismissals: input.markerDismissals,
  });
}
export interface WatchedInboxEnqueueResult {
  duplicate?: boolean;
  sourceId?: string;
  [key: string]: unknown;
}

export type WatchedInboxEnqueue = (projectId: string, file: IntakeFileInput) => Promise<WatchedInboxEnqueueResult>;

export function createLifecycleSourceEnqueuer(db: DatabaseSync): WatchedInboxEnqueue {
  return (projectId, file) => intakeProjectSource(db, projectId, file);
}

export interface WatchedInboxScannerOptions {
  projectId: string;
  inboxPath: string;
  enqueue: WatchedInboxEnqueue;
  isKnownHash?: (hash: string) => boolean | Promise<boolean>;
  stabilityMs?: number;
  debounceMs?: number;
  minimumStableScans?: number;
  now?: () => number;
}

export interface WatchedInboxEvent {
  path: string;
  status: 'observed' | 'unstable' | 'enqueued' | 'duplicate' | 'ignored' | 'failed';
  contentHash?: string;
  detail?: string;
}

interface SeenFile {
  size: number;
  mtimeMs: number;
  unchangedSince: number;
  stableScans: number;
  lastEnqueuedAt: number | null;
  lastHash: string | null;
}

const ignoredFile = /(^~\$)|(\.(?:tmp|partial|crdownload|download)$)/i;

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(resolved);
      else if (entry.isFile()) files.push(resolved);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

export class WatchedInboxScanner {
  private readonly seen = new Map<string, SeenFile>();
  private readonly processedHashes = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private readonly stabilityMs: number;
  private readonly debounceMs: number;
  private readonly minimumStableScans: number;
  private readonly now: () => number;

  constructor(private readonly options: WatchedInboxScannerOptions) {
    this.stabilityMs = options.stabilityMs ?? 1_500;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.minimumStableScans = options.minimumStableScans ?? 2;
    this.now = options.now ?? Date.now;
  }

  async scan(): Promise<WatchedInboxEvent[]> {
    if (this.scanning) return [];
    this.scanning = true;
    const events: WatchedInboxEvent[] = [];
    try {
      const files = await listFiles(path.resolve(this.options.inboxPath));
      const present = new Set(files);
      for (const knownPath of this.seen.keys()) if (!present.has(knownPath)) this.seen.delete(knownPath);
      for (const filePath of files) {
        if (ignoredFile.test(path.basename(filePath))) {
          events.push({ path: filePath, status: 'ignored', detail: 'Temporary or incomplete file name.' });
          continue;
        }
        const before = await stat(filePath);
        const observedAt = this.now();
        const previous = this.seen.get(filePath);
        if (!previous || previous.size !== before.size || previous.mtimeMs !== before.mtimeMs) {
          this.seen.set(filePath, { size: before.size, mtimeMs: before.mtimeMs, unchangedSince: observedAt, stableScans: 1, lastEnqueuedAt: previous?.lastEnqueuedAt ?? null, lastHash: null });
          events.push({ path: filePath, status: 'observed' });
          continue;
        }
        previous.stableScans += 1;
        if (observedAt - previous.unchangedSince < this.stabilityMs || previous.stableScans < this.minimumStableScans) {
          events.push({ path: filePath, status: 'unstable' });
          continue;
        }
        if (previous.lastEnqueuedAt !== null && observedAt - previous.lastEnqueuedAt < this.debounceMs) {
          events.push({ path: filePath, status: 'unstable', detail: 'Debounce interval has not elapsed.' });
          continue;
        }
        const bytes = await readFile(filePath);
        const after = await stat(filePath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          this.seen.set(filePath, { size: after.size, mtimeMs: after.mtimeMs, unchangedSince: observedAt, stableScans: 1, lastEnqueuedAt: previous.lastEnqueuedAt, lastHash: null });
          events.push({ path: filePath, status: 'unstable', detail: 'File changed while being read.' });
          continue;
        }
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        previous.lastHash = contentHash;
        const alreadyKnown = this.processedHashes.has(contentHash) || Boolean(await this.options.isKnownHash?.(contentHash));
        if (alreadyKnown) {
          previous.lastEnqueuedAt = observedAt;
          this.processedHashes.add(contentHash);
          events.push({ path: filePath, status: 'duplicate', contentHash });
          continue;
        }
        try {
          const result = await this.options.enqueue(this.options.projectId, {
            name: path.basename(filePath),
            dataBase64: bytes.toString('base64'),
          });
          previous.lastEnqueuedAt = observedAt;
          this.processedHashes.add(contentHash);
          events.push({ path: filePath, status: result.duplicate ? 'duplicate' : 'enqueued', contentHash });
        } catch (error) {
          events.push({ path: filePath, status: 'failed', contentHash, detail: error instanceof Error ? error.message : 'Inbox enqueue failed.' });
        }
      }
      return events;
    } finally {
      this.scanning = false;
    }
  }

  start(intervalMs = 1_000, onEvents?: (events: WatchedInboxEvent[]) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan().then((events) => {
        if (events.length > 0) onEvents?.(events);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
