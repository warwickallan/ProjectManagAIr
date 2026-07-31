import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { parseCodexJsonl, runCliCommand } from './extractionProvider.js';

export interface AIContextRef {
  contextType: 'current-day-calendar' | 'selected-event' | 'selected-email' | 'selected-project' | 'project-record';
  contextId: string;
  label: string;
  preview?: string;
}

export interface AIProviderStatus {
  id: string;
  label: string;
  available: boolean;
  detail: string;
  executablePath: string | null;
}

export interface ChatRequest {
  sessionId?: string;
  prompt: string;
  contextRefs: AIContextRef[];
}

export interface ChatResult {
  sessionId: string;
  provider: AIProviderStatus;
  response: string;
  contextSent: AIContextRef[];
}

export interface AIProvider {
  isAvailable(): AIProviderStatus;
  startSession(db: DatabaseSync, title: string): string;
  sendMessage(db: DatabaseSync, request: ChatRequest): Promise<ChatResult>;
  cancel(): void;
  resumeSession(sessionId: string): string;
}

/** Wall-clock limit for one interactive chat call; a hung CLI must not hang the Express route. */
export const DEFAULT_CHAT_TIMEOUT_MS = 3 * 60_000;

function where(command: string): string | null {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [command], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return ((result.stdout ?? '') || (result.stderr ?? '')).trim() || null;
}

class ClaudeCodeProvider implements AIProvider {
  private controller: AbortController | null = null;

  isAvailable(): AIProviderStatus {
    const executablePath = where('claude');
    if (!executablePath) return { id: 'claude-code', label: 'Claude Code CLI', available: false, detail: 'claude was not found on PATH.', executablePath: null };
    const version = commandVersion('claude');
    return { id: 'claude-code', label: 'Claude Code CLI', available: Boolean(version), detail: version ?? 'claude exists but --version did not complete.', executablePath };
  }

  startSession(db: DatabaseSync, title: string): string {
    return createSession(db, 'claude-code', title);
  }

