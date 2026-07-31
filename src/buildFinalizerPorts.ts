/**
 * The real GitHub and Google Drive adapters.
 *
 * Kept apart from the engine so that every rule in `buildFinalizer.ts` is proved
 * against fakes, and so that the only code holding a credential is the code that
 * has to.
 *
 * CREDENTIALS
 * -----------
 * Nothing here reads a token from a file this project wrote, and nothing here
 * writes one. GitHub comes from `git credential fill`, which on Windows is the
 * Credential Manager entry the operator already signed in to and on macOS and
 * Linux is whichever helper they configured — the same credential `git push`
 * uses, so if push works this works. Google Drive uses a refresh token held in
 * the local runtime directory, outside Git, obtained once through an explicit
 * consent flow the operator starts.
 *
 * A token is held in a local `const` for the duration of one call and never
 * logged, never put in an error message, never written to a manifest and never
 * placed in a URL. The engine additionally redacts everything it records, so a
 * mistake here still has to get past a second gate.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openAsBlob, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DriveConnectionRequiredError, redactSecrets, type DriveFile, type DrivePort, type GitHubPort, type PullRequestRecord } from './buildFinalizer.js';

/* ------------------------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------------------------ */

export class GitHubAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthenticationError';
  }
}

/**
 * Ask git's own credential helper for the token it would use to push.
 *
 * This is the whole reason the operator does not need to install the GitHub CLI
 * or paste a token anywhere: whatever authenticated their last `git push` is
 * what authenticates the pull-request call.
 */
export async function readGitHubToken(host = 'github.com', gitPath = 'git'): Promise<string> {
  // Deliberately NOT `runCommand`: that redacts its output, which is right for
  // everything else in this build and destroys the one value needed here. This
  // capture is read into a local, used for one header, and never returned to any
  // caller that logs.
  //
  // Invoked exactly once. Calling the helper twice can mean two credential
  // prompts on a machine whose helper is interactive.
  const raw = await captureStdout(gitPath, ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
  const password = raw.split('\n').find((line) => line.startsWith('password='))?.slice('password='.length).trim();
  if (!password) {
    throw new GitHubAuthenticationError(
      `git's credential helper supplied no password for ${host}. Sign in once with an ordinary 'git push', or configure a credential helper, then run this again. Nothing was written and no token was read.`,
    );
  }
  return password;
}

/** A raw capture, used only where redaction would destroy the value. Never logged. */
function captureStdout(command: string, args: string[], input: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new GitHubAuthenticationError(`${command} credential fill did not answer within ${timeoutMs} ms.`)); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(new GitHubAuthenticationError(`${command} could not be started: ${error.message}`)); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
    child.stdin?.end(input);
  });
}

export interface GitHubApiOptions {
  apiBase?: string;
  host?: string;
  gitPath?: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so no credential helper is invoked. */
  token?: string;
}

export class GitHubRestPort implements GitHubPort {
  private readonly apiBase: string;
  private readonly host: string;
  private readonly gitPath: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: string | null;

  constructor(options: GitHubApiOptions = {}) {
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.host = options.host ?? 'github.com';
    this.gitPath = options.gitPath ?? 'git';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cachedToken = options.token ?? null;
  }

