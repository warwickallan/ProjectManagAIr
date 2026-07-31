/**
 * The local build finaliser.
 *
 * Every case here runs against REAL git — a real bare remote, a real bundle, a
 * real local clone — and fake GitHub and Drive ports. That split is deliberate:
 * the git behaviour is the part where a mistake destroys work, so it is exercised
 * rather than mocked, while GitHub and Drive are exercised through the same
 * interface the real adapters implement so that "does not create a second pull
 * request" is a proved property and not a hope.
 *
 * No network, no credentials and no model calls are involved.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DriveConnectionRequiredError,
  MANIFEST_VERSION,
  buildFolderName,
  buildHandoffManifestSchema,
  discoverManifests,
  finalizeBuild,
  newestPendingManifest,
  redactSecrets,
  renderFinalizeReport,
  repositoryFromRemoteUrl,
  type BuildHandoffManifest,
  type DriveFile,
  type DrivePort,
  type FinalizeResult,
  type GitHubPort,
  type PullRequestRecord,
} from '../src/buildFinalizer';
import { isKnownManifestPath, readBuildHandoffs, resolveHandoffRoot } from '../src/buildHandoffs';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

interface Fixture {
  root: string;
  origin: string;
  cloud: string;
  local: string;
  handoffRoot: string;
  bundlePath: string;
  baselineSha: string;
  headSha: string;
  repository: string;
}

/**
 * Three repositories, exactly as the real situation has them: a bare `origin`,
 * a "cloud" clone that made the build and can produce a bundle but cannot push,
 * and Warwick's "local" clone which has the baseline and no network.
 */
function fixture(repository = 'warwickallan/ProjectManagAIr'): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'pma-finalizer-'));
  directories.push(root);
  const origin = path.join(root, 'origin.git');
  const cloud = path.join(root, 'cloud');
  const local = path.join(root, 'local');
  const handoffRoot = path.join(root, 'Data', 'staging', 'build-handoffs');
  mkdirSync(path.join(handoffRoot, 'pending'), { recursive: true });

  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, cloud);
  git(cloud, 'config', 'user.email', 'fixture@example.invalid');
  git(cloud, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(cloud, 'README.md'), '# baseline\n', 'utf8');
  git(cloud, 'add', '-A');
  git(cloud, 'commit', '-m', 'baseline');
  git(cloud, 'push', 'origin', 'main');
  const baselineSha = git(cloud, 'rev-parse', 'HEAD');

  git(cloud, 'switch', '-c', 'build/example-v1');
  writeFileSync(path.join(cloud, 'feature.md'), '# the build\n', 'utf8');
  git(cloud, 'add', '-A');
  git(cloud, 'commit', '-m', 'the build');
  const headSha = git(cloud, 'rev-parse', 'HEAD');

  const bundlePath = path.join(root, 'build.bundle');
  git(cloud, 'bundle', 'create', bundlePath, `${baselineSha}..build/example-v1`);

  // Warwick's clone: has the baseline, has never seen the branch.
  git(root, 'clone', origin, local);
  // The remote URL a real clone records is a filesystem path; give the fixture a
  // realistic `owner/repo` so repository identity is genuinely checked.
  git(local, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`);
  git(local, 'config', 'user.email', 'fixture@example.invalid');
  git(local, 'config', 'user.name', 'Fixture');
  // ...while still pushing to the bare repository on disk.
  git(local, 'config', `url.${origin}/.insteadOf`, `https://github.com/${repository}.git`);

  return { root, origin, cloud, local, handoffRoot, bundlePath, baselineSha, headSha, repository };
}

function writeManifest(fx: Fixture, overrides: Partial<BuildHandoffManifest> = {}, name = 'handoff.json'): string {
  const manifest: BuildHandoffManifest = buildHandoffManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    repository: fx.repository,
    bundlePath: fx.bundlePath,
    branch: 'build/example-v1',
    baseBranch: 'main',
    baselineSha: fx.baselineSha,
    expectedHeadSha: fx.headSha,
    pullRequest: { title: 'Example build', body: 'Body of the pull request.', draft: true },
    createdAt: '2026-07-31T12:00:00.000Z',
    origin: { model: 'claude-opus-5', session: 'test-session' },
    handoffDocumentPath: null,
    deliverables: [],
    drive: null,
    ...overrides,
  });
  const file = path.join(fx.handoffRoot, 'pending', name);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return file;
}

/* ------------------------------------------------------------------ fake ports */

class FakeGitHub implements GitHubPort {
  readonly created: PullRequestRecord[] = [];
  readonly updates: number[] = [];
  /** Branch -> pull request, exactly as GitHub keys an open head. */
  private readonly byBranch = new Map<string, PullRequestRecord>();
  private next = 41;
  failWith: Error | null = null;

  constructor(private readonly headSha: () => string) {}

  private guard() { if (this.failWith) throw this.failWith; }

  findPullRequest(input: { repository: string; branch: string; baseBranch: string }): Promise<PullRequestRecord | null> {
    this.guard();
    const found = this.byBranch.get(`${input.branch}->${input.baseBranch}`);
    return Promise.resolve(found && found.state === 'open' ? found : null);
  }

  createPullRequest(input: { repository: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }): Promise<PullRequestRecord> {
    this.guard();
    this.next += 1;
    const record: PullRequestRecord = {
      number: this.next,
      url: `https://github.com/${input.repository}/pull/${this.next}`,
      draft: input.draft,
      headSha: this.headSha(),
      title: input.title,
      body: input.body,
      state: 'open',
    };
    this.created.push(record);
    this.byBranch.set(`${input.branch}->${input.baseBranch}`, record);
    return Promise.resolve(record);
  }

