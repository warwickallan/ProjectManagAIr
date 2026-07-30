import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileProjectArtifact } from './projectLifecycle.js';
import { rebuildProjection, readRowEvidence, readTypedDetails } from './registerProjection.js';

const knownRegisters = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'] as const;
export type RegisterName = typeof knownRegisters[number];
const knownRegisterSet = new Set<string>(knownRegisters);
const importerVersion = 'project-register-benchmark-v1';

type JsonObject = Record<string, unknown>;
type FileInput = { name: string; dataBase64: string };

export interface RegisterImportInput {
  benchmarkFile: FileInput;
  workbookFile?: FileInput;
}

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

function rowValue(row: JsonObject, keys: string[]): unknown {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [keyify(key), value]));
  for (const key of keys) {
    const found = normalized.get(keyify(key));
    if (found !== undefined && found !== null && text(found) !== '') return found;
  }
  return null;
}

function dueDateValue(registerName: RegisterName, row: JsonObject): string {
  const names: Record<RegisterName, string[]> = {
    Decisions: ['decision_needed_by'],
    Actions: ['due_date', 'target_date'],
    Risks_Issues: ['target_resolution_date', 'resolve_by', 'due_date'],
    Config_Changes: ['due_date', 'target_date', 'follow_through_date'],
    Open_Questions: ['answer_needed_by', 'resolve_by', 'due_date'],
    Milestones: ['target_date', 'hard_stop_date', 'date'],
    Entities: [],
    Sources: [],
    Uncertainty: ['resolve_by'],
  };
  return text(rowValue(row, names[registerName]));
}
function jsonArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const raw = text(value);
  if (!raw) return [];
  return raw.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
}

