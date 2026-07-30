import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SOURCE_INTELLIGENCE_CATEGORIES,
  ClaudeCodeStructuredExtractionProvider,
  CodexCliStructuredExtractionProvider,
  FakeStructuredExtractionProvider,
  FrozenPacketExtractionProvider,
  ProviderError,
  buildStructuredExtractionPrompt,
  charFloorTokens,
  classifyProviderFailure,
  estimateTokens,
  isProviderError,
  parseCodexJsonl,
  parseStructuredExtractionOutput,
  parseStructuredExtractionOutputText,
  runCliCommand,
  sha256,
  type StructuredExtractionRequest,
} from '../src/extractionProvider';
import { ClaudeCodeGroundedBriefProvider, DEFAULT_BRIEF_TIMEOUT_MS } from '../src/briefProvider';
import type { SourceIntelligencePacket } from '../src/sourceIntelligence';

/* ------------------------------------------------------------------ fake CLI plumbing */

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'projectmanagair-provider-'));
  workspaces.push(dir);
  return dir;
}

/** Write a fake executable CLI on disk. No test in this file ever reaches a real model. */
function fakeCli(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/** A CLI that answers `--version` successfully but fails the real call, like the live failures do. */
function installedCli(dir: string, name: string, body: string, version = '2.0.0'): string {
  return fakeCli(dir, name, `case "$1" in --version) echo "${name} ${version}"; exit 0;; esac\n${body}`);
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

const VALID_OUTPUT = {
  rows: [],
  windowCoverage: [{ key: '1', status: 'none-found', itemCount: 0, explanation: 'Nothing governance-bearing in this window.' }],
  categoryCoverage: SOURCE_INTELLIGENCE_CATEGORIES.map((key) => ({ key, status: 'none-found', itemCount: 0, explanation: 'None found.' })),
};

function requestBase() {
  return {
    source: {
      sourceId: 'SRC-001',
      sourceType: 'text-note',
      originalFileName: 'synthetic-note.txt',
      contentHash: 'a'.repeat(64),
      eventDate: '2026-01-02',
    },
    project: { projectId: 'synthetic-project', projectCode: 'SYN', baseRegisterRevision: 0 },
    windows: [{
      id: 'SRC-001:window:001',
      seq: 1,
      startSeq: 1,
      endSeq: 1,
      tokenEstimate: 10,
      segments: [{ seq: 1, text: 'Action: confirm the synthetic owner.', speaker: null, tStartMs: null }],
    }],
    categories: [...SOURCE_INTELLIGENCE_CATEGORIES],
    existingRows: [],
    callIndex: 1,
  };
}

function fullRequest(): StructuredExtractionRequest {
  const base = requestBase();
  const prompt = buildStructuredExtractionPrompt(base);
  return { ...base, prompt, promptSha256: sha256(prompt), skillSha256: 'd'.repeat(64) };
}

function packet(): SourceIntelligencePacket {
  const empty = () => ({ rows: [] });
  return {
    packet_type: 'project_register_delta',
    packet_version: 1,
    project_code: 'SYN',
    base_register_revision: 0,
    source: {
      source_id: 'SRC-001',
      content_hash: 'a'.repeat(64),
      source_type: 'text-note',
      original_file_name: 'synthetic-note.txt',
      event_date: '2026-01-02',
      duration_ms: null,
      participants: [],
    },
    sheets: {
      Decisions: empty(),
      Actions: {
        rows: [{
          client_ref: 'action-1',
          op: 'add',
          target_id: null,
          proposed_id: '$ALLOC',
          title: 'Confirm the synthetic owner',
          summary: 'Confirm the synthetic owner.',
          status: 'open',
          record_type: 'action',
          owner: null,
          due_date_raw: null,
          source_ref: 'SRC-001',
          related_refs: [],
          supersedes: [],
          anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: 'confirm the synthetic owner' }],
          derivation: 'fact',
          reasoning: null,
          confidence: 'high',
          discharges_markers: [],
          details: {},
        }],
      },
      Risks_Issues: empty(),
      Config_Changes: empty(),
      Open_Questions: empty(),
      Milestones: empty(),
      Entities: empty(),
      Sources: empty(),
      Uncertainty: empty(),
    },
    coverage: {
      windows: [{ key: '1', status: 'populated', item_count: 1, explanation: null }],
      categories: SOURCE_INTELLIGENCE_CATEGORIES.map((key) => ({
        key,
        status: key === 'Actions' ? 'populated' as const : 'none-found' as const,
        item_count: key === 'Actions' ? 1 : 0,
        explanation: key === 'Actions' ? null : `No ${key} found.`,
      })),
    },
    execution: { runs: ['synthetic-run'] },
  };
}