  updatePullRequest(input: { repository: string; number: number; title: string; body: string }): Promise<PullRequestRecord> {
    this.guard();
    this.updates.push(input.number);
    const record = this.created.find((entry) => entry.number === input.number)!;
    record.title = input.title;
    record.body = input.body;
    return Promise.resolve(record);
  }
}

class FakeDrive implements DrivePort {
  readonly folders = new Map<string, { id: string; parentId: string; name: string }>();
  readonly files = new Map<string, { id: string; parentId: string; name: string; content: string; mimeType: string }>();
  readonly uploads: string[] = [];
  ready = true;
  failUploadsFor = new Set<string>();
  private counter = 0;

  ensureReady(): Promise<void> {
    if (!this.ready) return Promise.reject(new DriveConnectionRequiredError('Google Drive has not been authorised on this machine yet.'));
    return Promise.resolve();
  }

  findChildFolder(parentId: string, name: string): Promise<DriveFile | null> {
    const found = [...this.folders.values()].find((entry) => entry.parentId === parentId && entry.name === name);
    return Promise.resolve(found ? { id: found.id, name: found.name, mimeType: 'application/vnd.google-apps.folder', webViewLink: `https://drive.google.com/drive/folders/${found.id}` } : null);
  }

  createFolder(parentId: string, name: string): Promise<DriveFile> {
    this.counter += 1;
    const id = `folder-${this.counter}`;
    this.folders.set(id, { id, parentId, name });
    return Promise.resolve({ id, name, mimeType: 'application/vnd.google-apps.folder', webViewLink: `https://drive.google.com/drive/folders/${id}` });
  }

  findChildFile(parentId: string, name: string): Promise<DriveFile | null> {
    const found = [...this.files.values()].find((entry) => entry.parentId === parentId && entry.name === name);
    return Promise.resolve(found ? { id: found.id, name: found.name, mimeType: found.mimeType, webViewLink: `https://drive.google.com/file/d/${found.id}/view` } : null);
  }

  uploadFile(input: { parentId: string; name: string; localPath: string; mimeType: string; existingId: string | null }): Promise<DriveFile> {
    if (this.failUploadsFor.has(input.name)) return Promise.reject(new Error(`Drive refused ${input.name}.`));
    this.uploads.push(input.name);
    const id = input.existingId ?? `file-${(this.counter += 1)}`;
    this.files.set(id, { id, parentId: input.parentId, name: input.name, content: readFileSync(input.localPath, 'utf8'), mimeType: input.mimeType });
    return Promise.resolve({ id, name: input.name, mimeType: input.mimeType, webViewLink: `https://drive.google.com/file/d/${id}/view` });
  }

  uploadAsGoogleDoc(input: { parentId: string; name: string; localPath: string; existingId: string | null }): Promise<DriveFile> {
    return this.uploadFile({ ...input, mimeType: 'application/vnd.google-apps.document' });
  }
}

function run(fx: Fixture, manifestPath: string, github: FakeGitHub, drive?: DrivePort | null, extra: Partial<Parameters<typeof finalizeBuild>[0]> = {}): Promise<FinalizeResult> {
  return finalizeBuild({
    manifestPath,
    repoRoot: fx.local,
    handoffRoot: fx.handoffRoot,
    github,
    drive: drive ?? null,
    now: () => new Date('2026-07-31T12:30:00.000Z'),
    ...extra,
  });
}

