import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LIFECYCLE_LABELS, pendingDuplicateDecision, RETIRED_LIFECYCLE_STATES, type SourceLifecycleState } from './sourceSafety.js';
import {
  SOURCE_INTELLIGENCE_CATEGORIES,
  assembleExtractionPrompt,
  buildStructuredExtractionPrompt,
  estimateTokens,
  isProviderError,
  resolveExtractionSkill,
  sha256,
  type CoverageStatus,
  type ExtractionCoverage,
  type ExtractionMarkerInput,
  type ExtractionWindowInput,
  type ProviderErrorKind,
  type ProviderUsage,
  type SourceIntelligenceCategory,
  type SourcePacketRow,
  type StructuredExtractionOutput,
  type StructuredExtractionProvider,
  type RawProviderResponse,
  type StructuredExtractionRequest,
} from './extractionProvider.js';
import { preserveProviderOutput, recordProviderOutputOutcome } from './providerOutputs.js';
import { intakeProjectSource, type IntakeFileInput } from './projectLifecycle.js';
import { ensureSkillRegistrySynced, packetSkillProvenance, publicSkillProvenance, recordExtractionRunProvenance, resolveSkillForRun, runProvenanceOf } from './skillRegistry.js';
import {
  freezePacketAndCreateChangeset,
  registerNormalizedSource,
  type SourceIntelligencePacket,
} from './sourceIntelligence.js';

export const SOURCE_PIPELINE_CONTRACT = 'projectmanagair-source-intelligence-v1';

/**
 * How long a claimed job may run before another process may reclaim it. The lease is
 * renewed after every provider call, so this bounds the time between two calls rather
 * than the whole extraction; a 2-hour source is allowed 20 minutes of wall clock in
 * total (§5.3) but no single call may stall for ten minutes without a heartbeat.
 */
export const SOURCE_JOB_LEASE_MS = 10 * 60_000;
/** How often the sweeper looks for jobs whose owner died mid-extraction. */
export const SOURCE_JOB_SWEEP_INTERVAL_MS = 60_000;
/** Design §4: "one in-process timer, 30 s, scanning each project's 00_Inbox/Unsorted". */
export const WATCHED_INBOX_POLL_MS = 30_000;
/** Bounded per-file enqueue attempts before the watcher stops re-reading a failing file. */
export const WATCHED_INBOX_MAX_ENQUEUE_ATTEMPTS = 3;
/** First backoff after a failed enqueue; doubles per attempt. */
export const WATCHED_INBOX_FAILURE_BACKOFF_MS = 60_000;

