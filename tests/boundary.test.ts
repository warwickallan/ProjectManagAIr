import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { portfolioFixtureSchema } from '../src/domain';

const root = process.cwd();
const forbiddenLiveNames = /\b(NPL|NWLDC|Bellrock)\b/i;
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
  it('contains no prohibited live project names in runtime source or fixtures', () => {
    const runtimeFiles = [...filesUnder('src'), ...filesUnder('scripts'), ...filesUnder('fixtures'), path.join(root, 'server.ts')];
    const findings = runtimeFiles.filter((file) => forbiddenLiveNames.test(readFileSync(file, 'utf8')));
    expect(findings).toEqual([]);
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

  it('exposes no mutation endpoint implementation', () => {
    const server = readFileSync(path.join(root, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/app\.(post|put|patch|delete)\s*\(/i);
    expect(server).not.toContain('express.json(');
  });

  it('does not track database artifacts, portable runtime, or native sqlite dependencies', () => {
    const packageJson = readFileSync(path.join(root, 'package.json'), 'utf8');
    expect(packageJson).not.toMatch(/better-sqlite3|sqlite3|postgres|mysql|mongodb|prisma/i);
    const repositoryFiles = filesUnder('.').map((file) => path.relative(root, file));
    expect(repositoryFiles.some((name) => /(^|[\\/])\.runtime([\\/]|$)/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /\.(db|sqlite|sqlite3)$/i.test(name))).toBe(false);
  });
});
