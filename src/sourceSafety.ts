/**
 * Every uploaded transcript as a reversible source transaction.
 *
 * Four governed operations live here, all deterministic and all making ZERO
 * provider calls:
 *
 *   - fingerprint and classify an incoming source, BEFORE anything can reach a
 *     model, so "exact duplicate / possible overlap / apparently new" is
 *     answered at drop time;
 *   - record the human decision about that classification;
 *   - DISCARD a source before its changes are applied — it was never meant to
 *     be here — preserving the file, the hashes and the provenance;
 *   - VOID a source after its changes are applied, removing its contribution
 *     from effective state by REPLAY EXCLUSION rather than by compensating
 *     writes, and never deleting anything.
 *
 * The distinction between discard and the pre-existing "skip because it carries
 * no governance content" operation is deliberate and is not blurred anywhere: a
 * skipped source belonged here and simply had nothing to mine; a discarded
 * source never belonged here at all.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { rebuildProjection } from './registerProjection.js';
import {
  BLOCKING_CLASSIFICATIONS,
  CLASSIFICATION_LABELS,
  canonicalFingerprint,
  chunkFingerprints,
  classifySource,
  type ComparisonCandidate,
  type SourceClassification,
  type SourceComparison,
} from './sourceIdentity.js';

function nowIso(): string {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- *
 * Lifecycle states
 * -------------------------------------------------------------------------- */

export type SourceLifecycleState = 'active' | 'duplicate' | 'wrong-project' | 'wrong-file' | 'discarded' | 'voided';

/** Every state that stops a source contributing anything further. */
export const RETIRED_LIFECYCLE_STATES: readonly SourceLifecycleState[] = ['duplicate', 'wrong-project', 'wrong-file', 'discarded', 'voided'];

/** The four discard outcomes a consultant can choose before application. Each preserves evidence; none mutates register state. */
export const DISCARD_STATES: readonly SourceLifecycleState[] = ['duplicate', 'wrong-project', 'wrong-file', 'discarded'];

export const LIFECYCLE_LABELS: Record<SourceLifecycleState, string> = {
  active: 'Active',
  duplicate: 'Duplicate',
  'wrong-project': 'Wrong project',
  'wrong-file': 'Wrong file',
  discarded: 'Discarded',
  voided: 'Voided',
};

/* -------------------------------------------------------------------------- *
 * Fingerprinting
 * -------------------------------------------------------------------------- */

/**
 * Compute and store the canonical and chunk fingerprints for a normalised
 * source.
 *
 * Idempotent: re-running replaces this source's chunk rows rather than
 * accumulating duplicates, so a retry or a replay cannot inflate an overlap
 * ratio.
 */
export function recordSourceFingerprints(db: DatabaseSync, sourceId: string, projectId: string, text: string): { canonical: string; chunks: string[] } {
  const canonical = canonicalFingerprint(text);
  const chunks = chunkFingerprints(text);
  db.prepare('UPDATE source_documents SET canonical_fingerprint = ? WHERE id = ?').run(canonical, sourceId);
  db.prepare('DELETE FROM source_chunk_fingerprints WHERE source_id = ?').run(sourceId);
  const insert = db.prepare('INSERT INTO source_chunk_fingerprints (id, source_id, project_id, seq, fingerprint) VALUES (?, ?, ?, ?, ?)');
  chunks.forEach((fingerprint, index) => insert.run(randomUUID(), sourceId, projectId, index, fingerprint));
  return { canonical, chunks };
}

