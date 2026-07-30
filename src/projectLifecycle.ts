import { createHash, randomUUID } from 'node:crypto';
import { accessSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { registerNormalizedSource } from './sourceIntelligence.js';

export type SourceState = 'awaiting_processing' | 'processing' | 'awaiting_review' | 'verified' | 'failed' | 'rejected' | 'archived';
export type ProposedStatus = 'proposed' | 'reviewed' | 'approved' | 'applied' | 'rejected';
export type StructuredItemType = 'action' | 'risk_issue' | 'decision' | 'open_question' | 'milestone' | 'work_package' | 'meeting_summary' | 'stakeholder' | 'deliverable' | 'change_request' | 'source_metadata';

export interface ProjectStorageSettings {
  projectsRoot: string | null;
  projectFolderNamingFormat: string;
  verifiedAt: string | null;
  lastWriteTestAt: string | null;
  updatedAt: string;
  exists: boolean;
  writable: boolean;
  configured: boolean;
}

export interface CreateProjectInput {
  code: string;
  name: string;
  customer: string;
  description: string;
  status: 'active' | 'on-track' | 'watch' | 'at-risk' | 'blocked' | 'complete';
  owner: string;
  startDate?: string;
  targetDate?: string;
}

export interface IntakeFileInput {
  name: string;
  type?: string;
  dataBase64: string;
}

interface StructuredItem {
  id: string;
  type: StructuredItemType;
  title: string;
  summary: string;
  body?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

interface ProposedPayload {
  contractVersion: 1;
  provider: string;
  sourceMetadata: { sourceType: string; contentHash: string; originalFileName: string };
  items: StructuredItem[];
}

export interface BlindExtractionInput {
  sourceFile: IntakeFileInput;
  frozenPacket: ProposedPayload & {
    model?: string;
    generatedAt?: string;
    packetHash?: string;
    extractionMode?: string;
  };
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localConfigPath = path.join(repoRoot, 'config', 'project-storage.local.json');
const defaultNamingFormat = '{code} - {name}';
const contractName = 'projectmanagair-source-processing-v1';

const storageMapping: Record<string, string> = {
  transcripts: path.join('01_Sources_Immutable', 'Meeting_Transcripts'),
  email: path.join('01_Sources_Immutable', 'Emails_and_Decisions'),
  customerDocument: path.join('01_Sources_Immutable', 'Customer_Documents'),
  receivedData: path.join('01_Sources_Immutable', 'Customer_Data_Received'),
  workingData: path.join('04_Data_and_Configuration', 'Working'),
  readyUpload: path.join('04_Data_and_Configuration', 'Ready_for_Upload'),
  uploadEvidence: path.join('04_Data_and_Configuration', 'Upload_Results_and_Evidence'),
  draftDeliverable: path.join('08_Deliverables', 'Drafts'),
  issuedDeliverable: path.join('08_Deliverables', 'Issued'),
  aiWrites: path.join('09_Reporting_QA_Comms', '01_Writes'),
  verifications: path.join('09_Reporting_QA_Comms', '02_Verifications'),
  externalRegisters: path.join('06_Registers_and_Exports', 'External_Registers'),
};

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysDate(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || randomUUID();
}

function safeName(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').slice(0, 120) || 'Project';
}

function sourceTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.vtt') return 'vtt-transcript';
  if (['.txt', '.md'].includes(ext)) return 'plain-text';
  if (['.msg', '.eml'].includes(ext)) return 'email-evidence';
  if (['.xlsx', '.xls'].includes(ext)) return 'spreadsheet';
  if (['.docx', '.pdf'].includes(ext)) return 'customer-document';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image';
  return 'unsupported';
}

function destinationKeyFor(sourceType: string): string {
  if (sourceType === 'vtt-transcript' || sourceType === 'plain-text') return 'transcripts';
  if (sourceType === 'email-evidence') return 'email';
  if (sourceType === 'spreadsheet') return 'receivedData';
  if (sourceType === 'customer-document' || sourceType === 'image') return 'customerDocument';
  return 'receivedData';
}

function normalizeRoot(root: string) {
  return path.resolve(root.trim());
}

function assertInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resolved path escapes the configured projects root');
}

function readLocalConfigFile(): { projectsRoot?: string; projectFolderNamingFormat?: string } {
  if (process.env.NODE_ENV === 'test' || !existsSync(localConfigPath)) return {};
  return JSON.parse(readFileSync(localConfigPath, 'utf8')) as { projectsRoot?: string; projectFolderNamingFormat?: string };
}

function writeLocalConfigFile(settings: { projectsRoot: string | null; projectFolderNamingFormat: string }) {
  if (process.env.NODE_ENV === 'test') return;
  mkdirSync(path.dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function configuredRoot(db: DatabaseSync): string {
  const row = db.prepare("SELECT projects_root FROM project_storage_settings WHERE id = 'local'").get() as { projects_root: string | null } | undefined;
  const root = row?.projects_root?.trim();
  if (!root) throw new Error('Configure a local synced projects root before creating projects or taking in sources.');
  return normalizeRoot(root);
}

function projectPath(db: DatabaseSync, projectId: string): string {
  const row = db.prepare('SELECT external_path FROM projects WHERE id = ?').get(projectId) as { external_path: string | null } | undefined;
  if (!row?.external_path) throw new Error('Project does not have an external storage path recorded.');
  const root = configuredRoot(db);
  const resolved = path.resolve(row.external_path);
  assertInside(root, resolved);
  return resolved;
}

function parseLines(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^WEBVTT$/i.test(line) && !/^\d+$/.test(line) && !/-->/.test(line));
}

function item(type: StructuredItemType, title: string, summary = title): StructuredItem {
  return { id: randomUUID(), type, title: title.trim(), summary: summary.trim() || title.trim() };
}

function actionableItems(items: StructuredItem[]) {
  return items.filter((candidate) => !['meeting_summary', 'source_metadata', 'stakeholder'].includes(candidate.type));
}
function parseDeterministic(sourceType: string, fileName: string, text: string, contentHash: string): ProposedPayload {
  const items: StructuredItem[] = [];
  if (!['vtt-transcript', 'plain-text'].includes(sourceType)) {
    return { contractVersion: 1, provider: 'unsupported-local-retention', sourceMetadata: { sourceType, contentHash, originalFileName: fileName }, items };
  }

  for (const line of parseLines(text)) {
    const action = line.match(/^(?:action|todo|next step)\s*[:\-]\s*(.+)$/i);
    if (action) items.push({ ...item('action', action[1]), priority: 'medium' });
    const risk = line.match(/^risk\s*[:\-]\s*(.+)$/i);
    if (risk) items.push({ ...item('risk_issue', risk[1]), severity: 'high' });
    const issue = line.match(/^issue\s*[:\-]\s*(.+)$/i);
    if (issue) items.push({ ...item('risk_issue', issue[1]), severity: 'medium' });
    const decision = line.match(/^decision\s*[:\-]\s*(.+)$/i);
    if (decision) items.push(item('decision', decision[1]));
    const question = line.match(/^(?:question|open question)\s*[:\-]\s*(.+)$/i);
    if (question) items.push(item('open_question', question[1], question[1]));
    const milestone = line.match(/^milestone\s*[:\-]\s*(.+)$/i);
    if (milestone) items.push(item('milestone', milestone[1]));
    const workPackage = line.match(/^(?:work package|workpackage)\s*[:\-]\s*(.+)$/i);
    if (workPackage) items.push(item('work_package', workPackage[1]));
    const deliverable = line.match(/^deliverable\s*[:\-]\s*(.+)$/i);
    if (deliverable) items.push(item('deliverable', deliverable[1]));
    const change = line.match(/^(?:change|scope request)\s*[:\-]\s*(.+)$/i);
    if (change) items.push(item('change_request', change[1]));
  }

  items.push(item('meeting_summary', `Parsed ${sourceType === 'vtt-transcript' ? 'VTT transcript' : 'text source'}: ${fileName}`, `${items.length} structured candidate records were extracted for review.`));
  return { contractVersion: 1, provider: 'deterministic-local-parser', sourceMetadata: { sourceType, contentHash, originalFileName: fileName }, items };
}

export async function readStorageSettings(db: DatabaseSync): Promise<ProjectStorageSettings> {
  const local = readLocalConfigFile();
  if (local.projectsRoot !== undefined || local.projectFolderNamingFormat !== undefined) {
    db.prepare("INSERT INTO project_storage_settings (id, projects_root, project_folder_naming_format, updated_at) VALUES ('local', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET projects_root = excluded.projects_root, project_folder_naming_format = excluded.project_folder_naming_format, updated_at = excluded.updated_at")
      .run(local.projectsRoot?.trim() || null, local.projectFolderNamingFormat?.trim() || defaultNamingFormat, nowIso());
  }
  const row = db.prepare("SELECT * FROM project_storage_settings WHERE id = 'local'").get() as Record<string, unknown>;
  const root = row.projects_root ? String(row.projects_root) : null;
  const exists = root ? existsSync(root) : false;
  let writable = false;
  if (root && exists) {
    try { await access(root, constants.W_OK | constants.R_OK); writable = true; } catch { writable = false; }
  }
  return { projectsRoot: root, projectFolderNamingFormat: String(row.project_folder_naming_format ?? defaultNamingFormat), verifiedAt: row.verified_at ? String(row.verified_at) : null, lastWriteTestAt: row.last_write_test_at ? String(row.last_write_test_at) : null, updatedAt: String(row.updated_at), exists, writable, configured: Boolean(root) };
}

export async function updateStorageSettings(db: DatabaseSync, input: { projectsRoot?: string; projectFolderNamingFormat?: string }) {
  const root = input.projectsRoot?.trim() ? normalizeRoot(input.projectsRoot) : null;
  const naming = input.projectFolderNamingFormat?.trim() || defaultNamingFormat;
  writeLocalConfigFile({ projectsRoot: root, projectFolderNamingFormat: naming });
  const timestamp = nowIso();
  db.prepare("INSERT INTO project_storage_settings (id, projects_root, project_folder_naming_format, updated_at) VALUES ('local', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET projects_root = excluded.projects_root, project_folder_naming_format = excluded.project_folder_naming_format, updated_at = excluded.updated_at")
    .run(root, naming, timestamp);
  return readStorageSettings(db);
}

export async function verifyStorageRoot(db: DatabaseSync, writeTest = false) {
  const root = configuredRoot(db);
  const exists = existsSync(root);
  if (!exists) return { ...(await readStorageSettings(db)), writeTest: false, message: 'Configured root does not exist.' };
  await access(root, constants.R_OK | constants.W_OK);
  const timestamp = nowIso();
  if (writeTest) {
    const probe = path.join(root, `.projectmanagair-write-test-${Date.now()}.tmp`);
    await writeFile(probe, 'Project ManagAIr write test\n', 'utf8');
    await readFile(probe, 'utf8');
    rmSync(probe, { force: true });
    db.prepare("UPDATE project_storage_settings SET verified_at = ?, last_write_test_at = ?, updated_at = ? WHERE id = 'local'").run(timestamp, timestamp, timestamp);
    return { ...(await readStorageSettings(db)), writeTest: true, message: 'Write/read/delete test passed.' };
  }
  db.prepare("UPDATE project_storage_settings SET verified_at = ?, updated_at = ? WHERE id = 'local'").run(timestamp, timestamp);
  return { ...(await readStorageSettings(db)), writeTest: false, message: 'Path exists and is writable.' };
}

export function createProject(db: DatabaseSync, input: CreateProjectInput) {
  const settingsRoot = configuredRoot(db);
  accessSync(settingsRoot, constants.R_OK | constants.W_OK);
  const settings = db.prepare("SELECT project_folder_naming_format FROM project_storage_settings WHERE id = 'local'").get() as { project_folder_naming_format: string };
  const projectId = slug(input.code);
  const folderName = safeName((settings.project_folder_naming_format || defaultNamingFormat).replaceAll('{code}', input.code.trim()).replaceAll('{name}', input.name.trim()));
  const externalPath = path.join(settingsRoot, folderName);
  assertInside(settingsRoot, externalPath);
  const inboxPath = path.join(externalPath, '00_Inbox', 'Unsorted');
  const timestamp = nowIso();
  const projectRootExisted = existsSync(externalPath);
  mkdirSync(inboxPath, { recursive: true });

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification, imported_at, external_path, folder_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, input.name.trim(), input.code.trim(), input.description.trim() || `${input.customer.trim()} project workspace.`, input.status, 'Project setup', input.owner.trim(), input.startDate || todayDate(), input.targetDate || addDaysDate(90), '', timestamp, timestamp, 'operational-reference', timestamp, externalPath, folderName);
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'progress', `Created project workspace for ${input.customer.trim()}.`, 'Project ManagAIr', 'project', projectId, 'operational-reference');
    db.exec('COMMIT;');
    return { projectId, externalPath, inboxPath };
  } catch (error) {
    db.exec('ROLLBACK;');
    if (!projectRootExisted) rmSync(externalPath, { recursive: true, force: true });
    throw error;
  }
}

