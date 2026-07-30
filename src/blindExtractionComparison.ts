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
  change_request: 'Config_Changes',
  open_question: 'Open_Questions',
  milestone: 'Milestones',
  stakeholder: 'Entities',
  source_metadata: 'Sources',
};
const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'rather', 'should', 'the', 'to', 'use', 'with']);

export interface BlindExtractionComparisonInput {
  frozenPacketFile: FileInput;
  expectedDeltaFile: FileInput;
  expectedWorkbookFile?: FileInput;
}

interface ExpectedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
interface ExtractedRecord { id: string; registerName: RegisterName; title: string; status: string; sourceRef: string; anchor: string; workPackageId: string; workPackageName: string; row: JsonObject; text: string }
interface MatchRecord { expectedId: string; extractedId: string; status: 'exact' | 'semantic'; score: number; fieldMismatches: string[]; statusDifference: boolean; sourceAnchorDifference: boolean; workPackageTagDifference: boolean }

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
  return intersection / Math.max(aTokens.size, bTokens.size);
}

function parseExpected(raw: string): ExpectedRecord[] {
  const packet = asObject(JSON.parse(raw) as unknown, 'Expected delta packet');
  const sheets = asObject(packet.sheets, 'Expected delta sheets');
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
        anchor: rowValue(row, ['anchor', 'source_anchor']),
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
        anchor: rowValue(row, ['anchor', 'source_anchor', 'sourceAnchor']),
        workPackageId: rowValue(row, ['work_package_id', 'workPackageId']),
        workPackageName: rowValue(row, ['work_package_name', 'workPackageName']),
        row,
        text: [title, summary, body].filter(Boolean).join(' '),
      } satisfies ExtractedRecord;
    }).filter((row): row is ExtractedRecord => Boolean(row)),
  };
}

function compareRegister(registerName: RegisterName, expected: ExpectedRecord[], extracted: ExtractedRecord[]) {
  const expectedRows = expected.filter((row) => row.registerName === registerName);
  const extractedRows = extracted.filter((row) => row.registerName === registerName);
  const matchedExtracted = new Set<string>();
  const matches: MatchRecord[] = [];
  const missing: string[] = [];

  for (const expectedRow of expectedRows) {
    const exact = extractedRows.find((row) => row.id === expectedRow.id && normalize(row.title) === normalize(expectedRow.title));
    let selected = exact;
    let status: 'exact' | 'semantic' = 'exact';
    let score = exact ? 1 : 0;
    if (!selected) {
      const candidates = extractedRows.filter((row) => !matchedExtracted.has(row.id)).map((row) => ({ row, score: Math.max(similarity(expectedRow.title, row.title), similarity(expectedRow.text, row.text)) })).sort((a, b) => b.score - a.score);
      if (candidates[0] && candidates[0].score >= 0.22) {
        selected = candidates[0].row;
        score = candidates[0].score;
        status = 'semantic';
      }
    }
    if (!selected) {
      missing.push(expectedRow.id);
      continue;
    }
    matchedExtracted.add(selected.id);
    const fieldMismatches: string[] = [];
    const statusDifference = Boolean(expectedRow.status || selected.status) && normalize(expectedRow.status) !== normalize(selected.status);
    const sourceAnchorDifference = Boolean(expectedRow.anchor || selected.anchor) && normalize(expectedRow.anchor) !== normalize(selected.anchor);
    const workPackageTagDifference = Boolean(expectedRow.workPackageId || expectedRow.workPackageName || selected.workPackageId || selected.workPackageName) && normalize(`${expectedRow.workPackageId} ${expectedRow.workPackageName}`) !== normalize(`${selected.workPackageId} ${selected.workPackageName}`);
    if (normalize(expectedRow.title) !== normalize(selected.title)) fieldMismatches.push('title/text');
    if (statusDifference) fieldMismatches.push('status');
    if (sourceAnchorDifference) fieldMismatches.push('source_anchor');
    if (workPackageTagDifference) fieldMismatches.push('work_package');
    matches.push({ expectedId: expectedRow.id, extractedId: selected.id, status, score, fieldMismatches, statusDifference, sourceAnchorDifference, workPackageTagDifference });
  }

  const additional = extractedRows.filter((row) => !matchedExtracted.has(row.id)).map((row) => row.id);
  const exactMatches = matches.filter((match) => match.status === 'exact').length;
  const semanticMatches = matches.filter((match) => match.status === 'semantic').length;
  const fieldLevelMismatches = matches.reduce((total, match) => total + match.fieldMismatches.length, 0);
  const precision = extractedRows.length === 0 ? (expectedRows.length === 0 ? 1 : 0) : matches.length / extractedRows.length;
  const recall = expectedRows.length === 0 ? 1 : matches.length / expectedRows.length;
  return {
    registerName,
    expectedRows: expectedRows.length,
    extractedRows: extractedRows.length,
    exactMatches,
    semanticMatches,
    missingItems: missing,
    additionalItems: additional,
    fieldLevelMismatches,
    statusDifferences: matches.filter((match) => match.statusDifference).length,
    sourceAnchorDifferences: matches.filter((match) => match.sourceAnchorDifference).length,
    missedUncertainty: registerName === 'Uncertainty' ? missing.length : 0,
    missedStateReversalsOrSupersessions: expectedRows.filter((row) => /supersed|revers|instead|not/i.test(row.text) && missing.includes(row.id)).length,
    incorrectEntityConflation: registerName === 'Entities' ? additional.length : 0,
    hypotheticalEntitiesTreatedAsReal: registerName === 'Entities' ? extractedRows.filter((row) => /hypothetical|possible|maybe|unknown/i.test(row.text)).length : 0,
    workPackageTagDifferences: matches.filter((match) => match.workPackageTagDifference).length,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    matches,
  };
}

