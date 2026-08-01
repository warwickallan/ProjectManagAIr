/**
 * The Consultant Reasoning request: the complete approved project state,
 * assembled deterministically and hashed.
 *
 * This is the input the reasoning skill is contractually promised. The skill's
 * own doctrine forbids substituting a deterministic top-N selection, a
 * pre-written review pack or a fixed theme list for the project state — those
 * remain the zero-call fallback and evidence browser, nothing more. So this
 * module reads EVERY current approved register row and hands the model the
 * whole picture.
 *
 * The project-state hash computed here is the cache key and the staleness
 * signal. It covers the register content the model actually sees, so any
 * applied changeset that moves a row invalidates the cached reasoning, and a
 * change that touches nothing the model saw does not.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readTypedDetails } from './registerProjection.js';
import type { BriefMode } from './consultantReasoningContract.js';

/** Registers whose rows are project memory worth reasoning over. */
const REASONING_REGISTERS = [
  'Decisions', 'Actions', 'Risks_Issues', 'Config_Changes',
  'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty',
] as const;

export interface ReasoningStateRow {
  register_id: string;
  register: string;
  title: string;
  summary: string;
  status: string;
  record_status: string;
  owner: string | null;
  due_date: string | null;
  overdue: boolean;
  severity: string | null;
  blocking: boolean;
  conflict: boolean;
  band: string;
  details: Record<string, unknown>;
  related_ids: string[];
  supersedes: string[];
  superseded: boolean;
  /** Evidence availability only — never the quote itself (skill rule 13). */
  anchor_count: number;
  verified_anchor_count: number;
  confidence: string | null;
  derivation: string | null;
  first_seen_source_id: string | null;
  last_updated_source_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  latest_events: Array<{ occurredAt: string; actor: string; eventType: string; reason: string }>;
}

export interface ReasoningRequest {
  request: {
    mode: BriefMode;
    purpose: string;
    audience: string;
    time_horizon: string;
    meeting_context: string | null;
    current_date: string;
  };
  project: {
    project_id: string;
    code: string;
    name: string;
    customer: string | null;
    lifecycle_stage: string | null;
    target_date: string | null;
    consultant_identity: string;
    consultant_aliases: string[];
    customer_identities: string[];
    latest_processed_source_at: string | null;
    latest_processed_source_event_date: string | null;
    register_revision: number;
    project_state_hash: string;
  };
  current_state: ReasoningStateRow[];
  recent_changes: Array<{ register_id: string; change: string; occurredAt: string; actor: string }>;
}

export interface BuildRequestOptions {
  mode: BriefMode;
  purpose?: string;
  audience?: string;
  timeHorizon?: string;
  meetingContext?: string | null;
  currentDate?: string;
  consultantIdentity?: string;
  consultantAliases?: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter((entry) => entry && entry !== '-') : [];
  } catch {
    return [];
  }
}

const CLOSED_STATUS = /\b(closed|done|complete|completed|resolved|cancelled|canceled|withdrawn)\b/i;

/**
 * Assemble the complete approved project state for one reasoning run.
 *
 * Deliberately NOT filtered to open rows: a settled decision is exactly what
 * lets the model reconcile an earlier question as answered, and a superseded
 * row is what lets it see a reversal. Filtering here would reintroduce the
 * blindness the deterministic pack suffered from. Superseded rows are marked,
 * not removed.
 */
