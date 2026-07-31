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
 * This repository is PUBLIC, so `safe_for_public_git` is a deliberate statement
 * about a file that anyone on the internet may read — never a default. There is
 * no inferred classification: a builder that does not classify a file cannot
 * declare it at all, and nothing unclassified is ever committed or uploaded.
 *
 *   safe_for_public_git     may be committed to this public repository, and
 *                           mirrored to Drive if Drive is configured.
 *   safe_for_drive          not for public Git; may be mirrored to Drive.
 *   optional_private_mirror kept out of public Git on purpose; mirrored only
 *                           when a Drive destination is explicitly declared.
 *   local_only              never leaves the machine.
 *   contains_customer_data  never leaves the machine, and never enters Git.
 *   contains_secrets        never leaves the machine, and never enters Git.
 */
export const DELIVERABLE_CLASSIFICATIONS = [
  'safe_for_public_git',
  'safe_for_drive',
  'optional_private_mirror',
  'local_only',
  'contains_customer_data',
  'contains_secrets',
] as const;
export type DeliverableClassification = typeof DELIVERABLE_CLASSIFICATIONS[number];

/** The only classification that may be committed to a public repository. */
export const GIT_COMMITTABLE: readonly DeliverableClassification[] = ['safe_for_public_git'];

/**
 * What may go to Drive, when a Drive destination is declared. Drive is a private
 * folder, so it is a superset of what public Git may hold — but never a route
 * for customer data, secrets or anything marked local_only.
 */
export const DRIVE_MIRRORABLE: readonly DeliverableClassification[] = ['safe_for_public_git', 'safe_for_drive', 'optional_private_mirror'];

export function mayEnterPublicGit(classification: DeliverableClassification): boolean {
  return GIT_COMMITTABLE.includes(classification);
}

