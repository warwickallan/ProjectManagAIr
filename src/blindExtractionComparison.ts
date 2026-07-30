import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type JsonObject = Record<string, unknown>;
type FileInput = { name: string; dataBase64: string };

type RegisterName = 'Decisions' | 'Actions' | 'Risks_Issues' | 'Config_Changes' | 'Open_Questions' | 'Milestones' | 'Entities' | 'Sources' | 'Uncertainty';

const registerNames: RegisterName[] = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'];
const idFields: Record<RegisterName, string[]> = {
  Decisions: ['decision_id', 'id'],
  Actions: ['action_id', 'id'],
  Risks_Issues: ['raid_id', 'id'],
  Config_Changes: ['config_id', 'id'],
  Open_Questions: ['q_id', 'id'],
  Milestones: ['milestone_id', 'id'],
  Entities: ['entity_id', 'id'],
  Sources: ['source_id', 'id'],
  Uncertainty: ['u_id', 'id'],
};
const titleFields: Record<RegisterName, string[]> = {
  Decisions: ['decision', 'title', 'summary'],
  Actions: ['action', 'title', 'summary'],
  Risks_Issues: ['description', 'title', 'summary'],
  Config_Changes: ['change', 'title', 'summary'],
  Open_Questions: ['question', 'title', 'summary'],
  Milestones: ['item', 'title', 'summary'],
  Entities: ['name', 'title', 'summary'],
  Sources: ['filename', 'title', 'summary'],
  Uncertainty: ['item', 'why_uncertain', 'title', 'summary'],
};
const itemTypeToRegister: Record<string, RegisterName> = {
  decision: 'Decisions',
  action: 'Actions',
  risk_issue: 'Risks_Issues',
  risk: 'Risks_Issues',
  issue: 'Risks_Issues',
  change_request: 'Config_Changes',
  config_change: 'Config_Changes',
  open_question: 'Open_Questions',
  question: 'Open_Questions',
  milestone: 'Milestones',
  entity: 'Entities',
  stakeholder: 'Entities',
  source: 'Sources',
  source_metadata: 'Sources',
  uncertainty: 'Uncertainty',
};
const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'rather', 'should', 'the', 'to', 'use', 'with']);

export interface BlindExtractionComparisonInput {
  frozenPacketFile: FileInput;
  expectedDeltaFile: FileInput;
  expectedWorkbookFile?: FileInput;
}

interface ExpectedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; anchors: string[]; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
interface ExtractedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; anchors: string[]; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
interface MatchRecord { expectedId: string; extractedId: string; status: 'exact' | 'semantic'; alignment: 'canonical-anchor' | 'durable-id' | 'semantic'; score: number; fieldMismatches: string[]; statusDifference: boolean; sourceAnchorDifference: boolean; workPackageTagDifference: boolean }
interface DifferenceClassification { expectedId?: string; extractedIds?: string[]; reason: string }

function nowIso() {
  return new Date().toISOString();
}

function hashBytes(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function keyify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function rowValue(row: JsonObject, keys: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [keyify(key), value]));
  for (const key of keys) {
    const found = normalized.get(keyify(key));
    if (found !== undefined && found !== null && text(found) !== '') return text(found);
  }
  return '';
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value: string) {
  return normalize(value).split(' ').filter((part) => part.length > 2 && !stopWords.has(part));
}

