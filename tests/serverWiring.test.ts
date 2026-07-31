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