/** Identifies this process as a lease holder without recording anything host-identifying. */
const PROCESS_LEASE_OWNER = `worker:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Share of emitted rows that may conflict across overlapping calls before the pass is rejected. */
const MAX_MERGE_CONFLICT_RATIO = 0.1;

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
  /** Lease owner to keep alive while the extraction runs. Set by {@link runSourceExtractionJob}. */
  leaseOwner?: string;
  leaseMs?: number;
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

interface SourceJobRow {
  id: string;
  source_id: string;
  project_id: string;
  status: string;
  current_stage: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  packet_id: string | null;
  changeset_id: string | null;
  error_message: string | null;
  error_kind: string | null;
  recovery_action: string | null;
  updated_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString();
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

/**
 * Markers that are carried into the prompt.
 *
 * HIGH markers are a hard gate: `validatePacket` quarantines any packet where a HIGH marker is
 * neither validly discharged nor explicitly dismissed, so withholding them grades the model on a
 * checklist it never saw. MEDIUM markers are not a gate but are the per-window recall hints the
 * design intends the model to sweep, and they are cheap relative to their effect on recall.
 *
 * LOW markers are excluded on purpose. `preScan` emits one for any segment containing
 * risk/question/issue/concern/assumption/dependency/blocker, which on a real transcript is a large
 * fraction of all segments; they are deliberately never a gate, they carry no information the model
 * cannot read off the segment text it already has, and shipping them would spend budget on noise
 * that dilutes the HIGH checklist.
 *
 * Markers already carrying a dismissal reason are omitted: the operator has discharged them out of
 * band, so asking the model to account for them again is wasted budget.
 */
const PROMPTED_MARKER_CONFIDENCES = ['high', 'medium'] as const;

function readWindow(db: DatabaseSync, sourceId: string, row: SourceWindowRow): ExtractionWindowInput {
  const segments = db.prepare('SELECT seq, text, speaker, t_start_ms FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ? ORDER BY seq')
    .all(sourceId, row.start_seq, row.end_seq) as Array<{ seq: number; text: string; speaker: string | null; t_start_ms: number | null }>;
  const markers = db.prepare(`SELECT id, segment_seq, confidence
      FROM source_markers
      WHERE source_id = ? AND segment_seq BETWEEN ? AND ? AND confidence IN ('high', 'medium') AND dismissal_reason IS NULL
      ORDER BY segment_seq, id`)
    .all(sourceId, row.start_seq, row.end_seq) as Array<{ id: string; segment_seq: number; confidence: string }>;
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
    markers: markers
      .filter((marker) => (PROMPTED_MARKER_CONFIDENCES as readonly string[]).includes(String(marker.confidence)))
      .map((marker) => ({
        id: String(marker.id),
        seq: Number(marker.segment_seq),
        confidence: String(marker.confidence) as ExtractionMarkerInput['confidence'],
      })),
  };
}

export function sourceJobId(projectId: string, contentHash: string): string {
  return `source-job:${projectId}:${contentHash.slice(0, 16)}`;
}

export function prepareSourceIntelligenceJob(db: DatabaseSync, input: { projectId: string; intakeSourceId: string; contentHash: string }): string {
  const jobId = sourceJobId(input.projectId, input.contentHash);
  const timestamp = nowIso();
  db.prepare(`INSERT INTO source_processing_jobs
    (id, source_id, project_id, provider, status, started_at, completed_at, error_message, structured_output_contract, proposed_change_id, current_stage, attempt_count, max_attempts, queued_at, updated_at, packet_id, changeset_id)
    VALUES (?, ?, ?, 'unassigned', 'queued', ?, NULL, NULL, ?, NULL, 'queued', 0, 2, ?, ?, NULL, NULL)
    ON CONFLICT(id) DO UPDATE SET status = 'queued', current_stage = 'queued', error_message = NULL, error_kind = NULL,
      error_detail_json = NULL, recovery_action = NULL, last_error_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
      queued_at = excluded.queued_at, updated_at = excluded.updated_at`)
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

/* ------------------------------------------------------------------------------------ *
 * Failure taxonomy, recovery actions and job/intake visibility (D1, D2, D5)
 *
 * Every failure ends in three places a human can actually see: the job row (machine
 * state), the intake row (what the Cockpit chip renders) and the caller's event stream.
 * Nothing is swallowed and nothing is left in `processing`.
 * ------------------------------------------------------------------------------------ */

export type SourceFailureKind =
  | ProviderErrorKind
  | 'provider-unavailable'
  | 'budget'
  | 'packet-validation'
  | 'internal';

export interface SourceFailure {
  kind: SourceFailureKind;
  message: string;
  detail: Record<string, unknown> | null;
  /** Whether an identical retry could plausibly succeed without an operator changing something. */
  retryable: boolean;
}

/**
 * Kinds an automatic retry can never fix. `cli-missing`, `cli-too-old`,
 * `model-unsupported` and `auth` all need an operator; `budget` needs a bigger budget or
 * re-windowing; `provider-unavailable` needs the provider to exist.
 */
const NON_RETRYABLE_KINDS = new Set<SourceFailureKind>([
  'cli-missing',
  'cli-too-old',
  'model-unsupported',
  'auth',
  'provider-unavailable',
  'budget',
]);

/** A failure raised by the pipeline itself rather than by a provider. */
export class SourcePipelineFailure extends Error {
  readonly kind: SourceFailureKind;

  constructor(kind: SourceFailureKind, message: string) {
    super(message);
    this.name = 'SourcePipelineFailure';
    this.kind = kind;
  }
}

/** Errors already written to the job and intake rows, so an outer handler does not double-record. */
const recordedFailures = new WeakSet<object>();

export function classifySourceFailure(error: unknown): SourceFailure {
  if (isProviderError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      detail: error.toJSON(),
      retryable: !NON_RETRYABLE_KINDS.has(error.kind),
    };
  }
  if (error instanceof SourcePipelineFailure) {
    return {
      kind: error.kind,
      message: error.message,
      detail: { name: error.name, kind: error.kind, message: error.message },
      retryable: !NON_RETRYABLE_KINDS.has(error.kind),
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Structured extraction failed.');
  const packetValidation = /^Packet schema validation failed|no longer satisfies its recorded contract/.test(message);
  const kind: SourceFailureKind = packetValidation ? 'packet-validation' : 'internal';
  return {
    kind,
    message,
    detail: { name: error instanceof Error ? error.name : typeof error, kind, message },
    retryable: !NON_RETRYABLE_KINDS.has(kind),
  };
}

export interface RecoveryContext {
  providerId?: string | null;
  attemptCount?: number;
  maxAttempts?: number;
  willRetry?: boolean;
}

/** A concrete instruction, never "an error occurred". This string is what the operator acts on. */
export function recoveryActionFor(failure: SourceFailure, context: RecoveryContext = {}): string {
  const provider = context.providerId?.trim() || 'the configured extraction provider';
  const attempts = context.maxAttempts && context.attemptCount
    ? ` (attempt ${context.attemptCount} of ${context.maxAttempts})`
    : '';
  if (context.willRetry) {
    return `Automatic retry ${Number(context.attemptCount ?? 0) + 1} of ${context.maxAttempts ?? 0} is scheduled; no action is needed unless it also fails.`;
  }
  switch (failure.kind) {
    case 'cli-missing':
      return `Install ${provider} and make it available on PATH, then retry this source from the quarantine lane.`;
    case 'cli-too-old':
      return `Upgrade ${provider} to a version that supports the configured model, then retry this source from the quarantine lane. Retrying without upgrading will fail identically.`;
    case 'model-unsupported':
      return `Configure a model that ${provider} supports (or upgrade it), then retry this source from the quarantine lane. Retrying with the same model will fail identically.`;
    case 'auth':
      return `Sign in to ${provider} on this machine, then retry this source from the quarantine lane.`;
    case 'provider-unavailable':
      return `Make ${provider} available, then retry this source. The normalised source, segments and windows are already stored, so no re-upload is needed. Alternatively record an explicit comprehension skip with a reason.`;
    case 'transient':
      return `The provider failed transiently and the retry budget${attempts} is spent. Retry this source from the quarantine lane once the provider is reachable.`;
    case 'malformed-output':
      return `${provider} returned output that does not satisfy the extraction contract on every allowed attempt${attempts}. Read error_detail_json for the captured stdout/stderr, then retry this source from the quarantine lane.`;
    case 'packet-validation':
      return `The assembled packet failed contract validation. Read the recorded validation issues, correct the extraction skill or provider, then retry this source from the quarantine lane.`;
    case 'budget':
      return 'The extraction exceeded its configured budget. Raise the budget for this source type or re-window the source, then retry from the quarantine lane.';
    case 'unknown':
    case 'internal':
    default:
      return `The extraction stopped with an unclassified error${attempts}. Read error_message and error_detail_json on the job row, then retry this source from the quarantine lane.`;
  }
}

function readSourceDocument(db: DatabaseSync, sourceId: string): SourceDocumentRow | undefined {
  return db.prepare('SELECT * FROM source_documents WHERE id = ?').get(sourceId) as SourceDocumentRow | undefined;
}

function readJob(db: DatabaseSync, jobId: string): SourceJobRow | undefined {
  return db.prepare('SELECT * FROM source_processing_jobs WHERE id = ?').get(jobId) as SourceJobRow | undefined;
}

function jobIdForSource(source: Pick<SourceDocumentRow, 'project_id' | 'content_hash'>): string {
  return sourceJobId(source.project_id, source.content_hash);
}

function resolveIntakeId(db: DatabaseSync, source: SourceDocumentRow): string | null {
  if (source.intake_source_id) return source.intake_source_id;
  const row = db.prepare('SELECT id FROM project_source_intake WHERE project_id = ? AND content_hash = ? LIMIT 1')
    .get(source.project_id, source.content_hash) as { id: string } | undefined;
  return row ? String(row.id) : null;
}

interface IntakeState {
  /** Constrained to the values `inboxSourceSchema` accepts; the finer state lives in `processing_stage`. */
  status?: 'awaiting_processing' | 'processing' | 'awaiting_review' | 'failed';
  stage: string;
  error?: string | null;
  recoveryAction?: string | null;
}

function setIntakeState(db: DatabaseSync, intakeId: string | null, state: IntakeState): void {
  if (!intakeId) return;
  const timestamp = nowIso();
  db.prepare(`UPDATE project_source_intake
    SET processing_status = COALESCE(?, processing_status),
        processing_stage = ?,
        processing_error = ?,
        processing_recovery_action = ?,
        processing_updated_at = ?,
        updated_at = ?
    WHERE id = ?`)
    .run(state.status ?? null, state.stage, state.error ?? null, state.recoveryAction ?? null, timestamp, timestamp, intakeId);
}

function setJobState(db: DatabaseSync, source: SourceDocumentRow, status: string, stage: string, error: string | null): void {
  const timestamp = nowIso();
  db.prepare(`UPDATE source_processing_jobs
    SET status = ?, current_stage = ?, error_message = ?, updated_at = ?,
        completed_at = CASE WHEN ? IN ('quarantined', 'failed') THEN ? ELSE completed_at END
    WHERE id = ?`)
    .run(status, stage, error, timestamp, status, timestamp, jobIdForSource(source));
}

export interface QuarantineOptions {
  kind?: SourceFailureKind;
  detail?: Record<string, unknown> | null;
  recoveryAction?: string;
  stage?: string;
}

/**
 * Terminal, readable failure state. Writes the job row (machine state) *and* the intake
 * row (what the Cockpit renders) so an extraction failure can never again be invisible
 * outside the database.
 */
export function quarantineSourceJob(db: DatabaseSync, sourceId: string, reason: string, options: QuarantineOptions = {}): void {
  const source = readSourceDocument(db, sourceId);
  if (!source) throw new Error(`Source document ${sourceId} was not found.`);
  const kind = options.kind ?? 'internal';
  const recoveryAction = options.recoveryAction
    ?? recoveryActionFor({ kind, message: reason, detail: options.detail ?? null, retryable: !NON_RETRYABLE_KINDS.has(kind) });
  const stage = options.stage ?? 'quarantined';
  const timestamp = nowIso();
  setJobState(db, source, 'quarantined', stage, reason);
  db.prepare(`UPDATE source_processing_jobs
    SET error_kind = ?, error_detail_json = ?, recovery_action = ?, last_error_at = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ?`)
    .run(kind, options.detail ? JSON.stringify(options.detail) : null, recoveryAction, timestamp, jobIdForSource(source));
  db.prepare("UPDATE source_windows SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END, explanation = COALESCE(explanation, ?) WHERE source_id = ?")
    .run(reason, sourceId);
  setIntakeState(db, resolveIntakeId(db, source), {
    status: 'failed',
    stage,
    error: reason,
    recoveryAction,
  });
}

/** Classify, record on both rows, and mark the error so an outer handler does not repeat the work. */
function recordSourceFailure(db: DatabaseSync, source: SourceDocumentRow, error: unknown, providerId?: string | null): SourceFailure {
  const failure = classifySourceFailure(error);
  const job = readJob(db, jobIdForSource(source));
  const recoveryAction = recoveryActionFor(failure, {
    providerId,
    attemptCount: job ? Number(job.attempt_count) : undefined,
    maxAttempts: job ? Number(job.max_attempts) : undefined,
  });
  quarantineSourceJob(db, source.id, failure.message, { kind: failure.kind, detail: failure.detail, recoveryAction });
  if (error && typeof error === 'object') recordedFailures.add(error as object);
  return failure;
}

function failWith(db: DatabaseSync, source: SourceDocumentRow, kind: SourceFailureKind, message: string, providerId?: string | null): SourcePipelineFailure {
  const error = new SourcePipelineFailure(kind, message);
  recordSourceFailure(db, source, error, providerId);
  return error;
}

/* ------------------------------------------------------------------------------------ *
 * Leases, crash recovery and bounded retry (D2)
 * ------------------------------------------------------------------------------------ */

export interface ClaimResult {
  claimed: boolean;
  jobId: string;
  attemptCount: number;
  maxAttempts: number;
  detail?: string;
}

/**
 * Take ownership of a job for one attempt. A job whose lease is still live and held by
 * someone else is never stolen; everything else (queued, retry-pending, quarantined on an
 * explicit retry, or abandoned with an expired lease) is claimable.
 */
export function claimSourceJob(db: DatabaseSync, input: { jobId: string; owner?: string; leaseMs?: number; now?: number }): ClaimResult {
  const owner = input.owner ?? PROCESS_LEASE_OWNER;
  const leaseMs = input.leaseMs ?? SOURCE_JOB_LEASE_MS;
  const now = input.now ?? Date.now();
  const job = readJob(db, input.jobId);
  if (!job) return { claimed: false, jobId: input.jobId, attemptCount: 0, maxAttempts: 0, detail: 'Job row does not exist.' };
  const leaseLive = job.lease_expires_at !== null && job.lease_expires_at > new Date(now).toISOString();
  if (leaseLive && job.lease_owner !== owner) {
    return {
      claimed: false,
      jobId: job.id,
      attemptCount: Number(job.attempt_count),
      maxAttempts: Number(job.max_attempts),
      detail: `Job is leased by ${job.lease_owner} until ${job.lease_expires_at}.`,
    };
  }
  const attemptCount = Number(job.attempt_count) + 1;
  const timestamp = new Date(now).toISOString();
  db.prepare(`UPDATE source_processing_jobs
    SET status = 'processing', current_stage = 'extracting', attempt_count = ?, lease_owner = ?, lease_expires_at = ?,
        error_message = NULL, error_kind = NULL, error_detail_json = NULL, recovery_action = NULL,
        completed_at = NULL, updated_at = ?
    WHERE id = ?`)
    .run(attemptCount, owner, isoAfter(leaseMs, now), timestamp, job.id);
  const source = db.prepare('SELECT * FROM source_documents WHERE project_id = ? AND intake_source_id = ?').get(job.project_id, job.source_id) as SourceDocumentRow | undefined;
  setIntakeState(db, source ? resolveIntakeId(db, source) : job.source_id, { status: 'processing', stage: 'extracting', error: null, recoveryAction: null });
  return { claimed: true, jobId: job.id, attemptCount, maxAttempts: Number(job.max_attempts) };
}

/** Heartbeat. Called between provider calls so a long but healthy extraction is never reclaimed. */
export function renewSourceJobLease(db: DatabaseSync, jobId: string, owner: string, leaseMs = SOURCE_JOB_LEASE_MS): void {
  db.prepare('UPDATE source_processing_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?')
    .run(isoAfter(leaseMs), nowIso(), jobId, owner);
}

export function releaseSourceJobLease(db: DatabaseSync, jobId: string): void {
  db.prepare('UPDATE source_processing_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso(), jobId);
}

/** Move a job back to a retryable state between two automatic attempts. */
export function markSourceJobForRetry(db: DatabaseSync, jobId: string, detail: string, recoveryAction: string): void {
  const timestamp = nowIso();
  db.prepare(`UPDATE source_processing_jobs
    SET status = 'queued', current_stage = 'retry-pending', recovery_action = ?, error_message = ?,
        completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ?`)
    .run(recoveryAction, detail, timestamp, jobId);
  const job = readJob(db, jobId);
  if (job) setIntakeState(db, job.source_id, { status: 'processing', stage: 'retry-pending', error: detail, recoveryAction });
}

export interface ReclaimedSourceJob {
  jobId: string;
  projectId: string;
  intakeSourceId: string;
  sourceDocumentId: string | null;
  attemptCount: number;
  maxAttempts: number;
  action: 'requeued' | 'quarantined';
  detail: string;
}

/** Job statuses that mean "a process is supposed to be working on this right now". */
const IN_FLIGHT_STATUSES = ['processing', 'extracting', 'assembling', 'validating', 'reconciling', 'applying'];

/**
 * Crash recovery. A job whose lease expired — or which was left in flight by a process
 * that died before leases existed — is reclaimed: requeued if it still has retry budget,
 * quarantined with a reason if it does not. A job with a live lease is never touched.
 *
 * Run this once at startup and then periodically; see {@link startSourceJobSweeper}.
 */
export function sweepStalledSourceJobs(db: DatabaseSync, options: { now?: number; leaseMs?: number } = {}): ReclaimedSourceJob[] {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? SOURCE_JOB_LEASE_MS;
  const nowIsoValue = new Date(now).toISOString();
  const graceIso = new Date(now - leaseMs).toISOString();
  const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(', ');
  const stalled = db.prepare(`SELECT * FROM source_processing_jobs
    WHERE status IN (${placeholders})
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        OR (lease_expires_at IS NULL AND COALESCE(updated_at, started_at, '') <= ?)
      )
    ORDER BY id`)
    .all(...IN_FLIGHT_STATUSES, nowIsoValue, graceIso) as unknown as SourceJobRow[];

  const reclaimed: ReclaimedSourceJob[] = [];
  for (const job of stalled) {
    const attemptCount = Number(job.attempt_count);
    const maxAttempts = Number(job.max_attempts);
    const source = db.prepare('SELECT * FROM source_documents WHERE project_id = ? AND intake_source_id = ?')
      .get(job.project_id, job.source_id) as SourceDocumentRow | undefined;
    const exhausted = attemptCount >= maxAttempts;
    const detail = exhausted
      ? `Extraction stopped without completing (lease expired at ${job.lease_expires_at ?? 'never claimed'}) and the retry budget of ${maxAttempts} attempts is spent.`
      : `Extraction stopped without completing (lease expired at ${job.lease_expires_at ?? 'never claimed'}); the job was reclaimed and queued for retry after ${attemptCount} of ${maxAttempts} attempts.`;
    if (exhausted) {
      const failure: SourceFailure = { kind: 'transient', message: detail, detail: { reclaimedAt: nowIsoValue, leaseOwner: job.lease_owner, attemptCount, maxAttempts }, retryable: false };
      const recoveryAction = recoveryActionFor(failure, { attemptCount, maxAttempts });
      if (source) {
        quarantineSourceJob(db, source.id, detail, { kind: 'transient', detail: failure.detail, recoveryAction, stage: 'quarantined' });
      } else {
        db.prepare(`UPDATE source_processing_jobs
          SET status = 'quarantined', current_stage = 'quarantined', error_message = ?, error_kind = 'transient',
              error_detail_json = ?, recovery_action = ?, last_error_at = ?, completed_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`)
          .run(detail, JSON.stringify(failure.detail), recoveryAction, nowIsoValue, nowIsoValue, nowIsoValue, job.id);
        setIntakeState(db, job.source_id, { status: 'failed', stage: 'quarantined', error: detail, recoveryAction });
      }
      reclaimed.push({ jobId: job.id, projectId: job.project_id, intakeSourceId: job.source_id, sourceDocumentId: source?.id ?? null, attemptCount, maxAttempts, action: 'quarantined', detail });
      continue;
    }
    const recoveryAction = `Queued for retry (attempt ${attemptCount + 1} of ${maxAttempts}) after the previous run stopped without releasing its lease. No re-upload is needed.`;
    db.prepare(`UPDATE source_processing_jobs
      SET status = 'queued', current_stage = 'reclaimed', error_message = ?, error_kind = 'transient',
          error_detail_json = ?, recovery_action = ?, last_error_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          completed_at = NULL, updated_at = ?
      WHERE id = ?`)
      .run(detail, JSON.stringify({ reclaimedAt: nowIsoValue, previousLeaseOwner: job.lease_owner, attemptCount, maxAttempts }), recoveryAction, nowIsoValue, nowIsoValue, job.id);
    setIntakeState(db, job.source_id, { status: 'awaiting_processing', stage: 'reclaimed', error: detail, recoveryAction });
    reclaimed.push({ jobId: job.id, projectId: job.project_id, intakeSourceId: job.source_id, sourceDocumentId: source?.id ?? null, attemptCount, maxAttempts, action: 'requeued', detail });
  }
  return reclaimed;
}

export interface SourceJobSweeper {
  sweepNow(): ReclaimedSourceJob[];
  stop(): void;
}

/**
 * Startup + periodic sweep. Call once on server start: it sweeps immediately (crash
 * recovery for whatever the previous process left behind) and then on a timer.
 */
export function startSourceJobSweeper(db: DatabaseSync, options: {
  intervalMs?: number;
  leaseMs?: number;
  onReclaim?: (jobs: ReclaimedSourceJob[]) => void;
} = {}): SourceJobSweeper {
  const intervalMs = options.intervalMs ?? SOURCE_JOB_SWEEP_INTERVAL_MS;
  const sweepNow = () => {
    const reclaimed = sweepStalledSourceJobs(db, { leaseMs: options.leaseMs });
    if (reclaimed.length > 0) options.onReclaim?.(reclaimed);
    return reclaimed;
  };
  sweepNow();
  const timer = setInterval(() => {
    try {
      sweepNow();
    } catch {
      /* the sweeper must never take the process down; the next tick retries */
    }
  }, intervalMs);
  timer.unref?.();
  return { sweepNow, stop: () => clearInterval(timer) };
}

/* ------------------------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------------------------ */

/**
 * Attach the versioned skill provenance to a run row.
 *
 * Recorded per run: skill id, skill version, prompt-template version and packet
 * contract version, alongside the skill and prompt hashes the row already
 * carried. With provider and model that is the full answer to "what asked for
 * this, and under which contract".
 */
function recordRunProvenance(db: DatabaseSync, resolved: Parameters<typeof runProvenanceOf>[0], runId: string): string {
  recordExtractionRunProvenance(db, runId, runProvenanceOf(resolved));
  return runId;
}

function insertRun(db: DatabaseSync, input: {
  source: SourceDocumentRow;
  projectId: string;
  providerId: string;
  modelLabel: string;
  skillSha256: string;
  promptSha256: string;
  usage: ProviderUsage;
  startedAt: string;
  durationMs: number;
  status: string;
  error: string | null;
  outputSha256: string | null;
  stage?: string;
}): string {
  const id = `extract:${input.source.id}:${randomUUID()}`;
  db.prepare(`INSERT INTO extraction_runs
    (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256, input_token_source, output_token_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.source.id, input.projectId, input.stage ?? 'structured-extraction', input.providerId, input.modelLabel,
      input.skillSha256, input.promptSha256, input.usage.inputTokens, input.usage.outputTokens, input.usage.sourceTokens,
      input.startedAt, input.durationMs, input.status, input.error, input.outputSha256,
      input.usage.inputTokenSource ?? 'estimated', input.usage.outputTokenSource ?? 'estimated');
  return id;
}

