import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { orchestrateSourceExtraction } from '../src/sourcePipeline';
import { FakeStructuredExtractionProvider } from '../src/extractionProvider';

/**
 * Deviations from the approved design introduced so that one malformed or
 * duplicated row cannot discard an entire multi-call extraction.
 *
 * Both are LOSSY, never repairing: the affected rows are excluded, counted, and
 * reported in the packet's validation report. Neither relaxes what the register
 * will accept.
 */
async function fixture(code: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-tolerance-'));
  const root = path.join(dir, 'Projects');
  mkdirSync(root, { recursive: true });
  const context = openProjectManagairDatabase(path.join(dir, 't.db'));
  await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
  await verifyStorageRoot(context.db, true);
  const project = createProject(context.db, { code, name: 'Merge Tolerance', customer: 'Fictional', description: 'synthetic', status: 'active', owner: 'Casey' });
  const lines = ['WEBVTT', 'NOTE Recorded: 2026-07-10', ''];
  for (let index = 0; index < 400; index += 1) {
    const minute = String(Math.floor(index / 12) % 60).padStart(2, '0');
    const second = String((index * 5) % 60).padStart(2, '0');
    lines.push(`00:${minute}:${second}.000 --> 00:${minute}:${second}.500`, `<v Casey Morgan>Reviewing workstream ${index}, the migration approach, the retention window, the reporting cadence and the permit routing all remain broadly as previously described for this delivery.</v>`, '');
  }
  const intake = await intakeProjectSource(context.db, project.projectId, { name: `${code}-session.vtt`, dataBase64: Buffer.from(lines.join('\n')).toString('base64') });
  return { dir, context, db: context.db, project, sourceId: String(intake.sourceId) };
}

