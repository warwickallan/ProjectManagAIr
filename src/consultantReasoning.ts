/**
 * Consultant Reasoning: resolve the skill, assemble the prompt, make ONE
 * bounded call, preserve the response, validate it, cache it.
 *
 * The read path (`readConsultantReasoning`) is guaranteed provider-free: it is
 * what the Cockpit calls on open, navigate and reopen, and it must never cost
 * a token. The generate path (`generateConsultantReasoning`) is only ever
 * reached by an explicit Generate/Refresh action.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadSkillRegistry, readActiveSkillRevision, readSkillPin, type SkillRevisionRecord,
} from './skillRegistry.js';
import { resolveProviderOutputDir } from './providerOutputs.js';
import {
  CONSULTANT_REASONING_SKILL_ID, parseReasoningResponse, validateReasoningOutput,
  type BriefMode, type ReasoningOutput, type Violation,
} from './consultantReasoningContract.js';
import {
  allowedRegisterIds, buildReasoningRequest, reasoningCacheKey,
  type BuildRequestOptions, type ReasoningRequest,
} from './consultantReasoningState.js';
import type { ConsultantReasoningProvider } from './consultantReasoningProvider.js';
import { estimateTokens } from './extractionProvider.js';

export const CONSULTANT_REASONING_PROMPT_TEMPLATE = 'consultant-reasoning-prompt-v1';

/**
 * The input ceiling for one reasoning pass. Generous, because the whole point
 * of this family is that it sees the complete state — but finite, so a project
 * that outgrows one call fails loudly here rather than silently truncating.
 */
export const MAX_REASONING_PROMPT_TOKENS = 150_000;

