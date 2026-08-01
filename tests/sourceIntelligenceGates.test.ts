import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { recordRegisterEvent } from '../src/registerProjection';
import {
  acknowledgeChangeset,
  applyReviewedChangeset,
  computeProjectOverview,
  freezePacketAndCreateChangeset,
  readSourceIntelligence,
  replayPacket,
  reviewChangeset,
  validateBriefCitations,
  validatePacket,
  type SourceIntelligencePacket,
} from '../src/sourceIntelligence';

/* ------------------------------------------------------------------------- *
 * Regression cover for the acceptance gates repaired against independent
 * review findings B1–B8 and C1/C4/C8/C9/C12/C13/C14/C16.
 *
 * Every fixture is synthetic. No content is taken from any real source
 * document, and the transcript payloads are assembled at run time from parts so
 * that this file itself carries no transcript shape.
 * ------------------------------------------------------------------------- */

/* --------------------------- fixture plumbing ---------------------------- */

function tempDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-intelligence-gates-'));
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 'test.db'));
  return { dir, root, context };
}

async function createSyntheticProject(db: DatabaseSync, root: string, code = 'DEMO') {
  await updateStorageSettings(db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  await verifyStorageRoot(db, true);
  return createProject(db, { code, name: 'Synthetic Delivery', customer: 'Fictional Customer', description: 'Synthetic source intelligence validation.', status: 'active', owner: 'Casey' });
}

function trustedRun(db: DatabaseSync, projectId: string, sourceId: string) {
  const id = `run:${sourceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const source = db.prepare('SELECT word_count FROM source_documents WHERE id = ?').get(sourceId) as { word_count: number };
  db.prepare('INSERT INTO extraction_runs (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(id, sourceId, projectId, 'extract', 'frozen-synthetic-provider', 'fixture-v1', 'a'.repeat(64), 'b'.repeat(64), 100, 40, Math.ceil(source.word_count * 1.35), new Date().toISOString(), 12, 'completed', 'c'.repeat(64));
  return id;
}

function packetFor(db: DatabaseSync, projectId: string, projectCode: string, sourceId: string, runId: string): SourceIntelligencePacket {
  const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(sourceId) as Record<string, unknown>;
  const segment = db.prepare('SELECT * FROM source_segments WHERE source_id = ? ORDER BY seq LIMIT 1').get(sourceId) as Record<string, unknown>;
  const revision = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(projectId) as { revision: number } | undefined)?.revision ?? 0);
  const markerIds = (db.prepare("SELECT id FROM source_markers WHERE source_id = ? AND confidence = 'high'").all(sourceId) as Array<{ id: string }>).map((row) => row.id);
  const baseRow = {
    op: 'add' as const,
    target_id: null,
    proposed_id: '$ALLOC',
    status: 'open',
    record_type: null,
    owner: 'Casey',
    due_date_raw: 'by Friday',
    source_ref: sourceId,
    related_refs: [],
    supersedes: [],
    derivation: 'fact' as const,
    reasoning: null,
    confidence: 'high' as const,
    anchors: [{ segment_seq: Number(segment.seq), speaker: segment.speaker ? String(segment.speaker) : null, t_ms: segment.t_start_ms === null ? null : Number(segment.t_start_ms), quote: String(segment.text) }],
    discharges_markers: [] as string[],
    details: {},
  };
  // The upstream fixture shares one `anchors` array between both rows; give
  // every row its own so mutating one row's anchor in a test cannot silently
  // rewrite another row's evidence.
  const freshAnchors = () => structuredClone(baseRow.anchors);
  const empty = { rows: [] };
  const windows = (db.prepare('SELECT seq FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<{ seq: number }>).map((row) => ({ key: String(row.seq), status: 'reviewed' as const, item_count: 1, explanation: 'Synthetic window reviewed.' }));
  const categories = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'].map((key) => ({ key, status: key === 'Actions' || key === 'Sources' ? 'populated' as const : 'none-found' as const, item_count: key === 'Actions' || key === 'Sources' ? 1 : 0, explanation: key === 'Actions' || key === 'Sources' ? 'Synthetic fact extracted.' : 'Synthetic review found no items.' }));
  return {
    packet_type: 'project_register_delta', packet_version: 1, project_code: projectCode, base_register_revision: revision,
    source: { source_id: sourceId, content_hash: String(source.content_hash), source_type: String(source.source_type), original_file_name: String(source.original_file_name), event_date: source.event_date ? String(source.event_date) : null, duration_ms: source.duration_ms === null ? null : Number(source.duration_ms), participants: JSON.parse(String(source.participants_json)) as string[] },
    sheets: {
      Decisions: empty,
      Actions: { rows: [{ ...baseRow, anchors: freshAnchors(), client_ref: 'action-1', title: 'Confirm the release route', summary: 'Confirm the release route by Friday.', discharges_markers: markerIds }] },
      Risks_Issues: empty, Config_Changes: empty, Open_Questions: empty, Milestones: empty, Entities: empty,
      Sources: { rows: [{ ...baseRow, anchors: freshAnchors(), client_ref: 'source-1', title: String(source.original_file_name), summary: 'Immutable source registered.', due_date_raw: null, discharges_markers: [], details: { source_type: String(source.source_type) } }] },
      Uncertainty: empty,
    },
    coverage: { windows, categories },
    execution: { runs: [runId] },
  };
}

/* -------------------------- synthetic transcripts ------------------------- */

/** A cue timestamp, assembled numerically so this file carries no transcript shape. */
function stamp(totalSeconds: number): string {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return [hours, minutes, seconds].join(':') + '.000';
}

interface SpokenLine { speaker: string; text: string }

function vttBytes(lines: SpokenLine[], options: { recorded?: string } = {}): Buffer {
  const blocks: string[] = [['WEB', 'VTT'].join('')];
  if (options.recorded) blocks.push(`NOTE Recorded: ${options.recorded}`);
  lines.forEach((line, index) => {
    blocks.push([`${stamp(index * 10)} --> ${stamp(index * 10 + 8)}`, `${line.speaker}: ${line.text}`].join('\n'));
  });
  return Buffer.from(blocks.join('\n\n'), 'utf8');
}

/**
 * Ten governed turns. Exactly one of them — segment 3 — is a HIGH marker
 * (`explicit-action`); the fixtures assert that, so a change in marker
 * behaviour is reported here rather than silently reshaping the other tests.
 */
const GOVERNED_LINES: SpokenLine[] = [
  { speaker: 'Casey', text: 'The programme board asked us to confirm the release route before the customer sign-off window closes.' },
  { speaker: 'Dana', text: 'Nobody has written down which environment the migration script should target for the pilot tenant.' },
  { speaker: 'Casey', text: "I'll check with the platform team and confirm the migration environment this afternoon." },
  { speaker: 'Dana', text: 'The pilot tenant has no backup schedule at all, which is the largest exposure we carry.' },
  { speaker: 'Casey', text: 'Understood, we can revisit the backup schedule once the environment matter is settled.' },
  { speaker: 'Dana', text: 'Finance still owes us the revised licence counts for the second wave of onboarding.' },
  { speaker: 'Casey', text: 'The training material references screens that were renamed during the last upgrade.' },
  { speaker: 'Dana', text: 'Two of the reporting dashboards show different totals for the same reconciliation period.' },
  { speaker: 'Casey', text: 'The customer expects a written summary of the outstanding items after every session.' },
  { speaker: 'Dana', text: 'Nobody has agreed who signs off the cutover plan while the delivery lead is away.' },
];

const GOVERNED_FILE = 'handover-note.vtt';

async function governedProject(db: DatabaseSync, root: string, code = 'DEMO', options: { recorded?: string } = {}) {
  const project = await createSyntheticProject(db, root, code);
  const intake = await intakeProjectSource(db, project.projectId, { name: GOVERNED_FILE, dataBase64: vttBytes(GOVERNED_LINES, options).toString('base64') });
  const sourceId = String(intake.sourceId);
  const runId = trustedRun(db, project.projectId, sourceId);
  return { project, sourceId, runId, intake };
}

/* ------------------------------ small helpers ---------------------------- */

type Validation = ReturnType<typeof validatePacket>;

function hasIssue(result: Validation, rule: string, severity?: 'blocker' | 'warning') {
  return result.issues.some((issue) => issue.rule === rule && (!severity || issue.severity === severity));
}

function ruleList(result: Validation) {
  return result.issues.map((issue) => `${issue.rule}/${issue.severity}`);
}

function anchorAt(db: DatabaseSync, sourceId: string, seq: number, quote?: string | null) {
  const segment = db.prepare('SELECT * FROM source_segments WHERE source_id = ? AND seq = ?').get(sourceId, seq) as Record<string, unknown>;
  return {
    segment_seq: seq,
    speaker: segment.speaker ? String(segment.speaker) : null,
    t_ms: segment.t_start_ms === null ? null : Number(segment.t_start_ms),
    quote: quote === undefined ? String(segment.text) : quote,
  };
}

function segmentText(db: DatabaseSync, sourceId: string, seq: number) {
  return String((db.prepare('SELECT text FROM source_segments WHERE source_id = ? AND seq = ?').get(sourceId, seq) as { text: string }).text);
}

function setCategory(packet: SourceIntelligencePacket, key: string, patch: Partial<SourceIntelligencePacket['coverage']['categories'][number]>) {
  const entry = packet.coverage.categories.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Coverage category ${key} is missing from the fixture.`);
  Object.assign(entry, patch);
}

