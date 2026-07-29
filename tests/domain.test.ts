import fixtureJson from '../fixtures/portfolio.json';
import { buildPortfolioResponse, buildProjectResponse, deriveAttentionItems, formatAttentionLabel, getFreshness, portfolioFixtureSchema, type Project } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);
const atlas = fixture.projects[0];
const beacon = fixture.projects[1];

function emptyProject(project = atlas): Project {
  return {
    ...structuredClone(project),
    actions: [], risksIssues: [], decisions: [], openQuestions: [], milestones: [], workPackages: [], aiWork: [], activity: [],
  };
}

describe('person-neutral attention presentation', () => {
  it('uses the generic Needs You label when no display name is configured', () => {
    expect(formatAttentionLabel({ userId: 'user-42' })).toBe('Needs You');
  });

  it('uses an optional configured display name without changing selectors', () => {
    expect(formatAttentionLabel({ userId: 'user-42', displayName: 'Priya' })).toBe('Needs Priya');
  });

  it('selects by generic attention owner and excludes another user', () => {
    const project = emptyProject();
    project.actions = [
      { ...atlas.actions[0], attentionOwner: 'another-user', needsUserAttention: true },
      { ...atlas.actions[1], id: 'generic-action', status: 'open', attentionOwner: 'user-42', needsUserAttention: true, attentionReason: 'A generic user action.' },
    ];
    const items = deriveAttentionItems(project, 'user-42', fixture.asOf);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceEntityId: 'generic-action', attentionOwner: 'user-42' });
  });
});

describe('deterministic attention rules', () => {
  it('includes an explicitly assigned open action', () => {
    const project = emptyProject(); project.actions = [atlas.actions[0]];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)[0].sourceEntityType).toBe('action');
  });

  it('includes a high risk assigned to the current user', () => {
    const project = emptyProject(); project.risksIssues = [atlas.risksIssues[0]];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)[0].sourceEntityType).toBe('risk-issue');
  });

  it('does not include a medium risk even when assigned', () => {
    const project = emptyProject(); project.risksIssues = [{ ...atlas.risksIssues[1], needsUserAttention: true, attentionOwner: 'current-user' }];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)).toEqual([]);
  });

  it('includes a decision awaiting the current user', () => {
    const project = emptyProject(); project.decisions = [atlas.decisions[0]];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)[0].sourceEntityType).toBe('decision');
  });

  it('includes an unanswered question assigned to the current user', () => {
    const project = emptyProject(); project.openQuestions = [atlas.openQuestions[0]];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)[0].sourceEntityType).toBe('open-question');
  });

  it('includes a missed milestone and blocked work package', () => {
    const project = emptyProject(beacon);
    project.milestones = [beacon.milestones[1]];
    project.workPackages = [{ ...beacon.workPackages[0], id: 'blocked-package', workPackageStatus: 'blocked', needsUserAttention: true, attentionOwner: 'current-user', blockerSummary: 'Generic blocker.' }];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf).map((item) => item.sourceEntityType)).toEqual(['milestone', 'work-package']);
  });

  it('includes failed AI verification', () => {
    const project = emptyProject(); project.aiWork = [atlas.aiWork[0]];
    expect(deriveAttentionItems(project, 'current-user', fixture.asOf)[0]).toMatchObject({ sourceEntityType: 'ai-work', urgency: 'now' });
  });

  it('includes complete AI work whose pending verification is over 24 hours old', () => {
    const project = emptyProject(beacon); project.aiWork = [beacon.aiWork[0]];
    const item = deriveAttentionItems(project, 'current-user', fixture.asOf)[0];
    expect(item.reason).toContain('verification is overdue');
  });

  it('orders now before soon before watch with stable tie-breaking', () => {
    const items = deriveAttentionItems(atlas, 'current-user', fixture.asOf);
    const ranks = items.map((item) => ({ now: 0, soon: 1, watch: 2 }[item.urgency]));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('validated fixture responses', () => {
  it('contains exactly two wholly fictional projects', () => {
    expect(fixture.projects.map((project) => project.name)).toEqual(['Project Atlas', 'Project Beacon']);
    expect(fixture.projects.every((project) => project.dataClassification === 'fictional')).toBe(true);
  });

  it('builds reconciled portfolio and project responses', () => {
    const portfolio = buildPortfolioResponse(fixture, new Date(fixture.asOf));
    expect(portfolio.projects).toHaveLength(2);
    expect(portfolio.counts.attention).toBe(portfolio.attention.length);
    expect(buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf))?.project.name).toBe('Project Atlas');
    expect(buildProjectResponse(fixture, 'missing')).toBeNull();
  });

  it('reports current and stale snapshots truthfully', () => {
    expect(getFreshness(fixture.asOf, new Date('2026-07-29T10:00:00Z')).status).toBe('current');
    expect(getFreshness(fixture.asOf, new Date('2026-08-02T10:00:00Z')).status).toBe('stale');
  });
});
