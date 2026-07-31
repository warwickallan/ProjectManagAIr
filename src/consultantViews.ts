/**
 * Consultant views: deterministic by default, synthesised only on request.
 *
 * THE COST RULE THIS MODULE ENFORCES
 * ----------------------------------
 * Opening a project, changing a tab, changing a filter, refreshing the page,
 * viewing a row or watching the deterministic selection change costs **zero
 * provider calls**. The Meeting Brief and Needs Warwick views are built here
 * from stored state and deterministic themes, and they are complete on their
 * own — they are not a placeholder waiting for a model.
 *
 * A synthesis happens when, and only when, the consultant presses a button. One
 * user action produces at most one bounded provider call.
 *
 * THE CACHE
 * ---------
 * A synthesis is cached against the FULL identity of what produced it: the
 * deterministic selection, the skill id and version, the prompt template
 * version, the provider, the model and the packet contract version. Two of those
 * differing makes a different artefact, so reopening an unchanged view is free
 * and a view produced under a superseded skill version can never be served as if
 * it were current.
 *
 * STALENESS IS NOT REGENERATION
 * -----------------------------
 * When the selection moves, the previous synthesis is kept, marked stale, and
 * given a reason a consultant can read. Nothing regenerates on its own. Spending
 * tokens because state changed is exactly the automatic behaviour this design
 * rules out.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GroundedBriefProvider } from './briefProvider.js';
import { estimateTokens } from './extractionProvider.js';
import { buildProjectThemes, THEME_ENGINE_VERSION, type ProjectTheme, type ProjectThemeResult, type ThemeRow } from './projectThemes.js';
import { isStructuralHeading, validateBriefCitations } from './sourceIntelligence.js';
import {
  PACKET_CONTRACT_VERSION,
  loadSkillRegistry,
  readActiveSkillRevision,
  readSkillPin,
  type SkillRevisionRecord,
} from './skillRegistry.js';

/** The skill id that governs consultant synthesis. */
export const CONSULTANT_BRIEF_SKILL_ID = 'consultant-brief';

export const CONSULTANT_VIEW_MODES = ['meeting', 'needs-warwick'] as const;
export type ConsultantViewMode = typeof CONSULTANT_VIEW_MODES[number];

/** The bounded evidence pack size. A brief that reads everything is not a brief. */
export const MAX_SELECTED_RECORDS = 40;

/** Hard ceiling on the assembled synthesis prompt. Exceeding it refuses, never truncates silently. */
export const MAX_SYNTHESIS_PROMPT_TOKENS = 12_000;

const CLOSED_STATUS = /resolved|closed|complete|superseded|rejected|ratified|done|cancelled/i;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------------------------ *
 * The deterministic views
 * ------------------------------------------------------------------------------------ */

export interface ConsultantViewSection {
  key: string;
  title: string;
  /** Why this section exists, in a sentence, so an empty section still informs. */
  description: string;
  rowIds: string[];
}

export type ConsultantSelectionRecord = {
  id: string;
  registerName: string;
  title: string;
  summary: string;
  status: string;
  owner: string | null;
  ownership: 'consultant' | 'customer' | 'unowned';
  dueDate: string | null;
  overdue: boolean;
  blocking: boolean;
  conflict: boolean;
  severity: string | null;
  band: string;
  score: number;
  themeId: string | null;
  themeLabel: string | null;
  /** How many other records in this record's theme it plausibly unlocks. */
  unlocks: number;
  evidence: { sourceId: string; segmentSeq: number } | null;
}

export interface DeterministicConsultantView {
  mode: ConsultantViewMode;
  themeEngineVersion: string;
  themes: ProjectTheme[];
  sections: ConsultantViewSection[];
  records: ConsultantSelectionRecord[];
  selectedIds: string[];
  selectionHash: string;
  /** Always zero. Stated rather than implied, because it is the whole guarantee. */
  providerCalls: 0;
}

function ownershipOf(row: ThemeRow): 'consultant' | 'customer' | 'unowned' {
  if (row.unowned) return 'unowned';
  return row.consultantOwned ? 'consultant' : 'customer';
}

