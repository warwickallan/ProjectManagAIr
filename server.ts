import express from 'express';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from './src/domain.js';
import { openProjectManagairDatabase, readPortfolioData, readProjectData } from './src/db.js';
import { approveProposedChange, createProject, openOriginalPath, readStorageSettings, recordBlindExtractionPacket, rejectProposedChange, updateStorageSettings, verifyStorageRoot, type IntakeFileInput } from './src/projectLifecycle.js';
import { authStatus, markMessageRead, moveMessageToDeletedItems, pollDeviceCode, readCalendarProjection, readInboxProjection, requiredScopes, startDeviceCode, syncCalendarView, syncInbox } from './src/m365.js';
import { probeAIProviders, sendChatMessage } from './src/aiProvider.js';
import { compareBlindExtractionToBenchmark } from './src/blindExtractionComparison.js';
import { importProjectRegisterBenchmark } from './src/projectRegisters.js';
import { recordRegisterEvent } from './src/registerProjection.js';
import { acknowledgeChangeset, applyReviewedChangeset, buildConsultantBrief, freezePacketAndCreateChangeset, pinOverviewMode, readSourceIntelligence, replayPacket, reviewChangeset } from './src/sourceIntelligence.js';
import { createLifecycleSourceEnqueuer, retrySourceJob, runSourceExtractionJob, skipSourceAfterComprehension, startSourceJobSweeper, WatchedInboxScanner } from './src/sourcePipeline.js';
import { createLocalOriginGuard } from './src/httpSecurity.js';
import { ensureSkillRegistrySynced, pinProjectSkill, promoteSkillRevision, readSkillAuditTrail, readSkillPin, readSkillRevisions, rollbackSkillRevision, unpinProjectSkill } from './src/skillRegistry.js';
import { ClaudeCodeStructuredExtractionProvider } from './src/extractionProvider.js';
import { ClaudeCodeGroundedBriefProvider } from './src/briefProvider.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT ?? 4318);
const production = process.argv.includes('--production');
const demoMode = process.env.PROJECTMANAGAIR_DEMO === '1';
const demoEnvironment = 'Fictional demo data';
const databaseEnvironment = 'SQLite operational database';

let dbContext: ReturnType<typeof openProjectManagairDatabase> | null = null;
let fixture: ReturnType<typeof portfolioFixtureSchema.parse> | null = null;

if (demoMode) {
  const fixturePath = path.join(root, 'fixtures', 'portfolio.json');
  const rawFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  fixture = portfolioFixtureSchema.parse(rawFixture);
} else {
  dbContext = openProjectManagairDatabase();
}

function db() {
  if (!dbContext) throw new Error('Database did not initialise');
  return dbContext.db;
}

const structuredExtractionProvider = new ClaudeCodeStructuredExtractionProvider();
const groundedBriefProvider = new ClaudeCodeGroundedBriefProvider();
let extractionWorker = Promise.resolve();

function scheduleSourceExtraction(sourceId: string) {
  const source = db().prepare('SELECT id, project_id, intake_source_id, content_hash FROM source_documents WHERE id = ?').get(sourceId) as { id: string; project_id: string; intake_source_id: string | null; content_hash: string } | undefined;
  if (!source) return;
  // Re-probe before declaring the provider unavailable: installing the CLI
  // must not require a server restart.
  structuredExtractionProvider.refresh?.();
  if (!structuredExtractionProvider.isAvailable()) {
    const timestamp = new Date().toISOString();
    const jobId = `source-job:${source.project_id}:${source.content_hash.slice(0, 16)}`;
    db().prepare("UPDATE source_processing_jobs SET status = 'queued', current_stage = 'awaiting-provider', updated_at = ?, error_message = ? WHERE id = ?")
      .run(timestamp, 'Local structured extraction provider is unavailable; deterministic source evidence remains available.', jobId);
    db().prepare("UPDATE project_source_intake SET processing_status = 'awaiting_processing', processing_stage = 'awaiting-provider', processing_error = ?, processing_recovery_action = ?, processing_updated_at = ?, updated_at = ? WHERE id = ?")
      .run('Local structured extraction provider is unavailable.', 'Install or sign in to the local Claude CLI, then retry this source from the Cockpit.', timestamp, timestamp, source.intake_source_id);
    return;
  }
  // `runSourceExtractionJob` resolves rather than rejecting: every failure path
  // records a readable reason and a recovery action on the job and intake rows
  // before returning. Nothing is swallowed.
  extractionWorker = extractionWorker.then(async () => {
    const result = await runSourceExtractionJob(db(), {
      sourceId,
      provider: structuredExtractionProvider,
      onEvent: (event) => console.log('[source-pipeline]', JSON.stringify(event)),
    });
    if (!result.ok) console.error(`[source-pipeline] ${result.status}: ${result.message ?? 'no message'} -> ${result.recoveryAction ?? 'no recovery action recorded'}`);
  });
  void extractionWorker;
}

