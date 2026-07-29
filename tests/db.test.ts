import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { importProjectPayload, openProjectManagairDatabase, readPortfolioData, readProjectData } from '../src/db';
import { portfolioFixtureSchema } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);

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
      expect(first.migrationsApplied).toEqual(['001_operational_schema.sql']);
      first.db.close();

      const second = openProjectManagairDatabase(dbPath);
      expect(second.migrationsApplied).toEqual([]);
      const tableCount = (second.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get() as { count: number }).count;
      expect(tableCount).toBeGreaterThanOrEqual(17);
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
      const project = {
        ...structuredClone(fixture.projects[0]),
        id: 'rollback-proof',
        projectSources: [{ id: 'bad-source', projectId: 'missing-project', sourceType: 'folder', label: 'Bad source', externalPath: 'OneDrive/Fictional', lastSeenAt: null, dataClassification: 'fictional' }],
      };
      expect(() => importProjectPayload(context.db, { schemaVersion: 1, source: { label: 'Broken fixture' }, project })).toThrow();
      expect(readProjectData(context.db, 'rollback-proof')).toBeNull();
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
