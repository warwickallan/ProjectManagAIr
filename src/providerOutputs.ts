/**
 * Preservation of raw provider responses.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * --------------------------------------
 * A completed model response is preserved the instant it arrives — before JSON
 * parsing, before schema validation, before row canonicalisation, before
 * merging, before client-reference resolution and before packet assembly. A
 * defect in any of those steps must be recoverable by replaying preserved bytes,
 * never by paying for the model's work a second time.
 *
 * The previous acceptance attempt lost three completed responses — roughly
 * twenty-five minutes of model time — because the payload existed only in
 * memory and `extraction_runs` stored nothing but its hash. Capture-on-failure
 * is not preservation: the failures that matter are the ones downstream of a
 * successful call.
 *
 * WHERE THE BYTES GO
 * ------------------
 * The response text is written to a file under the configured provider-output
 * directory (git-ignored, outside the database) because it is source-derived
 * customer material. The database holds the identity, provenance and accounting
 * — everything needed to find, grade, attribute and replay that file — and the
 * hash that proves the file is the one that was received.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  parseStructuredExtractionOutputText,
  type StructuredExtractionProvider,
  type StructuredExtractionRequest,
  type StructuredExtractionResult,
  type StructuredProviderIdentity,
} from './extractionProvider.js';

/** Where preserved responses are written when no directory is configured. */
export const PROVIDER_OUTPUT_DIR_ENV = 'PROJECTMANAGAIR_PROVIDER_OUTPUT_DIR';

export function resolveProviderOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env[PROVIDER_OUTPUT_DIR_ENV] ?? '').trim();
  return configured || path.join(process.cwd(), 'artifacts', 'provider-output');
}

export type ProviderOutputParseStatus = 'received' | 'parsed' | 'parsed-with-exclusions' | 'rejected';

/**
 * Everything known at the moment a response arrives.
 *
 * Assembled by the caller that owns the extraction context, because the provider
 * knows the bytes but not which skill revision, project or window set produced
 * them.
 */
export interface PreserveProviderOutputInput {
  sourceId: string;
  projectId: string;
  stage: string;
  callIndex: number;
  attemptLabel?: string | null;
  providerId: string;
  modelLabel: string;
  skillId: string | null;
  skillVersion: string | null;
  skillSha256: string;
  promptTemplateVersion: string | null;
  promptSha256: string;
  packetContractVersion: number | null;
  windowKeys: Array<string | number>;
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  inputTokenSource?: string;
  outputTokenSource?: string;
}