async function enqueueSourceFile(projectId: string, file: IntakeFileInput) {
  const result = await createLifecycleSourceEnqueuer(db())(projectId, file);
  if (!result.duplicate && typeof result.sourceId === 'string') scheduleSourceExtraction(result.sourceId);
  return result;
}

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

const inboxWatchers = new Map<string, WatchedInboxScanner>();

function ensureInboxWatcher(projectId: string, externalPath: string | null) {
  if (demoMode || !externalPath || inboxWatchers.has(projectId)) return;
  const inboxPath = path.join(externalPath, '00_Inbox', 'Unsorted');
  // A missing inbox folder is no longer a silent drop: OneDrive is frequently
  // still mounting at startup, and the previous guard meant that project was
  // never watched again until someone restarted the server.
  const scanner = new WatchedInboxScanner({
    projectId,
    inboxPath,
    enqueue: enqueueSourceFile,
    isKnownHash: (contentHash) => Boolean(db().prepare('SELECT 1 FROM project_source_intake WHERE project_id = ? AND content_hash = ? LIMIT 1').get(projectId, contentHash)),
    onEvents: (events) => {
      for (const event of events) {
        if (['failed', 'abandoned', 'inbox-missing', 'inbox-ready', 'refused'].includes(String(event.status))) console.warn('[inbox-watcher]', JSON.stringify(event));
      }
    },
  });
  scanner.start();
  inboxWatchers.set(projectId, scanner);
}

function startInboxWatchers() {
  if (demoMode) return;
  const projects = db().prepare('SELECT id, external_path FROM projects WHERE external_path IS NOT NULL').all() as Array<{ id: string; external_path: string | null }>;
  for (const project of projects) ensureInboxWatcher(project.id, project.external_path);
}
app.disable('x-powered-by');
// Loopback is not a security boundary against a page the user visits: a
// DNS-rebinding site is same-origin to the browser. Host and Origin are checked
// before any body is parsed.
app.use(createLocalOriginGuard({ ports: [port] }));
app.use(express.json({ limit: '32mb' }));
app.use((_, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const contentSecurityPolicy = production
    ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  response.setHeader('Content-Security-Policy', contentSecurityPolicy);
  next();
});

app.get('/api/health', (_, response) => {
  if (demoMode && fixture) {
    response.json({ ok: true, mode: 'demo-fixtures', projects: fixture.projects.length });
    return;
  }
  if (!dbContext) {
    response.status(500).json({ ok: false, error: 'Database did not initialise' });
    return;
  }
  const portfolio = readPortfolioData(dbContext.db);
  response.json({ ok: true, mode: 'sqlite-operational', dbPath: dbContext.dbPath, migrationsApplied: dbContext.migrationsApplied, projects: portfolio.projects.length, m365: authStatus(), aiProviders: probeAIProviders() });
});

app.get('/api/portfolio', (_, response) => {
  if (demoMode && fixture) {
    response.json(buildPortfolioResponse(fixture, new Date(), demoEnvironment));
    return;
  }
  response.json(buildPortfolioResponse(readPortfolioData(db()), new Date(), databaseEnvironment));
});

app.get('/api/project-storage/settings', asyncRoute(async (_, response) => response.json(await readStorageSettings(db()))));
app.post('/api/project-storage/settings', asyncRoute(async (request, response) => response.json(await updateStorageSettings(db(), request.body as { projectsRoot?: string; projectFolderNamingFormat?: string }))));
app.post('/api/project-storage/verify', asyncRoute(async (request, response) => response.json(await verifyStorageRoot(db(), Boolean((request.body as { writeTest?: boolean }).writeTest)))));

app.post('/api/projects', asyncRoute(async (request, response) => {
  const result = createProject(db(), request.body as Parameters<typeof createProject>[1]);
  ensureInboxWatcher(result.projectId, result.externalPath);
  response.status(201).json(result);
}));
app.get('/api/projects/:projectId', (request, response) => {
  if (demoMode && fixture) {
    const result = buildProjectResponse(fixture, request.params.projectId, new Date(), demoEnvironment);
    if (!result) {
      response.status(404).json({ error: 'Project not found' });
      return;
    }
    response.json(result);
    return;
  }
  const data = readProjectData(db(), request.params.projectId);
  if (!data) {
    response.status(404).json({ error: 'Project not found' });
    return;
  }
  response.json(buildProjectResponse(data, request.params.projectId, new Date(), databaseEnvironment));
});

