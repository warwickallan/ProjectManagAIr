import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveDate } from './dateResolution.js';

export const SCORING_VERSION = 'source-intelligence-score-v1';
export const PROJECTOR_VERSION = 'current-state-projector-v1';

const registerNames = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'] as const;
type RegisterName = typeof registerNames[number];
type JsonObject = Record<string, unknown>;

function nowIso() {
  return new Date().toISOString();
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function normalized(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || ['true', 'yes', '1', 'blocking', 'blocked'].includes(normalized(value));
}

function rawValue(row: JsonObject, names: string[]): unknown {
  const byKey = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, '_'), value]));
  for (const name of names) {
    const value = byKey.get(name.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    if (value !== undefined && value !== null && text(value)) return value;
  }
  return null;
}

function rawDueValue(register: RegisterName, row: JsonObject): unknown {
  const names: Record<RegisterName, string[]> = {
    Decisions: ['due_date_raw', 'decision_needed_by'],
    Actions: ['due_date_raw', 'due_date', 'target_date'],
    Risks_Issues: ['due_date_raw', 'target_resolution_date', 'resolve_by', 'due_date'],
    Config_Changes: ['due_date_raw', 'due_date', 'target_date', 'follow_through_date'],
    Open_Questions: ['due_date_raw', 'answer_needed_by', 'resolve_by', 'due_date'],
    Milestones: ['due_date_raw', 'target_date', 'hard_stop_date', 'date'],
    Entities: ['due_date_raw'],
    Sources: ['due_date_raw'],
    Uncertainty: ['due_date_raw', 'resolve_by'],
  };
  return rawValue(row, names[register]);
}
export function isProjectConsultantOwner(db: DatabaseSync, projectId: string, owner: unknown): boolean {
  const candidate = normalized(owner);
  if (!candidate) return false;
  const project = db.prepare('SELECT owner FROM projects WHERE id = ?').get(projectId) as { owner: string | null } | undefined;
  const configuredOwner = normalized(project?.owner);
  return candidate === 'consultant' || candidate.includes('implementation consultant') || Boolean(configuredOwner && candidate === configuredOwner);
}

export function readTypedDetails(db: DatabaseSync, registerName: string, rowId: string): JsonObject {
  const query = registerName === 'Decisions' ? 'SELECT * FROM register_decision_details WHERE register_row_id = ?'
    : registerName === 'Risks_Issues' ? 'SELECT * FROM register_risk_issue_details WHERE register_row_id = ?'
      : registerName === 'Config_Changes' ? 'SELECT * FROM register_config_change_details WHERE register_row_id = ?'
        : registerName === 'Open_Questions' ? 'SELECT * FROM register_open_question_details WHERE register_row_id = ?'
          : registerName === 'Milestones' ? 'SELECT * FROM register_milestone_details WHERE register_row_id = ?'
            : registerName === 'Entities' ? 'SELECT * FROM register_entities WHERE register_row_id = ?'
              : registerName === 'Uncertainty' ? 'SELECT * FROM register_uncertainty WHERE register_row_id = ?'
                : null;
  if (!query) return {};
  const source = db.prepare(query).get(rowId) as JsonObject | undefined;
  if (!source) return {};
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (['register_row_id', 'project_id', 'external_register_id'].includes(key)) continue;
    if (key.endsWith('_json')) {
      try { result[key.replace(/_json$/, '')] = JSON.parse(String(value ?? '[]')) as unknown; } catch { result[key.replace(/_json$/, '')] = []; }
    } else result[key] = value;
  }
  return result;
}

function stateFor(db: DatabaseSync, projectId: string, row: Record<string, unknown>) {
  const state: Record<string, string | null> = {
    status: String(row.record_status),
    owner: row.owner ? String(row.owner) : null,
    due_date: row.due_date ? String(row.due_date) : null,
    resolution: null,
  };
  const events = db.prepare('SELECT * FROM register_row_events WHERE project_id = ? AND external_register_id = ? ORDER BY occurred_at, id').all(projectId, String(row.external_register_id)) as Array<Record<string, unknown>>;
  for (const event of events) {
    const field = event.field ? String(event.field) : null;
    if (field && Object.hasOwn(state, field)) state[field] = event.new_value === null ? null : String(event.new_value);
    const eventType = String(event.event_type);
    if (['complete', 'close', 'resolve', 'ratify', 'reject', 'park', 'reopen'].includes(eventType)) {
      state.status = eventType === 'reopen' ? 'open'
        : eventType === 'ratify' ? 'ratified'
          : eventType === 'reject' ? 'rejected'
            : eventType === 'park' ? 'parked'
              : eventType === 'complete' ? 'completed' : 'resolved';
    }
  }
  return { state, events };
}

