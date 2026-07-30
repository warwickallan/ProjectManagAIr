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

interface ExpectedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
interface ExtractedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
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

function nestedObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function canonicalAnchor(row: JsonObject): string {
  const direct = rowValue(row, ['anchor', 'source_anchor', 'sourceAnchor', 'segment_id', 'segmentId']);
  if (direct) return direct;
  const evidence = nestedObject(row.evidence);
  if (evidence) {
    const value = rowValue(evidence, ['anchor', 'source_anchor', 'segment_id', 'segmentId']);
    if (value) return value;
  }
  const anchors = Array.isArray(row.anchors) ? row.anchors : [];
  const first = anchors[0];
  if (typeof first === 'string') return first;
  const firstObject = nestedObject(first);
  return firstObject ? rowValue(firstObject, ['anchor', 'source_anchor', 'segment_id', 'segmentId']) : '';
}

const factMetadataKeys = new Set([
  'id', 'decision_id', 'action_id', 'raid_id', 'config_id', 'q_id', 'milestone_id', 'entity_id', 'source_id', 'u_id',
  'source_ref', 'source_anchor', 'anchor', 'row_number', 'original_row_number', 'tab_name', 'register_name',
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
  const value = rowValue(row, ['supersession_ids', 'supersedes', 'superseded_by', 'supersedes_links']);
  return value ? value.split(/[;,]/).map((part) => part.trim()).filter(Boolean) : [];
}

function factIsRecalled(fact: string, rows: ExtractedRecord[]) {
  return rows.some((row) => factValues(row.row).some((candidate) => candidate === fact || candidate.includes(fact) || fact.includes(candidate) || similarity(fact, candidate) >= 0.75));
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
      rows.push({
        id,
        registerName,
        title,
        status: rowValue(row, ['status']),
        sourceRef: rowValue(row, ['source_ref']),
        anchor: canonicalAnchor(row),
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
      return {
        id: rowValue(row, ['id']),
        registerName,
        title,
        status: rowValue(row, ['status']),
        sourceRef: rowValue(row, ['source_ref', 'sourceRef']),
        anchor: canonicalAnchor(row),
        workPackageId: rowValue(row, ['work_package_id', 'workPackageId']),
        workPackageName: rowValue(row, ['work_package_name', 'workPackageName']),
        row,
        text: [title, summary, body].filter(Boolean).join(' '),
      } satisfies ExtractedRecord;
    }).filter((row): row is ExtractedRecord => Boolean(row)),
  };
}

