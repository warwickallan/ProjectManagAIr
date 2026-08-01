import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dataClassification = z.enum(['fictional', 'operational-reference']);
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
  dataClassification,
  summary: z.string().default(''),
});

export const userConfigSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

export const projectSourceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceType: z.string().min(1),
  label: z.string().min(1),
  externalPath: z.string().min(1),
  lastSeenAt: isoDateTime.nullable(),
  dataClassification,
});

export const actionSchema = commonRecord.extend({
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  dueDate: dateOnly.nullable(),
  ...attentionFields,
  attentionReason: z.string().nullable(),
});

export const riskIssueSchema = commonRecord.extend({
  kind: z.enum(['risk', 'issue']),
  severity: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
  likelihood: z.enum(['unlikely', 'possible', 'likely', 'almost-certain']).nullable(),
  impact: z.string().min(1),
  response: z.string().min(1),
  targetResolutionDate: dateOnly.nullable(),
  ...attentionFields,
});

export const changeSchema = commonRecord.extend({
  changeType: z.string().min(1),
  impact: z.string().min(1),
  decisionId: z.string().nullable(),
  ...attentionFields,
  attentionReason: z.string().nullable(),
});

export const decisionSchema = commonRecord.extend({
  decisionStatus: z.enum(['proposed', 'awaiting-user', 'decided', 'agreed', 'agreed-in-principle', 'ratified', 'rejected', 'parked', 'pending-ratification', 'superseded']),
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
  dataClassification,
});

export const deliverableSchema = commonRecord.extend({
  deliverableType: z.string().min(1),
  externalPath: z.string().nullable(),
  dueDate: dateOnly.nullable(),
  ...attentionFields,
  attentionReason: z.string().nullable(),
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
  dataClassification,
});

export const verificationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  aiWriteId: z.string().nullable(),
  verificationStatus: z.enum(['not-required', 'not-started', 'pending', 'verified', 'failed']),
  method: z.string().nullable(),
  checkedAt: isoDateTime.nullable(),
  checkedBy: z.string().nullable(),
  summary: z.string(),
  dataClassification,
});

export const provenanceFileRefSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  label: z.string().min(1),
  externalPath: z.string().min(1),
  evidenceKind: z.string().min(1),
  capturedAt: isoDateTime.nullable(),
  dataClassification,
});

export const inboxSourceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  originalFileName: z.string().min(1),
  originalReceivedAt: isoDateTime,
  contentHash: z.string().min(1),
  sourceType: z.string().min(1),
  currentExternalPath: z.string().min(1),
  previousExternalPath: z.string().nullable(),
  processingStatus: z.enum(['awaiting_metadata', 'awaiting_processing', 'processing', 'awaiting_review', 'verified', 'failed', 'quarantined', 'rejected', 'archived']),
  processorProvider: z.string().min(1),
  extractedItemIds: z.array(z.string()),
  reviewState: z.string().min(1),
  verificationState: z.string().min(1),
  /**
   * D1 — recovery information the pipeline writes (migration 011) and which,
   * until now, was readable only by opening the database. `processingStage` is
   * the finer state behind the coarse `processingStatus` chip, `processingError`
   * is what went wrong, and `processingRecoveryAction` is what a consultant
   * should do about it. All three are null for a source that has never failed.
   */
  processingStage: z.string().nullable().default(null),
  processingError: z.string().nullable().default(null),
  processingRecoveryAction: z.string().nullable().default(null),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const proposedChangeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  status: z.enum(['proposed', 'reviewed', 'approved', 'applied', 'rejected']),
  payload: z.object({
    contractVersion: z.literal(1),
    provider: z.string().min(1),
    sourceMetadata: z.object({ sourceType: z.string(), contentHash: z.string(), originalFileName: z.string() }),
    items: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), summary: z.string(), body: z.string().optional(), severity: z.string().optional(), priority: z.string().optional() })),
  }),
  createdAt: isoDateTime,
  reviewedAt: isoDateTime.nullable(),
  reviewedBy: z.string().nullable(),
  appliedAt: isoDateTime.nullable(),
});

export const sourceEntityProvenanceSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  sourcePath: z.string().min(1),
  contentHash: z.string().min(1),
  createdAt: isoDateTime,
});

export const sourceFileHistorySchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  fromExternalPath: z.string().nullable(),
  toExternalPath: z.string().min(1),
  action: z.string().min(1),
  occurredAt: isoDateTime,
  actor: z.string().min(1),
  contentHash: z.string().min(1),
});

export const registerAnchorSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  segmentId: z.string().min(1),
  speaker: z.string().nullable(),
  tMs: z.number().nullable(),
  quote: z.string().nullable(),
  verified: z.boolean(),
});