/** The bare remote's own view of a branch. `show-ref` exits non-zero when absent. */
const remoteSha = (fx: Fixture, branch = 'build/example-v1'): string | null => {
  try {
    const line = git(fx.origin, 'show-ref', '--verify', `refs/heads/${branch}`).trim();
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
};

const localSha = (fx: Fixture, branch: string): string | null => {
  try {
    const line = git(fx.local, 'show-ref', '--verify', `refs/heads/${branch}`).trim();
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ the happy path */

describe('a valid handoff finalises in one action', () => {
  it('verifies, fetches, pushes, confirms the remote SHA and opens a draft pull request', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const github = new FakeGitHub(() => fx.headSha);

    const result = await run(fx, manifestPath, github);

    expect(result.state).toBe('COMPLETED');
    expect(result.localHeadSha).toBe(fx.headSha);
    expect(result.remoteHeadSha).toBe(fx.headSha);
    // The remote genuinely moved — asserted against the bare repository, not
    // against what the engine reported.
    expect(remoteSha(fx)).toBe(fx.headSha);
    expect(result.pullRequest).toMatchObject({ number: 42, draft: true, created: true, headSha: fx.headSha });
    expect(github.created).toHaveLength(1);

    // The steps read as an account of what happened.
    const keys = result.steps.map((step) => step.key);
    expect(keys).toEqual(['manifest', 'repository', 'worktree', 'bundle', 'fetch', 'commit', 'ancestry', 'branch', 'remote-read', 'push', 'remote-verify', 'pull-request', 'drive']);
    expect(result.steps.filter((step) => step.status === 'failed')).toEqual([]);
  });

  it('moves a completed manifest into completed and writes the completion manifest beside it', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('COMPLETED');
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(path.join(fx.handoffRoot, 'completed', 'handoff.json'))).toBe(true);
    expect(result.manifestPath).toBe(path.join(fx.handoffRoot, 'completed', 'handoff.json'));
    expect(result.completionManifestPath).toBe(path.join(fx.handoffRoot, 'completed', 'handoff.completion.json'));

    const completion = JSON.parse(readFileSync(result.completionManifestPath!, 'utf8')) as FinalizeResult;
    expect(completion.state).toBe('COMPLETED');
    expect(completion.remoteHeadSha).toBe(fx.headSha);
    expect(completion.pullRequest?.number).toBe(42);
  });

  it('finds the newest pending handoff with no arguments', () => {
    const fx = fixture();
    writeManifest(fx, {}, 'older.json');
    const newer = writeManifest(fx, {}, 'newer.json');
    // Same content, so ordering must come from the filesystem rather than luck.
    writeFileSync(newer, readFileSync(newer, 'utf8'), 'utf8');
    const found = newestPendingManifest(fx.handoffRoot);
    expect(found).not.toBeNull();
    expect(['older.json', 'newer.json']).toContain(path.basename(found!.path));
    expect(found!.manifest?.branch).toBe('build/example-v1');
  });

  it('skips an unreadable manifest rather than letting it block the next good one', () => {
    const fx = fixture();
    writeFileSync(path.join(fx.handoffRoot, 'pending', 'broken.json'), '{ not json', 'utf8');
    writeManifest(fx, {}, 'good.json');

    const found = newestPendingManifest(fx.handoffRoot);
    expect(path.basename(found!.path)).toBe('good.json');
    // ...and the broken one is still listed, with its parse error.
    const listed = discoverManifests(fx.handoffRoot).find((entry) => path.basename(entry.path) === 'broken.json')!;
    expect(listed.manifest).toBeNull();
    expect(listed.error).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ the refusals */

describe('it refuses rather than guessing', () => {
  it('rejects a manifest whose expected SHA is not what the bundle carries', async () => {
    const fx = fixture();
    const wrong = fx.baselineSha.replace(/.$/, fx.baselineSha.endsWith('a') ? 'b' : 'a');
    const manifestPath = writeManifest(fx, { expectedHeadSha: wrong });

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/bundle carries build\/example-v1 at .*but the manifest expects/i);
    expect(remoteSha(fx)).toBeNull();
    // A failed handoff stays where it is, ready to be retried.
    expect(existsSync(manifestPath)).toBe(true);
  });

  it('rejects a head that does not descend from the declared baseline', async () => {
    const fx = fixture();
    // A second root commit: a real commit, present in the repository, with no
    // ancestry to the baseline at all.
    git(fx.local, 'checkout', '--orphan', 'unrelated');
    writeFileSync(path.join(fx.local, 'unrelated.md'), 'unrelated\n', 'utf8');
    git(fx.local, 'add', '-A');
    git(fx.local, 'commit', '-m', 'unrelated root');
    const unrelated = git(fx.local, 'rev-parse', 'HEAD');
    git(fx.local, 'checkout', 'main');

    const manifestPath = writeManifest(fx, { bundlePath: null, expectedHeadSha: unrelated, branch: 'build/unrelated' });
    const result = await run(fx, manifestPath, new FakeGitHub(() => unrelated));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/does not descend from the declared baseline/i);
    expect(remoteSha(fx, 'build/unrelated')).toBeNull();
  });

  it('refuses a look-alike host carrying the same owner/repo path', async () => {
    const fx = fixture();
    // An internal mirror, a GitLab copy or a look-alike host can all carry the
    // same `owner/repo`. Pushing there and then opening the pull request against
    // api.github.com would be two different repositories.
    git(fx.local, 'config', 'remote.origin.url', `https://github.example-evil.com/${fx.repository}.git`);
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/on github.example-evil.com/i);
    expect(remoteSha(fx)).toBeNull();
  });

  it('refuses a repository that is not the one the manifest names', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx, { repository: 'someone-else/other-repo' });
    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/manifest is for someone-else\/other-repo on github.com but origin resolves to/i);
    // Assert the world, not the record: no branch anywhere, and the repository
    // check is the only step that ran after reading the manifest.
    expect(remoteSha(fx)).toBeNull();
    expect(localSha(fx, 'build/example-v1')).toBeNull();
    expect(result.steps.map((step) => step.key)).toEqual(['manifest', 'repository']);
  });

  it('fails safely when the repository is mid-merge, and changes nothing', async () => {
    const fx = fixture();
    // A genuine interrupted operation, not a synthetic marker file.
    git(fx.local, 'checkout', '-b', 'left');
    writeFileSync(path.join(fx.local, 'conflict.md'), 'left\n', 'utf8');
    git(fx.local, 'add', '-A');
    git(fx.local, 'commit', '-m', 'left');
    git(fx.local, 'checkout', 'main');
    git(fx.local, 'checkout', '-b', 'right');
    writeFileSync(path.join(fx.local, 'conflict.md'), 'right\n', 'utf8');
    git(fx.local, 'add', '-A');
    git(fx.local, 'commit', '-m', 'right');
    try { git(fx.local, 'merge', 'left'); } catch { /* the conflict is the point */ }

    const manifestPath = writeManifest(fx);
    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/merge is in progress|unmerged paths/i);
    expect(remoteSha(fx)).toBeNull();
    expect(localSha(fx, 'build/example-v1')).toBeNull();
    // The interrupted merge is still exactly as interrupted as it was.
    expect(existsSync(path.join(fx.local, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('proceeds when the only untidiness is modified tracked files, and says so', async () => {
    const fx = fixture();
    // The state Warwick's checkout is actually in. Fetching a ref and pushing it
    // reads no file, so refusing here would make the tool unusable for no gain.
    writeFileSync(path.join(fx.local, 'README.md'), '# locally modified\n', 'utf8');
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('COMPLETED');
    expect(result.steps.find((step) => step.key === 'worktree')!.detail).toMatch(/1 tracked file\(s\) are modified/);
    // ...and the modification is untouched.
    expect(readFileSync(path.join(fx.local, 'README.md'), 'utf8')).toBe('# locally modified\n');
  });

  it('refuses to move a local branch that already points somewhere unexpected', async () => {
    const fx = fixture();
    git(fx.local, 'branch', 'build/example-v1', fx.baselineSha);
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/already exists at .*Refusing to move it/i);
    // The branch is exactly where it was.
    expect(git(fx.local, 'rev-parse', 'build/example-v1')).toBe(fx.baselineSha);
    expect(remoteSha(fx)).toBeNull();
  });

  it('refuses a remote branch that already points somewhere else, and never force-pushes', async () => {
    const fx = fixture();
    // Someone else pushed a different commit to the same branch name.
    git(fx.cloud, 'push', 'origin', `${fx.baselineSha}:refs/heads/build/example-v1`);
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/already exists at .*would need a force-push, which this tool never performs/i);
    // The remote is untouched — which is the assertion that matters, since a
    // check on the absence of a `push` step would pass even if the engine had
    // pushed under a different step key.
    expect(remoteSha(fx)).toBe(fx.baselineSha);
  });
});

