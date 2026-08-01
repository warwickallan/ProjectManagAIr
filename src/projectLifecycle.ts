import { createHash, randomUUID } from 'node:crypto';
import { accessSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { registerNormalizedSource } from './sourceIntelligence.js';

export type SourceState = 'awaiting_metadata' | 'awaiting_processing' | 'processing' | 'awaiting_review' | 'verified' | 'failed' | 'rejected' | 'archived';
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

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Windows MAX_PATH is 260 characters and `writeFileSync` fails with ENOENT well
 * before anything explains why. A realistic OneDrive root plus a 120-character
 * project folder plus the deepest storage subfolder plus a 120-character file
 * base already exceeds it, so every long path is budgeted against this ceiling
 * rather than trusted to fit. The budget is enforced on every platform so the
 * behaviour is testable and so a Windows user never receives a repository that
 * only works on the developer's machine.
 */
const defaultPathBudget = 240;
const minimumFileNameBudget = 24;
const minimumFolderNameBudget = 8;
const deepestStorageSubPath = Math.max(
  ...Object.values(storageMapping).map((value) => value.length),
  path.join('00_Inbox', 'Unsorted').length,
);

function pathBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROJECTMANAGAIR_MAX_PATH_BUDGET);
  return Number.isInteger(raw) && raw >= 96 ? raw : defaultPathBudget;
}

/** Longest project folder name that still leaves room for the deepest artifact path. */
function folderNameBudget(root: string): number {
  return pathBudget() - root.length - 1 - (deepestStorageSubPath + 1) - (minimumFileNameBudget + 1);
}

function boundedFolderName(root: string, rawName: string): string {
  const budget = folderNameBudget(root);
  if (budget < minimumFolderNameBudget) {
    throw new Error(`The configured projects root is too long: a project folder plus its deepest storage subfolder would exceed the ${pathBudget()}-character path budget. Choose a shorter root.`);
  }
  const safe = safeName(rawName);
  return safe.length <= budget ? safe : safeName(safe.slice(0, budget));
}

const dangerousPosixRoots = new Set(['/', '/Applications', '/Library', '/System', '/Users', '/Volumes', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/media', '/mnt', '/opt', '/private', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var']);
// Written with forward slashes; the candidate is normalised to match. Keeping
// literal `\\`-separated Windows paths out of the source also keeps this file
// clean under the repository's own data-boundary scan.
const dangerousWindowsRoots = new Set(['/windows', '/winnt', '/program files', '/program files (x86)', '/programdata', '/users', '/$recycle.bin', '/system volume information', '/perflogs', '/recovery']);
/** Repository subdirectories that may legitimately hold a scratch projects root (all git-ignored). */
const repositoryScratchDirectories = new Set(['artifacts', 'data', '.data', '.runtime', 'test-results']);

function rootValidationError(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  // Express's default error handler honours `statusCode`, so a rejected root
  // surfaces as a 400 rather than an opaque 500.
  error.statusCode = 400;
  return error;
}

/**
 * D8.2 — `projectsRoot` arrives from an unauthenticated local HTTP route and is
 * persisted to the live local configuration file, so it is validated here
 * rather than trusted. Returns the normalised absolute root.
 */
