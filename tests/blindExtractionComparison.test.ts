import { describe, expect, it } from 'vitest';
import { compareBenchmarkInformedExtraction } from '../src/blindExtractionComparison';

const frozen = (items: Array<Record<string, unknown>>) => ({
  contractVersion: 1,
  provider: 'synthetic-provider',
  model: 'synthetic-model',
  generatedAt: '2026-01-15T10:00:00.000Z',
  sourceMetadata: { sourceType: 'plain-text', contentHash: 'synthetic-hash', originalFileName: 'fictional-note.txt' },
  items,
});
const expected = (sheets: Record<string, unknown>) => ({ packet_type: 'project_register_benchmark_delta', packet_version: 1, project_code: 'FIC', sheets });

describe('benchmark-informed extraction comparison', () => {
  it('maps and measures all nine register categories', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'FIC-D-001', type: 'decision', title: 'Approve fictional route', status: 'Decided', anchor: 'seg-1' },
      { id: 'FIC-A-001', type: 'action', title: 'Confirm fictional owner', status: 'Open', anchor: 'seg-2' },
      { id: 'FIC-R-001', type: 'risk', title: 'Fictional evidence delay', status: 'Open', anchor: 'seg-3' },
      { id: 'FIC-C-001', type: 'config_change', title: 'Set fictional flag', status: 'Open', anchor: 'seg-4' },
      { id: 'FIC-Q-001', type: 'question', title: 'Who approves the fictional pack?', status: 'Open', anchor: 'seg-5' },
      { id: 'FIC-M-001', type: 'milestone', title: 'Fictional pack ready', status: 'Not started', anchor: 'seg-6' },
      { id: 'FIC-E-001', type: 'entity', title: 'Fictional delivery team', status: 'Current', anchor: 'seg-7' },
      { id: 'FIC-S-001', type: 'source', title: 'Fictional source note', status: 'Current', anchor: 'seg-8' },
      { id: 'FIC-U-001', type: 'uncertainty', title: 'Fictional timing unclear', status: 'Open', anchor: 'seg-9' },
    ]), expected({
      Decisions: [{ decision_id: 'FIC-D-001', decision: 'Approve fictional route', status: 'Decided', anchor: 'seg-1' }],
      Actions: [{ action_id: 'FIC-A-001', action: 'Confirm fictional owner', status: 'Open', anchor: 'seg-2' }],
      Risks_Issues: [{ raid_id: 'FIC-R-001', description: 'Fictional evidence delay', status: 'Open', anchor: 'seg-3' }],
      Config_Changes: [{ config_id: 'FIC-C-001', change: 'Set fictional flag', status: 'Open', anchor: 'seg-4' }],
      Open_Questions: [{ q_id: 'FIC-Q-001', question: 'Who approves the fictional pack?', status: 'Open', anchor: 'seg-5' }],
      Milestones: [{ milestone_id: 'FIC-M-001', item: 'Fictional pack ready', status: 'Not started', anchor: 'seg-6' }],
      Entities: [{ entity_id: 'FIC-E-001', name: 'Fictional delivery team', status: 'Current', anchor: 'seg-7' }],
      Sources: [{ source_id: 'FIC-S-001', filename: 'Fictional source note', status: 'Current', anchor: 'seg-8' }],
      Uncertainty: [{ u_id: 'FIC-U-001', item: 'Fictional timing unclear', status: 'Open', anchor: 'seg-9' }],
    }));
    expect(result.report.benchmarkMode).toBe('benchmark-informed');
    expect(result.report.registers).toHaveLength(9);
    expect(result.report.registers.every((row) => row.expectedRows === 1 && row.extractedRows === 1)).toBe(true);
    expect(result.report.totals).toEqual(expect.objectContaining({ registerRowRecall: 1, distinctFactRecall: 1 }));
    expect(result.markdown).toContain('Benchmark-Informed Extraction Comparison');
    expect(result.markdown).not.toMatch(/\bblind\b/i);
  });

  it('prefers canonical anchors and uses length-normalised Dice similarity', () => {
    const anchorResult = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'action', title: 'Shared fictional action', anchor: 'seg-2' },
      { id: 'X-2', type: 'action', title: 'Shared fictional action', anchor: 'seg-1' },
    ]), expected({ Actions: [
      { action_id: 'E-1', action: 'Shared fictional action', anchor: 'seg-1' },
      { action_id: 'E-2', action: 'Shared fictional action', anchor: 'seg-2' },
    ] }));
    const anchorMatches = anchorResult.report.registers.find((row) => row.registerName === 'Actions')!.matches;
    expect(anchorMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedId: 'E-1', extractedId: 'X-2', alignment: 'canonical-anchor' }),
      expect.objectContaining({ expectedId: 'E-2', extractedId: 'X-1', alignment: 'canonical-anchor' }),
    ]));

    const similarityResult = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-3', type: 'action', title: 'alpha beta gamma delta epsilon' }]),
      expected({ Actions: [{ action_id: 'E-3', action: 'alpha beta gamma' }] }),
    );
    expect(similarityResult.report.registers.find((row) => row.registerName === 'Actions')!.matches[0].score).toBe(0.75);
  });

  it('uses globally optimal assignment rather than greedy first-match selection', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'action', title: 'alpha beta' },
      { id: 'X-2', type: 'action', title: 'beta' },
    ]), expected({ Actions: [
      { action_id: 'E-1', action: 'alpha beta' },
      { action_id: 'E-2', action: 'alpha' },
    ] }));
    const actions = result.report.registers.find((row) => row.registerName === 'Actions')!;
    expect(actions.semanticMatches).toBe(2);
    expect(actions.missingItems).toEqual([]);
    expect(actions.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedId: 'E-1', extractedId: 'X-2' }),
      expect.objectContaining({ expectedId: 'E-2', extractedId: 'X-1' }),
    ]));
  });

  it('uses structured supersession and classifies material differences', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-SPLIT-1', type: 'action', title: 'Configure fictional gateway' },
      { id: 'X-SPLIT-2', type: 'action', title: 'Monitor fictional gateway' },
      { id: 'X-DUP-1', type: 'action', title: 'Publish fictional checklist', anchor: 'seg-dup' },
      { id: 'X-DUP-2', type: 'action', title: 'Publish fictional checklist', anchor: 'seg-dup' },
      { id: 'X-WRONG', type: 'action', title: 'Escalate fictional signal outage', anchor: 'seg-disagreement' },
    ]), expected({
      Actions: [
        { action_id: 'E-SPLIT', action: 'Configure and monitor fictional gateway' },
        { action_id: 'E-DUP', action: 'Publish fictional checklist', anchor: 'seg-dup' },
        { action_id: 'E-MISS', action: 'Prepare uncommon lantern charter' },
      ],
      Risks_Issues: [{ raid_id: 'E-RISK', description: 'Escalate fictional signal outage', anchor: 'seg-disagreement' }],
      Decisions: [
        { decision_id: 'E-NOT', decision: 'This is not a lexical supersession' },
        { decision_id: 'E-STRUCTURED', decision: 'Replace fictional option', supersedes: ['E-OLD'] },
      ],
    }));
    const actions = result.report.registers.find((row) => row.registerName === 'Actions')!;
    const risks = result.report.registers.find((row) => row.registerName === 'Risks_Issues')!;
    const decisions = result.report.registers.find((row) => row.registerName === 'Decisions')!;
    expect(actions.classifications.genuineMisses.map((item) => item.expectedId)).toContain('E-MISS');
    expect(actions.classifications.alternativeDecompositions.length).toBeGreaterThan(0);
    expect(actions.classifications.possibleDuplicates.length).toBeGreaterThan(0);
    expect(risks.classifications.benchmarkDisagreements.length).toBeGreaterThan(0);
    expect(decisions.missedStructuredSupersessions).toBe(1);
    expect(decisions.missedStateReversalsOrSupersessions).toBe(1);
    expect(result.report.totals).toEqual(expect.objectContaining({ registerRowRecall: expect.any(Number), distinctFactRecall: expect.any(Number) }));
  });
});
