import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { DEFAULT_EXTRACTION_SKILL_ID, loadSeedSkillBody, type ResolvedSkillForRun } from './skillRegistry.js';
import type { SourceIntelligencePacket } from './sourceIntelligence.js';

export const SOURCE_INTELLIGENCE_CATEGORIES = [
  'Decisions',
  'Actions',
  'Risks_Issues',
  'Config_Changes',
  'Open_Questions',
  'Milestones',
  'Entities',
  'Sources',
  'Uncertainty',
] as const;

export type SourceIntelligenceCategory = typeof SOURCE_INTELLIGENCE_CATEGORIES[number];
export type SourcePacketRow = SourceIntelligencePacket['sheets']['Actions']['rows'][number];
export type CoverageStatus = 'reviewed' | 'populated' | 'none-found' | 'uncertain' | 'failed' | 'no-governance-content';

export interface StructuredProviderIdentity {
  readonly providerId: string;
  readonly modelLabel: string;
}

export interface ExtractionSegmentInput {
  seq: number;
  text: string;
  speaker: string | null;
  tStartMs: number | null;
}

/**
 * A pre-detected governance cue the packet validator will grade the extraction against.
 *
 * The payload is deliberately three fields. `marker_type` is the literal suffix of `id`
 * (`…:marker:412:explicit-action`) and `matched_text` is a substring of the segment text the
 * model already has at `seq`, so carrying either would repeat, once per marker and once per
 * call, information already in the prompt. On a 2,159-segment transcript that redundancy
 * measured ~15,800 tokens against a 200,000-token budget. Key names mirror the segment payload
 * (`seq`, not `segmentSeq`). `id` is verbatim because `discharges_markers` is matched byte-for-byte.
 */
export interface ExtractionMarkerInput {
  id: string;
  /** The segment the cue was detected in; a discharging row must anchor within 3 of it. */
  seq: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExtractionWindowInput {
  id: string;
  seq: number;
  startSeq: number;
  endSeq: number;
  tokenEstimate: number;
  segments: ExtractionSegmentInput[];
  /**
   * Markers whose segment falls inside this window. Optional so that callers building a
   * synthetic window need not fabricate one; absent and empty are serialised identically.
   */
  markers?: ExtractionMarkerInput[];
}

export interface ExistingRegisterRowInput {
  registerName: string;
  externalId: string;
  title: string;
  status: string;
  owner: string | null;
  dueDate: string | null;
}

export interface StructuredExtractionRequest {
  source: {
    sourceId: string;
    sourceType: string;
    originalFileName: string;
    contentHash: string;
    eventDate: string | null;
  };
  project: {
    projectId: string;
    projectCode: string;
    baseRegisterRevision: number;
  };
  windows: ExtractionWindowInput[];
  categories: SourceIntelligenceCategory[];
  existingRows: ExistingRegisterRowInput[];
  prompt: string;
  promptSha256: string;
  skillSha256: string;
  callIndex: number;
}

export interface ExtractionCoverage {
  key: string;
  status: CoverageStatus;
  itemCount: number;
  explanation: string | null;
}

export interface StructuredExtractionOutput {
  rows: Array<{ registerName: SourceIntelligenceCategory; row: SourcePacketRow }>;
  windowCoverage: ExtractionCoverage[];
  categoryCoverage: ExtractionCoverage[];
  markerDismissals?: Array<{ markerId: string; reason: string }>;
  /**
   * Rows that failed row-level validation and were dropped rather than repaired.
   * Never silently discarded: recorded against the run and surfaced to the reviewer.
   */
  rejectedRows?: RejectedProviderRow[];
}

/**
 * Where a recorded token count came from. Provider-reported counts are authoritative and
 * always take precedence over the local estimator; `estimated` marks a count the app
 * computed itself so cost evidence never overstates its own confidence.
 */
export type TokenCountSource = 'provider-reported' | 'estimated';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  sourceTokens: number;
  inputTokenSource?: TokenCountSource;
  outputTokenSource?: TokenCountSource;
}

export interface StructuredExtractionResult {
  output: StructuredExtractionOutput;
  usage: ProviderUsage;
}

/**
 * Provider failure taxonomy. Callers use this to decide whether a failure is the
 * operator's to fix (install, upgrade, authenticate, pick another model), the
 * provider's to fix (malformed output), or worth retrying (transient).
 *
 * - `cli-missing`        the executable is absent, not executable, or not on PATH
 * - `cli-too-old`        the CLI ran but is below the required version, or the service
 *                        told us the request needs a newer client
 * - `model-unsupported`  the configured model is unknown/refused by the provider
 * - `auth`               not logged in, expired or rejected credentials
 * - `transient`          timeout, abort, rate limit, network or 5xx — safe to retry
 * - `malformed-output`   the process succeeded but its output is not a valid
 *                        StructuredExtractionOutput (or not JSON at all)
 * - `unknown`            a non-zero exit we could not classify; the raw streams are
 *                        preserved on the error so an operator can read them
 */
export const PROVIDER_ERROR_KINDS = [
  'cli-missing',
  'cli-too-old',
  'model-unsupported',
  'auth',
  'transient',
  'malformed-output',
  'unknown',
] as const;

export type ProviderErrorKind = typeof PROVIDER_ERROR_KINDS[number];

/** Kinds that mean "do not keep calling this provider until something changes". */
const LATCHING_KINDS = new Set<ProviderErrorKind>(['cli-missing', 'cli-too-old', 'model-unsupported', 'auth']);

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  providerId: string;
  headline: string;
  command?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}

const ERROR_STREAM_BUDGET = 4_000;

function truncateStream(value: string, budget = ERROR_STREAM_BUDGET): string {
  const text = value ?? '';
  if (text.length <= budget) return text;
  const headSize = Math.ceil(budget * 0.6);
  const tailSize = budget - headSize;
  const omitted = text.length - headSize - tailSize;
  return `${text.slice(0, headSize)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tailSize)}`;
}

