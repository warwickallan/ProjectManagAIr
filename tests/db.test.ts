import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { importProjectPayload, openProjectManagairDatabase, readPortfolioData, readProjectData } from '../src/db';
import { approveProposedChange, createProject, fileProjectArtifact, intakeProjectSource, localConfigWriteDecision, openOriginalPath, recordBlindExtractionPacket, resolveDesktopLauncher, updateStorageSettings, validateProjectsRoot, verifyStorageRoot } from '../src/projectLifecycle';
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
      // Derived from the migrations directory rather than pinned to a count, so
      // adding a migration does not make this assertion fail for the wrong
      // reason. What is under test is that every migration applies once and the
      // second open applies none.
      const migrationFiles = readdirSync(path.resolve('migrations')).filter((name) => name.endsWith('.sql')).sort();
      const first = openProjectManagairDatabase(dbPath);
      expect(first.migrationsApplied).toEqual(migrationFiles);
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
      expect(summaryOnly.processingStatus).toBe('awaiting_metadata');
      expect('segmentCount' in summaryOnly ? summaryOnly.segmentCount : null).toBe(1);

      const intake = await intakeProjectSource(context.db, project.projectId, { name: 'acceptance.vtt', dataBase64: Buffer.from(vtt, 'utf8').toString('base64') });
      expect(intake.duplicate).toBe(false);
      expect(intake.processingStatus).toBe('awaiting_metadata');
      expect('segmentCount' in intake ? intake.segmentCount : 0).toBeGreaterThan(0);
      const afterIntake = readProjectData(context.db, project.projectId)!.projects[0];
      expect(afterIntake.proposedChanges).toHaveLength(1);
      expect(afterIntake.actions).toHaveLength(0);
      expect(afterIntake.sourceIntelligence.sources).toHaveLength(2);
      const acceptedSource = afterIntake.sourceIntelligence.sources.find((source) => source.originalFileName === 'acceptance.vtt');
      expect(acceptedSource?.windows.length).toBeGreaterThan(0);
      expect(acceptedSource?.markerCounts.length).toBeGreaterThan(0);
      const intakeRow = afterIntake.inboxSources.find((source) => source.originalFileName === 'acceptance.vtt');
      expect(intakeRow?.processingStatus).toBe('awaiting_metadata');
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

describe('local configuration write guard (D7)', () => {
  it('refuses to write the local config file even when NODE_ENV is not test', async () => {
    // The regression this pins: `NODE_ENV=development npx vitest run ...`
    // previously overwrote the consultant's live projectsRoot, permanently, in
    // three of the four suites that call updateStorageSettings. Vitest only
    // DEFAULTS NODE_ENV to 'test' when it is unset, so an ambient value re-armed
    // the clobber. The guard now also keys off the Vitest worker's own
    // variables, which no ambient value and no config edit can remove.
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'Projects');
    const previousNodeEnv = process.env.NODE_ENV;
    const previousMode = process.env.PROJECTMANAGAIR_LOCAL_CONFIG_MODE;
    const before = existsSync(localStorageConfigPath) ? readFileSync(localStorageConfigPath, 'utf8') : null;
    try {
      mkdirSync(root, { recursive: true });
      // Strip every signal the old guard depended on, and the one vite.config.ts adds.
      process.env.NODE_ENV = 'development';
      delete process.env.PROJECTMANAGAIR_LOCAL_CONFIG_MODE;
      expect(localConfigWriteDecision(process.env).allowed).toBe(false);
      expect(localConfigWriteDecision(process.env).reason).toMatch(/VITEST/);

      const context = openProjectManagairDatabase(dbPath);
      await updateStorageSettings(context.db, { projectsRoot: root });
      context.db.close();

      const after = existsSync(localStorageConfigPath) ? readFileSync(localStorageConfigPath, 'utf8') : null;
      expect(after).toBe(before);
      expect(after ?? '').not.toContain(root);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
      if (previousMode === undefined) delete process.env.PROJECTMANAGAIR_LOCAL_CONFIG_MODE; else process.env.PROJECTMANAGAIR_LOCAL_CONFIG_MODE = previousMode;
      cleanupTempDir(dir);
    }
  });

  it('reports each independent blocking signal by name and only allows a clean non-test environment', () => {
    const clean = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    expect(localConfigWriteDecision(clean)).toMatchObject({ allowed: true });
    expect(localConfigWriteDecision({ ...clean, NODE_ENV: 'test' }).allowed).toBe(false);
    expect(localConfigWriteDecision({ ...clean, VITEST: 'true' }).allowed).toBe(false);
    expect(localConfigWriteDecision({ ...clean, VITEST_WORKER_ID: '3' }).allowed).toBe(false);
    expect(localConfigWriteDecision({ ...clean, PROJECTMANAGAIR_LOCAL_CONFIG_MODE: 'blocked' }).allowed).toBe(false);
    expect(localConfigWriteDecision({ ...clean, npm_lifecycle_event: 'test:boundary' }).allowed).toBe(false);
    // The explicit opt-in cannot re-enable writes inside a Vitest worker.
    expect(localConfigWriteDecision({ ...clean, PROJECTMANAGAIR_LOCAL_CONFIG_MODE: 'allow', VITEST: 'true' }).allowed).toBe(false);
    expect(localConfigWriteDecision({ ...clean, PROJECTMANAGAIR_LOCAL_CONFIG_MODE: 'allow', NODE_ENV: 'test' }).allowed).toBe(true);
  });
});