function candidateQuality(expected: ExpectedRecord, extracted: ExtractedRecord) {
  const anchorMatch = Boolean(expected.anchor && extracted.anchor) && normalize(expected.anchor) === normalize(extracted.anchor);
  const idMatch = Boolean(expected.id && extracted.id) && normalize(expected.id) === normalize(extracted.id);
  const semanticScore = Math.max(similarity(expected.title, extracted.title), similarity(expected.text, extracted.text));
  return {
    acceptable: anchorMatch || idMatch || semanticScore >= 0.22,
    alignment: anchorMatch ? 'canonical-anchor' as const : idMatch ? 'durable-id' as const : 'semantic' as const,
    anchorMatch,
    idMatch,
    semanticScore,
    weight: (anchorMatch ? 4 : 0) + (idMatch ? 2 : 0) + semanticScore,
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
  const assignment = optimalAssignment(qualities.map((row) => row.map((quality) => quality.acceptable ? quality.weight : 0)));
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
    const sourceAnchorDifference = Boolean(expectedRow.anchor || selected.anchor) && normalize(expectedRow.anchor) !== normalize(selected.anchor);
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
    const crossRegister = extracted.filter((row) => row.registerName !== registerName && ((expectedRow.anchor && row.anchor && normalize(expectedRow.anchor) === normalize(row.anchor)) || similarity(expectedRow.text, row.text) >= 0.7));
    const decomposition = extractedRows.filter((row) => candidateQuality(expectedRow, row).semanticScore >= 0.18);
    if (crossRegister.length > 0) classifications.benchmarkDisagreements.push({ expectedId: recordLabel(expectedRow, expectedIndex), extractedIds: crossRegister.map(recordLabel), reason: 'Strong evidence aligned to a different register category.' });
    else if (decomposition.length >= 2) classifications.alternativeDecompositions.push({ expectedId: recordLabel(expectedRow, expectedIndex), extractedIds: decomposition.map(recordLabel), reason: 'Expected row appears split across multiple extracted rows.' });
    else classifications.genuineMisses.push({ expectedId: recordLabel(expectedRow, expectedIndex), reason: 'No acceptable aligned or semantic extraction was found.' });
  }

  for (const extractedIndex of additionalIndexes) {
    const extractedRow = extractedRows[extractedIndex];
    const crossRegister = expected.filter((row) => row.registerName !== registerName && ((row.anchor && extractedRow.anchor && normalize(row.anchor) === normalize(extractedRow.anchor)) || similarity(row.text, extractedRow.text) >= 0.7));
    const duplicateOf = extractedRows.find((row, index) => index !== extractedIndex && ((row.anchor && extractedRow.anchor && normalize(row.anchor) === normalize(extractedRow.anchor)) || similarity(row.text, extractedRow.text) >= 0.8));
    const relatedExpected = expectedRows.find((row) => candidateQuality(row, extractedRow).semanticScore >= 0.22);
    if (crossRegister.length > 0) classifications.benchmarkDisagreements.push({ extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'Extracted evidence strongly aligns to a benchmark row in another register category.' });
    else if (duplicateOf) classifications.possibleDuplicates.push({ extractedIds: [recordLabel(extractedRow, extractedIndex), recordLabel(duplicateOf, extractedRows.indexOf(duplicateOf))], reason: 'Additional extraction is strongly similar to another extracted row or shares its canonical anchor.' });
    else if (relatedExpected) classifications.alternativeDecompositions.push({ expectedId: recordLabel(relatedExpected, expectedRows.indexOf(relatedExpected)), extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'Additional extraction may be an alternative decomposition of a matched benchmark row.' });
    else classifications.genuineAdditions.push({ extractedIds: [recordLabel(extractedRow, extractedIndex)], reason: 'No corresponding benchmark fact was found.' });
  }

  const expectedFacts = expectedRows.flatMap((row) => factValues(row.row));
  const recalledFacts = expectedFacts.filter((fact) => factIsRecalled(fact, extractedRows)).length;
  const exactMatches = matches.filter((match) => match.status === 'exact').length;
  const semanticMatches = matches.filter((match) => match.status === 'semantic').length;
  const fieldLevelMismatches = matches.reduce((total, match) => total + match.fieldMismatches.length, 0);
  const precision = extractedRows.length === 0 ? (expectedRows.length === 0 ? 1 : 0) : matches.length / extractedRows.length;
  const registerRowRecall = expectedRows.length === 0 ? 1 : matches.length / expectedRows.length;
  const distinctFactRecall = expectedFacts.length === 0 ? 1 : recalledFacts / expectedFacts.length;
  const missingItems = missingIndexes.map((index) => recordLabel(expectedRows[index], index));
  const additionalItems = additionalIndexes.map((index) => recordLabel(extractedRows[index], index));
  const missedStructuredSupersessions = missingIndexes.filter((index) => structuredSupersessionIds(expectedRows[index].row).length > 0).length;
  return { registerName, expectedRows: expectedRows.length, extractedRows: extractedRows.length, expectedDistinctFacts: expectedFacts.length, recalledDistinctFacts: recalledFacts, exactMatches, semanticMatches, missingItems, additionalItems, fieldLevelMismatches, statusDifferences: matches.filter((match) => match.statusDifference).length, sourceAnchorDifferences: matches.filter((match) => match.sourceAnchorDifference).length, missedUncertainty: registerName === 'Uncertainty' ? missingItems.length : 0, missedStructuredSupersessions, missedStateReversalsOrSupersessions: missedStructuredSupersessions, incorrectEntityConflation: registerName === 'Entities' ? classifications.possibleDuplicates.length : 0, hypotheticalEntitiesTreatedAsReal: registerName === 'Entities' ? extractedRows.filter((row) => /hypothetical|possible|maybe|unknown/i.test(row.text)).length : 0, workPackageTagDifferences: matches.filter((match) => match.workPackageTagDifference).length, precision: Number(precision.toFixed(3)), recall: Number(registerRowRecall.toFixed(3)), registerRowRecall: Number(registerRowRecall.toFixed(3)), distinctFactRecall: Number(distinctFactRecall.toFixed(3)), classifications, matches };
}