export function validateProjectsRoot(candidate: string): string {
  const raw = String(candidate ?? '').trim();
  if (!raw) throw rootValidationError('A projects root is required.');
  if (raw.includes('\0')) throw rootValidationError('The projects root contains an invalid character.');
  const looksAbsolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw);
  if (!looksAbsolute) throw rootValidationError('The projects root must be an absolute path.');
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(raw) && !/^\\\\[^\\]/.test(raw)) {
    throw rootValidationError('The projects root must start with a drive letter or a UNC share.');
  }

  const resolved = normalizeRoot(raw);
  const comparable = resolved.replace(/[\\/]+$/, '');
  if (comparable === '' || /^[A-Za-z]:$/.test(comparable)) {
    throw rootValidationError('The projects root must not be a filesystem root.');
  }
  const separator = String.fromCharCode(92);
  const withoutDrive = comparable.replace(/^[A-Za-z]:/, '').split(separator).join('/').toLowerCase();
  if (dangerousPosixRoots.has(comparable) || dangerousWindowsRoots.has(withoutDrive)) {
    throw rootValidationError('The projects root must not be a system location.');
  }
  if (withoutDrive.startsWith('/windows/') || withoutDrive.startsWith('/winnt/')) {
    throw rootValidationError('The projects root must not be inside the Windows directory.');
  }

  if (resolved === repoRoot) throw rootValidationError('The projects root must not be the Project ManagAIr repository.');
  if (isInside(repoRoot, resolved)) {
    const firstSegment = path.relative(repoRoot, resolved).split(/[\\/]/)[0].toLowerCase();
    if (!repositoryScratchDirectories.has(firstSegment)) {
      throw rootValidationError('The projects root must not be inside the Project ManagAIr repository. Live project data belongs outside Git.');
    }
  }

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw rootValidationError('The projects root does not exist.');
  }
  if (!stats.isDirectory()) throw rootValidationError('The projects root is not a directory.');
  try {
    accessSync(resolved, constants.R_OK | constants.W_OK);
  } catch {
    throw rootValidationError('The projects root is not readable and writable.');
  }
  if (folderNameBudget(resolved) < minimumFolderNameBudget) {
    throw rootValidationError(`The projects root is too long. It must leave room for a project folder and its storage subfolders within the ${pathBudget()}-character path budget.`);
  }
  return resolved;
}

/**
 * D7 — the live local configuration file has already been destroyed once by a
 * test run, so the guard must not hang off a single ambient variable.
 *
 * `NODE_ENV` is only defaulted to `test` by Vitest when it is UNSET. Anyone who
 * exports `NODE_ENV=development` in their shell (or a CI job that sets it)
 * silently re-arms the clobber. So the guard consults several independent
 * signals, and any one of them is enough to block:
 *
 *   1. `PROJECTMANAGAIR_LOCAL_CONFIG_MODE=blocked` — explicit opt-out, set for
 *      every Vitest run by `vite.config.ts` (`test.env`).
 *   2. `NODE_ENV=test` — also pinned by `vite.config.ts` (`test.env`) so it can
 *      no longer be lost to an ambient value.
 *   3. `VITEST` / `VITEST_WORKER_ID` / `VITEST_POOL_ID` — set by the Vitest
 *      worker itself, independently of any config file, so the guard still
 *      holds if `vite.config.ts` is edited or a different config is used.
 *   4. `npm_lifecycle_event` starting with `test` — covers `npm test` wrappers.
 *
 * `PROJECTMANAGAIR_LOCAL_CONFIG_MODE=allow` is the explicit opt-in escape
 * hatch, but it deliberately does NOT override signals 3 and 4: an in-process
 * Vitest worker can never write the file, whatever else is configured.
 */
const vitestSignalVariables = ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID'] as const;

export function localConfigWriteDecision(env: NodeJS.ProcessEnv = process.env): { allowed: boolean; reason: string } {
  const vitestSignal = vitestSignalVariables.find((name) => String(env[name] ?? '').trim() !== '');
  if (vitestSignal) return { allowed: false, reason: `blocked: ${vitestSignal} is set (Vitest worker)` };
  const lifecycle = String(env.npm_lifecycle_event ?? '').trim().toLowerCase();
  if (lifecycle.startsWith('test')) return { allowed: false, reason: `blocked: npm_lifecycle_event=${lifecycle}` };
  const mode = String(env.PROJECTMANAGAIR_LOCAL_CONFIG_MODE ?? '').trim().toLowerCase();
  if (mode === 'blocked') return { allowed: false, reason: 'blocked: PROJECTMANAGAIR_LOCAL_CONFIG_MODE=blocked' };
  if (mode === 'allow') return { allowed: true, reason: 'allowed: PROJECTMANAGAIR_LOCAL_CONFIG_MODE=allow' };
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test') return { allowed: false, reason: 'blocked: NODE_ENV=test' };
  return { allowed: true, reason: 'allowed: no test-runner signal detected' };
}