describe('projects root validation (D8)', () => {
  function withTempDir<T>(run: (dir: string) => T): T {
    const { dir } = tempDbPath();
    try {
      return run(dir);
    } finally {
      cleanupTempDir(dir);
    }
  }

  it('accepts a real, writable directory and returns the normalised absolute path', () => {
    withTempDir((dir) => {
      const root = path.join(dir, 'Projects');
      mkdirSync(root, { recursive: true });
      expect(validateProjectsRoot(`${root}${path.sep}`)).toBe(path.resolve(root));
    });
  });

  it('rejects a path that does not exist', () => {
    withTempDir((dir) => {
      expect(() => validateProjectsRoot(path.join(dir, 'nope'))).toThrow(/does not exist/i);
    });
  });

  it('rejects a file that is not a directory', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'projects.txt');
      writeFileSync(file, 'not a directory', 'utf8');
      expect(() => validateProjectsRoot(file)).toThrow(/not a directory/i);
    });
  });

  it('rejects a relative path instead of silently resolving it against the server cwd', () => {
    for (const candidate of ['Projects', './Projects', '../Projects', '']) {
      expect(() => validateProjectsRoot(candidate)).toThrow();
    }
    expect(() => validateProjectsRoot('Projects')).toThrow(/absolute/i);
  });

  it('rejects filesystem and system roots', () => {
    expect(() => validateProjectsRoot('/')).toThrow(/filesystem root|system location/i);
    for (const candidate of ['/etc', '/usr', '/var', '/home', '/root']) {
      expect(() => validateProjectsRoot(candidate)).toThrow(/system location|not readable/i);
    }
  });

  it('rejects a root inside the product repository, where live data must never live', () => {
    expect(() => validateProjectsRoot(path.resolve('src'))).toThrow(/repository/i);
    expect(() => validateProjectsRoot(path.resolve('.'))).toThrow(/repository/i);
  });

  it('carries a 400 status so the route does not answer with an opaque 500', () => {
    try {
      validateProjectsRoot('Projects');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('rejects a root that leaves no room inside the Windows MAX_PATH budget', () => {
    withTempDir((dir) => {
      const root = path.join(dir, 'Projects');
      mkdirSync(root, { recursive: true });
      const previous = process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET;
      process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET = String(root.length + 85);
      try {
        expect(() => validateProjectsRoot(root)).toThrow(/too long/i);
      } finally {
        if (previous === undefined) delete process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET; else process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET = previous;
      }
    });
  });

  it('is enforced by updateStorageSettings, which no longer persists an unchecked root', async () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const context = openProjectManagairDatabase(dbPath);
      await expect(updateStorageSettings(context.db, { projectsRoot: path.join(dir, 'missing') })).rejects.toThrow(/does not exist/i);
      const stored = context.db.prepare("SELECT projects_root FROM project_storage_settings WHERE id = 'local'").get() as { projects_root: string | null };
      expect(stored.projects_root).toBeNull();
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('long path handling', () => {
  it('bounds the filed artifact path so a deep OneDrive root does not fail with ENOENT', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'Projects');
    const previous = process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET;
    try {
      mkdirSync(root, { recursive: true });
      process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET = String(root.length + 150);
      const context = openProjectManagairDatabase(dbPath);
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      const longName = 'Extremely Long Synthetic Project Name '.repeat(6);
      const project = createProject(context.db, { code: 'LONG', name: longName, customer: 'Synthetic', description: 'Long path bound.', status: 'active', owner: 'Casey' });
      const longFile = `${'synthetic-transcript-segment-'.repeat(8)}.vtt`;
      const bytes = Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAction: bound the path', 'utf8');
      const filed = fileProjectArtifact(context.db, project.projectId, 'uploadEvidence', longFile, bytes);
      expect(existsSync(filed.destinationPath)).toBe(true);
      expect(filed.destinationPath.length).toBeLessThanOrEqual(root.length + 150);
      expect(path.basename(filed.destinationPath)).toMatch(/-[0-9a-f]{12}\.vtt$/);
      context.db.close();
    } finally {
      if (previous === undefined) delete process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET; else process.env.PROJECTMANAGAIR_MAX_PATH_BUDGET = previous;
      cleanupTempDir(dir);
    }
  });
});

describe('openOriginalPath (D8)', () => {
  async function projectWithFile() {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'Projects');
    mkdirSync(root, { recursive: true });
    const context = openProjectManagairDatabase(dbPath);
    await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
    const project = createProject(context.db, { code: 'OPEN', name: 'Synthetic Open', customer: 'Synthetic', description: 'Launcher fixture.', status: 'active', owner: 'Casey' });
    const filed = fileProjectArtifact(context.db, project.projectId, 'transcripts', 'note.txt', Buffer.from('synthetic', 'utf8'));
    return { dir, context, root, filePath: filed.destinationPath };
  }

  it('fails cleanly on a host with no desktop launcher instead of spawning nothing', async () => {
    const fixture = await projectWithFile();
    try {
      expect(resolveDesktopLauncher('linux', { PATH: path.join(fixture.dir, 'no-such-bin') })).toBeNull();
      expect(() => openOriginalPath(fixture.context.db, fixture.filePath, { platform: 'linux', env: { PATH: path.join(fixture.dir, 'no-such-bin') } }))
        .toThrow(/No desktop file launcher is available/i);
    } finally {
      fixture.context.db.close();
      cleanupTempDir(fixture.dir);
    }
  });

  it("does not kill the process when the spawned child emits 'error'", async () => {
    // An 'error' event with no listener is rethrown as an uncaught exception.
    // Before the fix, one request on a host without `cmd` took the whole server
    // down. The listener must absorb it.
    const fixture = await projectWithFile();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const emitter = new EventEmitter() as EventEmitter & { unref: () => void };
      emitter.unref = () => undefined;
      const result = openOriginalPath(fixture.context.db, fixture.filePath, {
        // win32 resolves its launcher from ComSpec without probing PATH, so
        // this exercises the spawn path on any host.
        platform: 'win32',
        env: { ComSpec: 'cmd.exe' },
        spawnImpl: (() => emitter) as never,
      });
      expect(result).toMatchObject({ opened: true });
      expect(() => emitter.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      fixture.context.db.close();
      cleanupTempDir(fixture.dir);
    }
  });

  it('keeps assertInside and refuses executable file types', async () => {
    const fixture = await projectWithFile();
    try {
      expect(() => openOriginalPath(fixture.context.db, path.join(fixture.dir, 'outside.txt'))).toThrow(/escapes the configured projects root/i);
      const script = fileProjectArtifact(fixture.context.db, 'open', 'transcripts', 'payload.bat', Buffer.from('@echo off', 'utf8'));
      expect(() => openOriginalPath(fixture.context.db, script.destinationPath)).toThrow(/executable file type/i);
    } finally {
      fixture.context.db.close();
      cleanupTempDir(fixture.dir);
    }
  });
});

describe('recordBlindExtractionPacket collision (D9 residual)', () => {
  it('reuses an existing intake row for the same content hash and leaves no orphan file', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'Projects');
    try {
      mkdirSync(root, { recursive: true });
      const context = openProjectManagairDatabase(dbPath);
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      const project = createProject(context.db, { code: 'DEMO', name: 'Synthetic Blind', customer: 'Synthetic', description: 'Blind packet collision fixture.', status: 'active', owner: 'Casey' });
      const sourceText = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAction: Configure approval workflow route';
      const sourceHash = createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
      const dataBase64 = Buffer.from(sourceText, 'utf8').toString('base64');

      // The same file arrives first through the ordinary Cockpit intake route,
      // which is what creates the `(project_id, content_hash)` row the blind
      // packet's upsert then collides with.
      const intake = await intakeProjectSource(context.db, project.projectId, { name: 'approval-workflow.vtt', dataBase64 });
      const intakeRowId = (context.db.prepare('SELECT id FROM project_source_intake WHERE project_id = ? AND content_hash = ?').get(project.projectId, sourceHash) as { id: string }).id;
      expect(intake).toBeTruthy();

      const packet = {
        contractVersion: 1 as const,
        provider: 'Codex',
        model: 'GPT-5',
        generatedAt: '2026-07-30T12:00:00.000Z',
        extractionMode: 'blind-approval-workflow-vtt',
        sourceMetadata: { sourceType: 'vtt-transcript', contentHash: sourceHash, originalFileName: 'approval-workflow.vtt' },
        items: [{ id: 'DEMO-A-002', type: 'action' as const, title: 'Configure approval workflow route', summary: 'Configure approval workflow route from transcript evidence.' }],
      };
      const result = recordBlindExtractionPacket(context.db, project.projectId, { sourceFile: { name: 'approval-workflow.vtt', dataBase64 }, frozenPacket: packet });

      // Previously this threw `FOREIGN KEY constraint failed` as an opaque 500,
      // because the job row referenced a synthetic id the upsert had discarded.
      expect(result.duplicate).toBe(false);
      expect(result.sourceId).toBe(intakeRowId);
      const job = context.db.prepare('SELECT source_id FROM source_processing_jobs WHERE proposed_change_id = ?').get(result.proposedChangeId) as { source_id: string };
      expect(job.source_id).toBe(intakeRowId);
      expect(context.db.prepare('SELECT count(*) AS count FROM project_source_intake WHERE project_id = ? AND content_hash = ?').get(project.projectId, sourceHash)).toMatchObject({ count: 1 });
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('does not leave a filed immutable original behind when the transaction rolls back', async () => {
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'Projects');
    try {
      mkdirSync(root, { recursive: true });
      const context = openProjectManagairDatabase(dbPath);
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      const project = createProject(context.db, { code: 'DEMO', name: 'Synthetic Blind', customer: 'Synthetic', description: 'Rollback fixture.', status: 'active', owner: 'Casey' });
      const sourceText = 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nAction: Roll back cleanly';
      const sourceHash = createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
      const dataBase64 = Buffer.from(sourceText, 'utf8').toString('base64');
      const packet = {
        contractVersion: 1 as const,
        provider: 'Codex',
        sourceMetadata: { sourceType: 'vtt-transcript', contentHash: sourceHash, originalFileName: 'rollback.vtt' },
        items: [{ id: 'DEMO-A-003', type: 'action' as const, title: 'Roll back cleanly', summary: 'Roll back cleanly.' }],
      };
      const packetHash = createHash('sha256').update(JSON.stringify(packet)).digest('hex');

      // Force the transaction to fail on its last insert by pre-claiming the
      // deterministic ai_writes id the function will try to write.
      context.db.prepare('INSERT INTO ai_writes (id, project_id, label, related_entity_type, related_entity_id, write_status, verification_status, verification_method, last_attempt_at, verified_at, verified_by, status_detail, attention_owner, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`ai-write:${project.projectId}:${packetHash.slice(0, 16)}`, project.projectId, 'Pre-existing', 'source', 'placeholder-source', 'complete', 'pending', 'manual', null, null, null, 'Pre-existing row that forces a rollback.', 'current-user', 'operational-reference');

      const immutableDir = path.join(root, `DEMO - Synthetic Blind`, '01_Sources_Immutable', 'Meeting_Transcripts');
      expect(() => recordBlindExtractionPacket(context.db, project.projectId, { sourceFile: { name: 'rollback.vtt', dataBase64 }, frozenPacket: packet })).toThrow();
      const orphans = existsSync(immutableDir) ? readdirSync(immutableDir) : [];
      expect(orphans).toEqual([]);
      expect(context.db.prepare('SELECT count(*) AS count FROM project_source_intake WHERE project_id = ?').get(project.projectId)).toMatchObject({ count: 0 });
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('register projection ownership at the database boundary (C3)', () => {
  it('keeps operational rows the projector did not create when a register import rebuilds the projection', async () => {
    // `rebuildProjection` used to delete every operational row for the project
    // before re-inserting the register-derived ones, so anything written
    // directly through this module - the JSON import path, the fixture loader,
    // the connected-folder projection - was destroyed by the next register
    // import or the next recorded register event.
    const { dir, dbPath } = tempDbPath();
    const root = path.join(dir, 'OneDrive Projects');
    try {
      const context = openProjectManagairDatabase(dbPath);
      mkdirSync(root, { recursive: true });
      await updateStorageSettings(context.db, { projectsRoot: root, projectFolderNamingFormat: '{code} - {name}' });
      await verifyStorageRoot(context.db, true);
      const project = createProject(context.db, { code: 'OWN', name: 'Ownership Fixture', customer: 'Synthetic', description: 'Projection ownership fixture.', status: 'active', owner: 'Casey' });

      context.db.prepare('INSERT INTO project_sources (id, project_id, source_type, label, external_path, last_seen_at, data_classification) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('connected-folder', project.projectId, 'cloud-folder', 'Connected project folder', 'Cloud/Projects/OWN', '2026-07-30T09:00:00.000Z', 'operational-reference');
      context.db.prepare('INSERT INTO actions (id, project_id, title, status, owner, updated_at, data_classification, summary, priority, due_date, needs_user_attention, attention_owner, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL)')
        .run('connector-action', project.projectId, 'Action from a connected system', 'open', 'Avery Lane', '2026-07-30T09:00:00.000Z', 'operational-reference', 'Not derived from any register row.', 'medium');

      const packet = {
        packet_type: 'project_register_benchmark',
        packet_version: 1,
        project_code: 'OWN',
        registers: {
          Actions: [{ id: 'OWN-A-001', title: 'Confirm owner', status: 'Open', owner: 'Casey', due_date: '2026-08-01' }],
          Sources: [{ id: 'OWN-S-001', title: 'Canonical workbook', status: 'Current', type: 'workbook' }],
        },
      };
      const benchmarkText = JSON.stringify(packet, null, 2);
      importProjectRegisterBenchmark(context.db, project.projectId, { benchmarkFile: { name: 'OWN_register_benchmark_canonical.json', dataBase64: Buffer.from(benchmarkText, 'utf8').toString('base64') } });

      const data = readProjectData(context.db, project.projectId)!.projects[0];
      expect(data.projectSources.map((source) => source.id).sort()).toEqual(['OWN-S-001', 'connected-folder']);
      expect(data.actions.map((action) => action.id).sort()).toEqual(['OWN-A-001', 'connector-action']);
      expect(data.actions.find((action) => action.id === 'connector-action')?.title).toBe('Action from a connected system');

      // A second rebuild, through the human-event path, must not duplicate or
      // destroy anything either.
      const { recordRegisterEvent } = await import('../src/registerProjection');
      recordRegisterEvent(context.db, project.projectId, 'OWN-A-001', { actor: 'Casey', eventType: 'update', field: 'owner', newValue: 'Avery Lane', reason: 'Reassigned in the playback session.', occurredAt: '2026-07-30T10:00:00.000Z' });
      const after = readProjectData(context.db, project.projectId)!.projects[0];
      expect(after.projectSources).toHaveLength(2);
      expect(after.actions).toHaveLength(2);
      expect(after.actions.find((action) => action.id === 'OWN-A-001')?.owner).toBe('Avery Lane');
      context.db.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
