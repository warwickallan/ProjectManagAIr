import { spawn, spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

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

function where(command: string): string | null {
  const result = spawnSync('where.exe', [command], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim() || null;
}

class ClaudeCodeProvider implements AIProvider {
  private child: ReturnType<typeof spawn> | null = null;

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
    const response = await runCommand('claude', ['-p', prompt]);
    insertMessage(db, sessionId, 'assistant', response);
    return { sessionId, provider, response, contextSent: request.contextRefs };
  }

  cancel(): void {
    this.child?.kill();
    this.child = null;
  }

  resumeSession(sessionId: string): string {
    return sessionId;
  }
}

class CodexCliProvider implements AIProvider {
  isAvailable(): AIProviderStatus {
    const executablePath = where('codex');
    if (!executablePath) return { id: 'codex-cli', label: 'Codex CLI', available: false, detail: 'codex was not found on PATH.', executablePath: null };
    const version = commandVersion('codex');
    return { id: 'codex-cli', label: 'Codex CLI', available: Boolean(version), detail: version ?? 'codex exists but --version did not complete.', executablePath };
  }

  startSession(db: DatabaseSync, title: string): string {
    return createSession(db, 'codex-cli', title);
  }

  async sendMessage(): Promise<ChatResult> {
    const provider = this.isAvailable();
    throw new Error(provider.available ? 'Codex CLI non-interactive local provider is not enabled for this build.' : provider.detail);
  }

  cancel(): void {}

  resumeSession(sessionId: string): string {
    return sessionId;
  }
}

const providers: AIProvider[] = [new ClaudeCodeProvider(), new CodexCliProvider()];

export function probeAIProviders(): AIProviderStatus[] {
  return providers.map((provider) => provider.isAvailable());
}

export function preferredProvider(): AIProvider | null {
  const requested = process.env.PROJECTMANAGAIR_AI_PROVIDER;
  if (requested) return providers.find((provider) => provider.isAvailable().id === requested) ?? null;
  return providers.find((provider) => provider.isAvailable().available) ?? null;
}

export async function sendChatMessage(db: DatabaseSync, request: ChatRequest): Promise<ChatResult> {
  if (request.contextRefs.length === 0) throw new Error('Select at least one context record before sending chat.');
  const provider = preferredProvider();
  if (!provider) throw new Error('No supported authenticated local AI provider was discovered. Install nothing; authenticate an existing Claude Code CLI or configure a provider later.');
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

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}