function makeMarkdown(summary: ReturnType<typeof compareRegister>[], hashes: { frozenPacketHash: string; expectedDeltaHash: string; expectedWorkbookHash: string | null }) {
  const lines = ['# Benchmark-Informed Extraction Comparison', '', 'Mode: benchmark-informed', `Frozen packet SHA-256: ${hashes.frozenPacketHash}`, `Expected delta SHA-256: ${hashes.expectedDeltaHash}`];
  if (hashes.expectedWorkbookHash) lines.push(`Expected workbook SHA-256: ${hashes.expectedWorkbookHash}`);
  lines.push('', '| Register | Expected | Extracted | Exact | Semantic | Missing | Additional | Field mismatches | Status diff | Anchor diff | WP diff | Precision | Row recall | Fact recall |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summary) {
    lines.push(`| ${row.registerName} | ${row.expectedRows} | ${row.extractedRows} | ${row.exactMatches} | ${row.semanticMatches} | ${row.missingItems.length} | ${row.additionalItems.length} | ${row.fieldLevelMismatches} | ${row.statusDifferences} | ${row.sourceAnchorDifferences} | ${row.workPackageTagDifferences} | ${row.precision.toFixed(3)} | ${row.registerRowRecall.toFixed(3)} | ${row.distinctFactRecall.toFixed(3)} |`);
  }
  lines.push('', '## Detailed Differences');
  for (const row of summary) {
    lines.push('', `### ${row.registerName}`, `- Missing item IDs: ${row.missingItems.length ? row.missingItems.join(', ') : 'None'}`, `- Additional item IDs: ${row.additionalItems.length ? row.additionalItems.join(', ') : 'None'}`, `- Genuine misses: ${row.classifications.genuineMisses.length}`, `- Alternative decompositions: ${row.classifications.alternativeDecompositions.length}`, `- Possible duplicates: ${row.classifications.possibleDuplicates.length}`, `- Benchmark disagreements: ${row.classifications.benchmarkDisagreements.length}`, `- Missed uncertainty: ${row.missedUncertainty}`, `- Missed structured supersessions: ${row.missedStructuredSupersessions}`);
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
  const totalExpectedFacts = summary.reduce((total, row) => total + row.expectedDistinctFacts, 0);
  const totalRecalledFacts = summary.reduce((total, row) => total + row.recalledDistinctFacts, 0);
  const overallPrecision = totalExtracted === 0 ? 0 : Number((totalMatches / totalExtracted).toFixed(3));
  const registerRowRecall = totalExpected === 0 ? 0 : Number((totalMatches / totalExpected).toFixed(3));
  const distinctFactRecall = totalExpectedFacts === 0 ? 0 : Number((totalRecalledFacts / totalExpectedFacts).toFixed(3));
  const comparisonStatus = totalMissing === 0 && totalAdditional === 0 && summary.every((row) => row.fieldLevelMismatches === 0) ? 'passed' : 'differences-found';
  const report = { benchmarkMode: 'benchmark-informed' as const, frozenPacketHash: hashes.frozenPacketHash, expectedDeltaHash: hashes.expectedDeltaHash, expectedWorkbookHash: hashes.expectedWorkbookHash, frozenSourceHash: frozen.sourceHash, provider: frozen.provider, model: frozen.model, generatedAt: frozen.generatedAt, totals: { expectedRows: totalExpected, extractedRows: totalExtracted, expectedDistinctFacts: totalExpectedFacts, recalledDistinctFacts: totalRecalledFacts, exactMatches: summary.reduce((total, row) => total + row.exactMatches, 0), semanticMatches: summary.reduce((total, row) => total + row.semanticMatches, 0), missingItems: totalMissing, additionalItems: totalAdditional, precision: overallPrecision, recall: registerRowRecall, registerRowRecall, distinctFactRecall }, registers: summary };
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
      .run(writeId, projectId, 'Benchmark-informed extraction comparison', 'blind-comparison', id, 'complete', comparisonStatus === 'passed' ? 'verified' : 'failed', 'benchmark-informed-extraction-comparison', timestamp, timestamp, 'Project ManagAIr', `${totalMatches}/${totalExpected} expected rows matched; precision ${overallPrecision.toFixed(3)}, row recall ${registerRowRecall.toFixed(3)}, fact recall ${report.totals.distinctFactRecall.toFixed(3)}.`, comparisonStatus === 'passed' ? null : 'current-user', 'operational-reference');
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