export const registerEventSchema = z.object({
  id: z.string().min(1),
  occurredAt: isoDateTime,
  actor: z.string().min(1),
  eventType: z.string().min(1),
  field: z.string().nullable(),
  previousValue: z.string().nullable(),
  newValue: z.string().nullable(),
  reason: z.string().min(1),
  evidenceRef: z.string().nullable(),
  /** Who produced this event: the product UI, a source-extraction apply, or a future automated writer. */
  origin: z.enum(['source', 'human', 'system']).default('human'),
});

export const registerCurrentStateSchema = z.object({
  status: z.string().min(1),
  owner: z.string().nullable(),
  dueDate: z.string().nullable(),
  resolution: z.string().nullable(),
  lastHumanEventAt: z.string().nullable(),
});

export const registerScoreSchema = z.object({
  value: z.number(),
  band: z.enum(['Now', 'Soon', 'Watch', 'Reference']),
  inputs: z.record(z.string(), z.unknown()),
  scoringVersion: z.string().min(1),
});

export const overviewRecordSchema = z.object({
  id: z.string().min(1),
  registerName: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  status: z.string().min(1),
  owner: z.string().nullable(),
  dueDate: z.string().nullable(),
  score: z.number(),
  band: z.enum(['Now', 'Soon', 'Watch', 'Reference']),
  scoreInputs: z.record(z.string(), z.unknown()),
});

export const projectOverviewSchema = z.object({
  leadMode: z.enum(['changes', 'meeting', 'needs-warwick']),
  computedMode: z.enum(['changes', 'meeting', 'needs-warwick']),
  pinnedMode: z.enum(['changes', 'meeting', 'needs-warwick']).nullable(),
  modes: z.object({
    changes: z.object({ available: z.boolean(), changesetId: z.string().nullable() }),
    meeting: z.object({ available: z.boolean() }),
    needsWarwick: z.object({ available: z.boolean() }),
  }),
  lenses: z.record(z.string(), z.array(overviewRecordSchema)),
});

export const sourceIntelligenceSchema = z.object({
  changesets: z.array(z.object({
    id: z.string().min(1),
    packetId: z.string().min(1),
    sourceId: z.string().min(1),
    createdAt: isoDateTime,
    gateVerdict: z.string().min(1),
    gateReport: z.unknown(),
    reviewStatus: z.string().min(1),
    appliedAt: z.string().nullable(),
    deterministicHash: z.string().min(1),
    operations: z.array(z.object({
      id: z.string().min(1), seq: z.number().int(), op: z.string().min(1), registerName: z.string().min(1), clientRef: z.string().min(1),
      targetExternalId: z.string().nullable(), allocatedExternalId: z.string().nullable(), proposedRow: z.record(z.string(), z.unknown()), fieldDiff: z.record(z.string(), z.unknown()), anchors: z.array(z.unknown()),
      confidence: z.string().min(1), derivation: z.string().min(1), status: z.string().min(1), reviewer: z.string().nullable(), reviewedAt: z.string().nullable(), reviewNote: z.string().nullable(),
    })),
  })),
  sources: z.array(z.object({
    id: z.string().min(1), sourceType: z.string().min(1), originalFileName: z.string().min(1), eventDate: z.string().nullable(), durationMs: z.number().nullable(),
    wordCount: z.number().int().nonnegative(), segmentCount: z.number().int().nonnegative(), participants: z.array(z.string()), normaliserVersion: z.string().min(1), createdAt: isoDateTime,
    windows: z.array(z.record(z.string(), z.unknown())), markerCounts: z.array(z.record(z.string(), z.unknown())),
    metrics: z.object({ calls: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), durationMs: z.number().nonnegative() }),
  })),
});

export const consultantBriefSchema = z.object({
  id: z.string().min(1),
  selectionHash: z.string().min(1),
  briefMarkdown: z.string(),
  citations: z.array(z.string()),
  generationMode: z.string().min(1),
  stale: z.boolean(),
  selectedRecords: z.array(overviewRecordSchema).default([]),
});
/**
 * The deterministic Meeting Brief and Needs Warwick views.
 *
 * Carried on the project payload because they cost nothing to compute and must
 * be on screen the moment the project opens. A generated synthesis is NOT here:
 * it is fetched from its own route, so nothing about opening a project can be
 * mistaken for a request to spend a provider call.
 */
export const consultantViewSchema = z.object({
  mode: z.string().min(1),
  themeEngineVersion: z.string().min(1),
  themes: z.array(z.looseObject({ id: z.string(), label: z.string(), memberIds: z.array(z.string()) })).default([]),
  sections: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    rowIds: z.array(z.string()),
  })).default([]),
  records: z.array(z.looseObject({ id: z.string(), registerName: z.string(), title: z.string() })).default([]),
  selectedIds: z.array(z.string()).default([]),
  selectionHash: z.string().min(1),
  providerCalls: z.literal(0),
});

