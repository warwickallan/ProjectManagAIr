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
const actionsOf = (result: ReturnType<typeof compareBenchmarkInformedExtraction>) => result.report.registers.find((row) => row.registerName === 'Actions')!;
/** The real packet anchor shape: `anchorSchema` in src/sourceIntelligence.ts. */
const anchor = (segmentSeq: number) => [{ segment_seq: segmentSeq, speaker: null, t_ms: null, quote: null }];

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
    const anchorMatches = actionsOf(anchorResult).matches;
    expect(anchorMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedId: 'E-1', extractedId: 'X-2', alignment: 'canonical-anchor' }),
      expect.objectContaining({ expectedId: 'E-2', extractedId: 'X-1', alignment: 'canonical-anchor' }),
    ]));

    const similarityResult = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-3', type: 'action', title: 'alpha beta gamma delta epsilon' }]),
      expected({ Actions: [{ action_id: 'E-3', action: 'alpha beta gamma' }] }),
    );
    expect(actionsOf(similarityResult).matches[0].score).toBe(0.75);
  });

  it('uses globally optimal assignment rather than greedy first-match selection', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'action', title: 'Legacy permit register migration into the new workspace' },
      { id: 'X-2', type: 'action', title: 'Migrate the legacy permit register and archive the old workspace' },
    ]), expected({ Actions: [
      { action_id: 'E-1', action: 'Migrate the legacy permit register into the new workspace' },
      { action_id: 'E-2', action: 'Migrate the legacy permit register and archive the old workspace' },
    ] }));
    const actions = actionsOf(result);
    expect(actions.semanticMatches).toBe(2);
    expect(actions.missingItems).toEqual([]);
    expect(actions.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedId: 'E-1', extractedId: 'X-1' }),
      expect.objectContaining({ expectedId: 'E-2', extractedId: 'X-2' }),
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
    const actions = actionsOf(result);
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