/** The row shape a well-behaved provider emits, used to mutate one field at a time. */
function validRow() {
  return {
    registerName: 'Actions',
    row: {
      client_ref: 'action-1',
      op: 'add',
      target_id: null,
      proposed_id: '$ALLOC',
      title: 'Confirm the synthetic owner',
      summary: 'Confirm the synthetic owner.',
      status: 'open',
      record_type: 'action',
      owner: null,
      due_date_raw: null,
      source_ref: 'SRC-001',
      related_refs: [],
      supersedes: [],
      anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: 'confirm the synthetic owner' }],
      derivation: 'fact',
      reasoning: null,
      confidence: 'high',
      discharges_markers: [],
      details: {},
    },
  };
}

/* --------------------------------------------------------------------- existing behaviour */

describe('structured extraction providers', () => {
  it('builds a deterministic bounded prompt', () => {
    const first = buildStructuredExtractionPrompt(requestBase());
    const second = buildStructuredExtractionPrompt(requestBase());
    expect(first).toBe(second);
    expect(sha256(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toContain('proposed_id');
    expect(first).toContain('Action: confirm the synthetic owner.');
  });

  it('keeps fake provider identity under implementation control', async () => {
    const provider = new FakeStructuredExtractionProvider((request) => ({
      output: {
        rows: [],
        windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'none-found', itemCount: 0, explanation: 'Synthetic none found.' })),
        categoryCoverage: request.categories.map((key) => ({ key, status: 'none-found', itemCount: 0, explanation: 'Synthetic none found.' })),
      },
      usage: { inputTokens: 10.8, outputTokens: 5.2, sourceTokens: 3.9 },
    }));
    const result = await provider.extract(fullRequest());
    expect(provider.identity).toEqual({ providerId: 'fake-structured-provider', modelLabel: 'synthetic-test-output-v1' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, sourceTokens: 3 });
  });

  it('replays a frozen packet as window-bounded provider output', async () => {
    const provider = new FrozenPacketExtractionProvider(packet());
    const result = await provider.extract(fullRequest());
    expect(result.output.rows).toHaveLength(1);
    expect(result.output.rows[0].registerName).toBe('Actions');
    expect(result.output.windowCoverage).toEqual([{ key: '1', status: 'populated', itemCount: 1, explanation: null }]);
    expect(provider.identity.providerId).toBe('frozen-packet-provider');
  });

  it('parses the final Codex JSONL message and reported usage', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"rows":[],"windowCoverage":[],"categoryCoverage":[]}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, output_tokens: 45 } }),
    ].join('\n');
    expect(parseCodexJsonl(stream)).toEqual({
      message: '{"rows":[],"windowCoverage":[],"categoryCoverage":[]}',
      inputTokens: 321,
      outputTokens: 45,
      errors: [],
    });
  });
});

/* --------------------------------------------------------------- D5 output validation */