function buildDetail(options: ProviderErrorOptions): string {
  const parts: string[] = [];
  const stderr = (options.stderr ?? '').trim();
  const stdout = (options.stdout ?? '').trim();
  if (stderr) parts.push(`stderr: ${truncateStream(stderr)}`);
  if (stdout) parts.push(`stdout: ${truncateStream(stdout)}`);
  if (!stderr && !stdout) parts.push('stderr: <empty>\nstdout: <empty>');
  return parts.join('\n');
}

/**
 * A provider failure that always carries its classification and both output channels.
 * `--json` CLIs put their diagnostics on stdout, so discarding stdout on a non-zero exit
 * is what turned an HTTP 400 into `codex exited with code 1`.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly detail: string;

  constructor(options: ProviderErrorOptions) {
    const detail = buildDetail(options);
    super(`${options.providerId}: ${options.headline} [${options.kind}]\n${detail}`);
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.command = options.command ?? null;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stdout = truncateStream(options.stdout ?? '');
    this.stderr = truncateStream(options.stderr ?? '');
    this.detail = detail;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  /** Structured form for logging and for display in the quarantine lane. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      providerId: this.providerId,
      command: this.command,
      exitCode: this.exitCode,
      signal: this.signal,
      message: this.message,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export interface ProviderFailureSignals {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnErrorCode?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
}

/**
 * Classify a provider failure from everything we observed. Order matters: the real
 * Codex refusal ("The requested model … requires a newer version of the Codex app/CLI")
 * names both a model and a version, and the actionable fix is the upgrade.
 */
export function classifyProviderFailure(signals: ProviderFailureSignals): ProviderErrorKind {
  if (signals.timedOut || signals.aborted) return 'transient';
  const spawnCode = (signals.spawnErrorCode ?? '').toUpperCase();
  if (spawnCode === 'ENOENT' || spawnCode === 'EACCES' || spawnCode === 'EPERM' || spawnCode === 'ENOEXEC') return 'cli-missing';
  if (spawnCode === 'ETIMEDOUT' || spawnCode === 'EAGAIN' || spawnCode === 'EMFILE' || spawnCode === 'ENFILE') return 'transient';
  const text = `${signals.stderr ?? ''}\n${signals.stdout ?? ''}`.toLowerCase();
  if (!text.trim()) return spawnCode ? 'unknown' : 'unknown';
  if (/command not found|is not recognized as an internal or external command|no such file or directory|executable file not found|cannot find the path|not installed/.test(text)) return 'cli-missing';
  if (/requires a newer|requires at least version|newer version of the|please (?:update|upgrade)|upgrade your|update your |unsupported (?:cli|client) version|client (?:is )?too old|outdated (?:cli|client)/.test(text)) return 'cli-too-old';
  if (/(?:unknown|unsupported|invalid|unrecognized|unavailable)[^\n]{0,40}model|model[^\n]{0,60}(?:not found|not supported|not available|not enabled|does not exist|is invalid|is unknown)|model_not_found|does not have access to model/.test(text)) return 'model-unsupported';
  if (/\b40[13]\b|unauthori[sz]ed|unauthenticated|not logged in|not signed in|please (?:run )?(?:codex |claude )?login|authentication failed|invalid api key|missing api key|no api key|credentials?|token (?:has )?expired|forbidden|sign in to/.test(text)) return 'auth';
  if (/\b(?:408|429|500|502|503|504)\b|rate limit|too many requests|timed out|timeout|temporarily unavailable|service unavailable|econnreset|econnrefused|etimedout|enotfound|epipe|socket hang up|network error|overloaded|try again later|stream (?:disconnected|interrupted)/.test(text)) return 'transient';
  return 'unknown';
}

export interface CliRunOptions {
  providerId: string;
  command: string;
  args: string[];
  /** When present the value is written to stdin and stdin is closed. */
  input?: string | null;
  signal?: AbortSignal;
  /** Hard wall-clock limit. The child is SIGTERMed, then SIGKILLed after the grace period. */
  timeoutMs: number;
  killGraceMs?: number;
  cwd?: string;
  /** Upper bound on retained bytes per stream so a runaway CLI cannot exhaust memory. */
  maxCaptureChars?: number;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_CAPTURE_CHARS = 8_000_000;

/**
 * Run a provider CLI with a hard timeout, full capture of both output channels, and a
 * typed error on every failure path. The promise settles only on `close`, so the child
 * has exited and been reaped before the caller continues; a timed-out child is escalated
 * from SIGTERM to SIGKILL so it cannot leak.
 */
export function runCliCommand(options: CliRunOptions): Promise<CliRunResult> {
  const { providerId, command, args } = options;
  const maxCapture = options.maxCaptureChars ?? DEFAULT_MAX_CAPTURE_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const commandLine = [command, ...args].join(' ');
  const startedAt = Date.now();

  return new Promise<CliRunResult>((resolve, reject) => {
    if (!command.trim()) {
      reject(new ProviderError({ kind: 'cli-missing', providerId, headline: 'No executable is configured.', command: commandLine }));
      return;
    }
    if (options.signal?.aborted) {
      reject(new ProviderError({ kind: 'transient', providerId, headline: 'The call was aborted before the provider started.', command: commandLine }));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: [options.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: options.cwd,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? null;
      reject(new ProviderError({
        kind: classifyProviderFailure({ spawnErrorCode: code }),
        providerId,
        headline: `${command} could not be started (${code ?? 'spawn failure'}).`,
        command: commandLine,
        cause: error,
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    function terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      killTimer.unref?.();
    }

    function cleanup() {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      options.signal?.removeEventListener('abort', onAbort);
    }

    function capture(current: string, truncated: boolean, chunk: unknown): [string, boolean] {
      if (truncated) return [current, true];
      const next = current + String(chunk);
      if (next.length <= maxCapture) return [next, false];
      return [`${next.slice(0, maxCapture)}\n… [output truncated at ${maxCapture} characters] …`, true];
    }

    child.stdout?.on('data', (chunk) => { [stdout, stdoutTruncated] = capture(stdout, stdoutTruncated, chunk); });
    child.stderr?.on('data', (chunk) => { [stderr, stderrTruncated] = capture(stderr, stderrTruncated, chunk); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = (error as NodeJS.ErrnoException).code ?? null;
      reject(new ProviderError({
        kind: classifyProviderFailure({ spawnErrorCode: code, stdout, stderr, timedOut, aborted }),
        providerId,
        headline: `${command} failed to run (${code ?? error.message}).`,
        command: commandLine,
        stdout,
        stderr,
        cause: error,
      }));
    });

    // `close` fires after the process exited and its stdio closed: the child is reaped here.
    child.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new ProviderError({
          kind: 'transient',
          providerId,
          headline: `${command} timed out after ${options.timeoutMs} ms and was terminated.`,
          command: commandLine,
          exitCode: code,
          signal: signalName,
          stdout,
          stderr,
        }));
        return;
      }
      if (aborted) {
        reject(new ProviderError({
          kind: 'transient',
          providerId,
          headline: `${command} was aborted by the caller.`,
          command: commandLine,
          exitCode: code,
          signal: signalName,
          stdout,
          stderr,
        }));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0, durationMs: Date.now() - startedAt });
        return;
      }
      reject(new ProviderError({
        kind: classifyProviderFailure({ stdout, stderr, exitCode: code }),
        providerId,
        headline: signalName
          ? `${command} was terminated by ${signalName}.`
          : `${command} exited with code ${code}.`,
        command: commandLine,
        exitCode: code,
        signal: signalName,
        stdout,
        stderr,
      }));
    });

    if (options.input != null) {
      child.stdin?.on('error', () => { /* the child may exit before reading stdin */ });
      child.stdin?.end(options.input);
    }
  });
}