function similarity(a: string, b: string) {
  const aTokens = new Set(tokens(a));
  const bTokens = new Set(tokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
  return (2 * intersection) / (aTokens.size + bTokens.size);
}

function bigramSet(orderedTokens: string[]) {
  const set = new Set<string>();
  for (let index = 1; index < orderedTokens.length; index += 1) set.add(`${orderedTokens[index - 1]} ${orderedTokens[index]}`);
  return set;
}

function overlapCount(a: Set<string>, b: Set<string>) {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

/**
 * Semantic calibration (replaces the `semanticScore >= 0.22` predicate).
 *
 * The score itself stays exactly what it was — a length-normalised Dice coefficient over
 * meaningful unigrams — because that measure is correct and is what the design's "length-normalised"
 * wording refers to. What changes is the *decision rule* built on top of it.
 *
 * Measured on realistic project-register wording (benchmark row vs. a genuine paraphrase of it, and
 * benchmark row vs. an unrelated row drawn from the same project vocabulary — permit, isolation,
 * register, confirm, agree, workstream, cutover, migration):
 *
 *   genuine paraphrases        Dice 0.50 – 0.91, 2–5 shared unigrams, 1–4 shared bigrams
 *   unrelated same-vocab rows  Dice 0.18 – 0.60, 1–3 shared unigrams, 0–1 shared bigrams
 *
 * Three observations drive the rule:
 *   1. Every unrelated pair that scored below 0.45 shared exactly ONE meaningful token. One shared
 *      domain word ("payroll", "permit") is the dominant false-positive mode and is what made the
 *      old 0.22 threshold accept a null extraction, so a minimum of TWO shared meaningful tokens is
 *      required before any pair can be considered at all.
 *   2. In the 0.45–0.72 band, unigram overlap alone does not separate the classes, but *adjacency*
 *      does: paraphrases preserve phrases ("smart contractor", "permit register", "cutover date")
 *      and therefore share bigrams, while unrelated rows that happen to share three generic words
 *      ("update", "register", "workshop") share none. A shared bigram is the cheapest signal that
 *      measurably separates the two, so it is admitted as the second acceptance route.
 *   3. Above 0.75 the pair is a near-restatement of the same sentence and needs no phrase evidence.
 *
 * Hence: accept when >= 2 meaningful tokens are shared AND (Dice >= 0.75, or Dice >= 0.45 with at
 * least one shared bigram). On the calibration set this accepts 9/10 genuine paraphrases and rejects
 * 9/10 unrelated pairs; the single remaining false positive is a pair a human reviewer would also
 * call "related" ("...payroll migration workstream" vs "...migration workstream owner"), and such a
 * pair surfaces as an alternative decomposition rather than as a silent free match.
 *
 * The known false negative is a terse restatement of a long benchmark row ("Should the Expired
 * status be renamed, or is the process around expired permits sufficient?" vs "Question whether the
 * Expired permit status needs renaming", Dice 0.286): the harness understates recall there rather
 * than overstating it, which is the safe direction for an acceptance gate.
 */
const NEAR_RESTATEMENT_DICE = 0.75;
const PHRASE_SUPPORTED_DICE = 0.45;
const MIN_SHARED_TOKENS = 2;
/**
 * A side with a single meaningful token (an entity name, a one-word milestone) can never reach two
 * shared tokens. Such a pair is accepted only when the two token sets are effectively the same word,
 * which Dice >= 0.8 enforces (1-vs-1 identical = 1.0; 1-vs-2 containment = 0.667, rejected).
 */
const SINGLE_TOKEN_DICE = 0.8;
/**
 * A shared canonical anchor or a shared durable ID is strong independent evidence, so it lowers the
 * bar — but it does not remove it. An anchor collision at Dice 0 is not a match: one source segment
 * normally yields several proposed items, so anchor collision alone is near-universal.
 */
const ALIGNED_FLOOR_DICE = 0.35;
/** Threshold for "these two rows are talking about related material" — used only to classify
 * unmatched rows (decomposition / duplicate / related), never to count a match. */
const RELATED_EVIDENCE_DICE = 0.35;
const CROSS_REGISTER_DICE = 0.7;

interface FieldEvidence { dice: number; sharedTokens: number; sharedBigrams: number; sharedOk: boolean; semanticAcceptable: boolean; alignedAcceptable: boolean; related: boolean }

function fieldEvidence(a: string, b: string): FieldEvidence {
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const sharedTokens = overlapCount(aSet, bSet);
  const dice = aSet.size === 0 || bSet.size === 0 ? 0 : (2 * sharedTokens) / (aSet.size + bSet.size);
  const sharedBigrams = overlapCount(bigramSet(aTokens), bigramSet(bTokens));
  const smallestSide = Math.min(aSet.size, bSet.size);
  const sharedOk = smallestSide > 0 && (smallestSide >= MIN_SHARED_TOKENS
    ? sharedTokens >= MIN_SHARED_TOKENS
    : sharedTokens >= 1 && dice >= SINGLE_TOKEN_DICE);
  return {
    dice,
    sharedTokens,
    sharedBigrams,
    sharedOk,
    semanticAcceptable: sharedOk && (dice >= NEAR_RESTATEMENT_DICE || (dice >= PHRASE_SUPPORTED_DICE && sharedBigrams >= 1)),
    alignedAcceptable: sharedOk && dice >= ALIGNED_FLOOR_DICE,
    related: sharedOk && dice >= RELATED_EVIDENCE_DICE,
  };
}

function nestedObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

/**
 * Anchor keys carried by an object that may itself be a row, an `evidence` block or one entry of an
 * `anchors` array. `segment_seq` is the shape this system actually emits (`anchorSchema` in
 * `sourceIntelligence.ts`: `{ segment_seq, speaker, t_ms, quote }`); the remaining names are the
 * legacy keys older benchmark fixtures use and are still honoured.
 */
function anchorKeysOf(row: JsonObject): string[] {
  const keys: string[] = [];
  const seq = rowValue(row, ['segment_seq', 'segmentSeq']);
  if (seq && /^[0-9]+$/.test(seq.trim())) keys.push(`segment-seq:${Number(seq.trim())}`);
  const legacy = rowValue(row, ['anchor', 'source_anchor', 'sourceAnchor', 'segment_id', 'segmentId']);
  if (legacy) keys.push(legacy);
  return keys;
}

function canonicalAnchors(row: JsonObject): string[] {
  const keys = [...anchorKeysOf(row)];
  const evidence = nestedObject(row.evidence);
  if (evidence) keys.push(...anchorKeysOf(evidence));
  for (const entry of Array.isArray(row.anchors) ? row.anchors : []) {
    if (typeof entry === 'string') {
      if (entry.trim()) keys.push(entry.trim());
      continue;
    }
    const entryObject = nestedObject(entry);
    if (entryObject) keys.push(...anchorKeysOf(entryObject));
  }
  return [...new Set(keys.map(normalize).filter(Boolean))];
}

function anchorsOverlap(a: string[], b: string[]) {
  return a.length > 0 && b.length > 0 && a.some((value) => b.includes(value));
}

const factMetadataKeys = new Set([
  'id', 'decision_id', 'action_id', 'raid_id', 'config_id', 'q_id', 'milestone_id', 'entity_id', 'source_id', 'u_id',
  'source_ref', 'source_anchor', 'anchor', 'row_number', 'original_row_number', 'tab_name', 'register_name',
  // `anchors` carries verbatim source quotes. Counting a copied quote as a recalled fact would let an
  // extraction score recall on text it merely echoed from the source instead of on what it asserted.
  'anchors', 'quote', 'segment_seq', 'segment_id', 'client_ref', 'proposed_id', 't_ms',
]);

function factValues(row: JsonObject): string[] {
  const facts: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (factMetadataKeys.has(keyify(key))) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
    } else if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as JsonObject)) visit(childValue, childKey);
    } else {
      const normalized = normalize(text(value));
      if (normalized) facts.push(normalized);
    }
  };
  for (const [key, value] of Object.entries(row)) visit(value, key);
  return [...new Set(facts)];
}