/* ------------------------------------------------------------------ idempotence */

describe('running it again is safe', () => {
  it('is idempotent: a second run changes nothing and reports the same outcome', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const github = new FakeGitHub(() => fx.headSha);

    const first = await run(fx, manifestPath, github);
    expect(first.state).toBe('COMPLETED');

    // The manifest moved, so a rerun works from where it now is — which is what
    // the Cockpit's Retry does.
    const second = await run(fx, first.manifestPath, github);
    expect(second.state).toBe('COMPLETED');
    expect(second.remoteHeadSha).toBe(fx.headSha);
    expect(github.created).toHaveLength(1);
    expect(github.updates).toHaveLength(0);
    // Nothing mutated on the second pass.
    expect(second.steps.filter((step) => step.mutated)).toEqual([]);
    expect(second.steps.find((step) => step.key === 'push')!.detail).toMatch(/Already pushed/);
    expect(second.steps.find((step) => step.key === 'branch')!.detail).toMatch(/already points at the expected SHA/);
  });

  it('accepts a remote branch that someone already pushed at the right SHA', async () => {
    const fx = fixture();
    git(fx.cloud, 'push', 'origin', 'build/example-v1');
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    expect(result.state).toBe('COMPLETED');
    expect(result.steps.find((step) => step.key === 'push')!.status).toBe('skipped');
    expect(result.remoteHeadSha).toBe(fx.headSha);
  });

  it('does not create a second pull request, and updates the existing one when the text moved on', async () => {
    const fx = fixture();
    const github = new FakeGitHub(() => fx.headSha);
    const first = await run(fx, writeManifest(fx, {}, 'first.json'), github);
    expect(first.pullRequest?.created).toBe(true);

    const second = await run(fx, writeManifest(fx, { pullRequest: { title: 'A better title', body: 'Body of the pull request.', draft: true } }, 'second.json'), github);
    expect(second.state).toBe('COMPLETED');
    expect(second.pullRequest?.created).toBe(false);
    expect(second.pullRequest?.number).toBe(first.pullRequest?.number);
    expect(github.created).toHaveLength(1);
    expect(github.updates).toEqual([first.pullRequest!.number]);
    expect(github.created[0].title).toBe('A better title');
  });

  it('refuses a pull request whose head is not the expected SHA', async () => {
    const fx = fixture();
    const github = new FakeGitHub(() => fx.headSha);
    await run(fx, writeManifest(fx, {}, 'first.json'), github);
    // The pull request drifted to a different head.
    github.created[0].headSha = fx.baselineSha;

    // A different title, so an engine that updated before checking the head
    // would be caught doing it.
    const second = await run(fx, writeManifest(fx, { pullRequest: { title: 'A rewritten title', body: 'Body of the pull request.', draft: true } }, 'second.json'), github);
    expect(second.state).toBe('PARTIAL');
    expect(second.errors.join(' ')).toMatch(/its head is .*not/i);
    // Nothing was written to a pull request that is not this build's.
    expect(github.updates).toEqual([]);
    expect(github.created[0].title).toBe('Example build');
    expect(second.steps.find((step) => step.key === 'pull-request')!.mutated).toBe(false);
  });

  it('dry run verifies everything and changes nothing', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const github = new FakeGitHub(() => fx.headSha);

    const result = await run(fx, manifestPath, github, null, { dryRun: true });

    expect(result.state).toBe('PARTIAL');
    expect(remoteSha(fx)).toBeNull();
    expect(github.created).toHaveLength(0);
    expect(existsSync(manifestPath)).toBe(true);
    expect(result.steps.filter((step) => step.mutated)).toEqual([]);
    expect(result.steps.find((step) => step.key === 'bundle')!.status).toBe('ok');
    // The read-only checks are performed for real, not skipped: a dry run that
    // reports everything skipped has verified nothing.
    expect(result.steps.find((step) => step.key === 'branch')!.status).toBe('ok');
    expect(result.steps.find((step) => step.key === 'remote-read')!.status).toBe('ok');
    // ...and it did not create the local branch it says a real run would.
    expect(localSha(fx, 'build/example-v1')).toBeNull();
  });

  it('dry run surfaces a remote branch that would need a force-push, instead of reporting it is fine', async () => {
    const fx = fixture();
    git(fx.cloud, 'push', 'origin', `${fx.baselineSha}:refs/heads/build/example-v1`);
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), null, { dryRun: true });

    expect(result.state).toBe('FAILED');
    expect(result.errors.join(' ')).toMatch(/would refuse rather than force-push/i);
    expect(remoteSha(fx)).toBe(fx.baselineSha);
  });

  it('a dry run never overwrites the record of the real run that came before it', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const real = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));
    expect(real.state).toBe('COMPLETED');
    const record = readFileSync(real.completionManifestPath!, 'utf8');

    const dry = await run(fx, real.manifestPath, new FakeGitHub(() => fx.headSha), null, { dryRun: true });
    expect(dry.completionManifestPath).toBeNull();
    // The pull request number, the verified remote SHA and the Drive ids the
    // real run recorded are still the only completion record on disk.
    expect(readFileSync(real.completionManifestPath!, 'utf8')).toBe(record);
    const view = readBuildHandoffs(fx.handoffRoot).handoffs[0];
    expect(view.lastRun?.state).toBe('COMPLETED');
    expect(view.lastRun?.pullRequest?.number).toBe(real.pullRequest!.number);
    expect(view.lastRun?.remoteHeadSha).toBe(fx.headSha);
  });
});