function makeMarkdown(summary: ReturnType<typeof compareRegister>[], hashes: { frozenPacketHash: string; expectedDeltaHash: string; expectedWorkbookHash: string | null }) {
  const lines = ['# Blind PTW Extraction Benchmark Comparison', '', `Frozen packet SHA-256: ${hashes.frozenPacketHash}`, `Expected delta SHA-256: ${hashes.expectedDeltaHash}`];
  if (hashes.expectedWorkbookHash) lines.push(`Expected workbook SHA-256: ${hashes.expectedWorkbookHash}`);
  lines.push('', '| Register | Expected | Extracted | Exact | Semantic | Missing | Additional | Field mismatches | Status diff | Anchor diff | WP diff | Precision | Recall |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summary) {
    lines.push(`| ${row.registerName} | ${row.expectedRows} | ${row.extractedRows} | ${row.exactMatches} | ${row.semanticMatches} | ${row.missingItems.length} | ${row.additionalItems.length} | ${row.fieldLevelMismatches} | ${row.statusDifferences} | ${row.sourceAnchorDifferences} | ${row.workPackageTagDifferences} | ${row.precision.toFixed(3)} | ${row.recall.toFixed(3)} |`);
  }
  lines.push('', '## Detailed Differences');
  for (const row of summary) {
    lines.push('', `### ${row.registerName}`, `- Missing item IDs: ${row.missingItems.length ? row.missingItems.join(', ') : 'None'}`, `- Additional item IDs: ${row.additionalItems.length ? row.additionalItems.join(', ') : 'None'}`, `- Missed uncertainty: ${row.missedUncertainty}`, `- Missed state reversals or supersessions: ${row.missedStateReversalsOrSupersessions}`, `- Incorrect entity conflation: ${row.incorrectEntityConflation}`, `- Hypothetical entities treated as real: ${row.hypotheticalEntitiesTreatedAsReal}`);
  }
  return `${lines.join('\n')}\n`;
}

