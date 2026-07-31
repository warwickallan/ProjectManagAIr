/**
 * Read-only inspection of a database copy: schema state, canonical register
 * parity, and the historical PTW proposal. Used to prove a copy is intact
 * before and after migrations, without touching the live file.
 */
import { openProjectManagairDatabase } from '../src/db.js';
import { recomputeRegisterFieldParity } from '../src/projectRegisters.js';

const dbPath = process.argv[2];
if (!dbPath) throw new Error('usage: inspect-live.ts <dbPath>');
const context = openProjectManagairDatabase(dbPath);
const db = context.db;
const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as T[];
const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...(args as never[])) as T;

const report: Record<string, unknown> = {};
report.dbPath = context.dbPath;
report.migrationsAppliedNow = context.migrationsApplied;
report.allMigrations = q<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((row) => row.id);
report.quickCheck = q<{ quick_check: string }>('PRAGMA quick_check');
report.foreignKeyCheck = q('PRAGMA foreign_key_check');
report.projects = q('SELECT id, code, name, owner FROM projects ORDER BY code');
report.registerRowCount = one('SELECT count(*) count FROM project_register_rows');
report.registerRowsByRegister = q('SELECT register_name, count(*) count FROM project_register_rows GROUP BY register_name ORDER BY register_name');
report.proposedChanges = q('SELECT id, status, reviewed_at, applied_at, length(payload_json) payload_length FROM proposed_changes ORDER BY id');
report.sourceDocuments = q('SELECT id, project_id, original_file_name, normaliser_version, segment_count, word_count, event_date FROM source_documents ORDER BY id');
report.extractionRuns = q('SELECT id, source_id, stage, provider_id, model_label, status, input_tokens, output_tokens, started_at FROM extraction_runs ORDER BY started_at');
report.extractionPackets = q('SELECT id, source_id, packet_sha256, validation_status FROM extraction_packets ORDER BY assembled_at');
report.changesets = q('SELECT id, gate_verdict, review_status, applied_at FROM register_changesets ORDER BY created_at');
report.jobs = q('SELECT id, status, current_stage, attempt_count, max_attempts, error_kind FROM source_processing_jobs ORDER BY id');
report.intake = q('SELECT id, original_file_name, processing_status, processing_stage FROM project_source_intake ORDER BY created_at');
report.skills = q('SELECT skill_id, version, status, source, sha256 FROM extraction_skills ORDER BY skill_id, version');
report.providerRawOutputs = one('SELECT count(*) count FROM provider_raw_outputs');
report.scoreBands = q('SELECT band, count(*) count FROM register_row_scores GROUP BY band ORDER BY band');

const parity: Record<string, unknown> = {};
for (const project of report.projects as Array<{ id: string; code: string }>) {
  try {
    parity[project.code] = recomputeRegisterFieldParity(db, project.id);
  } catch (error) {
    parity[project.code] = { error: error instanceof Error ? error.message : String(error) };
  }
}
report.fieldParity = parity;
console.log(JSON.stringify(report, null, 2));
db.close();
