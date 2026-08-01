import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase, readProjectData } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { rebuildProjection, recordRegisterEvent } from '../src/registerProjection';
import { applyReviewedChangeset, buildConsultantBrief, freezePacketAndCreateChangeset, replayPacket, reviewChangeset, validateBriefCitations, validatePacket, type SourceIntelligencePacket } from '../src/sourceIntelligence';
import { FakeGroundedBriefProvider } from '../src/briefProvider';
import { normalizeSource } from '../src/sourceNormalizers';
import { resolveDate } from '../src/dateResolution';

function tempDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-intelligence-test-'));
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

function zipDocx(documentXml: string): Buffer {
  const name = Buffer.from('word/document.xml');
  const content = Buffer.from(documentXml);
  const compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x08, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(content.length, 12);
  const centralOffset = local.length + name.length + compressed.length + descriptor.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x08, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

function trustedRun(db: DatabaseSync, projectId: string, sourceId: string) {
  const id = `run:${sourceId}:${Date.now()}`;
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
  const empty = { rows: [] };
  const windows = (db.prepare('SELECT seq FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<{ seq: number }>).map((row) => ({ key: String(row.seq), status: 'reviewed' as const, item_count: 1, explanation: 'Synthetic window reviewed.' }));
  const categories = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'].map((key) => ({ key, status: key === 'Actions' || key === 'Sources' ? 'populated' as const : 'none-found' as const, item_count: key === 'Actions' || key === 'Sources' ? 1 : 0, explanation: key === 'Actions' || key === 'Sources' ? 'Synthetic fact extracted.' : 'Synthetic review found no items.' }));
  return {
    packet_type: 'project_register_delta', packet_version: 1, project_code: projectCode, base_register_revision: revision,
    source: { source_id: sourceId, content_hash: String(source.content_hash), source_type: String(source.source_type), original_file_name: String(source.original_file_name), event_date: source.event_date ? String(source.event_date) : null, duration_ms: source.duration_ms === null ? null : Number(source.duration_ms), participants: JSON.parse(String(source.participants_json)) as string[] },
    sheets: {
      Decisions: empty,
      Actions: { rows: [{ ...baseRow, client_ref: 'action-1', title: 'Confirm the release route', summary: 'Confirm the release route by Friday.', discharges_markers: markerIds }] },
      Risks_Issues: empty, Config_Changes: empty, Open_Questions: empty, Milestones: empty, Entities: empty,
      Sources: { rows: [{ ...baseRow, client_ref: 'source-1', title: String(source.original_file_name), summary: 'Immutable source registered.', due_date_raw: null, discharges_markers: [], details: { source_type: String(source.source_type) } }] },
      Uncertainty: empty,
    },
    coverage: { windows, categories },
    execution: { runs: [runId] },
  };
}

describe('source normalisation and dates', () => {
  it('normalises VTT, TXT, EML, and ordinary data-descriptor DOCX into addressable segments', () => {
    const vtt = normalizeSource('meeting.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCasey: Confirm the route'));
    expect(vtt.segments[0]).toMatchObject({ seq: 1, kind: 'cue', speaker: 'Casey', tStartMs: 1000 });
    const txt = normalizeSource('note.txt', Buffer.from('First paragraph.\n\nSecond paragraph.'));
    expect(txt.segments.map((row) => row.paraIndex)).toEqual([0, 1]);
    const eml = normalizeSource('message.eml', Buffer.from('From: casey@example.invalid\nDate: Thu, 30 Jul 2026 09:00:00 +0000\nMessage-ID: <synthetic-1@example.invalid>\nSubject: Release\n\nPlease confirm the route.'));
    expect(eml.segments[0]).toMatchObject({ kind: 'message', sender: 'casey@example.invalid', messageId: '<synthetic-1@example.invalid>' });
    const docx = normalizeSource('note.docx', zipDocx('<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>First synthetic paragraph.</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:body></w:document>'));
    expect(docx.segments).toHaveLength(2);
    expect(docx.segments[1]).toMatchObject({ section: 'Heading1', paraIndex: 1 });
  });

  it('resolves supported wording without fabricating unknown dates', () => {
    expect(resolveDate('2026-08-14').date).toBe('2026-08-14');
    expect(resolveDate('week commencing 2026-08-12').date).toBe('2026-08-10');
    expect(resolveDate('by Friday', '2026-07-30').date).toBe('2026-07-31');
    expect(resolveDate('end of month', '2026-07-30').date).toBe('2026-07-31');
    expect(resolveDate('in a little while', '2026-07-30')).toMatchObject({ date: null, confidence: 'none' });
  });
});

describe('deterministic Source Intelligence spine', () => {
  it('strictly validates, gates review, allocates IDs only in apply, projects, and replays with zero calls', async () => {
    const { dir, root, context } = tempDatabase();
    try {
      const project = await createSyntheticProject(context.db, root);
      const vtt = ['WEBVTT', 'NOTE Recorded: 2026-07-30', '', '00:00:01.000 --> 00:00:04.000', 'Casey: I will confirm the release route by Friday.'].join('\n');
      const intake = await intakeProjectSource(context.db, project.projectId, { name: 'release.vtt', dataBase64: Buffer.from(vtt).toString('base64') });
      const sourceId = String(intake.sourceId);
      // The event date is derived from the source itself at intake; nothing may
      // rewrite immutable evidence afterwards.
      expect(context.db.prepare('SELECT event_date FROM source_documents WHERE id = ?').get(sourceId)).toMatchObject({ event_date: '2026-07-30' });
      const runId = trustedRun(context.db, project.projectId, sourceId);
      const packet = packetFor(context.db, project.projectId, 'DEMO', sourceId, runId);

      expect(validatePacket(context.db, { ...packet, unexpected: true }).packet).toBeNull();
      const fabricated = structuredClone(packet);
      fabricated.sheets.Actions.rows[0].anchors[0].quote = 'Words absent from the source';
      expect(validatePacket(context.db, fabricated)).toMatchObject({ verdict: 'quarantined' });
      expect(validatePacket(context.db, fabricated).issues.some((issue) => issue.rule === 'quote-verification')).toBe(true);
      expect(validatePacket(context.db, packet)).toMatchObject({ verdict: 'clean' });

      const frozen = freezePacketAndCreateChangeset(context.db, packet);
      expect(frozen.gateVerdict).toBe('clean');
      expect((context.db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(project.projectId) as { count: number }).count).toBe(0);
      expect((context.db.prepare('SELECT count(*) count FROM register_change_ops WHERE changeset_id = ? AND allocated_external_id IS NOT NULL').get(frozen.changesetId) as { count: number }).count).toBe(0);
      const replay = replayPacket(context.db, frozen.packetId);
      expect(replay.providerCalls).toBe(0);
      expect(replay.durationMs).toBeLessThan(5000);
      expect(replay.changesetHash).toBe(frozen.deterministicHash);

      const operationIds = (context.db.prepare('SELECT id FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(frozen.changesetId) as Array<{ id: string }>).map((row) => row.id);
      expect(reviewChangeset(context.db, frozen.changesetId, { decision: 'accept', reviewer: 'Casey', opIds: operationIds, batch: true })).toMatchObject({ reviewStatus: 'ready-to-apply' });
      expect((context.db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(project.projectId) as { count: number }).count).toBe(0);
      expect(applyReviewedChangeset(context.db, frozen.changesetId)).toMatchObject({ appliedOperations: 2 });
      const allocated = context.db.prepare('SELECT allocated_external_id FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(frozen.changesetId) as Array<{ allocated_external_id: string }>;
      expect(allocated.every((row) => /^DEMO-(?:A|SRC)-\d{3}$/.test(row.allocated_external_id))).toBe(true);
      let briefCalls = 0;
      const briefProvider = new FakeGroundedBriefProvider(() => {
        briefCalls += 1;
        return { markdown: `## Meeting order\n- Confirm the release route first [${allocated[0].allocated_external_id}]`, usage: { inputTokens: 300, outputTokens: 30 } };
      });
      const groundedBrief = await buildConsultantBrief(context.db, project.projectId, 'needs-warwick', briefProvider);
      expect(groundedBrief).toMatchObject({ generationMode: 'fake-brief-provider' });
      expect(groundedBrief.briefMarkdown).toContain(`[${allocated[0].allocated_external_id}]`);
      expect(briefCalls).toBe(1);
      await buildConsultantBrief(context.db, project.projectId, 'needs-warwick', briefProvider);
      expect(briefCalls).toBe(1);
      expect(context.db.prepare('SELECT input_tokens, status FROM consultant_brief_runs').get()).toMatchObject({ input_tokens: 300, status: 'complete' });
      const data = readProjectData(context.db, project.projectId)!.projects[0];
      expect(data.registerRows).toHaveLength(2);
      expect(data.actions).toHaveLength(1);
      expect(data.registerRows.find((row) => row.registerName === 'Actions')?.dueDate).toBe('2026-07-31');
      expect(data.registerRows.find((row) => row.registerName === 'Actions')?.score?.inputs).toHaveProperty('ownership');
      const beforeProjection = JSON.stringify(context.db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
      rebuildProjection(context.db, project.projectId, '2026-07-30T12:00:00.000Z');
      const once = JSON.stringify(context.db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
      rebuildProjection(context.db, project.projectId, '2026-07-30T12:00:00.000Z');
      const twice = JSON.stringify(context.db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
      expect(once).toBe(twice);
      expect(beforeProjection).not.toBe('[]');
    } finally {
      context.db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a low-confidence lexical hint block a packet and holds an older source against a newer human event as conflict', async () => {
    const { dir, root, context } = tempDatabase();
    try {
      const project = await createSyntheticProject(context.db, root, 'SAFE');
      const firstText = ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', 'Casey: The route is not final.'].join('\n');
      const first = await intakeProjectSource(context.db, project.projectId, { name: 'lexical.vtt', dataBase64: Buffer.from(firstText).toString('base64') });
      const run1 = trustedRun(context.db, project.projectId, String(first.sourceId));
      const packet1 = packetFor(context.db, project.projectId, 'SAFE', String(first.sourceId), run1);
      expect((context.db.prepare("SELECT count(*) count FROM source_markers WHERE source_id = ? AND confidence = 'high'").get(String(first.sourceId)) as { count: number }).count).toBe(0);
      expect(validatePacket(context.db, packet1).verdict).toBe('clean');
      const frozen1 = freezePacketAndCreateChangeset(context.db, packet1);
      const ids1 = (context.db.prepare('SELECT id FROM register_change_ops WHERE changeset_id = ?').all(frozen1.changesetId) as Array<{ id: string }>).map((row) => row.id);
      reviewChangeset(context.db, frozen1.changesetId, { decision: 'accept', reviewer: 'Casey', opIds: ids1, batch: true });
      applyReviewedChangeset(context.db, frozen1.changesetId);
      const target = String((context.db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Actions'").get(project.projectId) as { external_register_id: string }).external_register_id);
      recordRegisterEvent(context.db, project.projectId, target, { actor: 'Casey', eventType: 'status-change', field: 'status', newValue: 'completed', reason: 'Verified complete.', occurredAt: '2026-08-02T10:00:00.000Z' });

      const secondText = ['WEBVTT', 'NOTE Recorded: 2026-08-01', '', '00:00:01.000 --> 00:00:03.000', 'Casey: The release route remains open.'].join('\n');
      const second = await intakeProjectSource(context.db, project.projectId, { name: 'older-update.vtt', dataBase64: Buffer.from(secondText).toString('base64') });
      const run2 = trustedRun(context.db, project.projectId, String(second.sourceId));
      const packet2 = packetFor(context.db, project.projectId, 'SAFE', String(second.sourceId), run2);
      const update = packet2.sheets.Actions.rows[0];
      update.op = 'update';
      update.target_id = target;
      update.proposed_id = target;
      update.status = 'open';
      const frozen2 = freezePacketAndCreateChangeset(context.db, packet2);
      const actionOp = context.db.prepare("SELECT op FROM register_change_ops WHERE changeset_id = ? AND register_name = 'Actions'").get(frozen2.changesetId) as { op: string };
      expect(actionOp.op).toBe('conflict');
      expect(readProjectData(context.db, project.projectId)!.projects[0].registerRows.find((row) => row.externalRegisterId === target)?.currentState?.status).toBe('completed');
    } finally {
      context.db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Goal 2 — a late-arriving but chronologically older source cannot overwrite a chronologically newer one, and replay is order-independent', async () => {
    const { dir, root, context } = tempDatabase();
    try {
      const project = await createSyntheticProject(context.db, root, 'CHRON');

      // Source A establishes the action. Event date 2026-08-01.
      const aText = ['WEBVTT', 'NOTE Recorded: 2026-08-01', '', '00:00:01.000 --> 00:00:03.000', 'Casey: Confirm the release route.'].join('\n');
      const a = await intakeProjectSource(context.db, project.projectId, { name: 'source-a.vtt', dataBase64: Buffer.from(aText).toString('base64') });
      const runA = trustedRun(context.db, project.projectId, String(a.sourceId));
      const packetA = packetFor(context.db, project.projectId, 'CHRON', String(a.sourceId), runA);
      packetA.sheets.Actions.rows[0].summary = 'Summary from source A (2026-08-01).';
      const frozenA = freezePacketAndCreateChangeset(context.db, packetA);
      const idsA = (context.db.prepare('SELECT id FROM register_change_ops WHERE changeset_id = ?').all(frozenA.changesetId) as Array<{ id: string }>).map((row) => row.id);
      reviewChangeset(context.db, frozenA.changesetId, { decision: 'accept', reviewer: 'Casey', opIds: idsA, batch: true });
      applyReviewedChangeset(context.db, frozenA.changesetId);
      const target = String((context.db.prepare("SELECT external_register_id FROM project_register_rows WHERE project_id = ? AND register_name = 'Actions'").get(project.projectId) as { external_register_id: string }).external_register_id);

      // Source B is chronologically NEWER (2026-08-05) and updates the same row.
      const bText = ['WEBVTT', 'NOTE Recorded: 2026-08-05', '', '00:00:01.000 --> 00:00:03.000', 'Casey: The release route is confirmed as the northern corridor.'].join('\n');
      const b = await intakeProjectSource(context.db, project.projectId, { name: 'source-b.vtt', dataBase64: Buffer.from(bText).toString('base64') });
      const runB = trustedRun(context.db, project.projectId, String(b.sourceId));
      const packetB = packetFor(context.db, project.projectId, 'CHRON', String(b.sourceId), runB);
      const updateB = packetB.sheets.Actions.rows[0];
      updateB.op = 'update'; updateB.target_id = target; updateB.proposed_id = target; updateB.status = 'open';
      updateB.summary = 'Summary from source B (2026-08-05), the newer decision.';
      const frozenB = freezePacketAndCreateChangeset(context.db, packetB);
      expect((context.db.prepare("SELECT op FROM register_change_ops WHERE changeset_id = ? AND register_name = 'Actions'").get(frozenB.changesetId) as { op: string }).op).toBe('update');
      // Its own Sources row registers source-b.vtt as a new record and may be
      // held (e.g. `possible_duplicate` against source-a.vtt's own Sources
      // row) — irrelevant to what this test checks, so route each op's
      // decision by whether it can legally be accepted at all.
      const opsB = context.db.prepare('SELECT id, op FROM register_change_ops WHERE changeset_id = ?').all(frozenB.changesetId) as Array<{ id: string; op: string }>;
      const heldOps = new Set(['conflict', 'unverified_link', 'possible_duplicate']);
      for (const row of opsB) reviewChangeset(context.db, frozenB.changesetId, { decision: heldOps.has(row.op) ? 'reject' : 'accept', reviewer: 'Casey', opIds: [row.id] });
      applyReviewedChangeset(context.db, frozenB.changesetId);
      expect((context.db.prepare('SELECT summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, target) as { summary: string }).summary)
        .toBe('Summary from source B (2026-08-05), the newer decision.');

      // Source C is a LATE-ARRIVING but chronologically OLDER source
      // (2026-07-20, before both A and B) proposing an update to the same
      // field. It must be held as a conflict, not silently applied over B's
      // chronologically newer state.
      const cText = ['WEBVTT', 'NOTE Recorded: 2026-07-20', '', '00:00:01.000 --> 00:00:03.000', 'Casey: The release route is still under discussion.'].join('\n');
      const c = await intakeProjectSource(context.db, project.projectId, { name: 'source-c.vtt', dataBase64: Buffer.from(cText).toString('base64') });
      const runC = trustedRun(context.db, project.projectId, String(c.sourceId));
      const packetC = packetFor(context.db, project.projectId, 'CHRON', String(c.sourceId), runC);
      const updateC = packetC.sheets.Actions.rows[0];
      updateC.op = 'update'; updateC.target_id = target; updateC.proposed_id = target; updateC.status = 'open';
      updateC.summary = 'Stale summary from source C (2026-07-20), arriving late.';
      const frozenC = freezePacketAndCreateChangeset(context.db, packetC);
      expect((context.db.prepare("SELECT op FROM register_change_ops WHERE changeset_id = ? AND register_name = 'Actions'").get(frozenC.changesetId) as { op: string }).op).toBe('conflict');

      // Held, never applied: B's value survives untouched — both positions
      // stay inspectable via the append-only event trail rather than one
      // silently replacing the other.
      expect((context.db.prepare('SELECT summary FROM project_register_rows WHERE project_id = ? AND external_register_id = ?').get(project.projectId, target) as { summary: string }).summary)
        .toBe('Summary from source B (2026-08-05), the newer decision.');
      const summaryEvents = context.db.prepare("SELECT new_value FROM register_row_events WHERE project_id = ? AND external_register_id = ? AND field = 'summary' ORDER BY occurred_at").all(project.projectId, target) as Array<{ new_value: string }>;
      expect(summaryEvents.map((event) => event.new_value)).toEqual([
        'Summary from source A (2026-08-01).',
        'Summary from source B (2026-08-05), the newer decision.',
      ]);

      // Deterministic, order-independent replay: rebuilding the projection
      // twice from the same event log yields byte-identical state.
      rebuildProjection(context.db, project.projectId, '2026-08-06T00:00:00.000Z');
      const once = JSON.stringify(context.db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
      rebuildProjection(context.db, project.projectId, '2026-08-06T00:00:00.000Z');
      const twice = JSON.stringify(context.db.prepare('SELECT * FROM register_row_state WHERE project_id = ? ORDER BY external_register_id').all(project.projectId));
      expect(once).toBe(twice);
    } finally {
      context.db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes unsupported or uncited brief claims', () => {
    const markdown = ['## Brief', 'Confirmed route [DEMO-A-001]', 'Unsupported statement.', 'Wrong record [DEMO-R-999]'].join('\n');
    const result = validateBriefCitations(markdown, ['DEMO-A-001']);
    expect(result.markdown).toContain('Confirmed route');
    expect(result.markdown).not.toContain('Unsupported statement');
    expect(result.markdown).not.toContain('DEMO-R-999');
    expect(result.invalidCitations).toContain('DEMO-R-999');
  });
});