function opsOf(db: DatabaseSync, changesetId: string) {
  return db.prepare('SELECT * FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(changesetId) as Array<Record<string, unknown>>;
}

const HELD_OPS = ['conflict', 'unverified_link', 'possible_duplicate'];

/** Reject everything that must be adjudicated, accept the rest, then apply. */
function reviewAndApply(db: DatabaseSync, changesetId: string, reviewer = 'Casey') {
  const ops = opsOf(db, changesetId);
  const held = ops.filter((op) => HELD_OPS.includes(String(op.op))).map((op) => String(op.id));
  const acceptable = ops.filter((op) => !HELD_OPS.includes(String(op.op))).map((op) => String(op.id));
  if (held.length) reviewChangeset(db, changesetId, { decision: 'reject', reviewer, opIds: held });
  if (acceptable.length) reviewChangeset(db, changesetId, { decision: 'accept', reviewer, opIds: acceptable });
  return applyReviewedChangeset(db, changesetId);
}

function freezeAndApply(db: DatabaseSync, packet: SourceIntelligencePacket) {
  const frozen = freezePacketAndCreateChangeset(db, packet);
  const applied = reviewAndApply(db, frozen.changesetId);
  return { frozen, applied };
}

function externalId(db: DatabaseSync, projectId: string, registerName: string) {
  return String((db.prepare('SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = ? ORDER BY external_register_id LIMIT 1').get(projectId, registerName) as { external_register_id: string }).external_register_id);
}

/** Re-point the packet's Sources row at the already-allocated Sources row. */
function linkSourcesRow(db: DatabaseSync, projectId: string, packet: SourceIntelligencePacket) {
  const id = externalId(db, projectId, 'Sources');
  const row = packet.sheets.Sources.rows[0];
  row.op = 'update';
  row.target_id = id;
  row.proposed_id = id;
  return id;
}

/* ================================ B1 ===================================== */

describe('B1 — unverified quotes are never stored as verified', () => {
  it('quarantines an inference quote absent from the source, and records verification honestly at apply', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root);
      const clean = packetFor(db, project.projectId, 'DEMO', sourceId, runId);
      expect(validatePacket(db, clean)).toMatchObject({ verdict: 'clean' });

      // An `inference` row whose anchor carries a quote that was never said.
      const fabricated = structuredClone(clean);
      const inference = fabricated.sheets.Actions.rows[0];
      inference.derivation = 'inference';
      inference.reasoning = 'The commitment follows from the release discussion.';
      inference.anchors = [anchorAt(db, sourceId, 1, 'Tony accepted every penalty on the programme personally')];
      const fabricatedResult = validatePacket(db, fabricated);
      expect(fabricatedResult.verdict).toBe('quarantined');
      expect(fabricatedResult.issues.filter((issue) => issue.rule === 'quote-verification')).toMatchObject([{ severity: 'blocker', clientRef: 'action-1' }]);
      // It is the quote that is rejected, not the derivation: the same row with
      // no quote at all is legitimate evidence-free reasoning.
      const quoteless = structuredClone(fabricated);
      quoteless.sheets.Actions.rows[0].anchors = [anchorAt(db, sourceId, 1, null)];
      const quotelessResult = validatePacket(db, quoteless);
      expect(ruleList(quotelessResult)).toEqual([]);
      expect(quotelessResult.verdict).toBe('clean');

      const { frozen, applied } = freezeAndApply(db, quoteless);
      expect(frozen.gateVerdict).toBe('clean');
      expect(applied.appliedOperations).toBe(2);

      const anchors = db.prepare('SELECT external_register_id, quote, verified FROM register_row_anchors WHERE project_id = ? ORDER BY external_register_id').all(project.projectId) as Array<{ external_register_id: string; quote: string | null; verified: number }>;
      const inferenceAnchor = anchors.find((anchor) => anchor.quote === null);
      const factAnchor = anchors.find((anchor) => anchor.quote !== null);
      expect(inferenceAnchor).toBeDefined();
      expect(factAnchor).toBeDefined();
      // The inference row carried no quote: nothing was verified, and nothing
      // may claim to have been.
      expect(inferenceAnchor!.verified).toBe(0);
      // The Sources row quoted the segment verbatim, so it is verified.
      expect(factAnchor!.quote).toBe(segmentText(db, sourceId, 1));
      expect(factAnchor!.verified).toBe(1);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B2 ===================================== */

describe('B2 — a quote must carry enough content to be evidence', () => {
  it('rejects a one-word quote against a long segment but accepts a whole short segment', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root);
      const trivial = packetFor(db, project.projectId, 'DEMO', sourceId, runId);
      trivial.sheets.Actions.rows[0].anchors[0].quote = 'the';
      const trivialResult = validatePacket(db, trivial);
      expect(trivialResult.verdict).toBe('quarantined');
      expect(trivialResult.issues.filter((issue) => issue.rule === 'quote-triviality')).toMatchObject([{ severity: 'blocker', clientRef: 'action-1' }]);
      // "the" does occur in the segment, so the substring test alone would have
      // passed it. The triviality gate is what rejects it.
      expect(segmentText(db, sourceId, 1).toLowerCase()).toContain('the');
      expect(hasIssue(trivialResult, 'quote-verification')).toBe(false);

      // A short segment cannot yield a long quote; quoting substantially all of
      // it is deliberately allowed even below the word and character floors.
      const shortProject = await createSyntheticProject(db, root, 'TERSE');
      const shortIntake = await intakeProjectSource(db, shortProject.projectId, { name: 'terse-note.vtt', dataBase64: vttBytes([{ speaker: 'Casey', text: 'Route is fixed.' }]).toString('base64') });
      const shortSource = String(shortIntake.sourceId);
      const shortRun = trustedRun(db, shortProject.projectId, shortSource);
      const shortPacket = packetFor(db, shortProject.projectId, 'TERSE', shortSource, shortRun);
      const quote = shortPacket.sheets.Actions.rows[0].anchors[0].quote!;
      expect(quote).toBe('Route is fixed.');
      expect(quote.split(' ').length).toBeLessThan(4);
      expect(quote.length).toBeLessThan(20);
      const shortResult = validatePacket(db, shortPacket);
      expect(ruleList(shortResult)).toEqual([]);
      expect(shortResult.verdict).toBe('clean');
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ============================ claim support ============================== */

describe('claim support — a verbatim quote cannot carry an unrelated claim', () => {
  it('blocks a disconnected fact, warns on a disconnected inference, and exempts Sources but not Entities', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root);
      const base = packetFor(db, project.projectId, 'DEMO', sourceId, runId);

      // Verbatim quote, entirely disconnected claim.
      const disconnected = structuredClone(base);
      disconnected.sheets.Actions.rows[0].title = 'Zephyr origami quantum';
      disconnected.sheets.Actions.rows[0].summary = 'Origami zephyr quantum.';
      expect(disconnected.sheets.Actions.rows[0].anchors[0].quote).toBe(segmentText(db, sourceId, 1));
      const factResult = validatePacket(db, disconnected);
      expect(factResult.verdict).toBe('quarantined');
      expect(hasIssue(factResult, 'claim-support', 'blocker')).toBe(true);

      const inferred = structuredClone(disconnected);
      inferred.sheets.Actions.rows[0].derivation = 'inference';
      inferred.sheets.Actions.rows[0].reasoning = 'Reasoned from the release discussion.';
      const inferenceResult = validatePacket(db, inferred);
      expect(hasIssue(inferenceResult, 'claim-support', 'warning')).toBe(true);
      expect(inferenceResult.verdict).toBe('warnings');

      // A Sources row is titled with the file name by contract, so it is exempt
      // — and the exemption is register-specific, not a hole in the gate.
      expect(base.sheets.Sources.rows[0].title).toBe(GOVERNED_FILE);
      expect(validatePacket(db, base).verdict).toBe('clean');
      const misfiled = structuredClone(base);
      misfiled.sheets.Decisions = { rows: [{ ...structuredClone(base.sheets.Sources.rows[0]), client_ref: 'decision-1' }] };
      setCategory(misfiled, 'Decisions', { status: 'populated', item_count: 1, explanation: 'Synthetic decision extracted.' });
      const misfiledResult = validatePacket(db, misfiled);
      expect(hasIssue(misfiledResult, 'claim-support', 'blocker')).toBe(true);

      // Entities get a name-presence check instead of a vocabulary check.
      const strangerRow = {
        ...structuredClone(base.sheets.Actions.rows[0]),
        client_ref: 'entity-1',
        title: 'Marcus Delacroix',
        summary: 'Named individual.',
        due_date_raw: null,
        discharges_markers: [] as string[],
        details: { entity_type: 'person' },
        anchors: [anchorAt(db, sourceId, 2)],
      };
      const stranger = structuredClone(base);
      stranger.sheets.Entities = { rows: [strangerRow] };
      setCategory(stranger, 'Entities', { status: 'populated', item_count: 1, explanation: 'Synthetic entity extracted.' });
      const strangerResult = validatePacket(db, stranger);
      expect(strangerResult.verdict).toBe('quarantined');
      expect(hasIssue(strangerResult, 'entity-support', 'blocker')).toBe(true);

      const participant = structuredClone(stranger);
      participant.sheets.Entities.rows[0].title = 'Dana';
      const participantResult = validatePacket(db, participant);
      expect(ruleList(participantResult)).toEqual([]);
      expect(participantResult.verdict).toBe('clean');
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B3 ===================================== */

describe('B3 — HIGH-marker discharge must be earned', () => {
  it('requires locality, records the discharging item, and blocks an undischarged marker', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root);
      const markers = db.prepare("SELECT id, segment_seq FROM source_markers WHERE source_id = ? AND confidence = 'high' ORDER BY segment_seq").all(sourceId) as Array<{ id: string; segment_seq: number }>;
      expect(markers).toHaveLength(1);
      expect(markers[0].segment_seq).toBe(3);
      const markerId = markers[0].id;

      // (a) Anchored eight segments away, listing the marker id.
      const distant = packetFor(db, project.projectId, 'DEMO', sourceId, runId);
      const distantRow = distant.sheets.Actions.rows[0];
      distantRow.anchors = [anchorAt(db, sourceId, 10)];
      distantRow.title = 'Agree who signs off the cutover plan';
      distantRow.summary = 'Nobody has agreed who signs off the cutover plan.';
      distantRow.discharges_markers = [markerId];
      const distantResult = validatePacket(db, distant);
      expect(distantResult.verdict).toBe('quarantined');
      expect(hasIssue(distantResult, 'marker-discharge-locality', 'blocker')).toBe(true);
      // Because the echo did not count, the marker is also still outstanding.
      expect(hasIssue(distantResult, 'high-marker-discharge', 'blocker')).toBe(true);

      // (b) Anchored on the marker's own segment: a valid discharge.
      const local = structuredClone(distant);
      const localRow = local.sheets.Actions.rows[0];
      localRow.anchors = [anchorAt(db, sourceId, 3)];
      localRow.title = 'Confirm the migration environment';
      localRow.summary = 'Check with the platform team and confirm the migration environment.';
      const localResult = validatePacket(db, local);
      expect(ruleList(localResult)).toEqual([]);
      expect(localResult.verdict).toBe('clean');
      expect(localResult.metrics?.highMarkersDischarged).toBe(1);

      // (c) After apply the discharge is answerable.
      const { applied } = freezeAndApply(db, local);
      expect(applied.appliedOperations).toBe(2);
      const actionId = externalId(db, project.projectId, 'Actions');
      expect(db.prepare('SELECT discharged_by_item_ref FROM source_markers WHERE id = ?').get(markerId)).toMatchObject({ discharged_by_item_ref: actionId });

      // (d) An undischarged, undismissed HIGH marker is a blocker.
      const run2 = trustedRun(db, project.projectId, sourceId);
      const silent = packetFor(db, project.projectId, 'DEMO', sourceId, run2);
      silent.sheets.Actions.rows[0].discharges_markers = [];
      linkSourcesRow(db, project.projectId, silent);
      silent.sheets.Actions.rows[0].op = 'update';
      silent.sheets.Actions.rows[0].target_id = actionId;
      silent.sheets.Actions.rows[0].proposed_id = actionId;
      const silentResult = validatePacket(db, silent);
      expect(hasIssue(silentResult, 'high-marker-discharge', 'blocker')).toBe(true);

      // A marker the consultant explicitly dismissed is not a blocker.
      db.prepare('UPDATE source_markers SET dismissal_reason = ? WHERE id = ?').run('Restated an already-open action.', markerId);
      expect(hasIssue(validatePacket(db, silent), 'high-marker-discharge')).toBe(false);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B4 ===================================== */

describe('B4 — window coverage is a gate, not a checklist of keys', () => {
  it('blocks failed, unexplained-empty, unsupported and unknown windows', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const project = await createSyntheticProject(db, root, 'WIDE');
      const topics = ['reporting', 'training', 'migration', 'licensing', 'scheduling', 'handover'];
      const lines: SpokenLine[] = [{ speaker: 'Casey', text: 'Confirm the release route for the reporting strand of the programme during this session.' }];
      for (let index = 2; index <= 400; index += 1) {
        lines.push({ speaker: index % 2 === 0 ? 'Dana' : 'Casey', text: `Item ${index} covers the ${topics[index % topics.length]} strand of the programme and the team reviewed it during this session.` });
      }
      const intake = await intakeProjectSource(db, project.projectId, { name: 'wide-session.vtt', dataBase64: vttBytes(lines).toString('base64') });
      const sourceId = String(intake.sourceId);
      const runId = trustedRun(db, project.projectId, sourceId);
      const windows = db.prepare('SELECT seq, start_seq, end_seq FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<{ seq: number; start_seq: number; end_seq: number }>;
      expect(windows.length).toBeGreaterThan(1);
      expect((db.prepare("SELECT count(*) count FROM source_markers WHERE source_id = ? AND confidence = 'high'").get(sourceId) as { count: number }).count).toBe(0);

      // Every packet row is anchored at segment 1, so only the first window has
      // supporting rows; the rest are honestly reported as empty and explained.
      const base = packetFor(db, project.projectId, 'WIDE', sourceId, runId);
      base.coverage.windows = windows.map((window) => ({ key: String(window.seq), status: 'reviewed' as const, item_count: window.seq === 1 ? 2 : 0, explanation: window.seq === 1 ? 'Two governance items found.' : 'No governance content in this window.' }));
      const baseResult = validatePacket(db, base);
      expect(ruleList(baseResult)).toEqual([]);
      expect(baseResult.verdict).toBe('clean');

      const failed = structuredClone(base);
      for (const entry of failed.coverage.windows) { entry.status = 'failed'; entry.item_count = 0; entry.explanation = null; }
      const failedResult = validatePacket(db, failed);
      expect(failedResult.verdict).toBe('quarantined');
      expect(failedResult.issues.filter((issue) => issue.rule === 'window-failed')).toHaveLength(windows.length);

      const unexplained = structuredClone(base);
      unexplained.coverage.windows[1].status = 'reviewed';
      unexplained.coverage.windows[1].item_count = 0;
      unexplained.coverage.windows[1].explanation = null;
      const unexplainedResult = validatePacket(db, unexplained);
      expect(unexplainedResult.verdict).toBe('quarantined');
      expect(hasIssue(unexplainedResult, 'window-empty-unexplained', 'blocker')).toBe(true);

      const overclaimed = structuredClone(base);
      overclaimed.coverage.windows[1].item_count = 4;
      const overclaimedResult = validatePacket(db, overclaimed);
      expect(overclaimedResult.verdict).toBe('quarantined');
      expect(hasIssue(overclaimedResult, 'window-item-count', 'blocker')).toBe(true);

      const invented = structuredClone(base);
      invented.coverage.windows.push({ key: String(windows.length + 99), status: 'reviewed', item_count: 0, explanation: 'Window that does not exist.' });
      const inventedResult = validatePacket(db, invented);
      expect(inventedResult.verdict).toBe('quarantined');
      expect(hasIssue(inventedResult, 'window-unknown', 'blocker')).toBe(true);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ================================ B5 ===================================== */

describe('B5 — source event dates', () => {
  it('derives the event date from the document header and holds the packet to it', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const project = await createSyntheticProject(db, root, 'DATED');
      const intake = await intakeProjectSource(db, project.projectId, { name: GOVERNED_FILE, dataBase64: vttBytes(GOVERNED_LINES, { recorded: '2026-07-30' }).toString('base64') });
      // Derived at intake from the source itself; no raw SQL wrote it.
      expect(intake.eventDate).toBe('2026-07-30');
      expect(readSourceIntelligence(db, project.projectId).sources[0].eventDate).toBe('2026-07-30');

      const sourceId = String(intake.sourceId);
      const runId = trustedRun(db, project.projectId, sourceId);
      const packet = packetFor(db, project.projectId, 'DATED', sourceId, runId);
      expect(packet.source.event_date).toBe('2026-07-30');
      expect(validatePacket(db, packet).verdict).toBe('clean');

      const restated = structuredClone(packet);
      restated.source.event_date = '2099-01-01';
      const restatedResult = validatePacket(db, restated);
      expect(restatedResult.verdict).toBe('quarantined');
      expect(hasIssue(restatedResult, 'source-event-date', 'blocker')).toBe(true);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still protects human edits when the source has no derivable event date', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'UNDATED');
      expect(db.prepare('SELECT event_date FROM source_documents WHERE id = ?').get(sourceId)).toMatchObject({ event_date: null });

      const first = packetFor(db, project.projectId, 'UNDATED', sourceId, runId);
      expect(validatePacket(db, first).verdict).toBe('clean');
      freezeAndApply(db, first);
      const actionId = externalId(db, project.projectId, 'Actions');
      const sourceRowId = externalId(db, project.projectId, 'Sources');
      const ingestedAt = String((db.prepare('SELECT created_at FROM source_documents WHERE id = ?').get(sourceId) as { created_at: string }).created_at);

      // An event that predates the ingest does not outrank the source.
      recordRegisterEvent(db, project.projectId, actionId, { actor: 'Casey', eventType: 'correct', field: 'status', newValue: 'open', reason: 'Historic correction recorded long before this source arrived.', occurredAt: '2020-01-01T00:00:00.000Z' });
      const run2 = trustedRun(db, project.projectId, sourceId);
      const older = packetFor(db, project.projectId, 'UNDATED', sourceId, run2);
      older.sheets.Actions.rows[0].op = 'update';
      older.sheets.Actions.rows[0].target_id = actionId;
      older.sheets.Actions.rows[0].proposed_id = actionId;
      older.sheets.Sources.rows[0].op = 'update';
      older.sheets.Sources.rows[0].target_id = sourceRowId;
      older.sheets.Sources.rows[0].proposed_id = sourceRowId;
      const frozenOlder = freezePacketAndCreateChangeset(db, older);
      expect(opsOf(db, frozenOlder.changesetId).find((op) => op.register_name === 'Actions')).toMatchObject({ op: 'update' });

      // An event recorded after ingest does, even though event_date is NULL.
      const afterIngest = new Date(Date.parse(ingestedAt) + 60_000).toISOString();
      recordRegisterEvent(db, project.projectId, actionId, { actor: 'Casey', eventType: 'status-change', field: 'status', newValue: 'completed', reason: 'Consultant closed this after the meeting.', occurredAt: afterIngest });
      const run3 = trustedRun(db, project.projectId, sourceId);
      const newer = packetFor(db, project.projectId, 'UNDATED', sourceId, run3);
      newer.sheets.Actions.rows[0].op = 'update';
      newer.sheets.Actions.rows[0].target_id = actionId;
      newer.sheets.Actions.rows[0].proposed_id = actionId;
      newer.sheets.Actions.rows[0].summary = 'Confirm the release route once the platform team replies.';
      newer.sheets.Sources.rows[0].op = 'update';
      newer.sheets.Sources.rows[0].target_id = sourceRowId;
      newer.sheets.Sources.rows[0].proposed_id = sourceRowId;
      const frozenNewer = freezePacketAndCreateChangeset(db, newer);
      const conflicted = opsOf(db, frozenNewer.changesetId).find((op) => op.register_name === 'Actions')!;
      expect(conflicted.op).toBe('conflict');
      expect(String(conflicted.field_diff_json)).toContain('status');
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B6 ===================================== */

describe('B6 — human precedence is per field, not per row', () => {
  it('lets an unrelated field be updated while contesting only the field a human touched', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'FIELD');
      const seed = packetFor(db, project.projectId, 'FIELD', sourceId, runId);
      seed.sheets.Risks_Issues = { rows: [{ ...structuredClone(seed.sheets.Actions.rows[0]), client_ref: 'risk-1', title: 'Pilot tenant has no backup schedule', summary: 'The pilot tenant has no backup schedule at all.', anchors: [anchorAt(db, sourceId, 4)], discharges_markers: [], details: { mitigation: 'Ask the platform team for a schedule.' } }] };
      setCategory(seed, 'Risks_Issues', { status: 'populated', item_count: 1, explanation: 'Synthetic risk extracted.' });
      expect(validatePacket(db, seed).verdict).toBe('clean');
      freezeAndApply(db, seed);

      const riskId = externalId(db, project.projectId, 'Risks_Issues');
      const sourceRowId = externalId(db, project.projectId, 'Sources');
      const actionId = externalId(db, project.projectId, 'Actions');
      recordRegisterEvent(db, project.projectId, riskId, { actor: 'Casey', eventType: 'reassignment', field: 'owner', newValue: 'Dana', reason: 'Ownership moved to the platform lead.', occurredAt: new Date(Date.now() + 60_000).toISOString() });

      const buildUpdate = (owner: string | null, summary: string) => {
        const run = trustedRun(db, project.projectId, sourceId);
        const packet = packetFor(db, project.projectId, 'FIELD', sourceId, run);
        packet.sheets.Actions.rows[0].op = 'update';
        packet.sheets.Actions.rows[0].target_id = actionId;
        packet.sheets.Actions.rows[0].proposed_id = actionId;
        packet.sheets.Sources.rows[0].op = 'update';
        packet.sheets.Sources.rows[0].target_id = sourceRowId;
        packet.sheets.Sources.rows[0].proposed_id = sourceRowId;
        packet.sheets.Risks_Issues = { rows: [{
          ...structuredClone(seed.sheets.Risks_Issues.rows[0]),
          op: 'update' as const,
          target_id: riskId,
          proposed_id: riskId,
          owner,
          due_date_raw: null,
          summary,
          details: { mitigation: 'Platform team to publish a nightly backup schedule.' },
        }] };
        setCategory(packet, 'Risks_Issues', { status: 'populated', item_count: 1, explanation: 'Synthetic risk updated.' });
        return packet;
      };

      // Owner unasserted: nothing this packet changes is contested.
      const untouched = buildUpdate(null, 'The pilot tenant has no backup schedule and no agreed retention.');
      expect(validatePacket(db, untouched).verdict).toBe('clean');
      const frozenUntouched = freezePacketAndCreateChangeset(db, untouched);
      const untouchedOp = opsOf(db, frozenUntouched.changesetId).find((op) => op.register_name === 'Risks_Issues')!;
      expect(untouchedOp.op).toBe('update');
      expect(String(untouchedOp.field_diff_json)).toContain('"contestedFields":[]');

      // Owner asserted: contested, and the reason names the field.
      const contested = buildUpdate('Casey', 'The pilot tenant has no backup schedule and no agreed retention window.');
      const frozenContested = freezePacketAndCreateChangeset(db, contested);
      const contestedOp = opsOf(db, frozenContested.changesetId).find((op) => op.register_name === 'Risks_Issues')!;
      expect(contestedOp.op).toBe('conflict');
      const diff = JSON.parse(String(contestedOp.field_diff_json)) as { reason: string; contestedFields: string[] };
      expect(diff.contestedFields).toEqual(['owner']);
      expect(diff.reason).toContain('owner');
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B7 ===================================== */

describe('B7 — a failed run is not provenance', () => {
  it('blocks a failed run and a run that produced no output', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'PROV');
      const clean = packetFor(db, project.projectId, 'PROV', sourceId, runId);
      expect(validatePacket(db, clean).verdict).toBe('clean');

      const cloneRun = (id: string, patch: { status?: string; output?: string | null }) => {
        const source = db.prepare('SELECT word_count FROM source_documents WHERE id = ?').get(sourceId) as { word_count: number };
        db.prepare('INSERT INTO extraction_runs (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
          .run(id, sourceId, project.projectId, 'extract', 'frozen-synthetic-provider', 'fixture-v1', 'a'.repeat(64), 'b'.repeat(64), 100, 0, Math.ceil(source.word_count * 1.35), new Date().toISOString(), 12, patch.status ?? 'completed', patch.output === undefined ? 'c'.repeat(64) : patch.output);
        return id;
      };

      const failedRun = cloneRun('run:failed', { status: 'failed', output: null });
      const failed = structuredClone(clean);
      failed.execution.runs = [failedRun];
      const failedResult = validatePacket(db, failed);
      expect(failedResult.verdict).toBe('quarantined');
      expect(hasIssue(failedResult, 'execution-status', 'blocker')).toBe(true);

      const outputlessRun = cloneRun('run:no-output', { status: 'completed', output: null });
      const outputless = structuredClone(clean);
      outputless.execution.runs = [outputlessRun];
      const outputlessResult = validatePacket(db, outputless);
      expect(outputlessResult.verdict).toBe('quarantined');
      expect(hasIssue(outputlessResult, 'execution-output', 'blocker')).toBe(true);
      expect(hasIssue(outputlessResult, 'execution-status')).toBe(false);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ B8 ===================================== */

const FOLLOW_UP_LINES: SpokenLine[] = [
  { speaker: 'Casey', text: 'Confirm the release route with the platform team before the customer sign-off is issued.' },
  { speaker: 'Dana', text: 'Publish the revised licence counts for the second wave of onboarding this week.' },
  { speaker: 'Casey', text: 'Both of those belong on the delivery plan for the coming fortnight.' },
];

describe('B8 — possible_duplicate is produced deterministically', () => {
  it('flags a paraphrased re-statement, leaves a genuinely different action alone, and refuses to accept or apply the duplicate', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const project = await createSyntheticProject(db, root, 'DUP');
      const firstIntake = await intakeProjectSource(db, project.projectId, { name: 'governance-review.vtt', dataBase64: vttBytes(GOVERNED_LINES).toString('base64') });
      const firstSource = String(firstIntake.sourceId);
      const firstRun = trustedRun(db, project.projectId, firstSource);
      const seed = packetFor(db, project.projectId, 'DUP', firstSource, firstRun);
      expect(validatePacket(db, seed).verdict).toBe('clean');
      freezeAndApply(db, seed);
      const actionId = externalId(db, project.projectId, 'Actions');
      expect(db.prepare('SELECT title FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId)).toMatchObject({ title: 'Confirm the release route' });

      const secondIntake = await intakeProjectSource(db, project.projectId, { name: 'programme-update.vtt', dataBase64: vttBytes(FOLLOW_UP_LINES).toString('base64') });
      const secondSource = String(secondIntake.sourceId);
      const secondRun = trustedRun(db, project.projectId, secondSource);
      const followUp = packetFor(db, project.projectId, 'DUP', secondSource, secondRun);
      followUp.sheets.Actions.rows[0].title = 'Confirm the release route with the platform team';
      followUp.sheets.Actions.rows[0].summary = 'Confirm the release route with the platform team before sign-off.';
      followUp.sheets.Actions.rows.push({
        ...structuredClone(followUp.sheets.Actions.rows[0]),
        client_ref: 'action-2',
        title: 'Publish the revised licence counts',
        summary: 'Publish the revised licence counts for the second wave of onboarding.',
        anchors: [anchorAt(db, secondSource, 2)],
        discharges_markers: [],
      });
      setCategory(followUp, 'Actions', { status: 'populated', item_count: 2, explanation: 'Two synthetic facts extracted.' });
      expect(validatePacket(db, followUp).verdict).toBe('clean');

      const frozen = freezePacketAndCreateChangeset(db, followUp);
      const ops = opsOf(db, frozen.changesetId);
      const duplicate = ops.find((op) => op.client_ref === 'action-1')!;
      const distinct = ops.find((op) => op.client_ref === 'action-2')!;
      expect(duplicate.op).toBe('possible_duplicate');
      expect(JSON.parse(String(duplicate.field_diff_json))).toMatchObject({ duplicateOf: actionId });
      expect(String(duplicate.field_diff_json)).toContain(actionId);
      expect(distinct.op).toBe('add');

      // Determinism: rebuilding the ops from the frozen artefact reproduces the
      // identical changeset hash.
      const replayed = replayPacket(db, frozen.packetId);
      expect(replayed.changesetHash).toBe(frozen.deterministicHash);
      expect(replayPacket(db, frozen.packetId).changesetHash).toBe(replayed.changesetHash);

      // The duplicate cannot be accepted...
      expect(() => reviewChangeset(db, frozen.changesetId, { decision: 'accept', reviewer: 'Casey', opIds: [String(duplicate.id)] })).toThrow(/possible duplicates cannot be accepted/i);
      // ...and cannot be applied even if its status is forced.
      reviewChangeset(db, frozen.changesetId, { decision: 'accept', reviewer: 'Casey', opIds: ops.filter((op) => op.id !== duplicate.id).map((op) => String(op.id)) });
      db.prepare("UPDATE register_change_ops SET status = 'accepted' WHERE id = ?").run(String(duplicate.id));
      db.prepare("UPDATE register_changesets SET review_status = 'ready-to-apply' WHERE id = ?").run(frozen.changesetId);
      expect(() => applyReviewedChangeset(db, frozen.changesetId)).toThrow(/requires adjudication/i);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ C1 ===================================== */

describe('C1 — re-freezing cannot erase review', () => {
  it('returns the existing handoff untouched and still applies the reviewed operations exactly once', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'REFRZ');
      const packet = packetFor(db, project.projectId, 'REFRZ', sourceId, runId);
      const frozen = freezePacketAndCreateChangeset(db, packet);
      const opIds = opsOf(db, frozen.changesetId).map((op) => String(op.id));
      expect(reviewChangeset(db, frozen.changesetId, { decision: 'accept', reviewer: 'Casey', opIds, batch: true })).toMatchObject({ reviewStatus: 'ready-to-apply' });

      const again = freezePacketAndCreateChangeset(db, packet) as { alreadyFrozen?: boolean; changesetId: string; packetId: string; deterministicHash: string };
      expect(again.alreadyFrozen).toBe(true);
      expect(again.changesetId).toBe(frozen.changesetId);
      expect(again.packetId).toBe(frozen.packetId);
      expect(again.deterministicHash).toBe(frozen.deterministicHash);
      const afterRefreeze = opsOf(db, frozen.changesetId);
      expect(afterRefreeze.every((op) => op.status === 'accepted')).toBe(true);
      expect(afterRefreeze.every((op) => op.reviewer === 'Casey')).toBe(true);
      expect(db.prepare('SELECT review_status FROM register_changesets WHERE id = ?').get(frozen.changesetId)).toMatchObject({ review_status: 'ready-to-apply' });

      const revisionBefore = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(project.projectId) as { revision: number } | undefined)?.revision ?? 0);
      const applied = applyReviewedChangeset(db, frozen.changesetId);
      expect(applied.appliedOperations).toBe(2);
      const revisionAfter = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(project.projectId) as { revision: number }).revision);
      expect(revisionAfter).toBe(revisionBefore + 1);
      expect((db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(project.projectId) as { count: number }).count).toBe(2);

      // A changeset with nothing accepted is refused rather than recorded as an
      // empty apply.
      const run2 = trustedRun(db, project.projectId, sourceId);
      const second = packetFor(db, project.projectId, 'REFRZ', sourceId, run2);
      const sourceRowId = externalId(db, project.projectId, 'Sources');
      const actionId = externalId(db, project.projectId, 'Actions');
      second.sheets.Actions.rows[0].op = 'update';
      second.sheets.Actions.rows[0].target_id = actionId;
      second.sheets.Actions.rows[0].proposed_id = actionId;
      second.sheets.Sources.rows[0].op = 'update';
      second.sheets.Sources.rows[0].target_id = sourceRowId;
      second.sheets.Sources.rows[0].proposed_id = sourceRowId;
      const frozenSecond = freezePacketAndCreateChangeset(db, second);
      reviewChangeset(db, frozenSecond.changesetId, { decision: 'reject', reviewer: 'Casey', opIds: opsOf(db, frozenSecond.changesetId).map((op) => String(op.id)) });
      expect(db.prepare('SELECT review_status FROM register_changesets WHERE id = ?').get(frozenSecond.changesetId)).toMatchObject({ review_status: 'ready-to-apply' });
      expect(() => applyReviewedChangeset(db, frozenSecond.changesetId)).toThrow(/no accepted operations/i);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ C4 ===================================== */

describe('C4 — replay verifies the frozen artefact', () => {
  it('rejects an in-place rewrite at the database, and rejects altered or non-canonical stored bytes at replay', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'FROZE');
      const packet = packetFor(db, project.projectId, 'FROZE', sourceId, runId);
      const frozen = freezePacketAndCreateChangeset(db, packet);

      // Primary defence: migration 011's immutability trigger.
      expect(() => db.prepare('UPDATE extraction_packets SET packet_json = ? WHERE id = ?').run('{"tampered":true}', frozen.packetId))
        .toThrow(/frozen artefacts and cannot be updated/i);
      expect(db.prepare('SELECT packet_sha256 FROM extraction_packets WHERE id = ?').get(frozen.packetId)).toMatchObject({ packet_sha256: frozen.packetHash });

      // The replay guard itself is reachable without defeating that trigger,
      // because INSERT is the one path the trigger does not cover: a forged row
      // whose bytes do not hash to its recorded digest.
      const original = db.prepare('SELECT * FROM extraction_packets WHERE id = ?').get(frozen.packetId) as Record<string, unknown>;
      const columns = Object.keys(original);
      const insertForged = db.prepare(`INSERT INTO extraction_packets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      const sha = (value: string) => createHash('sha256').update(value).digest('hex');

      const tamperedJson = String(original.packet_json).replace('Confirm the release route', 'Confirm the penalty payment');
      expect(tamperedJson).not.toBe(String(original.packet_json));
      const alteredId = 'packet:forged:altered';
      insertForged.run(...columns.map((column) => (column === 'id' ? alteredId : column === 'packet_json' ? tamperedJson : column === 'packet_sha256' ? sha(`${tamperedJson}:decoy`) : original[column] as never)));
      expect(() => replayPacket(db, alteredId)).toThrow(/Stored packet has been altered/i);

      // Bytes that hash to their recorded digest but are not the canonical
      // serialisation are also refused.
      const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(String(original.packet_json)) as Record<string, unknown>).reverse()));
      const reorderedId = 'packet:forged:reordered';
      insertForged.run(...columns.map((column) => (column === 'id' ? reorderedId : column === 'packet_json' ? reordered : column === 'packet_sha256' ? sha(reordered) : original[column] as never)));
      expect(() => replayPacket(db, reorderedId)).toThrow(/Canonical re-serialisation/i);

      // The untouched artefact replays cleanly, without any provider call.
      const first = replayPacket(db, frozen.packetId);
      expect(first).toMatchObject({ packetHashVerified: true, providerCalls: 0 });
      expect(first.durationMs).toBeLessThan(5000);
      expect(replayPacket(db, frozen.packetId).changesetHash).toBe(first.changesetHash);
      expect(first.changesetHash).toBe(frozen.deterministicHash);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* =============================== C16 ===================================== */

describe('C16 — replay after apply is not falsely quarantined', () => {
  it('keeps the recorded verdict and reports that the register has moved on', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'RPLY');
      const packet = packetFor(db, project.projectId, 'RPLY', sourceId, runId);
      const frozen = freezePacketAndCreateChangeset(db, packet);
      expect(replayPacket(db, frozen.packetId)).toMatchObject({ validationVerdict: 'clean', revisionCurrent: true });
      reviewAndApply(db, frozen.changesetId);
      const afterApply = replayPacket(db, frozen.packetId);
      expect(afterApply.validationVerdict).not.toBe('quarantined');
      expect(afterApply.validationVerdict).toBe('clean');
      expect(afterApply.revisionCurrent).toBe(false);
      expect(afterApply.packetHashVerified).toBe(true);
      // Freeze mode still refuses to re-freeze against a moved-on register.
      expect(validatePacket(db, packet, { mode: 'freeze' }).issues.some((issue) => issue.rule === 'base-register-revision')).toBe(true);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* =============================== C13 ===================================== */

describe('C13 — update is a patch, not an overwrite', () => {
  it('leaves an unasserted owner intact and clears it only when explicitly emptied', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'PATCH');
      freezeAndApply(db, packetFor(db, project.projectId, 'PATCH', sourceId, runId));
      const actionId = externalId(db, project.projectId, 'Actions');
      const sourceRowId = externalId(db, project.projectId, 'Sources');
      expect(db.prepare('SELECT owner FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId)).toMatchObject({ owner: 'Casey' });

      const buildUpdate = (owner: string | null, summary: string) => {
        const run = trustedRun(db, project.projectId, sourceId);
        const packet = packetFor(db, project.projectId, 'PATCH', sourceId, run);
        const action = packet.sheets.Actions.rows[0];
        action.op = 'update';
        action.target_id = actionId;
        action.proposed_id = actionId;
        action.owner = owner;
        action.due_date_raw = null;
        action.summary = summary;
        const sources = packet.sheets.Sources.rows[0];
        sources.op = 'update';
        sources.target_id = sourceRowId;
        sources.proposed_id = sourceRowId;
        return packet;
      };

      const summaryOnly = buildUpdate(null, 'Confirm the release route once the platform team replies.');
      expect(validatePacket(db, summaryOnly).verdict).toBe('clean');
      freezeAndApply(db, summaryOnly);
      expect(db.prepare('SELECT owner, summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId))
        .toMatchObject({ owner: 'Casey', summary: 'Confirm the release route once the platform team replies.' });

      const cleared = buildUpdate('', 'Confirm the release route; ownership is now unallocated.');
      expect(validatePacket(db, cleared).verdict).toBe('clean');
      freezeAndApply(db, cleared);
      expect(db.prepare('SELECT owner FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, actionId)).toMatchObject({ owner: null });
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* =============================== C14 ===================================== */

describe('C14 — intra-packet references resolve to allocated identifiers', () => {
  it('rewrites a client_ref cross-reference to the identifier allocated in the same apply', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'REFS');
      const packet = packetFor(db, project.projectId, 'REFS', sourceId, runId);
      const template = structuredClone(packet.sheets.Actions.rows[0]);
      packet.sheets.Decisions = { rows: [{
        ...template,
        client_ref: 'd1',
        title: 'Agree the migration environment',
        summary: 'Nobody has written down which environment the migration script should target.',
        anchors: [anchorAt(db, sourceId, 2)],
        discharges_markers: [],
        related_refs: ['c3'],
        details: { rationale: 'The pilot tenant needs a named environment.' },
      }] };
      packet.sheets.Config_Changes = { rows: [{
        ...template,
        client_ref: 'c3',
        title: 'Set the migration script target environment',
        summary: 'Set which environment the migration script should target for the pilot tenant.',
        anchors: [anchorAt(db, sourceId, 2)],
        discharges_markers: [],
        details: { environment: 'pilot', change_type: 'configuration' },
      }] };
      setCategory(packet, 'Decisions', { status: 'populated', item_count: 1, explanation: 'Synthetic decision extracted.' });
      setCategory(packet, 'Config_Changes', { status: 'populated', item_count: 1, explanation: 'Synthetic config change extracted.' });
      expect(validatePacket(db, packet).verdict).toBe('clean');

      const { applied } = freezeAndApply(db, packet);
      expect(applied.appliedOperations).toBe(4);
      const configId = externalId(db, project.projectId, 'Config_Changes');
      const decision = db.prepare("SELECT related_ids_json FROM project_register_rows WHERE project_id = ? AND register_name = 'Decisions'").get(project.projectId) as { related_ids_json: string };
      expect(JSON.parse(decision.related_ids_json)).toEqual([configId]);
      expect(decision.related_ids_json).not.toContain('c3');
      expect(configId).toMatch(/^REFS-C-\d{3}$/);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* =============================== C12 ===================================== */

describe('C12 — brief headings cannot bypass citation', () => {
  it('treats a factual heading as a claim while keeping structural headings exempt', () => {
    const claim = '## Go-live has slipped to March and the customer is threatening to withhold payment';
    const result = validateBriefCitations(claim, ['DEMO-A-001']);
    expect(result.factual).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.markdown).not.toContain('Go-live has slipped');
    expect(result.valid).toBe(false);

    const structural = validateBriefCitations(['## Needs Warwick', '## Meeting order'].join('\n'), ['DEMO-A-001']);
    expect(structural.factual).toBe(0);
    expect(structural.removed).toBe(0);
    expect(structural.markdown).toContain('## Needs Warwick');
    expect(structural.markdown).toContain('## Meeting order');
    expect(structural.valid).toBe(true);

    // A cited factual heading is kept, so the rule is about citation, not about
    // headings being forbidden.
    const cited = validateBriefCitations('## Go-live has slipped to March [DEMO-A-001]', ['DEMO-A-001']);
    expect(cited.removed).toBe(0);
    expect(cited.markdown).toContain('Go-live has slipped');
  });
});

/* ================================ C9 ===================================== */

describe('C9 — the overview leaves changes mode once acknowledged', () => {
  it('reports changes while a changeset is unacknowledged and stops afterwards', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const { project, sourceId, runId } = await governedProject(db, root, 'OVIEW');
      expect(computeProjectOverview(db, project.projectId).computedMode).not.toBe('changes');
      const frozen = freezePacketAndCreateChangeset(db, packetFor(db, project.projectId, 'OVIEW', sourceId, runId));
      reviewAndApply(db, frozen.changesetId);
      const before = computeProjectOverview(db, project.projectId);
      expect(before.computedMode).toBe('changes');
      expect(before.modes.changes).toMatchObject({ available: true, changesetId: frozen.changesetId });

      const after = acknowledgeChangeset(db, frozen.changesetId, 'Warwick');
      expect(after.computedMode).not.toBe('changes');
      expect(after.modes.changes.available).toBe(false);
      expect(computeProjectOverview(db, project.projectId).computedMode).not.toBe('changes');
      expect(db.prepare('SELECT acknowledged_by FROM register_changesets WHERE id = ?').get(frozen.changesetId)).toMatchObject({ acknowledged_by: 'Warwick' });
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================ C8 ===================================== */

const STRAIGHT = "'";
const CURLY = '’';

interface MarkerCase { label: string; text: string; high: boolean }

const MARKER_CASES: MarkerCase[] = [
  { label: 'explicit addition already made', text: "I've just added the new permit type to the register.", high: true },
  { label: 'named action', text: "Right, that's an action for the delivery team.", high: true },
  { label: 'commitment to check', text: "I'll check with Tony and come back to you.", high: true },
  { label: 'live configuration act', text: "I'll have to tick that box which says suppress records.", high: true },
  { label: 'scheduled day and date', text: 'Let us meet Wednesday the 15th to run through it.', high: true },
  { label: 'scheduled day and time', text: "Let us meet Wednesday at ten o'clock.", high: true },
  { label: 'register note', text: 'AI note for development, the suppression flag needs a label.', high: true },
  { label: 'calendar information', text: 'next Wednesday is a bank holiday for everyone here.', high: false },
  { label: 'completed past work', text: 'we finished that by Friday last month without any fuss.', high: false },
  { label: 'irrelevant change of mind', text: "I'll change my mind about the sandwich before lunch.", high: false },
];

describe('C8 — HIGH-marker detection covers the designs own examples', () => {
  it.each([['straight apostrophes', STRAIGHT], ['curly apostrophes', CURLY]])('classifies every example correctly with %s', async (_label, apostrophe) => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const project = await createSyntheticProject(db, root, 'MARKS');
      const lines = MARKER_CASES.map((entry) => ({ speaker: 'Casey', text: entry.text.split(STRAIGHT).join(apostrophe) }));
      const intake = await intakeProjectSource(db, project.projectId, { name: `marker-scan-${apostrophe === STRAIGHT ? 'plain' : 'curly'}.vtt`, dataBase64: vttBytes(lines).toString('base64') });
      const sourceId = String(intake.sourceId);
      const segments = db.prepare('SELECT seq, text FROM source_segments WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<{ seq: number; text: string }>;
      expect(segments).toHaveLength(MARKER_CASES.length);
      const high = db.prepare("SELECT segment_seq, marker_type FROM source_markers WHERE source_id = ? AND confidence = 'high'").all(sourceId) as Array<{ segment_seq: number; marker_type: string }>;
      const highSeqs = new Set(high.map((marker) => marker.segment_seq));
      const failures = MARKER_CASES
        .map((entry, index) => ({ entry, seq: index + 1 }))
        .filter(({ entry, seq }) => highSeqs.has(seq) !== entry.high)
        .map(({ entry, seq }) => `${entry.high ? 'missed' : 'false'} HIGH marker at segment ${seq}: ${entry.label}`);
      expect(failures).toEqual([]);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