  private async token(): Promise<string> {
    if (!this.cachedToken) this.cachedToken = await readGitHubToken(this.host, this.gitPath);
    return this.cachedToken;
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ProjectManagAIr-build-finalizer',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
        message = [parsed.message, ...(parsed.errors ?? []).map((entry) => entry.message).filter(Boolean)].filter(Boolean).join(' — ') || text;
      } catch { /* the body was not JSON; the raw text is the best available message */ }
      // The URL is included because it names the resource, and it never carries
      // a credential: the token travels in the Authorization header.
      throw new Error(redactSecrets(`GitHub ${method} ${url} failed with ${response.status}: ${message}`));
    }
    return text ? (JSON.parse(text) as unknown) : null;
  }

  private static toRecord(raw: Record<string, unknown>): PullRequestRecord {
    const head = raw.head as { sha?: string } | undefined;
    return {
      number: Number(raw.number),
      url: String(raw.html_url ?? ''),
      draft: Boolean(raw.draft),
      headSha: head?.sha ? String(head.sha) : null,
      title: String(raw.title ?? ''),
      body: typeof raw.body === 'string' ? raw.body : '',
      state: String(raw.state ?? ''),
    };
  }

  async findPullRequest(input: { repository: string; branch: string; baseBranch: string }): Promise<PullRequestRecord | null> {
    const owner = input.repository.split('/')[0];
    const query = `?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.baseBranch)}`;
    const list = await this.request('GET', `/repos/${input.repository}/pulls${query}`) as Array<Record<string, unknown>>;
    if (!Array.isArray(list) || list.length === 0) return null;
    return GitHubRestPort.toRecord(list[0]);
  }

  async createPullRequest(input: { repository: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }): Promise<PullRequestRecord> {
    const created = await this.request('POST', `/repos/${input.repository}/pulls`, {
      title: input.title,
      head: input.branch,
      base: input.baseBranch,
      body: input.body,
      draft: input.draft,
    }) as Record<string, unknown>;
    return GitHubRestPort.toRecord(created);
  }

  async updatePullRequest(input: { repository: string; number: number; title: string; body: string }): Promise<PullRequestRecord> {
    const updated = await this.request('PATCH', `/repos/${input.repository}/pulls/${input.number}`, {
      title: input.title,
      body: input.body,
    }) as Record<string, unknown>;
    return GitHubRestPort.toRecord(updated);
  }
}

/* ------------------------------------------------------------------------------------ *
 * Google Drive
 * ------------------------------------------------------------------------------------ */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Where the one-time Google authorisation lives.
 *
 * The client configuration is an operator-supplied file matching the repository's
 * existing `config/*.local.json` ignore rule; the refresh token is written to the
 * git-ignored runtime directory. Neither is ever committed, and neither is ever
 * read back into a log or a manifest.
 */
export interface DriveCredentialPaths {
  clientConfig: string;
  tokenStore: string;
}

export function driveCredentialPaths(repoRoot: string): DriveCredentialPaths {
  return {
    clientConfig: path.join(repoRoot, 'config', 'google-drive.local.json'),
    tokenStore: path.join(repoRoot, '.runtime', 'google-drive-token.local.json'),
  };
}

interface DriveClientConfig {
  clientId: string;
  clientSecret: string;
}

interface DriveTokenStore {
  refreshToken: string;
  obtainedAt: string;
}

export function readDriveClientConfig(file: string): DriveClientConfig {
  if (!existsSync(file)) {
    throw new DriveConnectionRequiredError(
      `No Google Drive client configuration at ${file}. Create a Desktop OAuth client in Google Cloud Console and save its id and secret there as {"clientId": "...", "clientSecret": "..."}.`,
    );
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DriveClientConfig> & { installed?: Partial<{ client_id: string; client_secret: string }> };
  // Accept the shape Google Cloud Console downloads verbatim, as well as the
  // short form, so the operator can save the file without editing it.
  const clientId = parsed.clientId ?? parsed.installed?.client_id;
  const clientSecret = parsed.clientSecret ?? parsed.installed?.client_secret;
  if (!clientId || !clientSecret) {
    throw new DriveConnectionRequiredError(`The Google Drive client configuration at ${file} has no client id and secret.`);
  }
  return { clientId, clientSecret };
}

export function readDriveTokenStore(file: string): DriveTokenStore | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DriveTokenStore>;
    return parsed.refreshToken ? { refreshToken: parsed.refreshToken, obtainedAt: parsed.obtainedAt ?? '' } : null;
  } catch {
    return null;
  }
}