export interface PreservedProviderOutput {
  id: string;
  responseSha256: string;
  responseBytes: number;
  artefactPath: string | null;
  /** True when this exact response for this exact call was already on record. */
  duplicate: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Persist one raw response and return its durable identity.
 *
 * Deliberately synchronous and deliberately first: the caller must be unable to
 * reach a parser before this has returned. Writing the file is best effort and
 * failure to write it never throws — but the database row, which is what makes
 * the response findable and attributable, is not best effort.
 */
export function preserveProviderOutput(db: DatabaseSync, input: PreserveProviderOutputInput): PreservedProviderOutput {
  const raw = input.raw ?? '';
  const responseSha256 = sha256(raw);
  const responseBytes = Buffer.byteLength(raw, 'utf8');
  const attemptLabel = input.attemptLabel ?? '';
  const id = `provider-output:${input.sourceId}:${input.stage}:${String(input.callIndex).padStart(3, '0')}:${responseSha256.slice(0, 16)}`;

  let artefactPath: string | null = null;
  try {
    const directory = resolveProviderOutputDir();
    mkdirSync(directory, { recursive: true });
    // Named by source, call and content hash so the file is identifiable on disk
    // without the database, which is the situation preservation is for.
    const file = path.join(directory, `${input.sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}-${input.stage}-${String(input.callIndex).padStart(3, '0')}-${responseSha256.slice(0, 16)}.txt`);
    writeFileSync(file, raw, 'utf8');
    artefactPath = file;
  } catch {
    // A full or read-only artefacts directory must not destroy the run: the
    // database row below still records the hash, the accounting and the
    // provenance, and the caller still holds the bytes in memory.
    artefactPath = null;
  }

  const existing = db.prepare('SELECT id FROM provider_raw_outputs WHERE source_id = ? AND stage = ? AND attempt_label = ? AND call_index = ? AND response_sha256 = ?')
    .get(input.sourceId, input.stage, attemptLabel, input.callIndex, responseSha256) as { id: string } | undefined;
  if (existing) return { id: String(existing.id), responseSha256, responseBytes, artefactPath, duplicate: true };

  db.prepare(`INSERT INTO provider_raw_outputs
    (id, source_id, project_id, stage, call_index, attempt_label, provider_id, model_label,
     skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, packet_contract_version,
     window_keys_json, requested_at, received_at, duration_ms, response_sha256, response_bytes, artefact_path,
     input_tokens, output_tokens, input_token_source, output_token_source, parse_status, parse_detail, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL)`)
    .run(id, input.sourceId, input.projectId, input.stage, input.callIndex, attemptLabel, input.providerId, input.modelLabel,
      input.skillId, input.skillVersion, input.skillSha256, input.promptTemplateVersion, input.promptSha256, input.packetContractVersion,
      JSON.stringify(input.windowKeys.map(String)), input.requestedAt, input.receivedAt, Math.max(0, Math.round(input.durationMs)),
      responseSha256, responseBytes, artefactPath,
      Math.max(0, Math.floor(input.inputTokens)), Math.max(0, Math.floor(input.outputTokens)),
      input.inputTokenSource ?? 'estimated', input.outputTokenSource ?? 'estimated');
  return { id, responseSha256, responseBytes, artefactPath, duplicate: false };
}

/**
 * Record what the parser made of a preserved response, and the run it became.
 *
 * Separate from preservation on purpose: the outcome is not known when the bytes
 * arrive, and a preservation that waited for the outcome would be exactly the
 * capture-on-failure behaviour this replaces.
 */
export function recordProviderOutputOutcome(db: DatabaseSync, id: string, outcome: { parseStatus: ProviderOutputParseStatus; parseDetail?: string | null; runId?: string | null }): void {
  db.prepare('UPDATE provider_raw_outputs SET parse_status = ?, parse_detail = ?, run_id = COALESCE(?, run_id) WHERE id = ?')
    .run(outcome.parseStatus, outcome.parseDetail ?? null, outcome.runId ?? null, id);
}

export interface PreservedOutputRecord {
  id: string;
  sourceId: string;
  projectId: string;
  stage: string;
  callIndex: number;
  attemptLabel: string;
  providerId: string;
  modelLabel: string;
  skillId: string | null;
  skillVersion: string | null;
  skillSha256: string;
  promptTemplateVersion: string | null;
  promptSha256: string;
  packetContractVersion: number | null;
  windowKeys: string[];
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
  responseSha256: string;
  responseBytes: number;
  artefactPath: string | null;
  inputTokens: number;
  outputTokens: number;
  inputTokenSource: string;
  outputTokenSource: string;
  parseStatus: ProviderOutputParseStatus;
  parseDetail: string | null;
  runId: string | null;
}

function toPreserved(row: Record<string, unknown>): PreservedOutputRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    projectId: String(row.project_id),
    stage: String(row.stage),
    callIndex: Number(row.call_index),
    attemptLabel: String(row.attempt_label ?? ''),
    providerId: String(row.provider_id),
    modelLabel: String(row.model_label),
    skillId: row.skill_id ? String(row.skill_id) : null,
    skillVersion: row.skill_version ? String(row.skill_version) : null,
    skillSha256: String(row.skill_sha256),
    promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : null,
    promptSha256: String(row.prompt_sha256),
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? null : Number(row.packet_contract_version),
    windowKeys: JSON.parse(String(row.window_keys_json ?? '[]')) as string[],
    requestedAt: String(row.requested_at),
    receivedAt: String(row.received_at),
    durationMs: Number(row.duration_ms),
    responseSha256: String(row.response_sha256),
    responseBytes: Number(row.response_bytes),
    artefactPath: row.artefact_path ? String(row.artefact_path) : null,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    inputTokenSource: String(row.input_token_source),
    outputTokenSource: String(row.output_token_source),
    parseStatus: String(row.parse_status) as ProviderOutputParseStatus,
    parseDetail: row.parse_detail ? String(row.parse_detail) : null,
    runId: row.run_id ? String(row.run_id) : null,
  };
}

export function readPreservedOutputs(db: DatabaseSync, sourceId: string): PreservedOutputRecord[] {
  const rows = db.prepare('SELECT * FROM provider_raw_outputs WHERE source_id = ? ORDER BY received_at, call_index').all(sourceId) as Array<Record<string, unknown>>;
  return rows.map(toPreserved);
}

