import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { importPayloadSchema, portfolioDataSchema, type ImportPayload, type PortfolioData, type Project, type UserConfig } from './domain.js';

type SqlValue = string | number | bigint | null;

export interface DatabaseContext {
  db: DatabaseSync;
  dbPath: string;
  migrationsApplied: string[];
}

export interface ImportResult {
  importRunId: string;
  projectId: string;
  recordsWritten: number;
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDbPath = path.resolve(repoRoot, '..', 'Data', 'projectmanagair.db');
const migrationDir = path.join(repoRoot, 'migrations');

export function resolveDatabasePath(): string {
  return process.env.PROJECTMANAGAIR_DB_PATH ? path.resolve(process.env.PROJECTMANAGAIR_DB_PATH) : defaultDbPath;
}

export function openProjectManagairDatabase(dbPath = resolveDatabasePath()): DatabaseContext {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA trusted_schema = OFF;');
  const migrationsApplied = applyMigrations(db);
  return { db, dbPath, migrationsApplied };
}

export function applyMigrations(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);

  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((row) => row.id));
  const appliedNow: string[] = [];
  for (const file of readdirSync(migrationDir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationDir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE;');
    try {
      executeMigrationSql(db, file, sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
      db.exec('COMMIT;');
      appliedNow.push(file);
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (fkViolations.length > 0) throw new Error(`SQLite foreign key check failed: ${JSON.stringify(fkViolations)}`);
  return appliedNow;
}


function executeMigrationSql(db: DatabaseSync, file: string, sql: string) {
  if (file !== '003_project_lifecycle.sql') {
    db.exec(sql);
    return;
  }
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    try {
      db.exec(`${statement};`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicateProjectColumn = /^ALTER TABLE projects ADD COLUMN/i.test(statement) && /duplicate column name/i.test(message);
      if (!duplicateProjectColumn) throw error;
    }
  }
}
function userConfig(db: DatabaseSync): UserConfig {
  const rows = db.prepare('SELECT key, value FROM app_config').all() as Array<{ key: string; value: string | null }>;
  const config = new Map(rows.map((row) => [row.key, row.value]));
  const displayName = config.get('current_user_display_name')?.trim() || undefined;
  return { userId: config.get('current_user_id') || 'current-user', displayName };
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function readPortfolioData(db: DatabaseSync): PortfolioData {
  const projectRows = db.prepare('SELECT * FROM projects ORDER BY name').all() as Array<Record<string, unknown>>;
  const projects = projectRows.map((row) => readProjectFromRows(db, row));
  const asOf = projects.map((project) => project.asOf).sort().at(-1) ?? new Date().toISOString();
  return portfolioDataSchema.parse({ schemaVersion: 1, dataClassification: 'operational-reference', asOf, userConfig: userConfig(db), projects });
}

export function readProjectData(db: DatabaseSync, projectId: string): PortfolioData | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const project = readProjectFromRows(db, row);
  return portfolioDataSchema.parse({ schemaVersion: 1, dataClassification: 'operational-reference', asOf: project.asOf, userConfig: userConfig(db), projects: [project] });
}

function readProjectFromRows(db: DatabaseSync, row: Record<string, unknown>): Project {
  const projectId = String(row.id);
  const project = {
    id: projectId,
    name: String(row.name),
    code: String(row.code),
    summary: String(row.summary),
    deliveryStatus: String(row.delivery_status),
    stage: String(row.stage),
    owner: String(row.owner),
    startDate: String(row.start_date),
    targetDate: String(row.target_date),
    nextMilestoneId: String(row.next_milestone_id ?? ''),
    updatedAt: String(row.updated_at),
    asOf: String(row.as_of),
    dataClassification: String(row.data_classification),
    externalPath: row.external_path ? String(row.external_path) : null,
    folderName: row.folder_name ? String(row.folder_name) : null,
    projectSources: (db.prepare('SELECT * FROM project_sources WHERE project_id = ? ORDER BY label').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, sourceType: String(item.source_type), label: String(item.label), externalPath: String(item.external_path), lastSeenAt: item.last_seen_at ? String(item.last_seen_at) : null, dataClassification: String(item.data_classification),
    })),
    actions: (db.prepare('SELECT * FROM actions WHERE project_id = ? ORDER BY due_date, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), priority: String(item.priority), dueDate: item.due_date ? String(item.due_date) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null, attentionReason: item.attention_reason ? String(item.attention_reason) : null,
    })),
    risksIssues: (db.prepare('SELECT * FROM risks_issues WHERE project_id = ? ORDER BY severity DESC, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), kind: String(item.kind), severity: String(item.severity), likelihood: item.likelihood ? String(item.likelihood) : null, impact: String(item.impact), response: String(item.response), targetResolutionDate: item.target_resolution_date ? String(item.target_resolution_date) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null,
    })),
    changes: (db.prepare('SELECT * FROM changes WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), changeType: String(item.change_type), impact: String(item.impact), decisionId: item.decision_id ? String(item.decision_id) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null, attentionReason: item.attention_reason ? String(item.attention_reason) : null,
    })),
    decisions: (db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decision_needed_by, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), decisionStatus: String(item.decision_status), decisionNeededBy: item.decision_needed_by ? String(item.decision_needed_by) : null, optionsSummary: String(item.options_summary), outcome: item.outcome ? String(item.outcome) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null,
    })),
    openQuestions: (db.prepare('SELECT * FROM open_questions WHERE project_id = ? ORDER BY answer_needed_by, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), question: String(item.question), answerNeededBy: item.answer_needed_by ? String(item.answer_needed_by) : null, blocking: bool(item.blocking), resolution: item.resolution ? String(item.resolution) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null,
    })),
    milestones: (db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY target_date, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), targetDate: String(item.target_date), milestoneStatus: String(item.milestone_status), completionPercent: Number(item.completion_percent), workPackageIds: jsonArray(item.work_package_ids_json as string), needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null,
    })),
    workPackages: (db.prepare('SELECT * FROM work_packages WHERE project_id = ? ORDER BY target_date, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), workPackageStatus: String(item.work_package_status), lead: String(item.lead), startDate: String(item.start_date), targetDate: String(item.target_date), completionPercent: Number(item.completion_percent), blockerSummary: item.blocker_summary ? String(item.blocker_summary) : null, milestoneId: String(item.milestone_id ?? ''), needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null,
    })),
    activity: (db.prepare('SELECT * FROM activity_events WHERE project_id = ? ORDER BY occurred_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, occurredAt: String(item.occurred_at), eventType: String(item.event_type), summary: String(item.summary), actor: String(item.actor), relatedEntityType: String(item.related_entity_type), relatedEntityId: String(item.related_entity_id), dataClassification: String(item.data_classification),
    })),
    deliverables: (db.prepare('SELECT * FROM deliverables WHERE project_id = ? ORDER BY due_date, title').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, title: String(item.title), status: String(item.status), owner: String(item.owner), updatedAt: String(item.updated_at), dataClassification: String(item.data_classification), summary: String(item.summary), deliverableType: String(item.deliverable_type), externalPath: item.external_path ? String(item.external_path) : null, dueDate: item.due_date ? String(item.due_date) : null, needsUserAttention: bool(item.needs_user_attention), attentionOwner: item.attention_owner ? String(item.attention_owner) : null, attentionReason: item.attention_reason ? String(item.attention_reason) : null,
    })),
    aiWork: (db.prepare('SELECT * FROM ai_writes WHERE project_id = ? ORDER BY label').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, label: String(item.label), relatedEntityType: String(item.related_entity_type), relatedEntityId: String(item.related_entity_id), writeStatus: String(item.write_status), verificationStatus: String(item.verification_status), verificationMethod: item.verification_method ? String(item.verification_method) : null, lastAttemptAt: item.last_attempt_at ? String(item.last_attempt_at) : null, verifiedAt: item.verified_at ? String(item.verified_at) : null, verifiedBy: item.verified_by ? String(item.verified_by) : null, statusDetail: String(item.status_detail), attentionOwner: item.attention_owner ? String(item.attention_owner) : null, dataClassification: String(item.data_classification),
    })),
    verifications: (db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY checked_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, aiWriteId: item.ai_write_id ? String(item.ai_write_id) : null, verificationStatus: String(item.verification_status), method: item.method ? String(item.method) : null, checkedAt: item.checked_at ? String(item.checked_at) : null, checkedBy: item.checked_by ? String(item.checked_by) : null, summary: String(item.summary), dataClassification: String(item.data_classification),
    })),
    provenance: (db.prepare('SELECT * FROM provenance_file_refs WHERE project_id = ? ORDER BY entity_type, label').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, entityType: String(item.entity_type), entityId: String(item.entity_id), label: String(item.label), externalPath: String(item.external_path), evidenceKind: String(item.evidence_kind), capturedAt: item.captured_at ? String(item.captured_at) : null, dataClassification: String(item.data_classification),
    })),
    inboxSources: (db.prepare('SELECT * FROM project_source_intake WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, originalFileName: String(item.original_file_name), originalReceivedAt: String(item.original_received_at), contentHash: String(item.content_hash), sourceType: String(item.source_type), currentExternalPath: String(item.current_external_path), previousExternalPath: item.previous_external_path ? String(item.previous_external_path) : null, processingStatus: String(item.processing_status), processorProvider: String(item.processor_provider), extractedItemIds: jsonArray(item.extracted_item_ids_json as string), reviewState: String(item.review_state), verificationState: String(item.verification_state), createdAt: String(item.created_at), updatedAt: String(item.updated_at),
    })),
    proposedChanges: (db.prepare('SELECT * FROM proposed_changes WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), projectId, sourceId: String(item.source_id), status: String(item.status), payload: JSON.parse(String(item.payload_json)) as unknown, createdAt: String(item.created_at), reviewedAt: item.reviewed_at ? String(item.reviewed_at) : null, reviewedBy: item.reviewed_by ? String(item.reviewed_by) : null, appliedAt: item.applied_at ? String(item.applied_at) : null,
    })),
    sourceEntityProvenance: (db.prepare('SELECT * FROM source_entity_provenance WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), sourceId: String(item.source_id), projectId, entityType: String(item.entity_type), entityId: String(item.entity_id), sourcePath: String(item.source_path), contentHash: String(item.content_hash), createdAt: String(item.created_at),
    })),
    sourceFileHistory: (db.prepare('SELECT * FROM source_file_history WHERE project_id = ? ORDER BY occurred_at DESC').all(projectId) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id), sourceId: String(item.source_id), projectId, fromExternalPath: item.from_external_path ? String(item.from_external_path) : null, toExternalPath: String(item.to_external_path), action: String(item.action), occurredAt: String(item.occurred_at), actor: String(item.actor), contentHash: String(item.content_hash),
    })),
  };
  return project as Project;
}