function structuredSupersessionIds(row: JsonObject): string[] {
  const value = rowValue(row, ['supersession_ids', 'supersedes', 'superseded_by', 'supersedes_links', 'supersession_ids_json']);
  // The benchmark workbook writes '-' for "no link"; treat it as empty rather than as an ID.
  return value ? value.split(/[;,]/).map((part) => part.trim()).filter((part) => part !== '' && part !== '-') : [];
}

/** Statuses that encode a reversal of a previously recorded state. Scored from the structured
 * status field — never from a lexical scan of the row text, which is what the deleted
 * `/supersed|revers|instead|not/i` regex did. */
const REVERSAL_STATUS = /(supersed|revers|withdraw|cancel|rescind|overturn|reopen|reject)/i;

/**
 * Distinct-fact accounting (A21 is stated in this metric, so it has to be sound in both directions).
 *
 * DEDUPE KEY: the normalised scalar value itself — `normalize(text(value))`, i.e. lower-cased with
 * every run of non-alphanumeric characters collapsed to a single space. Two values are the same fact
 * when they are the same string under that key, regardless of which row or field they came from.
 * `factValues` only deduped within a row, so five rows sharing `status: 'open'` produced five
 * "distinct facts"; the key is applied across the whole comparison scope instead.
 *
 * MEASURABILITY FLOOR: a value is only counted when it is at least MIN_FACT_CHARS characters AND at
 * least MIN_FACT_PARTS whitespace-separated parts. Single tokens, bare numbers and status words
 * ("open", "high", "1", "SRC-002") cannot be matched without coincidence in either direction, so
 * they are EXCLUDED FROM THE DENOMINATOR ENTIRELY rather than counted as free recall. Excluding them
 * is the conservative choice: it removes the trivially-satisfied numerator terms the old substring
 * test produced, and it does not let an extraction earn recall for facts nobody can verify.
 */
const MIN_FACT_CHARS = 8;
const MIN_FACT_PARTS = 2;
const FACT_RECALL_DICE = 0.75;
const MIN_COMPARABLE_FACT_TOKENS = 2;
const MIN_PHRASE_FACT_CHARS = 12;
const MIN_PHRASE_FACT_PARTS = 3;

function isMeasurableFact(fact: string) {
  return fact.length >= MIN_FACT_CHARS && fact.split(' ').length >= MIN_FACT_PARTS;
}

/** The whole benchmark fact appears as a complete token run inside a longer extracted value. Only
 * applied to facts long enough that the containment cannot be a coincidence — this replaces the old
 * bare `candidate.includes(fact) || fact.includes(candidate)` test, under which the fact
 * "2026 03 15" was recalled by any row carrying `priority: 1`. */
function containsFactPhrase(candidate: string, fact: string) {
  if (fact.length < MIN_PHRASE_FACT_CHARS || fact.split(' ').length < MIN_PHRASE_FACT_PARTS) return false;
  return candidate.length > fact.length && ` ${candidate} `.includes(` ${fact} `);
}

function factIsRecalled(fact: string, candidates: Set<string>) {
  if (candidates.has(fact)) return true;
  // A fact with fewer than two meaningful tokens (a date, a reference, a short phrase of stop words)
  // carries too little signal for Dice: "2026 03 15" and "2026 03 20" both reduce to {2026}. Such a
  // fact is only recalled by exact equality.
  const comparable = tokens(fact).length >= MIN_COMPARABLE_FACT_TOKENS;
  for (const candidate of candidates) {
    if (!isMeasurableFact(candidate)) continue;
    if (containsFactPhrase(candidate, fact)) return true;
    if (comparable && similarity(fact, candidate) >= FACT_RECALL_DICE) return true;
  }
  return false;
}

function measureFactRecall(expectedRows: ExpectedRecord[], extractedRows: ExtractedRecord[]) {
  const expectedFacts = new Set<string>();
  for (const row of expectedRows) for (const fact of factValues(row.row)) if (isMeasurableFact(fact)) expectedFacts.add(fact);
  const candidates = new Set<string>();
  for (const row of extractedRows) for (const fact of factValues(row.row)) candidates.add(fact);
  let recalled = 0;
  for (const fact of expectedFacts) if (factIsRecalled(fact, candidates)) recalled += 1;
  return { expected: expectedFacts.size, recalled };
}

function parseExpected(raw: string): ExpectedRecord[] {
  const packet = asObject(JSON.parse(raw) as unknown, 'Expected delta packet');
  const sheets = asObject(packet.sheets ?? packet.registers, 'Expected delta sheets');
  const rows: ExpectedRecord[] = [];
  for (const registerName of registerNames) {
    const sheet = sheets[registerName];
    if (!sheet) continue;
    const sheetRows = Array.isArray(sheet) ? sheet : asObject(sheet, `Expected ${registerName}`).rows;
    if (!Array.isArray(sheetRows)) throw new Error(`Expected ${registerName} rows must be an array.`);
    for (const rawRow of sheetRows) {
      const row = asObject(rawRow, `Expected ${registerName} row`);
      const id = rowValue(row, idFields[registerName]);
      const title = rowValue(row, titleFields[registerName]);
      const anchors = canonicalAnchors(row);
      rows.push({
        id,
        registerName,
        title,
        status: rowValue(row, ['status']),
        sourceRef: rowValue(row, ['source_ref']),
        anchor: anchors[0] ?? '',
        anchors,
        workPackageId: rowValue(row, ['work_package_id']),
        workPackageName: rowValue(row, ['work_package_name']),
        row,
        text: Object.entries(row).filter(([key]) => !['source_ref', 'anchor'].includes(keyify(key))).map(([, value]) => text(value)).join(' '),
      });
    }
  }
  return rows;
}