/**
 * Recompute per-register coverage from the rows that actually reached the packet.
 *
 * `lostByRegister` is what makes this honest. When rows were excluded — an
 * unknown key, a conflicting duplicate reference — the surviving count no longer
 * describes the source, and the packet must not say "no items were found" about
 * a register whose items we dropped. That sentence would be sealed under
 * `packet_sha256` as a false statement about the transcript, and it would
 * satisfy the `category-explanation` gate with fabricated text.
 */
function aggregateCategoryCoverage(
  rows: Array<{ registerName: SourceIntelligenceCategory; row: SourcePacketRow }>,
  entries: ExtractionCoverage[],
  lostByRegister: Map<string, number> = new Map(),
): ExtractionCoverage[] {
  return SOURCE_INTELLIGENCE_CATEGORIES.map((category) => {
    const categoryEntries = entries.filter((entry) => entry.key === category);
    const itemCount = rows.filter((row) => row.registerName === category).length;
    const lost = lostByRegister.get(category) ?? 0;
    const statuses = new Set(categoryEntries.map((entry) => entry.status));
    let status: CoverageStatus;
    if (statuses.has('failed') || categoryEntries.length === 0) status = 'failed';
    // Rows were dropped here, so this register's coverage is genuinely uncertain
    // whatever the provider reported about it.
    else if (lost > 0) status = 'uncertain';
    else if (statuses.has('uncertain')) status = 'uncertain';
    else if (itemCount > 0) status = 'populated';
    else if ([...statuses].every((value) => value === 'no-governance-content')) status = 'no-governance-content';
    else status = 'none-found';
    const explanations = categoryEntries.map((entry) => entry.explanation).filter((value): value is string => Boolean(value));
    const lossNote = lost > 0 ? `${lost} proposed ${category} row${lost === 1 ? '' : 's'} did not satisfy the row contract and were excluded; this register's coverage is incomplete.` : null;
    const provided = explanations.length > 0 ? [...new Set(explanations)].join(' ') : null;
    const explanation = lossNote
      ? [provided, lossNote].filter(Boolean).join(' ')
      : provided ?? (itemCount === 0 ? `No ${category} items were found in the reviewed source windows.` : null);
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

export interface FrozenSourceHandoff {
  packetId: string;
  packetHash: string;
  changesetId: string | null;
  deterministicHash: string | null;
  gateVerdict: string;
  reviewStatus: string | null;
}

/**
 * A frozen packet is an immutable artefact (migration 011 makes that a database rule, not
 * a convention). Re-running extraction over a source that already has one would call a
 * provider to produce something we are forbidden to overwrite, so every entry point
 * checks this first and returns the existing handoff with zero provider calls.
 */
export function readFrozenSourceHandoff(db: DatabaseSync, sourceId: string): FrozenSourceHandoff | null {
  const packet = db.prepare('SELECT id, packet_sha256, validation_status FROM extraction_packets WHERE source_id = ? ORDER BY assembled_at DESC LIMIT 1')
    .get(sourceId) as { id: string; packet_sha256: string; validation_status: string } | undefined;
  if (!packet) return null;
  const changeset = db.prepare('SELECT id, deterministic_hash, gate_verdict, review_status FROM register_changesets WHERE packet_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(packet.id) as { id: string; deterministic_hash: string; gate_verdict: string; review_status: string } | undefined;
  return {
    packetId: String(packet.id),
    packetHash: String(packet.packet_sha256),
    changesetId: changeset ? String(changeset.id) : null,
    deterministicHash: changeset ? String(changeset.deterministic_hash) : null,
    gateVerdict: changeset ? String(changeset.gate_verdict) : String(packet.validation_status),
    reviewStatus: changeset ? String(changeset.review_status) : null,
  };
}

/** Bring a job row into line with an already frozen packet, without touching the packet. */
function reconcileJobToFrozenPacket(db: DatabaseSync, source: SourceDocumentRow, frozen: FrozenSourceHandoff): void {
  const timestamp = nowIso();
  const quarantined = frozen.gateVerdict === 'quarantined';
  const applied = frozen.reviewStatus === 'applied';
  const status = quarantined ? 'quarantined' : applied ? 'complete' : 'awaiting_review';
  db.prepare(`UPDATE source_processing_jobs
    SET status = ?, current_stage = ?, packet_id = ?, changeset_id = ?, lease_owner = NULL, lease_expires_at = NULL,
        completed_at = COALESCE(completed_at, ?), updated_at = ?
    WHERE id = ?`)
    .run(status, status, frozen.packetId, frozen.changesetId, timestamp, timestamp, jobIdForSource(source));
  setIntakeState(db, resolveIntakeId(db, source), {
    status: quarantined ? 'failed' : 'awaiting_review',
    stage: status,
    error: quarantined ? 'The frozen packet for this source failed its validation gate; review it in the quarantine lane.' : null,
    recoveryAction: quarantined ? 'Open the quarantine lane and read the named failing rules on the frozen packet. Extraction is not re-run: the packet is immutable evidence.' : null,
  });
}

export async function orchestrateSourceExtraction(db: DatabaseSync, options: SourceExtractionOptions) {
  const source = readSourceDocument(db, options.sourceId);
  if (!source) throw new Error(`Source document ${options.sourceId} was not found.`);
  try {
    return await runSourceExtraction(db, options, source);
  } catch (error) {
    if (!error || typeof error !== 'object' || !recordedFailures.has(error as object)) {
      recordSourceFailure(db, source, error, options.provider?.identity.providerId ?? null);
    }
    throw error;
  }
}

async function runSourceExtraction(db: DatabaseSync, options: SourceExtractionOptions, source: SourceDocumentRow) {
  const project = db.prepare('SELECT id, code FROM projects WHERE id = ?').get(source.project_id) as { id: string; code: string } | undefined;
  if (!project) throw new Error(`Project ${source.project_id} was not found.`);
  const provider = options.provider;
  if (provider) assertIdentity(provider);
  const jobId = jobIdForSource(source);
  const started = Date.now();

  const frozen = readFrozenSourceHandoff(db, source.id);
  if (frozen) {
    reconcileJobToFrozenPacket(db, source, frozen);
    return {
      packetId: frozen.packetId,
      packetHash: frozen.packetHash,
      changesetId: frozen.changesetId,
      deterministicHash: frozen.deterministicHash,
      gateVerdict: frozen.gateVerdict,
      validation: null,
      sourceId: source.id,
      provider: provider?.identity ?? { providerId: 'frozen-packet', modelLabel: 'no-call' },
      runs: [] as string[],
      calls: 0,
      inputTokens: 0,
      sourceTokenRepetition: 0,
      durationMs: Date.now() - started,
      suggestedMarkerDismissals: [] as Array<{ markerId: string; reason: string }>,
      // No provider call was made, so no extraction skill was in force on this pass. The
      // contract that produced the frozen packet is recorded on its runs, not re-asserted here.
      skill: null as { sha256: string; origin: 'built-in' | 'external-file'; path: string | null; characters: number } | null,
      alreadyFrozen: true as const,
    };
  }

  const budget = resolvedBudget(source.source_type, Number(source.word_count), options.budget);
  // The recorded hash is the hash of the text actually sent, whether that is the built-in
  // constant or an external skill document injected by path. Resolved once so every call in
  // this extraction is provably graded against the same contract.
  // The instructional contract comes from the versioned registry, not from a
  // constant in this file: revisions are created, pinned, promoted and rolled
  // back as data. What we ACCEPT stays fixed in code.
  ensureSkillRegistrySynced(db);
  const resolvedSkill = resolveSkillForRun(db, project.id, { legacySkill: resolveExtractionSkill() });
  const skillSha256 = resolvedSkill.sha256;
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
    throw failWith(db, source, 'budget', message, provider?.identity.providerId);
  }
  if (slices.length > 0 && (!provider || !provider.isAvailable())) {
    const message = `Provider ${provider?.identity.providerId ?? 'none'} is unavailable; source remains quarantined for retry or explicit comprehension skip.`;
    throw failWith(db, source, 'provider-unavailable', message, provider?.identity.providerId);
  }

  setJobState(db, source, 'processing', 'extracting', null);
  setIntakeState(db, resolveIntakeId(db, source), { status: 'processing', stage: 'extracting', error: null, recoveryAction: null });
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
  // Which attempt on this source these responses belong to. Preserved outputs
  // from an earlier, failed attempt must remain distinguishable from this one's:
  // they are the evidence that the model already answered once.
  const attemptLabel = `attempt-${String(Number((db.prepare('SELECT attempt_count FROM source_processing_jobs WHERE id = ?').get(jobId) as { attempt_count: number } | undefined)?.attempt_count ?? 0)).padStart(2, '0')}`;
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
    const assembled = assembleExtractionPrompt(partialRequest, resolvedSkill);
    const prompt = assembled.prompt;
    const promptSha256 = assembled.promptSha256;
    // Preservation is wired per call so the handle it returns is in scope for the
    // outcome record below. The provider is contractually required to invoke it
    // before it parses anything, which is what makes a completed response
    // survive every downstream defect.
    // `outcomeRecorded` guards the catch below: a response that PARSED and
    // produced a completed run must not be relabelled `rejected` because the
    // pass failed afterwards on a budget or merge gate. The parse status
    // describes the parse, not everything that happened next.
    const preserved: { id: string | null; outcomeRecorded: boolean } = { id: null, outcomeRecorded: false };
    const preserveRawOutput = (event: RawProviderResponse): string | null => {
      const record = preserveProviderOutput(db, {
        sourceId: source.id,
        projectId: project.id,
        stage: 'structured-extraction',
        callIndex: slice.callIndex,
        attemptLabel: String(attemptLabel),
        providerId: provider!.identity.providerId,
        modelLabel: provider!.identity.modelLabel,
        skillId: resolvedSkill.skillId,
        skillVersion: resolvedSkill.version,
        skillSha256,
        promptTemplateVersion: resolvedSkill.promptTemplateVersion,
        promptSha256,
        packetContractVersion: resolvedSkill.packetContractVersion,
        windowKeys: slice.windows.map((window) => window.seq),
        requestedAt: event.requestedAt,
        receivedAt: event.receivedAt,
        durationMs: event.durationMs,
        raw: event.raw,
        inputTokens: event.reportedInputTokens ?? estimateTokens(prompt),
        outputTokens: event.reportedOutputTokens ?? estimateTokens(event.raw),
        inputTokenSource: event.reportedInputTokens === undefined || event.reportedInputTokens === null ? 'estimated' : 'provider-reported',
        outputTokenSource: event.reportedOutputTokens === undefined || event.reportedOutputTokens === null ? 'estimated' : 'provider-reported',
      });
      preserved.id = record.id;
      return record.id;
    };
    const request: StructuredExtractionRequest = { ...partialRequest, prompt, promptSha256, skillSha256, preserveRawOutput };
    const projectedInput = totalInputTokens + estimateTokens(prompt);
    const projectedRepetition = (totalSourceTokens + slice.estimatedSourceTokens) / sourceTokens;
    if (projectedInput > budget.maxInputTokens || projectedRepetition > budget.maxSourceRepetition || Date.now() - started > budget.maxWallClockMs) {
      throw failWith(db, source, 'budget', `Extraction budget would be exceeded before call ${slice.callIndex}.`, provider!.identity.providerId);
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
      const runId = recordRunProvenance(db, resolvedSkill, insertRun(db, {
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
      }));
      runIds.push(runId);
      completedRunRecorded = true;
      if (preserved.id) {
        preserved.outcomeRecorded = true;
        const excluded = result.output.rejectedRows?.length ?? 0;
        recordProviderOutputOutcome(db, preserved.id, {
          parseStatus: excluded > 0 ? 'parsed-with-exclusions' : 'parsed',
          parseDetail: excluded > 0 ? `${excluded} row(s) failed the row contract and were excluded: ${result.output.rejectedRows!.map((entry) => `#${entry.index} ${entry.reason}`).join(' | ').slice(0, 2000)}` : null,
          runId,
        });
      }
      outputs.push(result.output);
      if (options.leaseOwner) renewSourceJobLease(db, jobId, options.leaseOwner, options.leaseMs);
      if (totalInputTokens > budget.maxInputTokens || totalSourceTokens / sourceTokens > budget.maxSourceRepetition || Date.now() - started > budget.maxWallClockMs) {
        throw failWith(db, source, 'budget', `Provider telemetry exceeded the configured extraction budget after call ${slice.callIndex}.`, provider!.identity.providerId);
      }
    } catch (error) {
      const failure = classifySourceFailure(error);
      // A response that arrived and then failed to parse is still preserved; the
      // record says so rather than being silently left as `received`.
      // The detail names the failure KIND and points at the preserved artefact.
      // It deliberately does not carry `failure.message`, which for a
      // malformed-output error embeds an excerpt of the provider's raw stdout —
      // source-derived customer material that migration 013 keeps out of the
      // database on purpose.
      if (preserved.id && !preserved.outcomeRecorded) {
        recordProviderOutputOutcome(db, preserved.id, {
          parseStatus: 'rejected',
          parseDetail: `Rejected at the provider boundary (${failure.kind}). The complete response is preserved; read it from this record's artefact path.`,
        });
      }
      if (!completedRunRecorded) {
        recordRunProvenance(db, resolvedSkill, insertRun(db, {
          source,
          projectId: project.id,
          providerId: provider!.identity.providerId,
          modelLabel: provider!.identity.modelLabel,
          skillSha256,
          promptSha256,
          usage: { inputTokens: estimateTokens(prompt), outputTokens: 0, sourceTokens: slice.estimatedSourceTokens, inputTokenSource: 'estimated', outputTokenSource: 'estimated' },
          startedAt,
          durationMs: Date.now() - callStarted,
          status: 'failed',
          error: failure.message,
          outputSha256: null,
        }));
      }
      if (!(error && typeof error === 'object' && recordedFailures.has(error as object))) {
        recordSourceFailure(db, source, error, provider!.identity.providerId);
      }
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
    runIds.push(recordRunProvenance(db, resolvedSkill, insertRun(db, {
      source,
      projectId: project.id,
      providerId: 'deterministic-comprehension-skip',
      modelLabel: 'code-path-v1',
      skillSha256,
      promptSha256: sha256('deterministic-comprehension-skip-v1'),
      usage: { inputTokens: 0, outputTokens: 0, sourceTokens: 0, inputTokenSource: 'estimated', outputTokenSource: 'estimated' },
      startedAt: nowIso(),
      durationMs: Date.now() - started,
      status: 'completed',
      error: null,
      outputSha256: sha256(outputJson),
      stage: 'comprehension-skip',
    })));
    outputs.push(output);
  }

  // Windows overlap, so the same statement legitimately reaches two calls. An
  // identical restatement dedupes silently; a CONFLICTING restatement of the same
  // client_ref is a real disagreement about what the source says, and neither
  // variant may be quietly preferred. Both are excluded and recorded, so the
  // reviewer sees a gap rather than an arbitrary winner. Aborting the whole pass
  // instead — which is what this did — discarded every other row in a
  // twenty-five-minute extraction over one duplicated reference.
  const rowsByRef = new Map<string, { registerName: SourceIntelligenceCategory; row: SourcePacketRow; serialized: string }>();
  const conflictingRefs = new Set<string>();
  for (const entry of outputs.flatMap((output) => output.rows)) {
    const serialized = stable(entry);
    const existing = rowsByRef.get(entry.row.client_ref);
    if (existing && existing.serialized !== serialized) conflictingRefs.add(entry.row.client_ref);
    else if (!existing) rowsByRef.set(entry.row.client_ref, { ...entry, serialized });
  }
  const conflictRegisters = new Map<string, string>();
  for (const entry of outputs.flatMap((output) => output.rows)) if (conflictingRefs.has(entry.row.client_ref)) conflictRegisters.set(entry.row.client_ref, entry.registerName);
  const mergeConflicts = [...conflictingRefs].sort().map((clientRef) => ({
    clientRef,
    registerName: conflictRegisters.get(clientRef) ?? null,
    reason: 'Overlapping extraction calls proposed different content for the same client_ref; every variant was excluded because neither can be preferred without a human decision.',
  }));
  for (const clientRef of conflictingRefs) rowsByRef.delete(clientRef);
  const totalEmitted = outputs.reduce((count, output) => count + output.rows.length, 0);
  if (totalEmitted > 0 && conflictingRefs.size / totalEmitted > MAX_MERGE_CONFLICT_RATIO) {
    throw failWith(db, source, 'malformed-output', `${conflictingRefs.size} of ${totalEmitted} emitted rows conflicted across overlapping calls, above the ${Math.round(MAX_MERGE_CONFLICT_RATIO * 100)}% limit.`, provider?.identity.providerId);
  }
  const rows = [...rowsByRef.values()].map(({ registerName, row }) => ({ registerName, row }));
  const windowCoverageByKey = new Map<string, ExtractionCoverage>();
  for (const output of outputs) for (const coverage of output.windowCoverage) windowCoverageByKey.set(coverage.key, coverage);
  for (const window of windows) {
    const skippedReason = skipReasons.get(window.seq);
    if (skippedReason) windowCoverageByKey.set(String(window.seq), { key: String(window.seq), status: 'no-governance-content', itemCount: 0, explanation: skippedReason });
    if (!windowCoverageByKey.has(String(window.seq))) windowCoverageByKey.set(String(window.seq), { key: String(window.seq), status: 'failed', itemCount: 0, explanation: 'Provider omitted explicit coverage for this window.' });
  }
  // Rows the provider emitted that failed row-level validation were dropped, not
  // repaired. They are counted and reported so the loss is visible rather than
  // being mistaken for a source that simply said less.
  const rejectedRows = outputs.flatMap((output) => output.rejectedRows ?? []);
  // Which registers lost rows, so coverage cannot describe them as empty.
  const lostByRegister = new Map<string, number>();
  for (const entry of rejectedRows) if (entry.registerName) lostByRegister.set(entry.registerName, (lostByRegister.get(entry.registerName) ?? 0) + 1);
  for (const conflict of mergeConflicts) {
    const register = conflict.registerName ?? null;
    if (register) lostByRegister.set(register, (lostByRegister.get(register) ?? 0) + 1);
  }
  const categoryCoverage = aggregateCategoryCoverage(rows, outputs.flatMap((output) => output.categoryCoverage), lostByRegister);
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
  // Marker dismissal is one of the two ways the design lets a HIGH marker be
  // accounted for, but the model's dismissals previously never reached the
  // database before the gate read it — so option (b) was a guaranteed
  // quarantine and the only survivable answer was to discharge everything.
  // Model dismissals are recorded as PROPOSALS, clearly attributed, and the
  // validator caps how much of the checklist may be answered this way.
  const proposedDismissals = outputs.flatMap((output) => output.markerDismissals ?? []);
  if (proposedDismissals.length > 0) {
    dismissSourceMarkers(db, source.id, proposedDismissals.map((dismissal) => ({
      markerId: dismissal.markerId,
      reason: `model-proposed (${provider?.identity.providerId ?? 'unknown'}): ${dismissal.reason.trim()}`,
    })));
  }
  const handoff = freezePacketAndCreateChangeset(db, packet, {
    // Everything the provider emitted that did not survive into the packet is
    // reported with the packet, so a reviewer sees what was lost and why.
    providerAnomalies: [
      ...rejectedRows.map((entry) => ({ kind: 'rejected-row' as const, detail: `Row ${entry.index}${entry.registerName ? ` (${entry.registerName})` : ''} was excluded: ${entry.reason}` })),
      ...mergeConflicts.map((entry) => ({ kind: 'merge-conflict' as const, detail: `client_ref ${entry.clientRef}: ${entry.reason}` })),
    ],
    skillProvenance: packetSkillProvenance(db, runIds),
  });
  finaliseJobAfterFreeze(db, source, handoff.gateVerdict);
  return {
    ...handoff,
    sourceId: source.id,
    provider: provider?.identity ?? { providerId: 'deterministic-comprehension-skip', modelLabel: 'code-path-v1' },
    runs: runIds,
    calls: slices.length,
    inputTokens: totalInputTokens,
    sourceTokenRepetition: Number((totalSourceTokens / sourceTokens).toFixed(3)),
    durationMs: Date.now() - started,
    suggestedMarkerDismissals: proposedDismissals,
    rejectedRows,
    mergeConflicts,
    // Which contract this pass was actually graded against. Never the text itself: an external
    // skill document is customer material and must not reach a log, a response or the database.
    skill: {
      ...publicSkillProvenance(resolvedSkill),
      // `origin` predates the registry and is retained so existing consumers and
      // acceptance evidence keep reading the same field.
      origin: resolvedSkill.source === 'external-path' ? 'external-file' : resolvedSkill.source,
    },
    alreadyFrozen: false as const,
  };
}

/**
 * `freezePacketAndCreateChangeset` sets the job status; this releases the lease and moves
 * the intake row with it, so the two never disagree about what happened.
 */
function finaliseJobAfterFreeze(db: DatabaseSync, source: SourceDocumentRow, gateVerdict: string): void {
  releaseSourceJobLease(db, jobIdForSource(source));
  if (gateVerdict === 'quarantined') {
    const reason = 'The frozen packet failed its validation gate; the named blocking rules are recorded on the changeset.';
    const recoveryAction = 'Open the quarantine lane and read the named failing rules. The packet is immutable evidence and is not re-extracted; correct the source or the extraction skill and ingest a corrected source.';
    db.prepare('UPDATE source_processing_jobs SET error_kind = ?, recovery_action = ?, last_error_at = ?, updated_at = ? WHERE id = ?')
      .run('packet-validation', recoveryAction, nowIso(), nowIso(), jobIdForSource(source));
    setIntakeState(db, resolveIntakeId(db, source), { status: 'failed', stage: 'quarantined', error: reason, recoveryAction });
    return;
  }
  setIntakeState(db, resolveIntakeId(db, source), { status: 'awaiting_review', stage: 'awaiting_review', error: null, recoveryAction: null });
}

/* ------------------------------------------------------------------------------------ *
 * Worker entry points (D1, D2)
 * ------------------------------------------------------------------------------------ */

export type SourcePipelineEvent =
  | { type: 'claimed'; jobId: string; sourceId: string; attempt: number; maxAttempts: number }
  | { type: 'completed'; jobId: string; sourceId: string; packetId: string; changesetId: string | null; gateVerdict: string; calls: number }
  | { type: 'failed'; jobId: string; sourceId: string; kind: SourceFailureKind; message: string; recoveryAction: string; attempt: number; maxAttempts: number; willRetry: boolean }
  | { type: 'skipped'; jobId: string; sourceId: string; reason: 'lease-held' | 'already-frozen' | 'no-source' | 'awaiting-metadata' | 'awaiting-duplicate-decision' | 'source-retired'; detail: string };

function defaultPipelineLogger(event: SourcePipelineEvent): void {
  if (event.type === 'failed') {
    console.error(`[source-pipeline] ${event.jobId} ${event.kind}: ${event.message}\n  recovery: ${event.recoveryAction}`);
  }
}

export interface SourceJobRunOptions {
  /** `source_documents.id`. */
  sourceId: string;
  provider?: StructuredExtractionProvider;
  budget?: Partial<ExtractionBudget>;
  skipWindows?: Array<{ seq: number; reason: string }>;
  markerDismissals?: MarkerDismissal[];
  signal?: AbortSignal;
  owner?: string;
  leaseMs?: number;
  /** Overrides and persists `source_processing_jobs.max_attempts` for this job. */
  maxAttempts?: number;
  onEvent?: (event: SourcePipelineEvent) => void;
}

export type SourceExtractionHandoff = Awaited<ReturnType<typeof runSourceExtraction>>;

export interface SourceJobRunResult {
  ok: boolean;
  status: 'completed' | 'already-frozen' | 'quarantined' | 'lease-held' | 'blocked' | 'awaiting-metadata' | 'awaiting-duplicate-decision' | 'source-retired';
  jobId: string;
  sourceId: string;
  providerCalls: number;
  attempts: number;
  kind?: SourceFailureKind;
  message?: string;
  recoveryAction?: string | null;
  extraction?: SourceExtractionHandoff;
}

/**
 * The worker entry point. Claims a lease, runs the extraction, retries the failures that
 * a retry can fix up to `max_attempts`, and always leaves the job in a state a human can
 * read. It resolves rather than rejects: the caller cannot accidentally swallow a failure
 * with `.catch(() => undefined)`, because the failure is in the result and in the event.
 */
export async function runSourceExtractionJob(db: DatabaseSync, options: SourceJobRunOptions): Promise<SourceJobRunResult> {
  const emit = options.onEvent ?? defaultPipelineLogger;
  const owner = options.owner ?? PROCESS_LEASE_OWNER;
  const leaseMs = options.leaseMs ?? SOURCE_JOB_LEASE_MS;
  const source = readSourceDocument(db, options.sourceId);
  if (!source) {
    const detail = `Source document ${options.sourceId} was not found; nothing to extract.`;
    emit({ type: 'skipped', jobId: '', sourceId: options.sourceId, reason: 'no-source', detail });
    return { ok: false, status: 'blocked', jobId: '', sourceId: options.sourceId, providerCalls: 0, attempts: 0, message: detail };
  }
  const jobId = jobIdForSource(source);
  // Goal 1 — the single, centralised gate. Every caller (the direct-upload
  // scheduler, the watched-folder scanner and the stalled-job sweeper) funnels
  // through this function, so enforcing the check here — rather than only at
  // intake — is what stops a sweeper reclaim or a retry from bypassing an
  // unconfirmed source's metadata gate. `metadata_confirmed_at` is the single
  // source of truth; `processing_status` is a display label that mirrors it.
  const intakeId = resolveIntakeId(db, source);
  // Source safety gate, ahead of the metadata gate because it is the cheaper
  // refusal and the more absolute one: a retired source must not be extracted
  // whatever its metadata says.
  const lifecycleState = String((db.prepare('SELECT lifecycle_state FROM source_documents WHERE id = ?').get(source.id) as { lifecycle_state: string } | undefined)?.lifecycle_state ?? 'active');
  if (RETIRED_LIFECYCLE_STATES.includes(lifecycleState as SourceLifecycleState)) {
    const detail = `This source is marked "${LIFECYCLE_LABELS[lifecycleState as SourceLifecycleState] ?? lifecycleState}", so Source Intelligence is not invoked. Retain it as new first if that was a mistake.`;
    emit({ type: 'skipped', jobId, sourceId: source.id, reason: 'source-retired', detail });
    return { ok: false, status: 'source-retired', jobId, sourceId: source.id, providerCalls: 0, attempts: 0, message: detail };
  }
  // A duplicate or overlap verdict nobody has decided yet blocks the provider.
  // This is the single centralised place all three triggers funnel through, so
  // no sweeper reclaim or retry can bypass the decision.
  if (intakeId) {
    const pending = pendingDuplicateDecision(db, intakeId);
    if (pending && pending.blocksExtraction) {
      const detail = `${pending.label}: ${pending.detail} Decide what to do with this source in Inbox before it can be extracted.`;
      emit({ type: 'skipped', jobId, sourceId: source.id, reason: 'awaiting-duplicate-decision', detail });
      return { ok: false, status: 'awaiting-duplicate-decision', jobId, sourceId: source.id, providerCalls: 0, attempts: 0, message: detail };
    }
  }
  const intake = intakeId ? db.prepare('SELECT metadata_confirmed_at FROM project_source_intake WHERE id = ?').get(intakeId) as { metadata_confirmed_at: string | null } | undefined : undefined;
  if (!intake?.metadata_confirmed_at) {
    const detail = 'Meeting subject, event date and primary work package have not been confirmed for this source; Source Intelligence is not invoked until they are. Confirm details in Inbox.';
    emit({ type: 'skipped', jobId, sourceId: source.id, reason: 'awaiting-metadata', detail });
    return { ok: false, status: 'awaiting-metadata', jobId, sourceId: source.id, providerCalls: 0, attempts: 0, message: detail };
  }
  if (options.maxAttempts && options.maxAttempts > 0) {
    db.prepare('UPDATE source_processing_jobs SET max_attempts = ? WHERE id = ?').run(options.maxAttempts, jobId);
  }

  let providerCalls = 0;
  let attempts = 0;
  for (;;) {
    const frozen = readFrozenSourceHandoff(db, source.id);
    if (frozen) {
      reconcileJobToFrozenPacket(db, source, frozen);
      const detail = `Packet ${frozen.packetId} is already frozen for this source; extraction is not re-run and no provider is called.`;
      emit({ type: 'skipped', jobId, sourceId: source.id, reason: 'already-frozen', detail });
      return { ok: true, status: 'already-frozen', jobId, sourceId: source.id, providerCalls, attempts, message: detail };
    }
    const claim = claimSourceJob(db, { jobId, owner, leaseMs });
    if (!claim.claimed) {
      emit({ type: 'skipped', jobId, sourceId: source.id, reason: 'lease-held', detail: claim.detail ?? 'Job could not be claimed.' });
      return { ok: false, status: 'lease-held', jobId, sourceId: source.id, providerCalls, attempts, message: claim.detail };
    }
    attempts = claim.attemptCount;
    emit({ type: 'claimed', jobId, sourceId: source.id, attempt: claim.attemptCount, maxAttempts: claim.maxAttempts });
    try {
      const extraction = await orchestrateSourceExtraction(db, {
        sourceId: source.id,
        provider: options.provider,
        budget: options.budget,
        skipWindows: options.skipWindows,
        markerDismissals: options.markerDismissals,
        signal: options.signal,
        leaseOwner: owner,
        leaseMs,
      });
      providerCalls += extraction.calls;
      releaseSourceJobLease(db, jobId);
      emit({
        type: 'completed',
        jobId,
        sourceId: source.id,
        packetId: extraction.packetId,
        changesetId: extraction.changesetId,
        gateVerdict: extraction.gateVerdict,
        calls: extraction.calls,
      });
      return { ok: true, status: 'completed', jobId, sourceId: source.id, providerCalls, attempts, extraction };
    } catch (error) {
      const failure = classifySourceFailure(error);
      releaseSourceJobLease(db, jobId);
      // Never re-run an extraction that already spent completed provider calls.
      // Automatic retry is for a pass that produced nothing; once the model has
      // answered, a second full multi-call pass costs the same again, doubles the
      // token spend against a budget measured per job, and does it without the
      // operator's consent. Those failures go to the quarantine lane instead.
      const spentCalls = Number((db.prepare("SELECT count(*) count FROM extraction_runs WHERE source_id = ? AND status = 'completed'").get(source.id) as { count: number } | undefined)?.count ?? 0);
      const willRetry = failure.retryable && claim.attemptCount < claim.maxAttempts && spentCalls === 0;
      const recoveryAction = recoveryActionFor(failure, {
        providerId: options.provider?.identity.providerId,
        attemptCount: claim.attemptCount,
        maxAttempts: claim.maxAttempts,
        willRetry,
      });
      emit({
        type: 'failed',
        jobId,
        sourceId: source.id,
        kind: failure.kind,
        message: failure.message,
        recoveryAction,
        attempt: claim.attemptCount,
        maxAttempts: claim.maxAttempts,
        willRetry,
      });
      if (!willRetry) {
        const job = readJob(db, jobId);
        return {
          ok: false,
          status: 'quarantined',
          jobId,
          sourceId: source.id,
          providerCalls,
          attempts,
          kind: failure.kind,
          message: failure.message,
          recoveryAction: job?.recovery_action ?? recoveryAction,
        };
      }
      markSourceJobForRetry(db, jobId, failure.message, recoveryAction);
    }
  }
}

export interface RetrySourceJobInput {
  /** `source-job:<projectId>:<contentHash16>`. Either this or `sourceId` is required. */
  jobId?: string;
  /** `source_documents.id` (SRC-nnn) or `project_source_intake.id`. */
  sourceId?: string;
  provider?: StructuredExtractionProvider;
  budget?: Partial<ExtractionBudget>;
  /** Default true: an operator pressing Retry has asserted the cause is fixed. */
  resetAttempts?: boolean;
  maxAttempts?: number;
  owner?: string;
  leaseMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: SourcePipelineEvent) => void;
}

function resolveJobAndSource(db: DatabaseSync, input: RetrySourceJobInput): { jobId: string; source: SourceDocumentRow | null; job: SourceJobRow | null } {
  if (input.jobId) {
    const job = readJob(db, input.jobId) ?? null;
    const source = job
      ? (db.prepare('SELECT * FROM source_documents WHERE project_id = ? AND intake_source_id = ?').get(job.project_id, job.source_id) as SourceDocumentRow | undefined) ?? null
      : null;
    return { jobId: input.jobId, source, job };
  }
  if (!input.sourceId) throw new Error('retrySourceJob requires either a jobId or a sourceId.');
  const direct = readSourceDocument(db, input.sourceId);
  const source = direct
    ?? (db.prepare('SELECT * FROM source_documents WHERE intake_source_id = ? LIMIT 1').get(input.sourceId) as SourceDocumentRow | undefined)
    ?? null;
  if (source) return { jobId: jobIdForSource(source), source, job: readJob(db, jobIdForSource(source)) ?? null };
  const job = db.prepare('SELECT * FROM source_processing_jobs WHERE source_id = ? ORDER BY updated_at DESC LIMIT 1').get(input.sourceId) as SourceJobRow | undefined;
  return { jobId: job ? String(job.id) : '', source: null, job: job ?? null };
}

/**
 * Operator-facing retry for a quarantined or stalled job. Idempotent: a job whose packet
 * is already frozen is reconciled and returned with **zero** provider calls; a job with no
 * frozen packet is re-extracted from its stored segments and windows, so no re-upload is
 * needed and the content-hash dedup is never in the way.
 */
export async function retrySourceJob(db: DatabaseSync, input: RetrySourceJobInput): Promise<SourceJobRunResult> {
  const { jobId, source, job } = resolveJobAndSource(db, input);
  if (!source) {
    const message = job
      ? `Job ${jobId} has no normalised source document; the source must be re-ingested before extraction can run.`
      : `No source processing job was found for ${input.jobId ?? input.sourceId}.`;
    input.onEvent?.({ type: 'skipped', jobId, sourceId: input.sourceId ?? '', reason: 'no-source', detail: message });
    return { ok: false, status: 'blocked', jobId, sourceId: input.sourceId ?? '', providerCalls: 0, attempts: 0, message };
  }
  if (input.resetAttempts !== false) {
    db.prepare('UPDATE source_processing_jobs SET attempt_count = 0 WHERE id = ?').run(jobId);
  }
  return runSourceExtractionJob(db, {
    sourceId: source.id,
    provider: input.provider,
    budget: input.budget,
    maxAttempts: input.maxAttempts,
    owner: input.owner,
    leaseMs: input.leaseMs,
    signal: input.signal,
    onEvent: input.onEvent,
  });
}

/**
 * Operator-facing "this source carries no project-governance content" path. It produces a
 * reviewable source-only packet with no model call, and goes through the same job
 * bookkeeping as an extraction. Wire it to a route next to the retry route.
 */
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

/* ------------------------------------------------------------------------------------ *
 * Watched Inbox (D3, D11, D12)
 * ------------------------------------------------------------------------------------ */

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
  /**
   * Consecutive scans that must produce the same content hash before a file is enqueued.
   * Two means the bytes are read twice, a poll interval apart, and only enqueued if both
   * reads agree — a stalled writer cannot get a truncated file filed as an immutable
   * original (D11).
   */
  requiredHashConfirmations?: number;
  /** Bounded enqueue attempts per file before the watcher stops re-reading it (D3). */
  maxEnqueueAttempts?: number;
  failureBackoffMs?: number;
  now?: () => number;
  onEvents?: (events: WatchedInboxEvent[]) => void;
}

export interface WatchedInboxEvent {
  path: string;
  status: 'observed' | 'unstable' | 'enqueued' | 'duplicate' | 'ignored' | 'failed' | 'abandoned' | 'inbox-missing' | 'inbox-ready';
  contentHash?: string;
  detail?: string;
}

interface EnqueueFailureState {
  attempts: number;
  nextAttemptAt: number;
  lastMessage: string;
  abandoned: boolean;
  reported: boolean;
}

const ZIP_EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function zipCompletenessIssue(bytes: Buffer): string | null {
  if (bytes.length < 22) return 'the container is shorter than an empty ZIP archive, so the copy is incomplete';
  if (!bytes.subarray(0, 4).equals(ZIP_LOCAL_SIGNATURE) && !bytes.subarray(0, 4).equals(ZIP_EOCD_SIGNATURE)) {
    return 'the file does not begin with a ZIP local-file header, so it is not a complete Office container';
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 66_000));
  const index = tail.lastIndexOf(ZIP_EOCD_SIGNATURE);
  if (index < 0) return 'the ZIP end-of-central-directory record is missing, so the copy is still in progress or truncated';
  const eocd = bytes.length - tail.length + index;
  if (bytes.length - eocd < 22) return 'the ZIP end-of-central-directory record is itself truncated';
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length) return 'the ZIP end-of-central-directory record does not describe the whole file';
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (directoryOffset !== 0xffff_ffff && directorySize !== 0xffff_ffff && directoryOffset + directorySize > bytes.length) {
    return 'the ZIP central directory extends past the end of the file, so the copy is truncated';
  }
  return null;
}