describe('provider output is parsed, never cast', () => {
  const context = { providerId: 'codex-cli' };

  function expectMalformed(run: () => unknown, fragment?: RegExp) {
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(isProviderError(thrown)).toBe(true);
    const error = thrown as ProviderError;
    expect(error.kind).toBe('malformed-output');
    expect(error.providerId).toBe('codex-cli');
    if (fragment) expect(error.message).toMatch(fragment);
    return error;
  }

  it('accepts a well-formed payload and returns it', () => {
    const output = parseStructuredExtractionOutput({ ...VALID_OUTPUT, rows: [validRow()] }, context);
    expect(output.rows).toHaveLength(1);
    expect(output.rows[0].row.client_ref).toBe('action-1');
    expect(output.windowCoverage[0].status).toBe('none-found');
  });

  it('rejects rows: null instead of recording a completed run', () => {
    expectMalformed(() => parseStructuredExtractionOutput({ ...VALID_OUTPUT, rows: null }, context), /rows/);
  });

  it('rejects a missing windowCoverage', () => {
    const { windowCoverage, ...withoutWindows } = VALID_OUTPUT;
    expect(windowCoverage).toBeDefined();
    expectMalformed(() => parseStructuredExtractionOutput(withoutWindows, context), /windowCoverage/);
  });

  it('rejects wrong types inside coverage', () => {
    expectMalformed(() => parseStructuredExtractionOutput({
      ...VALID_OUTPUT,
      windowCoverage: [{ key: '1', status: 'none-found', itemCount: 'zero', explanation: null }],
    }, context), /itemCount/);
  });

  it('rejects an unknown coverage status', () => {
    expectMalformed(() => parseStructuredExtractionOutput({
      ...VALID_OUTPUT,
      windowCoverage: [{ key: '1', status: 'skipped', itemCount: 0, explanation: null }],
    }, context));
  });

  it('rejects extra unknown keys at the top level', () => {
    expectMalformed(() => parseStructuredExtractionOutput({ ...VALID_OUTPUT, extraSheet: { rows: [] } }, context), /extraSheet/);
  });

  it('rejects extra unknown keys inside a row', () => {
    const row = validRow();
    expectMalformed(() => parseStructuredExtractionOutput({
      ...VALID_OUTPUT,
      rows: [{ ...row, row: { ...row.row, allocated_external_id: 'SYN-A-001' } }],
    }, context), /allocated_external_id/);
  });

  it('rejects an unknown typed detail key, matching the packet contract', () => {
    const row = validRow();
    expectMalformed(() => parseStructuredExtractionOutput({
      ...VALID_OUTPUT,
      rows: [{ ...row, row: { ...row.row, details: { made_up_field: 'x' } } }],
    }, context), /made_up_field/);
  });

  it('rejects a row with no anchors', () => {
    const row = validRow();
    expectMalformed(() => parseStructuredExtractionOutput({
      ...VALID_OUTPUT,
      rows: [{ ...row, row: { ...row.row, anchors: [] } }],
    }, context), /anchors/);
  });

  it('rejects an unknown register name', () => {
    const row = validRow();
    expectMalformed(() => parseStructuredExtractionOutput({ ...VALID_OUTPUT, rows: [{ ...row, registerName: 'Invented' }] }, context));
  });

  it('rejects non-JSON text', () => {
    expectMalformed(() => parseStructuredExtractionOutputText('I could not complete this task.', context), /not JSON/);
  });

  it('rejects empty output', () => {
    expectMalformed(() => parseStructuredExtractionOutputText('   ', context), /no output/);
  });

  it('accepts a fenced JSON payload', () => {
    const output = parseStructuredExtractionOutputText('```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```', context);
    expect(output.categoryCoverage).toHaveLength(SOURCE_INTELLIGENCE_CATEGORIES.length);
  });
});

/* ------------------------------------------------------------ D4 error fidelity, taxonomy */