function isOpen(row: ThemeRow): boolean {
  return !row.superseded && !CLOSED_STATUS.test(row.status);
}

/**
 * How many other records a decision or blocker plausibly unlocks.
 *
 * Deterministic and conservative: only records inside the same deterministic
 * theme count, and only records that are not themselves decisions. A number
 * derived from anything looser would be a guess wearing a numeral.
 */
function unlockCount(row: ThemeRow, theme: ProjectTheme | undefined, byId: Map<string, ThemeRow>): number {
  if (!theme) return 0;
  if (row.registerName !== 'Decisions' && !row.blocking && row.registerName !== 'Open_Questions') return 0;
  return theme.memberIds
    .filter((id) => id !== row.id)
    .map((id) => byId.get(id))
    .filter((member): member is ThemeRow => Boolean(member) && member!.registerName !== 'Decisions' && isOpen(member!))
    .length;
}

/**
 * Build the Meeting Brief or Needs Warwick view. No provider is reachable from
 * here — the module does not even take one.
 */
export function buildDeterministicConsultantView(db: DatabaseSync, projectId: string, mode: ConsultantViewMode): DeterministicConsultantView {
  const themed: ProjectThemeResult = buildProjectThemes(db, projectId);
  const byId = new Map(themed.rows.map((row) => [row.id, row]));
  const themeOf = new Map<string, ProjectTheme>();
  for (const theme of themed.themes) for (const id of theme.memberIds) themeOf.set(id, theme);
  const open = themed.rows.filter(isOpen);
  const rank = (rows: ThemeRow[]) => [...rows].sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));

  const sections: ConsultantViewSection[] = [];
  const push = (key: string, title: string, description: string, rows: ThemeRow[], limit = 12) => {
    sections.push({ key, title, description, rowIds: rank(rows).slice(0, limit).map((row) => row.id) });
  };

  if (mode === 'meeting') {
    // Themes worth challenging: a theme carrying an unresolved decision, a
    // blocker, an overdue item or a customer dependency is a theme the meeting
    // should not end without touching.
    const challengeThemes = themed.themes.filter((theme) =>
      theme.unresolvedDecisionCount > 0 || theme.blockingCount > 0 || theme.overdueCount > 0 || theme.customerDependency || theme.conflictCount > 0);
    sections.push({
      key: 'themes-to-challenge',
      title: 'Themes to challenge',
      description: 'Deterministic groupings that carry an unresolved decision, a blocker, an overdue item, a conflict or a customer dependency.',
      rowIds: challengeThemes.flatMap((theme) => theme.memberIds.filter((id) => isOpen(byId.get(id)!))).slice(0, 24),
    });
    push('customer-owned-blockers', 'Customer-owned blockers',
      'Open records the customer owns that something else is waiting on.',
      open.filter((row) => ownershipOf(row) === 'customer' && (row.blocking || (themeOf.get(row.id)?.blockingCount ?? 0) > 0)));
    push('decisions-needed', 'Decisions needed',
      'Decisions that have not closed an option yet.',
      open.filter((row) => row.registerName === 'Decisions'));
    push('unresolved-questions', 'Unresolved questions',
      'Open questions, blocking ones first by score.',
      open.filter((row) => row.registerName === 'Open_Questions'));
    push('high-risks-issues', 'High risks and issues',
      'Risks and issues in the Now and Soon bands.',
      open.filter((row) => row.registerName === 'Risks_Issues' && ['Now', 'Soon'].includes(row.band)));
    push('milestones-at-risk', 'Milestones at risk',
      'Milestones that are overdue, blocked, or sit in a theme carrying an overdue item.',
      open.filter((row) => row.registerName === 'Milestones' && (row.overdue || row.blocking || (themeOf.get(row.id)?.overdueCount ?? 0) > 0)));
    push('recent-changes', 'Relevant recent changes',
      'Records the most recently applied source moved.',
      open.filter((row) => row.latestSource));
  } else {
    push('consultant-actions', 'Ranked consultant actions',
      'Open actions owned by the consultant or by nobody, highest score first.',
      open.filter((row) => row.registerName === 'Actions' && ownershipOf(row) !== 'customer'));
    push('decisions-requiring-warwick', 'Decisions requiring Warwick',
      'Open decisions that are unowned or consultant-owned.',
      open.filter((row) => row.registerName === 'Decisions' && ownershipOf(row) !== 'customer'));
    push('conflicts', 'Conflicts',
      'Records where a source assertion and a human edit disagree.',
      open.filter((row) => row.conflict));
    push('overdue', 'Overdue items',
      'Anything open with a due date in the past.',
      open.filter((row) => row.overdue));
    push('uncertain', 'Uncertain items needing judgement',
      'The uncertainty ledger and anything scored in the Now band without an owner.',
      open.filter((row) => row.registerName === 'Uncertainty' || (row.unowned && row.band === 'Now')));
    push('high-leverage', 'High-leverage items',
      'Decisions, questions and blockers that unlock several dependent records in the same theme.',
      open.filter((row) => unlockCount(row, themeOf.get(row.id), byId) >= 2));
  }

  // The selection is the union of the sections, ordered by score and bounded.
  // Ordering by score rather than by section keeps the pack stable when a
  // section gains or loses a row.
  const selectedIds = rank(
    [...new Set(sections.flatMap((section) => section.rowIds))]
      .map((id) => byId.get(id))
      .filter((row): row is ThemeRow => Boolean(row)),
  ).slice(0, MAX_SELECTED_RECORDS).map((row) => row.id);

  const records: ConsultantSelectionRecord[] = selectedIds.map((id) => {
    const row = byId.get(id)!;
    const theme = themeOf.get(id);
    const anchor = row.anchors[0] ?? null;
    return {
      id: row.id,
      registerName: row.registerName,
      title: row.title.slice(0, 240),
      summary: row.summary.slice(0, 500),
      status: row.status,
      owner: row.owner,
      ownership: ownershipOf(row),
      dueDate: row.dueDate,
      overdue: row.overdue,
      blocking: row.blocking,
      conflict: row.conflict,
      severity: row.severity,
      band: row.band,
      score: row.score,
      themeId: theme?.id ?? null,
      themeLabel: theme?.label ?? null,
      unlocks: unlockCount(row, theme, byId),
      evidence: anchor,
    };
  });

  // The hash covers the records AND the themes they sit in: a regrouping that
  // leaves the same rows selected is still a different pack to reason over.
  const selectionHash = hash(stable({
    mode,
    engine: THEME_ENGINE_VERSION,
    records,
    themes: themed.themes.filter((theme) => theme.memberIds.some((id) => selectedIds.includes(id))).map((theme) => ({ id: theme.id, label: theme.label, memberIds: theme.memberIds })),
  }));

  return {
    mode,
    themeEngineVersion: THEME_ENGINE_VERSION,
    themes: themed.themes,
    sections,
    records,
    selectedIds,
    selectionHash,
    providerCalls: 0,
  };
}

