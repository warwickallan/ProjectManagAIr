import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { importProjectPayload, openProjectManagairDatabase } from '../src/db.js';
import { portfolioFixtureSchema } from '../src/domain.js';

process.env.NODE_ENV = 'test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dbPath = process.env.PROJECTMANAGAIR_DB_PATH ?? path.join(repoRoot, 'artifacts', 'e2e-projectmanagair.db');
const artifactsDir = path.join(repoRoot, 'artifacts');
const resolvedDb = path.resolve(dbPath);

if (!resolvedDb.startsWith(path.resolve(artifactsDir))) {
  throw new Error(`Refusing to reset an e2e database outside ${artifactsDir}`);
}

mkdirSync(path.dirname(resolvedDb), { recursive: true });
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(`${resolvedDb}${suffix}`, { force: true });
}

process.env.PROJECTMANAGAIR_DB_PATH = resolvedDb;
process.env.PROJECTMANAGAIR_M365_CONFIG = path.join(artifactsDir, 'missing-m365-auth.local.json');
const fixture = portfolioFixtureSchema.parse(fixtureJson);
const context = openProjectManagairDatabase(resolvedDb);
try {
  for (const project of fixture.projects) {
    importProjectPayload(context.db, { schemaVersion: 1, source: { label: 'Fictional e2e fixture' }, project });
  }
} finally {
  context.db.close();
}

await import('../server.js');
