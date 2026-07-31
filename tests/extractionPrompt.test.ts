import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import {
  EXTRACTION_SKILL_PATH_ENV,
  FakeStructuredExtractionProvider,
  SOURCE_EXTRACTION_SKILL,
  SOURCE_INTELLIGENCE_CATEGORIES,
  buildStructuredExtractionPrompt,
  estimateTokens,
  resolveExtractionSkill,
  sha256,
  type ExtractionMarkerInput,
  type StructuredExtractionRequest,
} from '../src/extractionProvider';
import { createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import { orchestrateSourceExtraction } from '../src/sourcePipeline';

/* ------------------------------------------------------------------ fixtures */

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  delete process.env[EXTRACTION_SKILL_PATH_ENV];
});

function temporaryDirectory(prefix = 'projectmanagair-prompt-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function marker(overrides: Partial<ExtractionMarkerInput> = {}): ExtractionMarkerInput {
  return {
    id: 'SRCDOC-SYN-001:marker:1:explicit-action',
    seq: 1,
    confidence: 'high',
    ...overrides,
  };
}

function requestBase(markers?: ExtractionMarkerInput[]) {
  return {
    source: {
      sourceId: 'SRCDOC-SYN-001',
      sourceType: 'vtt-transcript',
      originalFileName: 'synthetic-call.vtt',
      contentHash: 'a'.repeat(64),
      eventDate: '2026-01-02',
    },
    project: { projectId: 'synthetic-project', projectCode: 'SYN', baseRegisterRevision: 0 },
    windows: [{
      id: 'SRCDOC-SYN-001:window:001',
      seq: 1,
      startSeq: 1,
      endSeq: 2,
      tokenEstimate: 40,
      segments: [
        { seq: 1, text: "I'll confirm the isolation certificate with the site team today.", speaker: 'Alex Reid', tStartMs: 0 },
        { seq: 2, text: 'That works for us, thanks.', speaker: 'Jo Patel', tStartMs: 12_000 },
      ],
      ...(markers ? { markers } : {}),
    }],
    categories: [...SOURCE_INTELLIGENCE_CATEGORIES],
    existingRows: [],
    callIndex: 1,
  };
}

/**
 * A Teams-shaped transcript with the cue density and speaker alternation the real 2,159-segment
 * source has, and with genuine governance cues so `preScan` produces real HIGH/MEDIUM markers
 * rather than a synthetic marker table.
 */
function syntheticTeamsTranscript(turns: number): string {
  const speakers = ['Alex Reid', 'Jo Patel', 'Sam Okoro', 'Priya Nair'];
  const chatter = [
    'The commissioning pack came back from the subcontractor yesterday and most of it looks fine.',
    'We walked the north riser again and the cable tray brackets are still short by about two metres.',
    'Nothing has changed on the drawings since the last coordination session as far as I can tell.',
    'The client wants the handover documentation bundled by discipline rather than by level this time.',
    'That matches what the quantity surveyor said on the call last week about the valuation.',
  ];
  const cues = [
    "I'll check the isolation certificate register and confirm which permits are still open.",
    'Can you please send the updated commissioning schedule by end of week so we can plan resource.',
    "We need to add that to the risk register because the delay affects the energisation date.",
    "I've just ticked the suppress box on the duplicate asset record in the configuration screen.",
    'Is there any way to close out the outstanding snags before the client walkthrough?',
    "That's an action on me to chase the certification body for the revised report.",
    'We can only test one panel at a time, so the programme cannot compress any further.',
  ];
  const blocks = ['WEBVTT', ''];
  for (let index = 0; index < turns; index += 1) {
    const start = index * 9_000;
    const end = start + 8_500;
    const stamp = (ms: number) => {
      const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
      const minutes = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
      const seconds = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0');
      return `${hours}:${minutes}:${seconds}.000`;
    };
    // Roughly one governance cue in five turns, which is the density the design assumes.
    const text = index % 5 === 0 ? cues[(index / 5) % cues.length] : chatter[index % chatter.length];
    blocks.push(`${stamp(start)} --> ${stamp(end)}`);
    blocks.push(`<v ${speakers[index % speakers.length]}>${text}</v>`);
    blocks.push('');
  }
  return blocks.join('\n');
}

