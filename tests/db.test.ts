import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { importProjectPayload, openProjectManagairDatabase, readPortfolioData, readProjectData } from '../src/db';
import { approveProposedChange, createProject, intakeProjectSource, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { portfolioFixtureSchema } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);

afterEach(() => {
  rmSync(path.resolve('config', 'project-storage.local.json'), { force: true });
});

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-db-test-'));
  return { dir, dbPath: path.join(dir, 'projectmanagair.db') };
}

function cleanupTempDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY') throw error;
  }
}

describe('SQLite operational database', () => {
  it('creates a database and applies migrations idempotently', () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const first = openProjectManagairDatabase(dbPath);
      expect(first.migrationsApplied).toEqual(['001_operational_schema.sql', '002_m365_workday_projection.sql', '003_project_lifecycle.sql']);
      first.db.close();

      const second = openProjectManagairDatabase(dbPath);
      expect(second.migrationsApplied).toEqual([]);
      const tableCount = (second.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get() as { count: number }).count;
      expect(tableCount).toBeGreaterThanOrEqual(32);
      expect((second.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check).toBe('ok');
      second.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('imports one project transactionally and reads Cockpit data from SQLite', () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const context = openProjectManagairDatabase(dbPath);
      const project = {
        ...structuredClone(fixture.projects[0]),
        projectSources: [{ id: 'atlas-source-plan', projectId: 'atlas', sourceType: 'onedrive-folder', label: 'External plan folder', externalPath: 'OneDrive/Project Atlas/Plan', lastSeenAt: fixture.asOf, dataClassification: 'fictional' }],
        changes: [{ id: 'atlas-change-scope', projectId: 'atlas', title: 'Pilot scope adjustment', status: 'open', owner: 'Avery Lane', updatedAt: fixture.asOf, dataClassification: 'fictional', summary: 'Fictional pilot scope narrowed for performance evidence.', changeType: 'scope', impact: 'Reduces first-wave users.', decisionId: 'atlas-decision-wave', needsUserAttention: false, attentionOwner: null, attentionReason: null }],
        deliverables: [{ id: 'atlas-deliverable-plan', projectId: 'atlas', title: 'Pilot readiness pack', status: 'in-review', owner: 'Avery Lane', updatedAt: fixture.asOf, dataClassification: 'fictional', summary: 'Fictional readiness evidence pack.', deliverableType: 'readiness-pack', externalPath: 'OneDrive/Project Atlas/Readiness Pack.docx', dueDate: '2026-08-04', needsUserAttention: false, attentionOwner: null, attentionReason: null }],
        verifications: [{ id: 'atlas-verification-runbook', projectId: 'atlas', aiWriteId: 'atlas-ai-runbook', verificationStatus: 'failed', method: 'Checklist comparison', checkedAt: fixture.asOf, checkedBy: 'Casey Flint', summary: 'Fictional escalation ownership failed verification.', dataClassification: 'fictional' }],
        provenance: [{ id: 'atlas-prov-readiness', projectId: 'atlas', entityType: 'deliverable', entityId: 'atlas-deliverable-plan', label: 'Readiness pack reference', externalPath: 'OneDrive/Project Atlas/Readiness Pack.docx', evidenceKind: 'external-file-reference', capturedAt: fixture.asOf, dataClassification: 'fictional' }],
      };
      const result = importProjectPayload(context.db, { schemaVersion: 1, source: { label: 'Unit fixture' }, project });
      expect(result.recordsWritten).toBeGreaterThan(1);
      expect(readPortfolioData(context.db).projects).toHaveLength(1);
      const projectData = readProjectData(context.db, 'atlas');
      expect(projectData?.projects[0].changes[0].title).toBe('Pilot scope adjustment');
      expect(projectData?.projects[0].deliverables[0].externalPath).toContain('OneDrive/Project Atlas');
      expect(projectData?.projects[0].provenance[0].externalPath).toContain('Readiness Pack.docx');
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('rolls back a failed import without leaving a partial project', () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const context = openProjectManagairDatabase(dbPath);
      const project = { ...structuredClone(fixture.projects[0]), id: 'rollback-proof', projectSources: [{ id: 'bad-source', projectId: 'missing-project', sourceType: 'folder', label: 'Bad source', externalPath: 'OneDrive/Fictional', lastSeenAt: null, dataClassification: 'fictional' }] };
      expect(() => importProjectPayload(context.db, { schemaVersion: 1, source: { label: 'Broken fixture' }, project })).toThrow();
      expect(readProjectData(context.db, 'rollback-proof')).toBeNull();
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('supports project creation, VTT intake, review approval, immutable filing, and provenance', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      const verified = await verifyStorageRoot(context.db, true);
      expect(verified.writable).toBe(true);

      const project = createProject(context.db, { code: 'ACPT-01', name: 'Lifecycle Acceptance', customer: 'Synthetic Customer', description: 'Synthetic acceptance project.', status: 'on-track', owner: 'Warwick' });
      expect(existsSync(path.join(project.externalPath, '00_Inbox', 'Unsorted'))).toBe(true);
      expect(existsSync(path.join(project.externalPath, '01_Sources_Immutable'))).toBe(false);

      const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', 'Action: Confirm training owner', 'Risk: Upload evidence may arrive late', 'Decision: Use the staged configuration pack', 'Question: Who signs off UAT?'].join('\n');
      const unsupported = await intakeProjectSource(context.db, project.projectId, { name: 'unsupported.bin', dataBase64: Buffer.from([1, 2, 3]).toString('base64') });
      expect(unsupported.processingStatus).toBe('failed');
      const failedProposal = readProjectData(context.db, project.projectId)?.projects[0].proposedChanges.find((proposal) => proposal.sourceId === unsupported.sourceId);
      expect(failedProposal?.status).toBe('rejected');
      expect(() => approveProposedChange(context.db, failedProposal!.id, 'Warwick')).toThrow(/Only proposed changes|no structured items/);

      const summaryOnly = await intakeProjectSource(context.db, project.projectId, { name: 'summary-only.vtt', dataBase64: Buffer.from('WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nGeneral discussion without markers', 'utf8').toString('base64') });
      expect(summaryOnly.processingStatus).toBe('failed');
      const summaryOnlyProposal = readProjectData(context.db, project.projectId)?.projects[0].proposedChanges.find((proposal) => proposal.sourceId === summaryOnly.sourceId);
      expect(summaryOnlyProposal?.status).toBe('rejected');
      expect(() => approveProposedChange(context.db, summaryOnlyProposal!.id, 'Warwick')).toThrow(/Only proposed changes|no actionable/);

      const intake = await intakeProjectSource(context.db, project.projectId, { name: 'acceptance.vtt', dataBase64: Buffer.from(vtt, 'utf8').toString('base64') });
      expect(intake.duplicate).toBe(false);
      expect(intake.processingStatus).toBe('awaiting_review');
      const beforeApprove = readProjectData(context.db, project.projectId)?.projects[0];
      expect(beforeApprove?.proposedChanges[0].payload.items.map((item) => item.type)).toEqual(expect.arrayContaining(['action', 'risk_issue', 'decision', 'open_question']));

      const approval = approveProposedChange(context.db, beforeApprove!.proposedChanges[0].id, 'Warwick');
      expect(approval.created.map((item) => item.type)).toEqual(expect.arrayContaining(['action', 'risk-issue', 'decision', 'open-question']));
      const afterApprove = readProjectData(context.db, project.projectId)?.projects[0];
      expect(afterApprove?.actions).toHaveLength(1);
      expect(afterApprove?.risksIssues).toHaveLength(1);
      expect(afterApprove?.decisions).toHaveLength(1);
      expect(afterApprove?.openQuestions).toHaveLength(1);
      expect(afterApprove?.sourceEntityProvenance).toHaveLength(4);
      expect(afterApprove?.aiWork[0].verificationStatus).toBe('verified');
      expect(afterApprove?.verifications[0].verificationStatus).toBe('verified');
      expect(afterApprove?.inboxSources[0].processingStatus).toBe('verified');
      expect(afterApprove?.inboxSources[0].currentExternalPath).toContain(path.join('01_Sources_Immutable', 'Meeting_Transcripts'));
      expect(readFileSync(afterApprove!.inboxSources[0].currentExternalPath, 'utf8')).toBe(vtt);
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
