import { spawn, spawnSync } from 'node:child_process';
import { estimateTokens } from './extractionProvider.js';

export interface BriefProviderIdentity {
  readonly providerId: string;
  readonly modelLabel: string;
}

export interface GroundedBriefRequest {
  prompt: string;
  selectionHash: string;
}

export interface GroundedBriefResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface GroundedBriefProvider {
  readonly identity: BriefProviderIdentity;
  isAvailable(): boolean;
  generate(request: GroundedBriefRequest, signal?: AbortSignal): Promise<GroundedBriefResult>;
}

export class FakeGroundedBriefProvider implements GroundedBriefProvider {
  readonly identity = Object.freeze({ providerId: 'fake-brief-provider', modelLabel: 'synthetic-brief-v1' });

  constructor(private readonly handler: (request: GroundedBriefRequest) => GroundedBriefResult | Promise<GroundedBriefResult>) {}

  isAvailable(): boolean { return true; }

  generate(request: GroundedBriefRequest): Promise<GroundedBriefResult> {
    return Promise.resolve(this.handler(request));
  }
}

export class ClaudeCodeGroundedBriefProvider implements GroundedBriefProvider {
  readonly identity = Object.freeze({ providerId: 'claude-code', modelLabel: 'claude-code-cli-default' });
  private available: boolean | null = null;

  constructor(private readonly executable = 'claude') {}

  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    const probe = spawnSync(this.executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    this.available = probe.status === 0 && !probe.error;
    return this.available;
  }

  async generate(request: GroundedBriefRequest, signal?: AbortSignal): Promise<GroundedBriefResult> {
    const raw = await runCommand(this.executable, ['-p', request.prompt], signal);
    let markdown = raw.trim();
    try {
      const unfenced = markdown.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(unfenced) as { briefMarkdown?: unknown };
      if (typeof parsed.briefMarkdown === 'string') markdown = parsed.briefMarkdown.trim();
    } catch {
      // Markdown is an allowed provider response; citation validation remains authoritative.
    }
    return { markdown, usage: { inputTokens: estimateTokens(request.prompt), outputTokens: estimateTokens(raw) } };
  }
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
  });
}