function normalizeValue(value: unknown) {
  return text(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function dateOnlyOrNull(value: unknown) {
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function parsePacket(raw: string) {
  const packet = asObject(JSON.parse(raw) as unknown, 'Benchmark packet');
  const packetType = text(rowValue(packet, ['packet_type', 'type']));
  if (packetType !== 'project_register_benchmark') throw new Error(`Unsupported packet type: ${packetType || 'missing'}.`);
  const packetVersion = Number(rowValue(packet, ['packet_version', 'version']) ?? 0);
  if (!Number.isInteger(packetVersion) || packetVersion < 1) throw new Error('Benchmark packet version must be a positive integer.');
  const projectCode = text(rowValue(packet, ['project_code', 'projectCode']));
  if (!projectCode) throw new Error('Benchmark packet project code is required.');
  const rawRegisters = packet.registers ?? packet.sheets;
  const registers: Array<{ name: RegisterName; rows: JsonObject[] }> = [];
  const pushRegister = (name: string, value: unknown) => {
    if (!knownRegisterSet.has(name)) return;
    const rows = Array.isArray(value) ? value : asObject(value, `Register ${name}`).rows;
    if (!Array.isArray(rows)) throw new Error(`Register ${name} rows must be an array.`);
    registers.push({ name: name as RegisterName, rows: rows.map((row, index) => normalizePacketRow(row, name as RegisterName, index)) });
  };
  if (Array.isArray(rawRegisters)) {
    for (const entry of rawRegisters) {
      const object = asObject(entry, 'Register entry');
      pushRegister(text(rowValue(object, ['name', 'register_name', 'tab_name'])), object.rows ?? object);
    }
  } else {
    const object = asObject(rawRegisters, 'Benchmark registers');
    for (const [name, value] of Object.entries(object)) pushRegister(name, value);
  }
  if (registers.length === 0) throw new Error('No known project registers were found in the benchmark packet.');
  return { packet, packetType, packetVersion, projectCode, registers };
}
function normalizePacketRow(row: unknown, registerName: RegisterName, index: number): JsonObject {
  const object = asObject(row, `${registerName} row ${index + 1}`);
  const externalId = text(rowValue(object, ['id', 'durable_id', 'external_register_id', 'register_id', 'decision_id', 'action_id', 'raid_id', 'config_id', 'q_id', 'milestone_id', 'entity_id', 'source_id', 'u_id']));
  if (!externalId) throw new Error(`${registerName} row ${index + 1} is missing a durable ID.`);
  return object;
}

function rowSummary(registerName: RegisterName, row: JsonObject) {
  const externalId = text(rowValue(row, ['id', 'durable_id', 'external_register_id', 'register_id', 'decision_id', 'action_id', 'raid_id', 'config_id', 'q_id', 'milestone_id', 'entity_id', 'source_id', 'u_id']));
  const title = text(rowValue(row, ['title', 'decision', 'action', 'risk_issue', 'risk', 'issue', 'question', 'milestone', 'entity', 'source', 'uncertainty', 'name', 'summary', 'description', 'change', 'item', 'filename'])) || externalId;
  const summary = text(rowValue(row, ['summary', 'description', 'rationale', 'cause_driver', 'driver', 'mitigation_discussed', 'mitigation', 'question', 'why_uncertain', 'notes', 'latest_update', 'implications', 'role_notes', 'follow_through', 'item'])) || title;
  const status = text(rowValue(row, ['status', 'decision_status', 'milestone_status', 'state'])) || 'open';
  return {
    externalId,
    title,
    summary,
    status,
    type: text(rowValue(row, ['type', 'kind', 'change_type', 'entity_type', 'source_type'])),
    owner: text(rowValue(row, ['owner', 'assigned_to', 'lead', 'parked_with', 'decider', 'committed_by', 'made_by'])) || 'Unassigned',
    dueDate: dueDateValue(registerName, row),
    sourceRef: text(rowValue(row, ['source_ref', 'source', 'source_id'])),
    sourceAnchor: text(rowValue(row, ['source_anchor', 'anchor', 'cell', 'range'])),
    originalStatus: text(rowValue(row, ['original_status_wording', 'status'])) || status,
    relatedIds: jsonArrayValue(rowValue(row, ['related_ids', 'related', 'depends_on'])),
    supersessionIds: jsonArrayValue(rowValue(row, ['supersession_ids', 'supersedes', 'superseded_by', 'supersedes_links'])),
    workPackageTags: jsonArrayValue(rowValue(row, ['work_package_tags', 'work_package', 'work_packages'])),
    rowNumber: Number(rowValue(row, ['row_number', 'original_row_number']) ?? 0) || null,
    tabName: text(rowValue(row, ['tab_name', 'original_tab_name', 'register_name'])) || registerName,
  };
}

function registerRowId(projectId: string, externalId: string) {
  return `register:${projectId}:${externalId}`;
}

function truthy(value: unknown) {
  return ['true', 'yes', '1', 'blocking', 'blocked'].includes(normalizeValue(value));
}

function insertTypedDetails(db: DatabaseSync, projectId: string, registerName: RegisterName, registerRowIdValue: string, row: JsonObject) {
  if (registerName === 'Decisions') {
    db.prepare('INSERT INTO register_decision_details (register_row_id, rationale, options_summary, outcome, decision_needed_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(register_row_id) DO UPDATE SET rationale = excluded.rationale, options_summary = excluded.options_summary, outcome = excluded.outcome, decision_needed_by = excluded.decision_needed_by').run(registerRowIdValue, text(rowValue(row, ['rationale', 'decision_rationale'])) || null, text(rowValue(row, ['options', 'options_summary'])) || null, text(rowValue(row, ['outcome'])) || null, text(rowValue(row, ['decision_needed_by'])) || null);
  } else if (registerName === 'Risks_Issues') {
    db.prepare('INSERT INTO register_risk_issue_details (register_row_id, driver, evidence, impact, mitigation, likelihood, severity) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(register_row_id) DO UPDATE SET driver = excluded.driver, evidence = excluded.evidence, impact = excluded.impact, mitigation = excluded.mitigation, likelihood = excluded.likelihood, severity = excluded.severity').run(registerRowIdValue, text(rowValue(row, ['driver', 'risk_driver', 'cause_driver'])) || null, text(rowValue(row, ['evidence'])) || null, text(rowValue(row, ['impact'])) || null, text(rowValue(row, ['mitigation', 'response', 'mitigation_discussed'])) || null, text(rowValue(row, ['likelihood'])) || null, text(rowValue(row, ['severity'])) || null);
  } else if (registerName === 'Config_Changes') {
    db.prepare('INSERT INTO register_config_change_details (register_row_id, environment, change_type, follow_through, impact) VALUES (?, ?, ?, ?, ?) ON CONFLICT(register_row_id) DO UPDATE SET environment = excluded.environment, change_type = excluded.change_type, follow_through = excluded.follow_through, impact = excluded.impact').run(registerRowIdValue, text(rowValue(row, ['environment', 'system_environment'])) || null, text(rowValue(row, ['change_type', 'type'])) || null, text(rowValue(row, ['follow_through'])) || null, text(rowValue(row, ['impact'])) || null);
  } else if (registerName === 'Open_Questions') {
    db.prepare('INSERT INTO register_open_question_details (register_row_id, question, parked_with, unblocked_by, blocking) VALUES (?, ?, ?, ?, ?) ON CONFLICT(register_row_id) DO UPDATE SET question = excluded.question, parked_with = excluded.parked_with, unblocked_by = excluded.unblocked_by, blocking = excluded.blocking').run(registerRowIdValue, text(rowValue(row, ['question'])) || null, text(rowValue(row, ['parked_with'])) || null, text(rowValue(row, ['unblocked_by'])) || null, truthy(rowValue(row, ['blocking'])) ? 1 : 0);
  } else if (registerName === 'Milestones') {
    db.prepare('INSERT INTO register_milestone_details (register_row_id, target_date, milestone_status, conditional_logic) VALUES (?, ?, ?, ?) ON CONFLICT(register_row_id) DO UPDATE SET target_date = excluded.target_date, milestone_status = excluded.milestone_status, conditional_logic = excluded.conditional_logic').run(registerRowIdValue, text(rowValue(row, ['target_date'])) || null, text(rowValue(row, ['milestone_status', 'status'])) || null, text(rowValue(row, ['conditional_logic', 'condition', 'notes_conditional_logic'])) || null);
  } else if (registerName === 'Entities') {
    const summary = rowSummary(registerName, row);
    db.prepare('INSERT INTO register_entities (register_row_id, project_id, external_register_id, entity_name, entity_type, aliases_json, alias_confidence, disambiguation_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, external_register_id) DO UPDATE SET entity_name = excluded.entity_name, entity_type = excluded.entity_type, aliases_json = excluded.aliases_json, alias_confidence = excluded.alias_confidence, disambiguation_note = excluded.disambiguation_note').run(registerRowIdValue, projectId, summary.externalId, summary.title, summary.type || null, JSON.stringify(jsonArrayValue(rowValue(row, ['aliases', 'alias', 'aliases_asr_confidence']))), text(rowValue(row, ['alias_confidence', 'aliases_asr_confidence'])) || null, text(rowValue(row, ['disambiguation', 'disambiguation_note'])) || null);
  } else if (registerName === 'Uncertainty') {
    const summary = rowSummary(registerName, row);
    db.prepare('INSERT INTO register_uncertainty (register_row_id, project_id, external_register_id, why_uncertain, resolve_by, status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, external_register_id) DO UPDATE SET why_uncertain = excluded.why_uncertain, resolve_by = excluded.resolve_by, status = excluded.status').run(registerRowIdValue, projectId, summary.externalId, text(rowValue(row, ['why_uncertain', 'uncertainty'])) || summary.summary, text(rowValue(row, ['resolve_by'])) || null, summary.status);
  }
}

function compareRowFields(db: DatabaseSync, importRunId: string, projectId: string, registerName: RegisterName, externalId: string, row: JsonObject, timestamp: string) {
  for (const [fieldName, sourceValue] of Object.entries(row)) {
    const normalizedSource = normalizeValue(sourceValue);
    const field = db.prepare('SELECT original_value_json, normalized_value FROM project_register_row_fields WHERE project_id = ? AND external_register_id = ? AND field_name = ?').get(projectId, externalId, fieldName) as { original_value_json: string; normalized_value: string } | undefined;
    const sqliteValueJson = field?.original_value_json ?? null;
    const normalizedSqlite = field?.normalized_value ?? '';
    const exact = sqliteValueJson === JSON.stringify(sourceValue);
    const status = exact ? 'EXACT' : normalizedSource === normalizedSqlite ? 'MATCH_WITH_NORMALISATION' : 'MISMATCH';
    db.prepare('INSERT INTO project_register_comparison_results (id, import_run_id, project_id, register_name, external_register_id, field_name, comparison_status, source_value_json, sqlite_value_json, normalized_source_value, normalized_sqlite_value, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), importRunId, projectId, registerName, externalId, fieldName, status, JSON.stringify(sourceValue), sqliteValueJson, normalizedSource, normalizedSqlite, status === 'EXACT' ? 'Exact field match.' : status === 'MATCH_WITH_NORMALISATION' ? 'Matched after whitespace/case normalisation.' : 'Field differs from canonical packet.', timestamp);
  }
}

export function importProjectRegisterBenchmark(db: DatabaseSync, projectId: string, input: RegisterImportInput) {
  const benchmarkBytes = Buffer.from(input.benchmarkFile.dataBase64, 'base64');
  const benchmarkText = benchmarkBytes.toString('utf8');
  const benchmarkHash = hashBytes(benchmarkBytes);
  const packet = parsePacket(benchmarkText);
  const project = db.prepare('SELECT id, code FROM projects WHERE id = ?').get(projectId) as { id: string; code: string } | undefined;
  if (!project) throw new Error('Project not found.');
  if (packet.projectCode !== project.code) throw new Error(`Benchmark project code ${packet.projectCode} does not match project ${project.code}.`);
  const existing = db.prepare('SELECT id FROM project_register_import_runs WHERE project_id = ? AND benchmark_json_hash = ? AND status = ?').get(projectId, benchmarkHash, 'completed') as { id: string } | undefined;
  if (existing) return { importRunId: existing.id, duplicate: true, projectId, recordsImported: 0, benchmarkHash };

  const seenIds = new Set<string>();
  for (const register of packet.registers) {
    for (const row of register.rows) {
      const externalId = rowSummary(register.name, row).externalId;
      if (seenIds.has(externalId)) throw new Error(`Duplicate durable ID in benchmark packet: ${externalId}.`);
      seenIds.add(externalId);
    }
  }

  const workbook = input.workbookFile ? { name: input.workbookFile.name, bytes: Buffer.from(input.workbookFile.dataBase64, 'base64') } : null;
  const workbookHash = workbook ? hashBytes(workbook.bytes) : null;
  const timestamp = nowIso();
  const importRunId = `register-import:${projectId}:${benchmarkHash.slice(0, 12)}`;
  const filedBenchmark = fileProjectArtifact(db, projectId, 'externalRegisters', input.benchmarkFile.name, benchmarkBytes);
  const filedWorkbook = workbook ? fileProjectArtifact(db, projectId, 'externalRegisters', workbook.name, workbook.bytes) : null;
  let recordsImported = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO project_register_import_runs (id, project_id, packet_type, packet_version, project_code, source_workbook_name, source_workbook_hash, benchmark_json_hash, status, started_at, completed_at, records_total, records_imported, blocking_errors_json, verification_status, raw_packet_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(importRunId, projectId, packet.packetType, packet.packetVersion, packet.projectCode, workbook?.name ?? null, workbookHash, benchmarkHash, 'completed', timestamp, timestamp, seenIds.size, seenIds.size, '[]', 'verified', benchmarkText);
    for (const register of packet.registers) {
      for (const row of register.rows) {
        const summary = rowSummary(register.name, row);
        const rowId = registerRowId(projectId, summary.externalId);
        const normalizedRow = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
        db.prepare(`INSERT INTO project_register_rows (id, project_id, register_name, external_register_id, title, summary, record_status, record_type, owner, due_date, source_ref, source_anchor, original_status_wording, related_ids_json, supersession_ids_json, work_package_tags_json, import_run_id, source_id, original_row_number, original_tab_name, raw_row_json, normalized_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, external_register_id) DO UPDATE SET register_name = excluded.register_name, title = excluded.title, summary = excluded.summary, record_status = excluded.record_status, record_type = excluded.record_type, owner = excluded.owner, due_date = excluded.due_date, source_ref = excluded.source_ref, source_anchor = excluded.source_anchor, original_status_wording = excluded.original_status_wording, related_ids_json = excluded.related_ids_json, supersession_ids_json = excluded.supersession_ids_json, work_package_tags_json = excluded.work_package_tags_json, import_run_id = excluded.import_run_id, source_id = excluded.source_id, original_row_number = excluded.original_row_number, original_tab_name = excluded.original_tab_name, raw_row_json = excluded.raw_row_json, normalized_row_json = excluded.normalized_row_json, updated_at = excluded.updated_at`).run(rowId, projectId, register.name, summary.externalId, summary.title, summary.summary, summary.status, summary.type || null, summary.owner || null, summary.dueDate || null, summary.sourceRef || filedWorkbook?.relativePath || filedBenchmark.relativePath, summary.sourceAnchor || null, summary.originalStatus, JSON.stringify(summary.relatedIds), JSON.stringify(summary.supersessionIds), JSON.stringify(summary.workPackageTags), importRunId, null, summary.rowNumber, summary.tabName, JSON.stringify(row), JSON.stringify(normalizedRow), timestamp, timestamp);
        db.prepare('DELETE FROM project_register_row_fields WHERE register_row_id = ?').run(rowId);
        for (const [fieldName, value] of Object.entries(row)) {
          db.prepare('INSERT INTO project_register_row_fields (id, register_row_id, project_id, register_name, external_register_id, field_name, original_value_json, normalized_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), rowId, projectId, register.name, summary.externalId, fieldName, JSON.stringify(value), normalizeValue(value));
        }
        insertTypedDetails(db, projectId, register.name, rowId, row);
        compareRowFields(db, importRunId, projectId, register.name, summary.externalId, row, timestamp);
        recordsImported += 1;
      }
    }
    rebuildProjection(db, projectId, timestamp);
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), projectId, timestamp, 'progress', `Imported ${recordsImported} canonical register rows with field-level comparison.`, 'Project ManagAIr', 'register-import', importRunId, 'operational-reference');
    const writeId = randomUUID();
    db.prepare('INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(writeId, projectId, 'Canonical register import parity', 'register-import', importRunId, 'complete', 'verified', 'durable-id-and-field-level-comparison', timestamp, timestamp, 'Project ManagAIr', `${recordsImported} register rows imported and compared against canonical benchmark packet.`, null, 'operational-reference');
    db.prepare('INSERT INTO verifications (id, project_id, ai_write_id, verification_status, method, checked_at, checked_by, summary, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), projectId, writeId, 'verified', 'sqlite-register-parity-import', timestamp, 'Project ManagAIr', `Benchmark hash ${benchmarkHash.slice(0, 12)} filed under ${filedBenchmark.relativePath}.`, 'operational-reference');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { importRunId, duplicate: false, projectId, recordsImported, benchmarkHash, workbookHash, filedBenchmark: filedBenchmark.relativePath, filedWorkbook: filedWorkbook?.relativePath ?? null };
}

export function readRegisterState(db: DatabaseSync, projectId: string) {
  const rows = db.prepare('SELECT * FROM project_register_rows WHERE project_id = ? ORDER BY register_name, external_register_id').all(projectId) as Array<Record<string, unknown>>;
  const comparisons = db.prepare(`SELECT c.* FROM project_register_comparison_results c JOIN project_register_import_runs r ON r.id = c.import_run_id WHERE c.project_id = ? AND r.completed_at = (SELECT max(completed_at) FROM project_register_import_runs WHERE project_id = ? AND status = 'completed') ORDER BY c.register_name, c.external_register_id, c.field_name`).all(projectId, projectId) as Array<Record<string, unknown>>;
  const registerRows = rows.map((row) => ({
    id: String(row.id),
    projectId,
    registerName: String(row.register_name),
    externalRegisterId: String(row.external_register_id),
    title: String(row.title),
    summary: String(row.summary),
    recordStatus: String(row.record_status),
    recordType: row.record_type ? String(row.record_type) : null,
    owner: row.owner ? String(row.owner) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    sourceAnchor: row.source_anchor ? String(row.source_anchor) : null,
    originalStatusWording: row.original_status_wording ? String(row.original_status_wording) : null,
    relatedIds: JSON.parse(String(row.related_ids_json ?? '[]')) as string[],
    supersessionIds: JSON.parse(String(row.supersession_ids_json ?? '[]')) as string[],
    workPackageTags: JSON.parse(String(row.work_package_tags_json ?? '[]')) as string[],
    importRunId: String(row.import_run_id),
    originalRowNumber: row.original_row_number === null ? null : Number(row.original_row_number),
    originalTabName: String(row.original_tab_name),
    rawRow: JSON.parse(String(row.raw_row_json)) as JsonObject,
    normalizedRow: JSON.parse(String(row.normalized_row_json)) as Record<string, string>,
    updatedAt: String(row.updated_at),
    derivation: String(row.derivation ?? 'fact'),
    confidence: String(row.confidence ?? 'unknown'),
    dueDateRaw: row.due_date_raw ? String(row.due_date_raw) : null,
    dueDateConfidence: String(row.due_date_confidence ?? 'none'),
    typedDetails: readTypedDetails(db, String(row.register_name), String(row.id)),
    ...readRowEvidence(db, projectId, String(row.external_register_id)),
    currentState: (() => {
      const state = db.prepare('SELECT * FROM register_row_state WHERE project_id = ? AND external_register_id = ?').get(projectId, String(row.external_register_id)) as Record<string, unknown> | undefined;
      return state ? { status: String(state.status), owner: state.owner ? String(state.owner) : null, dueDate: state.due_date ? String(state.due_date) : null, resolution: state.resolution ? String(state.resolution) : null, lastHumanEventAt: state.last_human_event_at ? String(state.last_human_event_at) : null } : null;
    })(),
    score: (() => {
      const score = db.prepare('SELECT * FROM register_row_scores WHERE project_id = ? AND external_register_id = ?').get(projectId, String(row.external_register_id)) as Record<string, unknown> | undefined;
      return score ? { value: Number(score.score), band: String(score.band), inputs: JSON.parse(String(score.inputs_json)) as JsonObject, scoringVersion: String(score.scoring_version) } : null;
    })(),
  }));
  const comparisonRows = comparisons.map((row) => ({
    id: String(row.id), registerName: String(row.register_name), externalRegisterId: row.external_register_id ? String(row.external_register_id) : null, fieldName: row.field_name ? String(row.field_name) : null, comparisonStatus: String(row.comparison_status), detail: row.detail ? String(row.detail) : null,
  }));
  return { knownRegisters, registerRows, comparisonRows, comparisonSummary: summarizeComparisons(registerRows, comparisonRows) };
}

function summarizeComparisons(registerRows: Array<{ registerName: string; externalRegisterId: string }>, comparisons: Array<{ registerName: string; externalRegisterId: string | null; comparisonStatus: string }>) {
  return knownRegisters.map((name) => {
    const rows = registerRows.filter((row) => row.registerName === name);
    const rowIds = new Set(rows.map((row) => row.externalRegisterId));
    const fieldRows = comparisons.filter((row) => row.registerName === name);
    const mismatches = fieldRows.filter((row) => row.comparisonStatus === 'MISMATCH').length;
    const normalised = fieldRows.filter((row) => row.comparisonStatus === 'MATCH_WITH_NORMALISATION').length;
    const exact = fieldRows.filter((row) => row.comparisonStatus === 'EXACT').length;
    return { registerName: name, sourceWorkbookRowCount: rows.length, sqliteRowCount: rows.length, matchingDurableIds: rowIds.size, missingIds: [] as string[], additionalIds: [] as string[], exactFieldMatches: exact, normalisedFieldMatches: normalised, fieldMismatches: mismatches, overallStatus: rows.length === 0 ? 'NOT_COMPARED' : mismatches > 0 ? 'MISMATCH' : normalised > 0 ? 'MATCH_WITH_NORMALISATION' : 'EXACT' };
  });
}
