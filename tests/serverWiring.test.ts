import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The HTTP guard is thoroughly unit-tested as a pure function, but its POLICY
 * being correct is worthless if it is not installed. Deleting the `app.use` line
 * left the whole suite green, so a HIGH-severity control could be removed, or
 * reordered after the body parser, with CI passing.
 *
 * These assert the wiring itself, in order, from the server source.
 */
const server = readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
const indexOf = (needle: string) => {
  const at = server.indexOf(needle);
  expect(at, `server.ts should contain ${needle}`).toBeGreaterThan(-1);
  return at;
};

describe('server wiring of security-critical middleware', () => {
  it('mounts the loopback origin guard', () => {
    expect(server).toContain("import { createLocalOriginGuard } from './src/httpSecurity.js'");
    expect(server).toMatch(/app\.use\(createLocalOriginGuard\(/);
  });

  it('mounts the guard before any request body is parsed', () => {
    expect(indexOf('app.use(createLocalOriginGuard(')).toBeLessThan(indexOf('app.use(express.json('));
  });

  it('passes the listening port to the guard so the E2E server is allowed', () => {
    expect(server).toMatch(/createLocalOriginGuard\(\{\s*ports:\s*\[port\]\s*\}\)/);
  });

  it('starts crash recovery and the skill registry at boot', () => {
    expect(server).toMatch(/startSourceJobSweeper\(/);
    expect(server).toMatch(/ensureSkillRegistrySynced\(/);
  });

  it('does not swallow worker failures', () => {
    expect(server).not.toContain('.catch(() => undefined)');
  });
});

/**
 * The zero-call guarantee is a wiring property before it is anything else. A GET
 * that can reach `generateConsultantView` is a GET that can spend money, however
 * carefully the function itself is written.
 */
describe('server wiring of the consultant views', () => {
  it('reaches generation from POST only', () => {
    const generateAt = indexOf('generateConsultantView(');
    const getHandler = server.slice(indexOf("app.get('/api/projects/:projectId/consultant-view'"), indexOf("app.post('/api/projects/:projectId/consultant-view'"));
    expect(getHandler).toContain('readConsultantView(');
    expect(getHandler).not.toContain('generateConsultantView(');
    expect(generateAt).toBeGreaterThan(-1);
  });

  it('never generates from the project payload', () => {
    const db = readFileSync(path.join(process.cwd(), 'src', 'db.ts'), 'utf8');
    // `readProjectData` is what opening a project, changing a tab and
    // refreshing the page all run. It may build the deterministic views and
    // nothing else.
    expect(db).toContain('buildDeterministicConsultantView');
    expect(db).not.toContain('generateConsultantView');
    expect(db).not.toContain('buildConsultantBrief');
  });

  it('exposes the prompt-management surface Settings needs', () => {
    for (const route of [
      "app.get('/api/extraction-skills'",
      "app.get('/api/extraction-skills/compare'",
      "app.post('/api/extraction-skills/validate'",
      "app.post('/api/extraction-skills/drafts'",
      "app.post('/api/extraction-skills/promote'",
      "app.post('/api/extraction-skills/rollback'",
      "app.post('/api/extraction-skills/retire'",
      "app.get('/api/extraction-skills/:skillId/versions/:version'",
      "app.get('/api/extraction-skills/:skillId/versions/:version/download'",
      "app.get('/api/extraction-skills/:skillId/versions/:version/runs'",
      "app.get('/api/extraction-runs/:runId/provenance'",
      "app.get('/api/projects/:projectId/sources/:sourceId/provider-outputs'",
    ]) {
      expect(server, `server.ts should route ${route}`).toContain(route);
    }
  });

  it('routes the build finaliser through the one engine, and reads without pushing', () => {
    for (const route of [
      "app.get('/api/build-handoffs'",
      "app.post('/api/build-handoffs/finalize'",
      "app.post('/api/build-handoffs/connect-drive'",
    ]) {
      expect(server, `server.ts should route ${route}`).toContain(route);
    }
    // The GET must be a filesystem read: opening Settings cannot push anything.
    const getHandler = server.slice(indexOf("app.get('/api/build-handoffs'"), indexOf("app.post('/api/build-handoffs/finalize'"));
    expect(getHandler).toContain('readBuildHandoffs(');
    expect(getHandler).not.toContain('finalizeBuild(');
    // The POST guards the supplied path against the handoffs this machine offers.
    const postHandler = server.slice(indexOf("app.post('/api/build-handoffs/finalize'"), indexOf("app.post('/api/build-handoffs/connect-drive'"));
    expect(postHandler).toContain('isKnownManifestPath(');
    expect(postHandler).toContain('finalizeBuild(');
    // And no Git command is issued from this file or from the UI: both delegate
    // to the engine. Matched on what would actually run a process, not on prose
    // — the comment above this route mentions `git push` on purpose.
    const panel = readFileSync(path.join(process.cwd(), 'src', 'BuildHandoffsPanel.tsx'), 'utf8');
    for (const source of [server, panel]) {
      expect(source).not.toMatch(/(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|runCommand)\(\s*['"`]git['"`]/);
      expect(source).not.toMatch(/\[\s*['"`](?:push|ls-remote|bundle|rev-parse)['"`]\s*,/);
    }
  });

  it('serves no route that returns skill or prompt text from a run', () => {
    // A revision body is a reusable template and may be served. An ASSEMBLED
    // prompt contains customer source windows and must not be, in any form.
    expect(server).not.toMatch(/prompt_json|assembled_prompt|promptText/);
  });
});