export interface ProviderAvailability {
  available: boolean;
  /** Why it is unavailable; null when available. */
  kind: ProviderErrorKind | null;
  detail: string;
  version: string | null;
  checkedAt: number;
}

export interface CliProviderOptions {
  /** Hard wall-clock limit for one provider call. */
  timeoutMs?: number;
  /** How long an availability probe result is trusted before it is re-taken. */
  availabilityTtlMs?: number;
  probeTimeoutMs?: number;
  /** Minimum CLI version; a lower reported version classifies as `cli-too-old`. */
  minimumVersion?: string | null;
}

export const DEFAULT_AVAILABILITY_TTL_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** Extraction legitimately takes minutes; a hung CLI must still not hang the route forever. */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 10 * 60_000;

export function parseCliVersion(value: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value ?? '');
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}`;
}

export function compareCliVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

interface AvailabilityTrackerOptions {
  providerId: string;
  executable: string;
  versionArgs: string[];
  probeTimeoutMs: number;
  ttlMs: number;
  minimumVersion: string | null;
  /** null when the provider has no configurable model. */
  model: string | null;
}

/**
 * Availability with a TTL and an explicit `refresh()`, so installing or authenticating a
 * CLI takes effect without restarting the process. A call that fails with an operator-fixable
 * kind latches that reason, which is how the configured model gets validated at all: no
 * `--version` probe can tell you the service will refuse your model.
 */
class CliAvailabilityTracker {
  private cached: ProviderAvailability | null = null;

  constructor(private readonly options: AvailabilityTrackerOptions) {}

  status(): ProviderAvailability {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < this.options.ttlMs) return this.cached;
    this.cached = this.probe(now);
    return this.cached;
  }

  refresh(): ProviderAvailability {
    this.cached = this.probe(Date.now());
    return this.cached;
  }

  noteFailure(error: ProviderError): void {
    if (!LATCHING_KINDS.has(error.kind)) return;
    this.cached = {
      available: false,
      kind: error.kind,
      detail: error.message,
      version: this.cached?.version ?? null,
      checkedAt: Date.now(),
    };
  }

  private probe(now: number): ProviderAvailability {
    const { providerId, executable, versionArgs, minimumVersion, model } = this.options;
    if (!executable.trim()) {
      return { available: false, kind: 'cli-missing', detail: `No executable is configured for ${providerId}.`, version: null, checkedAt: now };
    }
    if (model !== null && !model.trim()) {
      return { available: false, kind: 'model-unsupported', detail: `No model is configured for ${providerId}.`, version: null, checkedAt: now };
    }
    const probe = spawnSync(executable, versionArgs, { encoding: 'utf8', windowsHide: true, timeout: this.options.probeTimeoutMs });
    const stdout = probe.stdout ?? '';
    const stderr = probe.stderr ?? '';
    if (probe.error) {
      const code = (probe.error as NodeJS.ErrnoException).code ?? null;
      return {
        available: false,
        kind: classifyProviderFailure({ spawnErrorCode: code, stdout, stderr }),
        detail: `${executable} ${versionArgs.join(' ')} could not run (${code ?? probe.error.message}).`,
        version: null,
        checkedAt: now,
      };
    }
    if (probe.status !== 0) {
      return {
        available: false,
        kind: classifyProviderFailure({ stdout, stderr, exitCode: probe.status }),
        detail: `${executable} ${versionArgs.join(' ')} exited with code ${probe.status}.\n${buildDetail({ kind: 'unknown', providerId, headline: '', stdout, stderr })}`,
        version: null,
        checkedAt: now,
      };
    }
    const version = parseCliVersion(`${stdout} ${stderr}`);
    if (minimumVersion && version && compareCliVersions(version, minimumVersion) < 0) {
      return {
        available: false,
        kind: 'cli-too-old',
        detail: `${executable} reports version ${version}; ${minimumVersion} or newer is required.`,
        version,
        checkedAt: now,
      };
    }
    return {
      available: true,
      kind: null,
      detail: (stdout || stderr).trim() || `${executable} responded to ${versionArgs.join(' ')}.`,
      version,
      checkedAt: now,
    };
  }
}

export interface StructuredExtractionProvider {
  readonly identity: StructuredProviderIdentity;
  isAvailable(): boolean;
  /** Re-probe now; a newly installed or authenticated CLI must not need a restart. */
  refresh?(): ProviderAvailability;
  availability?(): ProviderAvailability;
  extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult>;
}

/**
 * The extraction contract, stated as instructions — the shipped seed revision.
 *
 * The text itself now lives in `skills/source-extraction/<version>.md` as a versioned data
 * asset, not in this file: see `src/skillRegistry.ts`. This constant is the default a caller
 * gets when it names no revision, and it is exactly the body of the seed revision, so the
 * built-in path and the registry path cannot drift apart.
 *
 * The text is hashed into `extraction_runs.skill_sha256`, so it is the recorded provenance of
 * every pass: it must say exactly what `validatePacket` enforces and nothing it does not.
 * A revision can change what we ask for; it can never change what we accept.
 */
export const SOURCE_EXTRACTION_SKILL: string = loadSeedSkillBody(DEFAULT_EXTRACTION_SKILL_ID);

/**
 * Environment variable naming a file whose contents replace the built-in skill.
 *
 * The organisation's own extraction skill is customer-adjacent and deliberately not committed,
 * so it is injected by path at run time. The file is read here and hashed here, and its contents
 * are never logged, echoed into an error message, or written to the run row — only its hash,
 * length and origin are recorded.
 */
export const EXTRACTION_SKILL_PATH_ENV = 'PROJECTMANAGAIR_EXTRACTION_SKILL_PATH';

export interface ResolvedExtractionSkill {
  /** The skill text that will actually be sent to the provider. */
  text: string;
  /** sha256 of `text` — this is what belongs in extraction_runs.skill_sha256. */
  sha256: string;
  origin: 'built-in' | 'external-file';
  /** Absolute or configured path when `origin` is `external-file`, otherwise null. */
  path: string | null;
  characters: number;
}

/**
 * Resolve the extraction skill actually in force. The recorded hash is always the hash of the
 * text used, never of the built-in constant, so a run's provenance cannot claim a contract the
 * model was not given. A configured but unreadable or empty file is a hard error rather than a
 * silent fallback: falling back would record one skill and honestly hash another.
 */
export function resolveExtractionSkill(env: NodeJS.ProcessEnv = process.env): ResolvedExtractionSkill {
  const configured = (env[EXTRACTION_SKILL_PATH_ENV] ?? '').trim();
  if (!configured) {
    return {
      text: SOURCE_EXTRACTION_SKILL,
      sha256: sha256(SOURCE_EXTRACTION_SKILL),
      origin: 'built-in',
      path: null,
      characters: SOURCE_EXTRACTION_SKILL.length,
    };
  }
  let text: string;
  try {
    text = readFileSync(configured, 'utf8');
  } catch (error) {
    // The message names the path and the errno only. The file may not exist, but if it does
    // its contents must not leak through a thrown error.
    const code = (error as NodeJS.ErrnoException).code ?? 'read failure';
    throw new Error(`${EXTRACTION_SKILL_PATH_ENV} points at ${configured}, which could not be read (${code}).`);
  }
  if (!text.trim()) {
    throw new Error(`${EXTRACTION_SKILL_PATH_ENV} points at ${configured}, which is empty; extraction has no contract to hash.`);
  }
  return { text, sha256: sha256(text), origin: 'external-file', path: configured, characters: text.length };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Conservative token estimate for the mixed prose + JSON scaffolding these prompts carry.
 *
 * The previous `words * 1.35` was a transcript-prose ratio applied to punctuation-dense
 * JSON, and it undercut real usage by 1.5–4x. Since this number is recorded as the actual
 * input count and gates the ≤200,000-token budget, it must over-estimate, never under.
 *
 * The estimate is the maximum of three independent lower bounds:
 *  - a character model whose chars-per-token shrinks from 4.0 (prose) to 2.6 (dense JSON)
 *    as punctuation density rises, since punctuation rarely merges into multi-char tokens;
 *  - a word model that charges 1.5 tokens per whitespace word plus 0.75 per punctuation mark;
 *  - an absolute chars/4 floor, the standard rule of thumb, which the result never drops below.
 */
export function estimateTokens(value: string): number {
  const text = value ?? '';
  if (!text.trim()) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  let punctuation = 0;
  const punctuationMatcher = /[^\p{L}\p{N}\s]/gu;
  while (punctuationMatcher.exec(text) !== null) punctuation += 1;
  const density = punctuation / chars;
  const charsPerToken = 4 - 1.4 * Math.min(1, density / 0.2);
  const charBased = chars / charsPerToken;
  const wordBased = words * 1.5 + punctuation * 0.75;
  const floor = chars / 4;
  return Math.ceil(Math.max(charBased, wordBased, floor));
}

/** The floor the estimator is never allowed to fall below; exported for calibration tests. */
export function charFloorTokens(value: string): number {
  return Math.ceil((value ?? '').length / 4);
}

// Key ordering must be host independent: the prompt is hashed into `prompt_sha256`, and
// `localeCompare` uses the host ICU collation, so two machines with different LANG produced
// different prompt hashes for byte-identical requests. Compare by UTF-16 code unit instead,
// matching the packet serialiser in sourceIntelligence.ts.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The version of the prompt *assembly*, as distinct from the version of the skill text.
 *
 * It names the shape of the assembled prompt — which blocks appear, in what order, with what
 * scaffolding — and must be bumped whenever that shape changes, because the shape is as much
 * a determinant of what a model returns as the instructions are. It is recorded on every run
 * (`extraction_runs.prompt_template_version`), so a change in extraction behaviour can be
 * attributed to the template or to the skill rather than guessed at.
 *
 * A skill revision declares which template it was written against, in its front matter.
 */
export const PROMPT_TEMPLATE_VERSIONS = ['source-extraction-prompt-v2'] as const;
export type PromptTemplateVersion = typeof PROMPT_TEMPLATE_VERSIONS[number];
export const CURRENT_PROMPT_TEMPLATE_VERSION: PromptTemplateVersion = 'source-extraction-prompt-v2';

export type StructuredExtractionPromptInput = Omit<StructuredExtractionRequest, 'prompt' | 'promptSha256' | 'skillSha256'>;

/**
 * Assemble the prompt for one call.
 *
 * Deterministic and host independent by construction: code-unit key ordering (never
 * `localeCompare`), no clock, no locale, no environment read. The same skill text and the
 * same input assemble a byte-identical prompt on any host, which is what makes
 * `prompt_sha256` an honest provenance record rather than a machine fingerprint.
 */
export function buildStructuredExtractionPrompt(
  input: StructuredExtractionPromptInput,
  skill: string = SOURCE_EXTRACTION_SKILL,
  promptTemplateVersion: string = CURRENT_PROMPT_TEMPLATE_VERSION,
): string {
  if (!(PROMPT_TEMPLATE_VERSIONS as readonly string[]).includes(promptTemplateVersion)) {
    // A skill revision naming a template this build does not implement must fail loudly:
    // silently assembling the current shape would record a template version we did not use.
    throw new Error(`Unknown prompt template version "${promptTemplateVersion}"; this build implements ${PROMPT_TEMPLATE_VERSIONS.join(', ')}.`);
  }
  // A window with no markers omits the key entirely rather than serialising `[]` or, worse,
  // the literal `undefined` that `stable` would emit for an explicitly-undefined property.
  const windows = input.windows.map((window) => {
    if (window.markers && window.markers.length > 0) return window;
    const { markers: _omitted, ...rest } = window;
    return rest;
  });
  const request = {
    contract: {
      rows: {
        registerName: SOURCE_INTELLIGENCE_CATEGORIES,
        row: {
          client_ref: 'unique within packet',
          op: ['add', 'update', 'resolve', 'supersede', 'reaffirm'],
          target_id: 'required except add',
          proposed_id: '$ALLOC for add, null otherwise',
          title: 'non-empty',
          summary: 'string',
          status: 'source wording normalized conservatively, or null when unstated',
          record_type: 'string or null',
          owner: 'string or null',
          due_date_raw: 'source wording or null',
          source_ref: 'source id',
          related_refs: [],
          supersedes: [],
          anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: 'verbatim for facts' }],
          derivation: ['fact', 'inference'],
          reasoning: 'required for inference',
          confidence: ['high', 'medium', 'low', 'unknown'],
          discharges_markers: ['marker id from windows[].markers, anchored within 3 segments'],
          details: {},
        },
      },
      coverage: {
        windows: 'one entry per requested window seq',
        categories: 'one entry per requested category',
        statuses: ['reviewed', 'populated', 'none-found', 'uncertain', 'no-governance-content'],
      },
      markers: {
        shape: { id: 'echo verbatim in discharges_markers', seq: 'segment the cue was detected in', confidence: ['high', 'medium'] },
        high: 'must be discharged by a row anchored within 3 segments, or listed in markerDismissals',
      },
    },
    task: { ...input, windows },
  };
  return `${skill}\nReturn one JSON object only with keys rows, windowCoverage, categoryCoverage and optional markerDismissals.\n${stable(request)}`;
}

/** Everything one call needs, plus the complete provenance of how it was assembled. */
export interface AssembledExtractionPrompt {
  prompt: string;
  promptSha256: string;
  skillSha256: string;
  skillId: string;
  skillVersion: string;
  promptTemplateVersion: string;
  packetContractVersion: number;
}

/**
 * Assemble the prompt for a resolved registry revision and return the whole provenance record
 * with it, so a caller cannot record one revision while sending another. The skill body is used
 * here and discarded; only hashes and versions leave this function.
 */
export function assembleExtractionPrompt(
  input: StructuredExtractionPromptInput,
  skill: Pick<ResolvedSkillForRun, 'text' | 'sha256' | 'skillId' | 'version' | 'promptTemplateVersion' | 'packetContractVersion'>,
): AssembledExtractionPrompt {
  const prompt = buildStructuredExtractionPrompt(input, skill.text, skill.promptTemplateVersion);
  return {
    prompt,
    promptSha256: sha256(prompt),
    skillSha256: skill.sha256,
    skillId: skill.skillId,
    skillVersion: skill.version,
    promptTemplateVersion: skill.promptTemplateVersion,
    packetContractVersion: skill.packetContractVersion,
  };
}

function normalizeUsage(usage: ProviderUsage): ProviderUsage {
  const number = (value: number) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const normalized: ProviderUsage = {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    sourceTokens: number(usage.sourceTokens),
  };
  if (usage.inputTokenSource) normalized.inputTokenSource = usage.inputTokenSource;
  if (usage.outputTokenSource) normalized.outputTokenSource = usage.outputTokenSource;
  return normalized;
}

/* ------------------------------------------------------------------------------------ *
 * Runtime validation of provider output.
 *
 * This mirrors the packet row contract in sourceIntelligence.ts exactly, so anything that
 * passes here also passes packet validation. A CLI returning `{"rows": null}` used to be
 * cast straight to StructuredExtractionOutput, recorded as a completed run, and then blow
 * up as a TypeError deep in the pipeline where nothing catches it.
 * ------------------------------------------------------------------------------------ */

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const ALLOWED_DETAIL_KEYS = new Set([
  'rationale', 'options_summary', 'outcome', 'decision_needed_by',
  'driver', 'evidence', 'impact', 'mitigation', 'likelihood', 'severity',
  'environment', 'change_type', 'follow_through',
  'question', 'parked_with', 'unblocked_by', 'blocking',
  'target_date', 'milestone_status', 'conditional_logic',
  'entity_type', 'aliases', 'alias_confidence', 'disambiguation_note', 'hypothetical',
  'source_type', 'why_uncertain', 'resolve_by', 'resolution_route',
]);

const providerDetailsSchema = z.record(z.string(), z.union([scalarSchema, z.array(scalarSchema)])).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) context.addIssue({ code: 'custom', path: [key], message: `Unknown typed detail field: ${key}` });
  }
});

const providerAnchorSchema = z.object({
  segment_seq: z.number().int().positive(),
  speaker: z.string().min(1).nullable().default(null),
  t_ms: z.number().int().nonnegative().nullable().default(null),
  quote: z.string().min(1).nullable().default(null),
}).strict();

const providerRowSchema = z.object({
  client_ref: z.string().min(1),
  op: z.enum(['add', 'update', 'resolve', 'supersede', 'reaffirm']),
  target_id: z.string().min(1).nullable(),
  // Mirrors packetRowSchema: null for every operation except `add`.
  proposed_id: z.string().min(1).nullable().default(null),
  title: z.string().min(1),
  summary: z.string().default(''),
  // Mirrors packetRowSchema in sourceIntelligence.ts: a source that states no
  // status says so with null rather than being forced to invent one.
  status: z.string().min(1).nullable().default(null),
  record_type: z.string().nullable().default(null),
  owner: z.string().nullable().default(null),
  due_date_raw: z.string().nullable().default(null),
  source_ref: z.string().min(1),
  related_refs: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
  anchors: z.array(providerAnchorSchema).min(1),
  derivation: z.enum(['fact', 'inference']),
  reasoning: z.string().min(1).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  discharges_markers: z.array(z.string()).default([]),
  details: providerDetailsSchema.default({}),
}).strict();

const providerCoverageSchema = z.object({
  key: z.string().min(1),
  status: z.enum(['reviewed', 'populated', 'none-found', 'uncertain', 'failed', 'no-governance-content']),
  itemCount: z.number().int().nonnegative(),
  explanation: z.string().min(1).nullable(),
}).strict();

/**
 * Accept both the nested `{registerName, row:{...}}` shape and the flat
 * `{registerName, ...rowFields}` shape.
 *
 * Strictness has to live where it protects the register — on the *content* of a
 * row — not on an incidental nesting convention. A model that puts the register
 * name alongside the fields rather than beside a sub-object has not made an
 * error of substance, and rejecting the whole extraction for it costs a full
 * multi-call pass. Once normalised, the row faces exactly the same strict schema.
 */
const providerRowEnvelopeSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entry = value as Record<string, unknown>;
  if ('row' in entry) return entry;
  const { registerName, register_name: registerNameSnake, ...rest } = entry;
  const name = registerName ?? registerNameSnake;
  if (name === undefined) return entry;
  return { registerName: name, row: rest };
}, z.object({
  registerName: z.enum(SOURCE_INTELLIGENCE_CATEGORIES),
  row: providerRowSchema,
}).strict());

export interface RejectedProviderRow {
  index: number;
  registerName: string | null;
  reason: string;
}

export const structuredExtractionOutputSchema = z.object({
  rows: z.array(providerRowEnvelopeSchema),
  windowCoverage: z.array(providerCoverageSchema),
  categoryCoverage: z.array(providerCoverageSchema),
  markerDismissals: z.array(z.object({ markerId: z.string().min(1), reason: z.string().min(1) }).strict()).optional(),
}).strict();

export interface OutputParseContext {
  providerId: string;
  stdout?: string;
  stderr?: string;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

/** Validate an already-parsed provider payload. Throws a typed `malformed-output` error, never returns a half-valid object. */
/**
 * Write the provider's complete raw output beside the run when it fails to
 * validate.
 *
 * A rejected extraction otherwise costs a full multi-call pass to diagnose,
 * because the error carries only a truncated excerpt. Best effort and silent on
 * failure: diagnostics must never mask the original error. Never logged, only
 * written to the local artefacts directory, because the content is source-derived.
 */
function captureRawOutput(context: OutputParseContext, raw: string): void {
  // Capture is on by default. A merge or gate failure after several successful
  // calls otherwise discards every one of them irrecoverably — which is exactly
  // what destroyed a twenty-five-minute acceptance run, because the payload
  // lives only in memory and `extraction_runs` stores nothing but its hash.
  const directory = process.env.PROJECTMANAGAIR_PROVIDER_OUTPUT_DIR ?? DEFAULT_PROVIDER_OUTPUT_DIR;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true });
    const name = `${context.providerId}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}.txt`;
    writeFileSync(pathJoin(directory, name), raw, 'utf8');
  } catch {
    /* diagnostics are best effort */
  }
}

/**
 * The share of rows that may fail row-level validation before the whole pass is
 * treated as malformed.
 */
export const MAX_REJECTED_ROW_RATIO = 0.1;

/** Where raw provider responses are kept when no explicit directory is configured. */
export const DEFAULT_PROVIDER_OUTPUT_DIR = pathJoin(process.cwd(), 'artifacts', 'provider-output');

/**
 * Validate rows individually so one malformed row does not discard a whole
 * multi-call extraction.
 *
 * The contract stays strict: an unknown key still rejects the row it appears on,
 * and the row is *dropped*, never silently repaired — silent repair is precisely
 * the failure that sank the previous attempt, where a permissive parser stripped
 * a field the system then claimed was present. The difference is accounting:
 * every rejected row is recorded with its reason, returned to the caller,
 * persisted against the run and surfaced to the reviewer, and if more than
 * MAX_REJECTED_ROW_RATIO of rows fail the entire pass is still rejected.
 */
export function parseStructuredExtractionOutput(value: unknown, context: OutputParseContext): StructuredExtractionOutput {
  const result = structuredExtractionOutputSchema.safeParse(value);
  if (result.success) return result.data as unknown as StructuredExtractionOutput;

  // Everything except `rows` must be perfect: coverage is a gate input, not content.
  const envelope = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const candidateRows = envelope && Array.isArray(envelope.rows) ? envelope.rows : null;
  if (candidateRows && candidateRows.length > 0) {
    const kept: unknown[] = [];
    const rejected: RejectedProviderRow[] = [];
    for (const [index, row] of candidateRows.entries()) {
      const parsedRow = providerRowEnvelopeSchema.safeParse(row);
      if (parsedRow.success) kept.push(parsedRow.data);
      else rejected.push({ index, registerName: rowRegisterHint(row), reason: formatIssues(parsedRow.error) });
    }
    const ratio = rejected.length / candidateRows.length;
    if (rejected.length > 0 && ratio <= MAX_REJECTED_ROW_RATIO) {
      const retry = structuredExtractionOutputSchema.safeParse({ ...envelope, rows: [] });
      if (retry.success) {
        captureRawOutput(context, typeof value === 'string' ? value : JSON.stringify(value));
        return { ...(retry.data as unknown as StructuredExtractionOutput), rows: kept as StructuredExtractionOutput['rows'], rejectedRows: rejected };
      }
    }
  }

  captureRawOutput(context, typeof value === 'string' ? value : JSON.stringify(value));
  throw new ProviderError({
    kind: 'malformed-output',
    providerId: context.providerId,
    headline: `Provider output failed StructuredExtractionOutput validation: ${formatIssues(result.error)}`,
    stdout: context.stdout ?? (typeof value === 'string' ? value : JSON.stringify(value)),
    stderr: context.stderr ?? '',
  });
}

function rowRegisterHint(row: unknown): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const entry = row as Record<string, unknown>;
  const name = entry.registerName ?? entry.register_name;
  return typeof name === 'string' ? name : null;
}

/** Strip an optional code fence, parse JSON, then validate. Every failure is `malformed-output`. */
export function parseStructuredExtractionOutputText(raw: string, context: OutputParseContext): StructuredExtractionOutput {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new ProviderError({
      kind: 'malformed-output',
      providerId: context.providerId,
      headline: 'Provider returned no output.',
      stdout: context.stdout ?? '',
      stderr: context.stderr ?? '',
    });
  }
  let json: unknown;
  try {
    json = parseJsonOutput(trimmed);
  } catch (error) {
    captureRawOutput(context, trimmed);
    throw new ProviderError({
      kind: 'malformed-output',
      providerId: context.providerId,
      headline: `Provider output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      stdout: context.stdout ?? trimmed,
      stderr: context.stderr ?? '',
      cause: error,
    });
  }
  return parseStructuredExtractionOutput(json, { ...context, stdout: context.stdout ?? trimmed });
}