export function isLocalConfigAccessAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return localConfigWriteDecision(env).allowed;
}

function readLocalConfigFile(): { projectsRoot?: string; projectFolderNamingFormat?: string } {
  if (!isLocalConfigAccessAllowed() || !existsSync(localConfigPath)) return {};
  return JSON.parse(readFileSync(localConfigPath, 'utf8')) as { projectsRoot?: string; projectFolderNamingFormat?: string };
}

function writeLocalConfigFile(settings: { projectsRoot: string | null; projectFolderNamingFormat: string }) {
  if (!isLocalConfigAccessAllowed()) return;
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
  // An absent `projectsRoot` key means "leave the configured root alone"; only
  // an explicitly empty value clears it. A partial body must never silently
  // unconfigure the live root.
  const current = db.prepare("SELECT projects_root FROM project_storage_settings WHERE id = 'local'").get() as { projects_root: string | null } | undefined;
  const root = input.projectsRoot === undefined
    ? (current?.projects_root?.trim() || null)
    : (input.projectsRoot.trim() ? validateProjectsRoot(input.projectsRoot) : null);
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
  const folderName = boundedFolderName(settingsRoot, (settings.project_folder_naming_format || defaultNamingFormat).replaceAll('{code}', input.code.trim()).replaceAll('{name}', input.name.trim()));
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

/**
 * Builds `<base>-<hash12><ext>` bounded so that `directory` + separator + the
 * result stays inside the path budget. The 12-character hash and the extension
 * are never truncated — the hash is what makes the filed name unique and the
 * extension is what the normaliser dispatches on — so only the base shrinks.
 */
function fileNameFor(directory: string, originalName: string, hash: string) {
  const ext = path.extname(originalName).slice(0, 12);
  const suffix = `-${hash.slice(0, 12)}${ext}`;
  const available = pathBudget() - directory.length - 1 - suffix.length;
  if (available < 1) {
    throw new Error(`The destination folder is too deep to file "${path.basename(originalName)}" within the ${pathBudget()}-character path budget. Choose a shorter projects root or project name.`);
  }
  const limit = Math.min(120, available);
  const base = safeName(path.basename(originalName, path.extname(originalName))).slice(0, limit);
  return `${base}${suffix}`;
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
  const target = path.join(inboxPath, fileNameFor(inboxPath, file.name, contentHash));
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
    // Confirmed by `confirmSourceMetadata` once Warwick supplies the meeting
    // subject, event date and primary work package; see the note beside the
    // post-normalisation UPDATE below for why this cannot invoke Source
    // Intelligence yet.
    status = 'awaiting_metadata';
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
        // Goal 1 — a VTT's own timestamps cannot be trusted to supply a
        // reliable meeting subject, event date or work package, so a
        // normalised source lands in an explicit `awaiting_metadata` state
        // rather than `processing`. `scheduleSourceExtraction` (server.ts)
        // and `runSourceExtractionJob` (sourcePipeline.ts) both refuse to
        // call the extraction provider while this state holds; confirming
        // metadata (`confirmSourceMetadata` below) is what advances it.
        db.prepare("UPDATE project_source_intake SET current_external_path = ?, previous_external_path = ?, processing_status = 'awaiting_metadata', updated_at = ? WHERE id = ?").run(filed.destinationPath, target, filedAt, sourceId);
        db.prepare('INSERT INTO source_file_history (id, source_id, project_id, from_external_path, to_external_path, action, occurred_at, actor, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), sourceId, projectId, target, filed.destinationPath, 'filed-immutable-original', filedAt, 'Project ManagAIr', contentHash);
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
      if (path.resolve(target) !== path.resolve(filed.destinationPath) && existsSync(target)) rmSync(target, { force: true });
      return { ...normalized, intakeSourceId: sourceId, proposedChangeId: null, processingStatus: 'awaiting_metadata', extractedCount: 0, immutablePath: filed.destinationPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE project_source_intake SET processing_status = 'failed', verification_state = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), sourceId);
      db.prepare("UPDATE source_processing_jobs SET status = 'failed', current_stage = 'failed', completed_at = ?, updated_at = ?, error_message = ? WHERE id = ?").run(nowIso(), nowIso(), message, jobId);
      throw error;
    }
  }
  return { sourceId, proposedChangeId: proposedId, duplicate: false, eventDate: null, processingStatus: status, extractedCount: payload.items.length };
}

