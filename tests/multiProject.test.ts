import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { applyReviewedChangeset, freezePacketAndCreateChangeset, reviewChangeset, validatePacket, type SourceIntelligencePacket } from '../src/sourceIntelligence';

/* ------------------------------------------------------------------------- *
 * C2 / C15 — more than one project must be able to ingest.
 *
 * Before the repair, `source_documents.id` was a database-wide primary key
 * while the next `SRC-nnn` was computed per project, so the SECOND project in a
 * database hit `UNIQUE constraint failed` on its very first source and could
 * never ingest at all. Every existing test used a single project in a fresh
 * database, so nothing caught it.
 *
 * The same namespace also held `Sources` REGISTER row identifiers, allocated
 * from an independent counter, so register row `SRC-001` could describe source
 * document `SRC-002` (C15).
 *
 * All fixtures are synthetic.
 * ------------------------------------------------------------------------- */

function tempDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'multi-project-test-'));
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 'test.db'));
  return { dir, root, context };
}

async function createSyntheticProject(db: DatabaseSync, root: string, code: string, name: string) {
  await updateStorageSettings(db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  await verifyStorageRoot(db, true);
  return createProject(db, { code, name, customer: 'Fictional Customer', description: 'Synthetic multi-project validation.', status: 'active', owner: 'Casey' });
}

function trustedRun(db: DatabaseSync, projectId: string, sourceId: string) {
  const id = `run:${sourceId}`;
  const source = db.prepare('SELECT word_count FROM source_documents WHERE id = ?').get(sourceId) as { word_count: number };
  db.prepare('INSERT INTO extraction_runs (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(id, sourceId, projectId, 'extract', 'frozen-synthetic-provider', 'fixture-v1', 'a'.repeat(64), 'b'.repeat(64), 100, 40, Math.ceil(source.word_count * 1.35), new Date().toISOString(), 12, 'completed', 'c'.repeat(64));
  return id;
}

function packetFor(db: DatabaseSync, projectId: string, projectCode: string, sourceId: string, runId: string, title: string, summary: string): SourceIntelligencePacket {
  const source = db.prepare('SELECT * FROM source_documents WHERE id = ?').get(sourceId) as Record<string, unknown>;
  const segment = db.prepare('SELECT * FROM source_segments WHERE source_id = ? ORDER BY seq LIMIT 1').get(sourceId) as Record<string, unknown>;
  const revision = Number((db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(projectId) as { revision: number } | undefined)?.revision ?? 0);
  const markerIds = (db.prepare("SELECT id FROM source_markers WHERE source_id = ? AND confidence = 'high'").all(sourceId) as Array<{ id: string }>).map((row) => row.id);
  const anchors = () => [{ segment_seq: Number(segment.seq), speaker: segment.speaker ? String(segment.speaker) : null, t_ms: segment.t_start_ms === null ? null : Number(segment.t_start_ms), quote: String(segment.text) }];
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
    discharges_markers: [] as string[],
    details: {},
  };
  const empty = { rows: [] };
  const windows = (db.prepare('SELECT seq FROM source_windows WHERE source_id = ? ORDER BY seq').all(sourceId) as Array<{ seq: number }>).map((row) => ({ key: String(row.seq), status: 'reviewed' as const, item_count: 2, explanation: 'Synthetic window reviewed.' }));
  const categories = ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'].map((key) => ({ key, status: key === 'Actions' || key === 'Sources' ? 'populated' as const : 'none-found' as const, item_count: key === 'Actions' || key === 'Sources' ? 1 : 0, explanation: key === 'Actions' || key === 'Sources' ? 'Synthetic fact extracted.' : 'Synthetic review found no items.' }));
  return {
    packet_type: 'project_register_delta', packet_version: 1, project_code: projectCode, base_register_revision: revision,
    source: { source_id: sourceId, content_hash: String(source.content_hash), source_type: String(source.source_type), original_file_name: String(source.original_file_name), event_date: source.event_date ? String(source.event_date) : null, duration_ms: source.duration_ms === null ? null : Number(source.duration_ms), participants: JSON.parse(String(source.participants_json)) as string[] },
    sheets: {
      Decisions: empty,
      Actions: { rows: [{ ...baseRow, anchors: anchors(), client_ref: 'action-1', title, summary, discharges_markers: markerIds }] },
      Risks_Issues: empty, Config_Changes: empty, Open_Questions: empty, Milestones: empty, Entities: empty,
      Sources: { rows: [{ ...baseRow, anchors: anchors(), client_ref: 'source-1', title: String(source.original_file_name), summary: 'Immutable source registered.', due_date_raw: null, discharges_markers: [], details: { source_type: String(source.source_type) } }] },
      Uncertainty: empty,
    },
    coverage: { windows, categories },
    execution: { runs: [runId] },
  };
}

function stamp(totalSeconds: number): string {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return [hours, minutes, seconds].join(':') + '.000';
}

function vttBase64(lines: Array<{ speaker: string; text: string }>): string {
  const blocks: string[] = [['WEB', 'VTT'].join('')];
  lines.forEach((line, index) => {
    blocks.push([`${stamp(index * 10)} --> ${stamp(index * 10 + 8)}`, `${line.speaker}: ${line.text}`].join('\n'));
  });
  return Buffer.from(blocks.join('\n\n'), 'utf8').toString('base64');
}

function reviewAndApply(db: DatabaseSync, changesetId: string) {
  const opIds = (db.prepare('SELECT id FROM register_change_ops WHERE changeset_id = ? ORDER BY seq').all(changesetId) as Array<{ id: string }>).map((row) => String(row.id));
  reviewChangeset(db, changesetId, { decision: 'accept', reviewer: 'Casey', opIds, batch: true });
  return applyReviewedChangeset(db, changesetId);
}

describe('C2 — every project can ingest a source, not only the first', () => {
  it('registers distinct source documents per project and keeps allocation independent', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const alpha = await createSyntheticProject(db, root, 'ALPHA', 'First Delivery');
      const beta = await createSyntheticProject(db, root, 'BETA', 'Second Delivery');
      expect(alpha.projectId).not.toBe(beta.projectId);

      const alphaIntake = await intakeProjectSource(db, alpha.projectId, {
        name: 'alpha-session.vtt',
        dataBase64: vttBase64([
          { speaker: 'Casey', text: 'Confirm the release route before the customer sign-off window closes.' },
          { speaker: 'Dana', text: 'The pilot tenant still has no agreed backup schedule.' },
        ]),
      });
      // The failure this closes was on the SECOND project's very first source:
      // `UNIQUE constraint failed`, intake marked failed, permanently.
      const betaIntake = await intakeProjectSource(db, beta.projectId, {
        name: 'beta-session.vtt',
        dataBase64: vttBase64([
          { speaker: 'Robin', text: 'Agree the reporting cadence with the finance workstream.' },
          { speaker: 'Sam', text: 'The training material references screens renamed at the last upgrade.' },
        ]),
      });

      expect(alphaIntake).toMatchObject({ duplicate: false, processingStatus: 'awaiting_metadata' });
      expect(betaIntake).toMatchObject({ duplicate: false, processingStatus: 'awaiting_metadata' });
      const alphaSource = String(alphaIntake.sourceId);
      const betaSource = String(betaIntake.sourceId);
      expect(alphaSource).not.toBe(betaSource);

      const documents = db.prepare('SELECT id, project_id FROM source_documents ORDER BY id').all() as Array<{ id: string; project_id: string }>;
      expect(documents).toHaveLength(2);
      expect(documents.map((row) => row.project_id).sort()).toEqual([alpha.projectId, beta.projectId].sort());
      // C15: source document identifiers no longer live in the `SRC-nnn`
      // namespace that Sources REGISTER rows are allocated from.
      for (const document of documents) {
        expect(document.id).toMatch(/^SRCDOC-[A-Z]+-\d{3}$/);
        expect(document.id).not.toMatch(/^SRC-\d+$/);
      }

      const alphaRun = trustedRun(db, alpha.projectId, alphaSource);
      const betaRun = trustedRun(db, beta.projectId, betaSource);
      const alphaPacket = packetFor(db, alpha.projectId, 'ALPHA', alphaSource, alphaRun, 'Confirm the release route', 'Confirm the release route before customer sign-off.');
      const betaPacket = packetFor(db, beta.projectId, 'BETA', betaSource, betaRun, 'Agree the reporting cadence', 'Agree the reporting cadence with the finance workstream.');
      expect(validatePacket(db, alphaPacket).verdict).toBe('clean');
      expect(validatePacket(db, betaPacket).verdict).toBe('clean');

      // A packet may not reach across the project boundary.
      const crossed = structuredClone(alphaPacket);
      crossed.project_code = 'BETA';
      expect(validatePacket(db, crossed).issues.some((issue) => issue.rule === 'project-boundary')).toBe(true);

      const alphaFrozen = freezePacketAndCreateChangeset(db, alphaPacket);
      const betaFrozen = freezePacketAndCreateChangeset(db, betaPacket);
      expect(alphaFrozen.changesetId).not.toBe(betaFrozen.changesetId);
      expect(alphaFrozen.gateVerdict).toBe('clean');
      expect(betaFrozen.gateVerdict).toBe('clean');
      expect(reviewAndApply(db, alphaFrozen.changesetId)).toMatchObject({ appliedOperations: 2, revision: 1 });

      const rowsFor = (projectId: string) => db.prepare('SELECT register_name, external_register_id, title FROM project_register_rows WHERE project_id = ? ORDER BY external_register_id').all(projectId) as Array<{ register_name: string; external_register_id: string; title: string }>;
      const alphaRows = rowsFor(alpha.projectId);
      expect(alphaRows.map((row) => row.external_register_id)).toEqual(['ALPHA-A-001', 'ALPHA-SRC-001']);
      expect(alphaRows.find((row) => row.register_name === 'Actions')?.title).toBe('Confirm the release route');
      const documentIds = new Set(documents.map((row) => row.id));
      for (const row of alphaRows) expect(documentIds.has(row.external_register_id)).toBe(false);
      expect(db.prepare('SELECT revision FROM project_register_revisions WHERE project_id = ?').get(alpha.projectId)).toMatchObject({ revision: 1 });
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  /* -------------------------------------------------------------------------
   * C2/C15 completed: `Sources` REGISTER rows are project-qualified too.
   *
   * Source DOCUMENT ids were changed to `SRCDOC-<CODE>-nnn`, but `Sources`
   * register rows were still allocated from one unqualified `SRC-nnn`
   * namespace, and `rebuildProjection` projects them into `project_sources`,
   * whose `id` is a database-wide PRIMARY KEY. Since `validatePacket` makes a
   * Sources row mandatory, EVERY apply in EVERY project after the first used to
   * abort — the C2 failure shape displaced from ingest to apply.
   * ----------------------------------------------------------------------- */
  it('lets every project apply its own Sources register row without colliding on a shared identifier', async () => {
    const { dir, root, context } = tempDatabase();
    const db = context.db;
    try {
      const alpha = await createSyntheticProject(db, root, 'ALPHA', 'First Delivery');
      const beta = await createSyntheticProject(db, root, 'BETA', 'Second Delivery');
      const alphaIntake = await intakeProjectSource(db, alpha.projectId, { name: 'alpha-session.vtt', dataBase64: vttBase64([{ speaker: 'Casey', text: 'Confirm the release route before the customer sign-off window closes.' }]) });
      const betaIntake = await intakeProjectSource(db, beta.projectId, { name: 'beta-session.vtt', dataBase64: vttBase64([{ speaker: 'Robin', text: 'Agree the reporting cadence with the finance workstream.' }]) });
      const alphaSource = String(alphaIntake.sourceId);
      const betaSource = String(betaIntake.sourceId);

      const alphaFrozen = freezePacketAndCreateChangeset(db, packetFor(db, alpha.projectId, 'ALPHA', alphaSource, trustedRun(db, alpha.projectId, alphaSource), 'Confirm the release route', 'Confirm the release route before customer sign-off.'));
      reviewAndApply(db, alphaFrozen.changesetId);
      expect(db.prepare('SELECT project_id FROM project_sources WHERE id = ?').get('ALPHA-SRC-001')).toMatchObject({ project_id: alpha.projectId });

      const betaFrozen = freezePacketAndCreateChangeset(db, packetFor(db, beta.projectId, 'BETA', betaSource, trustedRun(db, beta.projectId, betaSource), 'Agree the reporting cadence', 'Agree the reporting cadence with the finance workstream.'));
      expect(reviewAndApply(db, betaFrozen.changesetId)).toMatchObject({ appliedOperations: 2 });
      expect(db.prepare('SELECT project_id FROM project_sources WHERE id = ?').get('BETA-SRC-001')).toMatchObject({ project_id: beta.projectId });

      // No identifier is shared between the two projects.
      const ids = (db.prepare('SELECT project_id, external_register_id FROM project_register_rows ORDER BY project_id, external_register_id').all() as Array<{ project_id: string; external_register_id: string }>);
      expect(new Set(ids.map((row) => row.external_register_id)).size).toBe(ids.length);
      expect((db.prepare('SELECT count(*) count FROM project_register_rows WHERE project_id = ?').get(beta.projectId) as { count: number }).count).toBe(2);
    } finally {
      db.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
