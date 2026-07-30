import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { resolveDate } from './dateResolution.js';
import { estimateTokens } from './extractionProvider.js';
import type { GroundedBriefProvider } from './briefProvider.js';
import { normalizeSource, SOURCE_NORMALISER_VERSION, type NormalizedDocument, type NormalizedSegment } from './sourceNormalizers.js';
import { isProjectConsultantOwner, PROJECTOR_VERSION, rebuildProjection, readRowEvidence, readTypedDetails, SCORING_VERSION } from './registerProjection.js';

export const PACKET_VERSION = 1;
export const VALIDATOR_VERSION = 'source-intelligence-validator-v1';
export const RECONCILIATION_VERSION = 'reconciliation-engine-v1';
export const DATABASE_SCHEMA_VERSION = '010';

const registerNames = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'] as const;
type RegisterName = typeof registerNames[number];
type JsonObject = Record<string, unknown>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const detailsSchema = z.record(z.string(), z.union([scalar, z.array(scalar)])).superRefine((value, context) => {
  const allowed = new Set([
    'rationale', 'options_summary', 'outcome', 'decision_needed_by',
    'driver', 'evidence', 'impact', 'mitigation', 'likelihood', 'severity',
    'environment', 'change_type', 'follow_through',
    'question', 'parked_with', 'unblocked_by', 'blocking',
    'target_date', 'milestone_status', 'conditional_logic',
    'entity_type', 'aliases', 'alias_confidence', 'disambiguation_note', 'hypothetical',
    'source_type', 'why_uncertain', 'resolve_by', 'resolution_route',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) context.addIssue({ code: 'custom', path: [key], message: `Unknown typed detail field: ${key}` });
});

const anchorSchema = z.object({
  segment_seq: z.number().int().positive(),
  speaker: z.string().min(1).nullable().default(null),
  t_ms: z.number().int().nonnegative().nullable().default(null),
  quote: z.string().min(1).nullable().default(null),
}).strict();

const packetRowSchema = z.object({
  client_ref: z.string().min(1),
  op: z.enum(['add', 'update', 'resolve', 'supersede', 'reaffirm']),
  target_id: z.string().min(1).nullable(),
  proposed_id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  status: z.string().min(1).default('open'),
  record_type: z.string().nullable().default(null),
  owner: z.string().nullable().default(null),
  due_date_raw: z.string().nullable().default(null),
  source_ref: z.string().min(1),
  related_refs: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
  anchors: z.array(anchorSchema).min(1),
  derivation: z.enum(['fact', 'inference']),
  reasoning: z.string().min(1).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  discharges_markers: z.array(z.string()).default([]),
  details: detailsSchema.default({}),
}).strict();

const coverageEntrySchema = z.object({
  key: z.string().min(1),
  status: z.enum(['reviewed', 'populated', 'none-found', 'uncertain', 'failed', 'no-governance-content']),
  item_count: z.number().int().nonnegative(),
  explanation: z.string().min(1).nullable(),
}).strict();

const packetSchema = z.object({
  packet_type: z.literal('project_register_delta'),
  packet_version: z.literal(PACKET_VERSION),
  project_code: z.string().min(1),
  base_register_revision: z.number().int().nonnegative(),
  source: z.object({
    source_id: z.string().min(1),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_type: z.string().min(1),
    original_file_name: z.string().min(1),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    participants: z.array(z.string()),
  }).strict(),
  sheets: z.object({
    Decisions: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Actions: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Risks_Issues: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Config_Changes: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Open_Questions: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Milestones: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Entities: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Sources: z.object({ rows: z.array(packetRowSchema) }).strict(),
    Uncertainty: z.object({ rows: z.array(packetRowSchema) }).strict(),
  }).strict(),
  coverage: z.object({
    windows: z.array(coverageEntrySchema),
    categories: z.array(coverageEntrySchema),
  }).strict(),
  execution: z.object({ runs: z.array(z.string().min(1)).min(1) }).strict(),
}).strict();

export type SourceIntelligencePacket = z.infer<typeof packetSchema>;

interface ValidationIssue {
  rule: string;
  severity: 'blocker' | 'warning';
  message: string;
  clientRef?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedQuote(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || ['true', 'yes', '1', 'blocking', 'blocked'].includes(normalizedQuote(String(value ?? '')));
}

function tokenEstimate(value: string): number {
  return Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.35);
}

function nextSourceId(db: DatabaseSync, projectId: string): string {
  const existing = db.prepare("SELECT id FROM source_documents WHERE project_id = ? AND id LIKE 'SRC-%' ORDER BY CAST(substr(id, 5) AS INTEGER) DESC LIMIT 1").get(projectId) as { id: string } | undefined;
  return `SRC-${String(existing ? Number(existing.id.slice(4)) + 1 : 1).padStart(3, '0')}`;
}

function makeWindows(segments: NormalizedSegment[]) {
  const target = 5000;
  const overlap = 500;
  const windows: Array<{ seq: number; startSeq: number; endSeq: number; tokenEstimate: number }> = [];
  let startIndex = 0;
  while (startIndex < segments.length) {
    let tokens = 0;
    let endIndex = startIndex;
    while (endIndex < segments.length && (tokens < target || endIndex === startIndex)) {
      tokens += tokenEstimate(segments[endIndex].text);
      endIndex += 1;
    }
    windows.push({ seq: windows.length + 1, startSeq: segments[startIndex].seq, endSeq: segments[endIndex - 1].seq, tokenEstimate: tokens });
    if (endIndex >= segments.length) break;
    let overlapTokens = 0;
    let nextStart = endIndex;
    while (nextStart > startIndex && overlapTokens < overlap) {
      nextStart -= 1;
      overlapTokens += tokenEstimate(segments[nextStart].text);
    }
    startIndex = Math.max(startIndex + 1, nextStart);
  }
  return windows;
}

function preScan(document: NormalizedDocument) {
  const markers: Array<{ id: string; segmentSeq: number; confidence: 'high' | 'medium' | 'low'; markerType: string; matchedText: string }> = [];
  const high = [
    { type: 'explicit-action', pattern: /\b(?:that'?s an action|action (?:on|for) (?:me|us|you|yourselves)|i(?:'ll| will| need to) (?:check|confirm|send|update|add|remove|create|suppress|come back|follow up))\b/i },
    { type: 'explicit-register', pattern: /\b(?:capture|record|add) (?:that|this) (?:for|to|in) (?:the )?(?:decision|action|risk|question|register|log)\b/i },
    { type: 'explicit-date', pattern: /\b(?:by (?:the )?end of (?:the )?week|by friday|next (?:monday|tuesday|wednesday|thursday|friday)|\d{4}-\d{2}-\d{2})\b/i },
    { type: 'live-config-act', pattern: /\b(?:i(?:'ll| have| just| am going to)|let me)\b.{0,80}\b(?:add|change|tick|save|suppress|configure|rename|remove)\b/i },
  ];
  const medium = [
    { type: 'commitment-pattern', pattern: /\b(?:we need to|i need to think|i(?:'ll| will) come back|i(?:'ll| will) check)\b/i },
    { type: 'question-pattern', pattern: /\?$/ },
    { type: 'constraint-pattern', pattern: /\b(?:can only|cannot|isn'?t able|doesn'?t support|limited to)\b/i },
  ];
  const low = /\b(?:risk|question|issue|concern|cannot|not|noted)\b/i;
  for (const segment of document.segments) {
    for (const candidate of high) {
      const match = segment.text.match(candidate.pattern);
      if (match) markers.push({ id: `marker:${segment.seq}:${candidate.type}`, segmentSeq: segment.seq, confidence: 'high', markerType: candidate.type, matchedText: match[0] });
    }
    for (const candidate of medium) {
      const match = segment.text.match(candidate.pattern);
      if (match) markers.push({ id: `marker:${segment.seq}:${candidate.type}`, segmentSeq: segment.seq, confidence: 'medium', markerType: candidate.type, matchedText: match[0] });
    }
    const hint = segment.text.match(low);
    if (hint) markers.push({ id: `marker:${segment.seq}:lexical`, segmentSeq: segment.seq, confidence: 'low', markerType: 'lexical-hint', matchedText: hint[0] });
  }
  return markers;
}

export function registerNormalizedSource(db: DatabaseSync, input: { projectId: string; intakeSourceId: string; fileName: string; immutablePath: string; contentHash: string; bytes?: Buffer; eventDate?: string | null }) {
  const existing = db.prepare('SELECT id FROM source_documents WHERE project_id = ? AND content_hash = ?').get(input.projectId, input.contentHash) as { id: string } | undefined;
  if (existing) return { sourceId: existing.id, duplicate: true };
  const bytes = input.bytes ?? readFileSync(input.immutablePath);
  if (hash(bytes) !== input.contentHash) throw new Error('Source bytes do not match the registered intake hash.');
  const document = normalizeSource(input.fileName, bytes, input.eventDate);
  if (document.segments.length === 0) throw new Error('Source normalisation produced no mechanically addressable segments.');
  const sourceId = nextSourceId(db, input.projectId);
  const windows = makeWindows(document.segments);
  const markers = preScan(document);
  const createdAt = nowIso();
  const jobId = `source-job:${input.projectId}:${input.contentHash.slice(0, 16)}`;
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO source_documents (id, project_id, intake_source_id, content_hash, source_type, original_file_name, immutable_path, event_date, duration_ms, word_count, segment_count, participants_json, normaliser_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sourceId, input.projectId, input.intakeSourceId, input.contentHash, document.sourceType, input.fileName, input.immutablePath, document.eventDate, document.durationMs, document.wordCount, document.segments.length, JSON.stringify(document.participants), SOURCE_NORMALISER_VERSION, createdAt);
    const insertSegment = db.prepare('INSERT INTO source_segments (id, source_id, seq, kind, speaker, t_start_ms, t_end_ms, message_id, sender, sent_at, page, section, para_index, char_start, char_end, text, window_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const segment of document.segments) insertSegment.run(`${sourceId}:seg:${String(segment.seq).padStart(5, '0')}`, sourceId, segment.seq, segment.kind, segment.speaker, segment.tStartMs, segment.tEndMs, segment.messageId, segment.sender, segment.sentAt, segment.page, segment.section, segment.paraIndex, segment.charStart, segment.charEnd, segment.text, null);
    const insertWindow = db.prepare("INSERT INTO source_windows (id, source_id, seq, start_seq, end_seq, token_estimate, status, explanation, item_count) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 0)");
    for (const window of windows) {
      const windowId = `${sourceId}:window:${String(window.seq).padStart(3, '0')}`;
      insertWindow.run(windowId, sourceId, window.seq, window.startSeq, window.endSeq, window.tokenEstimate);
      db.prepare('UPDATE source_segments SET window_id = COALESCE(window_id, ?) WHERE source_id = ? AND seq BETWEEN ? AND ?').run(windowId, sourceId, window.startSeq, window.endSeq);
    }
    const insertMarker = db.prepare('INSERT INTO source_markers (id, source_id, segment_seq, confidence, marker_type, matched_text, discharged_by_item_ref, dismissal_reason) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)');
    for (const marker of markers) insertMarker.run(`${sourceId}:${marker.id}`, sourceId, marker.segmentSeq, marker.confidence, marker.markerType, marker.matchedText);
    db.prepare("UPDATE source_processing_jobs SET status = 'processing', current_stage = 'extracting', queued_at = COALESCE(queued_at, ?), updated_at = ?, packet_id = NULL, changeset_id = NULL WHERE id = ?").run(createdAt, createdAt, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { sourceId, duplicate: false, segmentCount: document.segments.length, windowCount: windows.length, markerCounts: { high: markers.filter((item) => item.confidence === 'high').length, medium: markers.filter((item) => item.confidence === 'medium').length, low: markers.filter((item) => item.confidence === 'low').length }, jobId };
}

function packetRows(packet: SourceIntelligencePacket) {
  return registerNames.flatMap((registerName) => packet.sheets[registerName].rows.map((row) => ({ registerName, row })));
}

export function validatePacket(db: DatabaseSync, rawPacket: unknown) {
  const parsed = packetSchema.safeParse(rawPacket);
  if (!parsed.success) {
    return { packet: null, verdict: 'quarantined' as const, issues: parsed.error.issues.map((issue): ValidationIssue => ({ rule: 'schema-strict', severity: 'blocker', message: `${issue.path.join('.')}: ${issue.message}` })) };
  }
  const packet = parsed.data;
  const issues: ValidationIssue[] = [];
  const project = db.prepare('SELECT id, code FROM projects WHERE code = ?').get(packet.project_code) as { id: string; code: string } | undefined;
  const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(packet.source.source_id) as Record<string, unknown> | undefined;
  if (!project) issues.push({ rule: 'project-match', severity: 'blocker', message: 'Packet project code does not identify a project.' });
  if (!source || String(source.content_hash) !== packet.source.content_hash) issues.push({ rule: 'source-registration', severity: 'blocker', message: 'Packet source is missing or its content hash does not match.' });
  if (source && String(source.project_id) !== project?.id) issues.push({ rule: 'project-boundary', severity: 'blocker', message: 'Packet source belongs to a different project.' });

  const currentRevision = project ? Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(project.id) as { revision: number } | undefined)?.revision ?? 0) : 0;
  if (packet.base_register_revision !== currentRevision) issues.push({ rule: 'base-register-revision', severity: 'blocker', message: `Packet revision ${packet.base_register_revision} does not match current revision ${currentRevision}.` });

  const refs = new Set<string>();
  for (const { registerName, row } of packetRows(packet)) {
    if (refs.has(row.client_ref)) issues.push({ rule: 'unique-client-ref', severity: 'blocker', message: `Duplicate client_ref ${row.client_ref}.`, clientRef: row.client_ref });
    refs.add(row.client_ref);
    if (row.op === 'add' && (row.proposed_id !== '$ALLOC' || row.target_id !== null)) issues.push({ rule: 'server-id-allocation', severity: 'blocker', message: 'Add operations must use proposed_id $ALLOC and target_id null.', clientRef: row.client_ref });
    if (row.op !== 'add' && !row.target_id) issues.push({ rule: 'target-required', severity: 'blocker', message: `${row.op} requires target_id.`, clientRef: row.client_ref });
    if (row.derivation === 'inference' && !row.reasoning) issues.push({ rule: 'inference-reasoning', severity: 'blocker', message: 'Inference items require explicit reasoning.', clientRef: row.client_ref });
    for (const anchor of row.anchors) {
      const segments = db.prepare('SELECT * FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ? ORDER BY seq').all(packet.source.source_id, anchor.segment_seq - 1, anchor.segment_seq + 1) as Array<Record<string, unknown>>;
      const exact = segments.find((segment) => Number(segment.seq) === anchor.segment_seq);
      if (!exact) {
        issues.push({ rule: 'anchor-resolution', severity: 'blocker', message: `Segment ${anchor.segment_seq} does not exist.`, clientRef: row.client_ref });
        continue;
      }
      if (anchor.speaker && normalizedQuote(String(exact.speaker ?? '')) !== normalizedQuote(anchor.speaker)) issues.push({ rule: 'anchor-speaker', severity: 'blocker', message: `Anchor speaker does not match segment ${anchor.segment_seq}.`, clientRef: row.client_ref });
      if (anchor.t_ms !== null && exact.t_start_ms !== null && Math.abs(Number(exact.t_start_ms) - anchor.t_ms) > 30000) issues.push({ rule: 'anchor-time', severity: 'blocker', message: `Anchor time is more than 30 seconds from segment ${anchor.segment_seq}.`, clientRef: row.client_ref });
      if (row.derivation === 'fact') {
        if (!anchor.quote) issues.push({ rule: 'fact-quote', severity: 'blocker', message: 'Fact anchors require a verbatim quote.', clientRef: row.client_ref });
        else if (!segments.some((segment) => normalizedQuote(String(segment.text)).includes(normalizedQuote(anchor.quote ?? '')))) issues.push({ rule: 'quote-verification', severity: 'blocker', message: `Quote was not found in segment ${anchor.segment_seq} or an adjacent segment.`, clientRef: row.client_ref });
      }
    }
    if (row.op !== 'add' && row.target_id && project) {
      const target = db.prepare('SELECT register_name FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.id, row.target_id) as { register_name: string } | undefined;
      if (!target || target.register_name !== registerName) issues.push({ rule: 'target-legality', severity: 'warning', message: `Target ${row.target_id} is not a legal ${registerName} row; reconciliation will hold it as unverified_link.`, clientRef: row.client_ref });
    }
  }

  const categories = new Map(packet.coverage.categories.map((entry) => [entry.key, entry]));
  for (const name of registerNames) {
    const coverage = categories.get(name);
    if (!coverage) issues.push({ rule: 'category-coverage', severity: 'blocker', message: `Category ${name} has no coverage status.` });
    else if (coverage.status === 'none-found' && !coverage.explanation) issues.push({ rule: 'category-explanation', severity: 'blocker', message: `Category ${name} is none-found without an explanation.` });
  }
  const expectedWindows = source ? db.prepare('SELECT seq FROM source_windows WHERE source_id = ?').all(String(source.id)) as Array<{ seq: number }> : [];
  const coveredWindows = new Set(packet.coverage.windows.map((entry) => Number(entry.key)));
  for (const window of expectedWindows) if (!coveredWindows.has(window.seq)) issues.push({ rule: 'window-coverage', severity: 'blocker', message: `Source window ${window.seq} has no coverage status.` });
  if (packet.sheets.Sources.rows.length === 0) issues.push({ rule: 'source-row', severity: 'blocker', message: 'Packet has no Sources register row.' });
  if ((source ? JSON.parse(String(source.participants_json ?? '[]')) as unknown[] : []).length > 1 && packet.sheets.Entities.rows.length === 0 && !categories.get('Entities')?.explanation) issues.push({ rule: 'entity-coverage', severity: 'blocker', message: 'Multi-speaker source has zero entities without explanation.' });
  if (packet.sheets.Uncertainty.rows.length === 0 && !categories.get('Uncertainty')?.explanation) issues.push({ rule: 'uncertainty-coverage', severity: 'blocker', message: 'Uncertainty ledger is empty without explanation.' });

  const highMarkers = source ? db.prepare("SELECT id FROM source_markers WHERE source_id = ? AND confidence = 'high'").all(String(source.id)) as Array<{ id: string }> : [];
  const discharged = new Set(packetRows(packet).flatMap(({ row }) => row.discharges_markers));
  for (const marker of highMarkers) {
    const stored = db.prepare('SELECT dismissal_reason FROM source_markers WHERE id = ?').get(marker.id) as { dismissal_reason: string | null } | undefined;
    if (!discharged.has(marker.id) && !stored?.dismissal_reason) issues.push({ rule: 'high-marker-discharge', severity: 'blocker', message: `HIGH marker ${marker.id} is neither linked nor explicitly dismissed.` });
  }

  for (const runId of packet.execution.runs) {
    const run = db.prepare('SELECT * FROM extraction_runs WHERE id = ? AND source_id = ?').get(runId, packet.source.source_id) as Record<string, unknown> | undefined;
    if (!run || !run.provider_id || !run.model_label || !run.skill_sha256 || !run.prompt_sha256) issues.push({ rule: 'execution-provenance', severity: 'blocker', message: `Execution run ${runId} is missing trusted provider provenance.` });
  }
  const totalRuns = packet.execution.runs.map((id) => db.prepare('SELECT input_tokens, output_tokens, source_tokens, duration_ms FROM extraction_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined).filter(Boolean) as Array<Record<string, unknown>>;
  const calls = totalRuns.length;
  const inputTokens = totalRuns.reduce((total, run) => total + Number(run.input_tokens), 0);
  const sourceTokens = source ? Math.ceil(Number(source.word_count) * 1.35) : 0;
  const repeated = totalRuns.reduce((total, run) => total + Number(run.source_tokens), 0);
  const repetition = sourceTokens ? repeated / sourceTokens : 0;
  if (calls > 12 || inputTokens > 200000 || repetition > 2.5) issues.push({ rule: 'cost-budget', severity: 'blocker', message: `Configured extraction budget exceeded: ${calls} calls, ${inputTokens} input tokens, ${repetition.toFixed(2)}x source repetition.` });
  if (calls > 6 || repetition > 2) issues.push({ rule: 'cost-drift', severity: 'warning', message: `Extraction cost is approaching its acceptance limit.` });

  const verdict = issues.some((issue) => issue.severity === 'blocker') ? 'quarantined' : issues.some((issue) => issue.severity === 'warning') ? 'warnings' : 'clean';
  return { packet, verdict, issues, metrics: { calls, inputTokens, outputTokens: totalRuns.reduce((total, run) => total + Number(run.output_tokens), 0), sourceTokenRepetition: Number(repetition.toFixed(3)), durationMs: totalRuns.reduce((total, run) => total + Number(run.duration_ms), 0) } };
}

function sourceDateConflict(db: DatabaseSync, projectId: string, targetId: string, row: SourceIntelligencePacket['sheets']['Actions']['rows'][number], eventDate: string | null) {
  if (!eventDate) return false;
  const fields: Record<string, unknown> = { title: row.title, summary: row.summary, status: row.status, owner: row.owner, due_date: row.due_date_raw, ...row.details };
  return Object.keys(fields).some((field) => Boolean(db.prepare('SELECT 1 FROM register_row_events WHERE project_id = ? AND external_register_id = ? AND field = ? AND occurred_at > ? LIMIT 1').get(projectId, targetId, field, `${eventDate}T23:59:59.999Z`)));
}

function deterministicOps(db: DatabaseSync, projectId: string, packet: SourceIntelligencePacket) {
  return packetRows(packet).map(({ registerName, row }, index) => {
    let op: string = row.op;
    let reason: string | null = null;
    if (row.op !== 'add' && row.target_id) {
      const target = db.prepare('SELECT register_name FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, row.target_id) as { register_name: string } | undefined;
      if (!target || target.register_name !== registerName) {
        op = 'unverified_link';
        reason = 'Target does not exist in the same project and register.';
      } else if (sourceDateConflict(db, projectId, row.target_id, row, packet.source.event_date)) {
        op = 'conflict';
        reason = 'A newer human field event outranks this source assertion.';
      }
    }
    const current = row.target_id ? db.prepare('SELECT raw_row_json FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, row.target_id) as { raw_row_json: string } | undefined : undefined;
    const proposed = { title: row.title, summary: row.summary, status: row.status, record_type: row.record_type, owner: row.owner, due_date_raw: row.due_date_raw, source_ref: row.source_ref, related_refs: row.related_refs, supersedes: row.supersedes, details: row.details };
    return {
      seq: index + 1, op, registerName, clientRef: row.client_ref, targetExternalId: row.target_id,
      proposedRow: proposed,
      fieldDiff: current ? { before: JSON.parse(current.raw_row_json) as unknown, after: proposed, reason } : { before: null, after: proposed, reason },
      anchors: row.anchors, confidence: row.confidence, derivation: row.derivation,
    };
  });
}

export function freezePacketAndCreateChangeset(db: DatabaseSync, rawPacket: unknown) {
  const validation = validatePacket(db, rawPacket);
  if (!validation.packet) throw new Error(`Packet schema validation failed: ${validation.issues.map((issue) => issue.message).join('; ')}`);
  const packet = validation.packet;
  const project = db.prepare('SELECT id FROM projects WHERE code = ?').get(packet.project_code) as { id: string };
  const packetJson = stable(packet);
  const packetHash = hash(packetJson);
  const packetId = `packet:${project.id}:${packetHash.slice(0, 20)}`;
  const changesetId = `changeset:${project.id}:${packetHash.slice(0, 20)}`;
  const ops = deterministicOps(db, project.id, packet);
  const deterministicHash = hash(stable({ baseRegisterRevision: packet.base_register_revision, ops, versions: { validator: VALIDATOR_VERSION, reconciliation: RECONCILIATION_VERSION, projector: PROJECTOR_VERSION, scoring: SCORING_VERSION } }));
  const assembledAt = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const firstRun = db.prepare('SELECT skill_sha256, prompt_sha256 FROM extraction_runs WHERE id = ?').get(packet.execution.runs[0]) as { skill_sha256: string; prompt_sha256: string };
    db.prepare('INSERT INTO extraction_packets (id, source_id, project_id, packet_contract_version, source_normaliser_version, database_schema_version, validator_version, reconciliation_engine_version, current_state_projector_version, scoring_configuration_version, skill_sha256, prompt_sha256, packet_sha256, packet_json, assembled_at, validation_status, validation_report_json, base_register_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, packet_sha256) DO NOTHING')
      .run(packetId, packet.source.source_id, project.id, PACKET_VERSION, SOURCE_NORMALISER_VERSION, DATABASE_SCHEMA_VERSION, VALIDATOR_VERSION, RECONCILIATION_VERSION, PROJECTOR_VERSION, SCORING_VERSION, firstRun.skill_sha256, firstRun.prompt_sha256, packetHash, packetJson, assembledAt, validation.verdict, JSON.stringify({ issues: validation.issues, metrics: validation.metrics }), packet.base_register_revision);
    const coverage = db.prepare('INSERT OR REPLACE INTO packet_coverage (packet_id, scope, key, status, item_count, explanation) VALUES (?, ?, ?, ?, ?, ?)');
    for (const entry of packet.coverage.windows) coverage.run(packetId, 'window', entry.key, entry.status, entry.item_count, entry.explanation);
    for (const entry of packet.coverage.categories) coverage.run(packetId, 'category', entry.key, entry.status, entry.item_count, entry.explanation);
    db.prepare('INSERT INTO register_changesets (id, packet_id, project_id, source_id, created_at, gate_verdict, gate_report_json, review_status, applied_at, base_register_revision, deterministic_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET gate_verdict = excluded.gate_verdict, gate_report_json = excluded.gate_report_json, deterministic_hash = excluded.deterministic_hash')
      .run(changesetId, packetId, project.id, packet.source.source_id, assembledAt, validation.verdict, JSON.stringify(validation), validation.verdict === 'quarantined' ? 'quarantined' : 'pending', packet.base_register_revision, deterministicHash);
    db.prepare('DELETE FROM register_change_ops WHERE changeset_id = ?').run(changesetId);
    const insertOp = db.prepare('INSERT INTO register_change_ops (id, changeset_id, seq, op, register_name, client_ref, target_external_id, allocated_external_id, proposed_row_json, field_diff_json, anchors_json, confidence, derivation, status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)');
    for (const op of ops) insertOp.run(`${changesetId}:op:${String(op.seq).padStart(3, '0')}`, changesetId, op.seq, op.op, op.registerName, op.clientRef, op.targetExternalId, stable(op.proposedRow), stable(op.fieldDiff), stable(op.anchors), op.confidence, op.derivation, 'pending');
    const jobId = `source-job:${project.id}:${packet.source.content_hash.slice(0, 16)}`;
    db.prepare("UPDATE source_processing_jobs SET status = ?, current_stage = ?, completed_at = CASE WHEN ? = 'quarantined' THEN ? ELSE completed_at END, updated_at = ?, packet_id = ?, changeset_id = ?, error_message = ? WHERE id = ?")
      .run(validation.verdict === 'quarantined' ? 'quarantined' : 'awaiting_review', validation.verdict === 'quarantined' ? 'quarantined' : 'awaiting_review', validation.verdict, assembledAt, assembledAt, packetId, changesetId, validation.verdict === 'quarantined' ? validation.issues.filter((issue) => issue.severity === 'blocker').map((issue) => issue.message).join('; ') : null, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { packetId, packetHash, changesetId, deterministicHash, gateVerdict: validation.verdict, validation };
}

export function reviewChangeset(db: DatabaseSync, changesetId: string, input: { decision: 'accept' | 'reject'; reviewer: string; note?: string | null; opIds?: string[]; batch?: boolean }) {
  const changeset = db.prepare('SELECT * FROM register_changesets WHERE id = ?').get(changesetId) as Record<string, unknown> | undefined;
  if (!changeset) throw new Error('Changeset not found.');
  if (changeset.gate_verdict === 'quarantined') throw new Error('Quarantined changesets cannot be reviewed until validation passes.');
  const all = db.prepare('SELECT * FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(changesetId) as Array<Record<string, unknown>>;
  const requested = input.opIds?.length ? new Set(input.opIds) : null;
  const selected = all.filter((op) => !requested || requested.has(String(op.id)));
  if (selected.length === 0) throw new Error('No changeset operations were selected.');
  if (input.decision === 'accept' && selected.some((op) => ['conflict', 'unverified_link', 'possible_duplicate'].includes(String(op.op)))) throw new Error('Held conflicts, invalid links and possible duplicates cannot be accepted as register changes; reject them to keep canonical state.');
  if (input.batch && selected.some((op) => !['add', 'reaffirm'].includes(String(op.op)))) throw new Error('Only additions and reaffirmations may be batch reviewed.');
  const reviewedAt = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const update = db.prepare('UPDATE register_change_ops SET status = ?, reviewer = ?, reviewed_at = ?, review_note = ? WHERE id = ?');
    for (const op of selected) update.run(input.decision === 'accept' ? 'accepted' : 'rejected', input.reviewer, reviewedAt, input.note ?? null, String(op.id));
    const pending = Number((db.prepare("SELECT count(*) count FROM register_change_ops WHERE changeset_id = ? AND status = 'pending'").get(changesetId) as { count: number }).count);
    db.prepare('UPDATE register_changesets SET review_status = ? WHERE id = ?').run(pending === 0 ? 'ready-to-apply' : 'pending', changesetId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { changesetId, reviewed: selected.length, reviewStatus: Number((db.prepare("SELECT count(*) count FROM register_change_ops WHERE changeset_id = ? AND status = 'pending'").get(changesetId) as { count: number }).count) === 0 ? 'ready-to-apply' : 'pending' };
}

const prefixes: Record<RegisterName, string> = { Decisions: 'D', Actions: 'A', Risks_Issues: 'R', Config_Changes: 'C', Open_Questions: 'Q', Milestones: 'M', Entities: 'E', Sources: 'SRC', Uncertainty: 'U' };

function allocateId(db: DatabaseSync, projectId: string, projectCode: string, registerName: RegisterName): string {
  const prefix = prefixes[registerName] === 'SRC' ? 'SRC' : `${projectCode}-${prefixes[registerName]}`;
  const stored = db.prepare('SELECT next_seq FROM id_allocations WHERE project_id = ? AND prefix = ?').get(projectId, prefix) as { next_seq: number } | undefined;
  let sequence = stored?.next_seq;
  if (!sequence) {
    const rows = db.prepare('SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND external_register_id LIKE ?').all(projectId, `${prefix}-%`) as Array<{ external_register_id: string }>;
    sequence = Math.max(0, ...rows.map((row) => Number(row.external_register_id.match(/(\d+)$/)?.[1] ?? 0))) + 1;
    db.prepare('INSERT INTO id_allocations (project_id, prefix, next_seq) VALUES (?, ?, ?) ON CONFLICT(project_id, prefix) DO UPDATE SET next_seq = excluded.next_seq').run(projectId, prefix, sequence);
  }
  db.prepare('UPDATE id_allocations SET next_seq = next_seq + 1 WHERE project_id = ? AND prefix = ?').run(projectId, prefix);
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

function writeTyped(db: DatabaseSync, registerName: RegisterName, rowId: string, projectId: string, externalId: string, detail: JsonObject, title: string, status: string) {
  if (registerName === 'Decisions') db.prepare('INSERT OR REPLACE INTO register_decision_details (register_row_id, rationale, options_summary, outcome, decision_needed_by) VALUES (?, ?, ?, ?, ?)').run(rowId, text(detail.rationale) || null, text(detail.options_summary) || null, text(detail.outcome) || null, text(detail.decision_needed_by) || null);
  else if (registerName === 'Risks_Issues') db.prepare('INSERT OR REPLACE INTO register_risk_issue_details (register_row_id, driver, evidence, impact, mitigation, likelihood, severity) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowId, text(detail.driver) || null, text(detail.evidence) || null, text(detail.impact) || null, text(detail.mitigation) || null, text(detail.likelihood) || null, text(detail.severity) || null);
  else if (registerName === 'Config_Changes') db.prepare('INSERT OR REPLACE INTO register_config_change_details (register_row_id, environment, change_type, follow_through, impact) VALUES (?, ?, ?, ?, ?)').run(rowId, text(detail.environment) || 'unclear', text(detail.change_type) || null, text(detail.follow_through) || null, text(detail.impact) || null);
  else if (registerName === 'Open_Questions') db.prepare('INSERT OR REPLACE INTO register_open_question_details (register_row_id, question, parked_with, unblocked_by, blocking) VALUES (?, ?, ?, ?, ?)').run(rowId, text(detail.question) || title, text(detail.parked_with) || null, text(detail.unblocked_by) || null, truthy(detail.blocking) ? 1 : 0);
  else if (registerName === 'Milestones') db.prepare('INSERT OR REPLACE INTO register_milestone_details (register_row_id, target_date, milestone_status, conditional_logic) VALUES (?, ?, ?, ?)').run(rowId, text(detail.target_date) || null, text(detail.milestone_status) || status, text(detail.conditional_logic) || null);
  else if (registerName === 'Entities') db.prepare('INSERT OR REPLACE INTO register_entities (register_row_id, project_id, external_register_id, entity_name, entity_type, aliases_json, alias_confidence, disambiguation_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(rowId, projectId, externalId, title, text(detail.entity_type) || null, JSON.stringify(Array.isArray(detail.aliases) ? detail.aliases : []), text(detail.alias_confidence) || null, text(detail.disambiguation_note) || null);
  else if (registerName === 'Uncertainty') db.prepare('INSERT OR REPLACE INTO register_uncertainty (register_row_id, project_id, external_register_id, why_uncertain, resolve_by, status) VALUES (?, ?, ?, ?, ?, ?)').run(rowId, projectId, externalId, text(detail.why_uncertain) || title, text(detail.resolve_by) || null, status);
}

function upsertFact(db: DatabaseSync, context: { projectId: string; projectCode: string; packetId: string; packetHash: string; sourceId: string; importRunId: string; timestamp: string }, op: Record<string, unknown>) {
  const registerName = String(op.register_name) as RegisterName;
  const proposed = JSON.parse(String(op.proposed_row_json)) as JsonObject;
  const targetId = op.target_external_id ? String(op.target_external_id) : null;
  if (['conflict', 'unverified_link', 'possible_duplicate'].includes(String(op.op))) throw new Error(`${op.op} requires adjudication and cannot be applied directly.`);
  if (op.op === 'reaffirm' && targetId) {
    db.prepare('INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)')
      .run(randomUUID(), context.projectId, targetId, context.timestamp, String(op.reviewer ?? 'reviewer'), 'reaffirm', 'Source reaffirmed the existing record.', context.packetId, context.sourceId);
    return targetId;
  }
  const externalId = op.op === 'add' || op.op === 'supersede' ? allocateId(db, context.projectId, context.projectCode, registerName) : targetId;
  if (!externalId) throw new Error('Apply operation has no target or allocated ID.');
  const existing = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(context.projectId, externalId) as Record<string, unknown> | undefined;
  const raw = existing ? { ...(JSON.parse(String(existing.raw_row_json)) as JsonObject), ...proposed } : proposed;
  if (op.op === 'resolve') raw.status = 'resolved';
  const due = resolveDate(proposed.due_date_raw, (db.prepare('SELECT event_date FROM source_documents WHERE id = ?').get(context.sourceId) as { event_date: string | null }).event_date);
  const rowId = `register:${context.projectId}:${externalId}`;
  db.prepare(`INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at, derivation, confidence, first_seen_source_id, last_updated_source_id, due_date_raw, due_date_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, external_register_id) DO UPDATE SET title = excluded.title, summary = excluded.summary, record_status = excluded.record_status, record_type = excluded.record_type, owner = excluded.owner, due_date = excluded.due_date, source_ref = excluded.source_ref, original_status_wording = excluded.original_status_wording, related_ids_json = excluded.related_ids_json, supersession_ids_json = excluded.supersession_ids_json, import_run_id = excluded.import_run_id, source_id = excluded.source_id, raw_row_json = excluded.raw_row_json, normalized_row_json = excluded.normalized_row_json, updated_at = excluded.updated_at, derivation = excluded.derivation, confidence = excluded.confidence, last_updated_source_id = excluded.last_updated_source_id, due_date_raw = excluded.due_date_raw, due_date_confidence = excluded.due_date_confidence`)
    .run(rowId, context.projectId, registerName, externalId, String(proposed.title), String(proposed.summary ?? ''), String(raw.status ?? 'open'), proposed.record_type ? String(proposed.record_type) : null, proposed.owner ? String(proposed.owner) : null, due.date, proposed.source_ref ? String(proposed.source_ref) : context.sourceId, null, String(raw.status ?? 'open'), JSON.stringify(proposed.related_refs ?? []), JSON.stringify(proposed.supersedes ?? []), '[]', context.importRunId, context.sourceId, null, registerName, stable(raw), stable(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, normalizedQuote(String(value ?? ''))]))), context.timestamp, context.timestamp, String(op.derivation), String(op.confidence), existing?.first_seen_source_id ? String(existing.first_seen_source_id) : context.sourceId, context.sourceId, proposed.due_date_raw ? String(proposed.due_date_raw) : null, due.confidence);
  db.prepare('DELETE FROM project_register_row_fields WHERE register_row_id = ?').run(rowId);
  const insertField = db.prepare('INSERT INTO project_register_row_fields (id, register_row_id, project_id, register_name, external_register_id, field_name, original_value_json, normalized_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [field, value] of Object.entries(raw)) insertField.run(randomUUID(), rowId, context.projectId, registerName, externalId, field, stable(value), normalizedQuote(String(value ?? '')));
  writeTyped(db, registerName, rowId, context.projectId, externalId, proposed.details as JsonObject, String(proposed.title), String(raw.status ?? 'open'));
  db.prepare('DELETE FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? AND source_id = ?').run(context.projectId, externalId, context.sourceId);
  for (const anchor of JSON.parse(String(op.anchors_json)) as Array<{ segment_seq: number; speaker: string | null; t_ms: number | null; quote: string | null }>) {
    db.prepare('INSERT INTO register_row_anchors (id, project_id, external_register_id, source_id, segment_id, speaker, t_ms, quote, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(randomUUID(), context.projectId, externalId, context.sourceId, `${context.sourceId}:seg:${String(anchor.segment_seq).padStart(5, '0')}`, anchor.speaker, anchor.t_ms, anchor.quote);
  }
  if (op.op === 'supersede' && targetId) {
    db.prepare("UPDATE project_register_rows SET record_status = 'superseded', supersession_ids_json = ? WHERE project_id = ? AND external_register_id = ?").run(JSON.stringify([externalId]), context.projectId, targetId);
  }
  db.prepare('UPDATE register_change_ops SET allocated_external_id = ? WHERE id = ?').run(externalId, String(op.id));
  return externalId;
}

export function applyReviewedChangeset(db: DatabaseSync, changesetId: string) {
  const changeset = db.prepare('SELECT * FROM register_changesets WHERE id = ?').get(changesetId) as Record<string, unknown> | undefined;
  if (!changeset) throw new Error('Changeset not found.');
  if (changeset.review_status !== 'ready-to-apply') throw new Error('Every operation must receive human review before apply.');
  const revision = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(String(changeset.project_id)) as { revision: number } | undefined)?.revision ?? 0);
  if (revision !== Number(changeset.base_register_revision)) throw new Error('Register revision changed after extraction; rebuild the changeset before apply.');
  const packet = db.prepare('SELECT * FROM extraction_packets WHERE id = ?').get(String(changeset.packet_id)) as Record<string, unknown>;
  const project = db.prepare('SELECT code FROM projects WHERE id = ?').get(String(changeset.project_id)) as { code: string };
  const ops = db.prepare("SELECT * FROM register_change_ops WHERE changeset_id = ? AND status = 'accepted' ORDER BY seq").all(changesetId) as Array<Record<string, unknown>>;
  const timestamp = nowIso();
  const importRunId = `register-import:${changeset.project_id}:${String(packet.packet_sha256).slice(0, 16)}`;
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`INSERT OR IGNORE INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, source_workbook_name, source_workbook_hash, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json)
      VALUES (?, ?, 'project_register_delta', 1, ?, NULL, NULL, ?, 'completed', ?, ?, ?, ?, '[]', 'human-reviewed', ?)`)
      .run(importRunId, String(changeset.project_id), project.code, String(packet.packet_sha256), timestamp, timestamp, ops.length, ops.length, String(packet.packet_json));
    for (const op of ops) upsertFact(db, { projectId: String(changeset.project_id), projectCode: project.code, packetId: String(packet.id), packetHash: String(packet.packet_sha256), sourceId: String(changeset.source_id), importRunId, timestamp }, op);
    db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at').run(String(changeset.project_id), timestamp);
    rebuildProjection(db, String(changeset.project_id), timestamp);
    db.prepare("UPDATE register_changesets SET review_status = 'applied', applied_at = ? WHERE id = ?").run(timestamp, changesetId);
    db.prepare("UPDATE source_processing_jobs SET status = 'complete', current_stage = 'complete', completed_at = ?, updated_at = ? WHERE packet_id = ?").run(timestamp, timestamp, String(packet.id));
    db.prepare('UPDATE consultant_briefs SET stale = 1 WHERE project_id = ?').run(String(changeset.project_id));
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { changesetId, appliedOperations: ops.length, appliedAt: timestamp, revision: revision + 1 };
}

export function replayPacket(db: DatabaseSync, packetId: string) {
  const started = performance.now();
  const stored = db.prepare('SELECT * FROM extraction_packets WHERE id = ?').get(packetId) as Record<string, unknown> | undefined;
  if (!stored) throw new Error('Extraction packet not found.');
  const packet = JSON.parse(String(stored.packet_json)) as unknown;
  const validation = validatePacket(db, packet);
  if (!validation.packet) throw new Error('Stored packet no longer satisfies its recorded contract.');
  const projectId = String(stored.project_id);
  const ops = deterministicOps(db, projectId, validation.packet);
  const changesetHash = hash(stable({ baseRegisterRevision: validation.packet.base_register_revision, ops, versions: { validator: VALIDATOR_VERSION, reconciliation: RECONCILIATION_VERSION, projector: PROJECTOR_VERSION, scoring: SCORING_VERSION } }));
  const registerState = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId);
  const projection = db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId);
  const scores = db.prepare('SELECT * FROM register_row_scores WHERE project_id = ? ORDER BY external_register_id').all(projectId);
  return { packetId, providerCalls: 0, durationMs: Math.round((performance.now() - started) * 1000) / 1000, changesetHash, registerStateHash: hash(stable(registerState)), projectionHash: hash(stable(projection)), scoresHash: hash(stable(scores)), validationVerdict: validation.verdict };
}

function readChangeset(db: DatabaseSync, row: Record<string, unknown>) {
  const ops = db.prepare('SELECT * FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(String(row.id)) as Array<Record<string, unknown>>;
  return {
    id: String(row.id), packetId: String(row.packet_id), sourceId: String(row.source_id), createdAt: String(row.created_at), gateVerdict: String(row.gate_verdict), gateReport: JSON.parse(String(row.gate_report_json)) as unknown, reviewStatus: String(row.review_status), appliedAt: row.applied_at ? String(row.applied_at) : null, deterministicHash: String(row.deterministic_hash),
    operations: ops.map((op) => ({ id: String(op.id), seq: Number(op.seq), op: String(op.op), registerName: String(op.register_name), clientRef: String(op.client_ref), targetExternalId: op.target_external_id ? String(op.target_external_id) : null, allocatedExternalId: op.allocated_external_id ? String(op.allocated_external_id) : null, proposedRow: JSON.parse(String(op.proposed_row_json)) as unknown, fieldDiff: JSON.parse(String(op.field_diff_json)) as unknown, anchors: JSON.parse(String(op.anchors_json)) as unknown, confidence: String(op.confidence), derivation: String(op.derivation), status: String(op.status), reviewer: op.reviewer ? String(op.reviewer) : null, reviewedAt: op.reviewed_at ? String(op.reviewed_at) : null, reviewNote: op.review_note ? String(op.review_note) : null })),
  };
}

export function readSourceIntelligence(db: DatabaseSync, projectId: string) {
  const changesets = (db.prepare('SELECT * FROM register_changesets WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>).map((row) => readChangeset(db, row));
  const sources = db.prepare('SELECT * FROM source_documents WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>;
  const runs = db.prepare('SELECT * FROM extraction_runs WHERE project_id = ? ORDER BY started_at DESC').all(projectId) as Array<Record<string, unknown>>;
  return {
    changesets,
    sources: sources.map((source) => ({
      id: String(source.id), sourceType: String(source.source_type), originalFileName: String(source.original_file_name), eventDate: source.event_date ? String(source.event_date) : null, durationMs: source.duration_ms === null ? null : Number(source.duration_ms), wordCount: Number(source.word_count), segmentCount: Number(source.segment_count), participants: JSON.parse(String(source.participants_json)) as string[], normaliserVersion: String(source.normaliser_version), createdAt: String(source.created_at),
      windows: db.prepare('SELECT seq, start_seq startSeq, end_seq endSeq, token_estimate tokenEstimate, status, explanation, item_count itemCount FROM source_windows WHERE source_id = ? ORDER BY seq').all(String(source.id)),
      markerCounts: db.prepare('SELECT confidence, count(*) count FROM source_markers WHERE source_id = ? GROUP BY confidence').all(String(source.id)),
      metrics: runs.filter((run) => run.source_id === source.id).reduce<{ calls: number; inputTokens: number; outputTokens: number; durationMs: number }>((result, run) => ({ calls: result.calls + 1, inputTokens: result.inputTokens + Number(run.input_tokens), outputTokens: result.outputTokens + Number(run.output_tokens), durationMs: result.durationMs + Number(run.duration_ms) }), { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }),
    })),
  };
}

export function computeProjectOverview(db: DatabaseSync, projectId: string) {
  const pin = db.prepare('SELECT mode FROM project_overview_pins WHERE project_id = ?').get(projectId) as { mode: string | null } | undefined;
  const latestChangeset = db.prepare("SELECT * FROM register_changesets WHERE project_id = ? AND (applied_at >= datetime('now', '-1 day') OR acknowledged_at IS NULL) ORDER BY created_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
  const meeting = db.prepare("SELECT external_register_id FROM register_row_state WHERE project_id = ? AND register_name = 'Milestones' AND due_date BETWEEN date('now') AND date('now', '+1 day') LIMIT 1").get(projectId);
  const computedMode = latestChangeset ? 'changes' : meeting ? 'meeting' : 'needs-warwick';
  const leadMode = pin?.mode ?? computedMode;
  const rows = db.prepare(`SELECT r.external_register_id, r.register_name, r.title, r.summary, s.status, s.owner, s.due_date, sc.score, sc.band, sc.inputs_json
    FROM project_register_rows r JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
    JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
    WHERE r.project_id = ? ORDER BY sc.score DESC, r.external_register_id LIMIT 200`).all(projectId) as Array<Record<string, unknown>>;
  const open = rows.filter((row) => !/resolved|closed|complete|superseded|rejected|ratified/i.test(String(row.status)));
  const lenses: Record<string, Array<Record<string, unknown>>> = {
    needsWarwick: open.filter((row) => isProjectConsultantOwner(db, projectId, row.owner) && ['Now', 'Soon'].includes(String(row.band))),
    needsCustomer: open.filter((row) => row.owner && !isProjectConsultantOwner(db, projectId, row.owner)),
    topRisksIssues: open.filter((row) => row.register_name === 'Risks_Issues'),
    decisionsRequired: open.filter((row) => row.register_name === 'Decisions' && /awaiting|pending|proposed/i.test(String(row.status))),
    blockingQuestions: open.filter((row) => row.register_name === 'Open_Questions' && Boolean((JSON.parse(String(row.inputs_json)) as JsonObject).blocking)),
    dueNext: open.filter((row) => row.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))),
    challengeNextMeeting: open.filter((row) => ['Now', 'Soon'].includes(String(row.band))).slice(0, 10),
    uncertainOrConflicting: open.filter((row) => row.register_name === 'Uncertainty' || Number((JSON.parse(String(row.inputs_json)) as JsonObject).conflict ?? 0) > 0),
    changesSinceLatestSource: rows.filter((row) => Number((JSON.parse(String(row.inputs_json)) as JsonObject).latestSource ?? 0) > 0),
  };
  const compact = (row: Record<string, unknown>) => ({ id: String(row.external_register_id), registerName: String(row.register_name), title: String(row.title), summary: String(row.summary), status: String(row.status), owner: row.owner ? String(row.owner) : null, dueDate: row.due_date ? String(row.due_date) : null, score: Number(row.score), band: String(row.band), scoreInputs: JSON.parse(String(row.inputs_json)) as JsonObject });
  return { leadMode, computedMode, pinnedMode: pin?.mode ?? null, modes: { changes: { available: Boolean(latestChangeset), changesetId: latestChangeset ? String(latestChangeset.id) : null }, meeting: { available: Boolean(meeting) }, needsWarwick: { available: true } }, lenses: Object.fromEntries(Object.entries(lenses).map(([key, value]) => [key, value.slice(0, 40).map(compact)])) };
}

export function pinOverviewMode(db: DatabaseSync, projectId: string, mode: 'changes' | 'meeting' | 'needs-warwick' | null, actor = 'Warwick') {
  if (mode === null) db.prepare('DELETE FROM project_overview_pins WHERE project_id = ?').run(projectId);
  else db.prepare('INSERT INTO project_overview_pins (project_id, mode, pinned_at, pinned_by) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by').run(projectId, mode, nowIso(), actor);
  return computeProjectOverview(db, projectId);
}

function briefContext(db: DatabaseSync, projectId: string) {
  const overview = computeProjectOverview(db, projectId);
  const ranked = [...new Map(Object.values(overview.lenses).flat().sort((a, b) => b.score - a.score).map((row) => [row.id, row])).values()].slice(0, 40);
  const selected = ranked.map((row) => {
    const registerRow = db.prepare('SELECT id FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, row.id) as { id: string } | undefined;
    const details = registerRow ? readTypedDetails(db, row.registerName, registerRow.id) : {};
    const evidence = readRowEvidence(db, projectId, row.id);
    const anchor = evidence.anchors.find((item) => item.verified) ?? evidence.anchors[0] ?? null;
    const latestHumanEvent = evidence.events[0] ?? null;
    return {
      id: row.id,
      registerName: row.registerName,
      title: row.title.slice(0, 240),
      summary: row.summary.slice(0, 500),
      status: row.status,
      owner: row.owner,
      dueDate: row.dueDate,
      severity: details.severity ? String(details.severity) : null,
      blocking: Boolean(row.scoreInputs.blocking),
      conflict: Number(row.scoreInputs.conflict ?? 0) > 0,
      band: row.band,
      score: row.score,
      scoreInputs: row.scoreInputs,
      latestHumanEvent: latestHumanEvent ? { eventType: latestHumanEvent.eventType, occurredAt: latestHumanEvent.occurredAt, reason: latestHumanEvent.reason.slice(0, 300) } : null,
      evidence: anchor ? { sourceId: anchor.sourceId, segmentId: anchor.segmentId, quote: anchor.quote?.slice(0, 600) ?? null } : null,
    };
  });
  const selectionHash = hash(stable(selected));
  return { overview, selected, selectionHash };
}

function readCachedBrief(db: DatabaseSync, projectId: string, mode: string, selectionHash: string) {
  const existing = db.prepare('SELECT * FROM consultant_briefs WHERE project_id = ? AND mode = ? AND selection_hash = ? AND stale = 0').get(projectId, mode, selectionHash) as Record<string, unknown> | undefined;
  return existing ? { id: String(existing.id), selectionHash, briefMarkdown: String(existing.brief_markdown), citations: JSON.parse(String(existing.citations_json)) as string[], generationMode: String(existing.provider_id), stale: false } : null;
}

export function buildDeterministicBrief(db: DatabaseSync, projectId: string, mode = 'needs-warwick') {
  const { overview, selected, selectionHash } = briefContext(db, projectId);
  const existing = readCachedBrief(db, projectId, mode, selectionHash);
  if (existing) return existing;
  const sections = [
    ['Needs Warwick', overview.lenses.needsWarwick],
    ['Top risks and issues', overview.lenses.topRisksIssues],
    ['Decisions required', overview.lenses.decisionsRequired],
    ['Blocking questions', overview.lenses.blockingQuestions],
    ['Due next', overview.lenses.dueNext],
    ['Uncertain or conflicting', overview.lenses.uncertainOrConflicting],
  ] as const;
  const lines = sections.flatMap(([title, rows]) => [`## ${title}`, ...(rows.slice(0, 6).length ? rows.slice(0, 6).map((row) => `- ${row.title} — ${row.status}${row.owner ? `; owner ${row.owner}` : ''}${row.dueDate ? `; due ${row.dueDate}` : ''} [${row.id}]`) : ['- Nothing currently selected.']), '']);
  const briefMarkdown = lines.join('\n').trim();
  const citations = selected.map((row) => row.id);
  const id = `brief:${projectId}:${mode}:${selectionHash.slice(0, 16)}`;
  db.prepare('INSERT INTO consultant_briefs (id, project_id, mode, selection_hash, brief_markdown, citations_json, provider_id, generated_at, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(project_id, mode, selection_hash) DO UPDATE SET brief_markdown = excluded.brief_markdown, citations_json = excluded.citations_json, provider_id = excluded.provider_id, generated_at = excluded.generated_at, stale = 0')
    .run(id, projectId, mode, selectionHash, briefMarkdown, JSON.stringify(citations), 'deterministic-template', nowIso());
  return { id, selectionHash, briefMarkdown, citations, generationMode: 'deterministic-template', stale: false, selectedRecords: selected };
}

export async function buildConsultantBrief(db: DatabaseSync, projectId: string, mode: string, provider: GroundedBriefProvider) {
  const { selected, selectionHash } = briefContext(db, projectId);
  const existing = readCachedBrief(db, projectId, mode, selectionHash);
  if (existing && existing.generationMode === provider.identity.providerId) return existing;
  if (!provider.isAvailable()) return buildDeterministicBrief(db, projectId, mode);
  const prompt = `Create a concise Implementation Consultant brief from this bounded evidence pack. Group repetition, explain significance, propose meeting order, identify challenges and decisions. Do not introduce unsupported facts. Every non-heading factual line must end with one or more cited selected IDs in square brackets. Return markdown only.\n${stable({ mode, records: selected })}`;
  const promptTokens = estimateTokens(prompt);
  const promptSha256 = hash(prompt);
  const createdAt = nowIso();
  if (promptTokens > 10_000) {
    db.prepare('INSERT INTO consultant_brief_runs (id, project_id, brief_id, selection_hash, provider_id, model_label, prompt_sha256, output_sha256, input_tokens, output_tokens, duration_ms, status, error, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?)')
      .run(randomUUID(), projectId, selectionHash, provider.identity.providerId, provider.identity.modelLabel, promptSha256, promptTokens, 'budget-exceeded', 'Bounded consultant brief input exceeded 10000 tokens.', createdAt);
    return buildDeterministicBrief(db, projectId, mode);
  }
  const started = performance.now();
  try {
    const result = await provider.generate({ prompt, selectionHash });
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    const validation = validateBriefCitations(result.markdown, selected.map((row) => row.id));
    const outputSha256 = hash(result.markdown);
    if (!validation.valid || !validation.markdown) {
      db.prepare('INSERT INTO consultant_brief_runs (id, project_id, brief_id, selection_hash, provider_id, model_label, prompt_sha256, output_sha256, input_tokens, output_tokens, duration_ms, status, error, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), projectId, selectionHash, provider.identity.providerId, provider.identity.modelLabel, promptSha256, outputSha256, Math.max(0, Math.floor(result.usage.inputTokens)), Math.max(0, Math.floor(result.usage.outputTokens)), durationMs, 'citation-rejected', `Removed ${validation.removed} of ${validation.factual} factual lines.`, createdAt);
      return buildDeterministicBrief(db, projectId, mode);
    }
    const citations = [...new Set([...validation.markdown.matchAll(/\[([A-Z][A-Z0-9-]*-\d+|SRC-\d+)\]/g)].map((match) => match[1]))];
    const id = `brief:${projectId}:${mode}:${selectionHash.slice(0, 16)}`;
    db.prepare('INSERT INTO consultant_briefs (id, project_id, mode, selection_hash, brief_markdown, citations_json, provider_id, generated_at, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(project_id, mode, selection_hash) DO UPDATE SET brief_markdown = excluded.brief_markdown, citations_json = excluded.citations_json, provider_id = excluded.provider_id, generated_at = excluded.generated_at, stale = 0')
      .run(id, projectId, mode, selectionHash, validation.markdown, JSON.stringify(citations), provider.identity.providerId, createdAt);
    db.prepare('INSERT INTO consultant_brief_runs (id, project_id, brief_id, selection_hash, provider_id, model_label, prompt_sha256, output_sha256, input_tokens, output_tokens, duration_ms, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(randomUUID(), projectId, id, selectionHash, provider.identity.providerId, provider.identity.modelLabel, promptSha256, outputSha256, Math.max(0, Math.floor(result.usage.inputTokens)), Math.max(0, Math.floor(result.usage.outputTokens)), durationMs, 'complete', createdAt);
    return { id, selectionHash, briefMarkdown: validation.markdown, citations, generationMode: provider.identity.providerId, stale: false, selectedRecords: selected };
  } catch (error) {
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    db.prepare('INSERT INTO consultant_brief_runs (id, project_id, brief_id, selection_hash, provider_id, model_label, prompt_sha256, output_sha256, input_tokens, output_tokens, duration_ms, status, error, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, selectionHash, provider.identity.providerId, provider.identity.modelLabel, promptSha256, promptTokens, durationMs, 'failed', error instanceof Error ? error.message : String(error), createdAt);
    return buildDeterministicBrief(db, projectId, mode);
  }
}
export function validateBriefCitations(markdown: string, selectedIds: string[]) {
  const selected = new Set(selectedIds);
  const kept: string[] = [];
  let factual = 0;
  let removed = 0;
  const invalidCitations = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim() || /^#{1,6}\s/.test(line)) { kept.push(line); continue; }
    factual += 1;
    const citations = [...line.matchAll(/\[([A-Z][A-Z0-9-]*-\d+|SRC-\d+)\]/g)].map((match) => match[1]);
    const invalid = citations.filter((id) => !selected.has(id));
    for (const id of invalid) invalidCitations.add(id);
    if (citations.length === 0 || invalid.length > 0) removed += 1;
    else kept.push(line);
  }
  const removalRatio = factual ? removed / factual : 0;
  return { valid: removalRatio <= 0.2, markdown: kept.join('\n').trim(), removed, factual, removalRatio, invalidCitations: [...invalidCitations].sort() };
}