/** Record a filename this content has arrived under. The filename is never identity — this exists so a consultant can recognise the file. */
export function recordAlternateName(db: DatabaseSync, sourceId: string, projectId: string, fileName: string): void {
  db.prepare('INSERT OR IGNORE INTO source_alternate_names (id, source_id, project_id, file_name, first_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), sourceId, projectId, fileName, nowIso());
}

/** Every filename this content has been seen under, oldest first. */
export function readAlternateNames(db: DatabaseSync, sourceId: string): Array<{ fileName: string; firstSeenAt: string }> {
  return (db.prepare('SELECT file_name, first_seen_at FROM source_alternate_names WHERE source_id = ? ORDER BY first_seen_at, file_name').all(sourceId) as Array<{ file_name: string; first_seen_at: string }>)
    .map((row) => ({ fileName: String(row.file_name), firstSeenAt: String(row.first_seen_at) }));
}

/* -------------------------------------------------------------------------- *
 * Classification
 * -------------------------------------------------------------------------- */

/**
 * Read every source that a new arrival could be a duplicate of.
 *
 * Deliberately includes retired and voided sources — "you already discarded
 * this" and "you already voided this" are exactly the answers a consultant
 * needs — and deliberately includes OTHER projects, because the same content
 * legitimately relating to two projects is a warning, never an automatic block.
 */
function comparisonCandidates(db: DatabaseSync, excludeSourceId: string | null): ComparisonCandidate[] {
  const rows = db.prepare(`
    SELECT d.id, d.project_id, d.intake_source_id, d.original_file_name, d.content_hash, d.canonical_fingerprint,
           d.lifecycle_state, d.meeting_subject, d.chronology_state, d.confirmed_event_date,
           i.processing_status
      FROM source_documents d
      LEFT JOIN project_source_intake i ON i.id = d.intake_source_id
     ORDER BY d.created_at, d.id`).all() as Array<Record<string, unknown>>;
  const chunkStatement = db.prepare('SELECT fingerprint FROM source_chunk_fingerprints WHERE source_id = ? ORDER BY seq');
  return rows
    .filter((row) => String(row.id) !== excludeSourceId)
    .map((row) => ({
      sourceId: String(row.id),
      projectId: String(row.project_id),
      intakeSourceId: row.intake_source_id ? String(row.intake_source_id) : null,
      fileName: String(row.original_file_name),
      contentHash: String(row.content_hash),
      canonicalFingerprint: row.canonical_fingerprint ? String(row.canonical_fingerprint) : null,
      chunkFingerprints: (chunkStatement.all(String(row.id)) as Array<{ fingerprint: string }>).map((chunk) => String(chunk.fingerprint)),
      lifecycleState: String(row.lifecycle_state ?? 'active'),
      processingStatus: row.processing_status ? String(row.processing_status) : null,
      meetingSubject: row.meeting_subject ? String(row.meeting_subject) : null,
      chronologyLabel: row.chronology_state === 'unknown' || !row.confirmed_event_date ? 'Meeting date unknown' : String(row.confirmed_event_date),
    }));
}

export interface ClassificationResult {
  verdict: SourceComparison;
  matches: SourceComparison[];
  /** True when nothing may reach a provider until a human decides. */
  blocksExtraction: boolean;
  label: string;
}

/**
 * Classify one incoming source and persist the comparison, before any provider
 * call is possible.
 *
 * `intakeSourceId` is the intake row the verdict belongs to; the comparison is
 * stored against it so the Inbox can render the decision the consultant still
 * owes without recomputing anything.
 */
export function classifyAndRecordSource(
  db: DatabaseSync,
  projectId: string,
  intakeSourceId: string,
  input: { fileName: string; contentHash: string; text: string; excludeSourceId?: string | null },
): ClassificationResult {
  const subject = {
    projectId,
    fileName: input.fileName,
    contentHash: input.contentHash,
    canonicalFingerprint: canonicalFingerprint(input.text),
    chunkFingerprints: chunkFingerprints(input.text),
  };
  const { verdict, matches } = classifySource(subject, comparisonCandidates(db, input.excludeSourceId ?? null));
  const timestamp = nowIso();
  db.prepare('DELETE FROM source_comparisons WHERE intake_source_id = ? AND decision IS NULL').run(intakeSourceId);
  const insert = db.prepare('INSERT INTO source_comparisons (id, project_id, intake_source_id, matched_source_id, matched_project_id, classification, raw_hash_match, canonical_match, overlap_ratio, filename_similarity, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Every individual match is stored, not only the strongest verdict, so the
  // Inbox can show the full comparison rather than just its conclusion.
  const stored = matches.length > 0 ? matches : [verdict];
  for (const match of stored) {
    insert.run(randomUUID(), projectId, intakeSourceId, match.matchedSourceId, match.matchedProjectId, match.classification,
      match.rawHashMatch ? 1 : 0, match.canonicalMatch ? 1 : 0, match.overlapRatio, match.filenameSimilarity,
      JSON.stringify({ detail: match.detail, fileName: input.fileName, blocksExtraction: match.blocksExtraction, requiresDecision: match.requiresDecision }), timestamp);
  }
  return {
    verdict, matches,
    blocksExtraction: BLOCKING_CLASSIFICATIONS.includes(verdict.classification),
    label: CLASSIFICATION_LABELS[verdict.classification],
  };
}

export interface StoredComparison {
  id: string;
  classification: SourceClassification;
  label: string;
  matchedSourceId: string | null;
  matchedProjectId: string | null;
  matchedFileName: string | null;
  matchedMeetingSubject: string | null;
  matchedChronology: string | null;
  matchedLifecycleState: string | null;
  matchedProcessingStatus: string | null;
  rawHashMatch: boolean;
  canonicalMatch: boolean;
  overlapRatio: number;
  filenameSimilarity: number;
  detail: string;
  incomingFileName: string | null;
  blocksExtraction: boolean;
  requiresDecision: boolean;
  createdAt: string;
  decision: string | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** Everything the Inbox needs to show the comparison, including the matched source's own identity. */
export function readSourceComparisons(db: DatabaseSync, intakeSourceId: string): StoredComparison[] {
  const rows = db.prepare(`
    SELECT c.*, d.original_file_name, d.meeting_subject, d.chronology_state, d.confirmed_event_date, d.lifecycle_state,
           i.processing_status
      FROM source_comparisons c
      LEFT JOIN source_documents d ON d.id = c.matched_source_id
      LEFT JOIN project_source_intake i ON i.id = d.intake_source_id
     WHERE c.intake_source_id = ?
     ORDER BY c.created_at DESC, c.overlap_ratio DESC`).all(intakeSourceId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const detail = JSON.parse(String(row.detail_json ?? '{}')) as { detail?: string; fileName?: string; blocksExtraction?: boolean; requiresDecision?: boolean };
    const classification = String(row.classification) as SourceClassification;
    return {
      id: String(row.id),
      classification,
      label: CLASSIFICATION_LABELS[classification] ?? classification,
      matchedSourceId: row.matched_source_id ? String(row.matched_source_id) : null,
      matchedProjectId: row.matched_project_id ? String(row.matched_project_id) : null,
      matchedFileName: row.original_file_name ? String(row.original_file_name) : null,
      matchedMeetingSubject: row.meeting_subject ? String(row.meeting_subject) : null,
      matchedChronology: row.matched_source_id ? (row.chronology_state === 'unknown' || !row.confirmed_event_date ? 'Meeting date unknown' : String(row.confirmed_event_date)) : null,
      matchedLifecycleState: row.lifecycle_state ? String(row.lifecycle_state) : null,
      matchedProcessingStatus: row.processing_status ? String(row.processing_status) : null,
      rawHashMatch: Number(row.raw_hash_match) === 1,
      canonicalMatch: Number(row.canonical_match) === 1,
      overlapRatio: Number(row.overlap_ratio),
      filenameSimilarity: Number(row.filename_similarity),
      detail: detail.detail ?? '',
      incomingFileName: detail.fileName ?? null,
      blocksExtraction: Boolean(detail.blocksExtraction),
      requiresDecision: Boolean(detail.requiresDecision),
      createdAt: String(row.created_at),
      decision: row.decision ? String(row.decision) : null,
      decisionReason: row.decision_reason ? String(row.decision_reason) : null,
      decidedBy: row.decided_by ? String(row.decided_by) : null,
      decidedAt: row.decided_at ? String(row.decided_at) : null,
    };
  });
}

/**
 * Is this source still waiting on a human duplicate decision?
 *
 * The extraction gate consults this, so a blocking classification stops the
 * pipeline in exactly one place rather than at each of the three call sites.
 */
export function pendingDuplicateDecision(db: DatabaseSync, intakeSourceId: string): StoredComparison | null {
  const comparisons = readSourceComparisons(db, intakeSourceId);
  return comparisons.find((row) => row.decision === null && (row.blocksExtraction || row.requiresDecision)) ?? null;
}

export type ComparisonDecision = 'retain-as-new' | 'mark-duplicate' | 'mark-wrong-project' | 'mark-wrong-file' | 'discard';

const DECISION_TO_STATE: Record<ComparisonDecision, SourceLifecycleState | null> = {
  'retain-as-new': null,
  'mark-duplicate': 'duplicate',
  'mark-wrong-project': 'wrong-project',
  'mark-wrong-file': 'wrong-file',
  discard: 'discarded',
};

/**
 * Record what the consultant decided about a comparison.
 *
 * `retain-as-new` clears the hold and lets the source proceed. Every other
 * decision retires the source through the same governed discard path, so a
 * duplicate marked from the Inbox and a source discarded from its detail panel
 * produce identical, equally auditable records.
 */
export function decideSourceComparison(
  db: DatabaseSync,
  projectId: string,
  idOrIntakeId: string,
  input: { decision: ComparisonDecision; actor: string; reason: string },
): { decision: ComparisonDecision; lifecycleState: SourceLifecycleState } {
  // Accepts either id, like every other source-facing route: the Inbox holds
  // the intake id, the source detail panel holds the document id.
  const resolved = resolveSource(db, idOrIntakeId);
  const intakeSourceId = resolved?.intake_source_id ? String(resolved.intake_source_id) : idOrIntakeId;
  const actor = input.actor?.trim();
  const reason = input.reason?.trim();
  if (!actor) throw new Error('Deciding a duplicate comparison requires a named actor.');
  if (!reason) throw new Error('Deciding a duplicate comparison requires an explicit reason.');
  if (!Object.hasOwn(DECISION_TO_STATE, input.decision)) throw new Error(`Unknown comparison decision "${input.decision}".`);
  const timestamp = nowIso();
  db.prepare('UPDATE source_comparisons SET decision = ?, decision_reason = ?, decided_by = ?, decided_at = ? WHERE intake_source_id = ? AND decision IS NULL')
    .run(input.decision, reason, actor, timestamp, intakeSourceId);

  const nextState = DECISION_TO_STATE[input.decision];
  if (nextState === null) {
    const source = db.prepare('SELECT id FROM source_documents WHERE intake_source_id = ?').get(intakeSourceId) as { id: string } | undefined;
    if (source) {
      appendLifecycleEvent(db, String(source.id), projectId, {
        actor, eventType: 'retain-as-new', previousState: 'active', newState: 'active', reason,
        detail: { intakeSourceId },
      });
    }
    return { decision: input.decision, lifecycleState: 'active' };
  }
  discardSource(db, projectId, intakeSourceId, { actor, reason, state: nextState });
  return { decision: input.decision, lifecycleState: nextState };
}

/* -------------------------------------------------------------------------- *
 * Lifecycle log
 * -------------------------------------------------------------------------- */

function appendLifecycleEvent(
  db: DatabaseSync,
  sourceId: string,
  projectId: string,
  input: { actor: string; eventType: string; previousState: string; newState: string; reason: string; detail?: Record<string, unknown> },
): void {
  db.prepare('INSERT INTO source_lifecycle_events (id, source_id, project_id, occurred_at, actor, event_type, previous_state, new_state, reason, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), sourceId, projectId, nowIso(), input.actor, input.eventType, input.previousState, input.newState, input.reason, JSON.stringify(input.detail ?? {}));
}

export interface LifecycleEvent {
  id: string;
  occurredAt: string;
  actor: string;
  eventType: string;
  previousState: string;
  newState: string;
  reason: string;
  detail: Record<string, unknown>;
}

/** The full, append-only lifecycle history of one source, oldest first. */
export function readSourceLifecycle(db: DatabaseSync, sourceId: string): LifecycleEvent[] {
  return (db.prepare('SELECT * FROM source_lifecycle_events WHERE source_id = ? ORDER BY occurred_at, id').all(sourceId) as Array<Record<string, unknown>>)
    .map((row) => ({
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      actor: String(row.actor),
      eventType: String(row.event_type),
      previousState: String(row.previous_state),
      newState: String(row.new_state),
      reason: String(row.reason),
      detail: JSON.parse(String(row.detail_json ?? '{}')) as Record<string, unknown>,
    }));
}

/** Resolve either a `source_documents.id` or a `project_source_intake.id` to the source row, as every other source-facing route does. */
function resolveSource(db: DatabaseSync, idOrIntakeId: string): Record<string, unknown> | undefined {
  const direct = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(idOrIntakeId) as Record<string, unknown> | undefined;
  if (direct) return direct;
  return db.prepare('SELECT * FROM source_documents WHERE intake_source_id = ? LIMIT 1').get(idOrIntakeId) as Record<string, unknown> | undefined;
}

/* -------------------------------------------------------------------------- *
 * 3. Discard, before application
 * -------------------------------------------------------------------------- */

export interface DiscardInput {
  actor: string;
  reason: string;
  state: SourceLifecycleState;
}

/**
 * Retire a source that should never have been processed.
 *
 * Preserves the immutable file, both content hashes, the chunk fingerprints and
 * every provenance record. Records actor, time and a mandatory reason. Prevents
 * extraction where it has not run, and prevents review or application where
 * proposals already exist. Creates NO register-state mutation and makes ZERO
 * provider calls.
 *
 * Refuses outright once a changeset has been applied: at that point the source
 * has already changed project state and the correct, governed operation is
 * `voidSource`, which knows how to remove that contribution safely.
 */
export function discardSource(db: DatabaseSync, projectId: string, idOrIntakeId: string, input: DiscardInput) {
  const actor = input.actor?.trim();
  const reason = input.reason?.trim();
  if (!actor) throw new Error('Discarding a source requires a named actor.');
  if (!reason) throw new Error('Discarding a source requires an explicit reason.');
  if (!DISCARD_STATES.includes(input.state)) throw new Error(`"${input.state}" is not a discard state. Use one of: ${DISCARD_STATES.join(', ')}.`);

  const source = resolveSource(db, idOrIntakeId);
  if (!source || String(source.project_id) !== projectId) throw new Error('Source not found.');
  const sourceId = String(source.id);
  const previousState = String(source.lifecycle_state ?? 'active');
  if (previousState === 'voided') throw new Error('This source has already been voided; a voided source cannot also be discarded.');
  if (RETIRED_LIFECYCLE_STATES.includes(previousState as SourceLifecycleState)) {
    throw new Error(`This source is already retired as "${LIFECYCLE_LABELS[previousState as SourceLifecycleState] ?? previousState}".`);
  }

  const applied = db.prepare("SELECT id FROM register_changesets WHERE source_id = ? AND review_status = 'applied' AND voided_at IS NULL").all(sourceId) as Array<{ id: string }>;
  if (applied.length > 0) {
    throw new Error(`This source has already been applied to the register (changeset ${applied[0].id}). Discarding would leave its changes in place; use Void source instead, which removes its contribution from effective state.`);
  }

  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    appendLifecycleEvent(db, sourceId, projectId, {
      actor, eventType: input.state === 'discarded' ? 'discard' : `mark-${input.state}`,
      previousState, newState: input.state, reason,
      detail: { intakeSourceId: source.intake_source_id ?? null, contentHash: source.content_hash ?? null },
    });
    db.prepare('UPDATE source_documents SET lifecycle_state = ?, lifecycle_reason = ?, lifecycle_actor = ?, lifecycle_at = ? WHERE id = ?')
      .run(input.state, reason, actor, timestamp, sourceId);
    if (source.intake_source_id) {
      // `processing_status` becomes `rejected` so every existing Inbox lane and
      // gate that already reads it treats the source as finished, while
      // `lifecycle_state` carries WHY. Nothing that reads the old column needs
      // to learn about the new one to behave correctly.
      db.prepare("UPDATE project_source_intake SET lifecycle_state = ?, processing_status = 'rejected', review_state = 'rejected', updated_at = ? WHERE id = ?")
        .run(input.state, timestamp, String(source.intake_source_id));
    }
    // Any changeset this source proposed but that was never applied is closed
    // off, so it can no longer be reviewed or applied. The packet, the raw
    // provider response and every operation are retained untouched.
    db.prepare("UPDATE register_changesets SET review_status = 'rejected' WHERE source_id = ? AND review_status IN ('pending', 'ready-to-apply', 'quarantined')").run(sourceId);
    db.prepare("UPDATE source_processing_jobs SET status = 'cancelled', current_stage = 'cancelled', updated_at = ? WHERE source_id IN (?, ?) AND status NOT IN ('complete', 'cancelled')")
      .run(timestamp, sourceId, String(source.intake_source_id ?? sourceId));
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'human', `Source ${source.original_file_name} was marked ${LIFECYCLE_LABELS[input.state]}: ${reason}`, actor, 'source', sourceId, 'operational-reference');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { sourceId, lifecycleState: input.state, previousState, discardedAt: timestamp, providerCalls: 0 };
}

/* -------------------------------------------------------------------------- *
 * 4. Void, after application
 * -------------------------------------------------------------------------- */

export interface VoidResult {
  sourceId: string;
  voidedAt: string;
  voidedChangesets: string[];
  excludedEvents: number;
  rowsOrphaned: string[];
  rowsRetainedForReview: string[];
  rowsFlaggedForRelationshipReview: string[];
  reasoningMarkedStale: number;
  providerCalls: 0;
}

/**
 * Remove a source's contribution from effective project state, reversibly and
 * without destroying anything.
 *
 * The source is the rollback boundary. Voiding:
 *
 *  - appends an immutable void event with actor, time and mandatory reason;
 *  - retains all raw evidence, extraction packets, raw provider responses,
 *    changesets, operations and review decisions;
 *  - marks the source and its applied changesets void;
 *  - rebuilds effective state EXCLUDING only register events whose origin is
 *    `source` and whose `source_id` is this source;
 *  - retains human events and every other source's events;
 *  - uses no compensating field writes, so it cannot overwrite a later valid
 *    source or a human update;
 *  - never deletes a historical record and never reuses a retired identifier;
 *  - marks Consultant Reasoning stale;
 *  - makes zero AI calls.
 *
 * The dependency rule for rows the voided source founded is implemented in
 * `rebuildProjection`/`voidDispositionFor`, because it is a property of the
 * replay rather than of this transaction.
 */
export function voidSource(db: DatabaseSync, projectId: string, idOrIntakeId: string, input: { actor: string; reason: string }): VoidResult {
  const actor = input.actor?.trim();
  const reason = input.reason?.trim();
  if (!actor) throw new Error('Voiding a source requires a named actor.');
  if (!reason) throw new Error('Voiding a source requires an explicit reason.');

  const source = resolveSource(db, idOrIntakeId);
  if (!source || String(source.project_id) !== projectId) throw new Error('Source not found.');
  const sourceId = String(source.id);
  const previousState = String(source.lifecycle_state ?? 'active');
  if (previousState === 'voided') throw new Error('This source has already been voided.');

  const excludedEvents = Number((db.prepare("SELECT count(*) count FROM register_row_events WHERE project_id = ? AND origin = 'source' AND source_id = ?").get(projectId, sourceId) as { count: number }).count);
  const changesets = (db.prepare("SELECT id FROM register_changesets WHERE source_id = ? AND review_status = 'applied'").all(sourceId) as Array<{ id: string }>).map((row) => String(row.id));
  const timestamp = nowIso();

  db.exec('BEGIN IMMEDIATE;');
  try {
    appendLifecycleEvent(db, sourceId, projectId, {
      actor, eventType: 'void', previousState, newState: 'voided', reason,
      detail: { changesets, excludedEvents, contentHash: source.content_hash ?? null },
    });
    db.prepare('UPDATE source_documents SET lifecycle_state = \'voided\', lifecycle_reason = ?, lifecycle_actor = ?, lifecycle_at = ? WHERE id = ?')
      .run(reason, actor, timestamp, sourceId);
    if (source.intake_source_id) {
      db.prepare("UPDATE project_source_intake SET lifecycle_state = 'voided', updated_at = ? WHERE id = ?").run(timestamp, String(source.intake_source_id));
    }
    // Marked, never deleted: the changeset, its packet, its operations and the
    // preserved raw provider response all remain exactly as they were. The void
    // changes what is REPLAYED, not what happened.
    db.prepare('UPDATE register_changesets SET voided_at = ?, voided_by = ?, void_reason = ? WHERE source_id = ? AND review_status = \'applied\'')
      .run(timestamp, actor, reason, sourceId);
    // Deterministic replay with the voided source's own events excluded. No
    // compensating write is issued anywhere: state is recomputed, not patched.
    rebuildProjection(db, projectId, timestamp);
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'human', `Source ${source.original_file_name} was voided and its contribution removed from effective state: ${reason}`, actor, 'source', sourceId, 'operational-reference');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  // Cached reasoning now describes a state that no longer exists. Marked stale
  // with a reason and KEPT — nothing regenerates on its own, and no provider is
  // called here or anywhere else in this function.
  const staleReason = `Source ${sourceId} was voided on ${timestamp}, so this view describes a superseded state.`;
  const briefs = db.prepare('UPDATE consultant_briefs SET stale = 1, stale_reason = ?, stale_at = ? WHERE project_id = ? AND stale = 0').run(staleReason, timestamp, projectId);
  let reasoningMarkedStale = Number(briefs.changes ?? 0);
  try {
    const reasoning = db.prepare("UPDATE consultant_reasoning_results SET state = 'stale', stale_reason = ?, stale_at = ? WHERE project_id = ? AND state = 'current'").run(staleReason, timestamp, projectId);
    reasoningMarkedStale += Number(reasoning.changes ?? 0);
  } catch {
    // The reasoning cache derives staleness from the project state hash it
    // reasoned over, which the replay above has already moved. An older schema
    // without these columns is therefore already correct, not broken.
  }

  const flagged = db.prepare('SELECT external_register_id, effective, review_flag FROM register_row_state WHERE project_id = ? AND review_flag IS NOT NULL ORDER BY external_register_id').all(projectId) as Array<{ external_register_id: string; effective: number; review_flag: string }>;
  return {
    sourceId,
    voidedAt: timestamp,
    voidedChangesets: changesets,
    excludedEvents,
    rowsOrphaned: flagged.filter((row) => Number(row.effective) === 0).map((row) => String(row.external_register_id)),
    rowsRetainedForReview: flagged.filter((row) => Number(row.effective) === 1 && row.review_flag === 'founding-source-voided').map((row) => String(row.external_register_id)),
    rowsFlaggedForRelationshipReview: flagged.filter((row) => row.review_flag === 'relationship-review').map((row) => String(row.external_register_id)),
    reasoningMarkedStale,
    providerCalls: 0,
  };
}

/* -------------------------------------------------------------------------- *
 * Source detail
 * -------------------------------------------------------------------------- */

/** Read the immutable source file's text, for re-fingerprinting an existing source that predates migration 017. */
export function readSourceText(immutablePath: string): string {
  return readFileSync(immutablePath, 'utf8');
}

/** SHA-256 of arbitrary bytes, so callers do not each reimplement it. */
export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SourceSafetyRecord {
  sourceId: string;
  intakeSourceId: string | null;
  projectId: string;
  fileName: string;
  alternateNames: Array<{ fileName: string; firstSeenAt: string }>;
  contentHash: string;
  canonicalFingerprint: string | null;
  chunkCount: number;
  immutablePath: string | null;
  lifecycleState: SourceLifecycleState;
  lifecycleLabel: string;
  lifecycleReason: string | null;
  lifecycleActor: string | null;
  lifecycleAt: string | null;
  duplicateOfSourceId: string | null;
  comparisons: StoredComparison[];
  pendingDecision: StoredComparison | null;
  lifecycleHistory: LifecycleEvent[];
  changesets: Array<{ id: string; reviewStatus: string; appliedAt: string | null; voidedAt: string | null; gateVerdict: string }>;
  extractionRuns: Array<{ id: string; status: string; providerId: string; startedAt: string; inputTokens: number; outputTokens: number }>;
  affectedRows: Array<{ externalRegisterId: string; registerName: string; title: string; effective: boolean; reviewFlag: string | null; reviewDetail: string | null }>;
  canDiscard: boolean;
  canVoid: boolean;
}

/** Everything the source detail panel shows, in one read. Makes no provider call and mutates nothing. */
export function readSourceSafety(db: DatabaseSync, projectId: string, idOrIntakeId: string): SourceSafetyRecord | null {
  const source = resolveSource(db, idOrIntakeId);
  if (!source || String(source.project_id) !== projectId) return null;
  const sourceId = String(source.id);
  const intakeSourceId = source.intake_source_id ? String(source.intake_source_id) : null;
  const lifecycleState = String(source.lifecycle_state ?? 'active') as SourceLifecycleState;
  const comparisons = intakeSourceId ? readSourceComparisons(db, intakeSourceId) : [];
  const changesets = (db.prepare('SELECT id, review_status, applied_at, voided_at, gate_verdict FROM register_changesets WHERE source_id = ? ORDER BY created_at').all(sourceId) as Array<Record<string, unknown>>)
    .map((row) => ({ id: String(row.id), reviewStatus: String(row.review_status), appliedAt: row.applied_at ? String(row.applied_at) : null, voidedAt: row.voided_at ? String(row.voided_at) : null, gateVerdict: String(row.gate_verdict) }));
  const affectedRows = (db.prepare(`
    SELECT r.external_register_id, r.register_name, r.title, s.effective, s.review_flag, s.review_detail
      FROM project_register_rows r
      LEFT JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
     WHERE r.project_id = ?
       AND (r.source_id = ? OR r.first_seen_source_id = ? OR r.last_updated_source_id = ?
            OR EXISTS (SELECT 1 FROM register_row_anchors a WHERE a.project_id = r.project_id AND a.external_register_id = r.external_register_id AND a.source_id = ?))
     ORDER BY r.register_name, r.external_register_id`).all(projectId, sourceId, sourceId, sourceId, sourceId) as Array<Record<string, unknown>>)
    .map((row) => ({
      externalRegisterId: String(row.external_register_id),
      registerName: String(row.register_name),
      title: String(row.title),
      effective: row.effective === null || row.effective === undefined ? true : Number(row.effective) === 1,
      reviewFlag: row.review_flag ? String(row.review_flag) : null,
      reviewDetail: row.review_detail ? String(row.review_detail) : null,
    }));
  const hasAppliedChangeset = changesets.some((row) => row.reviewStatus === 'applied' && row.voidedAt === null);
  return {
    sourceId, intakeSourceId, projectId,
    fileName: String(source.original_file_name),
    alternateNames: readAlternateNames(db, sourceId),
    contentHash: String(source.content_hash),
    canonicalFingerprint: source.canonical_fingerprint ? String(source.canonical_fingerprint) : null,
    chunkCount: Number((db.prepare('SELECT count(*) count FROM source_chunk_fingerprints WHERE source_id = ?').get(sourceId) as { count: number }).count),
    immutablePath: source.immutable_path ? String(source.immutable_path) : null,
    lifecycleState,
    lifecycleLabel: LIFECYCLE_LABELS[lifecycleState] ?? lifecycleState,
    lifecycleReason: source.lifecycle_reason ? String(source.lifecycle_reason) : null,
    lifecycleActor: source.lifecycle_actor ? String(source.lifecycle_actor) : null,
    lifecycleAt: source.lifecycle_at ? String(source.lifecycle_at) : null,
    duplicateOfSourceId: source.duplicate_of_source_id ? String(source.duplicate_of_source_id) : null,
    comparisons,
    pendingDecision: intakeSourceId ? pendingDuplicateDecision(db, intakeSourceId) : null,
    lifecycleHistory: readSourceLifecycle(db, sourceId),
    changesets,
    extractionRuns: (db.prepare('SELECT id, status, provider_id, started_at, input_tokens, output_tokens FROM extraction_runs WHERE source_id = ? ORDER BY started_at').all(sourceId) as Array<Record<string, unknown>>)
      .map((row) => ({ id: String(row.id), status: String(row.status), providerId: String(row.provider_id), startedAt: String(row.started_at), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) })),
    affectedRows,
    // Discard is only offered while nothing has been applied; after that the
    // correct governed action is Void, and offering both would invite the
    // consultant to choose the one that silently leaves changes in place.
    canDiscard: lifecycleState === 'active' && !hasAppliedChangeset,
    canVoid: lifecycleState !== 'voided' && hasAppliedChangeset,
  };
}
