/**
 * The local build finaliser.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A cloud build session can compile, test and commit, but it cannot write to
 * the GitHub repository. The sandboxed VM that can see the working copy has no
 * network. So a build ends with a bundle on disk and a human running
 * `git bundle verify`, `git fetch`, `git rev-parse`, `git push` and then opening
 * a pull request by hand. That makes the human the integration layer, which is
 * both tedious and the most error-prone step in the chain.
 *
 * This module is the whole finalisation, once, in code: verify, fetch, push,
 * verify the remote, open or update a draft pull request, mirror the safe
 * deliverables to Google Drive, and write down exactly what happened.
 *
 * ONE ENGINE
 * ----------
 * The command line and the Cockpit button both call {@link finalizeBuild}. The
 * PowerShell launcher discovers the runtime and renders output; it holds no Git
 * logic, and neither does the UI. There is one implementation of every rule
 * below, and it is this one.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Merge. Force-push. Delete a branch. Reset or clean a working tree. Move a
 * branch that points somewhere unexpected. Write a token to disk or to a log.
 * Where it cannot proceed safely it stops and says why, in a sentence an
 * operator can act on.
 *
 * IDEMPOTENCE
 * -----------
 * Every step reads the current state before it writes. Re-running a manifest
 * that has already been finalised performs no mutation and returns the same
 * result; re-running one that failed part-way retries only what is outstanding.
 * That is what makes "just press it again" a safe instruction.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/* ------------------------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------------------------ */

export const MANIFEST_VERSION = 1;

const sha40 = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character SHA-1');

/**
 * How a deliverable may be handled.
 *
 * Only `safe_for_drive` is ever uploaded automatically. The other three are
 * refusals with different reasons, and they are refusals a builder must make
 * deliberately: the default when a builder does not classify a file is to treat
 * it as `local_only`, never to guess that it is safe.
 */
export const DELIVERABLE_CLASSIFICATIONS = ['safe_for_drive', 'contains_customer_data', 'contains_secrets', 'local_only'] as const;
export type DeliverableClassification = typeof DELIVERABLE_CLASSIFICATIONS[number];

export const deliverableSchema = z.object({
  /** Absolute path, or a path relative to the manifest's own directory. */
  path: z.string().min(1),
  classification: z.enum(DELIVERABLE_CLASSIFICATIONS),
  /** Human title used for the Drive copy; defaults to the file name. */
  title: z.string().min(1).optional(),
  /** Required deliverables make the difference between COMPLETED and PARTIAL. */
  required: z.boolean().default(true),
  /** Also produce a native Google Doc copy. Only meaningful for text formats. */
  googleDoc: z.boolean().default(false),
}).strict();

export const buildHandoffManifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  /** `owner/repo`. Checked against the configured `origin` before anything is written. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/repo'),
  /** Absolute or manifest-relative path to a git bundle, when one is needed. */
  bundlePath: z.string().min(1).nullable().default(null),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
  baselineSha: sha40,
  expectedHeadSha: sha40,
  pullRequest: z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    bodyPath: z.string().min(1).optional(),
    draft: z.boolean().default(true),
  }).strict(),
  createdAt: z.string().min(1),
  origin: z.object({
    model: z.string().min(1),
    session: z.string().min(1).nullable().default(null),
  }).strict(),
  /** The human-readable handoff, kept outside Git. */
  handoffDocumentPath: z.string().min(1).nullable().default(null),
  deliverables: z.array(deliverableSchema).default([]),
  drive: z.object({
    /** Omit to skip Drive mirroring entirely; a build that declares it must complete it. */
    folderId: z.string().min(1),
    folderName: z.string().min(1).default('ProjectManagAIr'),
    buildDeliverablesFolder: z.string().min(1).default('Build Deliverables'),
  }).strict().nullable().default(null),
}).strict();

export type BuildHandoffManifest = z.infer<typeof buildHandoffManifestSchema>;

/* ------------------------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------------------------ */

export type FinalizeState = 'COMPLETED' | 'PARTIAL' | 'FAILED';
export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface FinalizeStep {
  key: string;
  title: string;
  status: StepStatus;
  detail: string;
  /** True when this run changed something, false when it found the work already done. */
  mutated: boolean;
}

export interface DeliverableResult {
  path: string;
  title: string;
  classification: DeliverableClassification;
  required: boolean;
  sha256: string | null;
  bytes: number | null;
  uploadStatus: 'uploaded' | 'updated' | 'unchanged' | 'skipped-classification' | 'missing' | 'failed';
  driveFileId: string | null;
  driveUrl: string | null;
  googleDocId: string | null;
  googleDocUrl: string | null;
  uploadedAt: string | null;
  error: string | null;
}

export interface FinalizeResult {
  state: FinalizeState;
  manifestPath: string;
  repository: string;
  branch: string;
  baseBranch: string;
  baselineSha: string;
  expectedHeadSha: string;
  localHeadSha: string | null;
  remoteHeadSha: string | null;
  pullRequest: { number: number; url: string; draft: boolean; headSha: string | null; created: boolean } | null;
  drive: {
    attempted: boolean;
    folderId: string | null;
    folderName: string | null;
    folderUrl: string | null;
    requiredCount: number;
    uploadedCount: number;
    connectionRequired: boolean;
    error: string | null;
  };
  deliverables: DeliverableResult[];
  steps: FinalizeStep[];
  errors: string[];
  startedAt: string;
  finishedAt: string;
  completionManifestPath: string | null;
}

/* ------------------------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------------------------ */