export function writeDriveTokenStore(file: string, refreshToken: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ refreshToken, obtainedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

export interface DriveApiOptions {
  paths: DriveCredentialPaths;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  uploadBase?: string;
  tokenEndpoint?: string;
  /** Injected in tests so no network and no credential file are needed. */
  accessToken?: string;
}

export class GoogleDriveRestPort implements DrivePort {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly tokenEndpoint: string;
  private accessToken: string | null;

  constructor(private readonly options: DriveApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://www.googleapis.com/drive/v3').replace(/\/$/, '');
    this.uploadBase = (options.uploadBase ?? 'https://www.googleapis.com/upload/drive/v3').replace(/\/$/, '');
    this.tokenEndpoint = options.tokenEndpoint ?? 'https://oauth2.googleapis.com/token';
    this.accessToken = options.accessToken ?? null;
  }

  async ensureReady(): Promise<void> {
    if (this.accessToken) return;
    const client = readDriveClientConfig(this.options.paths.clientConfig);
    const store = readDriveTokenStore(this.options.paths.tokenStore);
    if (!store) {
      throw new DriveConnectionRequiredError(
        'Google Drive has not been authorised on this machine yet. Use "Connect Google Drive" in the Cockpit, or run the finaliser with --connect-drive once.',
      );
    }
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: store.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!response.ok) {
      // The response body of a token endpoint can echo the request. Nothing from
      // it reaches the message.
      throw new DriveConnectionRequiredError(
        `The stored Google Drive authorisation was refused (HTTP ${response.status}). Re-connect Google Drive in the Cockpit.`,
      );
    }
    const parsed = await response.json() as { access_token?: string };
    if (!parsed.access_token) throw new DriveConnectionRequiredError('The Google token endpoint returned no access token. Re-connect Google Drive in the Cockpit.');
    this.accessToken = parsed.access_token;
  }

  private async request(method: string, url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      method,
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(redactSecrets(`Google Drive ${method} failed with ${response.status}: ${text}`));
    return text ? (JSON.parse(text) as unknown) : null;
  }

  private static toFile(raw: Record<string, unknown>): DriveFile {
    return {
      id: String(raw.id),
      name: String(raw.name ?? ''),
      mimeType: String(raw.mimeType ?? ''),
      webViewLink: raw.webViewLink ? String(raw.webViewLink) : null,
      md5Checksum: raw.md5Checksum ? String(raw.md5Checksum) : null,
    };
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null> {
    // `name = '...'` with the apostrophes escaped, plus an explicit trashed
    // filter: a trashed file of the same name must not be reused, or a rerun
    // would "update" something the operator deleted.
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const mime = folder ? " and mimeType = 'application/vnd.google-apps.folder'" : " and mimeType != 'application/vnd.google-apps.folder'";
    const query = `'${parentId}' in parents and name = '${escaped}'${mime} and trashed = false`;
    const url = `${this.apiBase}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,name,mimeType,webViewLink,md5Checksum)')}&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const parsed = await this.request('GET', url) as { files?: Array<Record<string, unknown>> };
    const first = parsed.files?.[0];
    return first ? GoogleDriveRestPort.toFile(first) : null;
  }

  findChildFolder(parentId: string, name: string): Promise<DriveFile | null> {
    return this.findChild(parentId, name, true);
  }

  findChildFile(parentId: string, name: string): Promise<DriveFile | null> {
    return this.findChild(parentId, name, false);
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const created = await this.request('POST', `${this.apiBase}/files?fields=${encodeURIComponent('id,name,mimeType,webViewLink')}&supportsAllDrives=true`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' }),
    }) as Record<string, unknown>;
    return GoogleDriveRestPort.toFile(created);
  }

  private async upload(input: { parentId: string; name: string; localPath: string; mimeType: string; existingId: string | null; convertTo?: string }): Promise<DriveFile> {
    const metadata: Record<string, unknown> = input.existingId
      ? { name: input.name, ...(input.convertTo ? { mimeType: input.convertTo } : {}) }
      : { name: input.name, parents: [input.parentId], ...(input.convertTo ? { mimeType: input.convertTo } : {}) };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', await openAsBlob(input.localPath, { type: input.mimeType }));
    const fields = encodeURIComponent('id,name,mimeType,webViewLink,md5Checksum');
    const url = input.existingId
      ? `${this.uploadBase}/files/${input.existingId}?uploadType=multipart&fields=${fields}&supportsAllDrives=true`
      : `${this.uploadBase}/files?uploadType=multipart&fields=${fields}&supportsAllDrives=true`;
    const uploaded = await this.request(input.existingId ? 'PATCH' : 'POST', url, { body: form }) as Record<string, unknown>;
    return GoogleDriveRestPort.toFile(uploaded);
  }

  uploadFile(input: { parentId: string; name: string; localPath: string; mimeType: string; existingId: string | null }): Promise<DriveFile> {
    if (!existsSync(input.localPath) || !statSync(input.localPath).isFile()) {
      throw new Error(`${input.localPath} is not a file.`);
    }
    return this.upload(input);
  }

  uploadAsGoogleDoc(input: { parentId: string; name: string; localPath: string; existingId: string | null }): Promise<DriveFile> {
    // Google converts text/plain and text/markdown reliably; anything else is
    // better left as its original type than turned into a bad Doc.
    return this.upload({ ...input, mimeType: 'text/plain', convertTo: 'application/vnd.google-apps.document' });
  }
}

/* ------------------------------------------------------------------------------------ *
 * The one-time Drive consent flow
 * ------------------------------------------------------------------------------------ */

export interface DriveAuthorizationRequest {
  authorizationUrl: string;
  /** The loopback port the flow is listening on. */
  port: number;
  /** Resolves once Google redirects back, or rejects on timeout or denial. */
  completed: Promise<void>;
}

/**
 * Start the installed-application consent flow.
 *
 * A loopback redirect rather than a device code, because it is one click in a
 * browser the operator is already signed in to and it needs no code to be typed.
 * The refresh token is written to the local token store and nothing else is
 * retained.
 */
export async function beginDriveAuthorization(options: {
  paths: DriveCredentialPaths;
  fetchImpl?: typeof fetch;
  tokenEndpoint?: string;
  authorizeEndpoint?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<DriveAuthorizationRequest> {
  const client = readDriveClientConfig(options.paths.clientConfig);
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenEndpoint = options.tokenEndpoint ?? 'https://oauth2.googleapis.com/token';
  const authorizeEndpoint = options.authorizeEndpoint ?? 'https://accounts.google.com/o/oauth2/v2/auth';
  const { createServer } = await import('node:http');

  let resolveCompleted: () => void;
  let rejectCompleted: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });

  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;

  const timer = setTimeout(() => {
    server.close();
    rejectCompleted(new Error('The Google authorisation was not completed within the time allowed.'));
  }, options.timeoutMs ?? 5 * 60_000);

  server.on('request', (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/oauth2/callback') { response.statusCode = 404; response.end('Not found'); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const say = (message: string) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><meta charset="utf-8"><title>Project ManagAIr</title><body style="font-family:system-ui;padding:40px"><h1>Project ManagAIr</h1><p>${message}</p><p>You can close this tab.</p>`);
      };
      try {
        if (error || !code) throw new Error(error ? `Google reported: ${error}` : 'Google returned no authorisation code.');
        const exchanged = await fetchImpl(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
        });
        if (!exchanged.ok) throw new Error(`The Google token exchange failed with HTTP ${exchanged.status}.`);
        const parsed = await exchanged.json() as { refresh_token?: string };
        if (!parsed.refresh_token) {
          throw new Error('Google returned no refresh token. Remove Project ManagAIr from your Google account permissions and connect again so consent is re-issued.');
        }
        writeDriveTokenStore(options.paths.tokenStore, parsed.refresh_token);
        say('Google Drive is connected. Return to the Cockpit and press Retry on the pending handoff.');
        resolveCompleted();
      } catch (caught) {
        say(`Google Drive could not be connected: ${redactSecrets(caught instanceof Error ? caught.message : String(caught))}`);
        rejectCompleted(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        clearTimeout(timer);
        server.close();
      }
    })();
  });

  const authorizationUrl = `${authorizeEndpoint}?${new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  }).toString()}`;

  return { authorizationUrl, port, completed };
}