export class FakeStructuredExtractionProvider implements StructuredExtractionProvider {
  readonly identity = Object.freeze({ providerId: 'fake-structured-provider', modelLabel: 'synthetic-test-output-v1' });

  constructor(private readonly handler: (request: StructuredExtractionRequest) => StructuredExtractionResult | Promise<StructuredExtractionResult>) {}

  isAvailable(): boolean {
    return true;
  }

  async extract(request: StructuredExtractionRequest): Promise<StructuredExtractionResult> {
    const result = await this.handler(request);
    return { output: result.output, usage: normalizeUsage(result.usage) };
  }
}

export class FrozenPacketExtractionProvider implements StructuredExtractionProvider {
  readonly identity = Object.freeze({ providerId: 'frozen-packet-provider', modelLabel: 'frozen-synthetic-packet-v1' });

  constructor(private readonly packet: SourceIntelligencePacket) {}

  isAvailable(): boolean {
    return true;
  }

  async extract(request: StructuredExtractionRequest): Promise<StructuredExtractionResult> {
    const requestedCategories = new Set(request.categories);
    const requestedWindows = new Set(request.windows.map((window) => String(window.seq)));
    const ranges = request.windows.map((window) => ({ start: window.startSeq, end: window.endSeq }));
    const rows: StructuredExtractionOutput['rows'] = [];
    for (const registerName of SOURCE_INTELLIGENCE_CATEGORIES) {
      if (!requestedCategories.has(registerName)) continue;
      for (const row of this.packet.sheets[registerName].rows) {
        const firstAnchor = row.anchors[0];
        if (firstAnchor && ranges.some((range) => firstAnchor.segment_seq >= range.start && firstAnchor.segment_seq <= range.end)) {
          rows.push({ registerName, row });
        }
      }
    }
    const windowCoverage = this.packet.coverage.windows
      .filter((entry) => requestedWindows.has(entry.key))
      .map((entry) => ({ key: entry.key, status: entry.status, itemCount: entry.item_count, explanation: entry.explanation }));
    const categoryCoverage = this.packet.coverage.categories
      .filter((entry) => requestedCategories.has(entry.key as SourceIntelligenceCategory))
      .map((entry) => ({ key: entry.key, status: entry.status, itemCount: entry.item_count, explanation: entry.explanation }));
    const output = { rows, windowCoverage, categoryCoverage };
    return {
      output,
      usage: {
        inputTokens: estimateTokens(request.prompt),
        outputTokens: estimateTokens(stable(output)),
        sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
        inputTokenSource: 'estimated',
        outputTokenSource: 'estimated',
      },
    };
  }
}

