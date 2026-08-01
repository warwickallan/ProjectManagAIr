/**
 * The headless Consultant Reasoning provider.
 *
 * One bounded call, no retries. If the CLI returns something that will not
 * parse or will not validate, the response is preserved and surfaced — never
 * re-bought. A completed provider response is evidence whether or not we liked
 * it, and spending the same tokens again to get a second opinion on our own
 * prompt is how a token budget disappears without anyone deciding to spend it.
 *
 * Modelled on `briefProvider.ts` (the interactive-family pattern) rather than
 * `extractionProvider.ts` (the batch pattern): a reasoning run is one user
 * action on one project, not a windowed sweep over a source.
 */

import { spawnSync } from 'node:child_process';
import {
  ProviderError, classifyProviderFailure, estimateTokens, isProviderError, runCliCommand,
  type ProviderAvailability,
} from './extractionProvider.js';

export interface ReasoningProviderIdentity {
  readonly providerId: string;
  readonly modelLabel: string;
}

export interface ReasoningProviderRequest {
  prompt: string;
  projectStateHash: string;
  /**
   * Called with the complete response the instant it arrives, BEFORE any parse
   * or validation. Returns the preserved-record id, or null if preservation
   * failed. The provider must not proceed to parsing until this has run.
   */
  preserveRawOutput?: (event: RawReasoningResponse) => string | null;
}

export interface RawReasoningResponse {
  raw: string;
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
}

export interface ReasoningProviderResult {
  raw: string;
  rawOutputId: string | null;
  usage: { inputTokens: number; outputTokens: number; tokenSource: 'provider-reported' | 'estimated' };
  durationMs: number;
}

export interface ConsultantReasoningProvider {
  readonly identity: ReasoningProviderIdentity;
  isAvailable(): boolean;
  refresh?(): ProviderAvailability;
  availability?(): ProviderAvailability;
  generate(request: ReasoningProviderRequest, signal?: AbortSignal): Promise<ReasoningProviderResult>;
}

/** A reasoning pass is one large call; it gets a generous but finite ceiling. */
const DEFAULT_REASONING_TIMEOUT_MS = 10 * 60_000;
const AVAILABILITY_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Test double. Always available, never touches a CLI. */
export class FakeConsultantReasoningProvider implements ConsultantReasoningProvider {
  readonly identity: ReasoningProviderIdentity = { providerId: 'fake-reasoning-provider', modelLabel: 'synthetic-reasoning-v1' };

  constructor(private readonly handler: (request: ReasoningProviderRequest) => string | Promise<string>) {}

  isAvailable(): boolean { return true; }

  async generate(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const requestedAt = new Date().toISOString();
    const started = Date.now();
    const raw = await this.handler(request);
    const durationMs = Date.now() - started;
    // The fake preserves too. A test that never exercises preservation would
    // let a regression through on the path that matters most.
    const rawOutputId = request.preserveRawOutput?.({ raw, requestedAt, receivedAt: new Date().toISOString(), durationMs }) ?? null;
    return {
      raw, rawOutputId, durationMs,
      usage: { inputTokens: estimateTokens(request.prompt), outputTokens: estimateTokens(raw), tokenSource: 'estimated' },
    };
  }
}

export class ClaudeCodeConsultantReasoningProvider implements ConsultantReasoningProvider {
  readonly identity: ReasoningProviderIdentity;
  private cached: ProviderAvailability | null = null;
  private readonly model: string | null;
  private readonly timeoutMs: number;

  constructor(private readonly executable = 'claude', options: { model?: string | null; timeoutMs?: number } = {}) {
    this.model = options.model ?? process.env.PROJECTMANAGAIR_REASONING_MODEL ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REASONING_TIMEOUT_MS;
    this.identity = {
      providerId: 'claude-code',
      modelLabel: this.model ? `claude-code-cli:${this.model}` : 'claude-code-cli-default',
    };
  }

  private probe(): ProviderAvailability {
    const checkedAt = Date.now();
    try {
      const result = spawnSync(this.executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS });
      if (result.error) {
        const kind = classifyProviderFailure({ spawnErrorCode: (result.error as NodeJS.ErrnoException).code ?? null, stderr: '', stdout: '' });
        return { available: false, kind, detail: result.error.message, version: null, checkedAt };
      }
      if (result.status !== 0) {
        return { available: false, kind: 'cli-missing', detail: (result.stderr || result.stdout || '').trim() || `Exit ${result.status}`, version: null, checkedAt };
      }
      return { available: true, kind: null, detail: 'ok', version: (result.stdout ?? '').trim() || null, checkedAt };
    } catch (error) {
      return { available: false, kind: 'unknown', detail: error instanceof Error ? error.message : String(error), version: null, checkedAt };
    }
  }

  availability(): ProviderAvailability {
    if (this.cached && Date.now() - this.cached.checkedAt < AVAILABILITY_TTL_MS) return this.cached;
    this.cached = this.probe();
    return this.cached;
  }

  refresh(): ProviderAvailability {
    this.cached = this.probe();
    return this.cached;
  }

  isAvailable(): boolean { return this.availability().available; }

  async generate(request: ReasoningProviderRequest, signal?: AbortSignal): Promise<ReasoningProviderResult> {
    const requestedAt = new Date().toISOString();
    let preserved = false;
    let rawOutputId: string | null = null;
    try {
      // The prompt goes on stdin, never argv: a full project state is ~200 KB
      // and would exceed the command-line limit on every platform.
      const run = await runCliCommand({
        providerId: this.identity.providerId,
        command: this.executable,
        args: this.model ? ['-p', '--model', this.model] : ['-p'],
        input: request.prompt,
        signal,
        timeoutMs: this.timeoutMs,
      });
      const receivedAt = new Date().toISOString();
      // Preserve FIRST. Nothing below this line may lose the response.
      preserved = true;
      rawOutputId = request.preserveRawOutput?.({ raw: run.stdout, requestedAt, receivedAt, durationMs: run.durationMs }) ?? null;
      return {
        raw: run.stdout,
        rawOutputId,
        durationMs: run.durationMs,
        // The CLI reports no usage in -p mode, so both counts are labelled
        // estimates rather than presented as measured truth.
        usage: { inputTokens: estimateTokens(request.prompt), outputTokens: estimateTokens(run.stdout), tokenSource: 'estimated' },
      };
    } catch (error) {
      // A CLI that printed its answer and then exited non-zero still produced
      // work worth keeping.
      if (!preserved && isProviderError(error) && error.rawStdout && error.rawStdout.trim().length > 0) {
        request.preserveRawOutput?.({ raw: error.rawStdout, requestedAt, receivedAt: new Date().toISOString(), durationMs: 0 });
      }
      if (isProviderError(error)) this.cached = { available: false, kind: error.kind, detail: error.detail || error.message, version: null, checkedAt: Date.now() };
      throw error instanceof ProviderError ? error : new ProviderError({
        kind: 'unknown',
        providerId: this.identity.providerId,
        headline: 'Consultant reasoning provider failed.',
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