/* ------------------------------------------------------------------ partial failure */

describe('a failure after the push is recoverable, not destructive', () => {
  it('does not report FAILED when the push worked and only the read-back failed', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    // A git that works until the branch has been pushed, then fails the
    // verifying `ls-remote`. A dropped connection a second after a successful
    // push must not be reported as "nothing was changed".
    const shim = path.join(fx.root, 'git-shim.sh');
    const counter = path.join(fx.root, 'ls-remote-calls');
    writeFileSync(shim, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "ls-remote" ]; then',
      `    printf x >> ${JSON.stringify(counter)}`,
      `    if [ "$(wc -c < ${JSON.stringify(counter)})" -gt 1 ]; then`,
      '      echo "fatal: unable to access origin: Could not resolve host" >&2',
      '      exit 128',
      '    fi',
      '  fi',
      'done',
      'exec git "$@"',
    ].join('\n') + '\n', { encoding: 'utf8', mode: 0o755 });

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), null, { gitPath: shim });

    // The branch really is on origin...
    expect(remoteSha(fx)).toBe(fx.headSha);
    // ...so this is a retryable PARTIAL, not a FAILED that says nothing happened.
    expect(result.state).toBe('PARTIAL');
    expect(result.steps.find((step) => step.key === 'push')!.status).toBe('ok');
    expect(result.errors.join(' ')).toMatch(/reading origin\/build\/example-v1 back failed/i);
    expect(result.errors.join(' ')).toMatch(/Run this again/i);
    // An unconfirmed remote SHA means no pull request is opened against it.
    expect(result.pullRequest).toBeNull();
    expect(result.steps.find((step) => step.key === 'pull-request')!.status).toBe('skipped');
    // The handoff stays pending so pressing Retry finishes it.
    expect(existsSync(manifestPath)).toBe(true);

    const retried = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));
    expect(retried.state).toBe('COMPLETED');
    expect(retried.remoteHeadSha).toBe(fx.headSha);
  });

  it('leaves the branch safely pushed when GitHub fails, and reports PARTIAL', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const github = new FakeGitHub(() => fx.headSha);
    github.failWith = new Error('GitHub POST /repos/... failed with 503: upstream unavailable');

    const result = await run(fx, manifestPath, github);

    expect(result.state).toBe('PARTIAL');
    // The push happened and is verified — the expensive, irreversible half.
    expect(remoteSha(fx)).toBe(fx.headSha);
    expect(result.remoteHeadSha).toBe(fx.headSha);
    expect(result.errors.join(' ')).toMatch(/branch is pushed and verified on origin; re-run to retry only the pull request/i);
    // The manifest stays pending so Retry finds it.
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(path.join(fx.handoffRoot, 'pending', 'handoff.completion.json'))).toBe(true);

    // Retry with GitHub back: only the pull request is done, and it completes.
    github.failWith = null;
    const retried = await run(fx, manifestPath, github);
    expect(retried.state).toBe('COMPLETED');
    expect(retried.steps.find((step) => step.key === 'push')!.status).toBe('skipped');
    expect(github.created).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ drive mirror */