function fileNameFor(originalName: string, hash: string) {
  const ext = path.extname(originalName);
  const base = safeName(path.basename(originalName, ext));
  return `${base}-${hash.slice(0, 12)}${ext}`;
}

export async function intakeProjectSource(db: DatabaseSync, projectId: string, file: IntakeFileInput) {
  const root = configuredRoot(db);
  const pPath = projectPath(db, projectId);
  assertInside(root, pPath);
  const bytes = Buffer.from(file.dataBase64, 'base64');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const sourceType = sourceTypeFor(file.name);
  const existing = db.prepare('SELECT id, processing_status FROM project_source_intake WHERE project_id = ? AND content_hash = ?').get(projectId, contentHash) as { id: string; processing_status: string } | undefined;
  if (existing) return { sourceId: existing.id, duplicate: true, processingStatus: existing.processing_status };

  const inboxPath = path.join(pPath, '00_Inbox', 'Unsorted');
  mkdirSync(inboxPath, { recursive: true });
  const target = path.join(inboxPath, fileNameFor(file.name, contentHash));
  assertInside(root, target);
  writeFileSync(target, bytes);
  let intakeRecordCommitted = false;

  const timestamp = nowIso();
  const sourceId = randomUUID();
  const jobId = `source-job:${projectId}:${contentHash.slice(0, 16)}`;
  const proposedId = randomUUID();
  const extension = path.extname(file.name).toLowerCase();
  const sourceIntelligenceSupported = ['.vtt', '.txt', '.eml', '.docx'].includes(extension);
  let status: SourceState = 'awaiting_review';
  let payload: ProposedPayload;
  if (sourceIntelligenceSupported) {
    status = 'processing';
    payload = { contractVersion: 1, provider: 'source-intelligence-v1', sourceMetadata: { sourceType, contentHash, originalFileName: file.name }, items: [] };
  } else try {
    const text = ['vtt-transcript', 'plain-text'].includes(sourceType) ? bytes.toString('utf8') : '';
    payload = parseDeterministic(sourceType, file.name, text, contentHash);
    if (actionableItems(payload.items).length === 0) status = 'failed';
  } catch {
    payload = { contractVersion: 1, provider: 'deterministic-local-parser', sourceMetadata: { sourceType, contentHash, originalFileName: file.name }, items: [] };
    status = 'failed';
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO project_source_intake (id, project_id, original_file_name, original_received_at, content_hash, source_type, current_external_path, previous_external_path, processing_status, processor_provider, extracted_item_ids_json, review_state, verification_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sourceId, projectId, file.name, timestamp, contentHash, sourceType, target, null, status, payload.provider, JSON.stringify(payload.items.map((candidate) => candidate.id)), sourceIntelligenceSupported ? 'not-started' : 'proposed', status === 'failed' ? 'failed' : 'pending', timestamp, timestamp);
    db.prepare('INSERT INTO source_processing_jobs (id, source_id, project_id, provider, status, started_at, completed_at, error_message, structured_output_contract, proposed_change_id, current_stage, queued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, sourceId, projectId, payload.provider, sourceIntelligenceSupported ? 'queued' : status === 'failed' ? 'failed' : 'completed', timestamp, sourceIntelligenceSupported ? null : timestamp, status === 'failed' ? 'No supported structured items could be parsed.' : null, sourceIntelligenceSupported ? 'project_register_delta-v1' : contractName, sourceIntelligenceSupported ? null : proposedId, sourceIntelligenceSupported ? 'queued' : status === 'failed' ? 'failed' : 'complete', timestamp, timestamp);
    if (!sourceIntelligenceSupported) {
      db.prepare('INSERT INTO proposed_changes (id, project_id, source_id, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(proposedId, projectId, sourceId, status === 'failed' ? 'rejected' : 'proposed', JSON.stringify(payload), timestamp);
    }
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'ai', `Source ${file.name} was taken into the project Inbox and hashed.`, 'Project ManagAIr', 'source', sourceId, 'operational-reference');
    db.exec('COMMIT;');
    intakeRecordCommitted = true;
  } catch (error) {
    db.exec('ROLLBACK;');
    if (!intakeRecordCommitted) rmSync(target, { force: true });
    throw error;
  }
  if (sourceIntelligenceSupported) {
    try {
      const filed = fileProjectArtifact(db, projectId, destinationKeyFor(sourceType) as keyof typeof storageMapping, file.name, bytes);
      const normalized = registerNormalizedSource(db, { projectId, intakeSourceId: sourceId, fileName: file.name, immutablePath: filed.destinationPath, contentHash, bytes });
      const filedAt = nowIso();
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare("UPDATE project_source_intake SET current_external_path = ?, previous_external_path = ?, processing_status = 'processing', updated_at = ? WHERE id = ?").run(filed.destinationPath, target, filedAt, sourceId);
        db.prepare('INSERT INTO source_file_history (id, source_id, project_id, from_external_path, to_external_path, action, occurred_at, actor, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), sourceId, projectId, target, filed.destinationPath, 'filed-immutable-original', filedAt, 'Project ManagAIr', contentHash);
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
      if (path.resolve(target) !== path.resolve(filed.destinationPath) && existsSync(target)) rmSync(target, { force: true });
      return { ...normalized, intakeSourceId: sourceId, proposedChangeId: null, processingStatus: 'processing', extractedCount: 0, immutablePath: filed.destinationPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE project_source_intake SET processing_status = 'failed', verification_state = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), sourceId);
      db.prepare("UPDATE source_processing_jobs SET status = 'failed', current_stage = 'failed', completed_at = ?, updated_at = ?, error_message = ? WHERE id = ?").run(nowIso(), nowIso(), message, jobId);
      throw error;
    }
  }
  return { sourceId, proposedChangeId: proposedId, duplicate: false, processingStatus: status, extractedCount: payload.items.length };
}

export function recordBlindExtractionPacket(db: DatabaseSync, projectId: string, input: BlindExtractionInput) {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
  if (!project) throw new Error('Project not found.');
  const sourceBytes = Buffer.from(input.sourceFile.dataBase64, 'base64');
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceType = sourceTypeFor(input.sourceFile.name);
  if (sourceType !== 'vtt-transcript') throw new Error('Benchmark acceptance source must be a VTT transcript.');
  if (input.frozenPacket.contractVersion !== 1) throw new Error('Frozen packet contractVersion must be 1.');
  if (!input.frozenPacket.provider?.trim()) throw new Error('Frozen packet provider is required.');
  if (!Array.isArray(input.frozenPacket.items)) throw new Error('Frozen packet items must be an array.');
  if (input.frozenPacket.sourceMetadata.contentHash !== sourceHash) throw new Error('Frozen packet source hash does not match the submitted source file.');

  const filedSource = fileProjectArtifact(db, projectId, 'transcripts', input.sourceFile.name, sourceBytes);
  const packetJson = JSON.stringify(input.frozenPacket);
  const packetHash = createHash('sha256').update(packetJson).digest('hex');
  if (input.frozenPacket.packetHash && input.frozenPacket.packetHash !== packetHash) throw new Error('Frozen packet hash does not match the submitted packet.');
  const timestamp = nowIso();
  const sourceId = `source:${projectId}:${sourceHash.slice(0, 16)}`;
  const jobId = `source-job:${projectId}:${packetHash.slice(0, 16)}`;
  const proposedId = `proposed:${projectId}:${packetHash.slice(0, 16)}`;
  const writeId = `ai-write:${projectId}:${packetHash.slice(0, 16)}`;
  const extractedIds = input.frozenPacket.items.map((candidate) => candidate.id);
  const existing = db.prepare('SELECT id FROM proposed_changes WHERE id = ?').get(proposedId) as { id: string } | undefined;
  if (existing) {
    return { sourceId, proposedChangeId: proposedId, duplicate: true, packetHash, sourceHash, filedSource: filedSource.relativePath, extractedCount: extractedIds.length };
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO project_source_intake (id, project_id, original_file_name, original_received_at, content_hash, source_type, current_external_path, previous_external_path, processing_status, processor_provider, extracted_item_ids_json, review_state, verification_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, content_hash) DO UPDATE SET current_external_path = excluded.current_external_path, processing_status = excluded.processing_status, processor_provider = excluded.processor_provider, extracted_item_ids_json = excluded.extracted_item_ids_json, review_state = excluded.review_state, verification_state = excluded.verification_state, updated_at = excluded.updated_at')
      .run(sourceId, projectId, input.sourceFile.name, timestamp, sourceHash, sourceType, filedSource.destinationPath, null, 'awaiting_review', `${input.frozenPacket.provider}${input.frozenPacket.model ? `/${input.frozenPacket.model}` : ''}`, JSON.stringify(extractedIds), 'proposed', 'pending', timestamp, timestamp);
    db.prepare('INSERT INTO source_processing_jobs (id, source_id, project_id, provider, status, started_at, completed_at, error_message, structured_output_contract, proposed_change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, sourceId, projectId, input.frozenPacket.provider, 'completed', timestamp, timestamp, null, 'projectmanagair-blind-ptw-extraction-v1', proposedId);
    db.prepare('INSERT INTO proposed_changes (id, project_id, source_id, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proposedId, projectId, sourceId, 'proposed', packetJson, timestamp);
    db.prepare('INSERT INTO source_file_history (id, source_id, project_id, from_external_path, to_external_path, action, occurred_at, actor, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sourceId, projectId, null, filedSource.destinationPath, 'filed-immutable-original', timestamp, 'Project ManagAIr', sourceHash);
    db.prepare('INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(writeId, projectId, 'Benchmark-informed extraction packet', 'source', sourceId, 'complete', 'pending', 'sealed-benchmark-comparison', timestamp, null, null, `Frozen packet SHA-256 ${packetHash}. Awaiting sealed benchmark comparison.`, 'current-user', 'operational-reference');
    db.prepare('INSERT INTO verifications (id, project_id, ai_write_id, verification_status, method, checked_at, checked_by, summary, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, writeId, 'pending', 'sealed-benchmark-comparison', timestamp, 'Project ManagAIr', 'Frozen blind extraction packet recorded; sealed benchmark comparison has not been run.', 'operational-reference');
    db.prepare('INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, timestamp, 'ai', 'Benchmark-informed extraction packet frozen for comparison; it remains a read-only proposal.', 'Project ManagAIr', 'source', sourceId, 'operational-reference');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { sourceId, proposedChangeId: proposedId, duplicate: false, packetHash, sourceHash, filedSource: filedSource.relativePath, extractedCount: extractedIds.length };
}
function readProposal(db: DatabaseSync, proposedChangeId: string) {
  return db.prepare('SELECT * FROM proposed_changes WHERE id = ?').get(proposedChangeId) as Record<string, unknown> | undefined;
}

export function approveProposedChange(db: DatabaseSync, proposedChangeId: string, _reviewer = 'current-user') {
  const proposal = readProposal(db, proposedChangeId);
  if (!proposal) throw new Error('Proposed change was not found.');
  if (String(proposal.status) === 'applied') return { proposedChangeId, alreadyApplied: true, created: [] };
  throw new Error('Legacy whole-proposal approval is disabled. Review and apply a Source Intelligence changeset instead.');
}
export function rejectProposedChange(db: DatabaseSync, proposedChangeId: string, _reviewer = 'current-user') {
  const proposal = readProposal(db, proposedChangeId);
  if (!proposal) throw new Error('Proposed change was not found.');
  if (String(proposal.status) === 'rejected') return { proposedChangeId, rejected: true, alreadyRejected: true };
  throw new Error('Legacy proposals are read-only historical records. Use governed Source Intelligence changesets for review.');
}
export function openOriginalPath(db: DatabaseSync, filePath: string) {
  const root = configuredRoot(db);
  const resolved = path.resolve(filePath);
  assertInside(root, resolved);
  if (!existsSync(resolved)) throw new Error('File does not exist.');
  spawn('cmd', ['/c', 'start', '', resolved], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { opened: true };
}
export function fileProjectArtifact(db: DatabaseSync, projectId: string, destinationKey: keyof typeof storageMapping, originalName: string, bytes: Buffer) {
  const root = configuredRoot(db);
  const pPath = projectPath(db, projectId);
  const destinationDir = path.join(pPath, storageMapping[destinationKey]);
  assertInside(root, destinationDir);
  mkdirSync(destinationDir, { recursive: true });
  const hash = createHash('sha256').update(bytes).digest('hex');
  const destinationPath = path.join(destinationDir, fileNameFor(originalName, hash));
  assertInside(root, destinationPath);
  if (!existsSync(destinationPath)) writeFileSync(destinationPath, bytes);
  return { destinationPath, hash, relativePath: path.relative(pPath, destinationPath) };
}