app.post('/api/projects/:projectId/register-imports', asyncRoute(async (request, response) => {
  const body = request.body as { benchmarkFile?: { name: string; dataBase64: string }; workbookFile?: { name: string; dataBase64: string } };
  if (!body.benchmarkFile) {
    response.status(400).json({ error: 'benchmarkFile is required.' });
    return;
  }
  response.status(201).json(importProjectRegisterBenchmark(db(), String(request.params.projectId), { benchmarkFile: body.benchmarkFile, workbookFile: body.workbookFile }));
}));
app.post('/api/projects/:projectId/blind-extractions', asyncRoute(async (request, response) => {
  const body = request.body as { sourceFile?: { name: string; type?: string; dataBase64: string }; frozenPacket?: Parameters<typeof recordBlindExtractionPacket>[2]['frozenPacket'] };
  if (!body.sourceFile || !body.frozenPacket) {
    response.status(400).json({ error: 'sourceFile and frozenPacket are required.' });
    return;
  }
  response.status(201).json(recordBlindExtractionPacket(db(), String(request.params.projectId), { sourceFile: body.sourceFile, frozenPacket: body.frozenPacket }));
}));
app.post('/api/projects/:projectId/blind-extraction-comparisons', asyncRoute(async (request, response) => {
  const body = request.body as { frozenPacketFile?: { name: string; dataBase64: string }; expectedDeltaFile?: { name: string; dataBase64: string }; expectedWorkbookFile?: { name: string; dataBase64: string } };
  if (!body.frozenPacketFile || !body.expectedDeltaFile) {
    response.status(400).json({ error: 'frozenPacketFile and expectedDeltaFile are required.' });
    return;
  }
  response.status(201).json(compareBlindExtractionToBenchmark(db(), String(request.params.projectId), { frozenPacketFile: body.frozenPacketFile, expectedDeltaFile: body.expectedDeltaFile, expectedWorkbookFile: body.expectedWorkbookFile }));
}));
app.post('/api/projects/:projectId/sources', asyncRoute(async (request, response) => {
  const body = request.body as { files?: Array<{ name: string; type?: string; dataBase64: string }> };
  const files = Array.isArray(body.files) ? body.files : [];
  response.status(201).json({ results: await Promise.all(files.map((file) => enqueueSourceFile(String(request.params.projectId), file))) });
}));
app.get('/api/projects/:projectId/source-intelligence', (request, response) => response.json(readSourceIntelligence(db(), String(request.params.projectId))));
app.post('/api/projects/:projectId/extraction-packets', asyncRoute(async (request, response) => response.status(201).json(freezePacketAndCreateChangeset(db(), request.body))));
app.post('/api/projects/:projectId/changesets/:changesetId/review', asyncRoute(async (request, response) => {
  const body = request.body as { reviewer?: string; decision?: 'accept' | 'reject'; opIds?: string[]; batch?: boolean; note?: string; decisions?: Array<{ operationId: string; status: 'accepted' | 'rejected'; note?: string }> };
  const reviewer = String(body.reviewer ?? 'current-user');
  if (Array.isArray(body.decisions)) {
    const accepted = body.decisions.filter((item) => item.status === 'accepted');
    const rejected = body.decisions.filter((item) => item.status === 'rejected');
    const results = [];
    if (accepted.length) results.push(reviewChangeset(db(), String(request.params.changesetId), { decision: 'accept', reviewer, opIds: accepted.map((item) => item.operationId), batch: Boolean(body.batch), note: accepted.map((item) => item.note).filter(Boolean).join('; ') || null }));
    if (rejected.length) results.push(reviewChangeset(db(), String(request.params.changesetId), { decision: 'reject', reviewer, opIds: rejected.map((item) => item.operationId), batch: Boolean(body.batch), note: rejected.map((item) => item.note).filter(Boolean).join('; ') || null }));
    response.json({ changesetId: String(request.params.changesetId), results });
    return;
  }
  if (!body.decision) { response.status(400).json({ error: 'decision or decisions is required.' }); return; }
  response.json(reviewChangeset(db(), String(request.params.changesetId), { decision: body.decision, reviewer, opIds: body.opIds, batch: body.batch, note: body.note ?? null }));
}));
app.post('/api/projects/:projectId/changesets/:changesetId/apply', asyncRoute(async (request, response) => response.json(applyReviewedChangeset(db(), String(request.params.changesetId)))));
app.post('/api/projects/:projectId/packets/:packetId/replay', asyncRoute(async (request, response) => response.json(replayPacket(db(), String(request.params.packetId)))));
app.post('/api/projects/:projectId/register-rows/:externalRegisterId/events', asyncRoute(async (request, response) => {
  const body = request.body as { actor?: string; eventType?: string; field?: string | null; newValue?: string | null; reason?: string; evidenceRef?: string | null; occurredAt?: string };
  if (!body.eventType || !body.reason) { response.status(400).json({ error: 'eventType and reason are required.' }); return; }
  response.status(201).json(recordRegisterEvent(db(), String(request.params.projectId), String(request.params.externalRegisterId), { actor: String(body.actor ?? 'current-user'), eventType: body.eventType, field: body.field, newValue: body.newValue, reason: body.reason, evidenceRef: body.evidenceRef, occurredAt: body.occurredAt }));
}));
app.post('/api/projects/:projectId/sources/:sourceId/retry', asyncRoute(async (request, response) => {
  const result = await retrySourceJob(db(), { sourceId: String(request.params.sourceId), provider: structuredExtractionProvider });
  response.status(result.status === 'lease-held' ? 409 : 200).json(result);
}));
app.post('/api/projects/:projectId/sources/:sourceId/skip', asyncRoute(async (request, response) => {
  const body = request.body as { reason?: string; markerDismissals?: Array<{ markerId: string; reason: string }> };
  if (!body.reason || !String(body.reason).trim()) { response.status(400).json({ error: 'reason is required to skip a source after comprehension.' }); return; }
  response.json(skipSourceAfterComprehension(db(), { sourceId: String(request.params.sourceId), reason: String(body.reason), markerDismissals: body.markerDismissals }));
}));
app.post('/api/projects/:projectId/changesets/:changesetId/acknowledge', asyncRoute(async (request, response) => {
  response.json(acknowledgeChangeset(db(), String(request.params.changesetId), String((request.body as { actor?: string }).actor ?? 'current-user')));
}));
app.post('/api/projects/:projectId/overview/pin', asyncRoute(async (request, response) => {
  const mode = (request.body as { mode?: 'changes' | 'meeting' | 'needs-warwick' | null }).mode ?? null;
  response.json(pinOverviewMode(db(), String(request.params.projectId), mode, 'current-user'));
}));
app.post('/api/projects/:projectId/consultant-brief', asyncRoute(async (request, response) => response.json(await buildConsultantBrief(db(), String(request.params.projectId), String((request.body as { mode?: string }).mode ?? 'needs-warwick'), groundedBriefProvider))));
app.post('/api/proposed-changes/:proposedChangeId/approve', asyncRoute(async (request, response) => response.json(approveProposedChange(db(), String(request.params.proposedChangeId), String((request.body as { reviewer?: string }).reviewer ?? 'current-user')))));
app.post('/api/proposed-changes/:proposedChangeId/reject', asyncRoute(async (request, response) => response.json(rejectProposedChange(db(), String(request.params.proposedChangeId), String((request.body as { reviewer?: string }).reviewer ?? 'current-user')))));
app.post('/api/files/open', asyncRoute(async (request, response) => response.json(openOriginalPath(db(), String((request.body as { path?: string }).path ?? '')))));
app.get('/api/m365/status', (_, response) => response.json({ ...authStatus(), scopes: requiredScopes(), aiProviders: probeAIProviders() }));
app.post('/api/m365/auth/start', asyncRoute(async (_, response) => response.json(await startDeviceCode())));
app.post('/api/m365/auth/poll', asyncRoute(async (_, response) => response.json(await pollDeviceCode(db()))));

