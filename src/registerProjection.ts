import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveDate } from './dateResolution.js';

export const PROJECTOR_VERSION = 'current-state-projector-v1';

/**
 * C18 — the scoring version actually in force.
 *
 * This used to be a hardcoded literal while `scoring_config` was dead data.
 * It is now a live binding: every read of the active configuration updates it,
 * so anything that records it as a replay determinant records the version that
 * really produced the scores. The initial value is only a placeholder for the
 * window before the first configuration read; no scoring path ever uses it,
 * because `readActiveScoringConfig` throws when there is no active row.
 *
 * Callers that record the version as provenance for a *specific* database
 * (packet freeze, changeset hashing) should prefer `activeScoringVersion(db)`,
 * which is exact rather than last-read.
 */
export let SCORING_VERSION = 'source-intelligence-score-v2';

const registerNames = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'] as const;
type RegisterName = typeof registerNames[number];
type JsonObject = Record<string, unknown>;

/**
 * The only clock read in this module. It supplies the default *as-of* instant
 * when a caller does not pin one; every time-dependent computation downstream
 * derives from that explicit value and never from the wall clock (C5).
 */
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

/* -------------------------------------------------------------------------- *
 * C11 — the canonical value pair.
 *
 * One serialisation function and one normalisation function, used by every
 * writer of `project_register_row_fields` / `*_row_json`. The import path and
 * the extraction pipeline previously had independent implementations that
 * disagreed on arrays (`"a,b"` vs `"a; b"`) and catastrophically on objects
 * (`String({}) === '[object Object]'`), which silently turned every
 * pipeline-touched row into a parity mismatch for reasons unrelated to content.
 *
 * `canonicalValueJson` round-trips through `JSON.parse` and is key-order
 * stable (code-unit order, not `localeCompare`, so it does not depend on the
 * host's ICU locale). `canonicalNormalizedValue` reproduces the behaviour the
 * import path has always had, so the frozen field-level parity figure is
 * preserved.
 * -------------------------------------------------------------------------- */

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as JsonObject;
    const result: JsonObject = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) result[key] = canonicalize(source[key]);
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/** Canonical, round-trippable JSON for one field value. `undefined` becomes `null`. */
export function canonicalValueJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(canonicalText).filter(Boolean).join('; ');
  if (typeof value === 'object') return canonicalValueJson(value);
  return String(value).trim();
}

/** Canonical comparison key for one field value: whitespace-collapsed, lower-cased. */
export function canonicalNormalizedValue(value: unknown): string {
  return canonicalText(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Canonical JSON for a whole register row (`raw_row_json`). */
export function canonicalRowJson(row: JsonObject): string {
  return canonicalValueJson(row);
}

/** Canonical JSON for the normalised projection of a row (`normalized_row_json`). */
export function canonicalNormalizedRowJson(row: JsonObject): string {
  return canonicalValueJson(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, canonicalNormalizedValue(value)])));
}

/* -------------------------------------------------------------------------- *
 * C18 — scoring configuration.
 * -------------------------------------------------------------------------- */

export interface ScoringWeights {
  register: Record<string, number>;
  severity: Record<string, number>;
  likelihood: Record<string, number>;
  blocking: number;
  urgency: { overdue: number; threeDays: number; sevenDays: number; fourteenDays: number };
  ownership: { consultant: number; customer: number };
  latestSource: number;
  supersession: number;
  conflict: number;
  uncertainty: number;
  staleness: number;
  stalenessDays: number;
  closure: number;
  bands: { now: number; soon: number; watch: number };
}

export interface ScoringConfig {
  version: string;
  weights: ScoringWeights;
}

function configError(version: string, detail: string): Error {
  return new Error(`Scoring configuration ${version} is unusable: ${detail}. Fix scoring_config before projecting; the projector will not fall back to hardcoded weights.`);
}

function requireNumber(version: string, source: JsonObject, path: string): number {
  const value = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as JsonObject)[key] : undefined), source);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw configError(version, `${path} must be a finite number`);
  return value;
}

function requireNumberMap(version: string, source: JsonObject, path: string, keys: readonly string[]): Record<string, number> {
  const value = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as JsonObject)[key] : undefined), source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError(version, `${path} must be an object of numeric weights`);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw configError(version, `${path}.${key} must be a finite number`);
    result[key] = entry;
  }
  for (const key of keys) if (!(key in result)) throw configError(version, `${path}.${key} is missing`);
  return result;
}

/**
 * Reads the single active row from `scoring_config` and parses it into the
 * weights the projector uses. Fails loudly when there is no active row, when
 * more than one row claims to be active (which would make scores depend on row
 * order), or when the payload is missing any weight the scorer needs.
 */