describe('provider error taxonomy', () => {
  it('classifies the real Codex refusal as cli-too-old, not a bare exit code', () => {
    const body = 'stream error: unexpected status 400 Bad Request: {"detail":"The requested model \'gpt-5.6-sol\' requires a newer version of the Codex app/CLI. Please update to continue."}';
    expect(classifyProviderFailure({ stdout: body, exitCode: 1 })).toBe('cli-too-old');
  });

  it('classifies each taxonomy member distinguishably', () => {
    expect(classifyProviderFailure({ spawnErrorCode: 'ENOENT' })).toBe('cli-missing');
    expect(classifyProviderFailure({ stderr: 'codex: command not found', exitCode: 127 })).toBe('cli-missing');
    expect(classifyProviderFailure({ stdout: '{"error":{"message":"The model `gpt-5.6-sol` does not exist or you do not have access to it."}}', exitCode: 1 })).toBe('model-unsupported');
    expect(classifyProviderFailure({ stderr: 'Error: 401 Unauthorized. Please run codex login.', exitCode: 1 })).toBe('auth');
    expect(classifyProviderFailure({ stdout: 'HTTP 429 rate limit exceeded, try again later', exitCode: 1 })).toBe('transient');
    expect(classifyProviderFailure({ stderr: 'connect ECONNRESET', exitCode: 1 })).toBe('transient');
    expect(classifyProviderFailure({ timedOut: true })).toBe('transient');
    expect(classifyProviderFailure({ stderr: 'something nobody has seen before', exitCode: 3 })).toBe('unknown');
  });

  it('preserves stdout AND stderr on a non-zero exit', async () => {
    const dir = workspace();
    const cli = installedCli(dir, 'codex', [
      'echo \'{"type":"stream_error","message":"unexpected status 400 Bad Request"}\'',
      'echo "codex: fatal, see diagnostics above" 1>&2',
      'exit 1',
    ].join('\n'));
    const provider = new CodexCliStructuredExtractionProvider(cli, 'gpt-5.6-sol', 'high', { availabilityTtlMs: 60_000 });
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown);
    expect(isProviderError(error)).toBe(true);
    const providerError = error as ProviderError;
    expect(providerError.exitCode).toBe(1);
    expect(providerError.stdout).toContain('unexpected status 400 Bad Request');
    expect(providerError.stderr).toContain('codex: fatal, see diagnostics above');
    expect(providerError.message).toContain('unexpected status 400 Bad Request');
    expect(providerError.message).toContain('codex: fatal, see diagnostics above');
    expect(providerError.detail).toContain('stdout:');
    expect(providerError.detail).toContain('stderr:');
    expect(providerError.toJSON()).toMatchObject({ providerId: 'codex-cli', exitCode: 1 });
  });

  it('surfaces a JSONL error event instead of "did not emit a final agent message"', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'stream_error', message: "unexpected status 400 Bad Request: The requested model 'gpt-5.6-sol' requires a newer version of the Codex app/CLI." }),
      JSON.stringify({ type: 'turn.failed' }),
    ].join('\n');
    const error = (() => { try { parseCodexJsonl(stream); } catch (thrown) { return thrown; } })();
    expect(isProviderError(error)).toBe(true);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe('cli-too-old');
    expect(providerError.message).toContain('requires a newer version of the Codex app/CLI');
    expect(providerError.message).not.toContain('did not emit a final agent message');
  });

  it('still reports malformed-output when a stream carries neither message nor error', () => {
    const error = (() => { try { parseCodexJsonl(JSON.stringify({ type: 'thread.started' })); } catch (thrown) { return thrown; } })();
    expect((error as ProviderError).kind).toBe('malformed-output');
    expect((error as ProviderError).message).toContain('did not emit a final agent message');
  });

  it('keeps a recovered stream_error visible alongside a successful message', () => {
    const stream = [
      JSON.stringify({ type: 'stream_error', message: 'temporary disconnect, retrying' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"rows":[]}' } }),
    ].join('\n');
    const parsed = parseCodexJsonl(stream);
    expect(parsed.message).toBe('{"rows":[]}');
    expect(parsed.errors).toEqual(['temporary disconnect, retrying']);
    expect(parsed.inputTokens).toBeNull();
  });

  it('classifies the HTTP 400 model refusal through the whole Codex adapter', async () => {
    const dir = workspace();
    const cli = installedCli(dir, 'codex', [
      `echo '{"type":"stream_error","message":"unexpected status 400 Bad Request: The requested model requires a newer version of the Codex app/CLI."}'`,
      'exit 1',
    ].join('\n'));
    const provider = new CodexCliStructuredExtractionProvider(cli, 'gpt-5.6-sol', 'high');
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('cli-too-old');
    expect(error.message).toContain('requires a newer version of the Codex app/CLI');
    // The failure latches, so the pipeline stops selecting a provider that cannot work.
    expect(provider.isAvailable()).toBe(false);
    expect(provider.availability()).toMatchObject({ available: false, kind: 'cli-too-old' });
  });

  it('classifies a missing CLI as cli-missing at both the probe and the call', async () => {
    const dir = workspace();
    const missing = path.join(dir, 'not-installed-codex');
    const provider = new CodexCliStructuredExtractionProvider(missing);
    expect(provider.isAvailable()).toBe(false);
    expect(provider.availability()).toMatchObject({ available: false, kind: 'cli-missing' });
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('cli-missing');
  });

  it('classifies a transient provider failure without latching availability', async () => {
    const dir = workspace();
    const cli = installedCli(dir, 'codex', ['echo "Error: 429 rate limit exceeded, try again later" 1>&2', 'exit 1'].join('\n'));
    const provider = new CodexCliStructuredExtractionProvider(cli);
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('transient');
    expect(provider.isAvailable()).toBe(true);
  });

  it('classifies an out-of-date CLI version as cli-too-old before any call', () => {
    const dir = workspace();
    const cli = fakeCli(dir, 'codex', 'echo "codex-cli 0.9.3"');
    const provider = new CodexCliStructuredExtractionProvider(cli, 'gpt-5.6-sol', 'high', { minimumVersion: '1.4.0' });
    expect(provider.isAvailable()).toBe(false);
    expect(provider.availability()).toMatchObject({ available: false, kind: 'cli-too-old', version: '0.9.3' });
  });

  it('refuses a blank configured model as model-unsupported', () => {
    const dir = workspace();
    const cli = fakeCli(dir, 'codex', 'echo "codex-cli 2.0.0"');
    const provider = new CodexCliStructuredExtractionProvider(cli, '   ');
    expect(provider.availability()).toMatchObject({ available: false, kind: 'model-unsupported' });
  });
});