/* ------------------------------------------------------------------------------------ *
 * Cache identity
 * ------------------------------------------------------------------------------------ */

export interface SynthesisIdentity {
  skillId: string;
  skillVersion: string | null;
  skillSha256: string | null;
  promptTemplateVersion: string | null;
  providerId: string;
  modelLabel: string;
  packetContractVersion: number;
}

/**
 * Which consultant-brief revision is in force for this project: its pin if it
 * has one, otherwise the active revision. Identical precedence to extraction,
 * because two different rules for "which skill is in force" is one rule too many.
 */
export function resolveConsultantSkill(db: DatabaseSync, projectId: string): SkillRevisionRecord | null {
  const pin = readSkillPin(db, projectId, CONSULTANT_BRIEF_SKILL_ID);
  if (pin) {
    const pinned = db.prepare('SELECT * FROM extraction_skills WHERE skill_id = ? AND version = ?').get(CONSULTANT_BRIEF_SKILL_ID, pin.version) as Record<string, unknown> | undefined;
    if (pinned) return readActiveSkillRevisionShape(pinned);
  }
  return readActiveSkillRevision(db, CONSULTANT_BRIEF_SKILL_ID);
}

function readActiveSkillRevisionShape(row: Record<string, unknown>): SkillRevisionRecord {
  return {
    skillId: String(row.skill_id),
    version: String(row.version),
    sha256: String(row.sha256),
    promptTemplateVersion: String(row.prompt_template_version),
    status: String(row.status) as SkillRevisionRecord['status'],
    source: String(row.source) as SkillRevisionRecord['source'],
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
    createdAt: String(row.created_at),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    retiredAt: row.retired_at ? String(row.retired_at) : null,
    name: row.name ? String(row.name) : 'Consultant Brief',
    purpose: row.purpose ? String(row.purpose) : null,
    providerProfile: row.provider_profile ? String(row.provider_profile) : null,
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? PACKET_CONTRACT_VERSION : Number(row.packet_contract_version),
    bodyPath: row.body_path ? String(row.body_path) : null,
    bodyCharacters: row.body_characters === null || row.body_characters === undefined ? null : Number(row.body_characters),
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
  };
}