export class ClaudeCodeStructuredExtractionProvider implements StructuredExtractionProvider {
  readonly identity: Readonly<{ providerId: string; modelLabel: string }>;
  private readonly tracker: CliAvailabilityTracker;
  private readonly timeoutMs: number;
  private readonly model: string | null;

  constructor(private readonly executable = 'claude', options: CliProviderOptions & { model?: string | null } = {}) {
    // The model is part of the recorded provenance of a pass, so it is named
    // explicitly rather than inherited from whatever the CLI happens to default
    // to. `PROJECTMANAGAIR_EXTRACTION_MODEL` lets an operator pin it without a
    // code change.
    this.model = options.model ?? process.env.PROJECTMANAGAIR_EXTRACTION_MODEL ?? null;
    this.identity = Object.freeze({ providerId: 'claude-code', modelLabel: this.model ? `claude-code-cli:${this.model}` : 'claude-code-cli-default' });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
    this.tracker = new CliAvailabilityTracker({
      providerId: 'claude-code',
      executable,
      versionArgs: ['--version'],
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ttlMs: options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS,
      minimumVersion: options.minimumVersion ?? null,
      model: null,
    });
  }

  isAvailable(): boolean {
    return this.tracker.status().available;
  }

  availability(): ProviderAvailability {
    return this.tracker.status();
  }