export function importProjectPayload(db: DatabaseSync, rawPayload: unknown): ImportResult {
  const payload = importPayloadSchema.parse(rawPayload);
  const project = payload.project;
  const now = new Date().toISOString();
  const importRunId = `import:${project.id}:${now}`;
  let recordsWritten = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`INSERT INTO projects (id, name, code, summary, delivery_status, stage, owner, start_date, target_date, next_milestone_id, updated_at, as_of, data_classification, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code, summary = excluded.summary, delivery_status = excluded.delivery_status, stage = excluded.stage, owner = excluded.owner, start_date = excluded.start_date, target_date = excluded.target_date, next_milestone_id = excluded.next_milestone_id, updated_at = excluded.updated_at, as_of = excluded.as_of, data_classification = excluded.data_classification, imported_at = excluded.imported_at`).run(project.id, project.name, project.code, project.summary, project.deliveryStatus, project.stage, project.owner, project.startDate, project.targetDate, project.nextMilestoneId, project.updatedAt, project.asOf, project.dataClassification, now);
    recordsWritten += 1;

    const upsert = (sql: string, rows: SqlValue[][]) => {
      const statement = db.prepare(sql);
      for (const row of rows) {
        statement.run(...row);
        recordsWritten += 1;
      }
    };

    upsert(`INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, source_type = excluded.source_type, label = excluded.label, external_path = excluded.external_path, last_seen_at = excluded.last_seen_at, data_classification = excluded.data_classification`, project.projectSources.map((item) => [item.id, item.projectId, item.sourceType, item.label, item.externalPath, item.lastSeenAt, item.dataClassification]));
    upsert(`INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, priority = excluded.priority, due_date = excluded.due_date, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner, attention_reason = excluded.attention_reason`, project.actions.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.priority, item.dueDate, item.needsUserAttention ? 1 : 0, item.attentionOwner, item.attentionReason]));
    upsert(`INSERT INTO risks_issues (id, project_id, title, status, owner, updated_at, data_classification, summary, kind, severity, likelihood, impact, response, target_resolution_date, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, kind = excluded.kind, severity = excluded.severity, likelihood = excluded.likelihood, impact = excluded.impact, response = excluded.response, target_resolution_date = excluded.target_resolution_date, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner`, project.risksIssues.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.kind, item.severity, item.likelihood, item.impact, item.response, item.targetResolutionDate, item.needsUserAttention ? 1 : 0, item.attentionOwner]));
    upsert(`INSERT INTO changes (id, project_id, title, status, owner, updated_at, data_classification, summary, change_type, impact, decision_id, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, change_type = excluded.change_type, impact = excluded.impact, decision_id = excluded.decision_id, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner, attention_reason = excluded.attention_reason`, project.changes.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.changeType, item.impact, item.decisionId, item.needsUserAttention ? 1 : 0, item.attentionOwner, item.attentionReason]));
    upsert(`INSERT INTO decisions (id, project_id, title, status, owner, updated_at, data_classification, summary, decision_status, decision_needed_by, options_summary, outcome, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, decision_status = excluded.decision_status, decision_needed_by = excluded.decision_needed_by, options_summary = excluded.options_summary, outcome = excluded.outcome, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner`, project.decisions.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.decisionStatus, item.decisionNeededBy, item.optionsSummary, item.outcome, item.needsUserAttention ? 1 : 0, item.attentionOwner]));
    upsert(`INSERT INTO open_questions (id, project_id, title, status, owner, updated_at, data_classification, summary, question, answer_needed_by, blocking, resolution, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, question = excluded.question, answer_needed_by = excluded.answer_needed_by, blocking = excluded.blocking, resolution = excluded.resolution, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner`, project.openQuestions.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.question, item.answerNeededBy, item.blocking ? 1 : 0, item.resolution, item.needsUserAttention ? 1 : 0, item.attentionOwner]));
    upsert(`INSERT INTO milestones (id, project_id, title, status, owner, updated_at, data_classification, summary, target_date, milestone_status, completion_percent, work_package_ids_json, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, target_date = excluded.target_date, milestone_status = excluded.milestone_status, completion_percent = excluded.completion_percent, work_package_ids_json = excluded.work_package_ids_json, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner`, project.milestones.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.targetDate, item.milestoneStatus, item.completionPercent, JSON.stringify(item.workPackageIds), item.needsUserAttention ? 1 : 0, item.attentionOwner]));
    upsert(`INSERT INTO work_packages (id, project_id, title, status, owner, updated_at, data_classification, summary, work_package_status, lead, start_date, target_date, completion_percent, blocker_summary, milestone_id, needs_user_attention, attention_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, work_package_status = excluded.work_package_status, lead = excluded.lead, start_date = excluded.start_date, target_date = excluded.target_date, completion_percent = excluded.completion_percent, blocker_summary = excluded.blocker_summary, milestone_id = excluded.milestone_id, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner`, project.workPackages.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.workPackageStatus, item.lead, item.startDate, item.targetDate, item.completionPercent, item.blockerSummary, item.milestoneId, item.needsUserAttention ? 1 : 0, item.attentionOwner]));
    upsert(`INSERT INTO activity_events (id, project_id, occurred_at, event_type, summary, actor, related_entity_type, related_entity_id, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, occurred_at = excluded.occurred_at, event_type = excluded.event_type, summary = excluded.summary, actor = excluded.actor, related_entity_type = excluded.related_entity_type, related_entity_id = excluded.related_entity_id, data_classification = excluded.data_classification`, project.activity.map((item) => [item.id, item.projectId, item.occurredAt, item.eventType, item.summary, item.actor, item.relatedEntityType, item.relatedEntityId, item.dataClassification]));
    upsert(`INSERT INTO deliverables (id, project_id, title, status, owner, updated_at, data_classification, summary, deliverable_type, external_path, due_date, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, status = excluded.status, owner = excluded.owner, updated_at = excluded.updated_at, data_classification = excluded.data_classification, summary = excluded.summary, deliverable_type = excluded.deliverable_type, external_path = excluded.external_path, due_date = excluded.due_date, needs_user_attention = excluded.needs_user_attention, attention_owner = excluded.attention_owner, attention_reason = excluded.attention_reason`, project.deliverables.map((item) => [item.id, item.projectId, item.title, item.status, item.owner, item.updatedAt, item.dataClassification, item.summary, item.deliverableType, item.externalPath, item.dueDate, item.needsUserAttention ? 1 : 0, item.attentionOwner, item.attentionReason]));
    upsert(`INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, label = excluded.label, related_entity_type = excluded.related_entity_type, related_entity_id = excluded.related_entity_id, write_status = excluded.write_status, verification_status = excluded.verification_status, verification_method = excluded.verification_method, last_attempt_at = excluded.last_attempt_at, verified_at = excluded.verified_at, verified_by = excluded.verified_by, status_detail = excluded.status_detail, attention_owner = excluded.attention_owner, data_classification = excluded.data_classification`, project.aiWork.map((item) => [item.id, item.projectId, item.label, item.relatedEntityType, item.relatedEntityId, item.writeStatus, item.verificationStatus, item.verificationMethod, item.lastAttemptAt, item.verifiedAt, item.verifiedBy, item.statusDetail, item.attentionOwner, item.dataClassification]));
    upsert(`INSERT INTO verifications (id, project_id, ai_write_id, verification_status, method, checked_at, checked_by, summary, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, ai_write_id = excluded.ai_write_id, verification_status = excluded.verification_status, method = excluded.method, checked_at = excluded.checked_at, checked_by = excluded.checked_by, summary = excluded.summary, data_classification = excluded.data_classification`, project.verifications.map((item) => [item.id, item.projectId, item.aiWriteId, item.verificationStatus, item.method, item.checkedAt, item.checkedBy, item.summary, item.dataClassification]));
    upsert(`INSERT INTO provenance_file_refs (id, project_id, entity_type, entity_id, label, external_path, evidence_kind, captured_at, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, entity_type = excluded.entity_type, entity_id = excluded.entity_id, label = excluded.label, external_path = excluded.external_path, evidence_kind = excluded.evidence_kind, captured_at = excluded.captured_at, data_classification = excluded.data_classification`, project.provenance.map((item) => [item.id, item.projectId, item.entityType, item.entityId, item.label, item.externalPath, item.evidenceKind, item.capturedAt, item.dataClassification]));

    db.prepare(`INSERT INTO import_runs (id, project_id, importer_version, started_at, completed_at, status, records_written, source_label, source_external_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(importRunId, project.id, 'projectmanagair-json-v1', now, new Date().toISOString(), 'completed', recordsWritten, payload.source?.label ?? 'Structured JSON import', payload.source?.externalPath ?? null);
    recordsWritten += 1;
    db.exec('COMMIT;');
    return { importRunId, projectId: project.id, recordsWritten };
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function importJsonText(db: DatabaseSync, jsonText: string): ImportResult {
  return importProjectPayload(db, JSON.parse(jsonText) as unknown);
}