export function synthesisIdentity(db: DatabaseSync, projectId: string, provider: GroundedBriefProvider): SynthesisIdentity {
  const skill = resolveConsultantSkill(db, projectId);
  return {
    skillId: CONSULTANT_BRIEF_SKILL_ID,
    skillVersion: skill?.version ?? null,
    skillSha256: skill?.sha256 ?? null,
    promptTemplateVersion: skill?.promptTemplateVersion ?? null,
    providerId: provider.identity.providerId,
    modelLabel: provider.identity.modelLabel,
    packetContractVersion: skill?.packetContractVersion ?? PACKET_CONTRACT_VERSION,
  };
}

export function consultantCacheKey(mode: ConsultantViewMode, selectionHash: string, identity: SynthesisIdentity): string {
  return hash(stable({
    mode,
    selectionHash,
    skillId: identity.skillId,
    skillVersion: identity.skillVersion,
    promptTemplateVersion: identity.promptTemplateVersion,
    providerId: identity.providerId,
    modelLabel: identity.modelLabel,
    packetContractVersion: identity.packetContractVersion,
  }));
}

/* ------------------------------------------------------------------------------------ *
 * Reading and invalidating the cache
 * ------------------------------------------------------------------------------------ */

export interface CachedConsultantSynthesis {
  id: string;
  mode: string;
  cacheKey: string;
  selectionHash: string;
  briefMarkdown: string;
  citations: string[];
  selectedIds: string[];
  providerId: string;
  modelLabel: string | null;
  skillId: string | null;
  skillVersion: string | null;
  promptTemplateVersion: string | null;
  packetContractVersion: number | null;
  inputTokens: number;
  outputTokens: number;
  generatedAt: string;
  stale: boolean;
  staleReason: string | null;
  staleAt: string | null;
}

function toCached(row: Record<string, unknown>): CachedConsultantSynthesis {
  return {
    id: String(row.id),
    mode: String(row.mode),
    cacheKey: String(row.cache_key),
    selectionHash: String(row.selection_hash),
    briefMarkdown: String(row.brief_markdown),
    citations: JSON.parse(String(row.citations_json)) as string[],
    selectedIds: JSON.parse(String(row.selected_ids_json ?? '[]')) as string[],
    providerId: String(row.provider_id),
    modelLabel: row.model_label ? String(row.model_label) : null,
    skillId: row.skill_id ? String(row.skill_id) : null,
    skillVersion: row.skill_version ? String(row.skill_version) : null,
    promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : null,
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? null : Number(row.packet_contract_version),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    generatedAt: String(row.generated_at),
    stale: Number(row.stale) === 1,
    staleReason: row.stale_reason ? String(row.stale_reason) : null,
    staleAt: row.stale_at ? String(row.stale_at) : null,
  };
}

/**
 * Mark every synthesis for this project and mode whose selection no longer
 * matches, keeping the text.
 *
 * A stale brief is still the best reasoning anyone has about the project until
 * someone asks for a new one; discarding it, or silently replacing it, both cost
 * the consultant something they did not agree to lose.
 */