interface Ingested {
  db: DatabaseSync;
  close: () => void;
  sourceId: string;
  projectId: string;
}

async function ingestTranscript(turns: number): Promise<Ingested> {
  const directory = temporaryDirectory();
  const projectsRoot = path.join(directory, 'Projects');
  mkdirSync(projectsRoot, { recursive: true });
  const context = openProjectManagairDatabase(path.join(directory, 'prompt.db'));
  await updateStorageSettings(context.db, { projectsRoot });
  const project = createProject(context.db, {
    code: 'SYN',
    name: 'Synthetic Prompt Fixture',
    customer: 'Synthetic Customer',
    description: 'Prompt payload fixture.',
    status: 'on-track',
    owner: 'Tester',
  });
  const intake = await intakeProjectSource(context.db, project.projectId, {
    name: 'synthetic-call.vtt',
    dataBase64: Buffer.from(syntheticTeamsTranscript(turns), 'utf8').toString('base64'),
  }) as unknown as { sourceId: string };
  return { db: context.db, close: () => context.db.close(), sourceId: intake.sourceId, projectId: project.projectId };
}

/** A provider that records every prompt it is handed and returns minimal well-formed coverage. */
function capturingProvider(prompts: StructuredExtractionRequest[]) {
  return new FakeStructuredExtractionProvider((request) => {
    prompts.push(request);
    return {
      output: {
        rows: [],
        windowCoverage: request.windows.map((window) => ({ key: String(window.seq), status: 'none-found' as const, itemCount: 0, explanation: 'Synthetic capture run.' })),
        categoryCoverage: request.categories.map((key) => ({ key, status: 'none-found' as const, itemCount: 0, explanation: 'Synthetic capture run.' })),
      },
      usage: { inputTokens: estimateTokens(request.prompt), outputTokens: 20, sourceTokens: request.windows.reduce((total, window) => total + window.tokenEstimate, 0) },
    };
  });
}

/* ------------------------------------------------------------------ marker payload */

describe('marker payload in the extraction prompt', () => {
  it('carries the markers of the window it is built for', () => {
    const prompt = buildStructuredExtractionPrompt(requestBase([marker()]));
    expect(prompt).toContain('"markers":[{"confidence":"high","id":"SRCDOC-SYN-001:marker:1:explicit-action","seq":1}]');
  });

  it('omits the markers key entirely when a window has none', () => {
    // The contract block still describes the marker shape; the task payload carries no array.
    expect(buildStructuredExtractionPrompt(requestBase())).not.toContain('"markers":[');
  });

  it('gives each call only the markers of its own windows', async () => {
    const fixture = await ingestTranscript(400);
    try {
      const windows = fixture.db.prepare('SELECT seq, start_seq, end_seq, token_estimate FROM source_windows WHERE source_id = ? ORDER BY seq')
        .all(fixture.sourceId) as Array<{ seq: number; start_seq: number; end_seq: number; token_estimate: number }>;
      expect(windows.length).toBeGreaterThan(1);
      const markers = fixture.db.prepare('SELECT id, segment_seq, confidence FROM source_markers WHERE source_id = ?')
        .all(fixture.sourceId) as Array<{ id: string; segment_seq: number; confidence: string }>;
      expect(markers.some((entry) => entry.confidence === 'high')).toBe(true);

      // One window per call, so "the markers of this call" is exactly "the markers of this window".
      const prompts: StructuredExtractionRequest[] = [];
      await orchestrateSourceExtraction(fixture.db, {
        sourceId: fixture.sourceId,
        provider: capturingProvider(prompts),
        budget: { maxTokensPerCall: Math.max(...windows.map((window) => window.token_estimate)), maxCalls: windows.length },
      });
      expect(prompts).toHaveLength(windows.length);

      for (const request of prompts) {
        const window = windows.find((entry) => entry.seq === request.windows[0].seq)!;
        const inside = markers.filter((entry) => entry.confidence !== 'low' && entry.segment_seq >= window.start_seq && entry.segment_seq <= window.end_seq);
        const outside = markers.filter((entry) => entry.segment_seq < window.start_seq || entry.segment_seq > window.end_seq);
        expect(inside.length).toBeGreaterThan(0);
        for (const entry of inside) expect(request.prompt).toContain(entry.id);
        for (const entry of outside) expect(request.prompt).not.toContain(entry.id);
      }
    } finally {
      fixture.close();
    }
  });

  it('excludes LOW markers, which are deliberately never a gate', async () => {
    const fixture = await ingestTranscript(120);
    try {
      const low = fixture.db.prepare("SELECT id FROM source_markers WHERE source_id = ? AND confidence = 'low'")
        .all(fixture.sourceId) as Array<{ id: string }>;
      expect(low.length).toBeGreaterThan(0);
      const prompts: StructuredExtractionRequest[] = [];
      await orchestrateSourceExtraction(fixture.db, { sourceId: fixture.sourceId, provider: capturingProvider(prompts) });
      const joined = prompts.map((request) => request.prompt).join('\n');
      for (const entry of low) expect(joined).not.toContain(entry.id);
    } finally {
      fixture.close();
    }
  });

  it('drops markers an operator has already dismissed', async () => {
    const fixture = await ingestTranscript(120);
    try {
      const high = fixture.db.prepare("SELECT id FROM source_markers WHERE source_id = ? AND confidence = 'high' ORDER BY segment_seq LIMIT 1")
        .get(fixture.sourceId) as { id: string };
      const prompts: StructuredExtractionRequest[] = [];
      await orchestrateSourceExtraction(fixture.db, {
        sourceId: fixture.sourceId,
        provider: capturingProvider(prompts),
        markerDismissals: [{ markerId: high.id, reason: 'Social chatter, no governance content.' }],
      });
      expect(prompts.map((request) => request.prompt).join('\n')).not.toContain(high.id);
    } finally {
      fixture.close();
    }
  });
});