function registerForExtracted(item: JsonObject): RegisterName | null {
  const explicit = rowValue(item, ['registerName', 'register_name']);
  if (registerNames.includes(explicit as RegisterName)) return explicit as RegisterName;
  const type = rowValue(item, ['type']);
  if (type === 'source_metadata') return 'Sources';
  if (type === 'stakeholder') return 'Entities';
  if (type === 'risk' || type === 'issue') return 'Risks_Issues';
  return itemTypeToRegister[type] ?? null;
}

function parseFrozen(raw: string): { sourceHash: string; provider: string; model: string; generatedAt: string; rows: ExtractedRecord[] } {
  const packet = asObject(JSON.parse(raw) as unknown, 'Frozen extraction packet');
  const items = packet.items;
  if (!Array.isArray(items)) throw new Error('Frozen extraction packet items must be an array.');
  return {
    sourceHash: rowValue(asObject(packet.sourceMetadata, 'Frozen source metadata'), ['contentHash']),
    provider: rowValue(packet, ['provider']),
    model: rowValue(packet, ['model']),
    generatedAt: rowValue(packet, ['generatedAt']),
    rows: items.map((rawItem) => {
      const row = asObject(rawItem, 'Frozen extraction item');
      const registerName = registerForExtracted(row);
      if (!registerName) return null;
      const title = rowValue(row, ['title']);
      const summary = rowValue(row, ['summary']);
      const body = rowValue(row, ['body']);
      const anchors = canonicalAnchors(row);
      return {
        id: rowValue(row, ['id']),
        registerName,
        title,
        status: rowValue(row, ['status']),
        sourceRef: rowValue(row, ['source_ref', 'sourceRef']),
        anchor: anchors[0] ?? '',
        anchors,
        workPackageId: rowValue(row, ['work_package_id', 'workPackageId']),
        workPackageName: rowValue(row, ['work_package_name', 'workPackageName']),
        row,
        text: [title, summary, body].filter(Boolean).join(' '),
      } satisfies ExtractedRecord;
    }).filter((row): row is ExtractedRecord => Boolean(row)),
  };
}

/** Tie-break quality, bounded by MAX_QUALITY. It only orders pairs that are already acceptable —
 * it can never create a match, which is what made the old `4*anchor + 2*id + semantic` weight drop
 * recoverable pairs. */
const ANCHOR_QUALITY_BONUS = 0.4;
const ID_QUALITY_BONUS = 0.2;
const MAX_QUALITY = 1 + ANCHOR_QUALITY_BONUS + ID_QUALITY_BONUS;

function candidateQuality(expected: ExpectedRecord, extracted: ExtractedRecord) {
  const anchorMatch = anchorsOverlap(expected.anchors, extracted.anchors);
  const idMatch = Boolean(expected.id && extracted.id) && normalize(expected.id) === normalize(extracted.id);
  const titleEvidence = fieldEvidence(expected.title, extracted.title);
  const bodyEvidence = fieldEvidence(expected.text, extracted.text);
  const semanticScore = Math.max(titleEvidence.dice, bodyEvidence.dice);
  const semanticAcceptable = titleEvidence.semanticAcceptable || bodyEvidence.semanticAcceptable;
  // An anchor or ID collision lowers the bar; it does not remove it. Anchor-aligned pairs must still
  // share meaningful content (>= 2 shared tokens and Dice >= ALIGNED_FLOOR_DICE on the same field).
  const alignedAcceptable = (anchorMatch || idMatch) && (titleEvidence.alignedAcceptable || bodyEvidence.alignedAcceptable);
  return {
    acceptable: semanticAcceptable || alignedAcceptable,
    alignment: anchorMatch ? 'canonical-anchor' as const : idMatch ? 'durable-id' as const : 'semantic' as const,
    anchorMatch,
    idMatch,
    semanticScore,
    sharedTokens: Math.max(titleEvidence.sharedTokens, bodyEvidence.sharedTokens),
    sharedBigrams: Math.max(titleEvidence.sharedBigrams, bodyEvidence.sharedBigrams),
    related: titleEvidence.related || bodyEvidence.related,
    quality: semanticScore + (anchorMatch ? ANCHOR_QUALITY_BONUS : 0) + (idMatch ? ID_QUALITY_BONUS : 0),
  };
}