export function markSupersededSyntheses(db: DatabaseSync, projectId: string, mode: string, currentSelectionHash: string, reason: string): number {
  const affected = db.prepare('SELECT id FROM consultant_briefs WHERE project_id = ? AND mode = ? AND selection_hash <> ? AND stale = 0').all(projectId, mode, currentSelectionHash) as Array<{ id: string }>;
  if (affected.length === 0) return 0;
  const at = nowIso();
  const update = db.prepare('UPDATE consultant_briefs SET stale = 1, stale_reason = ?, stale_at = ? WHERE id = ?');
  for (const row of affected) update.run(reason, at, String(row.id));
  return affected.length;
}

/** Read the cache only. Never calls a provider, never writes a brief. */
export function readConsultantSynthesis(db: DatabaseSync, projectId: string, mode: ConsultantViewMode, cacheKey: string): CachedConsultantSynthesis | null {
  const row = db.prepare('SELECT * FROM consultant_briefs WHERE project_id = ? AND mode = ? AND cache_key = ?').get(projectId, mode, cacheKey) as Record<string, unknown> | undefined;
  return row ? toCached(row) : null;
}

/** The most recent synthesis for this mode whatever its cache key — used to keep a stale one on screen. */
export function readLatestConsultantSynthesis(db: DatabaseSync, projectId: string, mode: ConsultantViewMode): CachedConsultantSynthesis | null {
  const row = db.prepare("SELECT * FROM consultant_briefs WHERE project_id = ? AND mode = ? AND provider_id <> 'deterministic-template' ORDER BY generated_at DESC LIMIT 1").get(projectId, mode) as Record<string, unknown> | undefined;
  return row ? toCached(row) : null;
}

/* ------------------------------------------------------------------------------------ *
 * The composed view a route returns
 * ------------------------------------------------------------------------------------ */

export type SynthesisState = 'none' | 'current' | 'stale' | 'failed';

export interface ConsultantViewResponse {
  projectId: string;
  mode: ConsultantViewMode;
  deterministic: DeterministicConsultantView;
  synthesis: (CachedConsultantSynthesis & { state: SynthesisState }) | null;
  /** What the next Generate would run under, so the UI can show it before spending anything. */
  identity: SynthesisIdentity & { providerAvailable: boolean; providerDetail: string | null };
  synthesisState: SynthesisState;
  failure: { message: string; recoveryAction: string } | null;
  providerCallsThisRequest: number;
}

/**
 * Read a project's consultant view.
 *
 * Deterministic content always; a synthesis only if one is already cached. Zero
 * provider calls, unconditionally — there is no branch in this function that can
 * reach a provider's `generate`.
 */
export function readConsultantView(db: DatabaseSync, projectId: string, mode: ConsultantViewMode, provider: GroundedBriefProvider): ConsultantViewResponse {
  const deterministic = buildDeterministicConsultantView(db, projectId, mode);
  const identity = synthesisIdentity(db, projectId, provider);
  const cacheKey = consultantCacheKey(mode, deterministic.selectionHash, identity);
  markSupersededSyntheses(db, projectId, mode, deterministic.selectionHash, 'The deterministic selection has changed since this view was generated.');
  const current = readConsultantSynthesis(db, projectId, mode, cacheKey);
  const fallback = current ?? readLatestConsultantSynthesis(db, projectId, mode);
  const state: SynthesisState = !fallback ? 'none' : current && !current.stale ? 'current' : 'stale';
  const availability = provider.availability?.() ?? null;
  return {
    projectId,
    mode,
    deterministic,
    synthesis: fallback ? { ...fallback, state } : null,
    identity: {
      ...identity,
      providerAvailable: provider.isAvailable(),
      providerDetail: availability?.detail ?? null,
    },
    synthesisState: state,
    failure: null,
    providerCallsThisRequest: 0,
  };
}

/* ------------------------------------------------------------------------------------ *
 * Generation — the only path that may call a provider
 * ------------------------------------------------------------------------------------ */

