import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const classification = z.literal('fictional');
const attentionFields = {
  needsUserAttention: z.boolean(),
  attentionOwner: z.string().nullable(),
};

const commonRecord = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  owner: z.string().min(1),
  updatedAt: isoDateTime,
  dataClassification: classification,
  summary: z.string().default(''),
});

export const userConfigSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

export const actionSchema = commonRecord.extend({
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  dueDate: dateOnly.nullable(),
  ...attentionFields,
  attentionReason: z.string().nullable(),
});

export const riskIssueSchema = commonRecord.extend({
  kind: z.enum(['risk', 'issue']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  likelihood: z.enum(['unlikely', 'possible', 'likely', 'almost-certain']).nullable(),
  impact: z.string().min(1),
  response: z.string().min(1),
  targetResolutionDate: dateOnly.nullable(),
  ...attentionFields,
});

export const decisionSchema = commonRecord.extend({
  decisionStatus: z.enum(['proposed', 'awaiting-user', 'decided', 'superseded']),
  decisionNeededBy: dateOnly.nullable(),
  optionsSummary: z.string(),
  outcome: z.string().nullable(),
  ...attentionFields,
});

export const openQuestionSchema = commonRecord.extend({
  question: z.string().min(1),
  answerNeededBy: dateOnly.nullable(),
  blocking: z.boolean(),
  resolution: z.string().nullable(),
  ...attentionFields,
});

export const milestoneSchema = commonRecord.extend({
  targetDate: dateOnly,
  milestoneStatus: z.enum(['not-started', 'in-progress', 'at-risk', 'achieved', 'missed']),
  completionPercent: z.number().int().min(0).max(100),
  workPackageIds: z.array(z.string()),
  ...attentionFields,
});

export const workPackageSchema = commonRecord.extend({
  workPackageStatus: z.enum(['not-started', 'in-progress', 'blocked', 'in-review', 'complete']),
  lead: z.string().min(1),
  startDate: dateOnly,
  targetDate: dateOnly,
  completionPercent: z.number().int().min(0).max(100),
  blockerSummary: z.string().nullable(),
  milestoneId: z.string(),
  ...attentionFields,
});

export const activitySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  occurredAt: isoDateTime,
  eventType: z.enum(['progress', 'decision', 'risk', 'milestone', 'ai']),
  summary: z.string().min(1),
  actor: z.string().min(1),
  relatedEntityType: z.string(),
  relatedEntityId: z.string(),
  dataClassification: classification,
});

export const aiWorkSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  label: z.string().min(1),
  relatedEntityType: z.string(),
  relatedEntityId: z.string(),
  writeStatus: z.enum(['not-started', 'drafting', 'draft-ready', 'complete', 'failed']),
  verificationStatus: z.enum(['not-required', 'not-started', 'pending', 'verified', 'failed']),
  verificationMethod: z.string().nullable(),
  lastAttemptAt: isoDateTime.nullable(),
  verifiedAt: isoDateTime.nullable(),
  verifiedBy: z.string().nullable(),
  statusDetail: z.string(),
  attentionOwner: z.string().nullable(),
  dataClassification: classification,
});

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  summary: z.string().min(1),
  deliveryStatus: z.enum(['on-track', 'watch', 'at-risk', 'blocked', 'complete']),
  stage: z.string().min(1),
  owner: z.string().min(1),
  startDate: dateOnly,
  targetDate: dateOnly,
  nextMilestoneId: z.string(),
  updatedAt: isoDateTime,
  asOf: isoDateTime,
  dataClassification: classification,
  actions: z.array(actionSchema),
  risksIssues: z.array(riskIssueSchema),
  decisions: z.array(decisionSchema),
  openQuestions: z.array(openQuestionSchema),
  milestones: z.array(milestoneSchema),
  workPackages: z.array(workPackageSchema),
  activity: z.array(activitySchema),
  aiWork: z.array(aiWorkSchema),
});

export const portfolioFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  dataClassification: classification,
  asOf: isoDateTime,
  userConfig: userConfigSchema,
  projects: z.array(projectSchema).length(2),
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export type PortfolioFixture = z.infer<typeof portfolioFixtureSchema>;
export type ActivityEvent = z.infer<typeof activitySchema>;

export type AttentionUrgency = 'now' | 'soon' | 'watch';
export type AttentionSource = 'action' | 'risk-issue' | 'decision' | 'open-question' | 'milestone' | 'work-package' | 'ai-work';