  refresh(): ProviderAvailability {
    return this.tracker.refresh();
  }

  async extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult> {
    try {
      const run = await runCliCommand({
        providerId: this.identity.providerId,
        command: this.executable,
        // The prompt goes on stdin, never argv: a real extraction prompt is
        // ~140 KB and passing it as an argument fails with E2BIG before the
        // model is ever reached.
        args: this.model ? ['-p', '--model', this.model] : ['-p'],
        input: request.prompt,
        signal,
        timeoutMs: this.timeoutMs,
      });
      // Persist the raw response for every call, not only failing ones. A
      // downstream merge or gate failure otherwise discards a multi-call
      // extraction with no way to recover the model's work, which is exactly how
      // twenty-five minutes of output was lost during acceptance.
      captureRawOutput({ providerId: this.identity.providerId }, run.stdout);
      const output = parseStructuredExtractionOutputText(run.stdout, {
        providerId: this.identity.providerId,
        stdout: run.stdout,
        stderr: run.stderr,
      });
      return {
        output,
        usage: {
          // The Claude Code CLI in `-p` mode reports no usage, so both counts are estimates
          // and are labelled as such rather than presented as measured actuals.
          inputTokens: estimateTokens(request.prompt),
          outputTokens: estimateTokens(run.stdout),
          sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
          inputTokenSource: 'estimated',
          outputTokenSource: 'estimated',
        },
      };
    } catch (error) {
      if (isProviderError(error)) this.tracker.noteFailure(error);
      throw error;
    }
  }
}

