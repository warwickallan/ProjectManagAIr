/**
 * Renders the one-hour meeting review pack from the deterministic Meeting
 * Brief / Needs Warwick views already produced by usefulness-proof.ts. Pure
 * template rendering over data already on disk — no database access, no
 * provider, no model call.
 *
 * Usage:
 *   tsx scripts/build-review-pack.ts --dir <usefulness-proof out-dir>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsultantSelectionRecord, DeterministicConsultantView } from '../src/consultantViews.js';

type Anchor = { speaker: string | null; tMs: number | null; quote: string | null; verified: boolean };

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const dir = path.resolve(arg('dir'));
const meeting = JSON.parse(readFileSync(path.join(dir, 'meeting-brief-view.json'), 'utf8')) as DeterministicConsultantView;
const needsWarwick = JSON.parse(readFileSync(path.join(dir, 'needs-warwick-view.json'), 'utf8')) as DeterministicConsultantView;
const anchors = JSON.parse(readFileSync(path.join(dir, 'source-anchors.json'), 'utf8')) as Record<string, Anchor[]>;
const runReport = JSON.parse(readFileSync(path.join(dir, 'usefulness-proof-report.json'), 'utf8')) as Record<string, unknown>;

// Union of both views' selected records, deduped by id. Each view scores and
// ranks independently, so the same row can appear in both; the pack cites it
// once.
const byId = new Map<string, ConsultantSelectionRecord>();
for (const record of [...meeting.records, ...needsWarwick.records]) if (!byId.has(record.id)) byId.set(record.id, record);
const all = [...byId.values()];

function fmtMs(t: number | null): string {
  if (t === null) return '';
  const totalSeconds = Math.round(t / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const cited = new Set<string>();
function cite(record: ConsultantSelectionRecord, opts: { withQuote?: boolean } = {}): string {
  cited.add(record.id);
  const rowAnchors = anchors[record.id] ?? [];
  const first = rowAnchors[0];
  const quotePart = opts.withQuote !== false && first?.quote
    ? ` — "${first.quote.trim()}" (${first.speaker ?? 'unknown speaker'}${first.tMs !== null ? `, ${fmtMs(first.tMs)}` : ''}${first.verified ? '' : ', unverified quote match'})`
    : rowAnchors.length === 0 ? ' — no source anchor recorded on this row' : '';
  return `${quotePart} [${record.id}]`;
}

function bullet(record: ConsultantSelectionRecord, detail: string): string {
  return `- **${record.title}**${detail}${cite(record)}`;
}

const lines: string[] = [];
lines.push('# NPL Concerto Implementation — One-Hour Meeting Review Pack');
lines.push('');
lines.push(`Generated ${runReport.finishedAt} from the applied candidate 2.9.0 changeset (\`${(runReport.apply as { changesetId: string }).changesetId}\`), on an isolated copy of the candidate database. **Zero model or provider calls were made to produce this pack** — every section below is a deterministic read of the applied register.`);
lines.push('');
lines.push(`Isolated database: \`${runReport.isolatedDbPath}\`. Source: \`${(runReport as { sourceDbPath: string }).sourceDbPath}\`, unaltered.`);
lines.push('');

// ---- 1. what a consultant needs to know for a meeting in one hour
lines.push('## What you need to know before this meeting');
lines.push('');
const challengeIds = new Set(meeting.sections.find((s) => s.key === 'themes-to-challenge')?.rowIds ?? []);
const challengeThemeLabels = [...new Set(all.filter((r) => challengeIds.has(r.id) && r.themeLabel).map((r) => r.themeLabel!))];
const overdueCount = all.filter((r) => r.overdue).length;
const decisionCount = all.filter((r) => r.registerName === 'Decisions').length;
const blockingQuestionCount = all.filter((r) => r.registerName === 'Open_Questions' && r.blocking).length;
const highRiskCount = all.filter((r) => r.registerName === 'Risks_Issues' && ['Now', 'Soon'].includes(r.band)).length;
lines.push(`Since the last applied source, ${overdueCount} open items are overdue, ${decisionCount} decisions are still open, ${blockingQuestionCount} questions are marked blocking, and ${highRiskCount} risks/issues sit in the Now/Soon band.`);
lines.push('');
if (challengeThemeLabels.length) {
  lines.push('Themes this meeting should not end without touching:');
  for (const label of challengeThemeLabels) lines.push(`- ${label}`);
} else {
  lines.push('No theme currently carries an unresolved decision, blocker, overdue item or customer dependency.');
}
lines.push('');

// ---- 2. important decisions
lines.push('## Important decisions');
lines.push('');
const decisions = all.filter((r) => r.registerName === 'Decisions').sort((a, b) => b.score - a.score);
if (decisions.length) {
  for (const d of decisions) lines.push(bullet(d, `${d.owner ? ` Owner: ${d.owner}.` : ' No owner recorded.'} Status: ${d.status}.`));
} else {
  lines.push('- No open decisions selected.');
}
lines.push('');

// ---- 3. outstanding actions and owners
lines.push('## Outstanding actions and owners');
lines.push('');
const actions = all.filter((r) => r.registerName === 'Actions').sort((a, b) => b.score - a.score);
if (actions.length) {
  for (const a of actions) lines.push(bullet(a, `${a.owner ? ` Owner: ${a.owner}.` : ' Unowned.'}${a.dueDate ? ` Due ${a.dueDate}${a.overdue ? ' (OVERDUE)' : ''}.` : ''}`));
} else {
  lines.push('- No open actions selected.');
}
lines.push('');

// ---- 4. risks and blockers
lines.push('## Risks and blockers');
lines.push('');
const risks = all.filter((r) => r.registerName === 'Risks_Issues' || r.blocking).sort((a, b) => b.score - a.score);
if (risks.length) {
  for (const r of risks) lines.push(bullet(r, `${r.severity ? ` Severity: ${r.severity}.` : ''} Band: ${r.band}.${r.blocking ? ' Blocking.' : ''}`));
} else {
  lines.push('- No open risks, issues or blockers selected.');
}
lines.push('');

// ---- 5. customer dependencies
lines.push('## Customer dependencies');
lines.push('');
const customerOwned = all.filter((r) => r.ownership === 'customer').sort((a, b) => b.score - a.score);
if (customerOwned.length) {
  for (const c of customerOwned) lines.push(bullet(c, ` Owner: ${c.owner ?? 'customer (unnamed)'}.${c.dueDate ? ` Due ${c.dueDate}${c.overdue ? ' (OVERDUE)' : ''}.` : ''}`));
} else {
  lines.push('- Nothing currently sits with the customer.');
}
lines.push('');

// ---- 6. Warwick's next actions
lines.push("## Warwick's next actions");
lines.push('');
const warwickNext = all.filter((r) => (r.registerName === 'Actions' || r.registerName === 'Decisions') && r.ownership !== 'customer').sort((a, b) => b.score - a.score);
if (warwickNext.length) {
  for (const w of warwickNext) lines.push(bullet(w, `${w.ownership === 'unowned' ? ' Unowned — needs an owner.' : ` Owner: ${w.owner}.`}${w.dueDate ? ` Due ${w.dueDate}${w.overdue ? ' (OVERDUE)' : ''}.` : ''}${w.unlocks > 0 ? ` Unlocks ${w.unlocks} other open item(s) in the same theme.` : ''}`));
} else {
  lines.push('- Nothing currently assigned to or requiring Warwick.');
}
lines.push('');

// ---- 7. questions to ask
lines.push('## Questions to ask');
lines.push('');
const questions = all.filter((r) => r.registerName === 'Open_Questions').sort((a, b) => b.score - a.score);
if (questions.length) {
  for (const q of questions) lines.push(bullet(q, `${q.blocking ? ' Blocking.' : ''}`));
} else {
  lines.push('- No open questions selected.');
}
lines.push('');

// ---- 8. source anchor index — one hop to the transcript for every material point cited above
lines.push('## Source anchor index');
lines.push('');
lines.push('Every material point above carries a bracketed register ID; this index gives the verbatim transcript quote(s) behind each one, so nothing here needs to be taken on trust.');
lines.push('');
for (const id of [...cited].sort()) {
  const rowAnchors = anchors[id] ?? [];
  lines.push(`### ${id}`);
  if (rowAnchors.length === 0) {
    lines.push('- No source anchor recorded on this row (register mutation without a transcript quote, e.g. a live-session decision or a reaffirmation).');
  } else {
    for (const a of rowAnchors) lines.push(`- ${a.speaker ?? 'unknown speaker'}${a.tMs !== null ? ` @ ${fmtMs(a.tMs)}` : ''}: "${a.quote?.trim() ?? ''}"${a.verified ? '' : ' (unverified quote match)'}`);
  }
  lines.push('');
}

const markdown = lines.join('\n').trim() + '\n';
writeFileSync(path.join(dir, 'review-pack.md'), markdown, 'utf8');
console.log(`[review-pack] written to ${path.join(dir, 'review-pack.md')}`);
console.log(`[review-pack] cited ${cited.size} of ${all.length} selected records`);