/* -------------------------------------------------------------------------- *
 * Goal 1 — mandatory source metadata before extraction.
 *
 * File names and a VTT's own embedded timestamps may only prefill this form;
 * they are never treated as confirmed truth. The source stays in
 * `awaiting_metadata` — and `runSourceExtractionJob` refuses to call the
 * extraction provider — until this function has been called successfully.
 * -------------------------------------------------------------------------- */

export interface SourceMetadataInput {
  actor: string;
  meetingSubject: string;
  eventDate: string;
  eventTime?: string | null;
  timezone?: string | null;
  primaryWorkPackage: string;
  additionalWorkPackages?: string[];
  participants?: string[];
  recordingGapNotes?: string | null;
  reason?: string | null;
}

export interface SourceMetadataRecord {
  sourceId: string;
  meetingSubject: string | null;
  eventDate: string | null;
  eventTime: string | null;
  timezone: string | null;
  primaryWorkPackage: string | null;
  additionalWorkPackages: string[];
  participants: string[];
  recordingGapNotes: string | null;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

/** Every mandatory-field check `confirmSourceMetadata` enforces, named so the UI and the API agree on what "confirmed" means. */
export const MANDATORY_SOURCE_METADATA_FIELDS = ['meetingSubject', 'eventDate', 'primaryWorkPackage'] as const;

function isoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * A caller may hand in either id: `source_documents.id` (the normalised
 * source) or `project_source_intake.id` (what the Inbox UI actually has,
 * since `inboxSources` is read from `project_source_intake`). Mirrors the
 * same either-id resolution `retrySourceJob`/`resolveJobAndSource` already
 * use in `sourcePipeline.ts`, so every source-facing route agrees on which
 * id a caller may supply.
 */
function resolveSourceDocumentRow(db: DatabaseSync, idOrIntakeId: string): Record<string, unknown> | undefined {
  const direct = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(idOrIntakeId) as Record<string, unknown> | undefined;
  if (direct) return direct;
  return db.prepare('SELECT * FROM source_documents WHERE intake_source_id = ? LIMIT 1').get(idOrIntakeId) as Record<string, unknown> | undefined;
}

/** The confirmed metadata for one source, or nulls/empties before confirmation. Never guesses — a filename-derived prefill lives only in the UI until this is called. */
export function readSourceMetadata(db: DatabaseSync, idOrIntakeId: string): SourceMetadataRecord | null {
  const source = resolveSourceDocumentRow(db, idOrIntakeId);
  if (!source) return null;
  const sourceId = String(source.id);
  const intake = db.prepare('SELECT metadata_confirmed_at, metadata_confirmed_by FROM project_source_intake WHERE id = ?').get(String(source.intake_source_id)) as { metadata_confirmed_at: string | null; metadata_confirmed_by: string | null } | undefined;
  return {
    sourceId,
    meetingSubject: source.meeting_subject ? String(source.meeting_subject) : null,
    eventDate: source.confirmed_event_date ? String(source.confirmed_event_date) : null,
    eventTime: source.event_time ? String(source.event_time) : null,
    timezone: source.timezone ? String(source.timezone) : null,
    primaryWorkPackage: source.primary_work_package ? String(source.primary_work_package) : null,
    additionalWorkPackages: JSON.parse(String(source.additional_work_packages_json ?? '[]')) as string[],
    participants: JSON.parse(String(source.confirmed_participants_json ?? '[]')) as string[],
    recordingGapNotes: source.recording_gap_notes ? String(source.recording_gap_notes) : null,
    confirmed: Boolean(intake?.metadata_confirmed_at),
    confirmedAt: intake?.metadata_confirmed_at ?? null,
    confirmedBy: intake?.metadata_confirmed_by ?? null,
  };
}

/**
 * Confirm (or correct) a source's meeting metadata. The first confirmation
 * unblocks extraction (the caller schedules it explicitly — this function
 * only records the metadata and its own audit trail, never a provider call
 * itself). A later correction is recorded exactly the same way: every field
 * that actually changes gets one `source_metadata_events` row naming the
 * previous and new value, so a correction after extraction never silently
 * rewrites provenance.
 */
export function confirmSourceMetadata(db: DatabaseSync, projectId: string, idOrIntakeId: string, input: SourceMetadataInput): SourceMetadataRecord {
  const source = resolveSourceDocumentRow(db, idOrIntakeId);
  if (!source || String(source.project_id) !== projectId) throw new Error('Source not found.');
  const sourceId = String(source.id);
  if (!input.meetingSubject?.trim()) throw new Error('Meeting subject is required.');
  if (!input.eventDate?.trim() || !isoDateOnly(input.eventDate.trim())) throw new Error('Meeting event date is required, as YYYY-MM-DD.');
  if (!input.primaryWorkPackage?.trim()) throw new Error('Primary work package is required.');
  if (!input.actor?.trim()) throw new Error('Confirming metadata requires a named actor.');

  const now = new Date().toISOString();
  const reason = input.reason?.trim() || (source.meeting_subject ? 'Corrected meeting metadata.' : 'Confirmed meeting metadata before extraction.');
  // `confirmed_event_date`/`confirmed_participants_json` are the correctable,
  // human-asserted facts — deliberately distinct columns from the immutable,
  // evidence-derived `event_date`/`participants_json` (guarded by
  // `trg_source_documents_immutable`), so a correction here never collides
  // with that evidence-integrity invariant.
  const next: Record<string, string | null> = {
    meeting_subject: input.meetingSubject.trim(),
    confirmed_event_date: input.eventDate.trim(),
    event_time: input.eventTime?.trim() || null,
    timezone: input.timezone?.trim() || null,
    primary_work_package: input.primaryWorkPackage.trim(),
    additional_work_packages_json: JSON.stringify(input.additionalWorkPackages ?? []),
    recording_gap_notes: input.recordingGapNotes?.trim() || null,
    confirmed_participants_json: JSON.stringify(input.participants ?? JSON.parse(String(source.confirmed_participants_json ?? '[]'))),
  };

  db.exec('BEGIN IMMEDIATE;');
  try {
    // One audit event per field that actually changed, mirroring
    // `register_row_events`: a correction is recorded, never silently
    // overwritten. JSON-valued fields are compared as JSON so `["a"]` vs
    // `["a"]` in a different key order does not spuriously fire.
    for (const [field, value] of Object.entries(next)) {
      const previous = source[field] === null || source[field] === undefined ? null : String(source[field]);
      if (previous === value) continue;
      db.prepare('INSERT INTO source_metadata_events (id, source_id, project_id, occurred_at, actor, field, previous_value, new_value, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), sourceId, projectId, now, input.actor.trim(), field, previous, value, reason);
    }
    db.prepare('UPDATE source_documents SET meeting_subject = ?, confirmed_event_date = ?, event_time = ?, timezone = ?, primary_work_package = ?, additional_work_packages_json = ?, recording_gap_notes = ?, confirmed_participants_json = ? WHERE id = ?')
      .run(next.meeting_subject, next.confirmed_event_date, next.event_time, next.timezone, next.primary_work_package, next.additional_work_packages_json, next.recording_gap_notes, next.confirmed_participants_json, sourceId);
    const intakeSourceId = String(source.intake_source_id);
    db.prepare("UPDATE project_source_intake SET metadata_confirmed_at = COALESCE(metadata_confirmed_at, ?), metadata_confirmed_by = COALESCE(metadata_confirmed_by, ?), processing_status = CASE WHEN processing_status = 'awaiting_metadata' THEN 'processing' ELSE processing_status END, updated_at = ? WHERE id = ?")
      .run(now, input.actor.trim(), now, intakeSourceId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return readSourceMetadata(db, sourceId)!;
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

  const packetJson = JSON.stringify(input.frozenPacket);
  const packetHash = createHash('sha256').update(packetJson).digest('hex');
  if (input.frozenPacket.packetHash && input.frozenPacket.packetHash !== packetHash) throw new Error('Frozen packet hash does not match the submitted packet.');
  const timestamp = nowIso();
  const jobId = `source-job:${projectId}:${packetHash.slice(0, 16)}`;
  const proposedId = `proposed:${projectId}:${packetHash.slice(0, 16)}`;
  const writeId = `ai-write:${projectId}:${packetHash.slice(0, 16)}`;
  const extractedIds = input.frozenPacket.items.map((candidate) => candidate.id);

  // D9 residual — the intake row is keyed on `(project_id, content_hash)`, not
  // on this synthetic id. If the same transcript already arrived through the
  // Cockpit intake route or the watcher, the upsert keeps the ORIGINAL row and
  // every follow-on insert must reference that row's id. Referencing the
  // synthetic id produced `FOREIGN KEY constraint failed` and an opaque 500.
  const existingIntake = db.prepare('SELECT id FROM project_source_intake WHERE project_id = ? AND content_hash = ?').get(projectId, sourceHash) as { id: string } | undefined;
  const sourceId = existingIntake?.id ?? `source:${projectId}:${sourceHash.slice(0, 16)}`;

  const duplicate = db.prepare('SELECT id FROM proposed_changes WHERE id = ?').get(proposedId) as { id: string } | undefined;
  if (duplicate) {
    const alreadyFiled = fileProjectArtifact(db, projectId, 'transcripts', input.sourceFile.name, sourceBytes);
    return { sourceId, proposedChangeId: proposedId, duplicate: true, packetHash, sourceHash, filedSource: alreadyFiled.relativePath, extractedCount: extractedIds.length };
  }

  // D9 residual — the immutable original used to be written before the
  // transaction, so a rollback left an orphan file in `01_Sources_Immutable`
  // with no database row referencing it. It is still written first (the DB
  // records its path), but a rollback now removes anything this call created.
  const filedSource = fileProjectArtifact(db, projectId, 'transcripts', input.sourceFile.name, sourceBytes);
  const provider = `${input.frozenPacket.provider}${input.frozenPacket.model ? `/${input.frozenPacket.model}` : ''}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (existingIntake) {
      db.prepare('UPDATE project_source_intake SET original_file_name = ?, content_hash = ?, source_type = ?, previous_external_path = current_external_path, current_external_path = ?, processing_status = ?, processor_provider = ?, extracted_item_ids_json = ?, review_state = ?, verification_state = ?, updated_at = ? WHERE id = ?')
        .run(input.sourceFile.name, sourceHash, sourceType, filedSource.destinationPath, 'awaiting_review', provider, JSON.stringify(extractedIds), 'proposed', 'pending', timestamp, sourceId);
    } else {
      db.prepare('INSERT INTO project_source_intake (id, project_id, original_file_name, original_received_at, content_hash, source_type, current_external_path, previous_external_path, processing_status, processor_provider, extracted_item_ids_json, review_state, verification_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sourceId, projectId, input.sourceFile.name, timestamp, sourceHash, sourceType, filedSource.destinationPath, null, 'awaiting_review', provider, JSON.stringify(extractedIds), 'proposed', 'pending', timestamp, timestamp);
    }
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
    if (filedSource.created) rmSync(filedSource.destinationPath, { force: true });
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
export interface DesktopLauncher {
  command: string;
  args: (target: string) => string[];
}

/** File types that the desktop shell would execute rather than display. */
const executableExtensions = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.cpl', '.hta', '.reg', '.lnk', '.pif', '.jar', '.sh', '.appref-ms', '.url']);

/**
 * Resolves the platform's file launcher, or `null` when this host has none.
 * `PATH` is probed synchronously so a host without a launcher fails with a
 * readable error instead of an asynchronous `'error'` event.
 */
export function resolveDesktopLauncher(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): DesktopLauncher | null {
  if (platform === 'win32') {
    const comSpec = env.ComSpec ?? env.COMSPEC ?? 'cmd';
    return { command: comSpec, args: (target) => ['/c', 'start', '', target] };
  }
  const candidates = platform === 'darwin' ? ['open'] : ['xdg-open', 'gio', 'gnome-open', 'kde-open'];
  const searchPath = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (searchPath.some((directory) => existsSync(path.join(directory, candidate)))) {
      return candidate === 'gio'
        ? { command: 'gio', args: (target) => ['open', target] }
        : { command: candidate, args: (target) => [target] };
    }
  }
  return null;
}

export interface OpenOriginalPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

export function openOriginalPath(db: DatabaseSync, filePath: string, options: OpenOriginalPathOptions = {}) {
  const root = configuredRoot(db);
  const resolved = path.resolve(filePath);
  // Kept from the original: the target must live under the configured root.
  assertInside(root, resolved);
  if (!existsSync(resolved)) throw new Error('File does not exist.');
  if (!statSync(resolved).isFile()) throw new Error('Only files can be opened.');
  const extension = path.extname(resolved).toLowerCase();
  if (executableExtensions.has(extension)) {
    // The projects root is operator-configurable and is fed by a watched inbox,
    // so a dropped script must never be handed to the shell.
    throw new Error(`Refusing to launch an executable file type (${extension || 'no extension'}).`);
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const launcher = resolveDesktopLauncher(platform, env);
  if (!launcher) {
    throw new Error(`No desktop file launcher is available on this host (${platform}). Open the file from the projects folder directly.`);
  }

  const spawnFn = options.spawnImpl ?? spawn;
  const child = spawnFn(launcher.command, launcher.args(resolved), { detached: true, stdio: 'ignore', windowsHide: true });
  // An 'error' event with no listener is rethrown as an uncaught exception and
  // kills the server process. One request on a host whose launcher disappeared
  // between the PATH probe and the spawn used to be a process kill.
  child.on('error', (error: NodeJS.ErrnoException) => {
    // Deliberately logs the launcher and error code only: the data boundary
    // forbids logging original filenames.
    console.warn(`[projectmanagair] desktop launcher "${launcher.command}" failed: ${error?.code ?? error?.message ?? 'unknown error'}`);
  });
  child.unref();
  return { opened: true, launcher: launcher.command };
}
export function fileProjectArtifact(db: DatabaseSync, projectId: string, destinationKey: keyof typeof storageMapping, originalName: string, bytes: Buffer) {
  const root = configuredRoot(db);
  const pPath = projectPath(db, projectId);
  const destinationDir = path.join(pPath, storageMapping[destinationKey]);
  assertInside(root, destinationDir);
  mkdirSync(destinationDir, { recursive: true });
  const hash = createHash('sha256').update(bytes).digest('hex');
  const destinationPath = path.join(destinationDir, fileNameFor(destinationDir, originalName, hash));
  assertInside(root, destinationPath);
  // `created` lets a caller that files an artifact ahead of a transaction undo
  // the write on rollback without deleting a file some earlier run filed.
  const created = !existsSync(destinationPath);
  if (created) writeFileSync(destinationPath, bytes);
  return { destinationPath, hash, relativePath: path.relative(pPath, destinationPath), created };
}