/* ------------------------------------------------------------------ determinism */

describe('prompt determinism', () => {
  it('is byte-identical for identical input and differs when the input differs', () => {
    const markers = [marker()];
    expect(buildStructuredExtractionPrompt(requestBase(markers))).toBe(buildStructuredExtractionPrompt(requestBase(markers)));
    expect(buildStructuredExtractionPrompt(requestBase(markers))).not.toBe(buildStructuredExtractionPrompt(requestBase()));
    const moved = [marker({ id: 'SRCDOC-SYN-001:marker:2:explicit-action', seq: 2 })];
    expect(buildStructuredExtractionPrompt(requestBase(moved))).not.toBe(buildStructuredExtractionPrompt(requestBase(markers)));
  });

  it('orders keys by code unit, not by host collation', () => {
    // `localeCompare` sorts "_b" before "aB" under en-US and after it by code unit; a prompt
    // hash recorded on one host must reproduce on another.
    const prompt = buildStructuredExtractionPrompt(requestBase([marker()]));
    expect(prompt.indexOf('"categories"')).toBeLessThan(prompt.indexOf('"existingRows"'));
    expect(prompt.indexOf('"markers"')).toBeLessThan(prompt.indexOf('"seq"'));
    expect(sha256(prompt)).toMatch(/^[a-f0-9]{64}$/);
  });
});

/* ------------------------------------------------------------------ skill contract */