export interface AttentionItem {
  id: string;
  projectId: string;
  projectName: string;
  sourceEntityType: AttentionSource;
  sourceEntityId: string;
  attentionOwner: string;
  reason: string;
  urgency: AttentionUrgency;
  dueAt: string | null;
  title: string;
  route: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  code: string;
  summary: string;
  deliveryStatus: Project['deliveryStatus'];
  stage: string;
  owner: string;
  nextMilestone: z.infer<typeof milestoneSchema> | null;
  attentionCount: number;
  highRiskIssueCount: number;
  updatedAt: string;
  targetDate: string;
}

export interface Freshness {
  status: 'current' | 'stale';
  hoursOld: number;
}

export function formatAttentionLabel(config: UserConfig): string {
  return config.displayName?.trim() ? `Needs ${config.displayName.trim()}` : 'Needs You';
}

function dateValue(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  return new Date(value.length === 10 ? `${value}T23:59:59Z` : value).getTime();
}

function urgencyFor(dueAt: string | null, asOf: string, forceNow = false): AttentionUrgency {
  if (forceNow) return 'now';
  const due = dateValue(dueAt);
  if (!Number.isFinite(due)) return 'watch';
  const now = new Date(asOf).getTime();
  if (due <= now) return 'now';
  if (due - now <= 3 * 24 * 60 * 60 * 1000) return 'soon';
  return 'watch';
}

const urgencyRank: Record<AttentionUrgency, number> = { now: 0, soon: 1, watch: 2 };

function pendingVerificationIsOverdue(lastAttemptAt: string | null, asOf: string): boolean {
  if (!lastAttemptAt) return false;
  return new Date(asOf).getTime() - new Date(lastAttemptAt).getTime() > 24 * 60 * 60 * 1000;
}

export function deriveAttentionItems(project: Project, userId: string, asOf: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  const belongsToUser = (needs: boolean, owner: string | null) => needs && owner === userId;
  const add = (
    sourceEntityType: AttentionSource,
    sourceEntityId: string,
    title: string,
    reason: string,
    dueAt: string | null,
    forceNow = false,
  ) => {
    items.push({
      id: `attention:${sourceEntityType}:${sourceEntityId}`,
      projectId: project.id,
      projectName: project.name,
      sourceEntityType,
      sourceEntityId,
      attentionOwner: userId,
      reason,
      urgency: urgencyFor(dueAt, asOf, forceNow),
      dueAt,
      title,
      route: `#/projects/${project.id}?focus=${sourceEntityType}`,
    });
  };

  for (const action of project.actions) {
    if (belongsToUser(action.needsUserAttention, action.attentionOwner) && action.status !== 'complete') {
      add('action', action.id, action.title, action.attentionReason ?? 'Your action is required.', action.dueDate, action.priority === 'critical');
    }
  }

  for (const item of project.risksIssues) {
    if (belongsToUser(item.needsUserAttention, item.attentionOwner) && ['high', 'critical'].includes(item.severity) && item.status !== 'closed') {
      add('risk-issue', item.id, item.title, `${item.kind === 'risk' ? 'Risk' : 'Issue'} needs your intervention: ${item.impact}`, item.targetResolutionDate, item.severity === 'critical');
    }
  }

  for (const decision of project.decisions) {
    if (decision.decisionStatus === 'awaiting-user' && decision.attentionOwner === userId) {
      add('decision', decision.id, decision.title, 'A decision is waiting for you.', decision.decisionNeededBy);
    }
  }

  for (const question of project.openQuestions) {
    if (belongsToUser(question.needsUserAttention, question.attentionOwner) && question.status !== 'answered') {
      add('open-question', question.id, question.title, question.blocking ? 'Your answer is blocking delivery.' : 'Your answer is requested.', question.answerNeededBy, question.blocking && urgencyFor(question.answerNeededBy, asOf) === 'now');
    }
  }

  for (const milestone of project.milestones) {
    if (belongsToUser(milestone.needsUserAttention, milestone.attentionOwner) && milestone.milestoneStatus === 'missed') {
      add('milestone', milestone.id, milestone.title, 'A missed milestone needs your intervention.', milestone.targetDate, true);
    }
  }

  for (const workPackage of project.workPackages) {
    if (belongsToUser(workPackage.needsUserAttention, workPackage.attentionOwner) && workPackage.workPackageStatus === 'blocked') {
      add('work-package', workPackage.id, workPackage.title, workPackage.blockerSummary ?? 'A blocked work package needs your intervention.', workPackage.targetDate, true);
    }
  }

  for (const aiWork of project.aiWork) {
    if (aiWork.attentionOwner !== userId) continue;
    if (aiWork.verificationStatus === 'failed') {
      add('ai-work', aiWork.id, aiWork.label, `AI verification failed: ${aiWork.statusDetail}`, aiWork.lastAttemptAt, true);
    } else if (aiWork.writeStatus === 'complete' && aiWork.verificationStatus === 'pending' && pendingVerificationIsOverdue(aiWork.lastAttemptAt, asOf)) {
      add('ai-work', aiWork.id, aiWork.label, 'AI output is complete but verification is overdue.', aiWork.lastAttemptAt, false);
    }
  }

  return items.toSorted((a, b) => {
    const urgency = urgencyRank[a.urgency] - urgencyRank[b.urgency];
    if (urgency !== 0) return urgency;
    const due = dateValue(a.dueAt) - dateValue(b.dueAt);
    if (due !== 0) return due;
    return a.id.localeCompare(b.id);
  });
}