export function readActiveScoringConfig(db: DatabaseSync): ScoringConfig {
  const rows = db.prepare('SELECT version, weights_json FROM scoring_config WHERE active = 1').all() as Array<{ version: string; weights_json: string }>;
  if (rows.length === 0) throw new Error('No active scoring_config row: importance scoring cannot run. Seed a configuration and set active = 1 rather than scoring against hardcoded weights.');
  if (rows.length > 1) throw new Error(`Ambiguous scoring configuration: ${rows.length} rows in scoring_config are active (${rows.map((row) => row.version).join(', ')}). Exactly one must be active.`);
  const version = String(rows[0].version);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(rows[0].weights_json)) as unknown;
  } catch {
    throw configError(version, 'weights_json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw configError(version, 'weights_json must be a JSON object');
  const source = parsed as JsonObject;
  const weights: ScoringWeights = {
    register: requireNumberMap(version, source, 'register', registerNames),
    severity: requireNumberMap(version, source, 'severity', ['critical', 'high', 'medium', 'low']),
    likelihood: requireNumberMap(version, source, 'likelihood', ['almost-certain', 'likely', 'possible', 'unlikely']),
    blocking: requireNumber(version, source, 'blocking'),
    urgency: {
      overdue: requireNumber(version, source, 'urgency.overdue'),
      threeDays: requireNumber(version, source, 'urgency.threeDays'),
      sevenDays: requireNumber(version, source, 'urgency.sevenDays'),
      fourteenDays: requireNumber(version, source, 'urgency.fourteenDays'),
    },
    ownership: {
      consultant: requireNumber(version, source, 'ownership.consultant'),
      customer: requireNumber(version, source, 'ownership.customer'),
    },
    latestSource: requireNumber(version, source, 'latestSource'),
    supersession: requireNumber(version, source, 'supersession'),
    conflict: requireNumber(version, source, 'conflict'),
    uncertainty: requireNumber(version, source, 'uncertainty'),
    staleness: requireNumber(version, source, 'staleness'),
    stalenessDays: requireNumber(version, source, 'stalenessDays'),
    closure: requireNumber(version, source, 'closure'),
    bands: {
      now: requireNumber(version, source, 'bands.now'),
      soon: requireNumber(version, source, 'bands.soon'),
      watch: requireNumber(version, source, 'bands.watch'),
    },
  };
  if (weights.stalenessDays <= 0) throw configError(version, 'stalenessDays must be greater than zero');
  if (!(weights.bands.now >= weights.bands.soon && weights.bands.soon >= weights.bands.watch)) throw configError(version, 'bands must be ordered now >= soon >= watch');
  SCORING_VERSION = version;
  return { version, weights };
}

/** The version of the active scoring configuration in this database. */
export function activeScoringVersion(db: DatabaseSync): string {
  return readActiveScoringConfig(db).version;
}

/* -------------------------------------------------------------------------- *
 * C10 — ownership.
 *
 * Decision: NULL is the single representation of "nobody owns this" in every
 * derived layer this module writes (`register_row_state.owner`, score inputs,
 * attention). The literal `'Unassigned'` survives only in the operational
 * tables, whose `owner` columns are `NOT NULL`, and is recognised as unowned
 * wherever ownership is interpreted. The UI already renders a null owner as
 * "Unassigned", so the sentinel is presentation, never meaning.
 * -------------------------------------------------------------------------- */

export const UNASSIGNED_OWNER = 'Unassigned';

const unownedTokens = new Set(['', '-', '--', 'n/a', 'na', 'none', 'nobody', 'no owner', 'not assigned', 'not yet assigned', 'not stated', 'tbc', 'tbd', 'unassigned', 'unowned', 'unknown']);

/** True when an owner value carries no real owner, including the `'Unassigned'` sentinel. */
export function isUnownedOwner(owner: unknown): boolean {
  return unownedTokens.has(normalized(owner).replace(/[.!]+$/, ''));
}

/** The owner value to store, or null when nobody owns the record. */
function ownerOrNull(owner: unknown): string | null {
  const value = text(owner);
  return value && !isUnownedOwner(value) ? value : null;
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
  if (!candidate || isUnownedOwner(candidate)) return false;
  const project = db.prepare('SELECT owner FROM projects WHERE id = ?').get(projectId) as { owner: string | null } | undefined;
  const configuredOwner = normalized(project?.owner);
  return candidate === 'consultant' || candidate.includes('implementation consultant') || Boolean(configuredOwner && candidate === configuredOwner);
}

/**
 * C10 — a `Now`/`Soon` record reaches the consultant's queue when the
 * consultant owns it *or when nobody does*. An unowned high-priority record is
 * the single most important thing to surface, and was the case the previous
 * predicate could never see.
 */
export function needsConsultantAttention(db: DatabaseSync, projectId: string, owner: unknown, band: string): boolean {
  if (!['Now', 'Soon'].includes(band)) return false;
  return isUnownedOwner(owner) || isProjectConsultantOwner(db, projectId, owner);
}

/* -------------------------------------------------------------------------- *
 * N2 — the typed-detail tables, and which of their columns a human may correct.
 *
 * Every register that carries typed detail has exactly one detail table keyed by
 * `project_register_rows.id`. The map is the single place that association is
 * written down; `readTypedDetails` and the human-correction replay below both
 * read it, so the two can never disagree about where a field lives.
 * -------------------------------------------------------------------------- */

const detailTableFor: Record<RegisterName, string | null> = {
  Decisions: 'register_decision_details',
  Actions: null,
  Risks_Issues: 'register_risk_issue_details',
  Config_Changes: 'register_config_change_details',
  Open_Questions: 'register_open_question_details',
  Milestones: 'register_milestone_details',
  Entities: 'register_entities',
  Sources: null,
  Uncertainty: 'register_uncertainty',
};

/** Columns that identify the row rather than describe it. Never correctable. */
const DETAIL_IDENTITY_COLUMNS = new Set(['register_row_id', 'project_id', 'external_register_id']);

interface DetailColumn { name: string; integer: boolean; notNull: boolean }

const detailColumnCache = new Map<string, Map<string, DetailColumn>>();

/**
 * The correctable columns of one detail table, discovered from the schema
 * rather than restated here, so a migration that adds a typed field makes that
 * field correctable without a second edit that someone can forget.
 *
 * `*_json` columns are excluded: they hold structured values (`aliases_json`)
 * that a single `new_value` string cannot express unambiguously, and quietly
 * accepting a string for them would recreate the very failure this fixes.
 */
function detailColumns(db: DatabaseSync, table: string): Map<string, DetailColumn> {
  const cached = detailColumnCache.get(table);
  if (cached) return cached;
  const columns = new Map<string, DetailColumn>();
  for (const info of db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>) {
    const name = String(info.name);
    if (DETAIL_IDENTITY_COLUMNS.has(name) || name.endsWith('_json')) continue;
    columns.set(name, { name, integer: String(info.type ?? '').toUpperCase().includes('INT'), notNull: Number(info.notnull ?? 0) === 1 });
  }
  // An empty result means the table is not present in this database yet; do not
  // cache that, or the first read would poison every later one.
  if (columns.size > 0) detailColumnCache.set(table, columns);
  return columns;
}

export function readTypedDetails(db: DatabaseSync, registerName: string, rowId: string): JsonObject {
  const table = detailTableFor[registerName as RegisterName] ?? null;
  if (!table) return {};
  const source = db.prepare(`SELECT * FROM ${table} WHERE register_row_id = ?`).get(rowId) as JsonObject | undefined;
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

/**
 * C6 — deterministic event order.
 *
 * `ORDER BY occurred_at, id` was a random total order whenever two events
 * shared a timestamp, because `id` is a `randomUUID()`. `server.ts` passes a
 * client-supplied `occurredAt` straight through, so equal timestamps are
 * trivially reachable and the projected state depended on which UUID sorted
 * first.
 *
 * The tiebreak is `rowid`. `register_row_events` is an ordinary rowid table
 * (`id TEXT PRIMARY KEY`, not `WITHOUT ROWID`), so SQLite assigns a
 * monotonically increasing rowid on insert; insertion order is exactly the
 * "which was recorded second" semantics the projector wants. A `VACUUM` may
 * renumber implicit rowids, but it rebuilds the table by copying rows in rowid
 * order, so the *relative* order this clause depends on survives. The
 * append-only trigger in migration 011 forbids updates and deletes, so no row
 * can be rewritten into a different position either.
 */
const EVENT_ORDER = 'ORDER BY occurred_at, rowid';

/* -------------------------------------------------------------------------- *
 * N2 — human corrections outside the four state fields.
 *
 * `register_row_state` materialises exactly four fields, so `stateFor` used to
 * apply an event only when `Object.hasOwn(state, field)` held. Every other
 * correction — `severity`, `mitigation`, `title` — was written to the
 * append-only event log and then discarded: the projection, the typed detail
 * tables, the operational tables and the score all continued to show the
 * extracted value. It was worse than inert, because `contestedFields` in
 * `sourceIntelligence.ts` DOES consider typed-detail keys, so the invisible
 * event permanently converted every later extracted update to that field into a
 * `conflict`. The human's edit did nothing except block the machine.
 *
 * The fix keeps the four state fields behaving exactly as they did and adds two
 * further classes of correctable field, replayed from the same event log in the
 * same deterministic order:
 *
 *   - `title` and `summary`, which the design lists under "Any: correct a field
 *     (with reason)" and which are rendered on every surface in the product;
 *   - every scalar column of the row's typed detail table, which is where
 *     "change severity / likelihood" and the rest of §8.3 actually live.
 *
 * Corrections are materialised, not merely overlaid, for the same reason
 * `register_row_state` is materialised: readers all over the codebase
 * (`readRegisterState`, `briefContext`, the lenses) go straight to the detail
 * tables and the operational tables, and an overlay applied in only one of them
 * would leave the correction invisible in the others. Materialisation is
 * idempotent because an event carries an absolute value, never a delta: writing
 * it over a value already equal to it is a no-op, so a rebuild at a fixed as-of
 * instant is byte-identical however many times it runs.
 *
 * What is NOT rewritten is `raw_row_json` / `project_register_row_fields`: that
 * is the verbatim record of what the source asserted, it is the `before` side of
 * every field diff, and it is the baseline the workbook parity comparison reads.
 * The extracted value therefore stays recoverable after a correction, alongside
 * `previous_value` on the event itself.
 * -------------------------------------------------------------------------- */

/** The four fields `register_row_state` materialises as columns. */
const STATE_FIELDS = ['status', 'owner', 'due_date', 'resolution'] as const;

/** Fields on the register row itself that a human may correct. */
const ROW_CORRECTABLE_FIELDS = ['title', 'summary'] as const;

/**
 * Every field a human event may name for this register, in a stable order.
 * A field outside this set cannot be projected anywhere, so `recordRegisterEvent`
 * refuses it rather than recording an event that would be silently discarded.
 */
export function correctableFields(db: DatabaseSync, registerName: string): string[] {
  const table = detailTableFor[registerName as RegisterName] ?? null;
  const detail = table ? [...detailColumns(db, table).keys()] : [];
  return [...new Set([...STATE_FIELDS, ...ROW_CORRECTABLE_FIELDS, ...detail])].sort(compareCodeUnits);
}

/** The value a correction should store for one detail column, or `undefined` when it cannot hold one. */
function coerceDetailValue(column: DetailColumn, value: string | null): string | number | null | undefined {
  // A NOT NULL column cannot be cleared. Refusing here rather than throwing at
  // the database keeps a replay of historic events from failing outright.
  if (value === null) return column.notNull ? undefined : null;
  return column.integer ? (truthy(value) ? 1 : 0) : value;
}

/**
 * Applies the human corrections that target this row's typed detail table:
 * writes them through to the table and returns the corrected detail object the
 * scorer and the operational projection then use.
 */
function correctedDetails(db: DatabaseSync, register: RegisterName, registerRowId: string, detail: JsonObject, corrections: Map<string, string | null>): JsonObject {
  const table = detailTableFor[register];
  if (!table || corrections.size === 0) return detail;
  const columns = detailColumns(db, table);
  const stored = Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE register_row_id = ?`).get(registerRowId));
  const result: JsonObject = { ...detail };
  for (const [field, value] of corrections) {
    const column = columns.get(field);
    if (!column) continue;
    const next = coerceDetailValue(column, value);
    if (next === undefined) continue;
    result[field] = next;
    // With no detail row to write into, the correction still reaches the score
    // and the operational tables through `result`; there is simply no typed row
    // to materialise it in.
    if (stored) db.prepare(`UPDATE ${table} SET ${column.name} = ? WHERE register_row_id = ?`).run(next, registerRowId);
  }
  return result;
}

/** The corrected value of a row-level field, or `null` when no correction is in force. */
function correctedRowField(corrections: Map<string, string | null>, field: string): string | null {
  const value = corrections.get(field);
  return value === undefined || value === null ? null : text(value) || null;
}

/**
 * Register-appropriate status transitions a human or a source-apply event may
 * request, keyed by `event_type`. Deliberately a flat map rather than a
 * per-register switch: the projector does not police which register an event
 * type "belongs to" (a Risks_Issues-only status recorded against an Action
 * would just be an unrecognised wording for that register's classifier, same
 * as any other unexpected status text, not a crash).
 *
 * `note` and `reaffirm` are intentionally absent: both are events a human (or
 * a source reaffirm) may record without changing status, and their absence
 * from this map is what keeps them status-neutral.
 */
const EVENT_TYPE_STATUS: Record<string, string> = {
  complete: 'completed',
  close: 'resolved',
  resolve: 'resolved',
  ratify: 'ratified',
  reject: 'rejected',
  park: 'parked',
  reopen: 'open',
  start: 'in-progress',
  block: 'blocked',
  cancel: 'cancelled',
  mitigate: 'mitigated',
  accept: 'accepted',
  supersede: 'superseded',
  achieve: 'achieved',
  miss: 'missed',
  apply: 'applied',
  verify: 'verified',
  revert: 'reverted',
};

/**
 * The relationship event types whose meaning depends on the row at the OTHER
 * end still existing in effective state. When a void removes or materially
 * alters that other end, every surviving row on this list is flagged for human
 * review rather than silently repaired or deleted.
 */
export const RELATIONSHIP_EVENT_TYPES: readonly string[] = ['answers', 'answered_by', 'supersedes', 'superseded_by', 'resolves', 'reaffirm', 'reaffirmed_by', 'contradicts'];

/**
 * Sources whose contribution is excluded from effective state.
 *
 * A void is a replay-time exclusion, never a compensating write: the events
 * stay in the append-only log exactly as recorded, and this set decides which
 * of them the projector reads. That is what makes a void deterministic and
 * reversible, and what stops it from landing a "correction" dated after every
 * later valid source and human edit.
 */
export function voidedSourceIds(db: DatabaseSync, projectId: string): Set<string> {
  const rows = db.prepare("SELECT id FROM source_documents WHERE project_id = ? AND lifecycle_state = 'voided'").all(projectId) as Array<{ id: string }>;
  return new Set(rows.map((row) => String(row.id)));
}

function stateFor(db: DatabaseSync, projectId: string, row: Record<string, unknown>, voided: ReadonlySet<string>) {
  const state: Record<string, string | null> = {
    status: String(row.record_status),
    owner: ownerOrNull(row.owner),
    due_date: row.due_date ? String(row.due_date) : null,
    resolution: null,
  };
  // Every field event that is not one of the four state fields, last write wins,
  // in the same deterministic event order.
  const corrections = new Map<string, string | null>();
  const all = db.prepare(`SELECT * FROM register_row_events WHERE project_id = ? AND external_register_id = ? ${EVENT_ORDER}`).all(projectId, String(row.external_register_id)) as Array<Record<string, unknown>>;
  // Exactly the exclusion the void contract specifies: origin = source AND
  // source_id = a voided source. A human event is never excluded, whichever
  // source prompted it, and neither is a valid source's event.
  const events = voided.size === 0
    ? all
    : all.filter((event) => !(String(event.origin) === 'source' && event.source_id !== null && voided.has(String(event.source_id))));
  for (const event of events) {
    const field = event.field ? String(event.field) : null;
    if (field) {
      const next = event.new_value === null ? null : String(event.new_value);
      if (Object.hasOwn(state, field)) state[field] = field === 'owner' ? ownerOrNull(next) : next;
      else corrections.set(field, next);
    }
    const eventType = String(event.event_type);
    if (Object.hasOwn(EVENT_TYPE_STATUS, eventType)) state.status = EVENT_TYPE_STATUS[eventType];
  }
  // `allEvents` keeps the unfiltered log available to the void-disposition pass,
  // which has to reason about relationships a voided source recorded — those
  // events are excluded from STATE but are still how we know the relationship
  // existed and therefore which surviving row needs review.
  return { state, corrections, events, allEvents: all };
}

function scoreRow(db: DatabaseSync, projectId: string, row: Record<string, unknown>, detail: JsonObject, state: Record<string, string | null>, events: Array<Record<string, unknown>>, timestamp: string, config: ScoringConfig) {
  const weights = config.weights;
  const register = String(row.register_name) as RegisterName;
  const severityLabel = normalized(detail.severity);
  const likelihoodLabel = normalized(detail.likelihood).replace(/ /g, '-');
  const blockingFlag = truthy(detail.blocking);
  const closed = ['resolved', 'closed', 'complete', 'completed', 'superseded', 'rejected', 'ratified', 'agreed', 'agreed in principle', 'accepted', 'cancelled', 'mitigated', 'achieved', 'missed', 'applied', 'verified', 'reverted'].includes(normalized(state.status));
  const due = state.due_date && /^\d{4}-\d{2}-\d{2}$/.test(state.due_date) ? state.due_date : null;
  // Every time input below derives from the explicit as-of `timestamp` (C5).
  const asOfMs = new Date(timestamp).valueOf();
  const now = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
  const dueDays = due ? Math.ceil((new Date(`${due}T00:00:00.000Z`).valueOf() - now.valueOf()) / 86400000) : null;
  const owner = state.owner;
  const conflict = Boolean(db.prepare("SELECT 1 FROM register_change_ops o JOIN register_changesets c ON c.id = o.changeset_id WHERE c.project_id = ? AND o.target_external_id = ? AND o.op = 'conflict' AND o.status = 'pending' LIMIT 1").get(projectId, String(row.external_register_id)));
  const latestSource = db.prepare('SELECT id FROM source_documents WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  const touchedLatest = Boolean(latestSource && String(row.last_updated_source_id ?? '') === latestSource.id);
  const supersession = JSON.parse(String(row.supersession_ids_json ?? '[]')) as string[];
  const related = JSON.parse(String(row.related_ids_json ?? '[]')) as string[];
  const openUncertainty = related.some((id) => Boolean(db.prepare("SELECT 1 FROM project_register_rows WHERE project_id = ? AND external_register_id = ? AND register_name = 'Uncertainty' AND record_status NOT LIKE '%resolved%' LIMIT 1").get(projectId, id)));
  const createdAtMs = new Date(String(row.created_at)).valueOf();
  const ageDays = Number.isFinite(createdAtMs) && Number.isFinite(asOfMs) ? (asOfMs - createdAtMs) / 86400000 : 0;
  const staleness = !closed && events.length === 0 && ageDays > weights.stalenessDays;
  const components = {
    type: weights.register[register] ?? 0,
    severity: weights.severity[severityLabel] ?? 0,
    likelihood: weights.likelihood[likelihoodLabel] ?? 0,
    blocking: blockingFlag ? weights.blocking : 0,
    urgency: dueDays === null ? 0
      : dueDays < 0 ? weights.urgency.overdue
        : dueDays <= 3 ? weights.urgency.threeDays
          : dueDays <= 7 ? weights.urgency.sevenDays
            : dueDays <= 14 ? weights.urgency.fourteenDays : 0,
    ownership: isProjectConsultantOwner(db, projectId, owner) ? weights.ownership.consultant : owner ? weights.ownership.customer : 0,
    latestSource: touchedLatest ? weights.latestSource : 0,
    supersession: supersession.length ? weights.supersession : 0,
    conflict: conflict ? weights.conflict : 0,
    uncertainty: openUncertainty ? weights.uncertainty : 0,
    staleness: staleness ? weights.staleness : 0,
    closure: closed ? weights.closure : 0,
  };
  const score = Object.values(components).reduce((total, value) => total + value, 0);
  const band = closed ? 'Reference'
    : blockingFlag || conflict || (dueDays !== null && dueDays < 0) ? 'Now'
      : (dueDays !== null && dueDays <= 7) || ['critical', 'high'].includes(severityLabel) ? 'Soon'
        : score >= weights.bands.now ? 'Now'
          : score >= weights.bands.soon ? 'Soon'
            : score >= weights.bands.watch ? 'Watch' : 'Reference';
  return {
    score,
    band,
    inputs: {
      ...components,
      dueDays,
      severity: severityLabel || null,
      likelihood: likelihoodLabel || null,
      blocking: blockingFlag,
      owner: state.owner,
      unowned: isUnownedOwner(state.owner),
      ageDays: Number.isFinite(ageDays) ? Math.floor(ageDays) : null,
      stalenessDays: weights.stalenessDays,
      asOf: timestamp,
    },
  };
}

/* -------------------------------------------------------------------------- *
 * C17 — status mapping.
 *
 * Every mapper below returns whether it actually recognised the wording. An
 * unrecognised value is never presented as a confident classification: it is
 * recorded in the score inputs, and the record is pushed into the attention
 * queue with a reason, so "we could not read this status" is visible rather
 * than rendered as a plausible default.
 * -------------------------------------------------------------------------- */

export interface StatusMapping<T extends string | null> {
  value: T;
  recognised: boolean;
  raw: string;
}

type DecisionStatus = 'proposed' | 'awaiting-user' | 'decided' | 'agreed' | 'agreed-in-principle' | 'ratified' | 'rejected' | 'parked' | 'pending-ratification' | 'superseded';

export function decisionStatus(value: unknown): StatusMapping<DecisionStatus> {
  const raw = text(value);
  const status = normalized(value).replace(/ /g, '-');
  const map = (mapped: DecisionStatus): StatusMapping<DecisionStatus> => ({ value: mapped, recognised: true, raw });
  if (!status) return { value: 'awaiting-user', recognised: false, raw };
  if (status.includes('supersed')) return map('superseded');
  if (status.includes('agreed-in-principle')) return map('agreed-in-principle');
  if (status.includes('pending-ratification')) return map('pending-ratification');
  if (status.includes('ratified')) return map('ratified');
  if (status.includes('rejected') || status.includes('declined')) return map('rejected');
  if (status.includes('parked') || status.includes('on-hold') || status.includes('deferred')) return map('parked');
  if (status.includes('agreed')) return map('agreed');
  // `resolved` is the literal status `stateFor` writes for a human `resolve`
  // or `close` event. It fell through to `awaiting-user`, so a decision a
  // consultant explicitly closed rendered as "Awaiting User" forever (C17).
  if (/decid|resolv|closed|close$|complete|finalis|finaliz|signed-off|sign-off|approved/.test(status)) return map('decided');
  if (status.includes('propos') || status.includes('draft')) return map('proposed');
  if (status.includes('await') || status.includes('open') || status.includes('pending') || status.includes('to-do') || status.includes('outstanding')) return map('awaiting-user');
  return { value: 'awaiting-user', recognised: false, raw };
}

type MilestoneStatus = 'not-started' | 'in-progress' | 'at-risk' | 'achieved' | 'missed';

export function milestoneStatus(value: unknown): StatusMapping<MilestoneStatus> {
  const raw = text(value);
  const status = normalized(value).replace(/ /g, '-');
  const map = (mapped: MilestoneStatus): StatusMapping<MilestoneStatus> => ({ value: mapped, recognised: true, raw });
  if (!status) return { value: 'not-started', recognised: false, raw };
  if (['not-started', 'in-progress', 'at-risk', 'achieved', 'missed'].includes(status)) return map(status as MilestoneStatus);
  if (/missed|breached|overdue|not-achieved|failed/.test(status)) return map('missed');
  if (/complete|achiev|delivered|done|resolved|closed/.test(status)) return map('achieved');
  if (/at-risk|slipp|delayed|late/.test(status)) return map('at-risk');
  if (/in-progress|underway|started|in-flight|ongoing/.test(status)) return map('in-progress');
  if (/not-started|open|planned|pending|scheduled|to-do|upcoming|forecast/.test(status)) return map('not-started');
  return { value: 'not-started', recognised: false, raw };
}

type RiskKind = 'risk' | 'issue';

function riskKind(value: unknown): StatusMapping<RiskKind> {
  const raw = text(value);
  const status = normalized(value);
  if (!status) return { value: 'risk', recognised: false, raw };
  if (status.includes('issue') || status.includes('problem') || status.includes('defect')) return { value: 'issue', recognised: true, raw };
  if (status.includes('risk') || status.includes('threat')) return { value: 'risk', recognised: true, raw };
  return { value: 'risk', recognised: false, raw };
}

/** `risks_issues.severity` has an explicit `unknown` member; unknown stays unknown. */
function riskSeverity(value: unknown): StatusMapping<'unknown' | 'low' | 'medium' | 'high' | 'critical'> {
  const raw = text(value);
  const status = normalized(value);
  if (['low', 'medium', 'high', 'critical'].includes(status)) return { value: status as 'low', recognised: true, raw };
  return { value: 'unknown', recognised: !status, raw };
}

function riskLikelihood(value: unknown): StatusMapping<'unlikely' | 'possible' | 'likely' | 'almost-certain' | null> {
  const raw = text(value);
  const status = normalized(value).replace(/ /g, '-');
  if (['unlikely', 'possible', 'likely', 'almost-certain'].includes(status)) return { value: status as 'likely', recognised: true, raw };
  return { value: null, recognised: !status, raw };
}

function setAttention(db: DatabaseSync, table: string, projectId: string, id: string, band: string, owner: string | null, score: number, unrecognisedStatus: string | null) {
  const unowned = isUnownedOwner(owner);
  const byBand = needsConsultantAttention(db, projectId, owner, band);
  const needs = byBand || unrecognisedStatus !== null ? 1 : 0;
  const attentionOwner = needs ? 'current-user' : null;
  const reasons: string[] = [];
  if (byBand) reasons.push(`${band} band; explainable score ${score}; ${unowned ? 'no owner recorded' : 'owned by the implementation consultant'}`);
  if (unrecognisedStatus !== null) reasons.push(`status wording "${unrecognisedStatus}" was not recognised and has not been classified`);
  const reason = reasons.length ? `${reasons.join('. ')}.` : null;
  if (['actions', 'changes'].includes(table)) db.prepare(`UPDATE ${table} SET needs_user_attention = ?, attention_owner = ?, attention_reason = ? WHERE project_id = ? AND id = ?`).run(needs, attentionOwner, reason, projectId, id);
  else db.prepare(`UPDATE ${table} SET needs_user_attention = ?, attention_owner = ? WHERE project_id = ? AND id = ?`).run(needs, attentionOwner, projectId, id);
}

/* -------------------------------------------------------------------------- *
 * C3 — provenance and ownership of operational rows.
 *
 * `rebuildProjection` used to delete every operational row for the project and
 * re-insert only the register-derived ones, destroying rows written directly by
 * `importProjectPayload`, the E2E fixture loader and the M365 projection.
 *
 * Provenance marker: `register_row_state` is the projector's own ledger. It has
 * exactly one row per record the projector produced on its last run, and no
 * other writer touches it, so "did I create this?" is answerable from existing
 * schema without a migration. The owned set for a rebuild is therefore
 *
 *     ids in project_register_rows (what I am about to own)
 *   ∪ ids in register_row_state    (what I owned last time)
 *
 * and nothing outside that set is ever deleted or overwritten. Rows still owned
 * are upserted rather than deleted and re-inserted, so a milestone referenced by
 * `work_packages.milestone_id` or `projects.next_milestone_id` is never briefly
 * or permanently removed; ids that have left the register are deleted, and any
 * reference they leave behind is repaired explicitly.
 * -------------------------------------------------------------------------- */

const operationalTableFor: Record<RegisterName, string | null> = {
  Decisions: 'decisions',
  Actions: 'actions',
  Risks_Issues: 'risks_issues',
  Config_Changes: 'changes',
  Open_Questions: 'open_questions',
  Milestones: 'milestones',
  Sources: 'project_sources',
  Entities: null,
  Uncertainty: null,
};

const operationalTables = ['actions', 'decisions', 'risks_issues', 'changes', 'open_questions', 'milestones', 'project_sources'] as const;

function assertNotForeignRow(db: DatabaseSync, table: string, projectId: string, id: string) {
  const existing = db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: string } | undefined;
  if (existing && String(existing.project_id) !== projectId) {
    throw new Error(`Cannot project register row ${id} into ${table}: that id already belongs to project ${String(existing.project_id)}.`);
  }
}

function insertOperational(db: DatabaseSync, projectId: string, register: RegisterName, id: string, raw: JsonObject, detail: JsonObject, state: Record<string, string | null>, corrections: Map<string, string | null>, score: { score: number; band: string }, timestamp: string) {
  const table = operationalTableFor[register];
  if (!table) return null;
  assertNotForeignRow(db, table, projectId, id);
  // A human correction to `title`/`summary` outranks the extracted wording on
  // every operational surface, exactly as a correction to `owner` does.
  const title = correctedRowField(corrections, 'title') ?? (text(rawValue(raw, ['title', 'decision', 'action', 'risk_issue', 'risk', 'issue', 'question', 'milestone', 'entity', 'source', 'uncertainty', 'name', 'summary', 'description', 'change', 'item', 'filename'])) || id);
  const summary = correctedRowField(corrections, 'summary') ?? (text(rawValue(raw, ['summary', 'description', 'rationale', 'driver', 'mitigation', 'question', 'why_uncertain', 'notes', 'implications', 'item'])) || title);
  const owner = state.owner ?? ownerOrNull(rawValue(raw, ['owner', 'assigned_to', 'lead', 'parked_with', 'decider', 'committed_by', 'made_by']));
  const storedOwner = owner ?? UNASSIGNED_OWNER;
  const status = state.status ?? 'open';
  const due = state.due_date;
  const base = [id, projectId, title, status, storedOwner, timestamp, 'operational-reference', summary];
  let unrecognisedStatus: string | null = null;
  if (register === 'Actions') {
    db.prepare(`INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, priority = excluded.priority, due_date = excluded.due_date, needs_user_attention = 0, attention_owner = NULL, attention_reason = NULL`).run(...base, normalized(raw.priority) || 'medium', due);
  } else if (register === 'Decisions') {
    const mapped = decisionStatus(status);
    if (!mapped.recognised) unrecognisedStatus = mapped.raw;
    db.prepare(`INSERT INTO decisions (id, project_id, title, status, owner, updated_at, data_classification, summary, decision_status, decision_needed_by, options_summary, outcome, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, decision_status = excluded.decision_status, decision_needed_by = excluded.decision_needed_by, options_summary = excluded.options_summary, outcome = excluded.outcome, needs_user_attention = 0, attention_owner = NULL`).run(...base, mapped.value, due, text(detail.options_summary), text(detail.outcome) || null);
  } else if (register === 'Risks_Issues') {
    const kind = riskKind(rawValue(raw, ['type', 'kind']));
    const severity = riskSeverity(detail.severity);
    const likelihood = riskLikelihood(detail.likelihood);
    if (!kind.recognised) unrecognisedStatus = `type ${kind.raw}`;
    db.prepare(`INSERT INTO risks_issues (id, project_id, title, status, owner, updated_at, data_classification, summary, kind, severity, likelihood, impact, response, target_resolution_date, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, kind = excluded.kind, severity = excluded.severity, likelihood = excluded.likelihood, impact = excluded.impact, response = excluded.response, target_resolution_date = excluded.target_resolution_date, needs_user_attention = 0, attention_owner = NULL`).run(...base, kind.value, severity.value, likelihood.value, text(detail.impact) || summary, text(detail.mitigation) || summary, due);
  } else if (register === 'Config_Changes') {
    db.prepare(`INSERT INTO changes (id, project_id, title, status, owner, updated_at, data_classification, summary, change_type, impact, decision_id, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, change_type = excluded.change_type, impact = excluded.impact, decision_id = excluded.decision_id, needs_user_attention = 0, attention_owner = NULL, attention_reason = NULL`).run(...base, text(detail.change_type) || 'configuration', text(detail.impact) || summary, text(raw.decision_id) || null);
  } else if (register === 'Open_Questions') {
    db.prepare(`INSERT INTO open_questions (id, project_id, title, status, owner, updated_at, data_classification, summary, question, answer_needed_by, blocking, resolution, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, question = excluded.question, answer_needed_by = excluded.answer_needed_by, blocking = excluded.blocking, resolution = excluded.resolution, needs_user_attention = 0, attention_owner = NULL`).run(...base, text(detail.question) || title, due, truthy(detail.blocking) ? 1 : 0, state.resolution);
  } else if (register === 'Milestones') {
    const mapped = milestoneStatus(status);
    if (!mapped.recognised) unrecognisedStatus = mapped.raw;
    db.prepare(`INSERT INTO milestones (id, project_id, title, status, owner, updated_at, data_classification, summary, target_date, milestone_status, completion_percent, work_package_ids_json, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, target_date = excluded.target_date, milestone_status = excluded.milestone_status, completion_percent = excluded.completion_percent, work_package_ids_json = excluded.work_package_ids_json, needs_user_attention = 0, attention_owner = NULL`).run(...base, due ?? '9999-12-31', mapped.value, Number(raw.completion_percent ?? 0), JSON.stringify(raw.work_package_tags ?? []));
  } else if (register === 'Sources') {
    db.prepare(`INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_type = excluded.source_type, label = excluded.label, external_path = excluded.external_path, last_seen_at = excluded.last_seen_at, data_classification = excluded.data_classification`).run(id, projectId, text(rawValue(raw, ['source_type', 'type'])) || 'source-intelligence', title, text(rawValue(raw, ['source_ref', 'path'])) || 'source-intelligence', timestamp, 'operational-reference');
    return { table, unrecognisedStatus: null };
  }
  setAttention(db, table, projectId, id, score.band, owner, score.score, unrecognisedStatus);
  return { table, unrecognisedStatus };
}

/** Rows the projector produced on its previous run, from its own ledger. */
function previouslyProjectedIds(db: DatabaseSync, projectId: string): Map<string, string | null> {
  const rows = db.prepare('SELECT external_register_id, register_name FROM register_row_state WHERE project_id = ?').all(projectId) as Array<{ external_register_id: string; register_name: string }>;
  return new Map(rows.map((row) => [String(row.external_register_id), operationalTableFor[String(row.register_name) as RegisterName] ?? null]));
}

/**
 * Clears exactly the operational rows the projector owns and is not about to
 * rewrite. Rows it never created are left untouched.
 */
function clearRetiredProjectedRows(db: DatabaseSync, projectId: string, owned: Map<string, string | null>, current: Map<string, string>) {
  const deleteFrom = new Map<string, ReturnType<DatabaseSync['prepare']>>(operationalTables.map((table) => [table, db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND id = ?`)]));
  for (const [id, previousTable] of owned) {
    if (!previousTable) continue;
    // Still projected into the same table: the upsert below rewrites it in
    // place, which keeps every reference to it valid.
    if (current.get(id) === previousTable) continue;
    deleteFrom.get(previousTable)!.run(projectId, id);
  }
}

/** Nothing may be left pointing at a milestone that no longer exists. */
function repairMilestoneReferences(db: DatabaseSync, projectId: string) {
  db.prepare('UPDATE work_packages SET milestone_id = NULL WHERE project_id = ? AND milestone_id IS NOT NULL AND milestone_id <> \'\' AND milestone_id NOT IN (SELECT id FROM milestones WHERE project_id = ?)').run(projectId, projectId);
  db.prepare('UPDATE projects SET next_milestone_id = NULL WHERE id = ? AND next_milestone_id IS NOT NULL AND next_milestone_id <> \'\' AND next_milestone_id NOT IN (SELECT id FROM milestones WHERE project_id = ?)').run(projectId, projectId);
}

export interface VoidDisposition {
  /** False when the row has left current effective state because its only evidence came from a voided source. */
  effective: boolean;
  reviewFlag: string | null;
  reviewDetail: string | null;
}

/**
 * Decide what a source void means for one register row.
 *
 * The rule, applied to a row founded by a now-voided source:
 *
 *  A. A still-valid source independently evidences this row — it has at least
 *     one anchor of its own on the row whose quote was MECHANICALLY VERIFIED
 *     against that source's transcript. The claim stands on evidence the void
 *     did not remove, so the row is retained, its surviving effective state is
 *     re-anchored to that valid evidence, and it is flagged
 *     "Founding source voided — review required".
 *
 *  B. Every other case: later sources merely referred to, updated or depended
 *     upon a claim that is now unsupported. The row leaves effective state and
 *     is retained in history, flagged "Orphaned by source void — review
 *     required". It is never deleted and its identifier is never reused.
 *
 * `verified = 1` is the discriminator because it is the one property that
 * already distinguishes "this source's own transcript demonstrably says this"
 * from "this source mentioned a row that something else asserted". An
 * unverified or inference-only reference is not independent evidence.
 *
 * A human event on the row also retains it: a person has deliberately worked on
 * this record, and the void contract requires human events to survive. Deleting
 * a row somebody owns because an unrelated transcript was withdrawn would be
 * exactly the silent damage this design exists to prevent.
 */
function voidDispositionFor(
  db: DatabaseSync,
  projectId: string,
  row: Record<string, unknown>,
  voided: ReadonlySet<string>,
  allEvents: ReadonlyArray<Record<string, unknown>>,
): VoidDisposition {
  if (voided.size === 0) return { effective: true, reviewFlag: null, reviewDetail: null };
  const externalId = String(row.external_register_id);
  const foundedBy = row.first_seen_source_id ? String(row.first_seen_source_id) : row.source_id ? String(row.source_id) : null;
  const anchors = db.prepare('SELECT source_id, verified FROM register_row_anchors WHERE project_id = ? AND external_register_id = ?').all(projectId, externalId) as Array<{ source_id: string; verified: number }>;
  const touchedByVoided = anchors.some((anchor) => voided.has(String(anchor.source_id)));
  const foundedByVoided = (foundedBy !== null && voided.has(foundedBy)) || (foundedBy === null && touchedByVoided);
  if (!foundedByVoided) {
    // The row was not founded by a voided source. It may still have been
    // TOUCHED by one — those events are already excluded from state above — but
    // it stands on its own founding evidence and stays effective.
    return touchedByVoided
      ? { effective: true, reviewFlag: 'relationship-review', reviewDetail: 'A voided source previously updated this row; its contribution has been removed from effective state. Review the remaining values.' }
      : { effective: true, reviewFlag: null, reviewDetail: null };
  }

  const validEvidence = anchors.some((anchor) => !voided.has(String(anchor.source_id)) && Number(anchor.verified) === 1);
  const humanEvents = allEvents.some((event) => String(event.origin) === 'human');
  if (validEvidence || humanEvents) {
    return {
      effective: true,
      reviewFlag: 'founding-source-voided',
      reviewDetail: validEvidence
        ? 'Founding source voided — review required. This row is retained because another valid source independently evidences it; its effective state is now anchored to that evidence.'
        : 'Founding source voided — review required. This row is retained because it carries human events that the void does not remove.',
    };
  }
  return {
    effective: false,
    reviewFlag: 'orphaned-by-source-void',
    reviewDetail: 'Orphaned by source void — review required. The only evidence for this row came from a voided source, so it has left current effective state. It is retained in history and its identifier is never reused.',
  };
}

export function rebuildProjection(db: DatabaseSync, projectId: string, timestamp = nowIso()) {
  const rows = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId) as Array<Record<string, unknown>>;
  const config = readActiveScoringConfig(db);
  const owned = previouslyProjectedIds(db, projectId);
  const voided = voidedSourceIds(db, projectId);

  // Dispositions are computed for every row BEFORE anything is projected,
  // because a relationship flag depends on whether the row at the other end
  // survived — which is not known until all of them have been decided.
  const replay = new Map<string, ReturnType<typeof stateFor>>();
  const dispositions = new Map<string, VoidDisposition>();
  for (const row of rows) {
    const id = String(row.external_register_id);
    const computed = stateFor(db, projectId, row, voided);
    replay.set(id, computed);
    dispositions.set(id, voidDispositionFor(db, projectId, row, voided, computed.allEvents));
  }
  if (voided.size > 0) {
    // Second pass — a surviving row whose relationship counterpart has left
    // effective state, or whose relationship was recorded by a voided source,
    // is flagged for a human. Relationships are never silently repaired and
    // never deleted.
    for (const row of rows) {
      const id = String(row.external_register_id);
      const disposition = dispositions.get(id)!;
      if (!disposition.effective || disposition.reviewFlag === 'founding-source-voided' || disposition.reviewFlag === 'orphaned-by-source-void') continue;
      const relationships = replay.get(id)!.allEvents.filter((event) => RELATIONSHIP_EVENT_TYPES.includes(String(event.event_type)));
      const broken = relationships.filter((event) => {
        const other = event.related_external_id ? String(event.related_external_id) : null;
        const fromVoided = String(event.origin) === 'source' && event.source_id !== null && voided.has(String(event.source_id));
        return fromVoided || (other !== null && dispositions.get(other)?.effective === false);
      });
      if (broken.length === 0) continue;
      const named = [...new Set(broken.map((event) => `${String(event.event_type)}${event.related_external_id ? ` ${String(event.related_external_id)}` : ''}`))].sort();
      dispositions.set(id, {
        effective: true,
        reviewFlag: 'relationship-review',
        reviewDetail: `A related record was removed or materially altered by a source void — review required. Affected relationships: ${named.join(', ')}.`,
      });
    }
  }

  const current = new Map<string, string>();
  for (const row of rows) {
    const table = operationalTableFor[String(row.register_name) as RegisterName];
    // A row excluded by a void must genuinely LEAVE effective state, so it is
    // omitted here and `clearRetiredProjectedRows` removes it from the
    // operational table it used to occupy — the same path a row that leaves the
    // register already takes, references repaired and all.
    if (table && dispositions.get(String(row.external_register_id))?.effective !== false) current.set(String(row.external_register_id), table);
  }
  clearRetiredProjectedRows(db, projectId, owned, current);
  db.prepare('DELETE FROM register_row_state WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM register_row_scores WHERE project_id = ?').run(projectId);
  db.prepare('INSERT INTO project_register_revisions (project_id, revision, updated_at) VALUES (?, 0, ?) ON CONFLICT(project_id) DO NOTHING').run(projectId, timestamp);

  for (const row of rows) {
    const register = String(row.register_name) as RegisterName;
    const id = String(row.external_register_id);
    const raw = JSON.parse(String(row.raw_row_json)) as JsonObject;
    const { state, corrections, events } = replay.get(id)!;
    const disposition = dispositions.get(id)!;
    // Replayed before scoring, so a corrected `severity` reaches the score and
    // the band rather than only the display layer (N2).
    const detail = correctedDetails(db, register, String(row.id), readTypedDetails(db, register, String(row.id)), corrections);
    // A due date relative to "the meeting" resolves against the CONFIRMED
    // meeting date, so a source whose date was corrected — or which never had
    // one — no longer resolves against an unrelated evidence-derived value.
    const source = row.source_id ? db.prepare('SELECT confirmed_event_date, event_date FROM source_documents WHERE id = ?').get(String(row.source_id)) as { confirmed_event_date: string | null; event_date: string | null } | undefined : undefined;
    const rawDue = text(rawDueValue(register, raw));
    const resolved = resolveDate(rawDue, source?.confirmed_event_date ?? source?.event_date ?? null);
    if (!events.some((event) => event.field === 'due_date')) state.due_date = resolved.date;
    const correctedTitle = correctedRowField(corrections, 'title');
    const correctedSummary = correctedRowField(corrections, 'summary');
    db.prepare('UPDATE project_register_rows SET due_date = ?, due_date_raw = ?, due_date_confidence = ?, title = COALESCE(?, title), summary = COALESCE(?, summary) WHERE id = ?').run(resolved.date, rawDue || null, resolved.confidence, correctedTitle, correctedSummary, String(row.id));
    const score = scoreRow(db, projectId, row, detail, state, events, timestamp, config);
    // A row orphaned by a void is NOT projected into its operational table: it
    // has left effective state. It keeps its `register_row_state` row so it
    // stays inspectable, flagged, and reachable from history.
    const projected = disposition.effective ? insertOperational(db, projectId, register, id, raw, detail, state, corrections, score, timestamp) : null;
    const inputs = projected?.unrecognisedStatus ? { ...score.inputs, unrecognisedStatus: projected.unrecognisedStatus } : score.inputs;
    // `last_source_id` must name a source that still counts. When the row's own
    // latest source was voided, effective state is re-anchored to the most
    // recent VALID source that evidenced it (rule A), rather than continuing to
    // credit a withdrawn transcript.
    const ownSource = row.last_updated_source_id ? String(row.last_updated_source_id) : row.source_id ? String(row.source_id) : null;
    const storedSource = disposition.effective && ownSource !== null && voided.has(ownSource)
      ? (db.prepare("SELECT source_id FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? AND source_id NOT IN (SELECT id FROM source_documents WHERE lifecycle_state = 'voided') ORDER BY verified DESC, source_id DESC LIMIT 1").get(projectId, id) as { source_id: string } | undefined)?.source_id ?? null
      : ownSource;
    db.prepare('INSERT INTO register_row_state (project_id, external_register_id, register_name, status, owner, due_date, resolution, last_human_event_at, last_source_id, updated_at, effective, review_flag, review_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, id, register, state.status, state.owner, state.due_date, state.resolution, events.at(-1)?.occurred_at ? String(events.at(-1)?.occurred_at) : null, storedSource, timestamp, disposition.effective ? 1 : 0, disposition.reviewFlag, disposition.reviewDetail);
    db.prepare('INSERT INTO register_row_scores (project_id, external_register_id, score, band, inputs_json, scoring_version, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, id, score.score, score.band, JSON.stringify(inputs), config.version, timestamp);
  }
  repairMilestoneReferences(db, projectId);
  return { projectId, rowCount: rows.length, scoringVersion: config.version, projectorVersion: PROJECTOR_VERSION };
}

/* -------------------------------------------------------------------------- *
 * N8 — `occurred_at` is client-supplied, and `register_row_events` is
 * trigger-enforced append-only.
 *
 * An event dated in the future wins the replay for ever, sets
 * `last_human_event_at` to that instant, and — because human precedence
 * compares `occurred_at > instant` — converts every later extracted update to
 * that field into a permanent `conflict`. Nothing can correct it afterwards,
 * because nothing in that table can be updated or deleted, only added to.
 *
 * So the timestamp is validated at the boundary that accepts it, and a bad one
 * is refused with a reason rather than clamped: a caller whose clock or
 * serialisation is wrong needs to find out.
 *
 * This function takes `now` as an argument rather than reading a clock, because
 * this module has exactly one clock read by design (C5) and because a validator
 * that cannot be pinned to an instant cannot be tested deterministically.
 * -------------------------------------------------------------------------- */

/**
 * How far ahead of the receiving server's clock a supplied instant may sit.
 *
 * Five minutes: comfortably larger than the drift of an unsynchronised desktop
 * or a VM resumed from suspend, comfortably smaller than any interval over
 * which "in the future" could be mistaken for a genuine record of the past.
 */
export const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The earliest instant that can plausibly describe a human acting on a register
 * row in this product. Anything older is a parsing accident — a Unix epoch zero,
 * a two-digit year, a millisecond value read as seconds — and it is a one-way
 * latch in the other direction: it sorts below every real event for ever and
 * silently disables human precedence for that field.
 */
export const OCCURRED_AT_FLOOR = '2000-01-01T00:00:00.000Z';

/** ISO-8601 instant with an explicit UTC designator or numeric offset. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;

/**
 * True when the civil date and time written down actually exist.
 *
 * `new Date('2026-02-31T00:00:00Z')` does not throw in V8, it silently rolls
 * over to 3 March. Accepting that would record an instant the caller never
 * sent, which is exactly the class of silent rewrite this validation exists to
 * prevent, so the components are checked before the string is parsed.
 */
function isRealCivilInstant(parts: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) return false;
  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  if (Number(day) < 1 || Number(day) > daysInMonth) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

export type OccurredAtCheck = { ok: true; occurredAt: string } | { ok: false; error: string };

/**
 * Validates a client-supplied `occurredAt` against `now` and canonicalises it to
 * UTC. Canonicalisation is not clamping: it preserves the instant exactly, and
 * it matters because every precedence comparison on `occurred_at` is a string
 * comparison, under which `2026-07-30T23:00:00+02:00` sorts after an instant it
 * actually precedes.
 */
export function validateOccurredAt(value: unknown, now: string): OccurredAtCheck {
  const parts = typeof value === 'string' ? ISO_INSTANT.exec(value.trim()) : null;
  if (!parts || !isRealCivilInstant(parts)) {
    return { ok: false, error: 'occurredAt must be an ISO-8601 instant with an explicit UTC designator or offset, for example 2026-07-30T09:00:00.000Z.' };
  }
  const instant = new Date(parts[0]);
  const instantMs = instant.valueOf();
  if (!Number.isFinite(instantMs)) return { ok: false, error: `occurredAt "${parts[0]}" is not a real instant.` };
  const nowMs = new Date(now).valueOf();
  if (!Number.isFinite(nowMs)) throw new Error('validateOccurredAt requires a valid reference instant.');
  if (instantMs > nowMs + OCCURRED_AT_FUTURE_TOLERANCE_MS) {
    return { ok: false, error: `occurredAt ${instant.toISOString()} is in the future (server time ${new Date(nowMs).toISOString()}, tolerance ${OCCURRED_AT_FUTURE_TOLERANCE_MS / 1000}s). Register events are append-only and cannot be corrected, so a future timestamp is refused rather than recorded.` };
  }
  if (instantMs < new Date(OCCURRED_AT_FLOOR).valueOf()) {
    return { ok: false, error: `occurredAt ${instant.toISOString()} is before ${OCCURRED_AT_FLOOR} and cannot describe a human acting on this register. Register events are append-only and cannot be corrected, so an implausible timestamp is refused rather than recorded.` };
  }
  return { ok: true, occurredAt: instant.toISOString() };
}

/**
 * The bare `register_row_events` insert, with no revision bump and no
 * rebuild. Used by two callers with different transaction shapes:
 * `recordRegisterEvent` (one human event, one rebuild) and the
 * source-extraction apply path (many relationship events across a whole
 * changeset, one rebuild at the end) — see `upsertFact` in
 * `sourceIntelligence.ts`. Kept as one function so both paths write the
 * identical row shape and can never drift on column order.
 */
export function insertRawRegisterRowEvent(db: DatabaseSync, projectId: string, externalRegisterId: string, input: { actor: string; eventType: string; field?: string | null; previousValue?: string | null; newValue?: string | null; reason: string; evidenceRef?: string | null; sourceId?: string | null; occurredAt: string; origin: 'source' | 'human' | 'system'; relatedExternalId?: string | null }): void {
  db.prepare('INSERT INTO register_row_events (id, project_id, external_register_id, occurred_at, actor, event_type, field, previous_value, new_value, reason, evidence_ref, source_id, origin, related_external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), projectId, externalRegisterId, input.occurredAt, input.actor, input.eventType, input.field ?? null, input.previousValue ?? null, input.newValue ?? null, input.reason, input.evidenceRef ?? null, input.sourceId ?? null, input.origin, input.relatedExternalId ?? null);
}

export function recordRegisterEvent(db: DatabaseSync, projectId: string, externalRegisterId: string, input: { actor: string; eventType: string; field?: string | null; newValue?: string | null; reason: string; evidenceRef?: string | null; occurredAt?: string; origin?: 'human' | 'system'; relatedExternalId?: string | null }) {
  const row = db.prepare('SELECT id, register_name, title, summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(projectId, externalRegisterId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Register row not found.');
  const register = String(row.register_name);
  // A standalone note is a record that carries no field mutation by
  // definition. Refusing one that also names a field, rather than silently
  // ignoring the field, keeps "note" a safe, reviewable guarantee rather than
  // a convention someone could accidentally violate.
  if (input.eventType === 'note' && (input.field || input.newValue)) {
    throw new Error('A note event cannot also carry a field or newValue; record the field correction as a separate event.');
  }
  // N2 — a field the projector cannot reach must not be recorded at all. The
  // event log is append-only, so an unprojectable event is permanent, inert,
  // and still able to block future extracted updates to that field.
  if (input.field) {
    const allowed = correctableFields(db, register);
    if (!allowed.includes(input.field)) {
      throw new Error(`"${input.field}" is not a correctable field on a ${register} row, so an event naming it could never be projected. Correctable fields: ${allowed.join(', ')}.`);
    }
  }
  const occurredAt = input.occurredAt ?? nowIso();
  const current = db.prepare('SELECT * FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, externalRegisterId) as Record<string, unknown> | undefined;
  // The value being replaced, wherever it actually lives. Reading only
  // `register_row_state` recorded `previous_value = NULL` for every
  // typed-detail, `title` and `summary` correction, which is the field diff the
  // attention lane shows the consultant.
  const previous = !input.field ? null
    : (STATE_FIELDS as readonly string[]).includes(input.field) ? current?.[input.field] ?? null
      : input.field === 'title' ? row.title ?? null
        : input.field === 'summary' ? row.summary ?? null
          : readTypedDetails(db, register, String(row.id))[input.field] ?? null;
  db.exec('BEGIN IMMEDIATE;');
  try {
    insertRawRegisterRowEvent(db, projectId, externalRegisterId, {
      actor: input.actor, eventType: input.eventType, field: input.field ?? null,
      previousValue: previous === null || previous === undefined ? null : String(previous),
      newValue: input.newValue ?? null, reason: input.reason, evidenceRef: input.evidenceRef ?? null,
      occurredAt, origin: input.origin ?? 'human', relatedExternalId: input.relatedExternalId ?? null,
    });
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
  // Anchor order was `ORDER BY id` over `randomUUID()` values, which made
  // "the verified anchor" a different anchor on every read (C6).
  const anchors = db.prepare('SELECT * FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? ORDER BY source_id, segment_id, rowid').all(projectId, externalRegisterId) as Array<Record<string, unknown>>;
  const events = db.prepare('SELECT * FROM register_row_events WHERE project_id = ? AND external_register_id = ? ORDER BY occurred_at DESC, rowid DESC').all(projectId, externalRegisterId) as Array<Record<string, unknown>>;
  return {
    anchors: anchors.map((row) => ({ id: String(row.id), sourceId: String(row.source_id), segmentId: String(row.segment_id), speaker: row.speaker ? String(row.speaker) : null, tMs: row.t_ms === null ? null : Number(row.t_ms), quote: row.quote ? String(row.quote) : null, verified: row.verified === 1 })),
    events: events.map((row) => ({ id: String(row.id), occurredAt: String(row.occurred_at), actor: String(row.actor), eventType: String(row.event_type), field: row.field ? String(row.field) : null, previousValue: row.previous_value ? String(row.previous_value) : null, newValue: row.new_value ? String(row.new_value) : null, reason: String(row.reason), evidenceRef: row.evidence_ref ? String(row.evidence_ref) : null, origin: (row.origin ? String(row.origin) : 'human') as 'source' | 'human' | 'system', relatedExternalId: row.related_external_id ? String(row.related_external_id) : null })),
  };
}