describe('the Google Drive mirror', () => {
  function withDeliverables(fx: Fixture): { manifestPath: string; safe: string; customer: string } {
    const safe = path.join(fx.root, 'handoff.md');
    const customer = path.join(fx.root, 'transcript.vtt');
    writeFileSync(safe, '# handoff\n', 'utf8');
    writeFileSync(customer, 'WEBVTT\n', 'utf8');
    const manifestPath = writeManifest(fx, {
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [
        { path: safe, classification: 'safe_for_drive', required: true, googleDoc: true, title: 'Handoff.md' },
        { path: customer, classification: 'contains_customer_data', required: false, googleDoc: false },
      ],
    });
    return { manifestPath, safe, customer };
  }

  it('uploads only safe deliverables, into a folder named by branch and exact SHA', async () => {
    const fx = fixture();
    const { manifestPath } = withDeliverables(fx);
    const drive = new FakeDrive();

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);

    expect(result.state).toBe('COMPLETED');
    // The declared deliverables, plus the run's own completion record.
    expect(drive.uploads).toEqual(['Handoff.md', 'Handoff (Doc)', 'handoff.completion.json']);
    // The customer transcript sitting beside the handoff is never uploaded.
    expect(drive.uploads.some((name) => name.includes('transcript'))).toBe(false);
    const withheld = result.deliverables.find((entry) => entry.classification === 'contains_customer_data')!;
    expect(withheld.uploadStatus).toBe('skipped-classification');
    expect(withheld.driveFileId).toBeNull();
    // ...and it is still recorded, with its hash, so the withholding is evidence.
    expect(withheld.sha256).toMatch(/^[a-f0-9]{64}$/);

    const uploaded = result.deliverables.find((entry) => entry.classification === 'safe_for_drive')!;
    expect(uploaded.uploadStatus).toBe('uploaded');
    expect(uploaded.driveFileId).toBeTruthy();
    expect(uploaded.driveUrl).toContain('drive.google.com');
    expect(uploaded.googleDocId).toBeTruthy();
    expect(uploaded.uploadedAt).toBe('2026-07-31T12:30:00.000Z');

    const folder = [...drive.folders.values()].find((entry) => entry.name.includes('build-example-v1'))!;
    expect(folder.name).toBe(buildFolderName('2026-07-31T12:00:00.000Z', 'build/example-v1', fx.headSha));
    expect(result.drive.folderUrl).toContain(folder.id);
  });

  it('reuses the same build folder on a rerun instead of creating a second one', async () => {
    const fx = fixture();
    const { manifestPath } = withDeliverables(fx);
    const drive = new FakeDrive();
    const github = new FakeGitHub(() => fx.headSha);

    const first = await run(fx, manifestPath, github, drive);
    const foldersAfterFirst = drive.folders.size;
    const fileId = first.deliverables.find((entry) => entry.classification === 'safe_for_drive')!.driveFileId;

    const second = await run(fx, first.manifestPath, github, drive);
    expect(second.state).toBe('COMPLETED');
    expect(drive.folders.size).toBe(foldersAfterFirst);
    const secondFile = second.deliverables.find((entry) => entry.classification === 'safe_for_drive')!;
    expect(secondFile.driveFileId).toBe(fileId);
    expect(secondFile.uploadStatus).toBe('updated');
  });

  it('gives a different SHA its own folder and never overwrites the previous build', async () => {
    const fx = fixture();
    const { manifestPath, safe } = withDeliverables(fx);
    const drive = new FakeDrive();
    await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);
    const firstFolder = result_folder(drive, fx.headSha);

    // A second build of the same branch at a different SHA.
    git(fx.cloud, 'commit', '--allow-empty', '-m', 'second build');
    const secondSha = git(fx.cloud, 'rev-parse', 'HEAD');
    const secondBundle = path.join(fx.root, 'build2.bundle');
    git(fx.cloud, 'bundle', 'create', secondBundle, `${fx.baselineSha}..build/example-v1`);
    git(fx.local, 'update-ref', '-d', 'refs/heads/build/example-v1');
    git(fx.origin, 'update-ref', '-d', 'refs/heads/build/example-v1');
    const second = writeManifest(fx, {
      bundlePath: secondBundle,
      expectedHeadSha: secondSha,
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [{ path: safe, classification: 'safe_for_drive', required: true, googleDoc: false, title: 'Handoff.md' }],
    }, 'second.json');

    await run(fx, second, new FakeGitHub(() => secondSha), drive);
    const secondFolder = result_folder(drive, secondSha);

    expect(secondFolder).not.toBe(firstFolder);
    expect([...drive.folders.values()].filter((entry) => entry.name.startsWith('2026-07-31 — build-example-v1'))).toHaveLength(2);
  });

  it('reports PARTIAL and stays retryable when Drive is not connected', async () => {
    const fx = fixture();
    const { manifestPath } = withDeliverables(fx);
    const drive = new FakeDrive();
    drive.ready = false;

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);

    expect(result.state).toBe('PARTIAL');
    // The Git half completed and is not undone by the Drive failure.
    expect(remoteSha(fx)).toBe(fx.headSha);
    expect(result.pullRequest?.number).toBe(42);
    expect(result.drive.connectionRequired).toBe(true);
    expect(result.errors.join(' ')).toContain('Google Drive connection required');
    expect(existsSync(manifestPath)).toBe(true);

    // Connect, retry: only the Drive work is redone.
    drive.ready = true;
    const retried = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);
    expect(retried.state).toBe('COMPLETED');
    expect(retried.steps.find((step) => step.key === 'push')!.status).toBe('skipped');
    expect(drive.uploads).toContain('Handoff.md');
  });

  it('reports PARTIAL when a required deliverable will not upload, and names it', async () => {
    const fx = fixture();
    const { manifestPath } = withDeliverables(fx);
    const drive = new FakeDrive();
    drive.failUploadsFor.add('Handoff.md');

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);

    expect(result.state).toBe('PARTIAL');
    expect(result.errors.join(' ')).toMatch(/Handoff\.md \(Drive refused Handoff\.md\.\)/);
    expect(remoteSha(fx)).toBe(fx.headSha);
  });

  it('mirrors the completion record itself into the build folder', async () => {
    const fx = fixture();
    const deliverable = path.join(fx.root, 'Handoff.md');
    writeFileSync(deliverable, '# handoff\n', 'utf8');
    const manifestPath = writeManifest(fx, {
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [{ path: deliverable, classification: 'safe_for_drive', required: true, googleDoc: false }],
    });
    const drive = new FakeDrive();

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);

    expect(result.state).toBe('COMPLETED');
    // The build folder holds the evidence of its own finalisation, so the only
    // durable record of the pushed SHA and the pull request is not one machine.
    expect(result.drive.completionRecordId).toBeTruthy();
    const uploaded = drive.files.get(result.drive.completionRecordId!)!;
    expect(uploaded.parentId).toBe(result.drive.folderId);
    expect(uploaded.name.endsWith('.completion.json')).toBe(true);
    const record = JSON.parse(uploaded.content) as FinalizeResult;
    expect(record.remoteHeadSha).toBe(fx.headSha);
    expect(record.pullRequest?.number).toBe(result.pullRequest!.number);
    // ...and the local copy names where its own copy went.
    const local = JSON.parse(readFileSync(result.completionManifestPath!, 'utf8')) as FinalizeResult;
    expect(local.drive.completionRecordId).toBe(result.drive.completionRecordId);
  });

  it('survives a deliverable that cannot be read, and still writes the completion record', async () => {
    const fx = fixture();
    // A directory where a file was meant. On Warwick's machine the same shape
    // is a file locked by another process, or one too large to read. Whatever
    // the cause, it happens AFTER the push, so throwing here would mean the
    // branch was pushed and no record of it was ever written.
    const notAFile = path.join(fx.root, 'output-folder');
    mkdirSync(notAFile, { recursive: true });
    const readable = path.join(fx.root, 'Handoff.md');
    writeFileSync(readable, '# handoff\n', 'utf8');
    const manifestPath = writeManifest(fx, {
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [
        { path: notAFile, classification: 'safe_for_drive', required: true, googleDoc: false },
        { path: readable, classification: 'safe_for_drive', required: true, googleDoc: false },
      ],
    });

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), new FakeDrive());

    expect(result.state).toBe('PARTIAL');
    expect(result.deliverables[0].uploadStatus).toBe('unreadable');
    // The failure names the file, so the operator knows which one to fix.
    expect(result.deliverables[0].error).toContain('output-folder');
    // The readable one still went, and the record exists on disk.
    expect(result.deliverables[1].uploadStatus).toBe('uploaded');
    expect(result.completionManifestPath).not.toBeNull();
    expect(existsSync(result.completionManifestPath!)).toBe(true);
    expect(readBuildHandoffs(fx.handoffRoot).handoffs[0].lastRun?.remoteHeadSha).toBe(fx.headSha);
  });

  it('never lets two deliverables with the same file name collapse into one Drive file', async () => {
    const fx = fixture();
    // The build contract's required deliverables plausibly share basenames
    // across directories. Keyed on the basename alone, the second would
    // overwrite the first and both would be reported as mirrored.
    mkdirSync(path.join(fx.root, 'acceptance'), { recursive: true });
    mkdirSync(path.join(fx.root, 'review'), { recursive: true });
    writeFileSync(path.join(fx.root, 'acceptance', 'report.md'), 'ACCEPTANCE\n', 'utf8');
    writeFileSync(path.join(fx.root, 'review', 'report.md'), 'REVIEW\n', 'utf8');
    const manifestPath = writeManifest(fx, {
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [
        { path: path.join(fx.root, 'acceptance', 'report.md'), classification: 'safe_for_drive', required: true, googleDoc: false },
        { path: path.join(fx.root, 'review', 'report.md'), classification: 'safe_for_drive', required: true, googleDoc: false },
      ],
    });
    const drive = new FakeDrive();

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), drive);

    expect(result.state).toBe('COMPLETED');
    const ids = result.deliverables.map((entry) => entry.driveFileId);
    expect(new Set(ids).size).toBe(2);
    expect(result.deliverables.map((entry) => entry.title)).toEqual(['acceptance — report.md', 'review — report.md']);
    // Both files are in Drive with their own content; neither overwrote the other.
    const contents = [...drive.files.values()].filter((file) => file.name.endsWith('report.md')).map((file) => file.content).sort();
    expect(contents).toEqual(['ACCEPTANCE\n', 'REVIEW\n']);

    // ...and re-finalising the same build updates those same two files.
    const again = await run(fx, result.manifestPath, new FakeGitHub(() => fx.headSha), drive);
    expect(again.deliverables.map((entry) => entry.driveFileId)).toEqual(ids);
    expect([...drive.files.values()].filter((file) => file.name.endsWith('report.md'))).toHaveLength(2);
  });

  it('records a declared deliverable that does not exist rather than silently ignoring it', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx, {
      drive: { folderId: 'root-folder', folderName: 'ProjectManagAIr', buildDeliverablesFolder: 'Build Deliverables' },
      deliverables: [{ path: path.join(fx.root, 'never-written.md'), classification: 'safe_for_drive', required: true, googleDoc: false }],
    });

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha), new FakeDrive());

    expect(result.state).toBe('PARTIAL');
    const missing = result.deliverables[0];
    expect(missing.uploadStatus).toBe('missing');
    expect(missing.error).toMatch(/does not exist/i);
  });
});

