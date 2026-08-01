/**
 * Regression tests for the deterministic review pack.
 *
 * Every fixture here is synthetic. The defects being pinned were found against
 * a real customer register, but no customer content enters Git: each case is
 * reproduced with invented names, ids and wording that exercise the same
 * structural shape.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_MEETING_ITEMS,
  buildReviewPack,
  evidenceStrength,
  isSettledDecision,
  ownerParts,
  reconcileQuestion,
  renderReviewPack,
  resolveOwnership,
  type ReviewPackInput,
  type ReviewPackRecord,
} from '../src/reviewPack.js';

const CONSULTANT_ALIASES = ['Dana', 'Dana Whitfield'];

function record(overrides: Partial<ReviewPackRecord> & { id: string }): ReviewPackRecord {
  return {
    registerName: 'Actions',
    title: `Record ${overrides.id}`,
    summary: '',
    status: 'open',
    owner: null,
    dueDate: null,
    overdue: false,
    blocking: false,
    conflict: false,
    severity: null,
    band: 'Soon',
    score: 10,
    themeLabel: null,
    relatedIds: [],
    anchors: [],
    selected: true,
    ...overrides,
  };
}

function input(records: ReviewPackRecord[]): ReviewPackInput {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    changesetId: 'changeset:test:0001',
    isolatedDbPath: '/tmp/isolated.db',
    sourceDbPath: '/tmp/source.db',
    sourceLabel: 'Synthetic_Session.vtt',
    sourceEventDate: '2026-01-01',
    consultantAliases: CONSULTANT_ALIASES,
    records,
    providerCalls: 0,
  };
}

const anchored = [
  { segmentSeq: 10, speaker: 'Dana Whitfield', tMs: 1000, quote: 'we agreed the supplier list lands next week', verified: true, context: 'we agreed the supplier list lands next week and it will be sent to the team by Friday at the latest' },
];

describe('owner resolution', () => {
  it('splits a multi-owner prose string into the people it names', () => {
    expect(ownerParts('Ravi/Priya obtain; Dana configure')).toEqual(['ravi', 'priya', 'dana']);
  });

  it('treats a full name as the consultant when the alias is the first name', () => {
    // The defect this pins: the project stored owner "Dana", the register wrote
    // "Dana Whitfield", exact matching failed, and the consultant's own
    // implementation work was reported as a customer dependency.
    expect(resolveOwnership('Dana Whitfield', CONSULTANT_ALIASES)).toBe('consultant');
    expect(resolveOwnership('Dana (proposed)', CONSULTANT_ALIASES)).toBe('consultant');
    expect(resolveOwnership('Dana (send); Ravi and Priya (distribute)', CONSULTANT_ALIASES)).toBe('shared');
  });

  it('classifies external people as customer and placeholders as unowned', () => {
    expect(resolveOwnership('Ravi Chandra', CONSULTANT_ALIASES)).toBe('customer');
    expect(resolveOwnership('Escalated: Ravi / Priya / senior sponsor', CONSULTANT_ALIASES)).toBe('customer');
    expect(resolveOwnership(null, CONSULTANT_ALIASES)).toBe('unowned');
    expect(resolveOwnership('unassigned', CONSULTANT_ALIASES)).toBe('unowned');
    expect(resolveOwnership('accepted constraint', CONSULTANT_ALIASES)).toBe('unowned');
  });
});

describe('decision settlement', () => {
  it('does not treat a qualified agreement as settled', () => {
    expect(isSettledDecision(record({ id: 'X-D-1', registerName: 'Decisions', status: 'agreed' }))).toBe(true);
    expect(isSettledDecision(record({ id: 'X-D-2', registerName: 'Decisions', status: 'agreed - structure pending' }))).toBe(false);
    expect(isSettledDecision(record({ id: 'X-D-3', registerName: 'Decisions', status: 'agreed in principle' }))).toBe(false);
    expect(isSettledDecision(record({ id: 'X-D-4', registerName: 'Decisions', status: 'working assumption' }))).toBe(false);
    expect(isSettledDecision(record({ id: 'X-D-5', registerName: 'Decisions', status: 'retained - confirm final state' }))).toBe(false);
  });
});

describe('question reconciliation', () => {
  const settled = record({ id: 'X-D-1', registerName: 'Decisions', status: 'agreed', relatedIds: ['X-Q-1'] });
  const unsettled = record({ id: 'X-D-2', registerName: 'Decisions', status: 'parked', relatedIds: ['X-Q-2'] });

  it('marks a question answered when a settled decision points at it', () => {
    const question = record({ id: 'X-Q-1', registerName: 'Open_Questions' });
    const byId = new Map([settled, question].map((row) => [row.id, row]));
    const result = reconcileQuestion(question, byId);
    expect(result.state).toBe('answered');
    expect(result.by).toEqual(['X-D-1']);
  });

  it('marks a question answered when the question points at a settled decision', () => {
    const question = record({ id: 'X-Q-3', registerName: 'Open_Questions', relatedIds: ['X-D-1'] });
    const byId = new Map([settled, question].map((row) => [row.id, row]));
    expect(reconcileQuestion(question, byId).state).toBe('answered');
  });

  it('does not treat an unsettled decision as an answer', () => {
    const question = record({ id: 'X-Q-2', registerName: 'Open_Questions' });
    const byId = new Map([unsettled, question].map((row) => [row.id, row]));
    expect(reconcileQuestion(question, byId).state).not.toBe('answered');
  });

  it('routes a question that is explicitly waiting on something', () => {
    const action = record({ id: 'X-A-9' });
    const question = record({ id: 'X-Q-4', registerName: 'Open_Questions', unblockedBy: 'X-A-9 investigation' });
    const byId = new Map([action, question].map((row) => [row.id, row]));
    const result = reconcileQuestion(question, byId);
    expect(result.state).toBe('routed');
    expect(result.by).toEqual(['X-A-9']);
  });

  it('asks a question that nothing answers and nothing unblocks', () => {
    const question = record({ id: 'X-Q-5', registerName: 'Open_Questions' });
    expect(reconcileQuestion(question, new Map([[question.id, question]])).state).toBe('ask');
  });
});

describe('evidence strength', () => {
  it('calls an unanchored record unanchored', () => {
    expect(evidenceStrength(record({ id: 'X-A-1' }))).toBe('unanchored');
  });

  it('calls an unverified quote fragmentary', () => {
    expect(evidenceStrength(record({
      id: 'X-A-2',
      anchors: [{ segmentSeq: 1, speaker: 'Ravi', tMs: 0, quote: 'maybe next week or so, hard to say', verified: false, context: null }],
    }))).toBe('fragmentary');
  });

  it('calls a single short verified fragment fragmentary, not settled fact', () => {
    expect(evidenceStrength(record({
      id: 'X-A-3',
      anchors: [{ segmentSeq: 1, speaker: 'Ravi', tMs: 0, quote: 'yeah maybe', verified: true, context: null }],
    }))).toBe('fragmentary');
  });

  it('calls a substantive verified quote anchored', () => {
    expect(evidenceStrength(record({ id: 'X-A-4', anchors: anchored }))).toBe('anchored');
  });
});

describe('sectioning', () => {
  it('puts consultant-owned work under the consultant, never under customer dependencies', () => {
    const built = buildReviewPack(input([
      record({ id: 'X-A-1', owner: 'Dana Whitfield', anchors: anchored }),
      record({ id: 'X-A-2', owner: 'Ravi Chandra', anchors: anchored }),
    ]));
    expect(built.byId.get('X-A-1')!.section).toBe('warwick-actions');
    expect(built.byId.get('X-A-2')!.section).toBe('customer-dependencies');
  });

  it('keeps risks, questions and milestones out of customer dependencies', () => {
    const built = buildReviewPack(input([
      record({ id: 'X-R-1', registerName: 'Risks_Issues', owner: 'Ravi Chandra' }),
      record({ id: 'X-Q-1', registerName: 'Open_Questions', owner: 'Ravi Chandra' }),
      record({ id: 'X-M-1', registerName: 'Milestones', owner: 'Ravi Chandra' }),
    ]));
    const dependencies = built.bySection.get('customer-dependencies') ?? [];
    expect(dependencies).toHaveLength(0);
    expect(built.byId.get('X-R-1')!.section).toBe('risks-monitored');
    expect(built.byId.get('X-M-1')!.section).toBe('milestones');
  });

  it('gives every record exactly one primary section', () => {
    const built = buildReviewPack(input([
      record({ id: 'X-A-1', owner: 'Ravi Chandra', overdue: true, dueDate: '2020-01-01', blocking: true }),
      record({ id: 'X-D-1', registerName: 'Decisions', status: 'parked' }),
      record({ id: 'X-Q-1', registerName: 'Open_Questions' }),
    ]));
    const seen = [...built.bySection.values()].flat().map((entry) => entry.record.id);
    expect(seen).toHaveLength(new Set(seen).size);
    // A blocking customer action is a blocker first, not a dependency twice.
    expect(built.byId.get('X-A-1')!.section).toBe('safety-and-blockers');
  });

  it('labels unowned work as needing an ownership decision rather than attributing it', () => {
    const built = buildReviewPack(input([record({ id: 'X-A-1', owner: null })]));
    expect(built.byId.get('X-A-1')!.ownership).toBe('unowned');
    expect(built.byId.get('X-A-1')!.section).toBe('warwick-actions');
    expect(renderReviewPack(input([record({ id: 'X-A-1', owner: null })]))).toContain('Warwick to assign/resolve ownership');
  });
});

describe('the opening brief', () => {
  it('never exceeds ten items', () => {
    const many = Array.from({ length: 30 }, (_, index) => record({
      id: `X-A-${String(index).padStart(2, '0')}`,
      blocking: true,
      score: index,
      anchors: anchored,
    }));
    const built = buildReviewPack(input(many));
    expect(built.topTen).toHaveLength(MAX_MEETING_ITEMS);
  });

  it('ranks safety above an ordinary overdue item', () => {
    const built = buildReviewPack(input([
      record({ id: 'X-A-1', overdue: true, dueDate: '2020-01-01', score: 99 }),
      record({ id: 'X-R-1', registerName: 'Risks_Issues', severity: 'safety-relevant', score: 1 }),
    ]));
    expect(built.topTen[0].record.id).toBe('X-R-1');
  });

  it('excludes answered questions and settled decisions from the opening brief', () => {
    const settled = record({ id: 'X-D-1', registerName: 'Decisions', status: 'agreed', relatedIds: ['X-Q-1'], score: 500 });
    const answered = record({ id: 'X-Q-1', registerName: 'Open_Questions', score: 500 });
    const built = buildReviewPack(input([settled, answered]));
    const ids = built.topTen.map((entry) => entry.record.id);
    expect(ids).not.toContain('X-Q-1');
    expect(ids).not.toContain('X-D-1');
  });
});

describe('honest presentation', () => {
  it('qualifies an overdue date rather than asserting it as current', () => {
    const markdown = renderReviewPack(input([record({ id: 'X-A-1', owner: 'Ravi Chandra', dueDate: '2020-01-01', overdue: true, anchors: anchored })]));
    expect(markdown).toContain('confirm current status');
    expect(markdown).toContain('last processed source');
  });

  it('labels an unanchored record as requiring confirmation', () => {
    const markdown = renderReviewPack(input([record({ id: 'X-A-1', owner: 'Ravi Chandra' })]));
    expect(markdown).toContain('requires confirmation');
  });

  it('does not present an answered question in the questions-to-ask section', () => {
    const markdown = renderReviewPack(input([
      record({ id: 'X-D-1', registerName: 'Decisions', status: 'agreed', relatedIds: ['X-Q-1'] }),
      record({ id: 'X-Q-1', registerName: 'Open_Questions', title: 'Already resolved question' }),
    ]));
    const askSection = markdown.slice(markdown.indexOf('## Questions to ask'), markdown.indexOf('## Questions already routed'));
    expect(askSection).not.toContain('Already resolved question');
    expect(markdown).toContain('already answered');
  });

  it('uses the widened context excerpt when one is available', () => {
    const markdown = renderReviewPack(input([record({ id: 'X-A-1', owner: 'Ravi Chandra', anchors: anchored })]));
    expect(markdown).toContain('sent to the team by Friday at the latest');
  });

  it('keeps the detailed appendix and states the zero-call guarantee', () => {
    const markdown = renderReviewPack(input([record({ id: 'X-A-1', anchors: anchored })]));
    expect(markdown).toContain('Appendix — full register and source evidence');
    expect(markdown).toContain('0 model or provider calls');
  });

  it('renders deterministically', () => {
    const records = [
      record({ id: 'X-A-1', owner: 'Dana Whitfield', anchors: anchored }),
      record({ id: 'X-R-1', registerName: 'Risks_Issues', severity: 'safety-relevant' }),
    ];
    expect(renderReviewPack(input(records))).toBe(renderReviewPack(input(records)));
  });
});

describe('headline semantics', () => {
  it('does not call an overdue customer-owned milestone a dependency', () => {
    const built = buildReviewPack(input([
      record({ id: 'X-M-1', registerName: 'Milestones', owner: 'Ravi Chandra', overdue: true, dueDate: '2020-01-01' }),
      record({ id: 'X-A-1', registerName: 'Actions', owner: 'Ravi Chandra', overdue: true, dueDate: '2020-01-01' }),
    ]));
    expect(built.byId.get('X-M-1')!.headline).toContain('overdue, customer-owned');
    expect(built.byId.get('X-M-1')!.headline).not.toContain('dependency');
    expect(built.byId.get('X-A-1')!.headline).toContain('overdue customer dependency');
  });
});