function scoreRow(db: DatabaseSync, projectId: string, row: Record<string, unknown>, detail: JsonObject, state: Record<string, string | null>, events: Array<Record<string, unknown>>, timestamp: string) {
  const register = String(row.register_name) as RegisterName;
  const type: Record<RegisterName, number> = { Decisions: 90, Actions: 70, Risks_Issues: 80, Config_Changes: 40, Open_Questions: 60, Milestones: 40, Entities: 10, Sources: 0, Uncertainty: 30 };
  const severityLabel = normalized(detail.severity);
  const likelihoodLabel = normalized(detail.likelihood).replace(/ /g, '-');
  const blockingFlag = truthy(detail.blocking);
  const closed = ['resolved', 'closed', 'complete', 'completed', 'superseded', 'rejected', 'ratified', 'agreed', 'agreed in principle', 'accepted'].includes(normalized(state.status));
  const due = state.due_date && /^\d{4}-\d{2}-\d{2}$/.test(state.due_date) ? state.due_date : null;
  const now = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
  const dueDays = due ? Math.ceil((new Date(`${due}T00:00:00.000Z`).valueOf() - now.valueOf()) / 86400000) : null;
  const owner = state.owner ?? '';
  const conflict = Boolean(db.prepare("SELECT 1 FROM register_change_ops o JOIN register_changesets c ON c.id = o.changeset_id WHERE c.project_id = ? AND o.target_external_id = ? AND o.op = 'conflict' AND o.status = 'pending' LIMIT 1").get(projectId, String(row.external_register_id)));
  const latestSource = db.prepare('SELECT id FROM source_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  const touchedLatest = Boolean(latestSource && String(row.last_updated_source_id ?? '') === latestSource.id);
  const supersession = JSON.parse(String(row.supersession_ids_json ?? '[]')) as string[];
  const related = JSON.parse(String(row.related_ids_json ?? '[]')) as string[];
  const openUncertainty = related.some((id) => Boolean(db.prepare("SELECT 1 FROM project_register_rows WHERE project_id = ? AND external_register_id = ? AND register_name = 'Uncertainty' AND record_status NOT LIKE '%resolved%' LIMIT 1").get(projectId, id)));
  const createdAt = new Date(String(row.created_at)).valueOf();
  const staleness = !closed && events.length === 0 && Date.now() - createdAt > 21 * 86400000;
  const components = {
    type: type[register],
    severity: ({ critical: 40, high: 25, medium: 10, low: 0 } as Record<string, number>)[severityLabel] ?? 0,
    likelihood: ({ 'almost-certain': 15, likely: 10, possible: 5, unlikely: 0 } as Record<string, number>)[likelihoodLabel] ?? 0,
    blocking: blockingFlag ? 35 : 0,
    urgency: dueDays === null ? 0 : dueDays < 0 ? 50 : dueDays <= 3 ? 30 : dueDays <= 7 ? 15 : dueDays <= 14 ? 5 : 0,
    ownership: isProjectConsultantOwner(db, projectId, owner) ? 20 : owner ? 10 : 0,
    latestSource: touchedLatest ? 25 : 0,
    supersession: supersession.length ? 40 : 0,
    conflict: conflict ? 45 : 0,
    uncertainty: openUncertainty ? 15 : 0,
    staleness: staleness ? 10 : 0,
    closure: closed ? -200 : 0,
  };
  const score = Object.values(components).reduce((total, value) => total + value, 0);
  const band = closed ? 'Reference'
    : blockingFlag || conflict || (dueDays !== null && dueDays < 0) ? 'Now'
      : (dueDays !== null && dueDays <= 7) || ['critical', 'high'].includes(severityLabel) ? 'Soon'
        : score >= 80 ? 'Watch' : 'Reference';
  return {
    score,
    band,
    inputs: { ...components, dueDays, severity: severityLabel || null, likelihood: likelihoodLabel || null, blocking: blockingFlag, owner: state.owner },
  };
}

function decisionStatus(value: unknown): string {
  const status = normalized(value).replace(/ /g, '-');
  if (status.includes('supersed')) return 'superseded';
  if (status.includes('agreed-in-principle')) return 'agreed-in-principle';
  if (status.includes('pending-ratification')) return 'pending-ratification';
  if (status.includes('ratified')) return 'ratified';
  if (status.includes('rejected')) return 'rejected';
  if (status.includes('parked')) return 'parked';
  if (status.includes('agreed')) return 'agreed';
  if (/decid|closed|complete/.test(status)) return 'decided';
  if (status.includes('propos')) return 'proposed';
  return 'awaiting-user';
}

function milestoneStatus(value: unknown): string {
  const status = normalized(value).replace(/ /g, '-');
  if (['not-started', 'in-progress', 'at-risk', 'achieved', 'missed'].includes(status)) return status;
  return /complete|achiev/.test(status) ? 'achieved' : 'not-started';
}

function setAttention(db: DatabaseSync, table: string, projectId: string, id: string, band: string, owner: string | null, score: number) {
  const needs = ['Now', 'Soon'].includes(band) && (!owner || isProjectConsultantOwner(db, projectId, owner)) ? 1 : 0;
  const attentionOwner = needs ? 'current-user' : null;
  if (['actions', 'changes'].includes(table)) db.prepare(`UPDATE ${table} SET needs_user_attention = ?, attention_owner = ?, attention_reason = ? WHERE project_id = ? AND id = ?`).run(needs, attentionOwner, needs ? `${band} band; explainable score ${score}.` : null, projectId, id);
  else db.prepare(`UPDATE ${table} SET needs_user_attention = ?, attention_owner = ? WHERE project_id = ? AND id = ?`).run(needs, attentionOwner, projectId, id);
}

function insertOperational(db: DatabaseSync, projectId: string, register: RegisterName, id: string, raw: JsonObject, detail: JsonObject, state: Record<string, string | null>, score: { score: number; band: string }, timestamp: string) {
  const title = text(rawValue(raw, ['title', 'decision', 'action', 'risk_issue', 'risk', 'issue', 'question', 'milestone', 'entity', 'source', 'uncertainty', 'name', 'summary', 'description', 'change', 'item', 'filename'])) || id;
  const summary = text(rawValue(raw, ['summary', 'description', 'rationale', 'driver', 'mitigation', 'question', 'why_uncertain', 'notes', 'implications', 'item'])) || title;
  const owner = state.owner ?? (text(rawValue(raw, ['owner', 'assigned_to', 'lead', 'parked_with', 'decider', 'committed_by', 'made_by'])) || 'Unassigned');
  const status = state.status ?? 'open';
  const due = state.due_date;
  const base = [id, projectId, title, status, owner, timestamp, 'operational-reference', summary];
  if (register === 'Actions') {
    db.prepare('INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)').run(...base, normalized(raw.priority) || 'medium', due);
    setAttention(db, 'actions', projectId, id, score.band, owner, score.score);
  } else if (register === 'Decisions') {
    db.prepare('INSERT INTO decisions (id, project_id, title, status, owner, updated_at, data_classification, summary, decision_status, decision_needed_by, options_summary, outcome, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)').run(...base, decisionStatus(status), due, text(detail.options_summary), text(detail.outcome) || null);
    setAttention(db, 'decisions', projectId, id, score.band, owner, score.score);
  } else if (register === 'Risks_Issues') {
    const kind = normalized(rawValue(raw, ['type', 'kind'])).includes('issue') ? 'issue' : 'risk';
    const severity = ['low', 'medium', 'high', 'critical'].includes(normalized(detail.severity)) ? normalized(detail.severity) : 'unknown';
    const likelihood = ['unlikely', 'possible', 'likely', 'almost-certain'].includes(normalized(detail.likelihood).replace(/ /g, '-')) ? normalized(detail.likelihood).replace(/ /g, '-') : null;
    db.prepare('INSERT INTO risks_issues (id, project_id, title, status, owner, updated_at, data_classification, summary, kind, severity, likelihood, impact, response, target_resolution_date, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)').run(...base, kind, severity, likelihood, text(detail.impact) || summary, text(detail.mitigation) || summary, due);
    setAttention(db, 'risks_issues', projectId, id, score.band, owner, score.score);
  } else if (register === 'Config_Changes') {
    db.prepare('INSERT INTO changes (id, project_id, title, status, owner, updated_at, data_classification, summary, change_type, impact, decision_id, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)').run(...base, text(detail.change_type) || 'configuration', text(detail.impact) || summary, text(raw.decision_id) || null);
    setAttention(db, 'changes', projectId, id, score.band, owner, score.score);
  } else if (register === 'Open_Questions') {
    db.prepare('INSERT INTO open_questions (id, project_id, title, status, owner, updated_at, data_classification, summary, question, answer_needed_by, blocking, resolution, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)').run(...base, text(detail.question) || title, due, truthy(detail.blocking) ? 1 : 0, state.resolution);
    setAttention(db, 'open_questions', projectId, id, score.band, owner, score.score);
  } else if (register === 'Milestones') {
    db.prepare('INSERT INTO milestones (id, project_id, title, status, owner, updated_at, data_classification, summary, target_date, milestone_status, completion_percent, work_package_ids_json, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)').run(...base, due ?? '9999-12-31', milestoneStatus(status), Number(raw.completion_percent ?? 0), JSON.stringify(raw.work_package_tags ?? []));
    setAttention(db, 'milestones', projectId, id, score.band, owner, score.score);
  } else if (register === 'Sources') {
    db.prepare('INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, text(rawValue(raw, ['source_type', 'type'])) || 'source-intelligence', title, text(rawValue(raw, ['source_ref', 'path'])) || 'source-intelligence', timestamp, 'operational-reference');
  }
}

export function rebuildProjection(db: DatabaseSync, projectId: string, timestamp = nowIso()) {
  const rows = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId) as Array<Record<string, unknown>>;
  for (const table of ['actions', 'decisions', 'risks_issues', 'changes', 'open_questions', 'milestones', 'project_sources']) db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
  db.prepare('DELETE FROM register_row_state WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM register_row_scores WHERE project_id = ?').run(projectId);
  db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 0, ?) ON CONFLICT(project_id) DO NOTHING').run(projectId, timestamp);

  for (const row of rows) {
    const register = String(row.register_name) as RegisterName;
    const id = String(row.external_register_id);
    const raw = JSON.parse(String(row.raw_row_json)) as JsonObject;
    const detail = readTypedDetails(db, register, String(row.id));
    const { state, events } = stateFor(db, projectId, row);
    const source = row.source_id ? db.prepare('SELECT event_date FROM source_documents WHERE id = ?').get(String(row.source_id)) as { event_date: string | null } | undefined : undefined;
    const rawDue = text(rawDueValue(register, raw));
    const resolved = resolveDate(rawDue, source?.event_date ?? null);
    if (!events.some((event) => event.field === 'due_date')) state.due_date = resolved.date;
    db.prepare('UPDATE project_register_rows SET due_date = ?, due_date_raw = ?, due_date_confidence = ? WHERE id = ?').run(resolved.date, rawDue || null, resolved.confidence, String(row.id));
    const score = scoreRow(db, projectId, row, detail, state, events, timestamp);
    db.prepare('INSERT INTO register_row_state (project_id, external_register_id, register_name, status, owner, due_date, resolution, last_human_event_at, last_source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, id, register, state.status, state.owner, state.due_date, state.resolution, events.at(-1)?.occurred_at ? String(events.at(-1)?.occurred_at) : null, row.last_updated_source_id ? String(row.last_updated_source_id) : row.source_id ? String(row.source_id) : null, timestamp);
    db.prepare('INSERT INTO register_row_scores (project_id, external_register_id, score, band, inputs_json, scoring_version, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, id, score.score, score.band, JSON.stringify(score.inputs), SCORING_VERSION, timestamp);
    insertOperational(db, projectId, register, id, raw, detail, state, score, timestamp);
  }
  return { projectId, rowCount: rows.length, scoringVersion: SCORING_VERSION, projectorVersion: PROJECTOR_VERSION };
}

export function recordRegisterEvent(db: DatabaseSync, projectId: string, externalRegisterId: string, input: { actor: string; eventType: string; field?: string | null; newValue?: string | null; reason: string; evidenceRef?: string | null; occurredAt?: string }) {
  const row = db.prepare('SELECT 1 FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, externalRegisterId);
  if (!row) throw new Error('Register row not found.');
  const occurredAt = input.occurredAt ?? nowIso();
  const current = db.prepare('SELECT * FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, externalRegisterId) as Record<string, unknown> | undefined;
  const previous = input.field ? current?.[input.field] ?? null : null;
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(randomUUID(), projectId, externalRegisterId, occurredAt, input.actor, input.eventType, input.field ?? null, previous === null || previous === undefined ? null : String(previous), input.newValue ?? null, input.reason, input.evidenceRef ?? null);
    db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at').run(projectId, occurredAt);
    rebuildProjection(db, projectId, occurredAt);
    db.prepare('UPDATE consultant_briefs SET stale = 1 WHERE project_id = ?').run(projectId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { projectId, externalRegisterId, occurredAt };
}

export function readRowEvidence(db: DatabaseSync, projectId: string, externalRegisterId: string) {
  const anchors = db.prepare('SELECT * FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? ORDER BY id').all(projectId, externalRegisterId) as Array<Record<string, unknown>>;
  const events = db.prepare('SELECT * FROM register_row_events WHERE project_id = ? AND external_register_id = ? ORDER BY occurred_at DESC, id DESC').all(projectId, externalRegisterId) as Array<Record<string, unknown>>;
  return {
    anchors: anchors.map((row) => ({ id: String(row.id), sourceId: String(row.source_id), segmentId: String(row.segment_id), speaker: row.speaker ? String(row.speaker) : null, tMs: row.t_ms === null ? null : Number(row.t_ms), quote: row.quote ? String(row.quote) : null, verified: row.verified === 1 })),
    events: events.map((row) => ({ id: String(row.id), occurredAt: String(row.occurred_at), actor: String(row.actor), eventType: String(row.event_type), field: row.field ? String(row.field) : null, previousValue: row.previous_value ? String(row.previous_value) : null, newValue: row.new_value ? String(row.new_value) : null, reason: String(row.reason), evidenceRef: row.evidence_ref ? String(row.evidence_ref) : null })),
  };
}