export function buildReasoningRequest(db: DatabaseSync, projectId: string, options: BuildRequestOptions): ReasoningRequest {
  const project = db.prepare('SELECT id, code, name, summary, owner, stage, delivery_status, target_date FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`No project ${projectId}.`);

  const placeholders = REASONING_REGISTERS.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT r.id row_id, r.external_register_id, r.register_name, r.title, r.summary, r.record_status,
      r.related_ids_json, r.supersession_ids_json, r.derivation, r.confidence,
      r.first_seen_source_id, r.last_updated_source_id, r.created_at, r.updated_at,
      s.status, s.owner, s.due_date, sc.score, sc.band, sc.inputs_json
    FROM project_register_rows r
    JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
    JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
    WHERE r.project_id = ? AND r.register_name IN (${placeholders})
    ORDER BY r.external_register_id`).all(projectId, ...REASONING_REGISTERS) as Array<Record<string, unknown>>;

  const today = (db.prepare("SELECT date('now') today").get() as { today: string }).today;

  const anchorCounts = new Map<string, { total: number; verified: number }>();
  for (const row of db.prepare('SELECT external_register_id, count(*) total, sum(verified) verified FROM register_row_anchors WHERE project_id = ? GROUP BY external_register_id').all(projectId) as Array<Record<string, unknown>>) {
    anchorCounts.set(String(row.external_register_id), { total: Number(row.total ?? 0), verified: Number(row.verified ?? 0) });
  }

  const eventsByRow = new Map<string, Array<{ occurredAt: string; actor: string; eventType: string; reason: string }>>();
  for (const row of db.prepare('SELECT external_register_id, occurred_at, actor, event_type, reason FROM register_row_events WHERE project_id = ? ORDER BY occurred_at DESC, rowid DESC').all(projectId) as Array<Record<string, unknown>>) {
    const key = String(row.external_register_id);
    const list = eventsByRow.get(key) ?? [];
    // Three most recent per row: enough to see a reversal or a human
    // correction without turning the request into an event log.
    if (list.length < 3) {
      list.push({ occurredAt: String(row.occurred_at), actor: String(row.actor), eventType: String(row.event_type), reason: String(row.reason) });
      eventsByRow.set(key, list);
    }
  }

  const currentState: ReasoningStateRow[] = rows.map((row) => {
    const id = String(row.external_register_id);
    const registerName = String(row.register_name);
    const inputs = JSON.parse(String(row.inputs_json)) as Record<string, unknown>;
    const status = String(row.status);
    const dueDate = row.due_date ? String(row.due_date) : null;
    const anchors = anchorCounts.get(id) ?? { total: 0, verified: 0 };
    return {
      register_id: id,
      register: registerName,
      title: String(row.title),
      summary: String(row.summary ?? ''),
      status,
      record_status: String(row.record_status),
      owner: row.owner === null || row.owner === undefined ? null : String(row.owner),
      due_date: dueDate,
      overdue: Boolean(dueDate && dueDate < today && !CLOSED_STATUS.test(status)),
      severity: inputs.severity ? String(inputs.severity) : null,
      blocking: Boolean(inputs.blocking),
      conflict: Number(inputs.conflict ?? 0) > 0,
      band: String(row.band),
      details: readTypedDetails(db, registerName, String(row.row_id)),
      related_ids: safeJsonArray(row.related_ids_json),
      supersedes: safeJsonArray(row.supersession_ids_json),
      superseded: String(row.record_status) === 'superseded',
      anchor_count: anchors.total,
      verified_anchor_count: anchors.verified,
      confidence: row.confidence ? String(row.confidence) : null,
      derivation: row.derivation ? String(row.derivation) : null,
      first_seen_source_id: row.first_seen_source_id ? String(row.first_seen_source_id) : null,
      last_updated_source_id: row.last_updated_source_id ? String(row.last_updated_source_id) : null,
      created_at: row.created_at ? String(row.created_at) : null,
      updated_at: row.updated_at ? String(row.updated_at) : null,
      latest_events: eventsByRow.get(id) ?? [],
    };
  });

  const source = db.prepare('SELECT original_file_name, event_date, created_at FROM source_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as Record<string, unknown> | undefined;
  const revision = db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(projectId) as { revision: number | null } | undefined;

  // The hash covers exactly what the model is shown. A change the model could
  // not see must not invalidate its answer, and one it could see must.
  const projectStateHash = createHash('sha256').update(stable(currentState), 'utf8').digest('hex');

  const recentChanges = currentState
    .filter((row) => row.latest_events.length > 0)
    .flatMap((row) => row.latest_events.map((event) => ({
      register_id: row.register_id, change: `${event.eventType}: ${event.reason}`, occurredAt: event.occurredAt, actor: event.actor,
    })))
    .sort((left, right) => (left.occurredAt < right.occurredAt ? 1 : -1))
    .slice(0, 40);

  const consultantIdentity = options.consultantIdentity ?? (project.owner ? String(project.owner) : 'the consultant');
  const customerIdentities = [...new Set(currentState
    .map((row) => row.owner)
    .filter((owner): owner is string => Boolean(owner)))]
    .sort();

  return {
    request: {
      mode: options.mode,
      purpose: options.purpose ?? 'Prepare the implementation consultant for the next customer session.',
      audience: options.audience ?? 'Implementation Consultant',
      time_horizon: options.timeHorizon ?? 'the next one to two weeks',
      meeting_context: options.meetingContext ?? null,
      current_date: options.currentDate ?? new Date().toISOString().slice(0, 10),
    },
    project: {
      project_id: String(project.id),
      code: String(project.code),
      name: String(project.name),
      customer: project.summary ? String(project.summary) : null,
      lifecycle_stage: [project.stage, project.delivery_status].filter(Boolean).map(String).join(' / ') || null,
      target_date: project.target_date ? String(project.target_date) : null,
      consultant_identity: consultantIdentity,
      consultant_aliases: options.consultantAliases ?? [consultantIdentity],
      customer_identities: customerIdentities,
      latest_processed_source_at: source?.created_at ? String(source.created_at) : null,
      latest_processed_source_event_date: source?.event_date ? String(source.event_date) : null,
      register_revision: Number(revision?.revision ?? 0),
      project_state_hash: projectStateHash,
    },
    current_state: currentState,
    recent_changes: recentChanges,
  };
}

/** Every register ID the model is allowed to cite. The validator's allow-list. */
export function allowedRegisterIds(request: ReasoningRequest): string[] {
  return request.current_state.map((row) => row.register_id);
}

/**
 * The cache key for an accepted reasoning result.
 *
 * Includes everything that could change the answer: the state the model saw,
 * the mode it was asked for, the exact skill revision and prompt template, and
 * the provider and model. Omitting any one of them would serve an answer
 * produced under different conditions under this one's name.
 */
export function reasoningCacheKey(parts: {
  projectId: string;
  projectStateHash: string;
  mode: string;
  skillId: string;
  skillVersion: string;
  promptTemplateVersion: string;
  providerId: string;
  modelLabel: string;
}): string {
  return createHash('sha256').update(stable(parts), 'utf8').digest('hex');
}