describe('provider response tolerance is lossy, recorded and bounded', () => {
  it('excludes both variants of a conflicting client_ref, records it, and keeps the rest of the pass', async () => {
    const f = await fixture('MERGE');
    try {
      const segments = f.db.prepare('SELECT seq FROM source_segments WHERE source_id = ? ORDER BY seq').all(f.sourceId) as Array<{ seq: number }>;
      const provider = new FakeStructuredExtractionProvider((request) => {
        const first = request.callIndex;
        const mk = (ref: string, seq: number, title: string) => ({
          registerName: 'Actions' as const,
          row: { client_ref: ref, op: 'add' as const, target_id: null, proposed_id: '$ALLOC', title, summary: `${title} with the platform team.`, status: null, record_type: null, owner: 'Casey Morgan', due_date_raw: null, source_ref: f.sourceId, related_refs: [], supersedes: [], anchors: [{ segment_seq: seq, speaker: null, t_ms: null, quote: `I will confirm the release route for workstream ${seq - 1} with the platform team.` }], derivation: 'fact' as const, reasoning: null, confidence: 'high' as const, discharges_markers: [], details: {} },
        });
        // The same client_ref is emitted by both calls with DIFFERENT content.
        const rows = [mk('shared-ref', segments[0].seq, `Confirm the release route variant ${first}`)];
        for (const segment of request.windows.flatMap((w) => w.segments).slice(0, 4)) rows.push(mk(`Actions-${segment.seq}`, Number(segment.seq), `Confirm the release route for workstream ${Number(segment.seq) - 1}`));
        return { usage: { inputTokens: 100, outputTokens: 40, sourceTokens: request.windows.reduce((t, w) => t + w.tokenEstimate, 0) }, output: {
          rows,
          windowCoverage: request.windows.map((w) => ({ key: String(w.seq), status: 'reviewed' as const, itemCount: rows.filter((r) => r.row.anchors[0].segment_seq >= w.startSeq && r.row.anchors[0].segment_seq <= w.endSeq).length, explanation: 'synthetic' })),
          categoryCoverage: ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'].map((key) => ({ key, status: key === 'Actions' ? 'populated' as const : 'none-found' as const, itemCount: 0, explanation: 'synthetic' })),
        } };
      });
      const result = await orchestrateSourceExtraction(f.db, { sourceId: f.sourceId, provider }) as { mergeConflicts: Array<{ clientRef: string; reason: string }> };
      // The conflicting reference is gone from the packet entirely (it survives
      // only in the recorded reason, which is the point).
      const frozen = (f.db.prepare('SELECT packet_json FROM extraction_packets').get() as { packet_json: string }).packet_json;
      expect(frozen).not.toContain('"client_ref":"shared-ref"');
      expect(frozen).toContain('"client_ref":"Actions-');
      // ...and its exclusion is recorded, not silent.
      expect(result.mergeConflicts).toEqual([{ clientRef: 'shared-ref', reason: expect.stringContaining('neither can be preferred') }]);
      const report = JSON.parse(String((f.db.prepare('SELECT validation_report_json FROM extraction_packets').get() as { validation_report_json: string }).validation_report_json)) as { issues: Array<{ rule: string; message: string }>; providerAnomalies: unknown[] };
      expect(report.issues.some((issue) => issue.rule === 'provider-merge-conflict' && issue.message.includes('shared-ref'))).toBe(true);
      expect(report.providerAnomalies).not.toHaveLength(0);
      // A packet that lost rows is never reported as clean.
      expect((f.db.prepare('SELECT validation_status FROM extraction_packets').get() as { validation_status: string }).validation_status).not.toBe('clean');
    } finally {
      f.db.close();
      if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same conflicting output yields the same exclusions every time', async () => {
    const runs = [] as string[];
    for (const code of ['DETA', 'DETB']) {
      const f = await fixture(code);
      try {
        const segments = f.db.prepare('SELECT seq FROM source_segments WHERE source_id = ? ORDER BY seq').all(f.sourceId) as Array<{ seq: number }>;
        const provider = new FakeStructuredExtractionProvider((request) => {
          const first = request.callIndex;
          const mk = (ref: string, seq: number, title: string) => ({ registerName: 'Actions' as const, row: { client_ref: ref, op: 'add' as const, target_id: null, proposed_id: '$ALLOC', title, summary: `${title} with the platform team.`, status: null, record_type: null, owner: 'Casey Morgan', due_date_raw: null, source_ref: f.sourceId, related_refs: [], supersedes: [], anchors: [{ segment_seq: seq, speaker: null, t_ms: null, quote: `I will confirm the release route for workstream ${seq - 1} with the platform team.` }], derivation: 'fact' as const, reasoning: null, confidence: 'high' as const, discharges_markers: [], details: {} } });
          const rows = [mk('shared-ref', segments[0].seq, `Confirm the release route variant ${first}`)];
          for (const segment of request.windows.flatMap((w) => w.segments).slice(0, 4)) rows.push(mk(`Actions-${segment.seq}`, Number(segment.seq), `Confirm the release route for workstream ${Number(segment.seq) - 1}`));
          return { usage: { inputTokens: 100, outputTokens: 40, sourceTokens: request.windows.reduce((t, w) => t + w.tokenEstimate, 0) }, output: { rows, windowCoverage: request.windows.map((w) => ({ key: String(w.seq), status: 'reviewed' as const, itemCount: rows.filter((r) => r.row.anchors[0].segment_seq >= w.startSeq && r.row.anchors[0].segment_seq <= w.endSeq).length, explanation: 'synthetic' })), categoryCoverage: ['Decisions', 'Actions', 'Risks_Issues', 'Config_Changes', 'Open_Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty'].map((key) => ({ key, status: key === 'Actions' ? 'populated' as const : 'none-found' as const, itemCount: 0, explanation: 'synthetic' })) } };
        });
        const result = await orchestrateSourceExtraction(f.db, { sourceId: f.sourceId, provider }) as { mergeConflicts: unknown };
        runs.push(JSON.stringify(result.mergeConflicts));
      } finally {
        f.db.close();
        if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
      }
    }
    expect(runs[0]).toBe(runs[1]);
  });
});