export const registerRowSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  registerName: z.string().min(1),
  externalRegisterId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  recordStatus: z.string().min(1),
  recordType: z.string().nullable(),
  owner: z.string().nullable(),
  dueDate: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceAnchor: z.string().nullable(),
  originalStatusWording: z.string().nullable(),
  relatedIds: z.array(z.string()),
  supersessionIds: z.array(z.string()),
  workPackageTags: z.array(z.string()),
  importRunId: z.string().min(1),
  originalRowNumber: z.number().nullable(),
  originalTabName: z.string().min(1),
  rawRow: z.record(z.string(), z.unknown()),
  normalizedRow: z.record(z.string(), z.string()),
  updatedAt: isoDateTime,
  derivation: z.enum(['fact', 'inference']).default('fact'),
  confidence: z.string().default('unknown'),
  dueDateRaw: z.string().nullable().default(null),
  dueDateConfidence: z.string().default('none'),
  typedDetails: z.record(z.string(), z.unknown()).default({}),
  anchors: z.array(registerAnchorSchema).default([]),
  events: z.array(registerEventSchema).default([]),
  currentState: registerCurrentStateSchema.nullable().default(null),
  score: registerScoreSchema.nullable().default(null),
});

export const registerComparisonRowSchema = z.object({
  id: z.string().min(1),
  registerName: z.string().min(1),
  externalRegisterId: z.string().nullable(),
  fieldName: z.string().nullable(),
  comparisonStatus: z.enum(['EXACT', 'MATCH_WITH_NORMALISATION', 'MISMATCH', 'NOT_COMPARED']),
  detail: z.string().nullable(),
});

export const blindExtractionComparisonReportSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  proposedChangeId: z.string().nullable(),
  frozenPacketHash: z.string().min(1),
  expectedDeltaHash: z.string().min(1),
  expectedWorkbookHash: z.string().nullable(),
  comparisonStatus: z.string().min(1),
  summary: z.unknown(),
  reportMarkdown: z.string(),
  createdAt: isoDateTime,
  createdBy: z.string().min(1),
});
export const registerComparisonSummarySchema = z.object({
  registerName: z.string().min(1),
  sourceWorkbookRowCount: z.number().int().min(0),
  sqliteRowCount: z.number().int().min(0),
  matchingDurableIds: z.number().int().min(0),
  missingIds: z.array(z.string()),
  additionalIds: z.array(z.string()),
  exactFieldMatches: z.number().int().min(0),
  normalisedFieldMatches: z.number().int().min(0),
  fieldMismatches: z.number().int().min(0),
  overallStatus: z.enum(['EXACT', 'MATCH_WITH_NORMALISATION', 'MISMATCH', 'NOT_COMPARED']),
});
export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  summary: z.string().min(1),
  deliveryStatus: z.enum(['active', 'on-track', 'watch', 'at-risk', 'blocked', 'complete']),
  stage: z.string().min(1),
  owner: z.string().min(1),
  startDate: dateOnly,
  targetDate: dateOnly,
  nextMilestoneId: z.string(),
  updatedAt: isoDateTime,
  asOf: isoDateTime,
  dataClassification,
  externalPath: z.string().nullable().default(null),
  folderName: z.string().nullable().default(null),
  storageSchemaVersion: z.string().default('project-storage-v1'),
  projectSources: z.array(projectSourceSchema).default([]),
  actions: z.array(actionSchema).default([]),
  risksIssues: z.array(riskIssueSchema).default([]),
  changes: z.array(changeSchema).default([]),
  decisions: z.array(decisionSchema).default([]),
  openQuestions: z.array(openQuestionSchema).default([]),
  milestones: z.array(milestoneSchema).default([]),
  workPackages: z.array(workPackageSchema).default([]),
  activity: z.array(activitySchema).default([]),
  deliverables: z.array(deliverableSchema).default([]),
  aiWork: z.array(aiWorkSchema).default([]),
  verifications: z.array(verificationSchema).default([]),
  provenance: z.array(provenanceFileRefSchema).default([]),
  inboxSources: z.array(inboxSourceSchema).default([]),
  proposedChanges: z.array(proposedChangeSchema).default([]),
  sourceEntityProvenance: z.array(sourceEntityProvenanceSchema).default([]),
  sourceFileHistory: z.array(sourceFileHistorySchema).default([]),
  registerRows: z.array(registerRowSchema).default([]),
  registerComparisonRows: z.array(registerComparisonRowSchema).default([]),
  registerComparisonSummary: z.array(registerComparisonSummarySchema).default([]),
  blindExtractionComparisonReports: z.array(blindExtractionComparisonReportSchema).default([]),
  sourceIntelligence: sourceIntelligenceSchema.default({ changesets: [], sources: [] }),
  projectOverview: projectOverviewSchema.optional(),
  consultantBrief: consultantBriefSchema.optional(),
  consultantViews: z.array(consultantViewSchema).default([]),
});

