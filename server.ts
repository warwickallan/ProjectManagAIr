import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from './src/domain.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(root, 'fixtures', 'portfolio.json');
const rawFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
const fixture = portfolioFixtureSchema.parse(rawFixture);
const app = express();
const port = Number(process.env.PORT ?? 4318);
const production = process.argv.includes('--production');

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
  response.json({ ok: true, mode: 'fictional-read-only', projects: fixture.projects.length });
});

app.get('/api/portfolio', (_, response) => {
  response.json(buildPortfolioResponse(fixture));
});

app.get('/api/projects/:projectId', (request, response) => {
  const result = buildProjectResponse(fixture, request.params.projectId);
  if (!result) {
    response.status(404).json({ error: 'Project not found' });
    return;
  }
  response.json(result);
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
  console.log('Mode: fictional fixture data, read-only, loopback-only');
});