/**
 * Structural completeness, per source type (D11).
 *
 * Quiet-period and hash-stability rules only prove that nothing changed while we were
 * looking. A writer that stalls for several polls defeats both of them, which is how a
 * truncated document was filed as an immutable original. For every format that carries
 * its own end-of-file evidence, check it: a truncated `.docx` has no ZIP
 * end-of-central-directory record, a truncated `.vtt` ends inside a cue, a truncated
 * `.eml` has no header/body separator. Plain text carries no such evidence, so it relies
 * on the quiet-period and hash rules alone — which is stated, not hidden.
 */
export function sourceCompletenessIssue(fileName: string, bytes: Buffer): string | null {
  if (bytes.length === 0) return 'the file is empty';
  const extension = path.extname(fileName).toLowerCase();
  if (['.docx', '.xlsx', '.pptx', '.zip'].includes(extension)) return zipCompletenessIssue(bytes);
  if (extension === '.vtt') {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    if (!/^WEBVTT/.test(text.trimStart())) return 'the transcript does not start with the WEBVTT signature, so the copy is incomplete';
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const last = lines.at(-1) ?? '';
    if (last.includes('-->')) return 'the transcript ends on a cue-timing line with no cue text, so the copy is truncated';
    if (/^\d{1,2}:\d{2}(:\d{2})?([.,]\d{0,3})?$/.test(last)) return 'the transcript ends inside a timestamp, so the copy is truncated';
    return null;
  }
  if (extension === '.eml') {
    const text = bytes.toString('utf8');
    if (!/\r?\n\r?\n/.test(text)) return 'the message has no header/body separator, so the copy is truncated';
    return null;
  }
  return null;
}

