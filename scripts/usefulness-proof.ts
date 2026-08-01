/**
 * Zero-additional-model-call usefulness proof.
 *
 * Takes the already-produced candidate 2.9.0 packet/changeset (frozen and
 * benchmarked earlier, sitting unapplied), applies it through the normal
 * review/apply path onto an ISOLATED COPY of the candidate database — never
 * the live NPL database — and renders the existing deterministic Meeting
 * Brief and Needs Warwick views on top. No provider is constructed, no
 * extraction job runs, no packet is reassembled. The question this run
 * answers is not "did the comparator score go up" but "is the applied
 * register, viewed deterministically, actually useful for a meeting."
 *
 * Usage:
 *   tsx scripts/usefulness-proof.ts --db <source-copy.db> --project-code <CODE> \
 *     --out-dir <dir>
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openProjectManagairDatabase } from '../src/db.js';
import { applyReviewedChangeset, reviewChangeset } from '../src/sourceIntelligence.js';
import { buildProjectThemes } from '../src/projectThemes.js';
import { buildDeterministicConsultantView } from '../src/consultantViews.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const sourceDbPath = path.resolve(arg('db'));
const projectCode = arg('project-code');
const outDir = path.resolve(arg('out-dir'));
mkdirSync(outDir, { recursive: true });

// ---- 1. isolated copy: never touch the candidate DB used for the benchmark run, never touch the live DB.
const isolatedDbPath = path.join(outDir, 'projectmanagair-usefulness.db');
for (const ext of ['', '-wal', '-shm']) {
  const from = `${sourceDbPath}${ext}`;
  if (existsSync(from)) copyFileSync(from, `${isolatedDbPath}${ext}`);
}

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  sourceDbPath,
  isolatedDbPath,
  providerCalls: 0,
};

const context = openProjectManagairDatabase(isolatedDbPath);
const db = context.db;
report.migrationsAppliedNow = context.migrationsApplied;

const project = db.prepare('SELECT id, code FROM projects WHERE code = ?').get(projectCode) as { id: string; code: string } | undefined;
if (!project) throw new Error(`Isolated copy has no project with code ${projectCode}.`);

// ---- 2. the normal review/apply path, on the isolated copy only.
const changeset = db.prepare("SELECT id, review_status, gate_verdict FROM register_changesets WHERE review_status = 'pending' ORDER BY created_at DESC LIMIT 1").get() as { id: string; review_status: string; gate_verdict: string } | undefined;
if (!changeset) throw new Error('No pending changeset found in the isolated copy.');
if (changeset.gate_verdict === 'quarantined') throw new Error('Changeset is quarantined; will not apply.');

const reviewResult = reviewChangeset(db, changeset.id, {
  decision: 'accept',
  reviewer: 'Warwick (zero-model-call usefulness proof)',
  note: 'Applied to an isolated copy only, to test whether the deterministic Cockpit views are useful, not to promote the skill or re-run the benchmark.',
});
report.review = reviewResult;

const applyResult = applyReviewedChangeset(db, changeset.id);
report.apply = applyResult;

// ---- 3. the existing deterministic views. No provider is even constructed.
const themes = buildProjectThemes(db, project.id);
const meeting = buildDeterministicConsultantView(db, project.id, 'meeting', themes);
const needsWarwick = buildDeterministicConsultantView(db, project.id, 'needs-warwick', themes);
report.meetingSelectionHash = meeting.selectionHash;
report.needsWarwickSelectionHash = needsWarwick.selectionHash;
report.meetingRecordCount = meeting.records.length;
report.needsWarwickRecordCount = needsWarwick.records.length;

writeFileSync(path.join(outDir, 'meeting-brief-view.json'), JSON.stringify(meeting, null, 2), 'utf8');
writeFileSync(path.join(outDir, 'needs-warwick-view.json'), JSON.stringify(needsWarwick, null, 2), 'utf8');

// ---- 4. source anchors for every record, widened to their adjacent segments.
//
// A single normalised segment is frequently half a sentence, so an anchor
// quoted alone often fails to support the claim it is evidence for. Widening
// to the neighbouring segments costs one indexed read and makes the appendix
// answerable rather than merely citable.
const anchorStatement = db.prepare('SELECT segment_id, speaker, t_ms, quote, verified FROM register_row_anchors WHERE project_id = ? AND external_register_id = ? ORDER BY t_ms, segment_id');
const neighbourStatement = db.prepare('SELECT seq, text FROM source_segments WHERE source_id = ? AND seq BETWEEN ? AND ? ORDER BY seq');

function anchorsFor(externalId: string) {
  return (anchorStatement.all(project.id, externalId) as Array<{ segment_id: string; speaker: string | null; t_ms: number | null; quote: string | null; verified: number }>)
    .map((row) => {
      const parsed = /^(.*):seg:(\d+)$/.exec(String(row.segment_id));
      const sourceId = parsed?.[1] ?? null;
      const segmentSeq = parsed ? Number(parsed[2]) : null;
      let context: string | null = null;
      if (sourceId && segmentSeq !== null) {
        const neighbours = neighbourStatement.all(sourceId, segmentSeq - 1, segmentSeq + 1) as Array<{ seq: number; text: string }>;
        const joined = neighbours.map((segment) => segment.text.trim()).filter(Boolean).join(' ');
        // Only offer the widened form when it genuinely adds something.
        if (joined && row.quote && joined.length > row.quote.trim().length) context = joined;
      }
      return { segmentSeq, speaker: row.speaker, tMs: row.t_ms, quote: row.quote, verified: Boolean(row.verified), context };
    });
}

// ---- 5. the review-pack input: every open record, not only the 40 each view selects.
//
// The prioritised sections are driven by the deterministic views' selection;
// the appendix needs the whole open register, or "full detail below" is a lie.
const selectedIds = new Set([...meeting.records, ...needsWarwick.records].map((record) => record.id));
const registerRows = db.prepare(`SELECT r.external_register_id id, r.register_name, r.title, r.summary, r.related_ids_json, r.record_status,
    s.status, s.owner, s.due_date, sc.score, sc.band, sc.inputs_json
  FROM project_register_rows r
  JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
  JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
  WHERE r.project_id = ? AND r.record_status != 'superseded' ORDER BY r.external_register_id`).all(project.id) as Array<Record<string, unknown>>;

const today = (db.prepare("SELECT date('now') today").get() as { today: string }).today;
const questionDetail = db.prepare('SELECT unblocked_by, parked_with FROM register_open_question_details WHERE register_row_id = ?');
const themeLabelById = new Map<string, string>();
for (const theme of themes.themes) for (const id of theme.memberIds) themeLabelById.set(id, theme.label);

const packRecords = registerRows.map((row) => {
  const id = String(row.id);
  const registerName = String(row.register_name);
  const inputs = JSON.parse(String(row.inputs_json)) as Record<string, unknown>;
  const status = String(row.status);
  const dueDate = row.due_date ? String(row.due_date) : null;
  const detail = registerName === 'Open_Questions'
    ? questionDetail.get(`register:${project.id}:${id}`) as { unblocked_by: string | null; parked_with: string | null } | undefined
    : undefined;
  return {
    id,
    registerName,
    title: String(row.title),
    summary: String(row.summary ?? ''),
    status,
    owner: row.owner === null || row.owner === undefined ? null : String(row.owner),
    dueDate,
    overdue: Boolean(dueDate && dueDate < today && !/\b(closed|done|complete|resolved|cancelled)\b/i.test(status)),
    blocking: Boolean(inputs.blocking),
    conflict: Number(inputs.conflict ?? 0) > 0,
    severity: inputs.severity ? String(inputs.severity) : null,
    band: String(row.band),
    score: Number(row.score),
    themeLabel: themeLabelById.get(id) ?? null,
    relatedIds: JSON.parse(String(row.related_ids_json)) as string[],
    anchors: anchorsFor(id),
    unblockedBy: detail?.unblocked_by ?? null,
    parkedWith: detail?.parked_with ?? null,
    selected: selectedIds.has(id),
  };
});

const source = db.prepare('SELECT original_file_name, event_date FROM source_documents WHERE id = (SELECT source_id FROM register_changesets WHERE id = ? LIMIT 1)').get(changeset.id) as { original_file_name: string; event_date: string | null } | undefined
  ?? db.prepare('SELECT original_file_name, event_date FROM source_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(project.id) as { original_file_name: string; event_date: string | null };

writeFileSync(path.join(outDir, 'review-pack-input.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  changesetId: changeset.id,
  isolatedDbPath,
  sourceDbPath,
  sourceLabel: source?.original_file_name ?? 'unknown source',
  sourceEventDate: source?.event_date ?? null,
  // The project's configured owner is one short name; the register writes the
  // consultant several ways. Both are declared here so section semantics do
  // not depend on an exact string match that the data never satisfies.
  consultantAliases: ['Warwick', 'Warwick Allan'],
  records: packRecords,
  providerCalls: 0,
}, null, 2), 'utf8');

report.packRecordCount = packRecords.length;

report.integrity = {
  quickCheck: db.prepare('PRAGMA quick_check').all(),
  foreignKeyCheck: db.prepare('PRAGMA foreign_key_check').all(),
  registerRowCount: db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(project.id),
  appliedChangesets: db.prepare("SELECT count(*) count FROM register_changesets WHERE review_status = 'applied'").get(),
};
report.finishedAt = new Date().toISOString();

writeFileSync(path.join(outDir, 'usefulness-proof-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[usefulness-proof] isolated db: ${isolatedDbPath}`);
console.log(`[usefulness-proof] report written to ${path.join(outDir, 'usefulness-proof-report.json')}`);
db.close();
