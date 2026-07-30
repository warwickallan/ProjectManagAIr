import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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

export interface ExtractionWindowInput {
  id: string;
  seq: number;
  startSeq: number;
  endSeq: number;
  tokenEstimate: number;
  segments: ExtractionSegmentInput[];
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
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  sourceTokens: number;
}

export interface StructuredExtractionResult {
  output: StructuredExtractionOutput;
  usage: ProviderUsage;
}

export interface StructuredExtractionProvider {
  readonly identity: StructuredProviderIdentity;
  isAvailable(): boolean;
  extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult>;
}

export const SOURCE_EXTRACTION_SKILL = `Project ManagAIr Source Intelligence extraction v1.
Interpret only the supplied source segments and current register index.
Return proposals, never final state. New rows use proposed_id "$ALLOC".
Every fact has a mechanically resolvable segment anchor and verbatim quote.
Review every requested category and window, including explicit none-found coverage.
Do not invent provider identity, durable IDs, source text, dates, owners or status.`;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function estimateTokens(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.35);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildStructuredExtractionPrompt(input: Omit<StructuredExtractionRequest, 'prompt' | 'promptSha256' | 'skillSha256'>): string {
  const request = {
    contract: {
      rows: {
        registerName: SOURCE_INTELLIGENCE_CATEGORIES,
        row: {
          client_ref: 'unique within packet',
          op: ['add', 'update', 'resolve', 'supersede', 'reaffirm'],
          target_id: 'required except add',
          proposed_id: '$ALLOC for add',
          title: 'non-empty',
          summary: 'string',
          status: 'source wording normalized conservatively',
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
          discharges_markers: [],
          details: {},
        },
      },
      coverage: {
        windows: 'one entry per requested window seq',
        categories: 'one entry per requested category',
        statuses: ['reviewed', 'populated', 'none-found', 'uncertain', 'failed', 'no-governance-content'],
      },
    },
    task: input,
  };
  return `${SOURCE_EXTRACTION_SKILL}\nReturn one JSON object only with keys rows, windowCoverage, categoryCoverage and optional markerDismissals.\n${stable(request)}`;
}

function normalizeUsage(usage: ProviderUsage): ProviderUsage {
  const number = (value: number) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    sourceTokens: number(usage.sourceTokens),
  };
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
      },
    };
  }
}

export class ClaudeCodeStructuredExtractionProvider implements StructuredExtractionProvider {
  readonly identity = Object.freeze({ providerId: 'claude-code', modelLabel: 'claude-code-cli-default' });
  private available: boolean | null = null;

  constructor(private readonly executable = 'claude') {}

  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    if (!this.executable.trim()) return false;
    const probe = spawnSync(this.executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    this.available = probe.status === 0 && !probe.error;
    return this.available;
  }

  async extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult> {
    const raw = await runCommand(this.executable, ['-p', request.prompt], signal);
    const json = parseJsonOutput(raw);
    const output = json as StructuredExtractionOutput;
    return {
      output,
      usage: {
        inputTokens: estimateTokens(request.prompt),
        outputTokens: estimateTokens(raw),
        sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
      },
    };
  }
}

export function parseCodexJsonl(value: string): { message: string; inputTokens: number; outputTokens: number } {
  let message = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const item = (event.item ?? (event.data as Record<string, unknown> | undefined)?.item) as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') message = item.text;
    const usage = (event.usage ?? (event.data as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
    if (usage) {
      const number = (key: string) => Number(usage[key] ?? 0);
      inputTokens = Math.max(inputTokens, number('input_tokens') || number('inputTokens'));
      outputTokens = Math.max(outputTokens, number('output_tokens') || number('outputTokens'));
    }
  }
  if (!message.trim()) throw new Error('Codex CLI did not emit a final agent message.');
  return { message: message.trim(), inputTokens, outputTokens };
}

export class CodexCliStructuredExtractionProvider implements StructuredExtractionProvider {
  readonly identity: StructuredProviderIdentity;
  private available: boolean | null = null;

  constructor(
    private readonly executable = 'codex',
    private readonly model = 'gpt-5.6-sol',
    private readonly reasoningEffort = 'high',
  ) {
    this.identity = Object.freeze({ providerId: 'codex-cli', modelLabel: `${model}-${reasoningEffort}` });
  }

  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    const probe = spawnSync(this.executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    this.available = probe.status === 0 && !probe.error;
    return this.available;
  }

  async extract(request: StructuredExtractionRequest, signal?: AbortSignal): Promise<StructuredExtractionResult> {
    const raw = await runCommandWithInput(this.executable, [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--model', this.model, '-c', `model_reasoning_effort="${this.reasoningEffort}"`, '--json', '-C', process.cwd(), '-',
    ], request.prompt, signal);
    const parsed = parseCodexJsonl(raw);
    return {
      output: parseJsonOutput(parsed.message) as StructuredExtractionOutput,
      usage: {
        inputTokens: parsed.inputTokens || estimateTokens(request.prompt),
        outputTokens: parsed.outputTokens || estimateTokens(parsed.message),
        sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0),
      },
    };
  }
}

function runCommandWithInput(command: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
    child.stdin.end(input);
  });
}
function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(withoutFence) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
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