function nowIso(): string { return new Date().toISOString(); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/**
 * Which consultant-reasoning revision governs this project.
 *
 * Pin first, then the active revision, then the highest candidate. The
 * candidate fallback exists because this family ships with exactly one
 * revision at `status: candidate` — the skill is explicitly not promoted until
 * a real run proves it. Falling back to it is what lets that proof happen;
 * without it the family would be unusable until someone promoted it blind.
 * A draft is never resolved.
 */
export function resolveReasoningSkill(db: DatabaseSync, projectId: string): SkillRevisionRecord | null {
  const pin = readSkillPin(db, projectId, CONSULTANT_REASONING_SKILL_ID);
  if (pin) {
    const pinned = db.prepare('SELECT * FROM extraction_skills WHERE skill_id = ? AND version = ?').get(CONSULTANT_REASONING_SKILL_ID, pin.version) as Record<string, unknown> | undefined;
    if (pinned) return shapeRevision(pinned);
  }
  const active = readActiveSkillRevision(db, CONSULTANT_REASONING_SKILL_ID);
  if (active) return active;
  const candidate = db.prepare("SELECT * FROM extraction_skills WHERE skill_id = ? AND status = 'candidate'").all(CONSULTANT_REASONING_SKILL_ID) as Array<Record<string, unknown>>;
  if (candidate.length === 0) return null;
  const highest = candidate
    .map(shapeRevision)
    .sort((left, right) => compareVersions(right.version, left.version))[0];
  return highest ?? null;
}

function compareVersions(left: string, right: string): number {
  const [a, b] = [left, right].map((value) => value.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function shapeRevision(row: Record<string, unknown>): SkillRevisionRecord {
  return {
    skillId: String(row.skill_id), version: String(row.version), sha256: String(row.sha256),
    promptTemplateVersion: String(row.prompt_template_version),
    status: String(row.status) as SkillRevisionRecord['status'],
    source: String(row.source) as SkillRevisionRecord['source'],
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    retiredAt: row.retired_at ? String(row.retired_at) : null,
    name: row.name ? String(row.name) : 'Project Consultant Reasoning',
    purpose: row.purpose ? String(row.purpose) : null,
    providerProfile: row.provider_profile ? String(row.provider_profile) : null,
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? 1 : Number(row.packet_contract_version),
    bodyPath: row.body_path ? String(row.body_path) : null,
    bodyCharacters: row.body_characters === null || row.body_characters === undefined ? null : Number(row.body_characters),
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
  };
}

/**
 * The skill body, re-read from disk and hash-verified against the registered
 * revision. Returns null rather than throwing so a missing or edited body
 * becomes a readable Cockpit failure naming Settings, not a 500.
 */
export function readReasoningSkillBody(db: DatabaseSync, projectId: string): { revision: SkillRevisionRecord; body: string } | null {
  const revision = resolveReasoningSkill(db, projectId);
  if (!revision) return null;
  const asset = loadSkillRegistry().find((entry) => entry.skillId === revision.skillId && entry.version === revision.version);
  if (!asset || asset.sha256 !== revision.sha256) return null;
  return { revision, body: asset.body };
}

/**
 * Assemble the prompt. The skill body is the instruction; the request object
 * is the data. Versioned separately from the body exactly as extraction does,
 * so a body edit and an assembly change are distinguishable in the record.
 */
export function assembleReasoningPrompt(skillBody: string, request: ReasoningRequest): { prompt: string; promptSha256: string } {
  const prompt = [
    skillBody,
    '',
    '--- REQUEST AND COMPLETE APPROVED PROJECT STATE ---',
    'Return exactly one JSON object matching the OUTPUT CONTRACT. No prose, no markdown fence.',
    JSON.stringify(request),
  ].join('\n');
  return { prompt, promptSha256: sha256(prompt) };
}

export type ReasoningState = 'none' | 'current' | 'stale' | 'failed';

export interface CachedReasoning {
  id: string;
  runId: string;
  mode: string;
  resultJson: ReasoningOutput;
  resultSha256: string;
  citedRegisterIds: string[];
  projectStateHash: string;
  registerRevision: number;
  skillId: string;
  skillVersion: string;
  promptTemplateVersion: string;
  providerId: string;
  modelLabel: string;
  generatedAt: string;
  stale: boolean;
  staleReason: string | null;
}

function toCached(row: Record<string, unknown>): CachedReasoning {
  return {
    id: String(row.id), runId: String(row.run_id), mode: String(row.mode),
    resultJson: JSON.parse(String(row.result_json)) as ReasoningOutput,
    resultSha256: String(row.result_sha256),
    citedRegisterIds: JSON.parse(String(row.cited_register_ids_json)) as string[],
    projectStateHash: String(row.project_state_hash),
    registerRevision: Number(row.register_revision),
    skillId: String(row.skill_id), skillVersion: String(row.skill_version),
    promptTemplateVersion: String(row.prompt_template_version),
    providerId: String(row.provider_id), modelLabel: String(row.model_label),
    generatedAt: String(row.generated_at),
    stale: Number(row.stale) === 1,
    staleReason: row.stale_reason ? String(row.stale_reason) : null,
  };
}

/**
 * Mark every cached result for this project stale except the one matching the
 * current state hash. Called after an apply. Results are never deleted: the
 * superseded brief is how the consultant sees what changed.
 */
export function markReasoningStale(db: DatabaseSync, projectId: string, currentStateHash: string, reason: string, mode?: string): number {
  // Scoped to one mode when given. Today every mode over one project shares a
  // state hash, so the distinction is invisible — but staling another mode's
  // brief as a side effect of accepting this one would be wrong the moment
  // that stops being true.
  const result = mode
    ? db.prepare('UPDATE consultant_reasoning_results SET stale = 1, stale_reason = ?, stale_at = ? WHERE project_id = ? AND mode = ? AND project_state_hash != ? AND stale = 0')
      .run(reason, nowIso(), projectId, mode, currentStateHash)
    : db.prepare('UPDATE consultant_reasoning_results SET stale = 1, stale_reason = ?, stale_at = ? WHERE project_id = ? AND project_state_hash != ? AND stale = 0')
      .run(reason, nowIso(), projectId, currentStateHash);
  return Number(result.changes ?? 0);
}

export interface ReasoningView {
  projectId: string;
  mode: string;
  /** The accepted result for the CURRENT state, if one exists. */
  current: CachedReasoning | null;
  /** The most recent accepted result for any state — possibly stale. */
  latest: CachedReasoning | null;
  state: ReasoningState;
  projectStateHash: string;
  registerRevision: number;
  identity: {
    skillId: string;
    skillVersion: string | null;
    promptTemplateVersion: string | null;
    providerId: string;
    modelLabel: string;
    providerAvailable: boolean;
    providerDetail: string;
    skillResolved: boolean;
  };
  lastFailure: { status: string; error: string | null; violations: Violation[]; createdAt: string } | null;
  /** Always zero on this path. Stated because it is the whole guarantee. */
  providerCallsThisRequest: 0;
}

/**
 * Read the reasoning view. Makes ZERO provider calls, always — this is the
 * function the Cockpit calls on every open and navigation.
 */
export function readConsultantReasoning(
  db: DatabaseSync,
  projectId: string,
  mode: BriefMode,
  provider: ConsultantReasoningProvider,
  options: BuildRequestOptions = { mode },
): ReasoningView {
  const request = buildReasoningRequest(db, projectId, { ...options, mode });
  const stateHash = request.project.project_state_hash;
  const resolved = resolveReasoningSkill(db, projectId);

  const rows = db.prepare('SELECT * FROM consultant_reasoning_results WHERE project_id = ? AND mode = ? ORDER BY generated_at DESC').all(projectId, mode) as Array<Record<string, unknown>>;
  const all = rows.map(toCached);
  const current = all.find((row) => row.projectStateHash === stateHash && !row.stale) ?? null;
  const latest = all[0] ?? null;

  // A stored failure only matters while it is the most recent word on this
  // mode; an accepted run afterwards supersedes it. Ordered by rowid, not by
  // `created_at`: ISO timestamps are millisecond-resolution, and two runs
  // recorded in the same millisecond made the comparison a coin toss that
  // could hide a genuine failure behind an older success.
  const lastRun = db.prepare('SELECT status, error, violations_json, created_at FROM consultant_reasoning_runs WHERE project_id = ? AND mode = ? ORDER BY rowid DESC LIMIT 1').get(projectId, mode) as Record<string, unknown> | undefined;
  const failureIsCurrent = Boolean(lastRun && String(lastRun.status) !== 'accepted');
  const failure = failureIsCurrent ? lastRun : undefined;

  const availability = provider.availability?.() ?? { available: provider.isAvailable(), detail: provider.isAvailable() ? 'ok' : 'unavailable', kind: null, version: null, checkedAt: Date.now() };

  const state: ReasoningState = current ? 'current' : failureIsCurrent ? 'failed' : latest ? 'stale' : 'none';

  return {
    projectId, mode, current, latest, state,
    projectStateHash: stateHash,
    registerRevision: request.project.register_revision,
    identity: {
      skillId: CONSULTANT_REASONING_SKILL_ID,
      skillVersion: resolved?.version ?? null,
      promptTemplateVersion: resolved?.promptTemplateVersion ?? null,
      providerId: provider.identity.providerId,
      modelLabel: provider.identity.modelLabel,
      providerAvailable: availability.available,
      providerDetail: availability.detail,
      skillResolved: Boolean(resolved),
    },
    lastFailure: failureIsCurrent && failure
      ? { status: String(failure.status), error: failure.error ? String(failure.error) : null, violations: JSON.parse(String(failure.violations_json)) as Violation[], createdAt: String(failure.created_at) }
      : null,
    providerCallsThisRequest: 0,
  };
}

export interface GenerateResult {
  view: ReasoningView;
  providerCalls: 0 | 1;
  outcome: 'cache-hit' | 'accepted' | 'parse-failed' | 'validation-failed' | 'provider-failed' | 'skill-unavailable' | 'provider-unavailable' | 'budget-exceeded';
  violations: Violation[];
  message: string | null;
  runId: string | null;
}

/**
 * Generate a reasoning result. At most ONE provider call, and only when the
 * cache genuinely misses. Every outcome — including every failure — writes a
 * run row, so an operator can always answer "what did we spend and what came
 * back" from the database alone.
 */
export async function generateConsultantReasoning(
  db: DatabaseSync,
  projectId: string,
  mode: BriefMode,
  provider: ConsultantReasoningProvider,
  options: BuildRequestOptions & { force?: boolean; actor?: string } = { mode },
): Promise<GenerateResult> {
  const request = buildReasoningRequest(db, projectId, { ...options, mode });
  const stateHash = request.project.project_state_hash;
  const view = () => readConsultantReasoning(db, projectId, mode, provider, options);

  const skill = readReasoningSkillBody(db, projectId);
  if (!skill) {
    return { view: view(), providerCalls: 0, outcome: 'skill-unavailable', violations: [], message: `No usable ${CONSULTANT_REASONING_SKILL_ID} revision is resolvable. Check Settings → AI Skills & Prompts.`, runId: null };
  }

  const cacheKey = reasoningCacheKey({
    projectId, projectStateHash: stateHash, mode,
    skillId: skill.revision.skillId, skillVersion: skill.revision.version,
    promptTemplateVersion: skill.revision.promptTemplateVersion,
    providerId: provider.identity.providerId, modelLabel: provider.identity.modelLabel,
  });

  if (!options.force) {
    const hit = db.prepare('SELECT * FROM consultant_reasoning_results WHERE project_id = ? AND mode = ? AND cache_key = ? AND stale = 0').get(projectId, mode, cacheKey) as Record<string, unknown> | undefined;
    if (hit) return { view: view(), providerCalls: 0, outcome: 'cache-hit', violations: [], message: null, runId: String(hit.run_id) };
  }

  const availability = provider.refresh?.() ?? provider.availability?.() ?? { available: provider.isAvailable(), detail: '', kind: null, version: null, checkedAt: Date.now() };
  if (!availability.available) {
    return { view: view(), providerCalls: 0, outcome: 'provider-unavailable', violations: [], message: `Reasoning provider unavailable: ${availability.detail}`, runId: null };
  }

  const { prompt, promptSha256 } = assembleReasoningPrompt(skill.body, request);
  const promptTokens = estimateTokens(prompt);
  const runId = `reasoning-run:${projectId}:${randomUUID()}`;
  const startedAt = nowIso();

  const recordRun = (input: { status: string; violations: Violation[]; error: string | null; rawOutputId: string | null; durationMs: number; inputTokens: number; outputTokens: number; resultSha256: string | null; providerCalls: number }) => {
    db.prepare(`INSERT INTO consultant_reasoning_runs (id, project_id, raw_output_id, skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, provider_id, model_label, mode, project_state_hash, register_revision, request_context_json, started_at, duration_ms, status, violations_json, error, input_tokens, output_tokens, token_source, result_sha256, provider_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimated', ?, ?, ?)`)
      .run(runId, projectId, input.rawOutputId, skill.revision.skillId, skill.revision.version, skill.revision.sha256,
        skill.revision.promptTemplateVersion, promptSha256, provider.identity.providerId, provider.identity.modelLabel,
        mode, stateHash, request.project.register_revision, JSON.stringify(request.request), startedAt,
        input.durationMs, input.status, JSON.stringify(input.violations), input.error,
        input.inputTokens, input.outputTokens, input.resultSha256, input.providerCalls, nowIso());
  };

  // The budget gate runs BEFORE the call, never after: refusing to spend is
  // only meaningful while the tokens are still unspent.
  if (promptTokens > MAX_REASONING_PROMPT_TOKENS) {
    recordRun({ status: 'budget-exceeded', violations: [], error: `Prompt of ~${promptTokens} tokens exceeds the ${MAX_REASONING_PROMPT_TOKENS} ceiling.`, rawOutputId: null, durationMs: 0, inputTokens: promptTokens, outputTokens: 0, resultSha256: null, providerCalls: 0 });
    return { view: view(), providerCalls: 0, outcome: 'budget-exceeded', violations: [], message: `Project state is too large for one bounded reasoning call (~${promptTokens} tokens).`, runId };
  }

  /* ------------------------------------------------- the single call */
  let raw = '';
  let rawOutputId: string | null = null;
  let durationMs = 0;
  let usage = { inputTokens: promptTokens, outputTokens: 0 };
  try {
    const result = await provider.generate({
      prompt,
      projectStateHash: stateHash,
      preserveRawOutput: (event) => preserveReasoningOutput(db, {
        projectId, skill: skill.revision, promptSha256, provider: provider.identity,
        mode, projectStateHash: stateHash, registerRevision: request.project.register_revision,
        event, inputTokens: promptTokens, runId,
      }),
    });
    raw = result.raw;
    rawOutputId = result.rawOutputId;
    durationMs = result.durationMs;
    usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRun({ status: 'provider-failed', violations: [], error: message, rawOutputId: null, durationMs: 0, inputTokens: promptTokens, outputTokens: 0, resultSha256: null, providerCalls: 1 });
    return { view: view(), providerCalls: 1, outcome: 'provider-failed', violations: [], message, runId };
  }

  /* --------------------------------------------- parse, then validate */
  const parsed = parseReasoningResponse(raw);
  if (!parsed.ok) {
    setRawParseStatus(db, rawOutputId, 'rejected', parsed.error);
    recordRun({ status: 'parse-failed', violations: [], error: parsed.error, rawOutputId, durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, resultSha256: null, providerCalls: 1 });
    return { view: view(), providerCalls: 1, outcome: 'parse-failed', violations: [], message: parsed.error, runId };
  }

  const validation = validateReasoningOutput(parsed.value, {
    allowedRegisterIds: allowedRegisterIds(request),
    requestedMode: mode,
  });
  if (!validation.ok) {
    setRawParseStatus(db, rawOutputId, 'rejected', `${validation.violations.length} contract violation(s).`);
    recordRun({ status: 'validation-failed', violations: validation.violations, error: `${validation.violations.length} contract violation(s).`, rawOutputId, durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, resultSha256: null, providerCalls: 1 });
    return { view: view(), providerCalls: 1, outcome: 'validation-failed', violations: validation.violations, message: `Reasoning output failed ${validation.violations.length} contract check(s); it was preserved and rejected, not retried.`, runId };
  }

  /* ------------------------------------------------------ accept it */
  const resultJson = JSON.stringify(validation.output);
  const resultSha256 = sha256(resultJson);
  setRawParseStatus(db, rawOutputId, 'parsed', null);
  recordRun({ status: 'accepted', violations: [], error: null, rawOutputId, durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, resultSha256, providerCalls: 1 });

  db.prepare(`INSERT INTO consultant_reasoning_results (id, project_id, run_id, mode, cache_key, project_state_hash, register_revision, skill_id, skill_version, prompt_template_version, provider_id, model_label, result_json, result_sha256, cited_register_ids_json, generated_at, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(project_id, mode, cache_key) DO UPDATE SET run_id = excluded.run_id, result_json = excluded.result_json, result_sha256 = excluded.result_sha256, cited_register_ids_json = excluded.cited_register_ids_json, generated_at = excluded.generated_at, stale = 0, stale_reason = NULL, stale_at = NULL`)
    .run(`reasoning:${projectId}:${mode}:${cacheKey.slice(0, 16)}`, projectId, runId, mode, cacheKey, stateHash,
      request.project.register_revision, skill.revision.skillId, skill.revision.version,
      skill.revision.promptTemplateVersion, provider.identity.providerId, provider.identity.modelLabel,
      resultJson, resultSha256, JSON.stringify(validation.citedRegisterIds), nowIso());

  markReasoningStale(db, projectId, stateHash, 'A newer reasoning result exists for the current project state.', mode);

  return { view: view(), providerCalls: 1, outcome: 'accepted', violations: [], message: null, runId };
}

/* ------------------------------------------------------- preservation */

function setRawParseStatus(db: DatabaseSync, id: string | null, status: string, detail: string | null): void {
  if (!id) return;
  db.prepare('UPDATE consultant_reasoning_raw_outputs SET parse_status = ?, parse_detail = ? WHERE id = ?').run(status, detail, id);
}

/**
 * Write the complete response to disk and record it, before anything parses
 * it. Returns the record id, or null if the row could not be written — a
 * preservation failure must never take down a run that otherwise succeeded,
 * but it must be visible.
 */
export function preserveReasoningOutput(db: DatabaseSync, input: {
  projectId: string;
  skill: SkillRevisionRecord;
  promptSha256: string;
  provider: { providerId: string; modelLabel: string };
  mode: string;
  projectStateHash: string;
  registerRevision: number;
  event: { raw: string; requestedAt: string; receivedAt: string; durationMs: number };
  inputTokens: number;
  runId: string;
}): string | null {
  const responseSha256 = sha256(input.event.raw);
  const id = `reasoning-output:${input.projectId}:${input.mode}:${responseSha256.slice(0, 16)}`;
  let artefactPath: string | null = null;
  try {
    const dir = path.join(resolveProviderOutputDir(), 'consultant-reasoning');
    mkdirSync(dir, { recursive: true });
    artefactPath = path.join(dir, `${input.projectId}-${input.mode}-${responseSha256.slice(0, 16)}.txt`);
    writeFileSync(artefactPath, input.event.raw, 'utf8');
  } catch {
    // The file is best-effort; the database row is not.
    artefactPath = null;
  }
  try {
    db.prepare(`INSERT OR IGNORE INTO consultant_reasoning_raw_outputs (id, project_id, skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, provider_id, model_label, mode, project_state_hash, register_revision, requested_at, received_at, duration_ms, response_sha256, response_bytes, artefact_path, input_tokens, output_tokens, token_source, parse_status, parse_detail, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimated', 'pending', NULL, ?)`)
      .run(id, input.projectId, input.skill.skillId, input.skill.version, input.skill.sha256,
        input.skill.promptTemplateVersion, input.promptSha256, input.provider.providerId, input.provider.modelLabel,
        input.mode, input.projectStateHash, input.registerRevision, input.event.requestedAt, input.event.receivedAt,
        input.event.durationMs, responseSha256, Buffer.byteLength(input.event.raw, 'utf8'), artefactPath,
        input.inputTokens, estimateTokens(input.event.raw), input.runId);
    return id;
  } catch {
    return null;
  }
}