/* ------------------------------------------------------------------- D4 availability refresh */

describe('availability refresh', () => {
  it('goes from unavailable to available once the binary appears, with no new provider object', () => {
    const dir = workspace();
    const target = path.join(dir, 'claude');
    const provider = new ClaudeCodeStructuredExtractionProvider(target, { availabilityTtlMs: 10 * 60_000 });

    expect(provider.isAvailable()).toBe(false);
    expect(provider.availability()).toMatchObject({ available: false, kind: 'cli-missing' });

    fakeCli(dir, 'claude', 'echo "1.2.3 (Claude Code)"');

    // The cached probe still answers until the TTL expires or refresh() is called.
    expect(provider.isAvailable()).toBe(false);

    const refreshed = provider.refresh();
    expect(refreshed).toMatchObject({ available: true, kind: null, version: '1.2.3' });
    expect(provider.isAvailable()).toBe(true);
  });

  it('re-probes automatically once the availability TTL expires', async () => {
    const dir = workspace();
    const target = path.join(dir, 'claude');
    const provider = new ClaudeCodeStructuredExtractionProvider(target, { availabilityTtlMs: 20 });
    expect(provider.isAvailable()).toBe(false);
    fakeCli(dir, 'claude', 'echo "1.2.3"');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(provider.isAvailable()).toBe(true);
  });

  it('refresh clears a latched call failure', async () => {
    const dir = workspace();
    const cli = installedCli(dir, 'claude', 'echo "401 Unauthorized: please log in" 1>&2\nexit 1');
    const provider = new ClaudeCodeStructuredExtractionProvider(cli, { availabilityTtlMs: 10 * 60_000 });
    expect(provider.isAvailable()).toBe(true);
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('auth');
    expect(provider.isAvailable()).toBe(false);
    fakeCli(dir, 'claude', 'echo "1.0.0"');
    expect(provider.refresh().available).toBe(true);
  });
});

/* --------------------------------------------------------------------- CLI happy paths */

