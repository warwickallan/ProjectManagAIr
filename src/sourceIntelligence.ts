import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { resolveDate } from './dateResolution.js';
import { estimateTokens } from './extractionProvider.js';
import type { GroundedBriefProvider } from './briefProvider.js';
import { normalizeSource, SOURCE_NORMALISER_VERSION, type NormalizedDocument, type NormalizedSegment } from './sourceNormalizers.js';
import { activeScoringVersion, canonicalNormalizedRowJson, canonicalNormalizedValue, canonicalRowJson, canonicalValueJson, needsConsultantAttention, PROJECTOR_VERSION, rebuildProjection, readRowEvidence, readTypedDetails } from './registerProjection.js';

export const PACKET_VERSION = 1;
export const VALIDATOR_VERSION = 'source-intelligence-validator-v2';
export const RECONCILIATION_VERSION = 'reconciliation-engine-v2';
export const DATABASE_SCHEMA_VERSION = '011';

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
  // Only an `add` allocates; every other operation targets an existing row, so
  // `proposed_id` is legitimately absent there. Requiring a non-empty string
  // forced a model to invent a value for a field that has no meaning.
  proposed_id: z.string().min(1).nullable().default(null),
  title: z.string().min(1),
  summary: z.string().default(''),
  // A source that states no status must be able to say so. For an `add` the
  // stored record status falls back to `open`; for the update family a null is
  // simply not asserted and the stored value stands.
  status: z.string().min(1).nullable().default(null),
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

// Key ordering must be locale independent (C19). `localeCompare` uses the host
// ICU collation, so two machines with different LANG produced different packet
// hashes for byte-identical packets, and the determinism claim failed silently.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedQuote(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Evidence comparison must survive the punctuation that Teams, Word and Outlook
// actually emit. Curly quotes and dashes are presentation, not content; folding
// them here is what lets a model quote a transcript accurately without having to
// reproduce the exact code points.
function foldEvidence(value: string): string {
  return value
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const EVIDENCE_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your']);

function evidenceTokens(value: string): string[] {
  return foldEvidence(value).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 2 && !EVIDENCE_STOP_WORDS.has(token));
}

// A quote must carry enough content to constitute evidence. The prior gate
// accepted `quote: "the"` against an arbitrary fabricated claim, which made the
// single strongest anti-hallucination control vacuous.
const MIN_QUOTE_WORDS = 4;
const MIN_QUOTE_CHARS = 20;

// How far from a marker an item may be anchored and still be said to account
// for it. Wide enough for the natural case where a commitment is stated in one
// turn and qualified in the next few; narrow enough that an item elsewhere in
// the transcript cannot claim it.
const MARKER_DISCHARGE_RADIUS = 3;

// The share of HIGH markers a single pass may answer by dismissal rather than by
// producing a register item.
const MAX_MODEL_DISMISSAL_RATIO = 0.3;

function quoteIsTrivial(quote: string, segmentText: string): boolean {
  const folded = foldEvidence(quote);
  if (!folded) return true;
  // A short segment cannot yield a long quote; accept a quote that is
  // substantially the whole segment even when the segment itself is terse.
  const segment = foldEvidence(segmentText);
  if (segment && folded.length >= segment.length * 0.6 && folded.length >= 8) return false;
  return folded.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS || folded.length < MIN_QUOTE_CHARS;
}

function quoteResolves(segments: Array<Record<string, unknown>>, quote: string): boolean {
  const needle = foldEvidence(quote);
  if (!needle) return false;
  // Contiguous match inside a single segment. Matching across the concatenation
  // of neighbours would let a model stitch a sentence that was never said.
  return segments.some((segment) => foldEvidence(String(segment.text ?? '')).includes(needle));
}

// Does the structured claim plausibly come from the cited evidence? This is a
// weak but real guard against a well-formed quote being attached to an unrelated
// assertion: the row's own wording must share vocabulary with the segments it
// cites. Deliberately lenient — legitimate paraphrase and summarisation must
// pass; only wholly disconnected claims are caught.
function claimSupport(row: { title: string; summary: string }, segmentTexts: string[]): number {
  const claim = new Set(evidenceTokens(`${row.title} ${row.summary}`));
  if (claim.size === 0) return 0;
  const evidence = new Set(segmentTexts.flatMap((textValue) => evidenceTokens(textValue)));
  let shared = 0;
  for (const token of claim) if (evidence.has(token)) shared += 1;
  return shared;
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || ['true', 'yes', '1', 'blocking', 'blocked'].includes(normalizedQuote(String(value ?? '')));
}

// Window sizing used a second copy of the under-counting estimator; it is now
// the same conservative estimator the provider and the budget gates use (D6).
function tokenEstimate(value: string): number {
  return estimateTokens(value);
}

// Source document identifiers are globally unique but allocated per project
// (C2). The previous scheme computed the next `SRC-nnn` scoped to the project
// while the primary key was database-wide, so every project after the first hit
// a UNIQUE violation on its very first source and could never ingest at all.
// The distinct `SRCDOC-` prefix also removes the collision with `SRC-nnn`
// Sources-register row identifiers (C15), which shared one namespace across two
// independent counters.
function nextSourceId(db: DatabaseSync, projectId: string, projectCode: string): string {
  const prefix = `SRCDOC-${projectCode}`;
  const existing = db.prepare("SELECT id FROM source_documents WHERE project_id = ? AND id LIKE ? ORDER BY CAST(substr(id, ?) AS INTEGER) DESC LIMIT 1").get(projectId, `${prefix}-%`, prefix.length + 2) as { id: string } | undefined;
  const next = existing ? Number(existing.id.slice(prefix.length + 1)) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
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

// Marker detection is both the mandatory-discharge gate and the per-window
// recall checklist, so it is scored against the folded text (C8): Teams and Word
// emit U+2019, and every apostrophe-bearing pattern used to be blind to real
// transcripts. Equally, ordinary prose must not be classified as mandatory
// governance content — a HIGH marker obliges the extraction to account for it.
const COMMITMENT_CUE = /\b(?:i(?:'ll| will| shall| need to| have to| must| am going to| ?'m going to)|we(?:'ll| will| shall| need to| should| must| have to| are going to| ?'re going to)|you(?:'ll| will| need to| must)|(?:they|he|she)(?:'ll| will| must)|let me|let us|can you|could you|please|action|deadline|due|target|by then|before|no later than|promise[sd]?|committed to|commit to|undertake[sd]?|undertaking to)\b/;

/* -------------------------------------------------------------------------- *
 * N7 — deciding whether a date is being committed to.
 *
 * The veto used to be `PAST_OR_HYPOTHETICAL` tested against the whole segment,
 * matching any past-tense word anywhere in it: `finished`, `completed`,
 * `closed`, `did`, `was`, `had`, `already`. That is not a test of tense, it is a
 * test for a vocabulary that ordinary forward-looking commitments use
 * constantly — "I'll have the permit mapping COMPLETED by Friday", "we need to
 * get the register CLOSED by the end of the week", "Tony WAS clear that we must
 * deliver the counts by Monday". Five of six realistic date commitments were
 * vetoed. A missed HIGH marker removes a mandatory discharge obligation, so the
 * gate got quietly easier and the per-window recall checklist quietly shorter:
 * the failure direction that loses governance content rather than adding noise.
 *
 * The question is not whether a past-tense word appears in the sentence. It is
 * whether THIS DATE is being committed to going forward. Three rules, in order:
 *
 *   1. Scope. Only the clause containing the date phrase can veto it. "I'll
 *      send the counts by Friday, we finished the last batch in March" commits
 *      to Friday whatever the second clause says.
 *   2. Evidence. The veto needs an explicit past-time expression — `last week`,
 *      `yesterday`, `three weeks ago` — or an explicitly counterfactual
 *      construction, not a past-tense verb.
 *   3. Precedence. A future modal in the same clause is decisive: "I'll have
 *      that closed by Friday" is a commitment however the verb is spelled.
 * -------------------------------------------------------------------------- */

/**
 * An explicit past-time expression: wording that can only place the date in the
 * past. `last month` qualifies; `completed` does not.
 */
const PAST_TIME_EXPRESSION = /\b(?:last (?:week|month|year|time|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|yesterday|the other day|previously|earlier (?:this|last) (?:week|month|year)|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:day|days|week|weeks|month|months|year|years) ago|back in (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/;

/** Counterfactual and hypothetical constructions, which commit to nothing. */
const HYPOTHETICAL = /\b(?:would have|could have|should have|might have|used to|if we had|if i had|had we|hypothetically)\b/;

/** A forward-looking modal. Decisive: it outranks anything else in its clause. */
const FUTURE_MODAL = /\b(?:i(?:'ll| will| shall| ?'m going to| am going to)|we(?:'ll| will| shall| ?'re going to| are going to)|you(?:'ll| will)|(?:they|he|she)(?:'ll| will)|will|shall|going to|needs? to|must|have to|has to|no later than|by then)\b/;

/**
 * Clause boundaries for the veto's scope. Sentence punctuation, commas, and the
 * conjunctions that introduce a contrasting or subordinate clause.
 */
const CLAUSE_BOUNDARY = '[.!?;,]+|\\b(?:but|however|whereas|although|though|unlike|because|even if)\\b';

/** The clause of `folded` containing the span `[start, end)`. */
function clauseContaining(folded: string, start: number, end: number): string {
  const boundary = new RegExp(CLAUSE_BOUNDARY, 'g');
  let clauseStart = 0;
  let clauseEnd = folded.length;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(folded)) !== null) {
    const matchEnd = match.index + match[0].length;
    // A boundary wholly before the date phrase moves the clause start; one
    // wholly after it ends the clause. One overlapping the phrase is ignored.
    if (matchEnd <= start) clauseStart = matchEnd;
    else if (match.index >= end) { clauseEnd = match.index; break; }
  }
  return folded.slice(clauseStart, clauseEnd);
}

/** True when the matched date phrase is being committed to rather than recalled. */
function commitsToDate(folded: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const clause = clauseContaining(folded, start, start + match[0].length);
  if (FUTURE_MODAL.test(clause)) return true;
  return !PAST_TIME_EXPRESSION.test(clause) && !HYPOTHETICAL.test(clause);
}

const CONFIG_OBJECT = /\b(?:box|tick ?box|checkbox|field|setting|settings|config|configuration|flag|option|value|template|permit|permits|register|record|records|status|toggle|parameter|rule|workflow|form|screen|profile|role|permission|module)\b/;

/**
 * Verbs that can only describe acting on the system. `change`, `add` and `save`
 * need a nameable configuration object to disambiguate them from ordinary
 * speech; `tick`, `suppress` and `configure` do not, which is why the design's
 * own example "let me tick that" is a HIGH marker with no object named.
 */
const SYSTEM_ONLY_VERB = /\b(?:tick|ticked|untick|unticked|suppress|suppressed|configure|configured|rename|renamed|enable|enabled|disable|disabled)\b/;
const LIVE_CONFIG_ACT = /\b(?:i(?:'ll|'ve| have| just| will| am going to)|let me|we've|we have)\b.{0,80}?\b(?:add|added|change|changed|tick|ticked|save|saved|suppress|suppressed|configure|configured|rename|renamed|remove|removed|switch|switched|enable|enabled|disable|disabled)\b/;
const DATE_PHRASE = /\b(?:by (?:the )?end of (?:the )?(?:week|month|day)|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th) (?:of )?(?:january|february|march|april|may|june|july|august|september|october|november|december))\b/;
const SCHEDULED_TIME = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]{0,40}\b(?:\d{1,2}(?:st|nd|rd|th)|\d{1,2}[:.]\d{2}|\d{1,2} ?(?:am|pm)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) o'clock)\b/;

