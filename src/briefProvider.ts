import {
  DEFAULT_AVAILABILITY_TTL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  classifyProviderFailure,
  estimateTokens,
  isProviderError,
  parseCliVersion,
  runCliCommand,
  type ProviderAvailability,
  type ProviderErrorKind,
  type TokenCountSource,
} from './extractionProvider.js';
import { spawnSync } from 'node:child_process';

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
  usage: {
    inputTokens: number;
    outputTokens: number;
    inputTokenSource?: TokenCountSource;
    outputTokenSource?: TokenCountSource;
  };
}

export interface GroundedBriefProvider {
  readonly identity: BriefProviderIdentity;
  isAvailable(): boolean;
  refresh?(): ProviderAvailability;
  availability?(): ProviderAvailability;
  generate(request: GroundedBriefRequest, signal?: AbortSignal): Promise<GroundedBriefResult>;
}

/**
 * A brief is a single bounded call on an interactive route: it must not take minutes.
 * Extraction timeouts are deliberately an order of magnitude larger.
 */
export const DEFAULT_BRIEF_TIMEOUT_MS = 60_000;

export interface GroundedBriefProviderOptions {
  timeoutMs?: number;
  availabilityTtlMs?: number;
  probeTimeoutMs?: number;
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
  private cached: ProviderAvailability | null = null;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly probeTimeoutMs: number;

  constructor(private readonly executable = 'claude', options: GroundedBriefProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS;
    this.ttlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return this.availability().available;
  }

  availability(): ProviderAvailability {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < this.ttlMs) return this.cached;
    this.cached = this.probe(now);
    return this.cached;
  }

  /** Re-probe now, so installing or authenticating the CLI does not need a restart. */
  refresh(): ProviderAvailability {
    this.cached = this.probe(Date.now());
    return this.cached;
  }

  private probe(now: number): ProviderAvailability {
    const executable = this.executable.trim();
    if (!executable) {
      return { available: false, kind: 'cli-missing', detail: 'No executable is configured for claude-code.', version: null, checkedAt: now };
    }
    const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: this.probeTimeoutMs });
    const stdout = probe.stdout ?? '';
    const stderr = probe.stderr ?? '';
    if (probe.error) {
      const code = (probe.error as NodeJS.ErrnoException).code ?? null;
      const kind: ProviderErrorKind = classifyProviderFailure({ spawnErrorCode: code, stdout, stderr });
      return { available: false, kind, detail: `${executable} --version could not run (${code ?? probe.error.message}).`, version: null, checkedAt: now };
    }
    if (probe.status !== 0) {
      return {
        available: false,
        kind: classifyProviderFailure({ stdout, stderr, exitCode: probe.status }),
        detail: `${executable} --version exited with code ${probe.status}.\nstderr: ${stderr.trim()}\nstdout: ${stdout.trim()}`,
        version: null,
        checkedAt: now,
      };
    }
    return {
      available: true,
      kind: null,
      detail: (stdout || stderr).trim() || `${executable} responded to --version.`,
      version: parseCliVersion(`${stdout} ${stderr}`),
      checkedAt: now,
    };
  }

  /**
   * Exactly one call, no retry: the bounded brief budget is part of the design. A hung CLI
   * is killed at the timeout and surfaces as a typed `transient` failure, which the caller
   * records as a failed run and answers from the deterministic template.
   */
  async generate(request: GroundedBriefRequest, signal?: AbortSignal): Promise<GroundedBriefResult> {
    try {
      const run = await runCliCommand({
        providerId: this.identity.providerId,
        command: this.executable,
        args: ['-p', request.prompt],
        signal,
        timeoutMs: this.timeoutMs,
      });
      const raw = run.stdout.trim();
      let markdown = raw;
      try {
        const unfenced = markdown.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(unfenced) as { briefMarkdown?: unknown };
        if (typeof parsed.briefMarkdown === 'string') markdown = parsed.briefMarkdown.trim();
      } catch {
        // Markdown is an allowed provider response; citation validation remains authoritative.
      }
      return {
        markdown,
        usage: {
          // The Claude Code CLI reports no usage in `-p` mode; both counts are estimates.
          inputTokens: estimateTokens(request.prompt),
          outputTokens: estimateTokens(raw),
          inputTokenSource: 'estimated',
          outputTokenSource: 'estimated',
        },
      };
    } catch (error) {
      if (isProviderError(error) && (error.kind === 'cli-missing' || error.kind === 'cli-too-old' || error.kind === 'auth' || error.kind === 'model-unsupported')) {
        this.cached = { available: false, kind: error.kind, detail: error.message, version: this.cached?.version ?? null, checkedAt: Date.now() };
      }
      throw error;
    }
  }
}