export function mayBeMirroredToDrive(classification: DeliverableClassification): boolean {
  return DRIVE_MIRRORABLE.includes(classification);
}

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
  /**
   * The host `origin` must point at. Defaults to github.com, because that is
   * where the pull request is afterwards created; a manifest for anywhere else
   * has to say so, rather than `owner/repo` matching a mirror by accident.
   */
  remoteHost: z.string().min(1).optional(),
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
  /** The full, possibly machine-specific handoff, kept outside Git. */
  handoffDocumentPath: z.string().min(1).nullable().default(null),
  /**
   * Repository-relative path of the SANITISED handoff committed to Git — the
   * canonical build record. GitHub is the canonical record, so a build that
   * names one is not COMPLETED until that file is proved present in the exact
   * commit being pushed.
   */
  gitHandoffPath: z.string().min(1).nullable().default(null),
  deliverables: z.array(deliverableSchema).default([]),
  /**
   * Optional. Google Drive is a convenience mirror, not part of the completion
   * contract: omit this and Drive reports `disabled` and changes nothing about
   * the verdict.
   */
  drive: z.object({
    folderId: z.string().min(1),
    folderName: z.string().min(1).default('ProjectManagAIr'),
    buildDeliverablesFolder: z.string().min(1).default('Build Deliverables'),
    /**
     * Opt in to Drive being load-bearing. Off by default: a missing OAuth client
     * or a Drive outage must never turn a pushed, verified, PR'd build into
     * PARTIAL.
     */
    required: z.boolean().default(false),
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
  uploadStatus: 'uploaded' | 'updated' | 'unchanged' | 'skipped-classification' | 'missing' | 'unreadable' | 'not-attempted' | 'failed';
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
  /** Whether the canonical record — the sanitised handoff — is in the pushed commit. */
  gitHandoff: {
    path: string | null;
    /** `present` in the exact commit, `missing` from it, or `not-declared`. */
    status: 'present' | 'missing' | 'not-declared';
  };
  drive: {
    /**
     * Google Drive is optional and is never part of the completion contract
     * unless the manifest opts in with `drive.required`.
     *
     *   disabled       the manifest declares no Drive destination
     *   not_configured declared, but Drive is not connected on this machine
     *   skipped        deliberately not run (a dry run)
     *   mirrored       deliverables are in the build folder
     *   failed         Drive was configured and something went wrong
     */
    status: 'disabled' | 'not_configured' | 'skipped' | 'mirrored' | 'failed';
    /** True only when the manifest opted in; otherwise a Drive failure cannot change the verdict. */
    required: boolean;
    attempted: boolean;
    folderId: string | null;
    folderName: string | null;
    folderUrl: string | null;
    requiredCount: number;
    uploadedCount: number;
    connectionRequired: boolean;
    error: string | null;
    /** The completion record's own copy in the build folder, uploaded after it is written. */
    completionRecordId: string | null;
    completionRecordUrl: string | null;
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
 * The pending manifest the no-argument command should act on.
 *
 * Never-attempted handoffs come first, newest of those; only then the newest
 * previously-attempted one. Without that, a handoff stuck at PARTIAL — because
 * Drive is not connected yet, say — would be selected forever and a second
 * pending handoff behind it would never be reached at all.
 *
 * An invalid file is skipped rather than fatal: one malformed manifest left
 * behind by a failed build must not stop the next good one from finalising, and
 * the Cockpit lists the malformed file with its parse error either way.
 */
export function newestPendingManifest(root: string): DiscoveredManifest | null {
  const pending = discoverManifests(root).filter((entry) => entry.state === 'pending' && entry.manifest !== null);
  const attempted = (entry: DiscoveredManifest) =>
    existsSync(path.join(path.dirname(entry.path), `${path.basename(entry.path, '.json')}${COMPLETION_SUFFIX}`));
  return pending.find((entry) => !attempted(entry)) ?? pending[0] ?? null;
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

/** The host a remote URL points at, and the `owner/repo` beneath it. */
export interface RemoteIdentity {
  /** Lower-cased hostname, or `(local)` for a `file://` remote. */
  host: string;
  repository: string;
}

/**
 * `owner/repo` and the host it lives on, from the URL shapes git remotes use.
 *
 * The host matters. `owner/repo` alone is not an identity: an internal mirror, a
 * GitLab copy or a look-alike host can carry the same path, and the pull request
 * is afterwards created against `api.github.com/repos/<that path>` — a different
 * repository from the one just pushed to. Both halves are compared.
 */
export function remoteIdentityFromUrl(url: string): RemoteIdentity | null {
  const trimmed = (url ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const patterns: Array<{ pattern: RegExp; host: number | null; repository: number }> = [
    { pattern: /^https?:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+)$/, host: 1, repository: 2 },
    { pattern: /^ssh:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+)$/, host: 1, repository: 2 },
    { pattern: /^[^@/]+@([^:/]+):([^/]+\/[^/]+)$/, host: 1, repository: 2 },
    { pattern: /^file:\/\/.*\/([^/]+\/[^/]+)$/, host: null, repository: 1 },
  ];
  for (const { pattern, host, repository } of patterns) {
    const match = trimmed.match(pattern);
    if (match) return { host: host === null ? LOCAL_REMOTE_HOST : match[host].toLowerCase(), repository: match[repository] };
  }
  return null;
}

/** The host recorded for a `file://` remote, which is what the test fixtures use. */
export const LOCAL_REMOTE_HOST = '(local)';
export const DEFAULT_REMOTE_HOST = 'github.com';

/** `owner/repo` alone, kept for callers that only need the path. */
export function repositoryFromRemoteUrl(url: string): string | null {
  return remoteIdentityFromUrl(url)?.repository ?? null;
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

  /**
   * Failures that leave a correct, pushed branch behind and are retryable by
   * running again. Anything else is a hard failure that changed nothing.
   *
   * `remote-verify` joins this list once the push has actually succeeded: a
   * transient `ls-remote` failure a second after a successful push must not be
   * reported as "FAILED — nothing was changed", which is the opposite of what
   * happened.
   */
  const SOFT_FAILURE_KEYS: string[] = ['pull-request', 'drive'];

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
    gitHandoff: { path: manifest?.gitHandoffPath ?? null, status: 'not-declared' },
    drive: { status: 'disabled', required: false, attempted: false, folderId: null, folderName: null, folderUrl: null, requiredCount: 0, uploadedCount: 0, connectionRequired: false, error: null, completionRecordId: null, completionRecordUrl: null },
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
  const identity = remoteIdentityFromUrl(remoteUrl.stdout);
  const expectedHost = (manifest.remoteHost ?? DEFAULT_REMOTE_HOST).toLowerCase();
  if (identity?.repository !== manifest.repository || identity.host !== expectedHost) {
    record({
      key: 'repository',
      title: 'Verify the repository',
      status: 'failed',
      detail: `This manifest is for ${manifest.repository} on ${expectedHost} but origin resolves to ${identity ? `${identity.repository} on ${identity.host}` : remoteUrl.stdout.trim()}. Refusing to act on a different repository.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  record({ key: 'repository', title: 'Verify the repository', status: 'ok', detail: `origin is ${identity.repository} on ${identity.host}.`, mutated: false });

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
    if (heads.code !== 0) {
      record({ key: 'bundle', title: 'Verify the bundle', status: 'failed', detail: `git bundle list-heads failed, so what the bundle carries is unknown: ${heads.stderr.trim() || heads.stdout.trim()}`, mutated: false });
      return finish(result, options, now);
    }
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
    record({
      key: 'git-handoff',
      title: 'Verify the committed build record',
      status: manifest.gitHandoffPath ? 'skipped' : 'failed',
      detail: manifest.gitHandoffPath
        ? `Dry run: ${manifest.gitHandoffPath} cannot be read out of a commit that was not fetched.`
        : 'This manifest declares no gitHandoffPath. GitHub is the canonical build record, so a build must commit a sanitised handoff and name it here.',
      mutated: false,
    });

    // The two refusals a dry run exists to surface are both read-only, so they
    // are performed for real rather than skipped. Without these the dry run
    // reported "everything looks fine" while checking almost nothing.
    const dryBranch = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${manifest.branch}`]);
    const dryBranchSha = dryBranch.code === 0 ? dryBranch.stdout.trim() : null;
    if (dryBranchSha && dryBranchSha !== manifest.expectedHeadSha) {
      record({ key: 'branch', title: 'Create or confirm the local branch', status: 'failed', detail: `A local branch ${manifest.branch} already exists at ${dryBranchSha}, which is not the expected ${manifest.expectedHeadSha}. A real run would refuse rather than move it.`, mutated: false });
    } else {
      record({ key: 'branch', title: 'Create or confirm the local branch', status: 'ok', detail: dryBranchSha ? 'The branch already points at the expected SHA.' : 'No local branch of that name exists; a real run would create one. Dry run: not created.', mutated: false });
    }

    const dryRemote = await git(['ls-remote', 'origin', `refs/heads/${manifest.branch}`], { timeoutMs: 120_000 });
    if (dryRemote.code !== 0) {
      record({ key: 'remote-read', title: 'Read the remote branch', status: 'failed', detail: `git ls-remote failed: ${dryRemote.stderr.trim() || dryRemote.stdout.trim()}`, mutated: false });
    } else {
      const dryRemoteSha = dryRemote.stdout.trim() ? dryRemote.stdout.trim().split(/\s+/)[0] : null;
      if (dryRemoteSha && dryRemoteSha !== manifest.expectedHeadSha) {
        record({ key: 'remote-read', title: 'Read the remote branch', status: 'failed', detail: `origin/${manifest.branch} already exists at ${dryRemoteSha}, which is not the expected ${manifest.expectedHeadSha}. A real run would refuse rather than force-push.`, mutated: false });
      } else {
        record({ key: 'remote-read', title: 'Read the remote branch', status: 'ok', detail: dryRemoteSha ? 'The remote branch already points at the expected SHA.' : 'The remote branch does not exist yet.', mutated: false });
      }
    }

    record({ key: 'push', title: 'Push to origin', status: 'skipped', detail: 'Dry run: nothing was pushed.', mutated: false });
    record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'skipped', detail: 'Dry run: nothing was pushed, so there is nothing to verify.', mutated: false });
    record({ key: 'pull-request', title: 'Open or update the draft pull request', status: 'skipped', detail: 'Dry run: no pull request was created or updated.', mutated: false });
    record({ key: 'drive', title: 'Mirror deliverables to Google Drive', status: 'skipped', detail: 'Dry run: nothing was uploaded.', mutated: false });
    result.state = steps.some((step) => step.status === 'failed') ? 'FAILED' : 'PARTIAL';
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

  /* ------------------------------------------------- the canonical Git record */

  // GitHub is the canonical build record. A build whose sanitised handoff is not
  // in the commit being pushed is not finished, however well the push itself
  // goes — so this is checked against the commit's own tree, before the push,
  // rather than trusted from the manifest.
  if (!manifest.gitHandoffPath) {
    result.gitHandoff = { path: null, status: 'not-declared' };
    record({
      key: 'git-handoff',
      title: 'Verify the committed build record',
      status: 'failed',
      detail: 'This manifest declares no gitHandoffPath. GitHub is the canonical build record, so a build must commit a sanitised handoff and name it here.',
      mutated: false,
    });
    return finish(result, options, now);
  }
  const committedHandoff = await git(['cat-file', '-e', `${manifest.expectedHeadSha}:${manifest.gitHandoffPath}`]);
  if (committedHandoff.code !== 0) {
    result.gitHandoff = { path: manifest.gitHandoffPath, status: 'missing' };
    record({
      key: 'git-handoff',
      title: 'Verify the committed build record',
      status: 'failed',
      detail: `${manifest.gitHandoffPath} is not in commit ${manifest.expectedHeadSha}. The canonical build record must be committed on the branch being pushed; commit it and produce a new bundle.`,
      mutated: false,
    });
    return finish(result, options, now);
  }
  result.gitHandoff = { path: manifest.gitHandoffPath, status: 'present' };
  record({ key: 'git-handoff', title: 'Verify the committed build record', status: 'ok', detail: `${manifest.gitHandoffPath} is present in ${manifest.expectedHeadSha.slice(0, 12)}.`, mutated: false });

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
  if (options.dryRun && !existingSha) {
    result.localHeadSha = null;
  } else {
    // `git rev-parse` echoes its argument to stdout when it cannot resolve it,
    // so an unchecked exit code here writes the literal string
    // `refs/heads/<branch>` into the completion manifest as a SHA.
    const resolved = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${manifest.branch}`]);
    result.localHeadSha = resolved.code === 0 && /^[0-9a-f]{40}$/.test(resolved.stdout.trim()) ? resolved.stdout.trim() : null;
  }

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
  const pushed = steps.some((step) => step.key === 'push' && step.status === 'ok') || remoteShaBefore === manifest.expectedHeadSha;
  if (pushed) SOFT_FAILURE_KEYS.push('remote-verify');

  /* ----------------------------------------------------------- verify remote */

  if (options.dryRun && remoteShaBefore !== manifest.expectedHeadSha) {
    record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'skipped', detail: 'Dry run: nothing was pushed, so there is nothing to verify.', mutated: false });
  } else {
    const remoteAfter = await git(['ls-remote', 'origin', `refs/heads/${manifest.branch}`], { timeoutMs: 120_000 });
    const remoteShaAfter = remoteAfter.code === 0 && remoteAfter.stdout.trim() ? remoteAfter.stdout.trim().split(/\s+/)[0] : null;
    result.remoteHeadSha = remoteShaAfter;
    if (remoteShaAfter !== manifest.expectedHeadSha) {
      // A failed read and a wrong answer are different things, and saying which
      // is the difference between "run it again" and "stop and look".
      const detail = remoteAfter.code !== 0
        ? `The push ${pushed ? 'succeeded' : 'was not needed'}, but reading origin/${manifest.branch} back failed: ${remoteAfter.stderr.trim() || remoteAfter.stdout.trim() || `git ls-remote exited ${remoteAfter.code}`}. The remote SHA is therefore unconfirmed. Run this again to re-read it; nothing was undone.`
        : `After pushing, origin/${manifest.branch} reads ${remoteShaAfter ?? 'nothing'} but should read ${manifest.expectedHeadSha}.`;
      record({ key: 'remote-verify', title: 'Verify the remote SHA', status: 'failed', detail, mutated: false });
      // Unverified means no pull request: a PR must never be opened against a
      // head this tool has not proved is on origin.
      record({ key: 'pull-request', title: 'Open or update the draft pull request', status: 'skipped', detail: 'Skipped: the remote SHA was not confirmed, so no pull request was opened or updated.', mutated: false });
      result.drive.status = 'skipped';
      record({ key: 'drive', title: 'Mirror deliverables to Google Drive (optional)', status: 'skipped', detail: 'Skipped: the remote SHA was not confirmed.', mutated: false });
      result.state = pushed ? 'PARTIAL' : 'FAILED';
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
        // The head check comes FIRST. A pull request whose head is not the SHA
        // this manifest describes is not this build's pull request, and its
        // title and body must not be rewritten before discovering that.
        if (existing.headSha && existing.headSha !== manifest.expectedHeadSha) {
          result.pullRequest = { number: existing.number, url: existing.url, draft: existing.draft, headSha: existing.headSha, created: false };
          // Recorded and carried into the verdict rather than returned from
          // here: the branch is pushed and verified, so this is a PARTIAL to
          // retry, not a FAILED that suggests nothing happened.
          record({
            key: 'pull-request',
            title: 'Open or update the draft pull request',
            status: 'failed',
            detail: `Pull request #${existing.number} exists for ${manifest.branch} but its head is ${existing.headSha}, not ${manifest.expectedHeadSha}. Nothing was changed on it.`,
            mutated: false,
          });
        } else {
          // Never a second pull request for the same head. Where the title or
          // body has moved on, the existing one is updated in place.
          const needsUpdate = existing.title !== manifest.pullRequest.title || existing.body !== prBody;
          const current = needsUpdate
            ? await options.github.updatePullRequest({ repository: manifest.repository, number: existing.number, title: manifest.pullRequest.title, body: prBody })
            : existing;
          result.pullRequest = { number: current.number, url: current.url, draft: current.draft, headSha: current.headSha, created: false };
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

  try {
    await mirrorDeliverables(manifest, options, result, record, now);
  } catch (error) {
    // Nothing in the Drive half may destroy the record of the Git half. This is
    // the last line of defence behind the per-deliverable guards above.
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    result.drive.error = message;
    result.drive.status = 'failed';
    record({ key: 'drive', title: DRIVE_STEP_TITLE, status: 'failed', detail: `The optional Drive mirror failed unexpectedly: ${message} The branch is pushed and verified on origin; re-run to retry only the mirror.`, mutated: false });
  }

  /* ------------------------------------------------------------------ verdict */

  // Google Drive is an optional mirror. Unless the manifest explicitly opted in
  // with `drive.required`, a Drive failure is reported in `drive.status` and in
  // the errors, and changes nothing about the verdict: a build that is pushed,
  // verified, PR'd and carrying its committed record in Git is COMPLETED.
  const driveCounts = Boolean(manifest.drive?.required);
  const gitFailed = steps.some((step) => step.status === 'failed' && !SOFT_FAILURE_KEYS.includes(step.key));
  const softFailed = steps.some((step) => step.status === 'failed' && SOFT_FAILURE_KEYS.includes(step.key) && (step.key !== 'drive' || driveCounts));
  result.state = gitFailed ? 'FAILED' : softFailed ? 'PARTIAL' : options.dryRun ? 'PARTIAL' : 'COMPLETED';
  if (options.dryRun) errors.push('Dry run: no mutation was performed, so the result is reported as PARTIAL by definition.');
  result.finishedAt = now().toISOString();
  finish(result, options, now, manifest);
  await mirrorCompletionRecord(options, result, now);
  return result;
}

/**
 * Upload the completion record itself, once it exists.
 *
 * The build folder must contain the evidence of its own finalisation, not just
 * the deliverables — otherwise the only durable record of the pushed SHA, the
 * pull request and the Drive ids lives on one Windows machine.
 *
 * It necessarily happens after `finish()` has written the file, so the copy that
 * lands in Drive is the one that does not yet name its own Drive id. The local
 * file is rewritten afterwards so that it does. Neither copy is ever missing
 * anything else.
 */
async function mirrorCompletionRecord(options: FinalizeOptions, result: FinalizeResult, now: () => Date): Promise<void> {
  if (options.dryRun || !options.drive || !result.drive.folderId || !result.completionManifestPath) return;
  if (!existsSync(result.completionManifestPath)) return;
  try {
    const name = path.basename(result.completionManifestPath);
    const existing = await options.drive.findChildFile(result.drive.folderId, name);
    const uploaded = await options.drive.uploadFile({
      parentId: result.drive.folderId,
      name,
      localPath: result.completionManifestPath,
      mimeType: 'application/json',
      existingId: existing?.id ?? null,
    });
    result.drive.completionRecordId = uploaded.id;
    result.drive.completionRecordUrl = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;
    writeFileSync(result.completionManifestPath, `${JSON.stringify(redactCompletion(result), null, 2)}\n`, 'utf8');
  } catch (error) {
    // Never downgrade a finished run because its receipt did not upload. The
    // verdict is already decided and the local record already exists.
    result.errors.push(`The completion record was written locally but not mirrored: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    void now;
  }
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
    const base: DeliverableResult = {
      path: absolute,
      title: entry.title ?? path.basename(absolute),
      classification: entry.classification,
      required: entry.required,
      sha256: null,
      bytes: null,
      // Not `failed`: nothing has been attempted yet. A manifest that declares no
      // Drive destination must not leave a COMPLETED run carrying deliverables
      // marked failed, which is what the previous initial value produced.
      uploadStatus: 'not-attempted',
      driveFileId: null,
      driveUrl: null,
      googleDocId: null,
      googleDocUrl: null,
      uploadedAt: null,
      error: null,
    };
    if (!existsSync(absolute)) {
      return { ...base, uploadStatus: 'missing', error: 'The file named by the manifest does not exist.' };
    }
    // Hashing is I/O and can fail for reasons that have nothing to do with the
    // build: a directory named where a file was meant, a file locked by another
    // Windows process, a file too large to read into memory. None of those may
    // be allowed to throw out of here — the branch is already pushed by this
    // point and an exception would mean no completion manifest is ever written.
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) {
        return { ...base, uploadStatus: 'unreadable', error: `${absolute} is not a regular file, so it cannot be hashed or uploaded.` };
      }
      return { ...base, sha256: sha256File(absolute), bytes: stat.size, uploadStatus: mayBeMirroredToDrive(entry.classification) ? 'not-attempted' : 'skipped-classification' };
    } catch (error) {
      return { ...base, uploadStatus: 'unreadable', error: `${absolute} could not be read: ${redactSecrets(error instanceof Error ? error.message : String(error))}` };
    }
  });
  disambiguateTitles(declared);
  result.deliverables = declared;

  const safe = declared.filter((entry) => mayBeMirroredToDrive(entry.classification) && !['missing', 'unreadable'].includes(entry.uploadStatus));
  result.drive.requiredCount = declared.filter((entry) => entry.required && mayBeMirroredToDrive(entry.classification)).length;
  result.drive.required = Boolean(manifest.drive?.required);

  if (!manifest.drive) {
    result.drive.status = 'disabled';
    record({ key: 'drive', title: DRIVE_STEP_TITLE, status: 'skipped', detail: 'Google Drive mirroring is not enabled for this build. GitHub is the canonical record.', mutated: false });
    return;
  }
  result.drive.attempted = true;
  result.drive.folderName = manifest.drive.folderName;

  if (options.dryRun) {
    result.drive.status = 'skipped';
    record({ key: 'drive', title: DRIVE_STEP_TITLE, status: 'skipped', detail: 'Dry run: nothing was uploaded.', mutated: false });
    return;
  }
  if (!options.drive) {
    result.drive.connectionRequired = true;
    result.drive.status = 'not_configured';
    result.drive.error = 'Google Drive is not configured on this machine.';
    record({
      key: 'drive',
      title: DRIVE_STEP_TITLE,
      status: manifest.drive.required ? 'failed' : 'skipped',
      detail: `Google Drive is not configured on this machine, so the optional mirror was not run.${manifest.drive.required ? ' This manifest marks Drive required, so the build is PARTIAL until it is connected.' : ' The Git finalisation is unaffected.'}`,
      mutated: false,
    });
    return;
  }

  try {
    await options.drive.ensureReady();
  } catch (error) {
    const connectionRequired = error instanceof DriveConnectionRequiredError;
    result.drive.connectionRequired = connectionRequired;
    result.drive.status = connectionRequired ? 'not_configured' : 'failed';
    result.drive.error = redactSecrets(error instanceof Error ? error.message : String(error));
    record({
      key: 'drive',
      title: DRIVE_STEP_TITLE,
      status: manifest.drive.required ? 'failed' : 'skipped',
      detail: connectionRequired
        ? `Google Drive is not connected on this machine, so the optional mirror was not run: ${result.drive.error}${manifest.drive.required ? '' : ' The Git finalisation is unaffected.'}`
        : `The optional Google Drive mirror is not usable: ${result.drive.error}${manifest.drive.required ? '' : ' The Git finalisation is unaffected.'}`,
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
    const outstanding = declared.filter((entry) => entry.required && mayBeMirroredToDrive(entry.classification) && !['uploaded', 'updated'].includes(entry.uploadStatus));
    if (outstanding.length > 0) {
      result.drive.status = 'failed';
      result.drive.error = `${outstanding.length} deliverable(s) did not reach the optional Drive mirror.`;
      record({
        key: 'drive',
        title: DRIVE_STEP_TITLE,
        status: 'failed',
        detail: `${result.drive.uploadedCount} of ${result.drive.requiredCount} deliverable(s) reached the optional Drive mirror. Outstanding: ${outstanding.map((entry) => `${entry.title} (${entry.error ?? 'unknown reason'})`).join('; ')}${manifest.drive.required ? '' : ' The Git finalisation is unaffected.'}`,
        mutated,
      });
      return;
    }
    result.drive.status = 'mirrored';
    record({
      key: 'drive',
      title: DRIVE_STEP_TITLE,
      status: 'ok',
      detail: `${result.drive.uploadedCount} deliverable(s) in ${result.drive.folderUrl}. ${declared.filter((entry) => entry.uploadStatus === 'skipped-classification').length} withheld by classification, ${declared.filter((entry) => ['missing', 'unreadable'].includes(entry.uploadStatus)).length} unreadable or absent.`,
      mutated,
    });
  } catch (error) {
    result.drive.status = 'failed';
    result.drive.error = redactSecrets(error instanceof Error ? error.message : String(error));
    record({ key: 'drive', title: DRIVE_STEP_TITLE, status: 'failed', detail: `${result.drive.error}${manifest.drive.required ? '' : ' This is the optional mirror; the Git finalisation is unaffected.'}`, mutated: false });
  }
}

/** One title, used everywhere, so the Cockpit and the report agree it is optional. */
const DRIVE_STEP_TITLE = 'Mirror deliverables to Google Drive (optional)';

/**
 * Make every deliverable title unique within the build folder.
 *
 * The Drive file identity is the title inside the build folder, so two
 * deliverables in different directories that share a basename — `reports/
 * acceptance.md` and `review/acceptance.md`, which the build contract's required
 * list makes entirely likely — would otherwise resolve to one Drive file, the
 * second silently overwriting the first while both were reported as mirrored.
 *
 * The rename is derived from the declared path alone, so it is the same on every
 * run and re-finalising the same build still updates the same file rather than
 * creating a second one.
 */
function disambiguateTitles(declared: DeliverableResult[]): void {
  const counts = new Map<string, number>();
  for (const entry of declared) counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1);
  const used = new Set<string>();
  for (const entry of declared) {
    if ((counts.get(entry.title) ?? 0) > 1) {
      const parent = path.basename(path.dirname(entry.path));
      entry.title = parent ? `${parent} — ${entry.title}` : entry.title;
    }
    if (used.has(entry.title)) {
      // Still colliding: fall back to a stable digest of the full path rather
      // than letting two entries share a Drive file.
      const suffix = createHash('sha256').update(entry.path).digest('hex').slice(0, 8);
      const extension = path.extname(entry.title);
      entry.title = `${entry.title.slice(0, entry.title.length - extension.length)} (${suffix})${extension}`;
    }
    used.add(entry.title);
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
  // A dry run writes nothing. It used to write the completion manifest like any
  // other run, which meant pressing "Dry run" on a card overwrote the durable
  // record of the real finalisation that came before it — the Drive file ids,
  // the pull request number and the verified remote SHA all disappeared from the
  // only artefact that held them.
  if (options.dryRun) return result;
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
  lines.push(`  Build record ${result.gitHandoff.path ?? 'not declared'} (${result.gitHandoff.status} in Git — the canonical record)`);
  lines.push(`  Drive mirror ${result.drive.status}${result.drive.required ? ' (required by this manifest)' : ' (optional)'}`);
  if (result.drive.attempted) {
    lines.push(`  Drive folder ${result.drive.folderUrl ?? 'not created'}`);
    lines.push(`  Deliverables ${result.drive.uploadedCount} of ${result.drive.requiredCount} mirrorable uploaded`);
    for (const entry of result.deliverables) {
      lines.push(`    ${entry.uploadStatus.padEnd(22)} ${entry.title}${entry.driveFileId ? ` — ${entry.driveFileId}` : ''}`);
    }
    if (result.drive.completionRecordUrl) lines.push(`  This report   ${result.drive.completionRecordUrl}`);
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