app.get('/api/today', asyncRoute(async (request, response) => {
  const now = new Date();
  const start = typeof request.query.start === 'string' ? request.query.start : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = typeof request.query.end === 'string' ? request.query.end : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7)).toISOString();
  const refresh = request.query.refresh === '1';
  response.json(refresh ? await syncCalendarView(db(), start, end) : readCalendarProjection(db(), start, end));
}));

app.post('/api/today/refresh', asyncRoute(async (request, response) => {
  const body = request.body as { start?: string; end?: string };
  response.json(await syncCalendarView(db(), body.start ?? new Date().toISOString(), body.end ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()));
}));

app.get('/api/inbox', asyncRoute(async (request, response) => response.json(request.query.refresh === '1' ? await syncInbox(db()) : readInboxProjection(db()))));
app.post('/api/inbox/refresh', asyncRoute(async (_, response) => response.json(await syncInbox(db()))));
app.post('/api/inbox/:graphId/read-state', asyncRoute(async (request, response) => {
  const body = request.body as { isRead?: boolean };
  response.json(await markMessageRead(db(), String(request.params.graphId), Boolean(body.isRead)));
}));
app.post('/api/inbox/:graphId/delete', asyncRoute(async (request, response) => response.json(await moveMessageToDeletedItems(db(), String(request.params.graphId)))));