describe('CLI providers over fake executables', () => {
  it('validates Claude CLI output at the boundary and reports estimated usage', async () => {
    const dir = workspace();
    const cli = fakeCli(dir, 'claude', `cat <<'JSON'\n${JSON.stringify(VALID_OUTPUT)}\nJSON`);
    const provider = new ClaudeCodeStructuredExtractionProvider(cli);
    const result = await provider.extract(fullRequest());
    expect(result.output.categoryCoverage).toHaveLength(SOURCE_INTELLIGENCE_CATEGORIES.length);
    expect(result.usage.inputTokenSource).toBe('estimated');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(provider.identity).toEqual({ providerId: 'claude-code', modelLabel: 'claude-code-cli-default' });
  });

  it('throws malformed-output when the Claude CLI returns {"rows": null}', async () => {
    const dir = workspace();
    const cli = fakeCli(dir, 'claude', `echo '{"rows":null,"windowCoverage":[],"categoryCoverage":[]}'`);
    const provider = new ClaudeCodeStructuredExtractionProvider(cli);
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('malformed-output');
    expect(error.message).toContain('rows');
  });

  it('prefers provider-reported usage over the estimate and records which was used', async () => {
    const dir = workspace();
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(VALID_OUTPUT) } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 987_654, output_tokens: 4_321 } }),
    ];
    const cli = fakeCli(dir, 'codex', ['cat > /dev/null', ...stream.map((line) => `echo '${line}'`)].join('\n'));
    const provider = new CodexCliStructuredExtractionProvider(cli);
    const result = await provider.extract(fullRequest());
    expect(result.usage.inputTokens).toBe(987_654);
    expect(result.usage.outputTokens).toBe(4_321);
    expect(result.usage.inputTokenSource).toBe('provider-reported');
    expect(result.usage.outputTokenSource).toBe('provider-reported');
  });

  it('falls back to a labelled estimate when Codex reports no usage', async () => {
    const dir = workspace();
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(VALID_OUTPUT) } });
    const cli = fakeCli(dir, 'codex', `cat > /dev/null\necho '${line}'`);
    const provider = new CodexCliStructuredExtractionProvider(cli);
    const result = await provider.extract(fullRequest());
    expect(result.usage.inputTokenSource).toBe('estimated');
    expect(result.usage.inputTokens).toBe(estimateTokens(fullRequest().prompt));
  });

  it('sends the prompt on stdin to Codex', async () => {
    const dir = workspace();
    const capture = path.join(dir, 'stdin.txt');
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(VALID_OUTPUT) } });
    const cli = fakeCli(dir, 'codex', `cat > ${capture}\necho '${line}'`);
    await new CodexCliStructuredExtractionProvider(cli).extract(fullRequest());
    expect(readFileSync(capture, 'utf8')).toContain('Action: confirm the synthetic owner.');
  });
});

/* ------------------------------------------------------------------------ timeouts */