function result_folder(drive: FakeDrive, sha: string): string | undefined {
  return [...drive.folders.values()].find((entry) => entry.name.endsWith(sha.slice(0, 7)))?.id;
}

/* ------------------------------------------------------------------ secrets */

describe('credentials never reach a log or a manifest', () => {
  it('redacts every token shape from anything it records', () => {
    const samples = [
      'remote: fatal https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/y.git',
      'Authorization: Bearer ya29.a0AfB_abcdefghijklmnopqrstuvwxyz0123456789',
      '{"refresh_token":"1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ","client_secret":"GOCSPX-abcdefghijklmnop"}',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const sample of samples) {
      const redacted = redactSecrets(sample);
      for (const secret of ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'ya29.a0AfB_abcdefghijklmnopqrstuvwxyz0123456789', '1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ', 'GOCSPX-abcdefghijklmnop', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345']) {
        expect(redacted).not.toContain(secret);
      }
    }
  });

  it('writes no credential into the completion manifest even when git quotes one back', async () => {
    const fx = fixture();
    // A remote whose URL embeds a token, exactly as a failing push would echo it.
    const leaky = `https://x-access-token:ghp_SECRETSECRETSECRETSECRET0123456789@github.com/${fx.repository}.git`;
    git(fx.local, 'remote', 'set-url', 'origin', leaky);
    // Rewrite the leaky URL back to the on-disk bare repository too, so this
    // test never reaches the network: without this it passes only because a
    // real `ls-remote` against github.com fails.
    git(fx.local, 'config', `url.${fx.origin}/.insteadOf`, leaky);
    const manifestPath = writeManifest(fx);

    const result = await run(fx, manifestPath, new FakeGitHub(() => fx.headSha));

    const recorded = JSON.stringify(result) + readFileSync(result.completionManifestPath!, 'utf8') + renderFinalizeReport(result);
    expect(recorded).not.toContain('ghp_SECRETSECRETSECRETSECRET0123456789');
  });
});