  async sendMessage(db: DatabaseSync, request: ChatRequest): Promise<ChatResult> {
    const provider = this.isAvailable();
    if (!provider.available) throw new Error(provider.detail);
    const sessionId = request.sessionId ?? this.startSession(db, 'Project ManagAIr chat');
    const prompt = buildGroundedPrompt(request.prompt, request.contextRefs);
    insertContextRefs(db, sessionId, request.contextRefs);
    insertMessage(db, sessionId, 'user', request.prompt);
    this.controller = new AbortController();
    try {
      const run = await runCliCommand({
        providerId: 'claude-code',
        command: 'claude',
        args: ['-p', prompt],
        signal: this.controller.signal,
        timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
      });
      const response = run.stdout.trim();
      insertMessage(db, sessionId, 'assistant', response);
      return { sessionId, provider, response, contextSent: request.contextRefs };
    } finally {
      this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  resumeSession(sessionId: string): string {
    return sessionId;
  }
}

/**
 * Codex is a first-class chat provider: it runs through the same `runCliCommand`
 * machinery as the extraction provider, so a failure carries its taxonomy kind and both
 * output channels instead of dead-ending the route with an unconditional throw.
 */
class CodexCliProvider implements AIProvider {
  private controller: AbortController | null = null;

  isAvailable(): AIProviderStatus {
    const executablePath = where('codex');
    if (!executablePath) return { id: 'codex-cli', label: 'Codex CLI', available: false, detail: 'codex was not found on PATH.', executablePath: null };
    const version = commandVersion('codex');
    return { id: 'codex-cli', label: 'Codex CLI', available: Boolean(version), detail: version ?? 'codex exists but --version did not complete.', executablePath };
  }

  startSession(db: DatabaseSync, title: string): string {
    return createSession(db, 'codex-cli', title);
  }

  async sendMessage(db: DatabaseSync, request: ChatRequest): Promise<ChatResult> {
    const provider = this.isAvailable();
    if (!provider.available) throw new Error(provider.detail);
    const sessionId = request.sessionId ?? this.startSession(db, 'Project ManagAIr chat');
    const prompt = buildGroundedPrompt(request.prompt, request.contextRefs);
    insertContextRefs(db, sessionId, request.contextRefs);
    insertMessage(db, sessionId, 'user', request.prompt);
    this.controller = new AbortController();
    try {
      const run = await runCliCommand({
        providerId: 'codex-cli',
        command: 'codex',
        args: ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
        input: prompt,
        signal: this.controller.signal,
        timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
      });
      const response = parseCodexJsonl(run.stdout, 'codex-cli').message;
      insertMessage(db, sessionId, 'assistant', response);
      return { sessionId, provider, response, contextSent: request.contextRefs };
    } finally {
      this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  resumeSession(sessionId: string): string {
    return sessionId;
  }
}

const providers: AIProvider[] = [new ClaudeCodeProvider(), new CodexCliProvider()];

export function probeAIProviders(): AIProviderStatus[] {
  return providers.map((provider) => provider.isAvailable());
}

export interface PreferredProviderResolution {
  provider: AIProvider | null;
  /** Why nothing was selected; null when a provider was selected. */
  reason: string | null;
}

/**
 * Select a provider. An explicitly requested provider must still be available — matching
 * on id alone selected a provider that could not run and dead-ended every chat call.
 */
export function resolvePreferredProvider(): PreferredProviderResolution {
  const requested = process.env.PROJECTMANAGAIR_AI_PROVIDER?.trim();
  const statuses = providers.map((provider) => ({ provider, status: provider.isAvailable() }));
  if (requested) {
    const match = statuses.find((entry) => entry.status.id === requested);
    if (!match) {
      return { provider: null, reason: `Requested AI provider "${requested}" is not a known provider (known: ${statuses.map((entry) => entry.status.id).join(', ')}).` };
    }
    if (!match.status.available) {
      return { provider: null, reason: `Requested AI provider "${requested}" is not available: ${match.status.detail}` };
    }
    return { provider: match.provider, reason: null };
  }
  const first = statuses.find((entry) => entry.status.available);
  if (first) return { provider: first.provider, reason: null };
  return {
    provider: null,
    reason: `No supported authenticated local AI provider was discovered. ${statuses.map((entry) => `${entry.status.id}: ${entry.status.detail}`).join(' ')}`,
  };
}

export function preferredProvider(): AIProvider | null {
  return resolvePreferredProvider().provider;
}

export async function sendChatMessage(db: DatabaseSync, request: ChatRequest): Promise<ChatResult> {
  if (request.contextRefs.length === 0) throw new Error('Select at least one context record before sending chat.');
  const { provider, reason } = resolvePreferredProvider();
  if (!provider) throw new Error(reason ?? 'No supported authenticated local AI provider was discovered.');
  // A typed provider failure propagates untouched: it already carries its taxonomy kind
  // and both output channels, which is what the operator needs to see.
  return provider.sendMessage(db, request);
}

function createSession(db: DatabaseSync, providerId: string, title: string): string {
  const id = `chat:${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ai_chat_sessions (id, provider_id, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, providerId, title, now, now, 'active');
  return id;
}

function insertMessage(db: DatabaseSync, sessionId: string, role: string, content: string) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ai_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`chatmsg:${sessionId}:${role}:${now}`, sessionId, role, content, now);
  db.prepare('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
}

function insertContextRefs(db: DatabaseSync, sessionId: string, refs: AIContextRef[]) {
  const now = new Date().toISOString();
  const statement = db.prepare('INSERT INTO ai_context_refs (id, session_id, context_type, context_id, label, selected_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const ref of refs) {
    statement.run(`ctx:${sessionId}:${ref.contextType}:${ref.contextId}:${now}`, sessionId, ref.contextType, ref.contextId, ref.label, now);
  }
}

function buildGroundedPrompt(prompt: string, refs: AIContextRef[]): string {
  const context = refs.map((ref, index) => `${index + 1}. ${ref.contextType} ${ref.contextId}: ${ref.label}${ref.preview ? `\nPreview: ${ref.preview}` : ''}`).join('\n');
  return `You are Project ManagAIr's embedded assistant. Use only the selected context records below. Do not infer from mailbox, calendar, attachments, or project folders that are not listed.\n\nSelected context:\n${context}\n\nUser request:\n${prompt}`;
}