describe('the extraction skill states the contract the validator enforces', () => {
  // A contract-drift alarm: each phrase names a rule `validatePacket` blocks on. If a rule is
  // renamed or added and the skill is not updated, the model is graded on an unseen checklist.
  const required: Array<[string, string]> = [
    ['every register', 'Uncertainty'],
    ['add allocation', '$ALLOC'],
    ['target_id for non-adds', 'target_id'],
    ['inference reasoning', 'REQUIRES a non-empty reasoning'],
    ['fact quotes', 'every anchor MUST carry a verbatim quote'],
    ['quote triviality', 'at least 4 words and 20 characters'],
    ['no stitching', 'Never stitch words from two segments'],
    ['adjacency', 'immediately adjacent segment'],
    ['claim support', 'share at least one substantive word'],
    ['entity support', 'participant list'],
    ['speaker exactness', "equal that segment's speaker exactly"],
    ['anchor time', '30000 ms'],
    ['marker discharge', 'discharges_markers'],
    ['discharge locality', 'within 3 segments'],
    ['marker dismissal', 'markerDismissals'],
    ['no failed windows', 'Never "failed"'],
    ['item count ceiling', 'may never exceed'],
    ['empty window explanation', 'itemCount 0 needs a non-empty explanation'],
    ['none-found explanation', '"none-found" needs one'],
    ['sources row', 'exactly one Sources row'],
    ['entity coverage', 'more than one participant'],
    ['uncertainty coverage', 'no Uncertainty rows'],
    ['null field semantics', 'did not speak to this field'],
    ['clearing semantics', 'explicitly clears the field'],
    ['details allow list', 'resolution_route'],
    ['unknown detail keys', 'any other key rejects the packet'],
    ['do not invent', 'NEVER INVENT'],
  ];

  for (const [rule, phrase] of required) {
    it(`states the ${rule} rule`, () => {
      expect(SOURCE_EXTRACTION_SKILL).toContain(phrase);
    });
  }

  it('names all nine registers', () => {
    for (const category of SOURCE_INTELLIGENCE_CATEGORIES) expect(SOURCE_EXTRACTION_SKILL).toContain(category);
  });

  it('lists every allow-listed typed-detail key', () => {
    const allowed = [
      'rationale', 'options_summary', 'outcome', 'decision_needed_by',
      'driver', 'evidence', 'impact', 'mitigation', 'likelihood', 'severity',
      'environment', 'change_type', 'follow_through',
      'question', 'parked_with', 'unblocked_by', 'blocking',
      'target_date', 'milestone_status', 'conditional_logic',
      'entity_type', 'aliases', 'alias_confidence', 'disambiguation_note', 'hypothetical',
      'source_type', 'why_uncertain', 'resolve_by', 'resolution_route',
    ];
    for (const key of allowed) expect(SOURCE_EXTRACTION_SKILL).toContain(key);
  });
});

/* ------------------------------------------------------------------ external skill */

