/**
 * The Consultant Reasoning acceptance run.
 *
 * ONE real bounded reasoning call against the already-applied register in the
 * isolated candidate database. No extraction, no benchmark, no live-database
 * access, no promotion of any skill. Everything it produces is evidence:
 * the preserved raw response, the validation outcome, the accepted result and
 * its provenance, and a rendered brief with register-resolved anchors.
 *
 * Usage:
 *   tsx scripts/reasoning-acceptance.ts --db <isolated.db> --project-id <id> \
 *     [--mode meeting] [--model opus] [--out-dir <dir>] [--dry-run]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openProjectManagairDatabase } from '../src/db.js';
import { ensureSkillRegistrySynced } from '../src/skillRegistry.js';
import { generateConsultantReasoning, readConsultantReasoning, resolveReasoningSkill } from '../src/consultantReasoning.js';
import { ClaudeCodeConsultantReasoningProvider, FakeConsultantReasoningProvider, type ConsultantReasoningProvider } from '../src/consultantReasoningProvider.js';
import { renderReasoningMarkdown, resolveReasoningEvidence } from '../src/consultantReasoningRender.js';
import { buildReasoningRequest } from '../src/consultantReasoningState.js';
import type { BriefMode } from '../src/consultantReasoningContract.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const dbPath = path.resolve(arg('db'));
const projectId = arg('project-id');
const mode = arg('mode', 'meeting') as BriefMode;
const model = arg('model', 'opus');
const outDir = path.resolve(arg('out-dir', path.join(path.dirname(dbPath), 'reasoning-acceptance')));
const dryRun = flag('dry-run');
mkdirSync(outDir, { recursive: true });

const context = openProjectManagairDatabase(dbPath);
const db = context.db;
ensureSkillRegistrySynced(db);

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  dbPath, projectId, mode, dryRun,
  migrationsAppliedNow: context.migrationsApplied,
};

const skill = resolveReasoningSkill(db, projectId);
if (!skill) throw new Error('No consultant-reasoning revision resolvable.');
report.skillInForce = { skillId: skill.skillId, version: skill.version, status: skill.status, sha256: skill.sha256, promptTemplateVersion: skill.promptTemplateVersion };

const request = buildReasoningRequest(db, projectId, { mode, consultantIdentity: 'Warwick', consultantAliases: ['Warwick', 'Warwick Allan'] });
report.stateSummary = {
  rows: request.current_state.length,
  byRegister: request.current_state.reduce<Record<string, number>>((acc, row) => { acc[row.register] = (acc[row.register] ?? 0) + 1; return acc; }, {}),
  projectStateHash: request.project.project_state_hash,
  registerRevision: request.project.register_revision,
  latestProcessedSourceEventDate: request.project.latest_processed_source_event_date,
  approximateRequestTokens: Math.round(JSON.stringify(request).length / 4),
};

/* ------------------------------------------------------- the read path */
// Proven BEFORE any call: opening the Cockpit must cost nothing.
let readCalls = 0;
const countingFake = new FakeConsultantReasoningProvider(() => { readCalls += 1; return '{}'; });
const beforeView = readConsultantReasoning(db, projectId, mode, countingFake);
report.readPathBefore = { state: beforeView.state, providerCallsThisRequest: beforeView.providerCallsThisRequest, fakeInvocations: readCalls };

/* ------------------------------------------------------ the one call */
const provider: ConsultantReasoningProvider = dryRun
  ? new FakeConsultantReasoningProvider(() => JSON.stringify({
    brief_type: mode,
    executive_summary: [
      { text: 'Dry-run placeholder point one.', supporting_register_ids: [request.current_state[0].register_id] },
      { text: 'Dry-run placeholder point two.', supporting_register_ids: [request.current_state[1].register_id] },
    ],
    matters: [{
      matter_id: 'MAT-01', title: 'Dry run', situation: 'Synthetic.', why_it_matters: 'Synthetic.',
      recommended_move: 'Nothing.', classification: 'watch_item', priority: 'medium', state: 'confirmed_current',
      owner_class: 'not_applicable', evidence_strength: 'strong',
      supporting_register_ids: [request.current_state[0].register_id], reasoning: 'Synthetic.', related_matter_ids: [],
    }],
    meeting_order: ['MAT-01'], decisions_required: [], customer_dependencies: [], consultant_next_actions: [],
    risks_and_blockers: [], unanswered_questions: [], contradictions_and_state_conflicts: [], recent_changes: [],
    confirmation_warnings: [], state_observations: [], limitations: [],
  }))
  : new ClaudeCodeConsultantReasoningProvider('claude', { model });

report.provider = { identity: provider.identity, available: provider.isAvailable() };
if (!provider.isAvailable()) throw new Error('Reasoning provider unavailable; the run is not attempted.');