describe('timeouts kill the child', () => {
  it('terminates a hung CLI, throws a typed transient error, and leaves no process behind', async () => {
    const dir = workspace();
    const pidFile = path.join(dir, 'child.pid');
    const cli = fakeCli(dir, 'claude', `echo $$ > ${pidFile}\nexec sleep 30`);
    const provider = new ClaudeCodeStructuredExtractionProvider(cli, { timeoutMs: 300 });
    const started = Date.now();
    const error = await provider.extract(fullRequest()).catch((thrown: unknown) => thrown) as ProviderError;
    const elapsed = Date.now() - started;

    expect(isProviderError(error)).toBe(true);
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('timed out after 300 ms');
    expect(elapsed).toBeLessThan(5_000);

    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isFinite(pid)).toBe(true);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('aborts on an AbortSignal without waiting for the timeout', async () => {
    const dir = workspace();
    const cli = fakeCli(dir, 'claude', 'exec sleep 30');
    const controller = new AbortController();
    const pending = runCliCommand({ providerId: 'claude-code', command: cli, args: [], timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('aborted');
  });

  it('gives the brief provider a much shorter default budget than extraction', async () => {
    expect(DEFAULT_BRIEF_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    const dir = workspace();
    const cli = fakeCli(dir, 'claude', 'exec sleep 30');
    const provider = new ClaudeCodeGroundedBriefProvider(cli, { timeoutMs: 250 });
    const error = await provider.generate({ prompt: 'brief me', selectionHash: 'abc' }).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('timed out after 250 ms');
  });

  it('runs exactly one brief call, with no retry, and surfaces the CLI failure', async () => {
    const dir = workspace();
    const counter = path.join(dir, 'calls.txt');
    const cli = installedCli(dir, 'claude', `echo x >> ${counter}\necho "boom on stdout"\necho "boom on stderr" 1>&2\nexit 2`);
    const provider = new ClaudeCodeGroundedBriefProvider(cli);
    const error = await provider.generate({ prompt: 'brief me', selectionHash: 'abc' }).catch((thrown: unknown) => thrown) as ProviderError;
    expect(error.message).toContain('boom on stdout');
    expect(error.message).toContain('boom on stderr');
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ D6 estimator calibration */

/** The estimator that undercounted by 1.5–4x; kept only as a calibration reference. */
function legacyEstimate(value: string): number {
  return Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.35);
}

const PROSE_FIXTURE = [
  'Right, so the thing I want to pick up first is the permit to work register, because we agreed last',
  'Thursday that the isolation certificates would be reissued before the shutdown window opens. Tony is',
  'going to confirm the payroll cutover date with finance, and I will chase the duplicate records that',
  'are still showing on the register even after we suppressed them. That is an action on me, and I would',
  'like it closed out by the end of next week at the latest, because the client is asking every day.',
].join(' ');

const JSON_FIXTURE = JSON.stringify({
  rows: Array.from({ length: 12 }, (_, index) => ({
    client_ref: `action-${index + 1}`,
    op: 'add',
    target_id: null,
    proposed_id: '$ALLOC',
    title: 'Confirm the isolation certificate reissue date',
    summary: 'Confirm with the client that the isolation certificates are reissued before the shutdown window.',
    status: 'open',
    record_type: 'action',
    owner: null,
    due_date_raw: 'by the end of next week',
    source_ref: 'SRC-001',
    related_refs: [],
    supersedes: [],
    anchors: [{ segment_seq: index + 1, speaker: null, t_ms: null, quote: 'that is an action on me' }],
    derivation: 'fact',
    reasoning: null,
    confidence: 'high',
    discharges_markers: [],
    details: { severity: 'medium', likelihood: 'low', mitigation: 'Reissue before the window opens.' },
  })),
});

describe('token estimator calibration', () => {
  const mixedFixture = buildStructuredExtractionPrompt({
    ...requestBase(),
    windows: [{
      id: 'SRC-001:window:001',
      seq: 1,
      startSeq: 1,
      endSeq: 6,
      tokenEstimate: 900,
      segments: PROSE_FIXTURE.split('. ').map((text, index) => ({ seq: index + 1, text: `${text}.`, speaker: 'Speaker One', tStartMs: index * 12_000 })),
    }],
    existingRows: Array.from({ length: 8 }, (_, index) => ({
      registerName: 'Actions',
      externalId: `SYN-A-${String(index + 1).padStart(3, '0')}`,
      title: 'Reissue the isolation certificates',
      status: 'open',
      owner: 'Tony',
      dueDate: '2026-02-01',
    })),
  });

  const fixtures = [
    { name: 'prose', text: PROSE_FIXTURE },
    { name: 'json-heavy', text: JSON_FIXTURE },
    { name: 'mixed prompt', text: mixedFixture },
  ];

  it('never falls below the chars/4 floor on any fixture', () => {
    for (const fixture of fixtures) {
      expect(estimateTokens(fixture.text)).toBeGreaterThanOrEqual(charFloorTokens(fixture.text));
    }
  });

  it('never returns less than the estimator it replaces', () => {
    for (const fixture of fixtures) {
      expect(estimateTokens(fixture.text)).toBeGreaterThan(legacyEstimate(fixture.text));
    }
  });

  it('closes the measured 1.44x prose-prompt shortfall', () => {
    // The review measured 7,020 chars estimating 1,221 against ~1,755 by chars/4.
    expect(estimateTokens(mixedFixture)).toBeGreaterThanOrEqual(Math.ceil(mixedFixture.length / 4));
    expect(estimateTokens(mixedFixture) / legacyEstimate(mixedFixture)).toBeGreaterThan(1.4);
  });

  it('is markedly more conservative on punctuation-dense JSON than on prose', () => {
    const jsonRatio = estimateTokens(JSON_FIXTURE) / legacyEstimate(JSON_FIXTURE);
    const proseRatio = estimateTokens(PROSE_FIXTURE) / legacyEstimate(PROSE_FIXTURE);
    expect(jsonRatio).toBeGreaterThan(2.5);
    expect(jsonRatio).toBeGreaterThan(proseRatio);
    // Conservative, not absurd: a JSON payload is not more than one token per character.
    expect(estimateTokens(JSON_FIXTURE)).toBeLessThanOrEqual(JSON_FIXTURE.length);
  });

  it('stays conservative but bounded on plain prose', () => {
    const ratio = estimateTokens(PROSE_FIXTURE) / legacyEstimate(PROSE_FIXTURE);
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(2);
  });

  it('is monotonic and handles the empty case', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens(PROSE_FIXTURE + PROSE_FIXTURE)).toBeGreaterThan(estimateTokens(PROSE_FIXTURE));
  });
});