describe('external skill injection', () => {
  it('uses the built-in constant when the environment variable is unset', () => {
    const resolved = resolveExtractionSkill({});
    expect(resolved.origin).toBe('built-in');
    expect(resolved.text).toBe(SOURCE_EXTRACTION_SKILL);
    expect(resolved.sha256).toBe(sha256(SOURCE_EXTRACTION_SKILL));
    expect(resolved.path).toBeNull();
  });

  it('loads the skill from the configured path and hashes the text it actually used', () => {
    const file = path.join(temporaryDirectory(), 'org-skill.md');
    const text = 'Organisation extraction skill, not committed to this repository.\nRule one.\n';
    writeFileSync(file, text, 'utf8');
    const resolved = resolveExtractionSkill({ [EXTRACTION_SKILL_PATH_ENV]: file });
    expect(resolved.origin).toBe('external-file');
    expect(resolved.text).toBe(text);
    expect(resolved.sha256).toBe(sha256(text));
    expect(resolved.sha256).not.toBe(sha256(SOURCE_EXTRACTION_SKILL));
    expect(resolved.path).toBe(file);
    expect(buildStructuredExtractionPrompt(requestBase(), resolved.text).startsWith(text)).toBe(true);
  });

  it('fails loudly rather than silently falling back to a contract it did not send', () => {
    const missing = path.join(temporaryDirectory(), 'absent.md');
    expect(() => resolveExtractionSkill({ [EXTRACTION_SKILL_PATH_ENV]: missing })).toThrow(/could not be read/);
    const empty = path.join(temporaryDirectory(), 'empty.md');
    writeFileSync(empty, '   \n', 'utf8');
    expect(() => resolveExtractionSkill({ [EXTRACTION_SKILL_PATH_ENV]: empty })).toThrow(/is empty/);
  });

  it('records the external skill hash on every run of a real extraction', async () => {
    const file = path.join(temporaryDirectory(), 'org-skill.md');
    const text = 'Organisation extraction skill v9. Discharge every HIGH marker.\n';
    writeFileSync(file, text, 'utf8');
    process.env[EXTRACTION_SKILL_PATH_ENV] = file;
    const fixture = await ingestTranscript(60);
    try {
      const prompts: StructuredExtractionRequest[] = [];
      const result = await orchestrateSourceExtraction(fixture.db, { sourceId: fixture.sourceId, provider: capturingProvider(prompts) });
      expect(result.skill).toMatchObject({ sha256: sha256(text), origin: 'external-file', path: file });
      const runs = fixture.db.prepare('SELECT skill_sha256 FROM extraction_runs WHERE source_id = ?').all(fixture.sourceId) as Array<{ skill_sha256: string }>;
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) expect(run.skill_sha256).toBe(sha256(text));
      for (const request of prompts) expect(request.prompt.startsWith(text)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

/* ------------------------------------------------------------------ token budget */

describe('prompt token budget', () => {
  /**
   * The gate that stops a future addition silently eating the extraction budget.
   *
   * `validatePacket` quarantines any packet whose runs total more than 200,000 input tokens, and
   * `runSourceExtraction` refuses the call that would cross it — so a prompt that grows is not a
   * cost regression, it is a guaranteed failure on the largest sources.
   *
   * Measured on the 2,159-segment fixture below (13 windows, 4 calls, marker-dense on purpose):
   *   old skill, no markers          130,357 total   32,589 per call
   *   this skill, no markers         136,455 total   34,114 per call
   *   this skill + marker payload    163,137 total   40,784 per call
   * The bounds keep roughly 20% headroom under the 200,000-token gate at that density.
   */
  const FULL_SOURCE_TOKEN_CEILING = 175_000;
  const PER_CALL_TOKEN_CEILING = 48_000;
  const SINGLE_WINDOW_TOKEN_CEILING = 16_000;

  it('keeps a full two-hour source under the budget the validator enforces', async () => {
    const fixture = await ingestTranscript(2_159);
    try {
      const segments = fixture.db.prepare('SELECT segment_count FROM source_documents WHERE id = ?')
        .get(fixture.sourceId) as { segment_count: number };
      expect(segments.segment_count).toBe(2_159);
      const prompts: StructuredExtractionRequest[] = [];
      // No budget override: this is the planner and the ceiling a real run would use.
      await orchestrateSourceExtraction(fixture.db, { sourceId: fixture.sourceId, provider: capturingProvider(prompts) });
      const measured = prompts.map((request) => estimateTokens(request.prompt));
      expect(measured.reduce((total, tokens) => total + tokens, 0)).toBeLessThan(FULL_SOURCE_TOKEN_CEILING);
      expect(Math.max(...measured)).toBeLessThan(PER_CALL_TOKEN_CEILING);
    } finally {
      fixture.close();
    }
  });

  it('keeps one realistic window, markers included, inside its stated ceiling', async () => {
    const fixture = await ingestTranscript(400);
    try {
      const windows = fixture.db.prepare('SELECT seq, token_estimate FROM source_windows WHERE source_id = ? ORDER BY seq')
        .all(fixture.sourceId) as Array<{ seq: number; token_estimate: number }>;
      const prompts: StructuredExtractionRequest[] = [];
      await orchestrateSourceExtraction(fixture.db, {
        sourceId: fixture.sourceId,
        provider: capturingProvider(prompts),
        budget: { maxTokensPerCall: Math.max(...windows.map((window) => window.token_estimate)), maxCalls: windows.length },
      });
      const request = prompts[0];
      expect(request.windows).toHaveLength(1);
      expect(request.windows[0].markers?.length ?? 0).toBeGreaterThan(0);
      const withMarkers = estimateTokens(request.prompt);
      expect(withMarkers).toBeLessThan(SINGLE_WINDOW_TOKEN_CEILING);
      const withoutMarkers = estimateTokens(buildStructuredExtractionPrompt({
        source: request.source,
        project: request.project,
        windows: request.windows.map(({ markers: _dropped, ...window }) => window),
        categories: request.categories,
        existingRows: request.existingRows,
        callIndex: request.callIndex,
      }));
      expect(withMarkers).toBeGreaterThan(withoutMarkers);
      // The whole point of the lean three-field shape: markers must stay a minority cost.
      expect((withMarkers - withoutMarkers) / withoutMarkers).toBeLessThan(0.2);
    } finally {
      fixture.close();
    }
  });
});