interface SeenFile {
  size: number;
  mtimeMs: number;
  unchangedSince: number;
  stableScans: number;
  lastEnqueuedAt: number | null;
  /** Hash observed on a previous scan, awaiting confirmation by an identical re-read. */
  pendingHash: string | null;
  hashConfirmations: number;
  failure: EnqueueFailureState | null;
  /** Bytes refused as structurally incomplete; cleared when the file changes on disk. */
  rejected: { hash: string; reason: string; reported: boolean } | null;
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

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class WatchedInboxScanner {
  private readonly seen = new Map<string, SeenFile>();
  private readonly processedHashes = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private inboxPresent: boolean | null = null;
  private readonly stabilityMs: number;
  private readonly debounceMs: number;
  private readonly minimumStableScans: number;
  private readonly requiredHashConfirmations: number;
  private readonly maxEnqueueAttempts: number;
  private readonly failureBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly options: WatchedInboxScannerOptions) {
    this.stabilityMs = options.stabilityMs ?? 5_000;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.minimumStableScans = options.minimumStableScans ?? 2;
    this.requiredHashConfirmations = Math.max(1, options.requiredHashConfirmations ?? 2);
    this.maxEnqueueAttempts = Math.max(1, options.maxEnqueueAttempts ?? WATCHED_INBOX_MAX_ENQUEUE_ATTEMPTS);
    this.failureBackoffMs = options.failureBackoffMs ?? WATCHED_INBOX_FAILURE_BACKOFF_MS;
    this.now = options.now ?? Date.now;
  }

