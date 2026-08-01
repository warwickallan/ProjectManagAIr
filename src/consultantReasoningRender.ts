/**
 * Resolving a reasoning result's citations to canonical evidence.
 *
 * The division of labour is deliberate and is the reason the reasoning output
 * can be trusted at all: **the model cites register IDs; Project ManagAIr
 * supplies the quotes.** The skill is explicitly forbidden from reproducing or
 * rewriting transcript evidence, so every anchor a consultant reads here came
 * out of the database, not out of a language model. A fabricated quote is
 * therefore not a risk that needs detecting — it is unrepresentable.
 */

import type { DatabaseSync } from 'node:sqlite';
import { readTypedDetails } from './registerProjection.js';
import type { ReasoningOutput } from './consultantReasoningContract.js';

export interface ResolvedAnchor {
  sourceId: string;
  segmentId: string;
  speaker: string | null;
  tMs: number | null;
  quote: string | null;
  verified: boolean;
}

export interface ResolvedRegisterRow {
  registerId: string;
  register: string;
  title: string;
  summary: string;
  status: string;
  owner: string | null;
  dueDate: string | null;
  overdue: boolean;
  severity: string | null;
  band: string;
  superseded: boolean;
  details: Record<string, unknown>;
  anchors: ResolvedAnchor[];
  /** True when the row carries no anchor at all — the drill-down must say so. */
  unanchored: boolean;
}

export interface ReasoningEvidence {
  /** Keyed by register ID. Every ID the accepted output cites resolves here. */
  rows: Record<string, ResolvedRegisterRow>;
  /**
   * IDs the result cites that no longer resolve. Normally empty: the validator
   * refuses unknown IDs at generation time. A non-empty list means the register
   * moved under a cached result, which is a staleness signal worth showing.
   */
  unresolved: string[];
}

const CLOSED_STATUS = /\b(closed|done|complete|completed|resolved|cancelled|canceled|withdrawn)\b/i;

/**
 * Resolve every register ID an accepted reasoning result cites.
 *
 * Reads whatever the result actually references rather than the whole
 * register, so the drill-down payload stays proportional to the brief.
 */
export function resolveReasoningEvidence(db: DatabaseSync, projectId: string, result: ReasoningOutput): ReasoningEvidence {
  const ids = new Set<string>();
  for (const point of result.executive_summary ?? []) for (const id of point.supporting_register_ids ?? []) ids.add(id);
  for (const matter of result.matters ?? []) for (const id of matter.supporting_register_ids ?? []) ids.add(id);
  for (const point of result.state_observations ?? []) for (const id of point.supporting_register_ids ?? []) ids.add(id);
  for (const point of result.limitations ?? []) for (const id of point.supporting_register_ids ?? []) ids.add(id);

  const rows: Record<string, ResolvedRegisterRow> = {};
  const unresolved: string[] = [];
  if (ids.size === 0) return { rows, unresolved };

  const today = (db.prepare("SELECT date('now') today").get() as { today: string }).today;
  const placeholders = [...ids].map(() => '?').join(', ');
  const found = db.prepare(`SELECT r.id row_id, r.external_register_id, r.register_name, r.title, r.summary, r.record_status,
      s.status, s.owner, s.due_date, sc.band, sc.inputs_json
    FROM project_register_rows r
    JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
    JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
    WHERE r.project_id = ? AND r.external_register_id IN (${placeholders})`).all(projectId, ...ids) as Array<Record<string, unknown>>;

  const anchorStatement = db.prepare('SELECT source_id, segment_id, speaker, t_ms, quote, verified FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? ORDER BY source_id, segment_id, rowid');

  for (const row of found) {
    const id = String(row.external_register_id);
    const inputs = JSON.parse(String(row.inputs_json)) as Record<string, unknown>;
    const status = String(row.status);
    const dueDate = row.due_date ? String(row.due_date) : null;
    const anchors = (anchorStatement.all(projectId, id) as Array<Record<string, unknown>>).map((anchor) => ({
      sourceId: String(anchor.source_id),
      segmentId: String(anchor.segment_id),
      speaker: anchor.speaker ? String(anchor.speaker) : null,
      tMs: anchor.t_ms === null ? null : Number(anchor.t_ms),
      quote: anchor.quote ? String(anchor.quote) : null,
      verified: Number(anchor.verified) === 1,
    }));
    rows[id] = {
      registerId: id,
      register: String(row.register_name),
      title: String(row.title),
      summary: String(row.summary ?? ''),
      status,
      owner: row.owner === null || row.owner === undefined ? null : String(row.owner),
      dueDate,
      overdue: Boolean(dueDate && dueDate < today && !CLOSED_STATUS.test(status)),
      severity: inputs.severity ? String(inputs.severity) : null,
      band: String(row.band),
      superseded: String(row.record_status) === 'superseded',
      details: readTypedDetails(db, String(row.register_name), String(row.row_id)),
      anchors,
      unanchored: anchors.length === 0,
    };
  }

  for (const id of ids) if (!rows[id]) unresolved.push(id);
  return { rows, unresolved: unresolved.sort() };
}