console.log(`[reasoning-acceptance] ${dryRun ? 'DRY RUN' : 'LIVE'} — one bounded call, model ${dryRun ? 'n/a' : model}, ${request.current_state.length} register rows`);
const started = Date.now();
const result = await generateConsultantReasoning(db, projectId, mode, provider, {
  mode, consultantIdentity: 'Warwick', consultantAliases: ['Warwick', 'Warwick Allan'],
  meetingContext: 'Next customer implementation session.',
  actor: 'reasoning-acceptance-script',
});
report.wallClockMs = Date.now() - started;
report.generation = {
  outcome: result.outcome, providerCalls: result.providerCalls, runId: result.runId,
  message: result.message, violations: result.violations,
};
console.log(`[reasoning-acceptance] outcome=${result.outcome} providerCalls=${result.providerCalls}`);

/* --------------------------------------------------------- evidence */
report.runRecord = db.prepare('SELECT id, status, provider_calls, input_tokens, output_tokens, token_source, duration_ms, result_sha256, skill_id, skill_version, prompt_template_version, prompt_sha256, provider_id, model_label, project_state_hash, register_revision, error, violations_json FROM consultant_reasoning_runs WHERE id = ?').get(result.runId ?? '') ?? null;
report.rawOutputs = db.prepare('SELECT id, response_sha256, response_bytes, artefact_path, parse_status, parse_detail, requested_at, received_at, duration_ms, input_tokens, output_tokens, token_source FROM consultant_reasoning_raw_outputs WHERE project_id = ? ORDER BY received_at DESC').all(projectId);

const afterView = readConsultantReasoning(db, projectId, mode, countingFake);
report.readPathAfter = { state: afterView.state, providerCallsThisRequest: afterView.providerCallsThisRequest, fakeInvocations: readCalls };

/* ------------------------------------------- a second read is a cache hit */
const second = await generateConsultantReasoning(db, projectId, mode, provider, {
  mode, consultantIdentity: 'Warwick', consultantAliases: ['Warwick', 'Warwick Allan'],
  meetingContext: 'Next customer implementation session.',
});
report.secondGeneration = { outcome: second.outcome, providerCalls: second.providerCalls };
console.log(`[reasoning-acceptance] repeat generate: outcome=${second.outcome} providerCalls=${second.providerCalls}`);

if (afterView.current) {
  const accepted = afterView.current;
  const evidence = resolveReasoningEvidence(db, projectId, accepted.resultJson);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string };
  const markdown = renderReasoningMarkdown(accepted.resultJson, evidence, {
    projectName: project.name, generatedAt: accepted.generatedAt,
    skillId: accepted.skillId, skillVersion: accepted.skillVersion,
    promptTemplateVersion: accepted.promptTemplateVersion,
    providerId: accepted.providerId, modelLabel: accepted.modelLabel,
    projectStateHash: accepted.projectStateHash, resultSha256: accepted.resultSha256,
    registerRevision: accepted.registerRevision, providerCalls: result.providerCalls,
  });
  writeFileSync(path.join(outDir, 'reasoning-brief.md'), markdown, 'utf8');
  writeFileSync(path.join(outDir, 'reasoning-result.json'), JSON.stringify(accepted.resultJson, null, 2), 'utf8');
  report.accepted = {
    resultSha256: accepted.resultSha256,
    citedRegisterIds: accepted.citedRegisterIds.length,
    matters: accepted.resultJson.matters.length,
    meetingOrder: accepted.resultJson.meeting_order.length,
    executiveSummary: accepted.resultJson.executive_summary.length,
    sections: {
      decisions_required: accepted.resultJson.decisions_required.length,
      customer_dependencies: accepted.resultJson.customer_dependencies.length,
      consultant_next_actions: accepted.resultJson.consultant_next_actions.length,
      risks_and_blockers: accepted.resultJson.risks_and_blockers.length,
      unanswered_questions: accepted.resultJson.unanswered_questions.length,
      contradictions_and_state_conflicts: accepted.resultJson.contradictions_and_state_conflicts.length,
      recent_changes: accepted.resultJson.recent_changes.length,
      confirmation_warnings: accepted.resultJson.confirmation_warnings.length,
    },
    stateObservations: accepted.resultJson.state_observations.length,
    limitations: accepted.resultJson.limitations.length,
    evidenceRowsResolved: Object.keys(evidence.rows).length,
    evidenceUnresolved: evidence.unresolved,
    unanchoredCitedRows: Object.values(evidence.rows).filter((row) => row.unanchored).map((row) => row.registerId),
    briefWords: markdown.split(/\s+/).length,
  };
}

report.integrity = {
  quickCheck: db.prepare('PRAGMA quick_check').all(),
  foreignKeyCheck: db.prepare('PRAGMA foreign_key_check').all(),
  registerRowCount: db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(projectId),
  // Reasoning must never mutate the register. Proven, not asserted.
  registerRevisionAfter: db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(projectId),
};
report.finishedAt = new Date().toISOString();

writeFileSync(path.join(outDir, 'reasoning-acceptance-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[reasoning-acceptance] report written to ${path.join(outDir, 'reasoning-acceptance-report.json')}`);
db.close();