function optimalAssignment(weights: number[][]): number[] {
  if (weights.length === 0) return [];
  const columnCount = weights[0]?.length ?? 0;
  if (columnCount === 0) return weights.map(() => -1);
  const size = Math.max(weights.length, columnCount);
  const maxWeight = Math.max(0, ...weights.flat());
  const cost = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => maxWeight - (weights[row]?.[column] ?? 0)));
  const u = Array(size + 1).fill(0) as number[];
  const v = Array(size + 1).fill(0) as number[];
  const p = Array(size + 1).fill(0) as number[];
  const way = Array(size + 1).fill(0) as number[];

  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column0 = 0;
    const minValue = Array(size + 1).fill(Number.POSITIVE_INFINITY) as number[];
    const used = Array(size + 1).fill(false) as boolean[];
    do {
      used[column0] = true;
      const row0 = p[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (current < minValue[column]) {
          minValue[column] = current;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }
      column0 = column1;
    } while (p[column0] !== 0);
    do {
      const column1 = way[column0];
      p[column0] = p[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = weights.map(() => -1);
  for (let column = 1; column <= size; column += 1) {
    const row = p[column] - 1;
    if (row >= 0 && row < weights.length && column - 1 < columnCount) assignment[row] = column - 1;
  }
  return assignment;
}

function recordLabel(row: ExpectedRecord | ExtractedRecord, index: number) {
  return row.id || `${row.registerName}:${index + 1}`;
}

function compareRegister(registerName: RegisterName, expected: ExpectedRecord[], extracted: ExtractedRecord[]) {
  const expectedRows = expected.filter((row) => row.registerName === registerName);
  const extractedRows = extracted.filter((row) => row.registerName === registerName);
  const qualities = expectedRows.map((expectedRow) => extractedRows.map((extractedRow) => candidateQuality(expectedRow, extractedRow)));
  // Lexicographic objective: match COUNT first, quality second. Every acceptable pair is worth
  // MATCH_BONUS, which is strictly greater than the total quality any assignment can accumulate
  // (quality <= MAX_QUALITY per pair, at most `size` pairs), so the optimiser can never trade a
  // match away for a better-scoring one. Unacceptable pairs are worth 0 and are discarded below.
  const size = Math.max(expectedRows.length, extractedRows.length);
  const matchBonus = MAX_QUALITY * (size + 1);
  const assignment = optimalAssignment(qualities.map((row) => row.map((quality) => quality.acceptable ? matchBonus + quality.quality : 0)));
  const matchedExpected = new Set<number>();
  const matchedExtracted = new Set<number>();
  const matches: MatchRecord[] = [];

  for (let expectedIndex = 0; expectedIndex < assignment.length; expectedIndex += 1) {
    const extractedIndex = assignment[expectedIndex];
    if (extractedIndex < 0) continue;
    const quality = qualities[expectedIndex][extractedIndex];
    if (!quality.acceptable) continue;
    const expectedRow = expectedRows[expectedIndex];
    const selected = extractedRows[extractedIndex];
    matchedExpected.add(expectedIndex);
    matchedExtracted.add(extractedIndex);
    const fieldMismatches: string[] = [];
    const statusDifference = Boolean(expectedRow.status || selected.status) && normalize(expectedRow.status) !== normalize(selected.status);
    const sourceAnchorDifference = (expectedRow.anchors.length > 0 || selected.anchors.length > 0) && !anchorsOverlap(expectedRow.anchors, selected.anchors);
    const workPackageTagDifference = Boolean(expectedRow.workPackageId || expectedRow.workPackageName || selected.workPackageId || selected.workPackageName) && normalize(`${expectedRow.workPackageId} ${expectedRow.workPackageName}`) !== normalize(`${selected.workPackageId} ${selected.workPackageName}`);
    if (normalize(expectedRow.title) !== normalize(selected.title)) fieldMismatches.push('title/text');
    if (statusDifference) fieldMismatches.push('status');
    if (sourceAnchorDifference) fieldMismatches.push('source_anchor');
    if (workPackageTagDifference) fieldMismatches.push('work_package');
    matches.push({ expectedId: recordLabel(expectedRow, expectedIndex), extractedId: recordLabel(selected, extractedIndex), status: quality.idMatch && normalize(expectedRow.title) === normalize(selected.title) ? 'exact' : 'semantic', alignment: quality.alignment, score: Number(quality.semanticScore.toFixed(3)), fieldMismatches, statusDifference, sourceAnchorDifference, workPackageTagDifference });
  }

  const missingIndexes = expectedRows.map((_, index) => index).filter((index) => !matchedExpected.has(index));
  const additionalIndexes = extractedRows.map((_, index) => index).filter((index) => !matchedExtracted.has(index));
  const classifications = {
    genuineMisses: [] as DifferenceClassification[],
    genuineAdditions: [] as DifferenceClassification[],
    alternativeDecompositions: [] as DifferenceClassification[],
    possibleDuplicates: [] as DifferenceClassification[],
    benchmarkDisagreements: [] as DifferenceClassification[],
  };

  for (const expectedIndex of missingIndexes) {
    const expectedRow = expectedRows[expectedIndex];
    const crossRegister = extracted.filter((row) => row.registerName !== registerName && (anchorsOverlap(expectedRow.anchors, row.anchors) || similarity(expectedRow.text, row.text) >= CROSS_REGISTER_DICE));
    const decomposition = extractedRows.filter((row) => candidateQuality(expectedRow, row).related);
    if (crossRegister.length > 0) classifications.benchmarkDisagreements.push({ expectedId: recordLabel(expectedRow, expectedIndex), extractedIds: crossRegister.map(recordLabel), reason: 'Strong evidence aligned to a different register category.' });
    else if (decomposition.length >= 2) classifications.alternativeDecompositions.push({ expectedId: recordLabel(expectedRow, expectedIndex), extractedIds: decomposition.map(recordLabel), reason: 'Expected row appears split across multiple extracted rows.' });
    else classifications.genuineMisses.push({ expectedId: recordLabel(expectedRow, expectedIndex), reason: 'No acceptable aligned or semantic extraction was found.' });
  }

  for (const extractedIndex of additionalIndexes) {
    const extractedRow = extractedRows[extractedIndex];
    const crossRegister = expected.filter((row) => row.registerName !== registerName && (anchorsOverlap(row.anchors, extractedRow.anchors) || similarity(row.text, extractedRow.text) >= CROSS_REGISTER_DICE));
    // A shared anchor alone is not duplication: one source segment normally yields several items.
    // Duplication needs the two rows to also say a related thing, or to be near-identical outright.
    const duplicateOf = extractedRows.find((row, index) => index !== extractedIndex && ((anchorsOverlap(row.anchors, extractedRow.anchors) && candidateQuality(row, extractedRow).related) || similarity(row.text, extractedRow.text) >= 0.8));
    const relatedExpected = expectedRows.find((row) => candidateQuality(row, extractedRow).related);
    if (crossRegister.length > 0) classifications.benchmarkDisagreements.push({ extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'Extracted evidence strongly aligns to a benchmark row in another register category.' });
    else if (duplicateOf) classifications.possibleDuplicates.push({ extractedIds: [recordLabel(extractedRow, extractedIndex), recordLabel(duplicateOf, extractedRows.indexOf(duplicateOf))], reason: 'Additional extraction is strongly similar to another extracted row or shares its canonical anchor.' });
    else if (relatedExpected) classifications.alternativeDecompositions.push({ expectedId: recordLabel(relatedExpected, expectedRows.indexOf(relatedExpected)), extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'Additional extraction may be an alternative decomposition of a matched benchmark row.' });
    else classifications.genuineAdditions.push({ extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'No corresponding benchmark fact was found.' });
  }

  const facts = measureFactRecall(expectedRows, extractedRows);
  const exactMatches = matches.filter((match) => match.status === 'exact').length;
  const semanticMatches = matches.filter((match) => match.status === 'semantic').length;
  const fieldLevelMismatches = matches.reduce((total, match) => total + match.fieldMismatches.length, 0);
  // Empty registers report honestly. A register with nothing proposed has no precision, a register
  // with no benchmark rows has no recall, and a register with no measurable benchmark facts has no
  // fact recall. Previously all three returned 1.000, so eight of nine register rows in a typical
  // report read as perfect scores for registers that were never compared.
  const precision = extractedRows.length === 0 ? null : matches.length / extractedRows.length;
  const registerRowRecall = expectedRows.length === 0 ? null : matches.length / expectedRows.length;
  const distinctFactRecall = facts.expected === 0 ? null : facts.recalled / facts.expected;
  const missingItems = missingIndexes.map((index) => recordLabel(expectedRows[index], index));
  const additionalItems = additionalIndexes.map((index) => recordLabel(extractedRows[index], index));

  // Supersession and state reversal are two measurements, checked on EVERY benchmark row rather
  // than only on unmatched ones: a matched row that dropped its supersession link is exactly the
  // failure these metrics exist to catch, and it used to be invisible.
  const matchedExtractedFor = new Map<number, ExtractedRecord>();
  for (let expectedIndex = 0; expectedIndex < assignment.length; expectedIndex += 1) {
    if (matchedExpected.has(expectedIndex)) matchedExtractedFor.set(expectedIndex, extractedRows[assignment[expectedIndex]]);
  }
  const droppedSupersessions: string[] = [];
  const droppedStateReversals: string[] = [];
  for (let expectedIndex = 0; expectedIndex < expectedRows.length; expectedIndex += 1) {
    const expectedRow = expectedRows[expectedIndex];
    const links = structuredSupersessionIds(expectedRow.row);
    const isReversal = REVERSAL_STATUS.test(expectedRow.status);
    if (links.length === 0 && !isReversal) continue;
    const label = recordLabel(expectedRow, expectedIndex);
    const selected = matchedExtractedFor.get(expectedIndex) ?? null;
    const reproducedLinks = selected ? structuredSupersessionIds(selected.row) : [];
    const supersessionDropped = links.length > 0 && !links.some((link) => reproducedLinks.some((value) => normalize(value) === normalize(link)));
    const reversalDropped = isReversal && (selected === null || normalize(selected.status) !== normalize(expectedRow.status));
    if (supersessionDropped) droppedSupersessions.push(label);
    if (supersessionDropped || reversalDropped) droppedStateReversals.push(label);
  }
  const applicable = expectedRows.length > 0 || extractedRows.length > 0;
  return {
    registerName,
    applicable,
    expectedRows: expectedRows.length,
    extractedRows: extractedRows.length,
    expectedDistinctFacts: facts.expected,
    recalledDistinctFacts: facts.recalled,
    exactMatches,
    semanticMatches,
    missingItems,
    additionalItems,
    fieldLevelMismatches,
    statusDifferences: matches.filter((match) => match.statusDifference).length,
    sourceAnchorDifferences: matches.filter((match) => match.sourceAnchorDifference).length,
    missedUncertainty: registerName === 'Uncertainty' ? missingItems.length : 0,
    missedStructuredSupersessions: droppedSupersessions.length,
    missedStructuredSupersessionIds: droppedSupersessions,
    missedStateReversalsOrSupersessions: droppedStateReversals.length,
    missedStateReversalOrSupersessionIds: droppedStateReversals,
    incorrectEntityConflation: registerName === 'Entities' ? classifications.possibleDuplicates.length : 0,
    hypotheticalEntitiesTreatedAsReal: registerName === 'Entities' ? extractedRows.filter((row) => /hypothetical|possible|maybe|unknown/i.test(row.text)).length : 0,
    workPackageTagDifferences: matches.filter((match) => match.workPackageTagDifference).length,
    // `precision` / `recall` / `registerRowRecall` / `distinctFactRecall` stay numeric because the
    // Cockpit renders them with `.toFixed(3)`. `0` here means "not measurable", never "perfect";
    // `metrics` and the `*Applicable` flags carry the honest not-applicable marker.
    precision: Number((precision ?? 0).toFixed(3)),
    recall: Number((registerRowRecall ?? 0).toFixed(3)),
    registerRowRecall: Number((registerRowRecall ?? 0).toFixed(3)),
    distinctFactRecall: Number((distinctFactRecall ?? 0).toFixed(3)),
    precisionApplicable: precision !== null,
    rowRecallApplicable: registerRowRecall !== null,
    factRecallApplicable: distinctFactRecall !== null,
    metrics: {
      precision: precision === null ? null : Number(precision.toFixed(3)),
      registerRowRecall: registerRowRecall === null ? null : Number(registerRowRecall.toFixed(3)),
      distinctFactRecall: distinctFactRecall === null ? null : Number(distinctFactRecall.toFixed(3)),
    },
    classifications,
    matches,
  };
}

/** `n/a` is printed for a metric with no denominator — never 1.000. */
function metricCell(value: number | null) {
  return value === null ? 'n/a' : value.toFixed(3);
}

function makeMarkdown(summary: ReturnType<typeof compareRegister>[], hashes: { frozenPacketHash: string; expectedDeltaHash: string; expectedWorkbookHash: string | null }) {
  const lines = ['# Benchmark-Informed Extraction Comparison', '', 'Mode: benchmark-informed', `Frozen packet SHA-256: ${hashes.frozenPacketHash}`, `Expected delta SHA-256: ${hashes.expectedDeltaHash}`];
  if (hashes.expectedWorkbookHash) lines.push(`Expected workbook SHA-256: ${hashes.expectedWorkbookHash}`);
  lines.push('', '| Register | Expected | Extracted | Exact | Semantic | Missing | Additional | Field mismatches | Status diff | Anchor diff | WP diff | Precision | Row recall | Fact recall |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summary) {
    lines.push(`| ${row.registerName} | ${row.expectedRows} | ${row.extractedRows} | ${row.exactMatches} | ${row.semanticMatches} | ${row.missingItems.length} | ${row.additionalItems.length} | ${row.fieldLevelMismatches} | ${row.statusDifferences} | ${row.sourceAnchorDifferences} | ${row.workPackageTagDifferences} | ${metricCell(row.metrics.precision)} | ${metricCell(row.metrics.registerRowRecall)} | ${metricCell(row.metrics.distinctFactRecall)} |`);
  }
  lines.push('', '## Detailed Differences');
  for (const row of summary) {
    lines.push('', `### ${row.registerName}`, `- Comparable: ${row.applicable ? 'yes' : 'no (no benchmark rows and no extracted rows)'}`, `- Missing item IDs: ${row.missingItems.length ? row.missingItems.join(', ') : 'None'}`, `- Additional item IDs: ${row.additionalItems.length ? row.additionalItems.join(', ') : 'None'}`, `- Genuine misses: ${row.classifications.genuineMisses.length}`, `- Alternative decompositions: ${row.classifications.alternativeDecompositions.length}`, `- Possible duplicates: ${row.classifications.possibleDuplicates.length}`, `- Genuine additions: ${row.classifications.genuineAdditions.length}`, `- Benchmark disagreements: ${row.classifications.benchmarkDisagreements.length}`, `- Missed uncertainty: ${row.missedUncertainty}`, `- Missed structured supersessions: ${row.missedStructuredSupersessions}${row.missedStructuredSupersessionIds.length ? ` (${row.missedStructuredSupersessionIds.join(', ')})` : ''}`, `- Missed state reversals or supersessions: ${row.missedStateReversalsOrSupersessions}${row.missedStateReversalOrSupersessionIds.length ? ` (${row.missedStateReversalOrSupersessionIds.join(', ')})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildComparison(frozen: ReturnType<typeof parseFrozen>, expected: ExpectedRecord[], hashes: { frozenPacketHash: string; expectedDeltaHash: string; expectedWorkbookHash: string | null }) {
  const summary = registerNames.map((name) => compareRegister(name, expected, frozen.rows));
  const totalExpected = summary.reduce((total, row) => total + row.expectedRows, 0);
  const totalExtracted = summary.reduce((total, row) => total + row.extractedRows, 0);
  const totalMatches = summary.reduce((total, row) => total + row.exactMatches + row.semanticMatches, 0);
  const totalMissing = summary.reduce((total, row) => total + row.missingItems.length, 0);
  const totalAdditional = summary.reduce((total, row) => total + row.additionalItems.length, 0);
  // The headline fact figure — the number A21 (>= 70% fact-level recall) is stated in — is measured
  // over a GLOBALLY deduplicated fact set: one entry per distinct normalised value across the whole
  // benchmark, not per register and not per row. Summing the per-register counts would count a value
  // shared by two registers twice, so the totals are measured directly rather than summed.
  const globalFacts = measureFactRecall(expected, frozen.rows);
  const totalExpectedFacts = globalFacts.expected;
  const totalRecalledFacts = globalFacts.recalled;
  const precisionValue = totalExtracted === 0 ? null : Number((totalMatches / totalExtracted).toFixed(3));
  const rowRecallValue = totalExpected === 0 ? null : Number((totalMatches / totalExpected).toFixed(3));
  const factRecallValue = totalExpectedFacts === 0 ? null : Number((totalRecalledFacts / totalExpectedFacts).toFixed(3));
  const overallPrecision = precisionValue ?? 0;
  const registerRowRecall = rowRecallValue ?? 0;
  const distinctFactRecall = factRecallValue ?? 0;
  const comparisonStatus = totalMissing === 0 && totalAdditional === 0 && summary.every((row) => row.fieldLevelMismatches === 0) ? 'passed' : 'differences-found';
  const report = {
    benchmarkMode: 'benchmark-informed' as const,
    frozenPacketHash: hashes.frozenPacketHash,
    expectedDeltaHash: hashes.expectedDeltaHash,
    expectedWorkbookHash: hashes.expectedWorkbookHash,
    frozenSourceHash: frozen.sourceHash,
    provider: frozen.provider,
    model: frozen.model,
    generatedAt: frozen.generatedAt,
    calibration: { nearRestatementDice: NEAR_RESTATEMENT_DICE, phraseSupportedDice: PHRASE_SUPPORTED_DICE, minSharedTokens: MIN_SHARED_TOKENS, alignedFloorDice: ALIGNED_FLOOR_DICE, factRecallDice: FACT_RECALL_DICE, minFactCharacters: MIN_FACT_CHARS, minFactParts: MIN_FACT_PARTS, factDedupeKey: 'normalised scalar value, deduplicated globally' },
    totals: {
      expectedRows: totalExpected,
      extractedRows: totalExtracted,
      expectedDistinctFacts: totalExpectedFacts,
      recalledDistinctFacts: totalRecalledFacts,
      exactMatches: summary.reduce((total, row) => total + row.exactMatches, 0),
      semanticMatches: summary.reduce((total, row) => total + row.semanticMatches, 0),
      missingItems: totalMissing,
      additionalItems: totalAdditional,
      precision: overallPrecision,
      recall: registerRowRecall,
      registerRowRecall,
      distinctFactRecall,
      precisionApplicable: precisionValue !== null,
      rowRecallApplicable: rowRecallValue !== null,
      factRecallApplicable: factRecallValue !== null,
      metrics: { precision: precisionValue, registerRowRecall: rowRecallValue, distinctFactRecall: factRecallValue },
    },
    registers: summary,
  };
  return { comparisonStatus, report, markdown: makeMarkdown(summary, hashes), summary, totalExpected, totalMatches, totalMissing, totalAdditional, overallPrecision, registerRowRecall };
}

export function compareBenchmarkInformedExtraction(frozenPacket: unknown, expectedPacket: unknown) {
  const frozenText = JSON.stringify(frozenPacket);
  const expectedText = JSON.stringify(expectedPacket);
  return buildComparison(parseFrozen(frozenText), parseExpected(expectedText), { frozenPacketHash: hashBytes(Buffer.from(frozenText)), expectedDeltaHash: hashBytes(Buffer.from(expectedText)), expectedWorkbookHash: null });
}

export function compareBlindExtractionToBenchmark(db: DatabaseSync, projectId: string, input: BlindExtractionComparisonInput) {
  const frozenBytes = Buffer.from(input.frozenPacketFile.dataBase64, 'base64');
  const expectedBytes = Buffer.from(input.expectedDeltaFile.dataBase64, 'base64');
  const frozenPacketHash = hashBytes(frozenBytes);
  const expectedDeltaHash = hashBytes(expectedBytes);
  const expectedWorkbookHash = input.expectedWorkbookFile ? hashBytes(Buffer.from(input.expectedWorkbookFile.dataBase64, 'base64')) : null;
  const comparison = buildComparison(parseFrozen(frozenBytes.toString('utf8')), parseExpected(expectedBytes.toString('utf8')), { frozenPacketHash, expectedDeltaHash, expectedWorkbookHash });
  const { comparisonStatus, report, markdown, summary, totalExpected, totalMatches, totalMissing, totalAdditional, overallPrecision, registerRowRecall } = comparison;
  const timestamp = nowIso();
  const id = `blind-comparison:${projectId}:${frozenPacketHash.slice(0, 12)}:${expectedDeltaHash.slice(0, 12)}`;
  const proposed = db.prepare('SELECT id FROM proposed_changes WHERE project_id = ? AND id = ?').get(projectId, `proposed:${projectId}:${frozenPacketHash.slice(0, 16)}`) as { id: string } | undefined;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO blind_extraction_comparison_reports (id, project_id, proposed_change_id, frozen_packet_hash, expected_delta_hash, expected_workbook_hash, comparison_status, summary_json, report_markdown, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, frozen_packet_hash, expected_delta_hash) DO UPDATE SET proposed_change_id = excluded.proposed_change_id, expected_workbook_hash = excluded.expected_workbook_hash, comparison_status = excluded.comparison_status, summary_json = excluded.summary_json, report_markdown = excluded.report_markdown, created_at = excluded.created_at, created_by = excluded.created_by')
      .run(id, projectId, proposed?.id ?? null, frozenPacketHash, expectedDeltaHash, expectedWorkbookHash, comparisonStatus, JSON.stringify(report), markdown, timestamp, 'Project ManagAIr');
    const writeId = `ai-write:${id}`;
    db.prepare('INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET write_status = excluded.write_status, verification_status = excluded.verification_status, verification_method = excluded.verification_method, last_attempt_at = excluded.last_attempt_at, verified_at = excluded.verified_at, verified_by = excluded.verified_by, status_detail = excluded.status_detail, attention_owner = excluded.attention_owner')
      .run(writeId, projectId, 'Benchmark-informed extraction comparison', 'blind-comparison', id, 'complete', comparisonStatus === 'passed' ? 'verified' : 'failed', 'benchmark-informed-extraction-comparison', timestamp, timestamp, 'Project ManagAIr', `${totalMatches}/${totalExpected} expected rows matched; precision ${metricCell(report.totals.metrics.precision)}, row recall ${metricCell(report.totals.metrics.registerRowRecall)}, fact recall ${metricCell(report.totals.metrics.distinctFactRecall)}.`, comparisonStatus === 'passed' ? null : 'current-user', 'operational-reference');
    db.prepare('INSERT INTO verifications (id, project_id, ai_write_id, verification_status, method, checked_at, checked_by, summary, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, writeId, comparisonStatus === 'passed' ? 'verified' : 'failed', 'benchmark-informed-extraction-comparison', timestamp, 'Project ManagAIr', `${totalMissing} missing, ${totalAdditional} additional, ${summary.reduce((total, row) => total + row.fieldLevelMismatches, 0)} field-level mismatches.`, 'operational-reference');
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'ai', 'Benchmark-informed extraction comparison completed and report retained in Cockpit.', 'Project ManagAIr', 'blind-comparison', id, 'operational-reference');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { id, comparisonStatus, report };
}

export function readBlindExtractionComparisonReports(db: DatabaseSync, projectId: string) {
  const rows = db.prepare('SELECT * FROM blind_extraction_comparison_reports WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    projectId,
    proposedChangeId: row.proposed_change_id ? String(row.proposed_change_id) : null,
    frozenPacketHash: String(row.frozen_packet_hash),
    expectedDeltaHash: String(row.expected_delta_hash),
    expectedWorkbookHash: row.expected_workbook_hash ? String(row.expected_workbook_hash) : null,
    comparisonStatus: String(row.comparison_status),
    summary: JSON.parse(String(row.summary_json)) as unknown,
    reportMarkdown: String(row.report_markdown),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
  }));
}