function readSkillBodyForSynthesis(db: DatabaseSync, projectId: string): { record: SkillRevisionRecord; body: string } | null {
  const record = resolveConsultantSkill(db, projectId);
  if (!record) return null;
  const asset = loadSkillRegistry().find((entry) => entry.skillId === record.skillId && entry.version === record.version);
  if (!asset || asset.sha256 !== record.sha256) return null;
  return { record, body: asset.body };
}

export interface GenerateConsultantViewOptions {
  /** Refuses when a current synthesis already exists unless this is set. */
  force?: boolean;
  actor?: string;
}

/**
 * Generate one consultant synthesis.
 *
 * Exactly one bounded provider call, or none at all:
 *  - a current cached synthesis returns immediately unless the caller forces;
 *  - an unavailable provider returns a readable failure and the deterministic
 *    view, which is never relabelled as generated;
 *  - a prompt over budget refuses rather than truncating the evidence pack;
 *  - a failed call is recorded, the previous synthesis is kept, and nothing
 *    retries.
 */
export async function generateConsultantView(
  db: DatabaseSync,
  projectId: string,
  mode: ConsultantViewMode,
  provider: GroundedBriefProvider,
  options: GenerateConsultantViewOptions = {},
): Promise<ConsultantViewResponse> {
  const deterministic = buildDeterministicConsultantView(db, projectId, mode);
  const identity = synthesisIdentity(db, projectId, provider);
  const cacheKey = consultantCacheKey(mode, deterministic.selectionHash, identity);
  markSupersededSyntheses(db, projectId, mode, deterministic.selectionHash, 'The deterministic selection has changed since this view was generated.');

  const base = (): ConsultantViewResponse => ({
    projectId,
    mode,
    deterministic,
    synthesis: null,
    identity: { ...identity, providerAvailable: provider.isAvailable(), providerDetail: provider.availability?.().detail ?? null },
    synthesisState: 'none',
    failure: null,
    providerCallsThisRequest: 0,
  });

  const cached = readConsultantSynthesis(db, projectId, mode, cacheKey);
  if (cached && !cached.stale && !options.force) {
    return { ...base(), synthesis: { ...cached, state: 'current' }, synthesisState: 'current' };
  }

  const previous = readLatestConsultantSynthesis(db, projectId, mode);
  const withFailure = (message: string, recoveryAction: string): ConsultantViewResponse => ({
    ...base(),
    // The deterministic view stands. The previous synthesis, if any, is still
    // shown and still labelled stale — never relabelled as this attempt's output.
    synthesis: previous ? { ...previous, state: 'stale' } : null,
    synthesisState: 'failed',
    failure: { message, recoveryAction },
  });

  if (deterministic.records.length === 0) {
    return withFailure(
      'There is nothing selected to reason about: this project has no open records in this view.',
      'Ingest and review a source, or switch to a view with selected records.',
    );
  }

  const skill = readSkillBodyForSynthesis(db, projectId);
  if (!skill) {
    return withFailure(
      `No usable "${CONSULTANT_BRIEF_SKILL_ID}" revision is in force: it is either unregistered, or its file is missing or has been rewritten in place.`,
      'Open Settings → AI Skills & Prompts and publish a Consultant Brief revision whose file is present and unmodified.',
    );
  }

  provider.refresh?.();
  if (!provider.isAvailable()) {
    const detail = provider.availability?.().detail ?? 'The configured brief provider did not respond.';
    return withFailure(
      `The consultant-brief provider is unavailable: ${detail}`,
      'Install or sign in to the local Claude CLI, then press Generate again. The deterministic view below is unaffected.',
    );
  }

  const prompt = [
    skill.body,
    '',
    '--- EVIDENCE PACK ---',
    stable({
      mode,
      themes: deterministic.themes
        .filter((theme) => theme.memberIds.some((id) => deterministic.selectedIds.includes(id)))
        .map((theme) => ({
          id: theme.id,
          label: theme.label,
          memberIds: theme.memberIds.filter((id) => deterministic.selectedIds.includes(id)),
          why: theme.basis.map((entry) => entry.detail),
          customerDependency: theme.customerDependency,
          unresolvedDecisions: theme.unresolvedDecisionCount,
          blockingCount: theme.blockingCount,
          overdueCount: theme.overdueCount,
        })),
      records: deterministic.records,
    }),
  ].join('\n');

  const promptTokens = estimateTokens(prompt);
  const promptSha256 = hash(prompt);
  const createdAt = nowIso();
  const recordRun = (status: string, error: string | null, outputSha256: string | null, inputTokens: number, outputTokens: number, durationMs: number, briefId: string | null) => {
    db.prepare(`INSERT INTO consultant_brief_runs
      (id, project_id, brief_id, selection_hash, provider_id, model_label, prompt_sha256, output_sha256, input_tokens, output_tokens, duration_ms, status, error, created_at,
       skill_id, skill_version, skill_sha256, prompt_template_version, packet_contract_version, mode, cache_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), projectId, briefId, deterministic.selectionHash, identity.providerId, identity.modelLabel, promptSha256, outputSha256,
        Math.max(0, Math.floor(inputTokens)), Math.max(0, Math.floor(outputTokens)), Math.round(durationMs), status, error, createdAt,
        identity.skillId, identity.skillVersion, identity.skillSha256, identity.promptTemplateVersion, identity.packetContractVersion, mode, cacheKey);
  };

  if (promptTokens > MAX_SYNTHESIS_PROMPT_TOKENS) {
    recordRun('budget-exceeded', `Assembled synthesis prompt was ${promptTokens} tokens against a ${MAX_SYNTHESIS_PROMPT_TOKENS} limit.`, null, promptTokens, 0, 0, null);
    return withFailure(
      `The evidence pack is too large to synthesise safely: ${promptTokens} tokens against a ${MAX_SYNTHESIS_PROMPT_TOKENS} limit.`,
      'Narrow the view, or shorten the Consultant Brief revision in Settings → AI Skills & Prompts. Nothing was truncated and no call was made.',
    );
  }

  const started = performance.now();
  let result;
  try {
    result = await provider.generate({ prompt, selectionHash: deterministic.selectionHash });
  } catch (error) {
    const durationMs = performance.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    recordRun('failed', message, null, promptTokens, 0, durationMs, null);
    return withFailure(
      `The consultant-brief provider failed: ${message}`,
      'This was a single attempt and nothing retries automatically. Press Generate again when the cause is fixed; the deterministic view below is unaffected.',
    );
  }

  const durationMs = performance.now() - started;
  const validation = validateBriefCitations(result.markdown, deterministic.selectedIds);
  const outputSha256 = hash(result.markdown);
  if (!validation.valid || !validation.markdown) {
    recordRun('citation-rejected', `Removed ${validation.removed} of ${validation.factual} factual lines; invalid citations: ${validation.invalidCitations.join(', ') || 'none'}.`, outputSha256, result.usage.inputTokens, result.usage.outputTokens, durationMs, null);
    return withFailure(
      `The generated narrative failed citation validation: ${validation.removed} of ${validation.factual} factual lines cited nothing selected${validation.invalidCitations.length ? `, and it cited ${validation.invalidCitations.join(', ')}, which are not in the selection` : ''}.`,
      'The narrative was discarded rather than shown with unsupported claims. Press Generate again, or improve the Consultant Brief revision in Settings → AI Skills & Prompts.',
    );
  }

  const citations = [...new Set([...validation.markdown.matchAll(/\[([A-Z][A-Z0-9-]*-\d+|SRC-\d+)\]/g)].map((match) => match[1]))];
  const id = `brief:${projectId}:${mode}:${cacheKey.slice(0, 16)}`;
  db.prepare(`INSERT INTO consultant_briefs
    (id, project_id, mode, selection_hash, cache_key, brief_markdown, citations_json, selected_ids_json, themes_json,
     provider_id, model_label, skill_id, skill_version, prompt_template_version, packet_contract_version,
     input_tokens, output_tokens, generated_at, stale, stale_reason, stale_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
    ON CONFLICT(project_id, mode, cache_key) DO UPDATE SET brief_markdown = excluded.brief_markdown, citations_json = excluded.citations_json,
      selected_ids_json = excluded.selected_ids_json, themes_json = excluded.themes_json, model_label = excluded.model_label,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, generated_at = excluded.generated_at,
      stale = 0, stale_reason = NULL, stale_at = NULL`)
    .run(id, projectId, mode, deterministic.selectionHash, cacheKey, validation.markdown, JSON.stringify(citations),
      JSON.stringify(deterministic.selectedIds),
      JSON.stringify(deterministic.themes.filter((theme) => theme.memberIds.some((member) => deterministic.selectedIds.includes(member))).map((theme) => ({ id: theme.id, label: theme.label, memberIds: theme.memberIds }))),
      identity.providerId, identity.modelLabel, identity.skillId, identity.skillVersion, identity.promptTemplateVersion, identity.packetContractVersion,
      Math.max(0, Math.floor(result.usage.inputTokens)), Math.max(0, Math.floor(result.usage.outputTokens)), createdAt);
  recordRun('complete', null, outputSha256, result.usage.inputTokens, result.usage.outputTokens, durationMs, id);

  const stored = readConsultantSynthesis(db, projectId, mode, cacheKey)!;
  return { ...base(), synthesis: { ...stored, state: 'current' }, synthesisState: 'current', providerCallsThisRequest: 1 };
}

/**
 * The downloadable form of a synthesis: the narrative plus the provenance that
 * makes it answerable, and never anything that is not already on screen.
 */
export function renderSynthesisMarkdown(view: ConsultantViewResponse): string {
  const synthesis = view.synthesis;
  const lines = [
    `# Consultant view — ${view.mode === 'meeting' ? 'Meeting Brief' : 'Needs Warwick'}`,
    '',
    `- Project: ${view.projectId}`,
    `- Deterministic selection: ${view.deterministic.selectedIds.length} record(s), hash ${view.deterministic.selectionHash.slice(0, 16)}`,
    `- Theme engine: ${view.deterministic.themeEngineVersion} (${view.deterministic.themes.length} theme(s))`,
  ];
  if (synthesis) {
    lines.push(
      `- Generated: ${synthesis.generatedAt}`,
      `- Provider / model: ${synthesis.providerId} / ${synthesis.modelLabel ?? 'unrecorded'}`,
      `- Consultant Brief skill: ${synthesis.skillId ?? 'unrecorded'} ${synthesis.skillVersion ?? ''} (prompt template ${synthesis.promptTemplateVersion ?? 'unrecorded'})`,
      `- Tokens: ${synthesis.inputTokens} in / ${synthesis.outputTokens} out`,
      `- Status: ${synthesis.state}${synthesis.staleReason ? ` — ${synthesis.staleReason}` : ''}`,
      '',
      '## Generated reasoning',
      '',
      synthesis.briefMarkdown,
      '',
      `Cited records: ${synthesis.citations.join(', ') || 'none'}`,
    );
  } else {
    lines.push('- Generated reasoning: none. This download contains the deterministic view only.');
  }
  lines.push('', '## Deterministic view', '');
  for (const section of view.deterministic.sections) {
    lines.push(`### ${section.title}`, '', section.description, '');
    if (section.rowIds.length === 0) lines.push('- Nothing currently qualifies.', '');
    else {
      for (const id of section.rowIds) {
        const record = view.deterministic.records.find((entry) => entry.id === id);
        lines.push(`- ${record ? `${record.title} — ${record.status}${record.owner ? `; owner ${record.owner}` : ''}${record.dueDate ? `; due ${record.dueDate}` : ''}` : 'record not in the bounded pack'} [${id}]`);
      }
      lines.push('');
    }
  }
  lines.push('## Themes', '');
  for (const theme of view.deterministic.themes) {
    lines.push(`### ${theme.label}`, '', `Members: ${theme.memberIds.join(', ')}`, '', ...theme.basis.map((entry) => `- ${entry.kind}: ${entry.detail}`), '');
  }
  return lines.join('\n').trim();
}

/** Re-exported so callers do not need to reach into `sourceIntelligence` for it. */
export { isStructuralHeading };