  /** True once the inbox directory has been seen; false while it is still absent. */
  get inboxAvailable(): boolean {
    return this.inboxPresent === true;
  }

  async scan(): Promise<WatchedInboxEvent[]> {
    if (this.scanning) return [];
    this.scanning = true;
    const events: WatchedInboxEvent[] = [];
    const inboxPath = path.resolve(this.options.inboxPath);
    try {
      let files: string[];
      try {
        files = await listFiles(inboxPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        // D12: the folder may not exist yet (OneDrive still mounting). Keep polling and
        // say so, instead of dropping the project silently until the next restart.
        if (this.inboxPresent !== false) {
          events.push({ path: inboxPath, status: 'inbox-missing', detail: 'Inbox folder is not present yet; the watcher will keep polling and start ingesting when it appears.' });
        }
        this.inboxPresent = false;
        this.seen.clear();
        return events;
      }
      if (this.inboxPresent === false) {
        events.push({ path: inboxPath, status: 'inbox-ready', detail: 'Inbox folder appeared; scanning resumed.' });
      }
      this.inboxPresent = true;
      const present = new Set(files);
      for (const knownPath of [...this.seen.keys()]) if (!present.has(knownPath)) this.seen.delete(knownPath);
      for (const filePath of files) {
        if (ignoredFile.test(path.basename(filePath))) {
          events.push({ path: filePath, status: 'ignored', detail: 'Temporary or incomplete file name.' });
          continue;
        }
        let before: Awaited<ReturnType<typeof stat>>;
        try {
          before = await stat(filePath);
        } catch (error) {
          if (isMissingPathError(error)) {
            this.seen.delete(filePath);
            continue;
          }
          throw error;
        }
        const observedAt = this.now();
        const previous = this.seen.get(filePath);
        if (!previous || previous.size !== before.size || previous.mtimeMs !== before.mtimeMs) {
          this.seen.set(filePath, {
            size: before.size,
            mtimeMs: before.mtimeMs,
            unchangedSince: observedAt,
            stableScans: 1,
            lastEnqueuedAt: previous?.lastEnqueuedAt ?? null,
            pendingHash: null,
            hashConfirmations: 0,
            failure: null,
            rejected: null,
          });
          events.push({ path: filePath, status: 'observed', detail: previous ? 'Size or mtime changed; the stability window restarted.' : undefined });
          continue;
        }
        previous.stableScans += 1;
        if (observedAt - previous.unchangedSince < this.stabilityMs || previous.stableScans < this.minimumStableScans) {
          events.push({ path: filePath, status: 'unstable', detail: 'Size and mtime have not been unchanged for long enough.' });
          continue;
        }
        // D3/D11: a file already refused or abandoned for these exact bytes must not be
        // re-read and re-hashed on every scan. All three gates are checked before any I/O;
        // any change to size or mtime resets the record above and re-opens the question.
        if (previous.rejected) continue;
        if (previous.failure?.abandoned) {
          if (!previous.failure.reported) {
            previous.failure.reported = true;
            events.push({ path: filePath, status: 'abandoned', detail: `Abandoned after ${previous.failure.attempts} failed enqueue attempts: ${previous.failure.lastMessage}. Modify or re-drop the file, or use the Cockpit upload, to try again.` });
          }
          continue;
        }
        if (previous.failure && observedAt < previous.failure.nextAttemptAt) {
          events.push({ path: filePath, status: 'unstable', detail: `Backing off for ${previous.failure.nextAttemptAt - observedAt}ms after ${previous.failure.attempts} failed enqueue attempts.` });
          continue;
        }
        if (previous.lastEnqueuedAt !== null && !previous.failure && observedAt - previous.lastEnqueuedAt < this.debounceMs) {
          events.push({ path: filePath, status: 'unstable', detail: 'Debounce interval has not elapsed.' });
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(filePath);
        } catch (error) {
          if (isMissingPathError(error)) {
            this.seen.delete(filePath);
            continue;
          }
          throw error;
        }
        const after = await stat(filePath).catch(() => null);
        if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          this.seen.set(filePath, {
            size: after?.size ?? before.size,
            mtimeMs: after?.mtimeMs ?? before.mtimeMs,
            unchangedSince: observedAt,
            stableScans: 1,
            lastEnqueuedAt: previous.lastEnqueuedAt,
            pendingHash: null,
            hashConfirmations: 0,
            failure: previous.failure,
            rejected: null,
          });
          events.push({ path: filePath, status: 'unstable', detail: 'File changed while being read.' });
          continue;
        }
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        // D11: size and mtime can both sit still while a writer is stalled mid-copy, and a
        // re-stat only catches a change *during* the read. Requiring the same hash from two
        // reads a poll apart means a truncated file is never filed as an immutable original.
        if (previous.pendingHash !== contentHash) {
          previous.pendingHash = contentHash;
          previous.hashConfirmations = 1;
        } else {
          previous.hashConfirmations += 1;
        }
        if (previous.hashConfirmations < this.requiredHashConfirmations) {
          events.push({ path: filePath, status: 'unstable', contentHash, detail: `Content hash confirmed ${previous.hashConfirmations} of ${this.requiredHashConfirmations} times.` });
          continue;
        }
        // D11: quiet bytes are not necessarily whole bytes. A writer that stalls for
        // several polls passes every timing rule, so the bytes themselves must show that
        // the file is complete before it can become an immutable original.
        const completeness = sourceCompletenessIssue(filePath, bytes);
        if (completeness) {
          previous.rejected = { hash: contentHash, reason: completeness, reported: true };
          events.push({ path: filePath, status: 'failed', contentHash, detail: `Refused as an incomplete source: ${completeness}. These bytes will not be filed; the file is re-checked when it changes on disk.` });
          continue;
        }
        const alreadyKnown =this.processedHashes.has(contentHash) || Boolean(await this.options.isKnownHash?.(contentHash));
        if (alreadyKnown) {
          previous.lastEnqueuedAt = observedAt;
          previous.failure = null;
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
          previous.failure = null;
          this.processedHashes.add(contentHash);
          events.push({ path: filePath, status: result.duplicate ? 'duplicate' : 'enqueued', contentHash });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Inbox enqueue failed.';
          const attempts = (previous.failure?.attempts ?? 0) + 1;
          const abandoned = attempts >= this.maxEnqueueAttempts;
          const backoff = this.failureBackoffMs * 2 ** (attempts - 1);
          previous.failure = { attempts, nextAttemptAt: observedAt + backoff, lastMessage: message, abandoned, reported: false };
          previous.lastEnqueuedAt = observedAt;
          events.push({
            path: filePath,
            status: 'failed',
            contentHash,
            detail: abandoned
              ? `Enqueue failed on attempt ${attempts} of ${this.maxEnqueueAttempts}; no further attempts will be made for these bytes: ${message}`
              : `Enqueue failed on attempt ${attempts} of ${this.maxEnqueueAttempts}; retrying no sooner than ${backoff}ms: ${message}`,
          });
        }
      }
      return events;
    } finally {
      this.scanning = false;
    }
  }

  /** Design §4: a 30-second poll, not the 1-second hot loop this defaulted to. */
  start(intervalMs = WATCHED_INBOX_POLL_MS, onEvents?: (events: WatchedInboxEvent[]) => void): void {
    if (this.timer) return;
    const sink = onEvents ?? this.options.onEvents ?? defaultWatcherLogger;
    this.timer = setInterval(() => {
      void this.scan().then(
        (events) => {
          if (events.length > 0) sink(events);
        },
        (error) => {
          sink([{ path: this.options.inboxPath, status: 'failed', detail: error instanceof Error ? error.message : 'Inbox scan failed.' }]);
        },
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function defaultWatcherLogger(events: WatchedInboxEvent[]): void {
  for (const event of events) {
    if (event.status === 'failed' || event.status === 'abandoned' || event.status === 'inbox-missing') {
      console.error(`[inbox-watcher] ${event.status} ${event.path}: ${event.detail ?? ''}`);
    }
  }
}