export interface CodexJsonlStream {
  message: string;
  /** null when the stream reported no usage, so an estimate is not mistaken for an actual. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** `error` and `stream_error` events, in order. These carry the HTTP body. */
  errors: string[];
}

function collectErrorText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.detail ?? record.text;
    if (typeof message === 'string' && message.trim()) return message.trim();
    return JSON.stringify(record);
  }
  return null;
}

/**
 * Parse the Codex `--json` event stream. `error` and `stream_error` events are surfaced,
 * not dropped: they are where "requires a newer Codex app/CLI" arrives.
 */
export function parseCodexJsonl(value: string, providerId = 'codex-cli'): CodexJsonlStream {
  let message = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  const errors: string[] = [];

  for (const line of (value ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const data = event.data as Record<string, unknown> | undefined;
    const msg = event.msg as Record<string, unknown> | undefined;
    const item = (event.item ?? data?.item ?? msg?.item) as Record<string, unknown> | undefined;

    if (item?.type === 'agent_message' && typeof item.text === 'string') message = item.text;

    const eventTypes = [event.type, data?.type, msg?.type, item?.type].filter((entry): entry is string => typeof entry === 'string');
    if (eventTypes.some((type) => type === 'error' || type === 'stream_error' || type === 'turn.failed' || type === 'task_error')) {
      const text = collectErrorText(event.message ?? event.error ?? msg?.message ?? msg?.error ?? data?.message ?? data?.error ?? item?.message ?? item?.text ?? event);
      if (text) errors.push(text);
    } else if (event.error !== undefined || data?.error !== undefined || msg?.error !== undefined) {
      const text = collectErrorText(event.error ?? data?.error ?? msg?.error);
      if (text) errors.push(text);
    }

    const usage = (event.usage ?? data?.usage ?? msg?.usage) as Record<string, unknown> | undefined;
    if (usage) {
      const number = (key: string, alternate: string) => {
        const raw = usage[key] ?? usage[alternate];
        const parsed = Number(raw);
        return raw === undefined || raw === null || !Number.isFinite(parsed) ? null : parsed;
      };
      const nextInput = number('input_tokens', 'inputTokens');
      const nextOutput = number('output_tokens', 'outputTokens');
      if (nextInput !== null) inputTokens = Math.max(inputTokens ?? 0, nextInput);
      if (nextOutput !== null) outputTokens = Math.max(outputTokens ?? 0, nextOutput);
    }
  }

  if (!message.trim()) {
    if (errors.length > 0) {
      const joined = errors.join('\n');
      throw new ProviderError({
        kind: classifyProviderFailure({ stdout: joined }),
        providerId,
        headline: `Codex reported an error and emitted no final agent message: ${errors[0]}`,
        stdout: joined,
      });
    }
    throw new ProviderError({
      kind: 'malformed-output',
      providerId,
      headline: 'Codex CLI did not emit a final agent message.',
      stdout: value ?? '',
    });
  }
  return { message: message.trim(), inputTokens, outputTokens, errors };
}

export class CodexCliStructuredExtractionProvider implements StructuredExtractionProvider {
  readonly identity: StructuredProviderIdentity;
  private readonly tracker: CliAvailabilityTracker;
  private readonly timeoutMs: number;

  constructor(
    private readonly executable = 'codex',
    private readonly model = 'gpt-5.6-sol',
    private readonly reasoningEffort = 'high',
    options: CliProviderOptions = {},
  ) {
    this.identity = Object.freeze({ providerId: 'codex-cli', modelLabel: `${model}-${reasoningEffort}` });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
    this.tracker = new CliAvailabilityTracker({
      providerId: 'codex-cli',
      executable,
      versionArgs: ['--version'],
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ttlMs: options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS,
      minimumVersion: options.minimumVersion ?? null,
      model,
    });
  }

  isAvailable(): boolean {
    return this.tracker.status().available;
  }

  availability(): ProviderAvailability {
    return this.tracker.status();
  }

  refresh(): ProviderAvailability {
    return this.tracker.refresh();
  }

  async extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult> {
    try {
      const run = await runCliCommand({
        providerId: this.identity.providerId,
        command: this.executable,
        args: [
          'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
          '--model', this.model, '-c', `model_reasoning_effort="${this.reasoningEffort}"`, '--json', '-C', process.cwd(), '-',
        ],
        input: request.prompt,
        signal,
        timeoutMs: this.timeoutMs,
      });
      const parsed = parseCodexJsonl(run.stdout, this.identity.providerId);
      const output = parseStructuredExtractionOutputText(parsed.message, {
        providerId: this.identity.providerId,
        stdout: run.stdout,
        stderr: run.stderr,
      });
      return {
        output,
        usage: {
          // Provider-reported usage is authoritative and wins over the estimator.
          inputTokens: parsed.inputTokens ?? estimateTokens(request.prompt),
          outputTokens: parsed.outputTokens ?? estimateTokens(parsed.message),
          sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
          inputTokenSource: parsed.inputTokens === null ? 'estimated' : 'provider-reported',
          outputTokenSource: parsed.outputTokens === null ? 'estimated' : 'provider-reported',
        },
      };
    } catch (error) {
      if (isProviderError(error)) this.tracker.noteFailure(error);
      throw error;
    }
  }
}

function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(withoutFence) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}
