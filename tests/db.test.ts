import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { importProjectPayload, openProjectManagairDatabase, readPortfolioData, readProjectData } from '../src/db';
import { approveProposedChange, createProject, intakeProjectSource, recordBlindExtractionPacket, updateStorageSettings, verifyStorageRoot } from '../src/projectLifecycle';
import { compareBlindExtractionToBenchmark } from '../src/blindExtractionComparison';
import { importProjectRegisterBenchmark } from '../src/projectRegisters';
import { portfolioFixtureSchema } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);
const localStorageConfigPath = path.resolve('config', 'project-storage.local.json');
const originalLocalStorageConfig = existsSync(localStorageConfigPath) ? readFileSync(localStorageConfigPath, 'utf8') : null;

afterEach(() => {
  if (originalLocalStorageConfig === null) {
    rmSync(localStorageConfigPath, { force: true });
    return;
  }
  mkdirSync(path.dirname(localStorageConfigPath), { recursive: true });
  writeFileSync(localStorageConfigPath, originalLocalStorageConfig, 'utf8');
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
      expect(first.migrationsApplied).toHaveLength(10);
      expect(first.migrationsApplied.at(-1)).toBe('010_grounded_brief_runs.sql');
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

  it('supports project creation and normalises VTT intake into immutable source intelligence', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      const verified = await verifyStorageRoot(context.db, true);
      expect(verified.writable).toBe(true);

      const project = createProject(context.db, { code: 'ACPT-01', name: 'Lifecycle Acceptance', customer: 'Synthetic Customer', description: 'Synthetic acceptance project.', status: 'on-track', owner: 'Casey' });
      expect(existsSync(path.join(project.externalPath, '00_Inbox', 'Unsorted'))).toBe(true);
      expect(existsSync(path.join(project.externalPath, '01_Sources_Immutable'))).toBe(false);

      const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', 'Action: Confirm training owner', 'Risk: Upload evidence may arrive late', 'Decision: Use the staged configuration pack', 'Question: Who signs off UAT?'].join('\n');
      const unsupported = await intakeProjectSource(context.db, project.projectId, { name: 'unsupported.bin', dataBase64: Buffer.from([1, 2, 3]).toString('base64') });
      expect(unsupported.processingStatus).toBe('failed');
      const failedProposal = readProjectData(context.db, project.projectId)?.projects[0].proposedChanges.find((proposal) => proposal.sourceId === unsupported.sourceId);
      expect(failedProposal?.status).toBe('rejected');
      expect(() => approveProposedChange(context.db, failedProposal!.id, 'Casey')).toThrow(/Only proposed changes|no structured items|Legacy whole-proposal approval is disabled/);

      const summaryText = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', 'General discussion without markers'].join('\n');
      const summaryOnly = await intakeProjectSource(context.db, project.projectId, { name: 'summary-only.vtt', dataBase64: Buffer.from(summaryText, 'utf8').toString('base64') });
      expect(summaryOnly.processingStatus).toBe('processing');
      expect('segmentCount' in summaryOnly ? summaryOnly.segmentCount : null).toBe(1);

      const intake = await intakeProjectSource(context.db, project.projectId, { name: 'acceptance.vtt', dataBase64: Buffer.from(vtt, 'utf8').toString('base64') });
      expect(intake.duplicate).toBe(false);
      expect(intake.processingStatus).toBe('processing');
      expect('segmentCount' in intake ? intake.segmentCount : 0).toBeGreaterThan(0);
      const afterIntake = readProjectData(context.db, project.projectId)!.projects[0];
      expect(afterIntake.proposedChanges).toHaveLength(1);
      expect(afterIntake.actions).toHaveLength(0);
      expect(afterIntake.sourceIntelligence.sources).toHaveLength(2);
      const acceptedSource = afterIntake.sourceIntelligence.sources.find((source) => source.originalFileName === 'acceptance.vtt');
      expect(acceptedSource?.windows.length).toBeGreaterThan(0);
      expect(acceptedSource?.markerCounts.length).toBeGreaterThan(0);
      const intakeRow = afterIntake.inboxSources.find((source) => source.originalFileName === 'acceptance.vtt');
      expect(intakeRow?.processingStatus).toBe('processing');
      expect(intakeRow?.currentExternalPath).toContain(path.join('01_Sources_Immutable', 'Meeting_Transcripts'));
      expect(readFileSync(intakeRow!.currentExternalPath, 'utf8')).toBe(vtt);
      expect(afterIntake.sourceFileHistory.some((entry) => entry.sourceId === intakeRow?.id && entry.action === 'filed-immutable-original')).toBe(true);
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
  it('imports canonical project register benchmark rows with durable ID parity and comparison evidence', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      await verifyStorageRoot(context.db, true);
      const project = createProject(context.db, { code: 'DEMO', name: 'DEMO Concerto Implementation', customer: 'DEMO', description: 'DEMO operational register parity workspace.', status: 'active', owner: 'Casey' });
      const packet = {
        packet_type: 'project_register_benchmark',
        packet_version: 1,
        project_code: 'DEMO',
        registers: {
          Decisions: [{ id: 'DEMO-D-001', title: 'Approve migration route', status: 'Decided', date: '2026-07-01', rationale: 'Keep a reversible path.', source_ref: 'Workbook', source_anchor: 'Decisions!A2', row_number: 2 }],
          Actions: [{ id: 'DEMO-A-001', title: 'Confirm owner', status: 'Open', priority: 'High', owner: 'Casey', due_date: '2026-08-01', source_ref: 'Workbook', source_anchor: 'Actions!A2', row_number: 2 }],
          Risks_Issues: [{ id: 'DEMO-R-001', title: 'Training evidence late', status: 'Open', severity: 'High', driver: 'Evidence dependency', evidence: 'Session not complete', impact: 'UAT delay', mitigation: 'Track source receipt', source_anchor: 'Risks!A2' }],
          Config_Changes: [{ id: 'DEMO-C-001', title: 'Set approval workflow flag', status: 'Open', environment: 'Production', follow_through: 'Confirm upload evidence', impact: 'Controls workflow', source_anchor: 'Config!A2' }],
          Open_Questions: [{ id: 'DEMO-Q-001', question: 'Who signs off approval workflow?', status: 'Open', parked_with: 'DEMO', unblocked_by: 'Named approver', source_anchor: 'Questions!A2' }],
          Milestones: [{ id: 'DEMO-M-001', title: 'approval workflow ready', status: 'Not started', target_date: '2026-08-15', conditional_logic: 'Only after approver confirmed', source_anchor: 'Milestones!A2' }],
          Entities: [{ id: 'DEMO-E-001', name: 'approval workflow Team', entity_type: 'Group', aliases: ['Permit team'], alias_confidence: 'high', disambiguation_note: 'Training audience', source_anchor: 'Entities!A2' }],
          Sources: [{ id: 'DEMO-S-001', title: 'Canonical workbook', status: 'Current', type: 'workbook', source_anchor: 'Sources!A2' }],
          Uncertainty: [{ id: 'DEMO-U-001', title: 'Approver timing unknown', status: 'Open', why_uncertain: 'Awaiting named approver', resolve_by: '2026-08-02', source_anchor: 'Uncertainty!A2' }],
        },
      };
      const benchmarkText = JSON.stringify(packet, null, 2);
      const result = importProjectRegisterBenchmark(context.db, project.projectId, { benchmarkFile: { name: 'DEMO_register_benchmark_canonical.json', dataBase64: Buffer.from(benchmarkText, 'utf8').toString('base64') }, workbookFile: { name: 'DEMO_Concerto_Project_Registers.xlsx', dataBase64: Buffer.from('synthetic workbook bytes').toString('base64') } });
      expect(result.recordsImported).toBe(9);
      expect(result.filedBenchmark).toContain(path.join('06_Registers_and_Exports', 'External_Registers'));
      const demo = readProjectData(context.db, project.projectId)!.projects[0];
      expect(demo.registerRows).toHaveLength(9);
      expect(demo.decisions[0].id).toBe('DEMO-D-001');
      expect(demo.registerRows.find((row) => row.externalRegisterId === 'DEMO-D-001')?.dueDate).toBeNull();
      expect(demo.registerRows.find((row) => row.externalRegisterId === 'DEMO-M-001')?.dueDate).toBe('2026-08-15');
      expect(demo.actions[0].id).toBe('DEMO-A-001');
      expect(demo.risksIssues[0].impact).toBe('UAT delay');
      expect(demo.registerComparisonSummary.every((row) => row.overallStatus === 'EXACT' || row.overallStatus === 'NOT_COMPARED')).toBe(true);
      const duplicate = importProjectRegisterBenchmark(context.db, project.projectId, { benchmarkFile: { name: 'DEMO_register_benchmark_canonical.json', dataBase64: Buffer.from(benchmarkText, 'utf8').toString('base64') } });
      expect(duplicate.duplicate).toBe(true);
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
  it('records a frozen blind approval workflow extraction as proposed pending verification without applying records', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      await verifyStorageRoot(context.db, true);
      const project = createProject(context.db, { code: 'DEMO', name: 'DEMO Concerto Implementation', customer: 'DEMO', description: 'DEMO operational register parity workspace.', status: 'active', owner: 'Casey' });
      const sourceText = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAction: Configure approval workflow route';
      const sourceHash = createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
      const packet = {
        contractVersion: 1 as const,
        provider: 'Codex',
        model: 'GPT-5',
        generatedAt: '2026-07-30T12:00:00.000Z',
        extractionMode: 'blind-approval-workflow-vtt',
        sourceMetadata: { sourceType: 'vtt-transcript', contentHash: sourceHash, originalFileName: 'approval-workflow.vtt' },
        items: [{ id: 'DEMO-A-002', type: 'action' as const, title: 'Configure approval workflow route', summary: 'Configure approval workflow route from transcript evidence.' }],
      };
      const result = recordBlindExtractionPacket(context.db, project.projectId, { sourceFile: { name: 'approval-workflow.vtt', dataBase64: Buffer.from(sourceText, 'utf8').toString('base64') }, frozenPacket: packet });
      expect(result.duplicate).toBe(false);
      expect(result.extractedCount).toBe(1);
      expect(result.filedSource).toContain(path.join('01_Sources_Immutable', 'Meeting_Transcripts'));
      const demo = readProjectData(context.db, project.projectId)!.projects[0];
      expect(demo.actions).toHaveLength(0);
      expect(demo.proposedChanges).toHaveLength(1);
      expect(demo.proposedChanges[0].status).toBe('proposed');
      expect(demo.inboxSources[0].processingStatus).toBe('awaiting_review');
      expect(demo.inboxSources[0].verificationState).toBe('pending');
      expect(demo.aiWork[0].verificationStatus).toBe('pending');
      expect(demo.verifications[0].verificationStatus).toBe('pending');
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
  it('compares a frozen blind extraction with an expected delta and keeps a detailed Cockpit report', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      await verifyStorageRoot(context.db, true);
      const project = createProject(context.db, { code: 'DEMO', name: 'DEMO Concerto Implementation', customer: 'DEMO', description: 'DEMO operational register parity workspace.', status: 'active', owner: 'Casey' });
      const sourceHash = createHash('sha256').update('synthetic source').digest('hex');
      const frozen = {
        contractVersion: 1 as const,
        provider: 'Codex',
        model: 'GPT-5',
        generatedAt: '2026-07-30T12:00:00.000Z',
        sourceMetadata: { sourceType: 'vtt-transcript', contentHash: sourceHash, originalFileName: 'approval-workflow.vtt' },
        items: [
          { id: 'DEMO-A-022', type: 'action' as const, title: 'Configure approval workflow route', summary: 'Configure the approval workflow high risk route.' },
          { id: 'DEMO-D-015', type: 'decision' as const, title: 'Use approval workflow route', summary: 'Use the approval workflow route for permits.' },
          { id: 'DEMO-A-999', type: 'action' as const, title: 'Additional speculative item', summary: 'Extra item.' },
        ],
      };
      const expected = {
        packet_type: 'project_register_benchmark_delta',
        packet_version: 1,
        project_code: 'DEMO',
        sheets: {
          Decisions: { rows: [{ decision_id: 'DEMO-D-015', decision: 'Use approval workflow route', status: 'Decided', source_ref: 'Transcript', anchor: '00:01', work_package_id: 'WP-1' }] },
          Actions: { rows: [{ action_id: 'DEMO-A-022', action: 'Configure permit to work high risk route', status: 'Open', source_ref: 'Transcript', anchor: '00:02', work_package_id: 'WP-1' }] },
          Risks_Issues: { rows: [{ raid_id: 'DEMO-R-010', description: 'Training gap', status: 'Open', anchor: '00:03' }] },
        },
      };
      const result = compareBlindExtractionToBenchmark(context.db, project.projectId, { frozenPacketFile: { name: 'frozen.json', dataBase64: Buffer.from(JSON.stringify(frozen), 'utf8').toString('base64') }, expectedDeltaFile: { name: 'expected.json', dataBase64: Buffer.from(JSON.stringify(expected), 'utf8').toString('base64') } });
      expect(result.comparisonStatus).toBe('differences-found');
      expect(result.report.totals.expectedRows).toBe(3);
      expect(result.report.totals.extractedRows).toBe(3);
      const demo = readProjectData(context.db, project.projectId)!.projects[0];
      expect(demo.blindExtractionComparisonReports).toHaveLength(1);
      expect(demo.blindExtractionComparisonReports[0].reportMarkdown).toContain('Benchmark-Informed Extraction Comparison');
      expect(demo.actions).toHaveLength(0);
      expect(demo.aiWork.some((item) => item.label === 'Benchmark-informed extraction comparison' && item.verificationStatus === 'failed')).toBe(true);
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
