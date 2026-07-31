import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import { FakeStructuredExtractionProvider, SOURCE_INTELLIGENCE_CATEGORIES, type SourcePacketRow } from '../src/extractionProvider';
import { createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import { orchestrateSourceExtraction } from '../src/sourcePipeline';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function addRow(sourceId: string, segmentSeq: number, quote: string, title: string, recordType: string): SourcePacketRow {
  return {
    client_ref: `${recordType}-${segmentSeq}`,
    op: 'add',
    target_id: null,
    proposed_id: '$ALLOC',
    title,
    summary: title,
    status: 'open',
    record_type: recordType,
    owner: null,
    due_date_raw: null,
    source_ref: sourceId,
    related_refs: [],
    supersedes: [],
    anchors: [{ segment_seq: segmentSeq, speaker: null, t_ms: null, quote }],
    derivation: 'fact',
    reasoning: null,
    confidence: 'high',
    discharges_markers: [],
    details: recordType === 'source' ? { source_type: 'text-note' } : {},
  };
}

describe('Source Intelligence extraction orchestration', () => {
  it('records trusted telemetry and hands a complete frozen packet to the deterministic changeset path', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'projectmanagair-pipeline-'));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, 'pipeline.db');
    const projectsRoot = path.join(directory, 'Projects');
    mkdirSync(projectsRoot, { recursive: true });
    const context = openProjectManagairDatabase(dbPath);
    try {
      await updateStorageSettings(context.db, { projectsRoot });
      const project = createProject(context.db, {
        code: 'SYN',
        name: 'Synthetic Pipeline',
        customer: 'Synthetic Customer',
        description: 'Synthetic Source Intelligence fixture.',
        status: 'on-track',
        owner: 'Tester',
      });
      const sourceText = 'Follow up with the synthetic owner.';
      const intake = await intakeProjectSource(context.db, project.projectId, {
        name: 'synthetic-note.txt',
        dataBase64: Buffer.from(sourceText, 'utf8').toString('base64'),
      }) as unknown as { sourceId: string };
      const intakeRow = context.db.prepare('SELECT intake_source_id FROM source_documents WHERE id = ?').get(intake.sourceId) as { intake_source_id: string };
      context.db.prepare(`INSERT INTO source_processing_jobs
        (id, source_id, project_id, provider, status, started_at, completed_at, error_message, structured_output_contract, proposed_change_id, current_stage, attempt_count, max_attempts, queued_at, updated_at, packet_id, changeset_id)
        VALUES ('legacy-job', ?, ?, 'legacy-provider', 'awaiting_review', '2026-01-01T00:00:00.000Z', NULL, NULL, 'legacy-contract', 'legacy-proposal', 'awaiting_review', 0, 2, NULL, '2026-01-01T00:00:00.000Z', NULL, NULL)`)
        .run(intakeRow.intake_source_id, project.projectId);
      const provider = new FakeStructuredExtractionProvider((request) => ({
        output: {
          rows: [
            { registerName: 'Actions', row: addRow(request.source.sourceId, 1, sourceText, 'Follow up with the synthetic owner', 'action') },
            { registerName: 'Sources', row: addRow(request.source.sourceId, 1, sourceText, 'Synthetic source note', 'source') },
          ],
          windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'populated', itemCount: 2, explanation: null })),
          categoryCoverage: request.categories.map((key) => ({
            key,
            status: key === 'Actions' || key === 'Sources' ? 'populated' : 'none-found',
            itemCount: key === 'Actions' || key === 'Sources' ? 1 : 0,
            explanation: key === 'Actions' || key === 'Sources' ? null : `No ${key} found in the synthetic source.`,
          })),
        },
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
        },
      }));

      const result = await orchestrateSourceExtraction(context.db, { sourceId: intake.sourceId, provider });
      expect(result.gateVerdict).toBe('clean');
      expect(result.calls).toBe(1);
      expect(result.provider.providerId).toBe('fake-structured-provider');
      const run = context.db.prepare('SELECT provider_id, model_label, status, output_sha256 FROM extraction_runs WHERE id = ?').get(result.runs[0]) as Record<string, unknown>;
      expect(run).toMatchObject({
        provider_id: 'fake-structured-provider',
        model_label: 'synthetic-test-output-v1',
        status: 'completed',
      });
      expect(String(run.output_sha256)).toMatch(/^[a-f0-9]{64}$/);
      const changeset = context.db.prepare('SELECT review_status, gate_verdict FROM register_changesets WHERE id = ?').get(result.changesetId) as Record<string, unknown>;
      expect(changeset).toMatchObject({ review_status: 'pending', gate_verdict: 'clean' });
      expect(SOURCE_INTELLIGENCE_CATEGORIES).toHaveLength(9);
      const legacyJob = context.db.prepare('SELECT status, current_stage, error_message, packet_id, changeset_id FROM source_processing_jobs WHERE id = ?').get('legacy-job');
      expect(legacyJob).toMatchObject({ status: 'awaiting_review', current_stage: 'awaiting_review', error_message: null, packet_id: null, changeset_id: null });
    } finally {
      context.db.close();
    }
  });
});