export function compareBlindExtractionToBenchmark(db: DatabaseSync, projectId: string, input: BlindExtractionComparisonInput) {
  const frozenBytes = Buffer.from(input.frozenPacketFile.dataBase64, 'base64');
  const expectedBytes = Buffer.from(input.expectedDeltaFile.dataBase64, 'base64');
  const frozenPacketHash = hashBytes(frozenBytes);
  const expectedDeltaHash = hashBytes(expectedBytes);
  const expectedWorkbookHash = input.expectedWorkbookFile ? hashBytes(Buffer.from(input.expectedWorkbookFile.dataBase64, 'base64')) : null;
  const frozen = parseFrozen(frozenBytes.toString('utf8'));
  const expected = parseExpected(expectedBytes.toString('utf8'));
  const summary = registerNames.map((name) => compareRegister(name, expected, frozen.rows));
  const totalExpected = summary.reduce((total, row) => total + row.expectedRows, 0);
  const totalExtracted = summary.reduce((total, row) => total + row.extractedRows, 0);
  const totalMatches = summary.reduce((total, row) => total + row.exactMatches + row.semanticMatches, 0);
  const totalMissing = summary.reduce((total, row) => total + row.missingItems.length, 0);
  const totalAdditional = summary.reduce((total, row) => total + row.additionalItems.length, 0);
  const overallPrecision = totalExtracted === 0 ? 0 : Number((totalMatches / totalExtracted).toFixed(3));
  const overallRecall = totalExpected === 0 ? 0 : Number((totalMatches / totalExpected).toFixed(3));
  const comparisonStatus = totalMissing === 0 && totalAdditional === 0 && summary.every((row) => row.fieldLevelMismatches === 0) ? 'passed' : 'differences-found';
  const report = { frozenPacketHash, expectedDeltaHash, expectedWorkbookHash, frozenSourceHash: frozen.sourceHash, provider: frozen.provider, model: frozen.model, generatedAt: frozen.generatedAt, totals: { expectedRows: totalExpected, extractedRows: totalExtracted, exactMatches: summary.reduce((total, row) => total + row.exactMatches, 0), semanticMatches: summary.reduce((total, row) => total + row.semanticMatches, 0), missingItems: totalMissing, additionalItems: totalAdditional, precision: overallPrecision, recall: overallRecall }, registers: summary };
  const markdown = makeMarkdown(summary, { frozenPacketHash, expectedDeltaHash, expectedWorkbookHash });
  const timestamp = nowIso();
  const id = `blind-comparison:${projectId}:${frozenPacketHash.slice(0, 12)}:${expectedDeltaHash.slice(0, 12)}`;
  const proposed = db.prepare('SELECT id FROM proposed_changes WHERE project_id = ? AND payload_json LIKE ? ORDER BY created_at DESC').get(projectId, `%${frozenPacketHash}%`) as { id: string } | undefined;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO blind_extraction_comparison_reports (id, project_id, proposed_change_id, frozen_packet_hash, expected_delta_hash, expected_workbook_hash, comparison_status, summary_json, report_markdown, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, frozen_packet_hash, expected_delta_hash) DO UPDATE SET proposed_change_id = excluded.proposed_change_id, expected_workbook_hash = excluded.expected_workbook_hash, comparison_status = excluded.comparison_status, summary_json = excluded.summary_json, report_markdown = excluded.report_markdown, created_at = excluded.created_at, created_by = excluded.created_by')
      .run(id, projectId, proposed?.id ?? null, frozenPacketHash, expectedDeltaHash, expectedWorkbookHash, comparisonStatus, JSON.stringify(report), markdown, timestamp, 'Project ManagAIr');
    const writeId = `ai-write:${id}`;
    db.prepare('INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET write_status = excluded.write_status, verification_status = excluded.verification_status, verification_method = excluded.verification_method, last_attempt_at = excluded.last_attempt_at, verified_at = excluded.verified_at, verified_by = excluded.verified_by, status_detail = excluded.status_detail, attention_owner = excluded.attention_owner')
      .run(writeId, projectId, 'Blind PTW benchmark comparison', 'blind-comparison', id, 'complete', comparisonStatus === 'passed' ? 'verified' : 'failed', 'sealed-benchmark-delta-comparison', timestamp, timestamp, 'Project ManagAIr', `${totalMatches}/${totalExpected} expected rows matched; precision ${overallPrecision.toFixed(3)}, recall ${overallRecall.toFixed(3)}.`, comparisonStatus === 'passed' ? null : 'current-user', 'operational-reference');
    db.prepare('INSERT INTO verifications (id, project_id, ai_write_id, verification_status, method, checked_at, checked_by, summary, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, writeId, comparisonStatus === 'passed' ? 'verified' : 'failed', 'sealed-benchmark-delta-comparison', timestamp, 'Project ManagAIr', `${totalMissing} missing, ${totalAdditional} additional, ${summary.reduce((total, row) => total + row.fieldLevelMismatches, 0)} field-level mismatches.`, 'operational-reference');
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'ai', 'Sealed PTW benchmark comparison completed and report retained in Cockpit.', 'Project ManagAIr', 'blind-comparison', id, 'operational-reference');
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