export function getFreshness(asOf: string, now = new Date()): Freshness {
  const hoursOld = Math.max(0, (now.getTime() - new Date(asOf).getTime()) / (60 * 60 * 1000));
  return { status: hoursOld > 72 ? 'stale' : 'current', hoursOld: Math.floor(hoursOld) };
}

export function projectSummary(project: Project, attention: AttentionItem[]): ProjectSummary {
  const nextMilestone = project.milestones.find((item) => item.id === project.nextMilestoneId) ?? null;
  return {
    id: project.id,
    name: project.name,
    code: project.code,
    summary: project.summary,
    deliveryStatus: project.deliveryStatus,
    stage: project.stage,
    owner: project.owner,
    nextMilestone,
    attentionCount: attention.length,
    highRiskIssueCount: project.risksIssues.filter((item) => item.status !== 'closed' && ['high', 'critical'].includes(item.severity)).length,
    updatedAt: project.updatedAt,
    targetDate: project.targetDate,
  };
}

export function buildPortfolioResponse(fixture: PortfolioFixture, now = new Date()) {
  const attention = fixture.projects.flatMap((project) => deriveAttentionItems(project, fixture.userConfig.userId, fixture.asOf))
    .toSorted((a, b) => {
      const urgency = urgencyRank[a.urgency] - urgencyRank[b.urgency];
      if (urgency !== 0) return urgency;
      const due = dateValue(a.dueAt) - dateValue(b.dueAt);
      return due !== 0 ? due : a.id.localeCompare(b.id);
    });
  const projectAttention = new Map(fixture.projects.map((project) => [project.id, attention.filter((item) => item.projectId === project.id)]));
  const activity = fixture.projects.flatMap((project) => project.activity)
    .toSorted((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 8);
  return {
    environment: 'Fictional demo data' as const,
    readOnly: true,
    asOf: fixture.asOf,
    freshness: getFreshness(fixture.asOf, now),
    userConfig: fixture.userConfig,
    attentionLabel: formatAttentionLabel(fixture.userConfig),
    projects: fixture.projects.map((project) => projectSummary(project, projectAttention.get(project.id) ?? [])),
    attention,
    activity,
    counts: {
      projects: fixture.projects.length,
      attention: attention.length,
      highRiskIssues: fixture.projects.flatMap((project) => project.risksIssues).filter((item) => item.status !== 'closed' && ['high', 'critical'].includes(item.severity)).length,
      pendingDecisions: fixture.projects.flatMap((project) => project.decisions).filter((item) => item.decisionStatus === 'awaiting-user').length,
      aiAwaitingVerification: fixture.projects.flatMap((project) => project.aiWork).filter((item) => ['pending', 'failed'].includes(item.verificationStatus)).length,
    },
  };
}

export function buildProjectResponse(fixture: PortfolioFixture, projectId: string, now = new Date()) {
  const project = fixture.projects.find((item) => item.id === projectId);
  if (!project) return null;
  return {
    environment: 'Fictional demo data' as const,
    readOnly: true,
    asOf: fixture.asOf,
    freshness: getFreshness(fixture.asOf, now),
    userConfig: fixture.userConfig,
    attentionLabel: formatAttentionLabel(fixture.userConfig),
    attention: deriveAttentionItems(project, fixture.userConfig.userId, fixture.asOf),
    project,
  };
}