app.get('/api/extraction-skills', (request, response) => response.json({ revisions: readSkillRevisions(db(), typeof request.query.skillId === 'string' ? request.query.skillId : undefined) }));
app.get('/api/extraction-skills/audit', (request, response) => response.json({ events: readSkillAuditTrail(db(), { skillId: typeof request.query.skillId === 'string' ? request.query.skillId : undefined, projectId: typeof request.query.projectId === 'string' ? request.query.projectId : undefined }) }));
app.post('/api/extraction-skills/promote', asyncRoute(async (request, response) => {
  const body = request.body as { skillId?: string; version?: string; actor?: string; note?: string };
  if (!body.version) { response.status(400).json({ error: 'version is required.' }); return; }
  response.json(promoteSkillRevision(db(), { skillId: body.skillId, version: body.version, actor: String(body.actor ?? 'current-user'), note: body.note }));
}));
app.post('/api/extraction-skills/rollback', asyncRoute(async (request, response) => {
  const body = request.body as { skillId?: string; toVersion?: string; actor?: string; note?: string };
  if (!body.toVersion) { response.status(400).json({ error: 'toVersion is required.' }); return; }
  response.json(rollbackSkillRevision(db(), { skillId: body.skillId, toVersion: body.toVersion, actor: String(body.actor ?? 'current-user'), note: body.note }));
}));
app.get('/api/projects/:projectId/extraction-skill', (request, response) => response.json({ pin: readSkillPin(db(), String(request.params.projectId)) }));
app.post('/api/projects/:projectId/extraction-skill/pin', asyncRoute(async (request, response) => {
  const body = request.body as { skillId?: string; version?: string; actor?: string; note?: string };
  if (!body.version) { response.status(400).json({ error: 'version is required.' }); return; }
  response.json(pinProjectSkill(db(), { projectId: String(request.params.projectId), skillId: body.skillId, version: body.version, actor: String(body.actor ?? 'current-user'), note: body.note }));
}));
app.post('/api/projects/:projectId/extraction-skill/unpin', asyncRoute(async (request, response) => response.json(unpinProjectSkill(db(), { projectId: String(request.params.projectId), skillId: (request.body as { skillId?: string }).skillId, actor: String((request.body as { actor?: string }).actor ?? 'current-user') }))));
app.get('/api/ai/providers', (_, response) => response.json({ providers: probeAIProviders() }));
app.post('/api/ai/chat', asyncRoute(async (request, response) => response.json(await sendChatMessage(db(), request.body))));

app.use('/api', (request, response) => {
  if (!['GET', 'POST'].includes(request.method)) {
    response.status(405).json({ error: 'Read-only Cockpit except explicit Graph-backed mailbox actions: mutation method is not available' });
    return;
  }
  response.status(404).json({ error: 'API route not found' });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(500).json({ error: error instanceof Error ? error.message : 'Unknown server error' });
});

if (production) {
  const dist = path.join(root, 'dist');
  app.use(express.static(dist));
  app.use((_, response) => response.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

if (!demoMode) ensureSkillRegistrySynced(db());
startInboxWatchers();

// Crash recovery: reclaim any job whose lease expired while the process was
// down, then keep sweeping. Without this a job interrupted mid-extraction stayed
// `processing` forever and re-uploading the file hit the content-hash dedup.
if (!demoMode) {
  startSourceJobSweeper(db(), {
    onReclaim: (jobs) => { if (jobs.length) console.warn('[source-pipeline] reclaimed stalled jobs', JSON.stringify(jobs)); },
  });
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Project ManagAIr Cockpit running at http://127.0.0.1:${port}`);
  if (demoMode) {
    console.log('Mode: explicit fictional demo data, read-only, loopback-only');
  } else {
    console.log(`Mode: SQLite operational database, M365 projection enabled, loopback-only, db=${dbContext?.dbPath}`);
  }
});