describe('adversarial calibration: the harness cannot be fooled', () => {
  // A null extraction: fluent project language drawn from the same vocabulary as the benchmark
  // (permit, isolation, register, confirm, agree, workstream, cutover, migration) that contains
  // none of the benchmark's content. Every benchmark row here shares exactly ONE domain word with
  // one proposed row and nothing else, so under the old `semanticScore >= 0.22` predicate a perfect
  // 6-of-6 assignment existed and this packet scored registerRowRecall 1.000 with no missing items.
  const nullExtractionBenchmark = expected({
    Actions: [
      { action_id: 'E-1', action: 'Confirm the payroll cutover date with finance', status: 'open' },
      { action_id: 'E-2', action: 'Agree the isolation certificate wording with safety', status: 'open' },
      { action_id: 'E-3', action: 'Collate the contractor engineer names', status: 'open' },
      { action_id: 'E-4', action: 'Publish the permit training pack', status: 'open' },
      { action_id: 'E-5', action: 'Circulate the register of open questions', status: 'open' },
      { action_id: 'E-6', action: 'Agree the weekly migration cutover sequence', status: 'open' },
    ],
  });
  const nullExtractionItems = [
    { id: 'X-1', type: 'action', title: 'Update the payroll interface mapping' },
    { id: 'X-2', type: 'action', title: 'Review the isolation valve schedule' },
    { id: 'X-3', type: 'action', title: 'Draft the contractor induction slides' },
    { id: 'X-4', type: 'action', title: 'Schedule the permit workshop' },
    { id: 'X-5', type: 'action', title: 'Update the risk register' },
    { id: 'X-6', type: 'action', title: 'Review the migration runbook' },
    { id: 'X-7', type: 'action', title: 'Prepare the workstream reporting deck' },
    { id: 'X-8', type: 'action', title: 'Book the governance call slot' },
  ];

  it('scores a null extraction at zero recall, not one', () => {
    const result = compareBenchmarkInformedExtraction(frozen(nullExtractionItems), nullExtractionBenchmark);
    const actions = actionsOf(result);
    expect(actions.matches).toEqual([]);
    expect(actions.metrics.registerRowRecall).toBe(0);
    expect(actions.metrics.precision).toBe(0);
    expect(actions.missingItems).toHaveLength(6);
    expect(actions.additionalItems).toHaveLength(8);
    expect(result.report.totals.registerRowRecall).toBe(0);
    expect(result.report.totals.precision).toBe(0);
    // A handful of benchmark facts may share a stock phrase with the noise; nothing close to a pass.
    expect(result.report.totals.distinctFactRecall).toBeLessThan(0.2);
    expect(result.comparisonStatus).toBe('differences-found');
  });

  it('does not match on a single shared domain word', () => {
    const result = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Update payroll interface mapping' }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Confirm payroll cutover date with finance' }] }),
    );
    const actions = actionsOf(result);
    // The pair scores Dice 0.222 on one shared token: the exact case the old 0.22 threshold accepted.
    expect(actions.matches).toEqual([]);
    expect(actions.metrics.registerRowRecall).toBe(0);

    const second = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'decision', title: 'Agree the meeting cadence' }]),
      expected({ Decisions: [{ decision_id: 'E-1', decision: 'Agree suppression of duplicate records in the register' }] }),
    );
    expect(result.report.registers.find((row) => row.registerName === 'Decisions')!.matches).toEqual([]);
    expect(second.report.registers.find((row) => row.registerName === 'Decisions')!.matches).toEqual([]);
  });

  it('rejects an anchor collision that carries no semantic overlap', () => {
    const result = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Review supplier invoice coding in the finance ledger', anchors: anchor(7) }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Agree the isolation certificate wording with safety', anchors: anchor(7) }] }),
    );
    const actions = actionsOf(result);
    expect(actions.matches).toEqual([]);
    expect(actions.missingItems).toEqual(['E-1']);
    expect(actions.additionalItems).toEqual(['X-1']);
  });

  it('reads the segment_seq anchor shape and lets an anchor lower the bar without removing it', () => {
    const pair = (withAnchor: boolean) => compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Confirm the isolation permit list', ...(withAnchor ? { anchors: anchor(12) } : {}) }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Confirm the permit register update with the contractor', ...(withAnchor ? { anchors: anchor(12) } : {}) }] }),
    );
    // Dice 0.444 on two shared tokens: below the semantic bar on its own.
    expect(actionsOf(pair(false)).matches).toEqual([]);
    // With a shared segment_seq anchor the same pair clears the (lower) anchor-aligned floor.
    expect(actionsOf(pair(true)).matches).toEqual([expect.objectContaining({ expectedId: 'E-1', extractedId: 'X-1', alignment: 'canonical-anchor' })]);
  });

  it('does not recall a date fact from a single-digit field', () => {
    const result = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Confirm the shutdown window with the site team', priority: 1 }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Confirm the shutdown window with the site team', due_date: '2026-03-15', status: 'open' }] }),
    );
    const actions = actionsOf(result);
    // Two measurable benchmark facts: the action wording and the date. Only the wording is recalled.
    // Under `fact.includes(candidate)` the date was recalled by `priority: 1` and this read 1.000.
    expect(actions.expectedDistinctFacts).toBe(2);
    expect(actions.recalledDistinctFacts).toBe(1);
    expect(actions.metrics.distinctFactRecall).toBe(0.5);
  });

  it('deduplicates distinct facts globally, not per row', () => {
    const rows = ['Confirm the permit isolation register owner', 'Agree the payroll cutover sequencing', 'Issue the revised isolation certificate', 'Collate the contractor engineer names', 'Publish the permit training pack'];
    const result = compareBenchmarkInformedExtraction(frozen([]), expected({
      Actions: rows.map((action, index) => ({ action_id: `E-${index + 1}`, action, status: 'open', owner: 'Site Delivery Team' })),
    }));
    const actions = actionsOf(result);
    // Five distinct action statements plus one shared owner. `status: 'open'` is below the
    // measurability floor and is excluded from the denominator rather than counted five times.
    expect(actions.expectedDistinctFacts).toBe(6);
    expect(actions.recalledDistinctFacts).toBe(0);
    expect(actions.metrics.distinctFactRecall).toBe(0);
  });

  it('maximises match count rather than assignment weight', () => {
    // A5: benchmark {AAA anchored seg 4, BBB} vs proposed {X1 anchored seg 4, X2}.
    // AAA-X1 is acceptable only because of the shared anchor; AAA-X2 and BBB-X1 are both acceptable
    // semantically. The old `4*anchor + 2*id + semantic` objective preferred the single anchored
    // pair and reported one match; the lexicographic objective returns the maximum, two.
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'action', title: 'Isolation certificate register entries to be agreed with legal', anchors: anchor(4) },
      { id: 'X-2', type: 'action', title: 'Isolation certificate wording to be agreed with safety' },
    ]), expected({ Actions: [
      { action_id: 'E-AAA', action: 'Agree isolation certificate wording with safety', anchors: anchor(4) },
      { action_id: 'E-BBB', action: 'Agree isolation certificate register entries with the legal team' },
    ] }));
    const actions = actionsOf(result);
    expect(actions.matches).toHaveLength(2);
    expect(actions.matches.map((match) => `${match.expectedId}->${match.extractedId}`).sort()).toEqual(['E-AAA->X-2', 'E-BBB->X-1']);
    expect(actions.metrics.registerRowRecall).toBe(1);
    expect(actions.missingItems).toEqual([]);
  });

  it('returns a maximal matching on a larger overlapping register', () => {
    // Every benchmark row here has at least one acceptable partner; a maximum matching is 4.
    const titles = [
      ['Agree the isolation certificate wording with safety', 'Isolation certificate wording to be agreed with safety'],
      ['Migrate the legacy permit register into the new workspace', 'Legacy permit register migration into the new workspace'],
      ['Confirm payroll cutover date with finance', 'Confirm the payroll cutover date with the finance team'],
      ['Publish the permit training pack to the site team', 'Permit training pack to be published to the site team'],
    ];
    const result = compareBenchmarkInformedExtraction(
      frozen(titles.map(([, proposed], index) => ({ id: `X-${index + 1}`, type: 'action', title: proposed, anchors: anchor(1) }))),
      expected({ Actions: titles.map(([benchmark], index) => ({ action_id: `E-${index + 1}`, action: benchmark, anchors: anchor(1) })) }),
    );
    const actions = actionsOf(result);
    expect(actions.matches).toHaveLength(4);
    // Every row is paired with its own paraphrase despite all four sharing one anchor.
    expect(actions.matches.map((match) => `${match.expectedId}->${match.extractedId}`).sort()).toEqual(['E-1->X-1', 'E-2->X-2', 'E-3->X-3', 'E-4->X-4']);
  });

  it('still scores a genuinely correct but paraphrased extraction highly', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'action', title: 'Isolation certificate wording to be agreed with safety', summary: 'Safety to sign off the isolation certificate wording.', owner: 'Dale Winters', due_date: '2026-03-15', anchors: anchor(3) },
      { id: 'X-2', type: 'action', title: 'Legacy permit register migration into the new workspace', summary: 'Move the legacy permit register into the new workspace.', owner: 'Priya Raman', anchors: anchor(5) },
      { id: 'X-3', type: 'action', title: 'Confirm the payroll cutover date with the finance team', summary: 'Finance to confirm the payroll cutover date.', owner: 'Dale Winters', anchors: anchor(8) },
      { id: 'X-4', type: 'action', title: 'Compile the list of contractor companies and engineers for supplier setup', summary: 'List of contractor companies and engineers needed for supplier setup.', owner: 'Priya Raman', anchors: anchor(11) },
      { id: 'X-5', type: 'decision', title: 'The permit authoriser sets the PPE and method requirements', summary: 'Authoriser confirms PPE and method requirements on each permit.', anchors: anchor(14) },
    ]), expected({
      Actions: [
        { action_id: 'E-1', action: 'Agree isolation certificate wording with safety', owner: 'Dale Winters', due_date: '2026-03-15', status: 'open', anchors: anchor(3) },
        { action_id: 'E-2', action: 'Migrate the legacy permit register into the new workspace', owner: 'Priya Raman', status: 'open', anchors: anchor(5) },
        { action_id: 'E-3', action: 'Confirm payroll cutover date with finance', owner: 'Dale Winters', status: 'open', anchors: anchor(8) },
        { action_id: 'E-4', action: 'Collate contractor company names plus engineer list for supplier setup', owner: 'Priya Raman', status: 'open', anchors: anchor(11) },
      ],
      Decisions: [
        { decision_id: 'E-5', decision: 'Permit authoriser determines PPE and method controls', status: 'agreed', anchors: anchor(14) },
      ],
    }));
    const actions = actionsOf(result);
    const decisions = result.report.registers.find((row) => row.registerName === 'Decisions')!;
    expect(actions.matches).toHaveLength(4);
    expect(actions.metrics.registerRowRecall).toBe(1);
    expect(actions.metrics.precision).toBe(1);
    expect(decisions.metrics.registerRowRecall).toBe(1);
    expect(result.report.totals.registerRowRecall).toBe(1);
    // A21 is stated as >= 70% fact-level recall; a correct paraphrased extraction must clear it.
    expect(result.report.totals.distinctFactRecall).toBeGreaterThanOrEqual(0.7);
  });

  it('detects a supersession link dropped by a matched row', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'decision', title: 'Replace the fictional routing option with the direct route', summary: 'The fictional routing option is replaced by the direct route.' },
    ]), expected({
      Decisions: [
        { decision_id: 'E-1', decision: 'Replace the fictional routing option with the direct route', supersedes: ['E-OLD'], status: 'agreed' },
      ],
    }));
    const decisions = result.report.registers.find((row) => row.registerName === 'Decisions')!;
    // The row IS matched — this is the case the old `missingIndexes.filter(...)` could never see.
    expect(decisions.matches).toHaveLength(1);
    expect(decisions.metrics.registerRowRecall).toBe(1);
    expect(decisions.missedStructuredSupersessions).toBe(1);
    expect(decisions.missedStructuredSupersessionIds).toEqual(['E-1']);

    const carried = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'decision', title: 'Replace the fictional routing option with the direct route', supersedes: ['E-OLD'] },
    ]), expected({
      Decisions: [{ decision_id: 'E-1', decision: 'Replace the fictional routing option with the direct route', supersedes: ['E-OLD'], status: 'agreed' }],
    }));
    expect(carried.report.registers.find((row) => row.registerName === 'Decisions')!.missedStructuredSupersessions).toBe(0);
  });

  it('reports supersession and state reversal as two separate measurements', () => {
    const result = compareBenchmarkInformedExtraction(frozen([
      { id: 'X-1', type: 'decision', title: 'Withdraw the fictional weekend working allowance', status: 'agreed' },
    ]), expected({
      Decisions: [{ decision_id: 'E-1', decision: 'Withdraw the fictional weekend working allowance', status: 'withdrawn' }],
    }));
    const decisions = result.report.registers.find((row) => row.registerName === 'Decisions')!;
    expect(decisions.matches).toHaveLength(1);
    expect(decisions.missedStructuredSupersessions).toBe(0);
    expect(decisions.missedStateReversalsOrSupersessions).toBe(1);
  });

  it('reports an empty register honestly instead of 1.000', () => {
    const result = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Agree isolation certificate wording with safety' }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Isolation certificate wording to be agreed with safety' }] }),
    );
    const milestones = result.report.registers.find((row) => row.registerName === 'Milestones')!;
    expect(milestones.applicable).toBe(false);
    expect(milestones.metrics).toEqual({ precision: null, registerRowRecall: null, distinctFactRecall: null });
    expect(milestones.precisionApplicable).toBe(false);
    expect(milestones.rowRecallApplicable).toBe(false);
    expect(milestones.factRecallApplicable).toBe(false);
    // Legacy numeric fields stay numbers for the Cockpit table; 0 means "not measurable".
    expect(milestones.precision).toBe(0);
    expect(milestones.recall).toBe(0);
    expect(milestones.distinctFactRecall).toBe(0);
    expect(result.markdown).toContain('| Milestones | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a | n/a |');
    expect(result.markdown).not.toMatch(/\| Milestones \|.*1\.000/);

    // A register with benchmark rows but nothing proposed has no precision, but does have recall.
    const oneSided = compareBenchmarkInformedExtraction(frozen([]), expected({ Actions: [{ action_id: 'E-1', action: 'Agree isolation certificate wording with safety' }] }));
    const actions = actionsOf(oneSided);
    expect(actions.applicable).toBe(true);
    expect(actions.metrics.precision).toBeNull();
    expect(actions.metrics.registerRowRecall).toBe(0);
    expect(oneSided.report.totals.metrics.precision).toBeNull();
  });

  it('reports fact recall and register row recall as separate fields', () => {
    const result = compareBenchmarkInformedExtraction(
      frozen([{ id: 'X-1', type: 'action', title: 'Agree isolation certificate wording with safety' }]),
      expected({ Actions: [{ action_id: 'E-1', action: 'Isolation certificate wording to be agreed with safety', owner: 'Dale Winters' }] }),
    );
    const actions = actionsOf(result);
    expect(actions.metrics.registerRowRecall).toBe(1);
    // The owner fact was not extracted, so fact recall is strictly below row recall.
    expect(actions.metrics.distinctFactRecall).toBeLessThan(1);
    expect(result.report.totals.registerRowRecall).not.toBe(result.report.totals.distinctFactRecall);
    expect(result.report.totals).toEqual(expect.objectContaining({ recall: expect.any(Number), registerRowRecall: expect.any(Number), distinctFactRecall: expect.any(Number) }));
  });
});