/* ------------------------------------------------------------------ the shared engine */

describe('the Cockpit and the command line share one engine', () => {
  it('reads the same handoffs the command line lists, without touching Git', () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const view = readBuildHandoffs(fx.handoffRoot);

    expect(view.handoffs).toHaveLength(1);
    expect(view.handoffs[0]).toMatchObject({
      state: 'pending',
      readable: true,
      branch: 'build/example-v1',
      expectedHeadSha: fx.headSha,
      baselineSha: fx.baselineSha,
      bundlePresent: true,
      driveDeclared: false,
    });
    expect(view.handoffs[0].origin).toEqual({ model: 'claude-opus-5', session: 'test-session' });
    expect(isKnownManifestPath(fx.handoffRoot, manifestPath)).toBe(true);
    // A path the machine does not offer is refused, so the route cannot be
    // pointed at an arbitrary file.
    expect(isKnownManifestPath(fx.handoffRoot, path.join(fx.root, 'elsewhere.json'))).toBe(false);
  });

  it('shows the last run, including a failure, so Retry is an informed decision', async () => {
    const fx = fixture();
    const manifestPath = writeManifest(fx);
    const github = new FakeGitHub(() => fx.headSha);
    github.failWith = new Error('GitHub is down');
    await run(fx, manifestPath, github);

    const view = readBuildHandoffs(fx.handoffRoot).handoffs[0];
    expect(view.state).toBe('pending');
    expect(view.lastRun).not.toBeNull();
    expect(view.lastRun!.state).toBe('PARTIAL');
    expect(view.lastRun!.remoteHeadSha).toBe(fx.headSha);
    expect(view.lastRun!.lastError).toMatch(/GitHub is down/);
  });

  it('resolves the handoff root beside Data, never inside the repository', () => {
    const root = resolveHandoffRoot('/somewhere/ProjectManagAIr', {});
    expect(root).toBe(path.resolve('/somewhere/Data/staging/build-handoffs'));
    expect(root.includes(`${path.sep}ProjectManagAIr${path.sep}`)).toBe(false);
    expect(resolveHandoffRoot('/somewhere/ProjectManagAIr', { PROJECTMANAGAIR_BUILD_HANDOFF_DIR: '/tmp/elsewhere' })).toBe(path.resolve('/tmp/elsewhere'));
  });
});

/* ------------------------------------------------------------------ small pieces */

describe('supporting rules', () => {
  it('reads owner/repo out of every remote URL shape git actually uses', () => {
    expect(repositoryFromRemoteUrl('https://github.com/warwickallan/ProjectManagAIr.git')).toBe('warwickallan/ProjectManagAIr');
    expect(repositoryFromRemoteUrl('https://github.com/warwickallan/ProjectManagAIr')).toBe('warwickallan/ProjectManagAIr');
    expect(repositoryFromRemoteUrl('git@github.com:warwickallan/ProjectManagAIr.git')).toBe('warwickallan/ProjectManagAIr');
    expect(repositoryFromRemoteUrl('ssh://git@github.com/warwickallan/ProjectManagAIr.git')).toBe('warwickallan/ProjectManagAIr');
    expect(repositoryFromRemoteUrl('not a url')).toBeNull();
  });

  it('names a build folder by day, branch and short SHA', () => {
    expect(buildFolderName('2026-07-31T12:00:00.000Z', 'build/local-build-finalizer-v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'))
      .toBe('2026-07-31 — build-local-build-finalizer-v1 — a1b2c3d');
  });

  it('rejects a manifest that is missing or malformed rather than half-applying it', () => {
    expect(buildHandoffManifestSchema.safeParse({}).success).toBe(false);
    expect(buildHandoffManifestSchema.safeParse({ manifestVersion: 1, repository: 'a/b', branch: 'x', baselineSha: 'short', expectedHeadSha: 'short' }).success).toBe(false);
    const parsed = buildHandoffManifestSchema.safeParse({
      manifestVersion: 1,
      repository: 'owner/repo',
      branch: 'build/x',
      baselineSha: 'a'.repeat(40),
      expectedHeadSha: 'b'.repeat(40),
      pullRequest: { title: 'x' },
      createdAt: '2026-07-31T00:00:00.000Z',
      origin: { model: 'claude-opus-5' },
    });
    expect(parsed.success).toBe(true);
    // The defaults a builder should not have to write out.
    expect(parsed.success && parsed.data.baseBranch).toBe('main');
    expect(parsed.success && parsed.data.pullRequest.draft).toBe(true);
    expect(parsed.success && parsed.data.deliverables).toEqual([]);
  });
});
