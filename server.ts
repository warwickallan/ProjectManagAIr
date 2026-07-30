import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from './src/domain.js';
import { openProjectManagairDatabase, readPortfolioData, readProjectData } from './src/db.js';
import { approveProposedChange, createProject, intakeProjectSource, openOriginalPath, readStorageSettings, recordBlindExtractionPacket, rejectProposedChange, updateStorageSettings, verifyStorageRoot } from './src/projectLifecycle.js';
import { authStatus, markMessageRead, moveMessageToDeletedItems, pollDeviceCode, readCalendarProjection, readInboxProjection, requiredScopes, startDeviceCode, syncCalendarView, syncInbox } from './src/m365.js';
import { probeAIProviders, sendChatMessage } from './src/aiProvider.js';
import { compareBlindExtractionToBenchmark } from './src/blindExtractionComparison.js';
import { importProjectRegisterBenchmark } from './src/projectRegisters.js';

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

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

app.disable('x-powered-by');
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
  response.status(201).json({ results: await Promise.all(files.map((file) => intakeProjectSource(db(), String(request.params.projectId), file))) });
}));
app.post('/api/proposed-changes/:proposedChangeId/approve', asyncRoute(async (request, response) => response.json(approveProposedChange(db(), String(request.params.proposedChangeId), String((request.body as { reviewer?: string }).reviewer ?? 'Warwick')))));
app.post('/api/proposed-changes/:proposedChangeId/reject', asyncRoute(async (request, response) => response.json(rejectProposedChange(db(), String(request.params.proposedChangeId), String((request.body as { reviewer?: string }).reviewer ?? 'Warwick')))));
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

app.listen(port, '127.0.0.1', () => {
  console.log(`Project ManagAIr Cockpit running at http://127.0.0.1:${port}`);
  if (demoMode) {
    console.log('Mode: explicit fictional demo data, read-only, loopback-only');
  } else {
    console.log(`Mode: SQLite operational database, M365 projection enabled, loopback-only, db=${dbContext?.dbPath}`);
  }
});