function preScan(document: NormalizedDocument) {
  const markers: Array<{ id: string; segmentSeq: number; confidence: 'high' | 'medium' | 'low'; markerType: string; matchedText: string }> = [];
  const high: Array<{ type: string; test: (folded: string) => RegExpMatchArray | null }> = [
    {
      type: 'explicit-action',
      test: (folded) => folded.match(/\b(?:that's an action|action (?:on|for) (?:me|us|you|yourselves)|i(?:'ll|'ve| will| have| need to| am going to| just)(?: \w+){0,3} (?:check|confirm|send|update|add|added|remove|create|suppress|tick|chase|raise|book|arrange|set up|come back|follow up))\b/),
    },
    {
      type: 'explicit-register',
      test: (folded) => folded.match(/\b(?:capture|record|add|note|log)(?: that| this| it)? (?:for|to|in|as|against) (?:the )?(?:decision|action|risk|issue|question|register|log|backlog|development)\b|\b(?:ai note|note for development|for the register|for the log|one for the register)\b/),
    },
    {
      // A date only obliges the extraction when someone is committing to it.
      // "next Wednesday is a bank holiday" is information, not governance;
      // "we finished that by Friday last month" is a recollection (N7).
      type: 'explicit-date',
      test: (folded) => {
        if (!COMMITMENT_CUE.test(folded)) return null;
        const match = folded.match(DATE_PHRASE);
        return match && commitsToDate(folded, match) ? match : null;
      },
    },
    {
      // A specific day paired with a specific time is a scheduling commitment
      // in its own right, per the design's worked examples.
      type: 'scheduled-time',
      test: (folded) => {
        const match = folded.match(SCHEDULED_TIME);
        return match && commitsToDate(folded, match) ? match : null;
      },
    },
    {
      // Live configuration acts with an ambiguous verb need an object that can
      // actually be configured; "I'll change my mind about the sandwich" is not
      // a change to the system. A verb that only ever means "act on the system"
      // stands on its own.
      type: 'live-config-act',
      test: (folded) => {
        const match = folded.match(LIVE_CONFIG_ACT);
        return match && (CONFIG_OBJECT.test(folded) || SYSTEM_ONLY_VERB.test(match[0])) ? match : null;
      },
    },
  ];
  const medium: Array<{ type: string; pattern: RegExp }> = [
    { type: 'commitment-pattern', pattern: /\b(?:we need to|i need to think|i(?:'ll| will) come back|i(?:'ll| will) check|we should probably|somebody needs to)\b/ },
    { type: 'question-pattern', pattern: /\?\s*$/ },
    { type: 'constraint-pattern', pattern: /\b(?:can only|cannot|can't|isn't able|doesn't support|not able to|limited to|no way to)\b/ },
  ];
  const low = /\b(?:risk|question|issue|concern|assumption|dependency|blocker)\b/;
  for (const segment of document.segments) {
    const folded = foldEvidence(segment.text);
    for (const candidate of high) {
      const match = candidate.test(folded);
      if (match) markers.push({ id: `marker:${segment.seq}:${candidate.type}`, segmentSeq: segment.seq, confidence: 'high', markerType: candidate.type, matchedText: match[0] });
    }
    for (const candidate of medium) {
      const match = folded.match(candidate.pattern);
      if (match) markers.push({ id: `marker:${segment.seq}:${candidate.type}`, segmentSeq: segment.seq, confidence: 'medium', markerType: candidate.type, matchedText: match[0] });
    }
    const hint = folded.match(low);
    if (hint) markers.push({ id: `marker:${segment.seq}:lexical`, segmentSeq: segment.seq, confidence: 'low', markerType: 'lexical-hint', matchedText: hint[0] });
  }
  return markers;
}

export function registerNormalizedSource(db: DatabaseSync, input: { projectId: string; intakeSourceId: string; fileName: string; immutablePath: string; contentHash: string; bytes?: Buffer; eventDate?: string | null }) {
  const existing = db.prepare('SELECT id, event_date, normaliser_version FROM source_documents WHERE project_id = ? AND content_hash = ?').get(input.projectId, input.contentHash) as { id: string; event_date: string | null; normaliser_version: string } | undefined;
  if (existing) {
    return {
      sourceId: existing.id,
      duplicate: true as const,
      eventDate: existing.event_date,
      // Surfacing a stale normaliser lets the caller offer re-normalisation
      // rather than silently reusing evidence produced by older parsing rules.
      staleNormaliser: existing.normaliser_version !== SOURCE_NORMALISER_VERSION,
      normaliserVersion: existing.normaliser_version,
    };
  }
  const bytes = input.bytes ?? readFileSync(input.immutablePath);
  if (hash(bytes) !== input.contentHash) throw new Error('Source bytes do not match the registered intake hash.');
  const document = normalizeSource(input.fileName, bytes, input.eventDate);
  if (document.segments.length === 0) throw new Error('Source normalisation produced no mechanically addressable segments.');
  const project = db.prepare('SELECT code FROM projects WHERE id = ?').get(input.projectId) as { code: string } | undefined;
  if (!project) throw new Error('Cannot register a normalised source against an unknown project.');
  const sourceId = nextSourceId(db, input.projectId, project.code);
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
    // The job is queued here, not "processing": no worker has claimed it yet,
    // and the crash-recovery sweep needs the honest state to reason about leases.
    db.prepare("UPDATE source_processing_jobs SET status = 'queued', current_stage = 'queued', queued_at = COALESCE(queued_at, ?), updated_at = ?, packet_id = NULL, changeset_id = NULL, error_message = NULL, error_kind = NULL, error_detail_json = NULL, recovery_action = NULL WHERE id = ?").run(createdAt, createdAt, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { sourceId, duplicate: false, eventDate: document.eventDate, eventDateEvidence: document.eventDateEvidence, segmentCount: document.segments.length, windowCount: windows.length, markerCounts: { high: markers.filter((item) => item.confidence === 'high').length, medium: markers.filter((item) => item.confidence === 'medium').length, low: markers.filter((item) => item.confidence === 'low').length }, jobId };
}

/**
 * Deliberately discard a normalised source so it can be re-registered under the
 * current normaliser.
 *
 * Evidence is immutable, but it is not permanent: when the normaliser changes,
 * the honest options are to keep serving evidence produced by superseded parsing
 * rules or to re-derive it. This is the second, and it is refused outright once
 * any changeset from that source has been applied, because at that point the
 * evidence underwrites canonical register state.
 */
export function renormalizeSource(db: DatabaseSync, sourceId: string, options: { bytes?: Buffer; eventDate?: string | null } = {}) {
  const source = db.prepare('SELECT id, project_id, intake_source_id, content_hash, original_file_name, immutable_path, normaliser_version FROM source_documents WHERE id = ?').get(sourceId) as Record<string, unknown> | undefined;
  if (!source) throw new Error('Source document not found.');
  const applied = db.prepare("SELECT count(*) count FROM register_changesets WHERE source_id = ? AND review_status = 'applied'").get(sourceId) as { count: number };
  if (applied.count > 0) throw new Error('This source underwrites applied register state and cannot be re-normalised; ingest a corrected source instead.');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM source_documents WHERE id = ?').run(sourceId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return registerNormalizedSource(db, {
    projectId: String(source.project_id),
    intakeSourceId: String(source.intake_source_id ?? ''),
    fileName: String(source.original_file_name),
    immutablePath: String(source.immutable_path),
    contentHash: String(source.content_hash),
    bytes: options.bytes,
    eventDate: options.eventDate,
  });
}

function packetRows(packet: SourceIntelligencePacket) {
  return registerNames.flatMap((registerName) => packet.sheets[registerName].rows.map((row) => ({ registerName, row })));
}

export interface ValidatePacketOptions {
  // `replay` re-validates a stored packet against the evidence it was frozen
  // from, without asserting that the register is still at the packet's base
  // revision. A historically clean packet must not be reported as quarantined
  // merely because a later changeset moved the register on (C16).
  mode?: 'freeze' | 'replay';
}

export function validatePacket(db: DatabaseSync, rawPacket: unknown, options: ValidatePacketOptions = {}) {
  const mode = options.mode ?? 'freeze';
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

  // Source metadata is server-held evidence, not something the packet may
  // restate differently. A packet claiming a later event date than the stored
  // source would silently defeat human-edit precedence (B5).
  if (source) {
    const storedEventDate = source.event_date ? String(source.event_date) : null;
    if ((packet.source.event_date ?? null) !== storedEventDate) issues.push({ rule: 'source-event-date', severity: 'blocker', message: `Packet event date ${packet.source.event_date ?? 'null'} does not match the registered source event date ${storedEventDate ?? 'null'}.` });
    if (String(source.original_file_name) !== packet.source.original_file_name) issues.push({ rule: 'source-metadata', severity: 'blocker', message: 'Packet source file name does not match the registered source.' });
    if (String(source.source_type) !== packet.source.source_type) issues.push({ rule: 'source-metadata', severity: 'blocker', message: 'Packet source type does not match the registered source.' });
  }

  const currentRevision = project ? Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(project.id) as { revision: number } | undefined)?.revision ?? 0) : 0;
  const revisionCurrent = packet.base_register_revision === currentRevision;
  if (!revisionCurrent && mode === 'freeze') issues.push({ rule: 'base-register-revision', severity: 'blocker', message: `Packet revision ${packet.base_register_revision} does not match current revision ${currentRevision}.` });

  const markerRows = source ? db.prepare('SELECT id, segment_seq, confidence, dismissal_reason FROM source_markers WHERE source_id = ?').all(String(source.id)) as Array<{ id: string; segment_seq: number; confidence: string; dismissal_reason: string | null }> : [];
  const markerById = new Map(markerRows.map((marker) => [marker.id, marker]));
  const validDischarges = new Map<string, string>();
  const anchoredSegmentsByRef = new Map<string, number[]>();
  const sourceParticipants = source ? (JSON.parse(String(source.participants_json ?? '[]')) as string[]) : [];

  const refs = new Set<string>();
  for (const { registerName, row } of packetRows(packet)) {
    if (refs.has(row.client_ref)) issues.push({ rule: 'unique-client-ref', severity: 'blocker', message: `Duplicate client_ref ${row.client_ref}.`, clientRef: row.client_ref });
    refs.add(row.client_ref);
    if (row.op === 'add' && (row.proposed_id !== '$ALLOC' || row.target_id !== null)) issues.push({ rule: 'server-id-allocation', severity: 'blocker', message: 'Add operations must use proposed_id $ALLOC and target_id null.', clientRef: row.client_ref });
    if (row.op !== 'add' && row.proposed_id !== null && row.proposed_id !== row.target_id) issues.push({ rule: 'server-id-allocation', severity: 'blocker', message: `${row.op} operations must leave proposed_id null or equal to target_id; identifiers are allocated server-side.`, clientRef: row.client_ref });
    if (row.op !== 'add' && !row.target_id) issues.push({ rule: 'target-required', severity: 'blocker', message: `${row.op} requires target_id.`, clientRef: row.client_ref });
    if (row.derivation === 'inference' && !row.reasoning) issues.push({ rule: 'inference-reasoning', severity: 'blocker', message: 'Inference items require explicit reasoning.', clientRef: row.client_ref });
    const citedSegmentTexts: string[] = [];
    const anchoredSeqs: number[] = [];
    for (const anchor of row.anchors) {
      const segments = db.prepare('SELECT * FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ? ORDER BY seq').all(packet.source.source_id, anchor.segment_seq - 1, anchor.segment_seq + 1) as Array<Record<string, unknown>>;
      const exact = segments.find((segment) => Number(segment.seq) === anchor.segment_seq);
      if (!exact) {
        issues.push({ rule: 'anchor-resolution', severity: 'blocker', message: `Segment ${anchor.segment_seq} does not exist.`, clientRef: row.client_ref });
        continue;
      }
      anchoredSeqs.push(anchor.segment_seq);
      for (const segment of segments) citedSegmentTexts.push(String(segment.text ?? ''));
      if (anchor.speaker && foldEvidence(String(exact.speaker ?? '')) !== foldEvidence(anchor.speaker)) issues.push({ rule: 'anchor-speaker', severity: 'blocker', message: `Anchor speaker does not match segment ${anchor.segment_seq}.`, clientRef: row.client_ref });
      if (anchor.t_ms !== null && exact.t_start_ms !== null && Math.abs(Number(exact.t_start_ms) - anchor.t_ms) > 30000) issues.push({ rule: 'anchor-time', severity: 'blocker', message: `Anchor time is more than 30 seconds from segment ${anchor.segment_seq}.`, clientRef: row.client_ref });

      // Quote semantics, explicitly (B1, B2):
      //  - a `fact` anchor MUST carry a verbatim quote, and it must resolve;
      //  - an `inference` anchor MAY omit a quote (the claim is reasoned, not
      //    stated) but ANY quote it does supply must resolve exactly as
      //    strictly — an unverified quote must never be presented as evidence;
      //  - a quote too short to constitute evidence is rejected outright.
      if (row.derivation === 'fact' && !anchor.quote) {
        issues.push({ rule: 'fact-quote', severity: 'blocker', message: 'Fact anchors require a verbatim quote.', clientRef: row.client_ref });
      } else if (anchor.quote) {
        if (quoteIsTrivial(anchor.quote, String(exact.text ?? ''))) {
          issues.push({ rule: 'quote-triviality', severity: 'blocker', message: `Quote for segment ${anchor.segment_seq} is too short to constitute evidence; quote at least ${MIN_QUOTE_WORDS} words.`, clientRef: row.client_ref });
        } else if (!quoteResolves(segments, anchor.quote)) {
          issues.push({ rule: 'quote-verification', severity: 'blocker', message: `Quote was not found verbatim in segment ${anchor.segment_seq} or an adjacent segment.`, clientRef: row.client_ref });
        }
      }
    }

    // The cited evidence must plausibly support the structured claim. A
    // perfectly verbatim quote attached to an unrelated assertion is still a
    // fabrication.
    // `Sources` rows describe the artefact itself — their title is the file
    // name by contract — so vocabulary overlap with the transcript is not
    // expected. `Entities` rows name a participant or organisation, so they get
    // a name-presence check instead of a vocabulary check.
    if (anchoredSeqs.length > 0 && registerName !== 'Sources') {
      if (registerName === 'Entities') {
        const haystack = new Set([...citedSegmentTexts.flatMap((textValue) => evidenceTokens(textValue)), ...sourceParticipants.flatMap((name) => evidenceTokens(name))]);
        const nameTokens = evidenceTokens(row.title);
        const folded = [...citedSegmentTexts, ...sourceParticipants].map(foldEvidence).join(' ');
        const present = nameTokens.length > 0 ? nameTokens.some((token) => haystack.has(token)) : folded.includes(foldEvidence(row.title));
        if (!present) {
          issues.push({ rule: 'entity-support', severity: 'blocker', message: 'Entity name does not appear in the segments it cites or among the source participants.', clientRef: row.client_ref });
        }
      } else if (claimSupport(row, citedSegmentTexts) === 0) {
        issues.push({
          rule: 'claim-support',
          severity: row.derivation === 'fact' ? 'blocker' : 'warning',
          message: 'Row shares no substantive vocabulary with the segments it cites.',
          clientRef: row.client_ref,
        });
      }
    }
    anchoredSegmentsByRef.set(row.client_ref, anchoredSeqs);

    // HIGH-marker discharge must be earned, not echoed (B3). A discharging item
    // has to be anchored in the neighbourhood of the marker it claims to
    // account for; previously any row could discharge any marker by repeating
    // an identifier it had been handed in the prompt.
    for (const markerId of row.discharges_markers) {
      const marker = markerById.get(markerId);
      if (!marker) {
        issues.push({ rule: 'marker-unknown', severity: 'blocker', message: `Row discharges unknown marker ${markerId}.`, clientRef: row.client_ref });
        continue;
      }
      const near = anchoredSeqs.some((seq) => Math.abs(seq - Number(marker.segment_seq)) <= MARKER_DISCHARGE_RADIUS);
      if (!near) {
        issues.push({ rule: 'marker-discharge-locality', severity: 'blocker', message: `Row claims to discharge marker ${markerId} at segment ${marker.segment_seq} but is not anchored within ${MARKER_DISCHARGE_RADIUS} segments of it.`, clientRef: row.client_ref });
        continue;
      }
      if (!validDischarges.has(markerId)) validDischarges.set(markerId, row.client_ref);
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
  // Window coverage is a gate, not a checklist of keys (B4). A packet in which
  // every window reported `failed`, or reported `reviewed` with no items and no
  // explanation, used to validate clean.
  const expectedWindows = source ? db.prepare('SELECT seq, start_seq, end_seq FROM source_windows WHERE source_id = ?').all(String(source.id)) as Array<{ seq: number; start_seq: number; end_seq: number }> : [];
  const windowCoverage = new Map(packet.coverage.windows.map((entry) => [Number(entry.key), entry]));
  const allAnchoredSeqs = [...anchoredSegmentsByRef.values()].flat();
  for (const window of expectedWindows) {
    const entry = windowCoverage.get(window.seq);
    if (!entry) {
      issues.push({ rule: 'window-coverage', severity: 'blocker', message: `Source window ${window.seq} has no coverage status.` });
      continue;
    }
    if (entry.status === 'failed') {
      issues.push({ rule: 'window-failed', severity: 'blocker', message: `Source window ${window.seq} was not successfully reviewed${entry.explanation ? `: ${entry.explanation}` : '.'}` });
      continue;
    }
    if (entry.item_count === 0 && !entry.explanation) {
      issues.push({ rule: 'window-empty-unexplained', severity: 'blocker', message: `Source window ${window.seq} reported ${entry.status} with no items and no explanation.` });
    }
    const anchoredHere = allAnchoredSeqs.filter((seq) => seq >= window.start_seq && seq <= window.end_seq).length;
    // A window cannot have yielded more items than the packet anchors into it.
    if (entry.item_count > anchoredHere) {
      issues.push({ rule: 'window-item-count', severity: 'blocker', message: `Source window ${window.seq} claims ${entry.item_count} items but only ${anchoredHere} packet rows are anchored inside it.` });
    }
  }
  for (const key of windowCoverage.keys()) {
    if (!expectedWindows.some((window) => window.seq === key)) issues.push({ rule: 'window-unknown', severity: 'blocker', message: `Coverage reports window ${key}, which does not exist for this source.` });
  }
  if (packet.sheets.Sources.rows.length === 0) issues.push({ rule: 'source-row', severity: 'blocker', message: 'Packet has no Sources register row.' });
  if ((source ? JSON.parse(String(source.participants_json ?? '[]')) as unknown[] : []).length > 1 && packet.sheets.Entities.rows.length === 0 && !categories.get('Entities')?.explanation) issues.push({ rule: 'entity-coverage', severity: 'blocker', message: 'Multi-speaker source has zero entities without explanation.' });
  if (packet.sheets.Uncertainty.rows.length === 0 && !categories.get('Uncertainty')?.explanation) issues.push({ rule: 'uncertainty-coverage', severity: 'blocker', message: 'Uncertainty ledger is empty without explanation.' });

  // Only discharges that passed the locality check above count.
  const highMarkerRows = markerRows.filter((entry) => entry.confidence === 'high');
  for (const marker of highMarkerRows) {
    if (!validDischarges.has(marker.id) && !marker.dismissal_reason) issues.push({ rule: 'high-marker-discharge', severity: 'blocker', message: `HIGH marker ${marker.id} is neither validly linked nor explicitly dismissed.` });
  }
  // Dismissal is a legitimate answer for a genuine false positive, but it must
  // not become the cheap way to clear the checklist. A model-proposed dismissal
  // still faces the human in the review lane; the cap is what stops a pass from
  // dismissing its way to a clean verdict.
  const dismissedHigh = highMarkerRows.filter((entry) => entry.dismissal_reason && !validDischarges.has(entry.id));
  const modelProposed = dismissedHigh.filter((entry) => String(entry.dismissal_reason).startsWith('model-proposed'));
  if (highMarkerRows.length > 0 && modelProposed.length / highMarkerRows.length > MAX_MODEL_DISMISSAL_RATIO) {
    issues.push({ rule: 'marker-dismissal-rate', severity: 'blocker', message: `${modelProposed.length} of ${highMarkerRows.length} HIGH markers were dismissed rather than accounted for, above the ${Math.round(MAX_MODEL_DISMISSAL_RATIO * 100)}% limit.` });
  }
  if (modelProposed.length > 0) {
    issues.push({ rule: 'marker-dismissal-review', severity: 'warning', message: `${modelProposed.length} HIGH marker dismissals are model-proposed and need explicit human confirmation: ${modelProposed.map((entry) => entry.id).join(', ')}.` });
  }

  // Provenance must come from a run that actually produced output (B7). The
  // prior gate accepted a `status = 'failed'` run — exactly the shape of a
  // transport failure that returned no model output at all — as trusted
  // evidence for a frozen packet.
  for (const runId of packet.execution.runs) {
    const run = db.prepare('SELECT * FROM extraction_runs WHERE id = ? AND source_id = ?').get(runId, packet.source.source_id) as Record<string, unknown> | undefined;
    if (!run || !run.provider_id || !run.model_label || !run.skill_sha256 || !run.prompt_sha256) {
      issues.push({ rule: 'execution-provenance', severity: 'blocker', message: `Execution run ${runId} is missing trusted provider provenance.` });
      continue;
    }
    if (String(run.status) !== 'completed') issues.push({ rule: 'execution-status', severity: 'blocker', message: `Execution run ${runId} has status ${String(run.status)}; only a completed run may support a frozen packet.` });
    if (!run.output_sha256) issues.push({ rule: 'execution-output', severity: 'blocker', message: `Execution run ${runId} recorded no model output.` });
  }
  const totalRuns = packet.execution.runs.map((id) => db.prepare('SELECT input_tokens, output_tokens, source_tokens, duration_ms FROM extraction_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined).filter(Boolean) as Array<Record<string, unknown>>;
  const calls = totalRuns.length;
  const inputTokens = totalRuns.reduce((total, run) => total + Number(run.input_tokens), 0);
  const sourceTokens = source ? Math.ceil(Number(source.word_count) * 1.35) : 0;
  const repeated = totalRuns.reduce((total, run) => total + Number(run.source_tokens), 0);
  const repetition = sourceTokens ? repeated / sourceTokens : 0;
  // The budget is a property of the job, not of the surviving pass. Counting only
  // `packet.execution.runs` meant tokens burned by an earlier failed attempt on
  // the same source were recorded and then ignored, so a job could spend twice
  // the limit and still validate green.
  const jobRuns = source ? db.prepare('SELECT input_tokens, output_tokens, duration_ms, status FROM extraction_runs WHERE source_id = ?').all(String(source.id)) as Array<Record<string, unknown>> : [];
  const jobCalls = jobRuns.length;
  const jobInputTokens = jobRuns.reduce((total, run) => total + Number(run.input_tokens), 0);
  if (jobCalls > 12 || jobInputTokens > 200000 || repetition > 2.5) issues.push({ rule: 'cost-budget', severity: 'blocker', message: `Configured extraction budget exceeded across every attempt on this source: ${jobCalls} calls, ${jobInputTokens} input tokens, ${repetition.toFixed(2)}x source repetition.` });
  if (calls > 6 || repetition > 2) issues.push({ rule: 'cost-drift', severity: 'warning', message: `Extraction cost is approaching its acceptance limit.` });

  const verdict = issues.some((issue) => issue.severity === 'blocker') ? 'quarantined' : issues.some((issue) => issue.severity === 'warning') ? 'warnings' : 'clean';
  return {
    packet,
    verdict,
    issues,
    revisionCurrent,
    metrics: {
      calls,
      inputTokens,
      outputTokens: totalRuns.reduce((total, run) => total + Number(run.output_tokens), 0),
      sourceTokenRepetition: Number(repetition.toFixed(3)),
      durationMs: totalRuns.reduce((total, run) => total + Number(run.duration_ms), 0),
      highMarkers: markerRows.filter((entry) => entry.confidence === 'high').length,
      highMarkersDischarged: validDischarges.size,
      highMarkersDismissed: dismissedHigh.length,
      highMarkersDismissedByModel: modelProposed.length,
      anchoredRows: anchoredSegmentsByRef.size,
      jobCalls,
      jobInputTokens,
      jobOutputTokens: jobRuns.reduce((total, run) => total + Number(run.output_tokens), 0),
      jobDurationMs: jobRuns.reduce((total, run) => total + Number(run.duration_ms), 0),
    },
  };
}

type PacketRow = SourceIntelligencePacket['sheets']['Actions']['rows'][number];

// For `update`-family operations, a null value means "this source did not speak
// to this field", not "clear it" (C13). Explicitly clearing a field is done with
// an empty string. Without this distinction a source that changed only a summary
// nulled the row's owner, because the schema defaults every unmentioned field to
// null.
function assertedFields(row: PacketRow): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    title: row.title,
    summary: row.summary,
    status: row.status,
    record_type: row.record_type,
    owner: row.owner,
    due_date_raw: row.due_date_raw,
    source_ref: row.source_ref,
    related_refs: row.related_refs,
    supersedes: row.supersedes,
    details: row.details,
  };
  if (row.op === 'add') return candidate;
  const asserted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === 'details' && Object.keys(value as JsonObject).length === 0) continue;
    asserted[key] = value;
  }
  return asserted;
}

// The instant after which a human edit outranks this source. When the source
// carries an event date we use the end of that day; when it does not — which is
// every transcript with no recoverable date — we fall back to the moment the
// source was ingested, because a human edit recorded after ingest unambiguously
// postdates the source. The previous code returned `false` outright on a null
// event date, which disabled human-edit protection entirely (B5).
function humanPrecedenceInstant(source: { event_date: string | null; created_at: string }): string {
  return source.event_date ? `${source.event_date}T23:59:59.999Z` : source.created_at;
}

// Precedence is checked per field, not per row (B6): a newer human note on
// `owner` must not block an extracted update to `mitigation`. Only fields this
// packet actually asserts a change to can be contested.
function contestedFields(db: DatabaseSync, projectId: string, targetId: string, row: PacketRow, instant: string): string[] {
  const asserted = assertedFields(row);
  const stored = db.prepare('SELECT raw_row_json FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, targetId) as { raw_row_json: string } | undefined;
  const existing = stored ? (JSON.parse(stored.raw_row_json) as JsonObject) : {};
  const existingDetails = (existing.details ?? {}) as JsonObject;
  // The comparison baseline is the CURRENT projected state, which already
  // incorporates human events — not the canonical row, which still holds the
  // pre-edit value. Comparing against the canonical row would let a source
  // silently revert a human edit simply by restating the value the human
  // replaced.
  const projected = db.prepare('SELECT status, owner, due_date, resolution FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, targetId) as Record<string, unknown> | undefined;
  const currentOf = (field: string, fallback: unknown): unknown => (projected && field in projected && projected[field] !== null && projected[field] !== undefined ? projected[field] : fallback);

  // Only fields whose value this source actually CHANGES can be contested. The
  // schema forces `title`, `summary` and `status` to be present on every row, so
  // presence alone would make a status conflict unavoidable even when the source
  // proposes the value already in effect.
  const changed = new Set<string>();
  for (const [key, value] of Object.entries(asserted)) {
    if (key === 'details') continue;
    const field = key === 'due_date_raw' ? 'due_date' : key;
    if (canonicalValueJson(value) === canonicalValueJson(currentOf(field, existing[key]))) continue;
    changed.add(field);
  }
  for (const [key, value] of Object.entries((asserted.details ?? {}) as JsonObject)) {
    if (canonicalValueJson(value) === canonicalValueJson(currentOf(key, existingDetails[key]))) continue;
    changed.add(key);
  }
  const statement = db.prepare('SELECT 1 FROM register_row_events WHERE project_id = ? AND external_register_id = ? AND field = ? AND occurred_at > ? LIMIT 1');
  return [...changed].sort().filter((field) => Boolean(statement.get(projectId, targetId, field, instant)));
}

// Deterministic near-duplicate detection for additions (B8). The
// `possible_duplicate` lane was referenced by two rejection guards and the UI
// but had no producer at all, so a transcript and its follow-up email each
// created a separate register row for the same commitment with no reviewer
// signal. Pure function of stored state and packet content — no clock, no
// randomness, no model involvement.
const DUPLICATE_TITLE_SIMILARITY = 0.7;

function duplicateCandidate(db: DatabaseSync, projectId: string, registerName: RegisterName, row: PacketRow): string | null {
  const candidateTokens = new Set(evidenceTokens(row.title));
  if (candidateTokens.size === 0) return null;
  const existing = db.prepare("SELECT external_register_id, title FROM project_register_rows WHERE project_id = ? AND register_name = ? AND record_status NOT IN ('superseded', 'rejected') ORDER BY external_register_id").all(projectId, registerName) as Array<{ external_register_id: string; title: string }>;
  let best: { id: string; score: number } | null = null;
  for (const candidate of existing) {
    const tokens = new Set(evidenceTokens(String(candidate.title)));
    if (tokens.size === 0) continue;
    let shared = 0;
    for (const token of candidateTokens) if (tokens.has(token)) shared += 1;
    const score = (2 * shared) / (candidateTokens.size + tokens.size);
    // Ties resolve to the lowest external id because the query is ordered.
    if (score >= DUPLICATE_TITLE_SIMILARITY && (!best || score > best.score)) best = { id: String(candidate.external_register_id), score };
  }
  return best ? best.id : null;
}

function deterministicOps(db: DatabaseSync, projectId: string, packet: SourceIntelligencePacket) {
  const source = db.prepare('SELECT event_date, created_at FROM source_documents WHERE id = ?').get(packet.source.source_id) as { event_date: string | null; created_at: string } | undefined;
  // No weaker fallback: a missing source row must not silently disable
  // human-edit precedence. `validatePacket` already blocks this, and a second,
  // laxer copy of the removed defect sitting behind one gate is not acceptable.
  if (!source) throw new Error('Cannot reconcile a packet whose source document is not registered.');
  const instant = humanPrecedenceInstant(source);
  return packetRows(packet).map(({ registerName, row }, index) => {
    let op: string = row.op;
    let reason: string | null = null;
    let contested: string[] = [];
    let duplicateOf: string | null = null;
    if (row.op !== 'add' && row.target_id) {
      const target = db.prepare('SELECT register_name FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, row.target_id) as { register_name: string } | undefined;
      if (!target || target.register_name !== registerName) {
        op = 'unverified_link';
        reason = 'Target does not exist in the same project and register.';
      } else {
        contested = contestedFields(db, projectId, row.target_id, row, instant);
        if (contested.length > 0) {
          op = 'conflict';
          reason = `A newer human field event outranks this source assertion on: ${contested.join(', ')}.`;
        }
      }
    } else if (row.op === 'add') {
      duplicateOf = duplicateCandidate(db, projectId, registerName, row);
      if (duplicateOf) {
        op = 'possible_duplicate';
        reason = `Substantively similar to existing ${registerName} row ${duplicateOf}; adjudicate before adding a second record.`;
      }
    }
    const current = row.target_id ? db.prepare('SELECT raw_row_json FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, row.target_id) as { raw_row_json: string } | undefined : undefined;
    const proposed = { ...assertedFields(row), discharges_markers: row.discharges_markers };
    return {
      seq: index + 1, op, registerName, clientRef: row.client_ref, targetExternalId: row.target_id,
      proposedRow: proposed,
      fieldDiff: current ? { before: JSON.parse(current.raw_row_json) as unknown, after: proposed, reason, contestedFields: contested, duplicateOf } : { before: null, after: proposed, reason, contestedFields: contested, duplicateOf },
      anchors: row.anchors, confidence: row.confidence, derivation: row.derivation,
    };
  });
}

export interface ProviderAnomaly {
  kind: 'rejected-row' | 'merge-conflict';
  detail: string;
}

export interface FreezeOptions {
  /**
   * Everything the provider emitted that did not survive into the packet.
   *
   * These are recorded in the packet's validation report as warnings so the loss
   * is visible to the reviewer. A dropped row must never be mistaken for a source
   * that simply said less, and the unknown field that caused the drop is carried
   * verbatim in the detail.
   */
  providerAnomalies?: ProviderAnomaly[];
  skillProvenance?: { skillId: string | null; skillVersion: string | null; promptTemplateVersion: string | null };
}

export function freezePacketAndCreateChangeset(db: DatabaseSync, rawPacket: unknown, options: FreezeOptions = {}) {
  const validation = validatePacket(db, rawPacket);
  if (!validation.packet) throw new Error(`Packet schema validation failed: ${validation.issues.map((issue) => issue.message).join('; ')}`);
  const packet = validation.packet;
  const anomalies = options.providerAnomalies ?? [];
  for (const anomaly of anomalies) {
    validation.issues.push({ rule: `provider-${anomaly.kind}`, severity: 'warning', message: anomaly.detail });
  }
  // A packet that lost rows is not a clean packet. Recompute the verdict so the
  // gate report and the review lane both reflect the loss.
  const gateVerdict = validation.issues.some((issue) => issue.severity === 'blocker')
    ? 'quarantined'
    : validation.issues.some((issue) => issue.severity === 'warning')
      ? 'warnings'
      : 'clean';
  const project = db.prepare('SELECT id FROM projects WHERE code = ?').get(packet.project_code) as { id: string };
  const packetJson = stable(packet);
  const packetHash = hash(packetJson);
  const packetId = `packet:${project.id}:${packetHash.slice(0, 20)}`;
  const changesetId = `changeset:${project.id}:${packetHash.slice(0, 20)}`;
  const ops = deterministicOps(db, project.id, packet);
  const deterministicHash = hash(stable({ baseRegisterRevision: packet.base_register_revision, ops, versions: { validator: VALIDATOR_VERSION, reconciliation: RECONCILIATION_VERSION, projector: PROJECTOR_VERSION, scoring: activeScoringVersion(db) } }));
  const assembledAt = nowIso();

  // Freezing is idempotent (C1). Re-submitting a packet that has already been
  // frozen must return the existing handoff untouched. The previous code
  // unconditionally deleted and re-inserted every operation as `pending`, which
  // destroyed the reviewer's decisions while leaving `review_status` at
  // `ready-to-apply` — so the subsequent apply selected zero accepted
  // operations, wrote an empty import run, bumped the register revision, marked
  // the changeset applied and reported success. Reviewed content vanished with
  // an audit trail that read "applied".
  const alreadyFrozen = db.prepare('SELECT id FROM extraction_packets WHERE project_id = ? AND packet_sha256 = ?').get(project.id, packetHash) as { id: string } | undefined;
  if (alreadyFrozen) {
    const existing = db.prepare('SELECT * FROM register_changesets WHERE id = ?').get(changesetId) as Record<string, unknown> | undefined;
    return {
      packetId: String(alreadyFrozen.id),
      packetHash,
      changesetId,
      deterministicHash: existing ? String(existing.deterministic_hash) : deterministicHash,
      gateVerdict: existing ? String(existing.gate_verdict) : validation.verdict,
      validation,
      alreadyFrozen: true as const,
      reviewStatus: existing ? String(existing.review_status) : null,
    };
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const firstRun = db.prepare('SELECT skill_sha256, prompt_sha256 FROM extraction_runs WHERE id = ?').get(packet.execution.runs[0]) as { skill_sha256: string; prompt_sha256: string };
    db.prepare('INSERT INTO extraction_packets (id, source_id, project_id, packet_contract_version, source_normaliser_version, database_schema_version, validator_version, reconciliation_engine_version, current_state_projector_version, scoring_configuration_version, skill_sha256, prompt_sha256, packet_sha256, packet_json, assembled_at, validation_status, validation_report_json, base_register_revision, skill_id, skill_version, prompt_template_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, packet_sha256) DO NOTHING')
      .run(packetId, packet.source.source_id, project.id, PACKET_VERSION, SOURCE_NORMALISER_VERSION, DATABASE_SCHEMA_VERSION, VALIDATOR_VERSION, RECONCILIATION_VERSION, PROJECTOR_VERSION, activeScoringVersion(db), firstRun.skill_sha256, firstRun.prompt_sha256, packetHash, packetJson, assembledAt, gateVerdict, JSON.stringify({ issues: validation.issues, metrics: validation.metrics, providerAnomalies: anomalies }), packet.base_register_revision, options.skillProvenance?.skillId ?? null, options.skillProvenance?.skillVersion ?? null, options.skillProvenance?.promptTemplateVersion ?? null);
    const coverage = db.prepare('INSERT OR REPLACE INTO packet_coverage (packet_id, scope, key, status, item_count, explanation) VALUES (?, ?, ?, ?, ?, ?)');
    for (const entry of packet.coverage.windows) coverage.run(packetId, 'window', entry.key, entry.status, entry.item_count, entry.explanation);
    for (const entry of packet.coverage.categories) coverage.run(packetId, 'category', entry.key, entry.status, entry.item_count, entry.explanation);
    db.prepare('INSERT INTO register_changesets (id, packet_id, project_id, source_id, created_at, gate_verdict, gate_report_json, review_status, applied_at, base_register_revision, deterministic_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET gate_verdict = excluded.gate_verdict, gate_report_json = excluded.gate_report_json, deterministic_hash = excluded.deterministic_hash')
      .run(changesetId, packetId, project.id, packet.source.source_id, assembledAt, gateVerdict, JSON.stringify({ ...validation, verdict: gateVerdict, providerAnomalies: anomalies }), gateVerdict === 'quarantined' ? 'quarantined' : 'pending', packet.base_register_revision, deterministicHash);
    // Only untouched operations may be replaced; migration 011 enforces the same
    // rule with a trigger so no future writer can bypass it.
    db.prepare("DELETE FROM register_change_ops WHERE changeset_id = ? AND status = 'pending'").run(changesetId);
    const insertOp = db.prepare('INSERT INTO register_change_ops (id, changeset_id, seq, op, register_name, client_ref, target_external_id, allocated_external_id, proposed_row_json, field_diff_json, anchors_json, confidence, derivation, status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)');
    for (const op of ops) insertOp.run(`${changesetId}:op:${String(op.seq).padStart(3, '0')}`, changesetId, op.seq, op.op, op.registerName, op.clientRef, op.targetExternalId, stable(op.proposedRow), stable(op.fieldDiff), stable(op.anchors), op.confidence, op.derivation, 'pending');
    const jobId = `source-job:${project.id}:${packet.source.content_hash.slice(0, 16)}`;
    db.prepare("UPDATE source_processing_jobs SET status = ?, current_stage = ?, completed_at = CASE WHEN ? = 'quarantined' THEN ? ELSE completed_at END, updated_at = ?, packet_id = ?, changeset_id = ?, error_message = ? WHERE id = ?")
      .run(gateVerdict === 'quarantined' ? 'quarantined' : 'awaiting_review', gateVerdict === 'quarantined' ? 'quarantined' : 'awaiting_review', gateVerdict, assembledAt, assembledAt, packetId, changesetId, gateVerdict === 'quarantined' ? validation.issues.filter((issue) => issue.severity === 'blocker').map((issue) => issue.message).join('; ') : null, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { packetId, packetHash, changesetId, deterministicHash, gateVerdict, validation };
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
  // Every register identifier is project-qualified, Sources included. Sources
  // rows previously allocated a bare `SRC-nnn`, which becomes a database-wide
  // namespace once projected into `project_sources`, so the second project to
  // apply a changeset collided with the first and rolled back — the C2 defect
  // displaced from ingest to apply.
  const prefix = `${projectCode}-${prefixes[registerName]}`;
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

function upsertFact(db: DatabaseSync, context: { projectId: string; projectCode: string; packetId: string; packetHash: string; sourceId: string; importRunId: string; timestamp: string; refMap: Map<string, string>; verifiedQuotes: Set<string> }, op: Record<string, unknown>) {
  const registerName = String(op.register_name) as RegisterName;
  const proposed = JSON.parse(String(op.proposed_row_json)) as JsonObject;
  const targetId = op.target_external_id ? String(op.target_external_id) : null;
  if (['conflict', 'unverified_link', 'possible_duplicate'].includes(String(op.op))) throw new Error(`${op.op} requires adjudication and cannot be applied directly.`);
  if (op.op === 'reaffirm' && targetId) {
    db.prepare('INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)')
      .run(randomUUID(), context.projectId, targetId, context.timestamp, String(op.reviewer ?? 'reviewer'), 'reaffirm', 'Source reaffirmed the existing record.', context.packetId, context.sourceId);
    return targetId;
  }
  const externalId = context.refMap.get(String(op.client_ref)) ?? targetId;
  if (!externalId) throw new Error('Apply operation has no target or allocated ID.');
  const existing = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(context.projectId, externalId) as Record<string, unknown> | undefined;
  // `proposed` carries only the fields this source actually asserted, so an
  // update genuinely patches the row instead of nulling everything the source
  // did not mention (C13).
  const raw = existing ? { ...(JSON.parse(String(existing.raw_row_json)) as JsonObject), ...proposed } : { ...proposed };
  delete raw.discharges_markers;
  // Intra-packet references arrive as client refs and must resolve to the
  // durable identifiers allocated in this same transaction (C14). Previously
  // they were persisted verbatim, leaving every cross-reference dangling.
  const resolveRefs = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => context.refMap.get(String(entry)) ?? String(entry)) : []);
  const relatedIds = resolveRefs(proposed.related_refs);
  const supersedesIds = resolveRefs(proposed.supersedes);
  raw.related_refs = relatedIds;
  raw.supersedes = supersedesIds;
  if (op.op === 'resolve') raw.status = 'resolved';
  const due = resolveDate(proposed.due_date_raw, (db.prepare('SELECT event_date FROM source_documents WHERE id = ?').get(context.sourceId) as { event_date: string | null }).event_date);
  const rowId = `register:${context.projectId}:${externalId}`;
  db.prepare(`INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at, derivation, confidence, first_seen_source_id, last_updated_source_id, due_date_raw, due_date_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, external_register_id) DO UPDATE SET title = excluded.title, summary = excluded.summary, record_status = excluded.record_status, record_type = excluded.record_type, owner = excluded.owner, due_date = excluded.due_date, source_ref = excluded.source_ref, original_status_wording = excluded.original_status_wording, related_ids_json = excluded.related_ids_json, supersession_ids_json = excluded.supersession_ids_json, import_run_id = excluded.import_run_id, source_id = excluded.source_id, raw_row_json = excluded.raw_row_json, normalized_row_json = excluded.normalized_row_json, updated_at = excluded.updated_at, derivation = excluded.derivation, confidence = excluded.confidence, last_updated_source_id = excluded.last_updated_source_id, due_date_raw = excluded.due_date_raw, due_date_confidence = excluded.due_date_confidence`)
    .run(rowId, context.projectId, registerName, externalId, String(raw.title), String(raw.summary ?? ''), String(raw.status ?? 'open'), raw.record_type ? String(raw.record_type) : null, raw.owner ? String(raw.owner) : null, due.date, raw.source_ref ? String(raw.source_ref) : context.sourceId, null, String(raw.status ?? 'open'), JSON.stringify(relatedIds), JSON.stringify(supersedesIds), '[]', context.importRunId, context.sourceId, null, registerName, canonicalRowJson(raw), canonicalNormalizedRowJson(raw), context.timestamp, context.timestamp, String(op.derivation), String(op.confidence), existing?.first_seen_source_id ? String(existing.first_seen_source_id) : context.sourceId, context.sourceId, raw.due_date_raw ? String(raw.due_date_raw) : null, due.confidence);
  db.prepare('DELETE FROM project_register_row_fields WHERE register_row_id = ?').run(rowId);
  const insertField = db.prepare('INSERT INTO project_register_row_fields (id, register_row_id, project_id, register_name, external_register_id, field_name, original_value_json, normalized_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // Import and pipeline now serialise identically (C11); previously the pipeline
  // wrote "[object object]" for every details field, so live field parity drifted
  // the moment a changeset applied.
  for (const [field, value] of Object.entries(raw)) insertField.run(randomUUID(), rowId, context.projectId, registerName, externalId, field, canonicalValueJson(value), canonicalNormalizedValue(value));
  writeTyped(db, registerName, rowId, context.projectId, externalId, (raw.details ?? {}) as JsonObject, String(raw.title), String(raw.status ?? 'open'));
  db.prepare('DELETE FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? AND source_id = ?').run(context.projectId, externalId, context.sourceId);
  const insertAnchor = db.prepare('INSERT INTO register_row_anchors (id, project_id, external_register_id, source_id, segment_id, speaker, t_ms, quote, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const anchor of JSON.parse(String(op.anchors_json)) as Array<{ segment_seq: number; speaker: string | null; t_ms: number | null; quote: string | null }>) {
    // `verified` records whether this quote was mechanically confirmed against
    // the source, not whether we would like it to have been (B1). It was
    // previously hardcoded to 1, so an inference row's unchecked quote was
    // presented to the consultant as verified evidence.
    const verified = anchor.quote && context.verifiedQuotes.has(`${anchor.segment_seq}:${foldEvidence(anchor.quote)}`) ? 1 : 0;
    insertAnchor.run(randomUUID(), context.projectId, externalId, context.sourceId, `${context.sourceId}:seg:${String(anchor.segment_seq).padStart(5, '0')}`, anchor.speaker, anchor.t_ms, anchor.quote, verified);
  }
  // Persist which register item accounted for each HIGH marker, so the discharge
  // is answerable after the fact rather than being a transient gate result (B3).
  const dischargeStatement = db.prepare('UPDATE source_markers SET discharged_by_item_ref = ? WHERE id = ? AND source_id = ?');
  for (const markerId of (Array.isArray(proposed.discharges_markers) ? proposed.discharges_markers : []) as string[]) dischargeStatement.run(externalId, String(markerId), context.sourceId);
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
  if (ops.length === 0) throw new Error('A changeset with no accepted operations cannot be applied; reject it instead of recording an empty apply.');
  const timestamp = nowIso();
  const importRunId = `register-import:${changeset.project_id}:${String(packet.packet_sha256).slice(0, 16)}`;
  // Quotes are re-verified mechanically at apply time so the `verified` flag
  // stored on each anchor reflects the source, not the packet's assertion.
  const verifiedQuotes = new Set<string>();
  for (const op of ops) {
    for (const anchor of JSON.parse(String(op.anchors_json)) as Array<{ segment_seq: number; quote: string | null }>) {
      if (!anchor.quote) continue;
      const segments = db.prepare('SELECT text FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ?').all(String(changeset.source_id), anchor.segment_seq - 1, anchor.segment_seq + 1) as Array<Record<string, unknown>>;
      if (quoteResolves(segments, anchor.quote)) verifiedQuotes.add(`${anchor.segment_seq}:${foldEvidence(anchor.quote)}`);
    }
  }
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`INSERT OR IGNORE INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, source_workbook_name, source_workbook_hash, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json)
      VALUES (?, ?, 'project_register_delta', 1, ?, NULL, NULL, ?, 'completed', ?, ?, ?, ?, '[]', 'human-reviewed', ?)`)
      .run(importRunId, String(changeset.project_id), project.code, String(packet.packet_sha256), timestamp, timestamp, ops.length, ops.length, String(packet.packet_json));
    // Two passes: allocate every durable identifier first, so intra-packet
    // references can resolve to identifiers allocated later in the same
    // changeset (C14). Allocation happens inside this transaction, so a failure
    // rolls the sequence back with everything else.
    const refMap = new Map<string, string>();
    for (const op of ops) {
      const clientRef = String(op.client_ref);
      if (op.op === 'add' || op.op === 'supersede') refMap.set(clientRef, allocateId(db, String(changeset.project_id), project.code, String(op.register_name) as RegisterName));
      else if (op.target_external_id) refMap.set(clientRef, String(op.target_external_id));
    }
    for (const op of ops) upsertFact(db, { projectId: String(changeset.project_id), projectCode: project.code, packetId: String(packet.id), packetHash: String(packet.packet_sha256), sourceId: String(changeset.source_id), importRunId, timestamp, refMap, verifiedQuotes }, op);
    db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at').run(String(changeset.project_id), timestamp);
    rebuildProjection(db, String(changeset.project_id), timestamp);
    db.prepare("UPDATE register_changesets SET review_status = 'applied', applied_at = ? WHERE id = ?").run(timestamp, changesetId);
    db.prepare("UPDATE source_processing_jobs SET status = 'complete', current_stage = 'complete', completed_at = ?, updated_at = ? WHERE packet_id = ?").run(timestamp, timestamp, String(packet.id));
    // Applying a changeset changes the register, so every cached consultant view
    // for this project now describes a state that no longer exists. They are
    // marked stale with a reason and KEPT: nothing regenerates on its own, and a
    // stale brief is still the best reasoning anyone has until someone asks for
    // a new one.
    db.prepare("UPDATE consultant_briefs SET stale = 1, stale_reason = ?, stale_at = ? WHERE project_id = ? AND stale = 0")
      .run(`Changeset ${changesetId} was applied to the register on ${timestamp}, so this view describes a superseded state.`, timestamp, String(changeset.project_id));
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
  const packetJson = String(stored.packet_json);
  // Replay must first prove the artefact is the one that was frozen (C4).
  // Nothing previously compared the stored bytes against the stored hash, so a
  // tampered or corrupted `packet_json` replayed silently while the recorded
  // SHA-256 still asserted the original.
  const storedHash = String(stored.packet_sha256);
  const recomputedHash = hash(packetJson);
  if (recomputedHash !== storedHash) throw new Error(`Stored packet has been altered: recorded SHA-256 ${storedHash} but stored bytes hash to ${recomputedHash}.`);
  const packet = JSON.parse(packetJson) as unknown;
  const validation = validatePacket(db, packet, { mode: 'replay' });
  if (!validation.packet) throw new Error('Stored packet no longer satisfies its recorded contract.');
  // The canonical re-serialisation must also reproduce the frozen bytes, which
  // proves the serialiser itself is still deterministic on this host.
  const canonicalHash = hash(stable(validation.packet));
  if (canonicalHash !== storedHash) throw new Error(`Canonical re-serialisation of the stored packet does not reproduce its frozen hash (${canonicalHash} vs ${storedHash}).`);
  const projectId = String(stored.project_id);
  const ops = deterministicOps(db, projectId, validation.packet);
  const changesetHash = hash(stable({ baseRegisterRevision: validation.packet.base_register_revision, ops, versions: { validator: VALIDATOR_VERSION, reconciliation: RECONCILIATION_VERSION, projector: PROJECTOR_VERSION, scoring: activeScoringVersion(db) } }));
  const registerState = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId);
  const projection = db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId);
  const scores = db.prepare('SELECT * FROM register_row_scores WHERE project_id = ? ORDER BY external_register_id').all(projectId);
  return { packetId, providerCalls: 0, durationMs: Math.round((performance.now() - started) * 1000) / 1000, changesetHash, packetHashVerified: true, registerStateHash: hash(stable(registerState)), projectionHash: hash(stable(projection)), scoresHash: hash(stable(scores)), validationVerdict: validation.verdict, revisionCurrent: validation.revisionCurrent };
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
  // A changeset leads the overview until the consultant acknowledges it (C9).
  // `acknowledged_at` had no writer at all, so the predicate was always true and
  // the overview was permanently latched to `changes` — `meeting` and
  // `needs-warwick` could never be selected again once a project had ever
  // processed a source.
  const latestChangeset = db.prepare("SELECT * FROM register_changesets WHERE project_id = ? AND acknowledged_at IS NULL AND review_status <> 'quarantined' ORDER BY created_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
  const meeting = db.prepare("SELECT external_register_id FROM register_row_state WHERE project_id = ? AND register_name = 'Milestones' AND due_date BETWEEN date('now') AND date('now', '+1 day') LIMIT 1").get(projectId);
  const computedMode = latestChangeset ? 'changes' : meeting ? 'meeting' : 'needs-warwick';
  const leadMode = pin?.mode ?? computedMode;
  const rows = db.prepare(`SELECT r.external_register_id, r.register_name, r.title, r.summary, s.status, s.owner, s.due_date, sc.score, sc.band, sc.inputs_json
    FROM project_register_rows r JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
    JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
    WHERE r.project_id = ? ORDER BY sc.score DESC, r.external_register_id LIMIT 200`).all(projectId) as Array<Record<string, unknown>>;
  const open = rows.filter((row) => !/resolved|closed|complete|superseded|rejected|ratified/i.test(String(row.status)));
  const lenses: Record<string, Array<Record<string, unknown>>> = {
    // Unowned high-priority rows are the consultant's problem by definition;
    // the previous filter dropped every one of them (C10).
    needsWarwick: open.filter((row) => needsConsultantAttention(db, projectId, row.owner, String(row.band))),
    needsCustomer: open.filter((row) => row.owner && !needsConsultantAttention(db, projectId, row.owner, String(row.band))),
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

export function acknowledgeChangeset(db: DatabaseSync, changesetId: string, actor = 'Warwick') {
  const changeset = db.prepare('SELECT project_id, acknowledged_at FROM register_changesets WHERE id = ?').get(changesetId) as { project_id: string; acknowledged_at: string | null } | undefined;
  if (!changeset) throw new Error('Changeset not found.');
  if (!changeset.acknowledged_at) db.prepare('UPDATE register_changesets SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?').run(nowIso(), actor, changesetId);
  return computeProjectOverview(db, String(changeset.project_id));
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
  // Migration 013 widened the cache key to the full identity of what produced a
  // view. This legacy reader is only ever asked for the *deterministic* template,
  // which depends on nothing but the selection, so it looks up the deterministic
  // cache key directly rather than matching any row that happens to share a
  // selection hash — otherwise a model-generated brief would be served from the
  // zero-call path and reported as deterministic.
  const existing = db.prepare('SELECT * FROM consultant_briefs WHERE project_id = ? AND mode = ? AND cache_key = ? AND stale = 0').get(projectId, mode, deterministicCacheKey(selectionHash)) as Record<string, unknown> | undefined;
  return existing ? { id: String(existing.id), selectionHash, briefMarkdown: String(existing.brief_markdown), citations: JSON.parse(String(existing.citations_json)) as string[], generationMode: String(existing.provider_id), stale: false } : null;
}

/** The cache key a deterministic template renders under. Never a provider's. */
function deterministicCacheKey(selectionHash: string): string {
  return `deterministic-template:${selectionHash}`;
}

/** The cache key the legacy grounded-brief route renders under. */
function providerCacheKey(provider: GroundedBriefProvider, selectionHash: string): string {
  return `${provider.identity.providerId}:${provider.identity.modelLabel}:${selectionHash}`;
}

function readCachedBriefByKey(db: DatabaseSync, projectId: string, mode: string, selectionHash: string, cacheKey: string) {
  const existing = db.prepare('SELECT * FROM consultant_briefs WHERE project_id = ? AND mode = ? AND cache_key = ? AND stale = 0').get(projectId, mode, cacheKey) as Record<string, unknown> | undefined;
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
  const id = `brief:${projectId}:${mode}:deterministic:${selectionHash.slice(0, 16)}`;
  db.prepare(`INSERT INTO consultant_briefs (id, project_id, mode, selection_hash, cache_key, brief_markdown, citations_json, selected_ids_json, themes_json, provider_id, model_label, generated_at, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'deterministic-template', NULL, ?, 0)
    ON CONFLICT(project_id, mode, cache_key) DO UPDATE SET brief_markdown = excluded.brief_markdown, citations_json = excluded.citations_json, selected_ids_json = excluded.selected_ids_json, provider_id = excluded.provider_id, generated_at = excluded.generated_at, stale = 0, stale_reason = NULL, stale_at = NULL`)
    .run(id, projectId, mode, selectionHash, deterministicCacheKey(selectionHash), briefMarkdown, JSON.stringify(citations), JSON.stringify(citations), nowIso());
  return { id, selectionHash, briefMarkdown, citations, generationMode: 'deterministic-template', stale: false, selectedRecords: selected };
}

export async function buildConsultantBrief(db: DatabaseSync, projectId: string, mode: string, provider: GroundedBriefProvider) {
  const { selected, selectionHash } = briefContext(db, projectId);
  // Keyed by this provider and model, not by the selection alone: a cached
  // narrative produced by a different model is a different artefact, and serving
  // it under this provider's name would misreport its provenance.
  const existing = readCachedBriefByKey(db, projectId, mode, selectionHash, providerCacheKey(provider, selectionHash));
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
    const id = `brief:${projectId}:${mode}:${provider.identity.providerId}:${selectionHash.slice(0, 16)}`;
    db.prepare(`INSERT INTO consultant_briefs (id, project_id, mode, selection_hash, cache_key, brief_markdown, citations_json, selected_ids_json, themes_json, provider_id, model_label, generated_at, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 0)
      ON CONFLICT(project_id, mode, cache_key) DO UPDATE SET brief_markdown = excluded.brief_markdown, citations_json = excluded.citations_json, selected_ids_json = excluded.selected_ids_json, provider_id = excluded.provider_id, model_label = excluded.model_label, generated_at = excluded.generated_at, stale = 0, stale_reason = NULL, stale_at = NULL`)
      .run(id, projectId, mode, selectionHash, providerCacheKey(provider, selectionHash), validation.markdown, JSON.stringify(citations), JSON.stringify(selected.map((row) => row.id)), provider.identity.providerId, provider.identity.modelLabel, createdAt);
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
// A structural heading names a section; it does not assert anything about the
// project. Anything else in heading position is a claim and must be cited.
const STRUCTURAL_HEADINGS = new Set([
  'needs warwick', 'needs you', 'top risks and issues', 'risks and issues', 'decisions required',
  'blocking questions', 'due next', 'uncertain or conflicting', 'changes since last source',
  'meeting order', 'challenges', 'summary', 'overview', 'actions', 'decisions', 'risks', 'questions',
  'milestones', 'next steps', 'recommended order', 'open questions', 'entities', 'sources', 'uncertainty',
]);

export function isStructuralHeading(line: string): boolean {
  const label = line.replace(/^#{1,6}\s*/, '').replace(/[:.]\s*$/, '').trim().toLowerCase();
  if (STRUCTURAL_HEADINGS.has(label)) return true;
  // A short noun-phrase label with no finite verb and no sentence punctuation is
  // still structural; a sentence is not.
  const words = label.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && !/[.!?;]/.test(label) && !/\b(?:is|are|was|were|has|have|will|must|should|slipped|needs|remains|requires)\b/.test(label);
}

export function validateBriefCitations(markdown: string, selectedIds: string[]) {
  const selected = new Set(selectedIds);
  const kept: string[] = [];
  let factual = 0;
  let removed = 0;
  const invalidCitations = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim()) { kept.push(line); continue; }
    // Headings are exempt only when they are structural section labels (C12).
    // A blanket heading exemption let an entire brief of uncited factual claims
    // render as grounded and verified, because every line began with `##`.
    if (/^#{1,6}\s/.test(line) && isStructuralHeading(line)) { kept.push(line); continue; }
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