/**
 * Render an accepted result as markdown, for download and for the out-of-Git
 * acceptance report. Deliberately terse: the skill targets a primary brief
 * under 700 words, and a renderer that pads it defeats the point.
 */
export function renderReasoningMarkdown(result: ReasoningOutput, evidence: ReasoningEvidence, context: {
  projectName: string; generatedAt: string; skillId: string; skillVersion: string;
  promptTemplateVersion: string; providerId: string; modelLabel: string;
  projectStateHash: string; resultSha256: string; registerRevision: number; providerCalls: number;
}): string {
  const byId = new Map((result.matters ?? []).map((matter) => [matter.matter_id, matter]));
  const lines: string[] = [];

  lines.push(`# ${context.projectName} — Consultant Reasoning Brief`);
  lines.push('');
  lines.push(`**Mode:** ${result.brief_type} · **Generated:** ${context.generatedAt} · **Provider calls:** ${context.providerCalls}`);
  lines.push(`**Skill:** \`${context.skillId}@${context.skillVersion}\` · **Prompt template:** \`${context.promptTemplateVersion}\` · **Model:** ${context.modelLabel} (${context.providerId})`);
  lines.push(`**Project-state hash:** \`${context.projectStateHash.slice(0, 16)}\` · **Register revision:** ${context.registerRevision} · **Result hash:** \`${context.resultSha256.slice(0, 16)}\``);
  lines.push('');
  lines.push('> Every point below cites approved register IDs. The reasoning is the model\'s; the quoted evidence under each citation is resolved from the database by Project ManagAIr, never written by the model.');
  lines.push('');

  lines.push('## Executive summary');
  lines.push('');
  for (const point of result.executive_summary ?? []) {
    lines.push(`- ${point.text} ${point.supporting_register_ids.map((id) => `\`[${id}]\``).join(' ')}`);
  }
  lines.push('');

  // A matter is explained ONCE, in the first section that claims it, and
  // referenced by title everywhere else. The skill's contract says a matter may
  // appear in several section arrays "without repeating its prose", and a
  // renderer that repeats it anyway reintroduces exactly the scattered,
  // duplicated presentation the second intelligence exists to remove.
  const explained = new Set<string>();

  const section = (title: string, matterIds: string[], note?: string) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (note) { lines.push(note); lines.push(''); }
    if (!matterIds || matterIds.length === 0) { lines.push('_None._'); lines.push(''); return; }
    for (const matterId of matterIds) {
      const matter = byId.get(matterId);
      if (!matter) continue;
      const flags = [
        matter.priority,
        matter.state !== 'confirmed_current' ? `**${matter.state.replace(/_/g, ' ')}**` : null,
        matter.evidence_strength !== 'strong' ? `${matter.evidence_strength} evidence` : null,
      ].filter(Boolean).join(' · ');

      if (explained.has(matterId)) {
        // Cross-reference only: one line, enough to see it belongs here.
        lines.push(`- **${matter.title}** \`[${matter.matter_id}]\` — ${flags} · owner: ${matter.owner_class}. _Detailed above._`);
        continue;
      }
      explained.add(matterId);

      lines.push(`### ${matter.title} \`[${matter.matter_id}]\``);
      lines.push('');
      lines.push(`*${flags} · owner: ${matter.owner_class} · ${matter.classification.replace(/_/g, ' ')}*`);
      lines.push('');
      lines.push(`**Situation.** ${matter.situation}`);
      lines.push('');
      lines.push(`**Why it matters.** ${matter.why_it_matters}`);
      lines.push('');
      lines.push(`**Recommended move.** ${matter.recommended_move}`);
      lines.push('');
      lines.push(`**Reasoning.** ${matter.reasoning}`);
      lines.push('');
      lines.push(`**Supporting records:** ${matter.supporting_register_ids.map((id) => `\`${id}\``).join(', ')}`);
      lines.push('');
    }
    lines.push('');
  };

  section('Meeting order', result.meeting_order ?? [], 'The matters that genuinely deserve discussion, most important first.');
  section('Decisions required', result.decisions_required ?? []);
  section('Customer dependencies', result.customer_dependencies ?? []);
  section('Consultant next actions', result.consultant_next_actions ?? []);
  section('Risks and blockers', result.risks_and_blockers ?? []);
  section('Unanswered questions', result.unanswered_questions ?? [], 'Questions answered by later state have been reconciled out.');
  section('Contradictions and state conflicts', result.contradictions_and_state_conflicts ?? []);
  section('Recent changes', result.recent_changes ?? []);
  section('Confirmation warnings', result.confirmation_warnings ?? [], 'Stale, conflicted or weakly supported. **Do not treat as confirmed truth.**');

  if ((result.state_observations ?? []).length > 0) {
    lines.push('## State observations (for human review — not applied)');
    lines.push('');
    for (const point of result.state_observations) {
      lines.push(`- ${point.observation} ${point.supporting_register_ids.map((id) => `\`[${id}]\``).join(' ')}`);
    }
    lines.push('');
  }

  if ((result.limitations ?? []).length > 0) {
    lines.push('## Limitations');
    lines.push('');
    for (const point of result.limitations) {
      lines.push(`- ${point.text}${point.supporting_register_ids.length ? ` ${point.supporting_register_ids.map((id) => `\`[${id}]\``).join(' ')}` : ''}`);
    }
    lines.push('');
  }

  /* ---- the evidence, resolved deterministically from the register */
  lines.push('---');
  lines.push('');
  lines.push('# Evidence appendix — resolved from the register');
  lines.push('');
  lines.push('Every cited record, with the canonical row and its verbatim source anchors as stored. Quotes here were never generated.');
  lines.push('');
  for (const id of Object.keys(evidence.rows).sort()) {
    const row = evidence.rows[id];
    lines.push(`### ${id} — ${row.title}`);
    lines.push('');
    lines.push(`- **${row.register}** · status ${row.status} · band ${row.band}${row.severity ? ` · severity ${row.severity}` : ''}${row.superseded ? ' · **superseded**' : ''}`);
    lines.push(`- Owner: ${row.owner ?? 'unowned'}${row.dueDate ? ` · due ${row.dueDate}${row.overdue ? ' (overdue as at last processed source)' : ''}` : ''}`);
    if (row.summary) lines.push(`- ${row.summary}`);
    lines.push('');
    if (row.unanchored) {
      lines.push('_No source anchor on this row — it came from a reaffirmation or a live-session change. Requires confirmation._');
      lines.push('');
    } else {
      for (const anchor of row.anchors) {
        const when = anchor.tMs === null ? '' : ` @ ${Math.floor(anchor.tMs / 3600000)}:${String(Math.floor((anchor.tMs % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((anchor.tMs % 60000) / 1000)).padStart(2, '0')}`;
        lines.push(`> ${anchor.speaker ?? 'unknown speaker'}${when}: "${(anchor.quote ?? '').trim()}"${anchor.verified ? '' : ' _(unverified quote match)_'}`);
        lines.push('');
      }
    }
  }

  if (evidence.unresolved.length > 0) {
    lines.push('## Unresolved citations');
    lines.push('');
    lines.push(`These cited IDs no longer resolve, which means the register moved after this result was generated: ${evidence.unresolved.map((id) => `\`${id}\``).join(', ')}. Regenerate before relying on the brief.`);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}
