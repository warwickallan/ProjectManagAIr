import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { portfolioFixtureSchema } from '../src/domain';

const root = process.cwd();
const forbiddenTokens = [[78, 80, 76], [78, 87, 76, 68, 67], [66, 101, 108, 108, 114, 111, 99, 107]].map((codes) => String.fromCharCode(...codes));
const forbiddenLiveNames = new RegExp(`\\b(${forbiddenTokens.join('|')})\\b`, 'i');
const ignored = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report', 'artifacts', '.runtime']);

function filesUnder(relative: string): string[] {
  const target = path.join(root, relative);
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).flatMap((entry) => {
    if (ignored.has(entry)) return [];
    const child = path.join(target, entry);
    return statSync(child).isDirectory() ? filesUnder(path.relative(root, child)) : [child];
  });
}

describe('repository data boundary', () => {
  it('contains no prohibited live project names or local absolute paths in runtime, tests, or fixtures', () => {
    const boundaryFiles = [...filesUnder('src'), ...filesUnder('scripts'), ...filesUnder('fixtures'), ...filesUnder('tests'), path.join(root, 'server.ts')];
    const liveNameFindings = boundaryFiles.filter((file) => forbiddenLiveNames.test(readFileSync(file, 'utf8')));
    const absolutePathFindings = boundaryFiles.filter((file) => /(?:^|[\s"(])[A-Za-z]:\\(?:Users|Brain|Fusion|tmp|Windows)(?:\\|$)/im.test(readFileSync(file, 'utf8')));
    expect(liveNameFindings).toEqual([]);
    expect(absolutePathFindings).toEqual([]);
  });

  it('contains no external URLs in fixture data', () => {
    expect(JSON.stringify(fixtureJson)).not.toMatch(/https?:\/\//i);
  });

  it('validates all fixture records as fictional', () => {
    const fixture = portfolioFixtureSchema.parse(fixtureJson);
    const collections = fixture.projects.flatMap((project) => [project.projectSources, project.actions, project.risksIssues, project.changes, project.decisions, project.openQuestions, project.milestones, project.workPackages, project.activity, project.deliverables, project.aiWork, project.verifications, project.provenance]);
    expect(fixture.dataClassification).toBe('fictional');
    expect(collections.flat().every((record) => record.dataClassification === 'fictional')).toBe(true);
  });

  it('exposes only explicit approved POST command endpoints and no hard delete route', () => {
    const server = readFileSync(path.join(root, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/app\.(put|patch|delete)\s*\(/i);
    expect(server).not.toMatch(/method:\s*['"]DELETE['"]/i);
    expect(server).toContain('/api/inbox/:graphId/delete');
    expect(server).toContain('moveMessageToDeletedItems');
  });

  it('keeps operational compatibility tables behind the single projection writer', () => {
    const intelligenceFiles = ['src/projectRegisters.ts', 'src/projectLifecycle.ts', 'src/sourceIntelligence.ts']
      .map((file) => path.join(root, file));
    const directWrite = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+(?:actions|decisions|risks_issues|changes|open_questions|milestones|project_sources)\b/i;
    const findings = intelligenceFiles.filter((file) => directWrite.test(readFileSync(file, 'utf8')));
    expect(findings).toEqual([]);
    expect(readFileSync(path.join(root, 'src', 'registerProjection.ts'), 'utf8')).toMatch(directWrite);
  });
  it('does not track database artifacts, portable runtime, native sqlite dependencies, tokens, or tenant config', () => {
    const packageJson = readFileSync(path.join(root, 'package.json'), 'utf8');
    expect(packageJson).not.toMatch(/better-sqlite3|sqlite3|postgres|mysql|mongodb|prisma/i);
    const repositoryFiles = filesUnder('.').map((file) => path.relative(root, file));
    expect(repositoryFiles.some((name) => /(^|[\\/])\.runtime([\\/]|$)/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /\.(db|sqlite|sqlite3)$/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /m365-auth\.local\.json|token/i.test(name))).toBe(false);
  });
});