export const portfolioDataSchema = z.object({
  schemaVersion: z.literal(1),
  dataClassification,
  asOf: isoDateTime,
  userConfig: userConfigSchema,
  projects: z.array(projectSchema),
});

export const portfolioFixtureSchema = portfolioDataSchema.extend({
  dataClassification: z.literal('fictional'),
  projects: z.array(projectSchema.extend({ dataClassification: z.literal('fictional') })).length(2),
});

export const importPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    label: z.string().min(1),
    externalPath: z.string().min(1).optional(),
  }).optional(),
  project: projectSchema,
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export type PortfolioData = z.infer<typeof portfolioDataSchema>;
export type PortfolioFixture = z.infer<typeof portfolioFixtureSchema>;
export type ImportPayload = z.infer<typeof importPayloadSchema>;
export type ActivityEvent = z.infer<typeof activitySchema>;

export type AttentionUrgency = 'now' | 'soon' | 'watch';
export type AttentionSource = 'action' | 'risk-issue' | 'change' | 'decision' | 'open-question' | 'milestone' | 'work-package' | 'deliverable' | 'ai-work';

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

function tabForAttentionSource(source: AttentionSource): string {
  const tabs: Record<AttentionSource, string> = {
    action: 'actions',
    'risk-issue': 'risks',
    change: 'config-changes',
    decision: 'decisions',
    'open-question': 'open-questions',
    milestone: 'milestones',
    'work-package': 'work-packages',
    deliverable: 'deliverables',
    'ai-work': 'activity',
  };
  return tabs[source];
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
      route: `#/projects/${project.id}/${tabForAttentionSource(sourceEntityType)}`,
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

  for (const change of project.changes) {
    if (belongsToUser(change.needsUserAttention, change.attentionOwner) && change.status !== 'closed') {
      add('change', change.id, change.title, change.attentionReason ?? `Change needs your review: ${change.impact}`, null);
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

  for (const deliverable of project.deliverables) {
    if (belongsToUser(deliverable.needsUserAttention, deliverable.attentionOwner) && deliverable.status !== 'complete') {
      add('deliverable', deliverable.id, deliverable.title, deliverable.attentionReason ?? 'A deliverable needs your attention.', deliverable.dueDate);
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

export function buildPortfolioResponse(data: PortfolioData, now = new Date(), environment = 'SQLite operational database') {
  const attention = data.projects.flatMap((project) => deriveAttentionItems(project, data.userConfig.userId, data.asOf))
    .toSorted((a, b) => {
      const urgency = urgencyRank[a.urgency] - urgencyRank[b.urgency];
      if (urgency !== 0) return urgency;
      const due = dateValue(a.dueAt) - dateValue(b.dueAt);
      return due !== 0 ? due : a.id.localeCompare(b.id);
    });
  const projectAttention = new Map(data.projects.map((project) => [project.id, attention.filter((item) => item.projectId === project.id)]));
  const activity = data.projects.flatMap((project) => project.activity)
    .toSorted((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 8);
  return {
    environment,
    readOnly: true,
    asOf: data.asOf,
    freshness: getFreshness(data.asOf, now),
    userConfig: data.userConfig,
    attentionLabel: formatAttentionLabel(data.userConfig),
    projects: data.projects.map((project) => projectSummary(project, projectAttention.get(project.id) ?? [])),
    attention,
    activity,
    counts: {
      projects: data.projects.length,
      attention: attention.length,
      highRiskIssues: data.projects.flatMap((project) => project.risksIssues).filter((item) => item.status !== 'closed' && ['high', 'critical'].includes(item.severity)).length,
      pendingDecisions: data.projects.flatMap((project) => project.decisions).filter((item) => item.decisionStatus === 'awaiting-user').length,
      aiAwaitingVerification: data.projects.flatMap((project) => project.aiWork).filter((item) => ['pending', 'failed'].includes(item.verificationStatus)).length,
      awaitingSourceReview: data.projects.flatMap((project) => project.proposedChanges).filter((item) => item.status === 'proposed').length,
    },
  };
}

export function buildProjectResponse(data: PortfolioData, projectId: string, now = new Date(), environment = 'SQLite operational database') {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) return null;
  return {
    environment,
    readOnly: true,
    asOf: data.asOf,
    freshness: getFreshness(data.asOf, now),
    userConfig: data.userConfig,
    attentionLabel: formatAttentionLabel(data.userConfig),
    attention: deriveAttentionItems(project, data.userConfig.userId, data.asOf),
    project,
  };
}
