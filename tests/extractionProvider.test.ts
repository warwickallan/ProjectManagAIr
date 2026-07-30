import { describe, expect, it } from 'vitest';
import {
  SOURCE_INTELLIGENCE_CATEGORIES,
  FakeStructuredExtractionProvider,
  FrozenPacketExtractionProvider,
  buildStructuredExtractionPrompt,
  parseCodexJsonl,
  sha256,
  type StructuredExtractionRequest,
} from '../src/extractionProvider';
import type { SourceIntelligencePacket } from '../src/sourceIntelligence';

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
    const base = requestBase();
    const prompt = buildStructuredExtractionPrompt(base);
    const request: StructuredExtractionRequest = {
      ...base,
      prompt,
      promptSha256: sha256(prompt),
      skillSha256: 'b'.repeat(64),
    };
    const result = await provider.extract(request);
    expect(provider.identity).toEqual({ providerId: 'fake-structured-provider', modelLabel: 'synthetic-test-output-v1' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, sourceTokens: 3 });
  });

  it('replays a frozen packet as window-bounded provider output', async () => {
    const provider = new FrozenPacketExtractionProvider(packet());
    const base = requestBase();
    const prompt = buildStructuredExtractionPrompt(base);
    const result = await provider.extract({ ...base, prompt, promptSha256: sha256(prompt), skillSha256: 'c'.repeat(64) });
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
    expect(parseCodexJsonl(stream)).toEqual({ message: '{"rows":[],"windowCoverage":[],"categoryCoverage":[]}', inputTokens: 321, outputTokens: 45 });
  });
});