export function readPreservedOutput(db: DatabaseSync, id: string): PreservedOutputRecord | null {
  const row = db.prepare('SELECT * FROM provider_raw_outputs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toPreserved(row) : null;
}

/**
 * Read back the preserved bytes and prove they are the ones that were received.
 *
 * A preserved response whose file has been altered is not evidence, so this
 * refuses rather than returning something that would silently be replayed as if
 * it were the model's answer.
 */
export function readPreservedOutputText(db: DatabaseSync, id: string): string {
  const record = readPreservedOutput(db, id);
  if (!record) throw new Error(`Preserved provider output ${id} was not found.`);
  if (!record.artefactPath) throw new Error(`Preserved provider output ${id} recorded no artefact path; the bytes were not written to disk.`);
  const text = readFileSync(record.artefactPath, 'utf8');
  const actual = sha256(text);
  if (actual !== record.responseSha256) {
    throw new Error(`Preserved provider output ${id} no longer matches its recorded hash (${actual} vs ${record.responseSha256}); the file has been altered.`);
  }
  return text;
}

/* ------------------------------------------------------------------------------------ *
 * Replaying preserved outputs
 * ------------------------------------------------------------------------------------ */

/**
 * A structured-extraction provider that answers from preserved bytes.
 *
 * This is what preservation is *for*. When a pass fails downstream of completed
 * calls — a merge defect, a gate defect, a canonicalisation defect — the fix is
 * to correct the code and run the same pass again against the responses the
 * model already gave, at zero cost and with no possibility of the model
 * answering differently the second time.
 *
 * It is deliberately strict: a call it has no preserved response for is an
 * error, not a silent fall-through to the real provider. Half a replay and half
 * a fresh pass would be neither reproducible nor honest about what it cost.
 */
export class PreservedOutputExtractionProvider implements StructuredExtractionProvider {
  readonly identity: StructuredProviderIdentity;
  private readonly byCallIndex: Map<number, PreservedOutputRecord>;

  constructor(private readonly db: DatabaseSync, private readonly sourceId: string, options: { attemptLabel?: string | null; stage?: string } = {}) {
    const stage = options.stage ?? 'structured-extraction';
    const preserved = readPreservedOutputs(db, sourceId).filter((record) => record.stage === stage
      && (options.attemptLabel === undefined || options.attemptLabel === null || record.attemptLabel === options.attemptLabel));
    if (preserved.length === 0) {
      throw new Error(`No preserved provider output exists for source ${sourceId} at stage ${stage}${options.attemptLabel ? ` (attempt ${options.attemptLabel})` : ''}; there is nothing to replay.`);
    }
    // The latest preserved response per call index wins, so a re-run after a
    // transport retry replays the response that actually completed.
    this.byCallIndex = new Map();
    for (const record of [...preserved].sort((left, right) => (left.receivedAt < right.receivedAt ? -1 : 1))) {
      this.byCallIndex.set(record.callIndex, record);
    }
    const first = preserved[0];
    this.identity = Object.freeze({ providerId: `replay:${first.providerId}`, modelLabel: `${first.modelLabel} (preserved)` });
  }

  /** The calls this replay can answer, in order. */
  get callIndexes(): number[] {
    return [...this.byCallIndex.keys()].sort((left, right) => left - right);
  }

  isAvailable(): boolean {
    return this.byCallIndex.size > 0;
  }

  extract(request: StructuredExtractionRequest): Promise<StructuredExtractionResult> {
    const record = this.byCallIndex.get(request.callIndex);
    if (!record) {
      throw new Error(`Replay has no preserved response for call ${request.callIndex} of ${this.sourceId}; preserved calls are ${this.callIndexes.join(', ') || 'none'}.`);
    }
    const raw = readPreservedOutputText(this.db, record.id);
    // Preserved bytes go through the identical parser the live call used. A
    // replay that parsed more leniently would prove the wrong thing.
    const output = parseStructuredExtractionOutputText(raw, { providerId: this.identity.providerId, stdout: raw, stderr: '' });
    return Promise.resolve({
      output,
      usage: {
        // The cost was paid by the original call and is reported as it was
        // recorded then, so a replay never inflates a job's spend.
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
        inputTokenSource: record.inputTokenSource === 'provider-reported' ? 'provider-reported' : 'estimated',
        outputTokenSource: record.outputTokenSource === 'provider-reported' ? 'provider-reported' : 'estimated',
      },
    });
  }
}