/**
 * Everything this module records passes through here first.
 *
 * A token reaching a log or a completion manifest is a credential leak that no
 * later cleanup fixes, and the most likely way it happens is a git or HTTP error
 * message quoting a URL with a token embedded in it. Redaction is applied at the
 * single choke point rather than at each call site, so a new call site cannot
 * forget.
 */
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ya29\.[A-Za-z0-9._-]{20,}/g,
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,
  /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
  /("?(?:access_token|refresh_token|client_secret|password|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

export function redactSecrets(value: string): string {
  let text = value ?? '';
  text = text.replace(SECRET_PATTERNS[4], '$1***:***@');
  text = text.replace(SECRET_PATTERNS[5], '$1***');
  for (const pattern of [SECRET_PATTERNS[0], SECRET_PATTERNS[1], SECRET_PATTERNS[2], SECRET_PATTERNS[3]]) {
    text = text.replace(pattern, '***');
  }
  return text;
}

/* ------------------------------------------------------------------------------------ *
 * Process helpers
 * ------------------------------------------------------------------------------------ */

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command and capture both streams.
 *
 * Never throws on a non-zero exit: a failing git command is information the
 * caller has to reason about, not an exception to unwind through. Output is
 * redacted before it leaves this function.
 */
export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), code });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\nTimed out after ${options.timeoutMs ?? 120_000} ms.`;
      finish(124);
    }, options.timeoutMs ?? 120_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { stderr += `\n${error.message}`; finish(127); });
    child.on('close', (code) => finish(code ?? 0));
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** A git invocation inside one repository. */
export interface GitRunner {
  (args: string[], options?: RunOptions): Promise<RunResult>;
}

export function gitIn(repoRoot: string, options: { gitPath?: string } = {}): GitRunner {
  const git = options.gitPath ?? 'git';
  return (args, runOptions = {}) => runCommand(git, args, { ...runOptions, cwd: runOptions.cwd ?? repoRoot });
}

/* ------------------------------------------------------------------------------------ *
 * The GitHub and Drive ports
 *
 * Both external services are behind a narrow interface so the whole engine can
 * be driven against fakes in the test suite. Every rule below — idempotence,
 * refusing a conflicting head, not creating a second pull request — is proved
 * against those fakes rather than asserted.
 * ------------------------------------------------------------------------------------ */

export interface PullRequestRecord {
  number: number;
  url: string;
  draft: boolean;
  headSha: string | null;
  title: string;
  body: string;
  state: string;
}

export interface GitHubPort {
  /** Null when no open pull request exists for this head and base. */
  findPullRequest(input: { repository: string; branch: string; baseBranch: string }): Promise<PullRequestRecord | null>;
  createPullRequest(input: { repository: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }): Promise<PullRequestRecord>;
  updatePullRequest(input: { repository: string; number: number; title: string; body: string }): Promise<PullRequestRecord>;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  md5Checksum?: string | null;
}

export interface DrivePort {
  /** Throws a {@link DriveConnectionRequiredError} when no usable credential exists. */
  ensureReady(): Promise<void>;
  findChildFolder(parentId: string, name: string): Promise<DriveFile | null>;
  createFolder(parentId: string, name: string): Promise<DriveFile>;
  findChildFile(parentId: string, name: string): Promise<DriveFile | null>;
  uploadFile(input: { parentId: string; name: string; localPath: string; mimeType: string; existingId: string | null }): Promise<DriveFile>;
  /** Native Google Doc conversion of a text file. */
  uploadAsGoogleDoc(input: { parentId: string; name: string; localPath: string; existingId: string | null }): Promise<DriveFile>;
}

export class DriveConnectionRequiredError extends Error {
  readonly connectionRequired = true;
  constructor(message: string) {
    super(message);
    this.name = 'DriveConnectionRequiredError';
  }
}

/* ------------------------------------------------------------------------------------ *
 * Manifest discovery
 * ------------------------------------------------------------------------------------ */

export const PENDING_DIR = 'pending';
export const COMPLETED_DIR = 'completed';
/** Distinguishes the record of a run from the handoff it describes. */
export const COMPLETION_SUFFIX = '.completion.json';

export interface HandoffLocation {
  root: string;
  pending: string;
  completed: string;
}

export function handoffLocations(root: string): HandoffLocation {
  return { root, pending: path.join(root, PENDING_DIR), completed: path.join(root, COMPLETED_DIR) };
}

export interface DiscoveredManifest {
  path: string;
  manifest: BuildHandoffManifest | null;
  /** Present when the file exists but is not a valid manifest. */
  error: string | null;
  modifiedAt: string;
  state: 'pending' | 'completed';
}

export function readManifestFile(file: string): DiscoveredManifest {
  const modifiedAt = existsSync(file) ? new Date(statSync(file).mtimeMs).toISOString() : new Date(0).toISOString();
  const state: 'pending' | 'completed' = path.basename(path.dirname(file)) === COMPLETED_DIR ? 'completed' : 'pending';
  try {
    const parsed = buildHandoffManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    if (!parsed.success) {
      return { path: file, manifest: null, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '), modifiedAt, state };
    }
    return { path: file, manifest: parsed.data, error: null, modifiedAt, state };
  } catch (error) {
    return { path: file, manifest: null, error: error instanceof Error ? error.message : String(error), modifiedAt, state };
  }
}

/** Every manifest under a handoff root, newest first, invalid ones included. */
export function discoverManifests(root: string): DiscoveredManifest[] {
  const locations = handoffLocations(root);
  const found: DiscoveredManifest[] = [];
  for (const directory of [locations.pending, locations.completed]) {
    if (!existsSync(directory)) continue;
    // `*.completion.json` is the record OF a run, written beside the manifest it
    // describes. Listing it as a handoff made it the newest entry in the
    // directory and pushed the real one out of view.
    for (const entry of readdirSync(directory).filter((name) => name.endsWith('.json') && !name.endsWith(COMPLETION_SUFFIX)).sort()) {
      found.push(readManifestFile(path.join(directory, entry)));
    }
  }
  return found.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : left.modifiedAt > right.modifiedAt ? -1 : 0));
}

/**
 * The newest pending manifest that actually parses.
 *
 * An invalid file is skipped rather than fatal: one malformed manifest left
 * behind by a failed build must not stop the next good one from finalising, and
 * the Cockpit lists the malformed file with its parse error either way.
 */
export function newestPendingManifest(root: string): DiscoveredManifest | null {
  return discoverManifests(root).find((entry) => entry.state === 'pending' && entry.manifest !== null) ?? null;
}

/* ------------------------------------------------------------------------------------ *
 * Worktree safety
 * ------------------------------------------------------------------------------------ */

export interface WorktreeAssessment {
  safe: boolean;
  /** Why the operation cannot proceed. Empty when it can. */
  blockers: string[];
  /** True-but-harmless observations, reported and not acted on. */
  advisories: string[];
  currentBranch: string | null;
  modifiedTrackedFiles: number;
}

/**
 * Decide whether it is safe to fetch a ref and push it.
 *
 * WHY THIS IS NARROWER THAN "THE WORKTREE IS CLEAN"
 * -------------------------------------------------
 * Fetching a ref out of a bundle and pushing it does not read, write or check
 * out a single file. Modified tracked files therefore cannot be damaged by it
 * and cannot make it wrong. Refusing on `git status` being non-empty would be
 * easy to write and would make the tool unusable on a checkout whose only sin is
 * a line-ending mismatch — which is exactly the state this repository is in on
 * the machine it has to run on.
 *
 * What genuinely makes the operation unsafe or ambiguous is a different list: an
 * interrupted merge, rebase, cherry-pick or bisect leaves refs in a state where
 * "what does this branch mean" has no stable answer; unmerged paths mean the
 * index is mid-conflict; and moving the branch you are standing on would move
 * the worktree under you. Those block. Everything else is reported.
 */
export async function assessWorktree(git: GitRunner, repoRoot: string, targetBranch: string): Promise<WorktreeAssessment> {
  const blockers: string[] = [];
  const advisories: string[] = [];

  const gitDirResult = await git(['rev-parse', '--git-dir']);
  const gitDir = gitDirResult.code === 0 ? path.resolve(repoRoot, gitDirResult.stdout.trim()) : repoRoot;
  const inProgress: Array<[string, string]> = [
    ['MERGE_HEAD', 'a merge is in progress'],
    ['rebase-merge', 'a rebase is in progress'],
    ['rebase-apply', 'a rebase or am is in progress'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
    ['REVERT_HEAD', 'a revert is in progress'],
    ['BISECT_LOG', 'a bisect is in progress'],
  ];
  for (const [marker, description] of inProgress) {
    if (existsSync(path.join(gitDir, marker))) blockers.push(`The repository is mid-operation: ${description}. Finish or abort it, then run this again.`);
  }

  const unmerged = await git(['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.code === 0 && unmerged.stdout.trim()) {
    blockers.push(`The index has unmerged paths (${unmerged.stdout.trim().split('\n').length} file(s)). Resolve the conflict before finalising a build.`);
  }

  const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  if (currentBranch === 'HEAD') advisories.push('The repository has a detached HEAD. That does not affect this operation.');

  const status = await git(['status', '--porcelain']);
  const lines = status.code === 0 ? status.stdout.split('\n').filter((line) => line.trim()) : [];
  const modifiedTrackedFiles = lines.filter((line) => !line.startsWith('??')).length;
  if (modifiedTrackedFiles > 0) {
    advisories.push(`${modifiedTrackedFiles} tracked file(s) are modified. Nothing this command does reads or writes them: it fetches a ref and pushes it.`);
  }

  // Moving the branch you are standing on would move the worktree with it. This
  // only matters when the branch already exists and points elsewhere; that case
  // is refused outright further down, so here it is a blocker only for clarity.
  if (currentBranch && currentBranch === targetBranch) {
    advisories.push(`${targetBranch} is the checked-out branch. It will be verified in place and never moved.`);
  }

  return { safe: blockers.length === 0, blockers, advisories, currentBranch, modifiedTrackedFiles };
}

/* ------------------------------------------------------------------------------------ *
 * Repository identity
 * ------------------------------------------------------------------------------------ */

/** `owner/repo` from any of the URL shapes git remotes actually use. */
export function repositoryFromRemoteUrl(url: string): string | null {
  const trimmed = (url ?? '').trim().replace(/\.git$/, '');
  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/,
    /^ssh:\/\/[^/]+\/([^/]+\/[^/]+)$/,
    /^[^@]+@[^:]+:([^/]+\/[^/]+)$/,
    /^file:\/\/.*\/([^/]+\/[^/]+)$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/* ------------------------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------------------------ */

export interface FinalizeOptions {
  manifestPath: string;
  repoRoot: string;
  handoffRoot: string;
  github: GitHubPort;
  drive?: DrivePort | null;
  gitPath?: string;
  /** Injected in tests so a completion manifest is reproducible. */
  now?: () => Date;
  onStep?: (step: FinalizeStep) => void;
  /** Verify and report without pushing, opening a pull request or uploading. */
  dryRun?: boolean;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function resolveRelative(base: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(base), target);
}

const TEXT_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(file: string): string {
  return TEXT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** `2026-07-31 — build-local-build-finalizer-v1 — a1b2c3d` */
export function buildFolderName(createdAt: string, branch: string, headSha: string): string {
  const day = createdAt.slice(0, 10);
  return `${day} — ${branch.replace(/\//g, '-')} — ${headSha.slice(0, 7)}`;
}

export async function finalizeBuild(options: FinalizeOptions): Promise<FinalizeResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const steps: FinalizeStep[] = [];
  const errors: string[] = [];
  const git = gitIn(options.repoRoot, { gitPath: options.gitPath });

  const record = (step: FinalizeStep) => {
    const redacted = { ...step, detail: redactSecrets(step.detail) };
    steps.push(redacted);
    options.onStep?.(redacted);
    if (redacted.status === 'failed') errors.push(`${redacted.title}: ${redacted.detail}`);
    return redacted;
  };

  const discovered = readManifestFile(options.manifestPath);
  const manifest = discovered.manifest;

  const result: FinalizeResult = {
    state: 'FAILED',
    manifestPath: options.manifestPath,
    repository: manifest?.repository ?? '',
    branch: manifest?.branch ?? '',
    baseBranch: manifest?.baseBranch ?? '',
    baselineSha: manifest?.baselineSha ?? '',
    expectedHeadSha: manifest?.expectedHeadSha ?? '',
    localHeadSha: null,
    remoteHeadSha: null,
    pullRequest: null,
    drive: { attempted: false, folderId: null, folderName: null, folderUrl: null, requiredCount: 0, uploadedCount: 0, connectionRequired: false, error: null },
    deliverables: [],
    steps,
    errors,
    startedAt,
    finishedAt: startedAt,
    completionManifestPath: null,
  };

  if (!manifest) {
    record({ key: 'manifest', title: 'Read the handoff manifest', status: 'failed', detail: discovered.error ?? 'The manifest could not be read.', mutated: false });
    result.finishedAt = now().toISOString();
    return finish(result, options, now);
  }
  record({ key: 'manifest', title: 'Read the handoff manifest', status: 'ok', detail: `${manifest.branch} at ${manifest.expectedHeadSha} from ${manifest.origin.model}.`, mutated: false });

  /* ---------------------------------------------------------------- identity */

  // `git config --get`, not `git remote get-url`: the latter applies `insteadOf`
  // rewriting, so an operator who rewrites GitHub URLs to SSH would see their own
  // repository reported as something else and be refused. The manifest names the
  // logical repository, which is what the configured URL expresses.
  const configuredUrl = await git(['config', '--get', 'remote.origin.url']);
  const remoteUrl = configuredUrl.code === 0 && configuredUrl.stdout.trim() ? configuredUrl : await git(['remote', 'get-url', 'origin']);
  if (remoteUrl.code !== 0 || !remoteUrl.stdout.trim()) {
    record({ key: 'repository', title: 'Verify the repository', status: 'failed', detail: `No 'origin' remote is configured in ${options.repoRoot}.`, mutated: false });
    return finish(result, options, now);
  }
  const actualRepository = repositoryFromRemoteUrl(remoteUrl.stdout);
  if (actualRepository !== manifest.repository) {
    record({
      key: 'repository',
      title: 'Verify the repository',
      status: 'failed',
      detail: `This manifest is for ${manifest.repository} but origin resolves to ${actualRepository ?? remoteUrl.stdout.trim()}. Refusing to act on a different repository.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  record({ key: 'repository', title: 'Verify the repository', status: 'ok', detail: `origin is ${actualRepository}.`, mutated: false });

  /* ----------------------------------------------------------------- worktree */

  const worktree = await assessWorktree(git, options.repoRoot, manifest.branch);
  if (!worktree.safe) {
    record({ key: 'worktree', title: 'Check the working tree', status: 'failed', detail: worktree.blockers.join(' '), mutated: false });
    return finish(result, options, now);
  }
  record({
    key: 'worktree',
    title: 'Check the working tree',
    status: 'ok',
    detail: worktree.advisories.length > 0 ? worktree.advisories.join(' ') : 'Nothing in progress and no unmerged paths.',
    mutated: false,
  });

  /* ------------------------------------------------------------------- bundle */

  const bundlePath = manifest.bundlePath ? resolveRelative(options.manifestPath, manifest.bundlePath) : null;
  const commitPresent = async () => (await git(['cat-file', '-e', `${manifest.expectedHeadSha}^{commit}`])).code === 0;
  let bundleCarriesExpectedHead = false;

  if (bundlePath && !(await commitPresent())) {
    if (!existsSync(bundlePath)) {
      record({ key: 'bundle', title: 'Verify the bundle', status: 'failed', detail: `The manifest names a bundle at ${bundlePath}, the commit is not in this repository, and the bundle is not there.`, mutated: false });
      return finish(result, options, now);
    }
    const verify = await git(['bundle', 'verify', '--', bundlePath]);
    if (verify.code !== 0) {
      record({ key: 'bundle', title: 'Verify the bundle', status: 'failed', detail: `git bundle verify failed: ${verify.stderr.trim() || verify.stdout.trim()}`, mutated: false });
      return finish(result, options, now);
    }
    const heads = await git(['bundle', 'list-heads', bundlePath]);
    const offered = heads.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/, 2);
      return { sha, ref };
    });
    const wanted = offered.find((entry) => entry.ref === `refs/heads/${manifest.branch}`);
    if (!wanted) {
      record({ key: 'bundle', title: 'Verify the bundle', status: 'failed', detail: `The bundle does not carry refs/heads/${manifest.branch}. It offers: ${offered.map((entry) => entry.ref).join(', ') || 'nothing'}.`, mutated: false });
      return finish(result, options, now);
    }
    if (wanted.sha !== manifest.expectedHeadSha) {
      record({ key: 'bundle', title: 'Verify the bundle', status: 'failed', detail: `The bundle carries ${manifest.branch} at ${wanted.sha}, but the manifest expects ${manifest.expectedHeadSha}.`, mutated: false });
      return finish(result, options, now);
    }
    bundleCarriesExpectedHead = true;
    record({ key: 'bundle', title: 'Verify the bundle', status: 'ok', detail: `Verified, and it carries ${manifest.branch} at the expected SHA.`, mutated: false });

    if (options.dryRun) {
      record({ key: 'fetch', title: 'Fetch the branch from the bundle', status: 'skipped', detail: 'Dry run: nothing was fetched.', mutated: false });
    } else {
      // Fetch into a temporary ref, never straight onto the branch: if the branch
      // already exists at an unexpected SHA the fetch would move it before the
      // check below could refuse.
      const temporaryRef = `refs/projectmanagair/finalize/${manifest.branch}`;
      const fetch = await git(['fetch', '--no-tags', '--', bundlePath, `refs/heads/${manifest.branch}:${temporaryRef}`], { timeoutMs: 180_000 });
      if (fetch.code !== 0) {
        record({ key: 'fetch', title: 'Fetch the branch from the bundle', status: 'failed', detail: `git fetch from the bundle failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`, mutated: false });
        return finish(result, options, now);
      }
      record({ key: 'fetch', title: 'Fetch the branch from the bundle', status: 'ok', detail: 'Objects fetched into a temporary ref. No branch was moved and no file was touched.', mutated: true });
    }
  } else if (bundlePath) {
    record({ key: 'bundle', title: 'Verify the bundle', status: 'skipped', detail: 'The commit is already in this repository, so the bundle was not needed.', mutated: false });
  } else {
    record({ key: 'bundle', title: 'Verify the bundle', status: 'skipped', detail: 'The manifest declares no bundle.', mutated: false });
  }

  const havePresentCommit = await commitPresent();
  if (!havePresentCommit && options.dryRun && bundleCarriesExpectedHead) {
    // A dry run does not fetch, so the commit is legitimately absent. The bundle
    // has already been verified to carry it at the expected SHA, which is the
    // strongest statement that can honestly be made without mutating anything.
    record({ key: 'commit', title: 'Verify the expected commit exists', status: 'skipped', detail: 'Dry run: the verified bundle carries this commit and would supply it.', mutated: false });
    record({ key: 'ancestry', title: 'Verify the declared baseline', status: 'skipped', detail: 'Dry run: the commit was not fetched, so its ancestry cannot be checked without mutating the repository.', mutated: false });
    record({ key: 'branch', title: 'Create or confirm the local branch', status: 'skipped', detail: 'Dry run: the branch was not created.', mutated: false });
    record({ key: 'remote-read', title: 'Read the remote branch', status: 'skipped', detail: 'Dry run: the remote was not consulted for a branch that was not fetched.', mutated: false });
    record({ key: 'push', title: 'Push to origin', status: 'skipped', detail: 'Dry run: nothing was pushed.', mutated: false });
    record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'skipped', detail: 'Dry run: nothing was pushed, so there is nothing to verify.', mutated: false });
    record({ key: 'pull-request', title: 'Open or update the draft pull request', status: 'skipped', detail: 'Dry run: no pull request was created or updated.', mutated: false });
    record({ key: 'drive', title: 'Mirror deliverables to Google Drive', status: 'skipped', detail: 'Dry run: nothing was uploaded.', mutated: false });
    result.state = 'PARTIAL';
    errors.push('Dry run: no mutation was performed, so the result is reported as PARTIAL by definition.');
    return finish(result, options, now, manifest);
  }
  if (!havePresentCommit) {
    record({ key: 'commit', title: 'Verify the expected commit exists', status: 'failed', detail: `Commit ${manifest.expectedHeadSha} is not in this repository and no bundle supplied it.`, mutated: false });
    return finish(result, options, now);
  }
  record({ key: 'commit', title: 'Verify the expected commit exists', status: 'ok', detail: `${manifest.expectedHeadSha} is present.`, mutated: false });

  /* ---------------------------------------------------------------- ancestry */

  if ((await git(['cat-file', '-e', `${manifest.baselineSha}^{commit}`])).code !== 0) {
    record({ key: 'ancestry', title: 'Verify the declared baseline', status: 'failed', detail: `The declared baseline ${manifest.baselineSha} is not in this repository, so the head's ancestry cannot be checked.`, mutated: false });
    return finish(result, options, now);
  }
  const ancestry = await git(['merge-base', '--is-ancestor', manifest.baselineSha, manifest.expectedHeadSha]);
  if (ancestry.code !== 0) {
    record({
      key: 'ancestry',
      title: 'Verify the declared baseline',
      status: 'failed',
      detail: `${manifest.expectedHeadSha} does not descend from the declared baseline ${manifest.baselineSha}. This is not the build the manifest describes.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  record({ key: 'ancestry', title: 'Verify the declared baseline', status: 'ok', detail: `${manifest.expectedHeadSha.slice(0, 12)} descends from ${manifest.baselineSha.slice(0, 12)}.`, mutated: false });

  /* ------------------------------------------------------------ local branch */

  const existingBranch = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${manifest.branch}`]);
  const existingSha = existingBranch.code === 0 ? existingBranch.stdout.trim() : null;
  if (existingSha && existingSha !== manifest.expectedHeadSha) {
    record({
      key: 'branch',
      title: 'Create or confirm the local branch',
      status: 'failed',
      detail: `A local branch ${manifest.branch} already exists at ${existingSha}, which is not the expected ${manifest.expectedHeadSha}. Refusing to move it — resolve this by hand and run again.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  if (existingSha) {
    record({ key: 'branch', title: 'Create or confirm the local branch', status: 'ok', detail: 'The branch already points at the expected SHA.', mutated: false });
  } else if (options.dryRun) {
    record({ key: 'branch', title: 'Create or confirm the local branch', status: 'skipped', detail: 'Dry run: the branch was not created.', mutated: false });
  } else {
    const create = await git(['branch', manifest.branch, manifest.expectedHeadSha]);
    if (create.code !== 0) {
      record({ key: 'branch', title: 'Create or confirm the local branch', status: 'failed', detail: `git branch failed: ${create.stderr.trim() || create.stdout.trim()}`, mutated: false });
      return finish(result, options, now);
    }
    record({ key: 'branch', title: 'Create or confirm the local branch', status: 'ok', detail: `Created ${manifest.branch} at the expected SHA. No file was checked out.`, mutated: true });
  }
  result.localHeadSha = options.dryRun && !existingSha ? null : (await git(['rev-parse', `refs/heads/${manifest.branch}`])).stdout.trim() || null;

  /* -------------------------------------------------------------- remote head */

  const remoteBefore = await git(['ls-remote', 'origin', `refs/heads/${manifest.branch}`], { timeoutMs: 120_000 });
  if (remoteBefore.code !== 0) {
    record({ key: 'remote-read', title: 'Read the remote branch', status: 'failed', detail: `git ls-remote failed: ${remoteBefore.stderr.trim() || remoteBefore.stdout.trim()}`, mutated: false });
    return finish(result, options, now);
  }
  const remoteShaBefore = remoteBefore.stdout.trim() ? remoteBefore.stdout.trim().split(/\s+/)[0] : null;
  if (remoteShaBefore && remoteShaBefore !== manifest.expectedHeadSha) {
    record({
      key: 'remote-read',
      title: 'Read the remote branch',
      status: 'failed',
      detail: `origin/${manifest.branch} already exists at ${remoteShaBefore}, which is not the expected ${manifest.expectedHeadSha}. Refusing to push — this would need a force-push, which this tool never performs.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  record({
    key: 'remote-read',
    title: 'Read the remote branch',
    status: 'ok',
    detail: remoteShaBefore ? 'The remote branch already points at the expected SHA.' : 'The remote branch does not exist yet.',
    mutated: false,
  });

  /* -------------------------------------------------------------------- push */

  if (remoteShaBefore === manifest.expectedHeadSha) {
    record({ key: 'push', title: 'Push to origin', status: 'skipped', detail: 'Already pushed. Nothing to do.', mutated: false });
  } else if (options.dryRun) {
    record({ key: 'push', title: 'Push to origin', status: 'skipped', detail: 'Dry run: nothing was pushed.', mutated: false });
  } else {
    const push = await git(['push', '--set-upstream', 'origin', `refs/heads/${manifest.branch}:refs/heads/${manifest.branch}`], { timeoutMs: 300_000 });
    if (push.code !== 0) {
      record({ key: 'push', title: 'Push to origin', status: 'failed', detail: `git push failed: ${push.stderr.trim() || push.stdout.trim()}`, mutated: false });
      return finish(result, options, now);
    }
    record({ key: 'push', title: 'Push to origin', status: 'ok', detail: `Pushed ${manifest.branch} with upstream tracking.`, mutated: true });
  }

  /* ----------------------------------------------------------- verify remote */

  if (options.dryRun && remoteShaBefore !== manifest.expectedHeadSha) {
    record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'skipped', detail: 'Dry run: nothing was pushed, so there is nothing to verify.', mutated: false });
  } else {
    const remoteAfter = await git(['ls-remote', 'origin', `refs/heads/${manifest.branch}`], { timeoutMs: 120_000 });
    const remoteShaAfter = remoteAfter.code === 0 && remoteAfter.stdout.trim() ? remoteAfter.stdout.trim().split(/\s+/)[0] : null;
    result.remoteHeadSha = remoteShaAfter;
    if (remoteShaAfter !== manifest.expectedHeadSha) {
      record({
        key: 'remote-verify',
        title: 'Verify the remote SHA',
        status: 'failed',
        detail: `After pushing, origin/${manifest.branch} reads ${remoteShaAfter ?? 'nothing'} but should read ${manifest.expectedHeadSha}.`,
        mutated: false,
      });
      return finish(result, options, now);
    }
    record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'ok', detail: `origin/${manifest.branch} is ${remoteShaAfter}, confirmed by ls-remote.`, mutated: false });
  }

  /* ------------------------------------------------------------ pull request */

  const prBody = manifest.pullRequest.body
    ?? (manifest.pullRequest.bodyPath && existsSync(resolveRelative(options.manifestPath, manifest.pullRequest.bodyPath))
      ? readFileSync(resolveRelative(options.manifestPath, manifest.pullRequest.bodyPath), 'utf8')
      : `Automated handoff for \`${manifest.branch}\` at \`${manifest.expectedHeadSha}\`.`);

  if (options.dryRun) {
    record({ key: 'pull-request', title: 'Open or update the draft pull request', status: 'skipped', detail: 'Dry run: no pull request was created or updated.', mutated: false });
  } else {
    try {
      const existing = await options.github.findPullRequest({ repository: manifest.repository, branch: manifest.branch, baseBranch: manifest.baseBranch });
      if (existing) {
        // Never a second pull request for the same head. Where the title or body
        // has moved on, the existing one is updated in place.
        const needsUpdate = existing.title !== manifest.pullRequest.title || existing.body !== prBody;
        const current = needsUpdate
          ? await options.github.updatePullRequest({ repository: manifest.repository, number: existing.number, title: manifest.pullRequest.title, body: prBody })
          : existing;
        result.pullRequest = { number: current.number, url: current.url, draft: current.draft, headSha: current.headSha, created: false };
        if (current.headSha && current.headSha !== manifest.expectedHeadSha) {
          // Recorded and carried into the verdict rather than returned from
          // here: the branch is pushed and verified, so this is a PARTIAL to
          // retry, not a FAILED that suggests nothing happened.
          record({
            key: 'pull-request',
            title: 'Open or update the draft pull request',
            status: 'failed',
            detail: `Pull request #${current.number} exists for ${manifest.branch} but its head is ${current.headSha}, not ${manifest.expectedHeadSha}. Nothing was changed on it.`,
            mutated: needsUpdate,
          });
        } else {
        record({
          key: 'pull-request',
          title: 'Open or update the draft pull request',
          status: 'ok',
          detail: `${needsUpdate ? 'Updated' : 'Confirmed'} existing pull request #${current.number} — ${current.url}`,
          mutated: needsUpdate,
        });
        }
      } else {
        const created = await options.github.createPullRequest({
          repository: manifest.repository,
          branch: manifest.branch,
          baseBranch: manifest.baseBranch,
          title: manifest.pullRequest.title,
          body: prBody,
          draft: manifest.pullRequest.draft,
        });
        result.pullRequest = { number: created.number, url: created.url, draft: created.draft, headSha: created.headSha, created: true };
        record({ key: 'pull-request', title: 'Open or update the draft pull request', status: 'ok', detail: `Created ${created.draft ? 'draft ' : ''}pull request #${created.number} — ${created.url}`, mutated: true });
      }
    } catch (error) {
      // The branch is pushed and verified. A pull-request failure is recoverable
      // by re-running, and must not undo or obscure that.
      record({
        key: 'pull-request',
        title: 'Open or update the draft pull request',
        status: 'failed',
        detail: `${error instanceof Error ? error.message : String(error)} The branch is pushed and verified on origin; re-run to retry only the pull request.`,
        mutated: false,
      });
    }
  }

  /* ------------------------------------------------------------------- drive */

  await mirrorDeliverables(manifest, options, result, record, now);

  /* ------------------------------------------------------------------ verdict */

  const gitFailed = steps.some((step) => step.status === 'failed' && !['pull-request', 'drive'].includes(step.key));
  const softFailed = steps.some((step) => step.status === 'failed' && ['pull-request', 'drive'].includes(step.key));
  result.state = gitFailed ? 'FAILED' : softFailed ? 'PARTIAL' : options.dryRun ? 'PARTIAL' : 'COMPLETED';
  if (options.dryRun) errors.push('Dry run: no mutation was performed, so the result is reported as PARTIAL by definition.');
  result.finishedAt = now().toISOString();
  return finish(result, options, now, manifest);
}

/* ------------------------------------------------------------------------------------ *
 * Drive mirroring
 * ------------------------------------------------------------------------------------ */

async function mirrorDeliverables(
  manifest: BuildHandoffManifest,
  options: FinalizeOptions,
  result: FinalizeResult,
  record: (step: FinalizeStep) => FinalizeStep,
  now: () => Date,
): Promise<void> {
  // Classify and hash every declared deliverable, whatever happens to Drive. The
  // classification is evidence in the completion manifest even when nothing is
  // uploaded, so a reader can see what was withheld and why.
  const declared = manifest.deliverables.map((entry): DeliverableResult => {
    const absolute = resolveRelative(options.manifestPath, entry.path);
    const present = existsSync(absolute);
    return {
      path: absolute,
      title: entry.title ?? path.basename(absolute),
      classification: entry.classification,
      required: entry.required,
      sha256: present ? sha256File(absolute) : null,
      bytes: present ? statSync(absolute).size : null,
      uploadStatus: !present ? 'missing' : entry.classification === 'safe_for_drive' ? 'failed' : 'skipped-classification',
      driveFileId: null,
      driveUrl: null,
      googleDocId: null,
      googleDocUrl: null,
      uploadedAt: null,
      error: present ? null : 'The file named by the manifest does not exist.',
    };
  });
  result.deliverables = declared;

  const safe = declared.filter((entry) => entry.classification === 'safe_for_drive' && entry.uploadStatus !== 'missing');
  result.drive.requiredCount = declared.filter((entry) => entry.required && entry.classification === 'safe_for_drive').length;

  if (!manifest.drive) {
    record({ key: 'drive', title: 'Mirror deliverables to Google Drive', status: 'skipped', detail: 'The manifest declares no Drive destination.', mutated: false });
    return;
  }
  result.drive.attempted = true;
  result.drive.folderName = manifest.drive.folderName;

  if (options.dryRun) {
    record({ key: 'drive', title: 'Mirror deliverables to Google Drive', status: 'skipped', detail: 'Dry run: nothing was uploaded.', mutated: false });
    return;
  }
  if (!options.drive) {
    result.drive.connectionRequired = true;
    result.drive.error = 'Google Drive connection required.';
    record({
      key: 'drive',
      title: 'Mirror deliverables to Google Drive',
      status: 'failed',
      detail: 'Google Drive connection required. Connect Drive in the Cockpit, then retry this handoff; the pushed branch and the pull request are unaffected.',
      mutated: false,
    });
    return;
  }

  try {
    await options.drive.ensureReady();
  } catch (error) {
    const connectionRequired = error instanceof DriveConnectionRequiredError;
    result.drive.connectionRequired = connectionRequired;
    result.drive.error = redactSecrets(error instanceof Error ? error.message : String(error));
    record({
      key: 'drive',
      title: 'Mirror deliverables to Google Drive',
      status: 'failed',
      detail: connectionRequired
        ? `Google Drive connection required. ${result.drive.error}`
        : `Google Drive is not usable: ${result.drive.error}`,
      mutated: false,
    });
    return;
  }

  try {
    // The build folder's identity is the branch plus the exact SHA, so
    // re-finalising the same build reuses it and a different SHA never lands in
    // someone else's folder.
    const parent = await ensureFolder(options.drive, manifest.drive.folderId, manifest.drive.buildDeliverablesFolder);
    const buildFolder = await ensureFolder(options.drive, parent.id, buildFolderName(manifest.createdAt, manifest.branch, manifest.expectedHeadSha));
    result.drive.folderId = buildFolder.id;
    result.drive.folderUrl = buildFolder.webViewLink ?? `https://drive.google.com/drive/folders/${buildFolder.id}`;

    let mutated = false;
    for (const entry of safe) {
      const declaration = manifest.deliverables.find((candidate) => resolveRelative(options.manifestPath, candidate.path) === entry.path)!;
      try {
        const existing = await options.drive.findChildFile(buildFolder.id, entry.title);
        const uploaded = await options.drive.uploadFile({
          parentId: buildFolder.id,
          name: entry.title,
          localPath: entry.path,
          mimeType: mimeFor(entry.path),
          existingId: existing?.id ?? null,
        });
        entry.driveFileId = uploaded.id;
        entry.driveUrl = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;
        entry.uploadStatus = existing ? 'updated' : 'uploaded';
        entry.uploadedAt = now().toISOString();
        entry.error = null;
        mutated = true;

        if (declaration.googleDoc) {
          const docName = `${entry.title.replace(/\.[^.]+$/, '')} (Doc)`;
          const existingDoc = await options.drive.findChildFile(buildFolder.id, docName);
          const doc = await options.drive.uploadAsGoogleDoc({ parentId: buildFolder.id, name: docName, localPath: entry.path, existingId: existingDoc?.id ?? null });
          entry.googleDocId = doc.id;
          entry.googleDocUrl = doc.webViewLink ?? `https://docs.google.com/document/d/${doc.id}/edit`;
        }
      } catch (error) {
        entry.uploadStatus = 'failed';
        entry.error = redactSecrets(error instanceof Error ? error.message : String(error));
      }
    }

    result.drive.uploadedCount = declared.filter((entry) => ['uploaded', 'updated'].includes(entry.uploadStatus)).length;
    const outstanding = declared.filter((entry) => entry.required && entry.classification === 'safe_for_drive' && !['uploaded', 'updated'].includes(entry.uploadStatus));
    if (outstanding.length > 0) {
      result.drive.error = `${outstanding.length} required deliverable(s) did not upload.`;
      record({
        key: 'drive',
        title: 'Mirror deliverables to Google Drive',
        status: 'failed',
        detail: `${result.drive.uploadedCount} of ${result.drive.requiredCount} required deliverable(s) uploaded. Outstanding: ${outstanding.map((entry) => `${entry.title} (${entry.error ?? 'unknown reason'})`).join('; ')}`,
        mutated,
      });
      return;
    }
    record({
      key: 'drive',
      title: 'Mirror deliverables to Google Drive',
      status: 'ok',
      detail: `${result.drive.uploadedCount} deliverable(s) in ${result.drive.folderUrl}. ${declared.length - safe.length} withheld by classification.`,
      mutated,
    });
  } catch (error) {
    result.drive.error = redactSecrets(error instanceof Error ? error.message : String(error));
    record({ key: 'drive', title: 'Mirror deliverables to Google Drive', status: 'failed', detail: result.drive.error, mutated: false });
  }
}

async function ensureFolder(drive: DrivePort, parentId: string, name: string): Promise<DriveFile> {
  return (await drive.findChildFolder(parentId, name)) ?? (await drive.createFolder(parentId, name));
}

/* ------------------------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------------------------ */

/**
 * Write the completion manifest and move a fully completed handoff out of
 * `pending`.
 *
 * A PARTIAL or FAILED handoff stays exactly where it is, so "retry" means
 * "press it again" rather than "find the file and move it back". The completion
 * manifest is written in every case, including failure, because the most useful
 * moment for a record of what happened is when something went wrong.
 */
function finish(result: FinalizeResult, options: FinalizeOptions, now: () => Date, manifest?: BuildHandoffManifest): FinalizeResult {
  result.finishedAt = now().toISOString();
  const locations = handoffLocations(options.handoffRoot);
  const completionName = `${path.basename(options.manifestPath, '.json')}${COMPLETION_SUFFIX}`;
  const completionDirectory = result.state === 'COMPLETED' ? locations.completed : locations.pending;
  try {
    mkdirSync(completionDirectory, { recursive: true });
    const completionPath = path.join(completionDirectory, completionName);
    writeFileSync(completionPath, `${JSON.stringify(redactCompletion(result), null, 2)}\n`, 'utf8');
    result.completionManifestPath = completionPath;
  } catch (error) {
    result.errors.push(`The completion manifest could not be written: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }

  if (result.state === 'COMPLETED' && manifest && path.basename(path.dirname(options.manifestPath)) === PENDING_DIR) {
    try {
      mkdirSync(locations.completed, { recursive: true });
      const destination = path.join(locations.completed, path.basename(options.manifestPath));
      renameSync(options.manifestPath, destination);
      result.manifestPath = destination;
    } catch (error) {
      result.errors.push(`The handoff completed but the manifest could not be moved to completed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return result;
}

function redactCompletion(result: FinalizeResult): FinalizeResult {
  return JSON.parse(redactSecrets(JSON.stringify(result))) as FinalizeResult;
}

/** A short, readable account of what happened, for a console or a log. */
export function renderFinalizeReport(result: FinalizeResult): string {
  const lines: string[] = [];
  lines.push(`Build finalisation: ${result.state}`);
  lines.push('');
  lines.push(`  Repository   ${result.repository}`);
  lines.push(`  Branch       ${result.branch} -> ${result.baseBranch}`);
  lines.push(`  Expected SHA ${result.expectedHeadSha}`);
  lines.push(`  Remote SHA   ${result.remoteHeadSha ?? 'not verified'}`);
  if (result.pullRequest) lines.push(`  Pull request #${result.pullRequest.number} ${result.pullRequest.draft ? '(draft) ' : ''}${result.pullRequest.url}`);
  if (result.drive.attempted) {
    lines.push(`  Drive folder ${result.drive.folderUrl ?? 'not created'}`);
    lines.push(`  Deliverables ${result.drive.uploadedCount} of ${result.drive.requiredCount} required uploaded`);
  }
  lines.push('');
  for (const step of result.steps) {
    const mark = step.status === 'ok' ? '  ok  ' : step.status === 'skipped' ? ' skip ' : ' FAIL ';
    lines.push(`[${mark}] ${step.title} — ${step.detail}`);
  }
  if (result.errors.length > 0) {
    lines.push('');
    lines.push('Outstanding:');
    for (const error of result.errors) lines.push(`  - ${error}`);
  }
  if (result.completionManifestPath) {
    lines.push('');
    lines.push(`Completion manifest: ${result.completionManifestPath}`);
  }
  return lines.join('\n');
}
