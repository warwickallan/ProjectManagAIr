import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from './src/domain.js';
import { openProjectManagairDatabase, readPortfolioData, readProjectData } from './src/db.js';

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

app.disable('x-powered-by');
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
  response.json({ ok: true, mode: 'sqlite-read-only', dbPath: dbContext.dbPath, migrationsApplied: dbContext.migrationsApplied, projects: portfolio.projects.length });
});

app.get('/api/portfolio', (_, response) => {
  if (demoMode && fixture) {
    response.json(buildPortfolioResponse(fixture, new Date(), demoEnvironment));
    return;
  }
  if (!dbContext) {
    response.status(500).json({ error: 'Database did not initialise' });
    return;
  }
  response.json(buildPortfolioResponse(readPortfolioData(dbContext.db), new Date(), databaseEnvironment));
});

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
  if (!dbContext) {
    response.status(500).json({ error: 'Database did not initialise' });
    return;
  }
  const data = readProjectData(dbContext.db, request.params.projectId);
  if (!data) {
    response.status(404).json({ error: 'Project not found' });
    return;
  }
  response.json(buildProjectResponse(data, request.params.projectId, new Date(), databaseEnvironment));
});

app.use('/api', (request, response) => {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Read-only Cockpit: mutation methods are not available' });
    return;
  }
  response.status(404).json({ error: 'API route not found' });
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
    console.log(`Mode: SQLite operational database, read-only, loopback-only, db=${dbContext?.dbPath}`);
  }
});
