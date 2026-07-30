import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import {
  FakeStructuredExtractionProvider,
  SOURCE_EXTRACTION_SKILL,
  SOURCE_INTELLIGENCE_CATEGORIES,
  assembleExtractionPrompt,
  buildStructuredExtractionPrompt,
  estimateTokens,
  parseStructuredExtractionOutput,
  sha256,
  type StructuredExtractionRequest,
} from '../src/extractionProvider';
import { createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import { PACKET_VERSION, freezePacketAndCreateChangeset, validatePacket } from '../src/sourceIntelligence';
import { orchestrateSourceExtraction } from '../src/sourcePipeline';
import {
  DEFAULT_EXTRACTION_SKILL_ID,
  PACKET_CONTRACT_VERSION,
  SKILL_REGISTRY_DIR_ENV,
  SkillRegistryError,
  compareSkillVersions,
  ensureSkillRegistrySynced,
  loadSkillRegistry,
  packetSkillProvenance,
  parseSkillRevision,
  pinProjectSkill,
  promoteSkillRevision,
  publicSkillProvenance,
  readActiveSkillRevision,
  readExtractionRunProvenance,
  readSkillAuditTrail,
  readSkillRevisions,
  recordExtractionRunProvenance,
  resolveSkillForRun,
  rollbackSkillRevision,
  syncSkillRegistry,
  unpinProjectSkill,
} from '../src/skillRegistry';

/* ------------------------------------------------------------------ fixtures */

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  delete process.env[SKILL_REGISTRY_DIR_ENV];
});

function temporaryDirectory(prefix = 'projectmanagair-skill-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function revisionFile(options: {
  directory: string;
  skillId?: string;
  version: string;
  promptTemplateVersion?: string;
  status?: string;
  notes?: string;
  body?: string;
  /** Written verbatim instead of the generated document, for malformed-revision cases. */
  raw?: string;
  /** Overrides the file name, for the "file disagrees with its front matter" case. */
  fileName?: string;
}): string {
  const skillId = options.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  const directory = path.join(options.directory, skillId);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, options.fileName ?? `${options.version}.md`);
  const document = options.raw ?? [
    '---',
    `skillId: ${skillId}`,
    `version: ${options.version}`,
    `promptTemplateVersion: ${options.promptTemplateVersion ?? 'source-extraction-prompt-v2'}`,
    `status: ${options.status ?? 'candidate'}`,
    `notes: ${options.notes ?? `Test revision ${options.version}.`}`,
    '---',
    options.body ?? `Test extraction skill ${options.version}. Emit exactly one JSON object and nothing else.`,
    '',
  ].join('\n');
  writeFileSync(file, document, 'utf8');
  return file;
}

interface Fixture {
  db: DatabaseSync;
  projectId: string;
  close: () => void;
}

async function openFixture(): Promise<Fixture> {
  const directory = temporaryDirectory();
  const projectsRoot = path.join(directory, 'Projects');
  mkdirSync(projectsRoot, { recursive: true });
  const context = openProjectManagairDatabase(path.join(directory, 'skills.db'));
  await updateStorageSettings(context.db, { projectsRoot });
  const project = createProject(context.db, {
    code: 'SKL',
    name: 'Skill Registry Fixture',
    customer: 'Synthetic Customer',
    description: 'Skill registry fixture.',
    status: 'on-track',
    owner: 'Tester',
  });
  return { db: context.db, projectId: project.projectId, close: () => context.db.close() };
}

function syntheticTranscript(turns: number): string {
  const speakers = ['Alex Reid', 'Jo Patel'];
  const cues = [
    "I'll check the isolation certificate register and confirm which permits are still open.",
    'Can you please send the updated commissioning schedule by end of week so we can plan resource.',
    'We need to add that to the risk register because the delay affects the energisation date.',
  ];
  const chatter = [
    'The commissioning pack came back from the subcontractor yesterday and most of it looks fine.',
    'We walked the north riser again and the cable tray brackets are still short by about two metres.',
  ];
  const stamp = (ms: number) => {
    const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const minutes = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
    const seconds = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}.000`;
  };
  const blocks = ['WEBVTT', ''];
  for (let index = 0; index < turns; index += 1) {
    const start = index * 9_000;
    const text = index % 5 === 0 ? cues[(index / 5) % cues.length] : chatter[index % chatter.length];
    blocks.push(`${stamp(start)} --> ${stamp(start + 8_500)}`);
    blocks.push(`<v ${speakers[index % speakers.length]}>${text}</v>`);
    blocks.push('');
  }
  return blocks.join('\n');
}

async function ingestSource(fixture: Fixture, turns = 40): Promise<string> {
  const intake = await intakeProjectSource(fixture.db, fixture.projectId, {
    name: 'synthetic-call.vtt',
    dataBase64: Buffer.from(syntheticTranscript(turns), 'utf8').toString('base64'),
  }) as unknown as { sourceId: string };
  return intake.sourceId;
}

/** A provider that never calls a model: it records the requests and returns valid coverage. */
function capturingProvider(requests: StructuredExtractionRequest[]) {
  return new FakeStructuredExtractionProvider((request) => {
    requests.push(request);
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

function promptInput() {
  return {
    source: {
      sourceId: 'SRCDOC-SKL-001',
      sourceType: 'vtt-transcript',
      originalFileName: 'synthetic-call.vtt',
      contentHash: 'a'.repeat(64),
      eventDate: '2026-01-02',
    },
    project: { projectId: 'skill-fixture', projectCode: 'SKL', baseRegisterRevision: 0 },
    windows: [{
      id: 'SRCDOC-SKL-001:window:001',
      seq: 1,
      startSeq: 1,
      endSeq: 2,
      tokenEstimate: 40,
      segments: [
        { seq: 1, text: "I'll confirm the isolation certificate with the site team today.", speaker: 'Alex Reid', tStartMs: 0 },
        { seq: 2, text: 'That works for us, thanks.', speaker: 'Jo Patel', tStartMs: 12_000 },
      ],
    }],
    categories: [...SOURCE_INTELLIGENCE_CATEGORIES],
    existingRows: [],
    callIndex: 1,
  };
}

/** The shape `insertRun` in sourcePipeline writes, plus the four columns migration 012 adds. */
function insertRun(db: DatabaseSync, input: {
  id: string;
  sourceId: string;
  projectId: string;
  providerId: string;
  modelLabel: string;
  skillSha256: string;
  promptSha256: string;
}): string {
  db.prepare(`INSERT INTO extraction_runs
    (id, source_id, project_id, stage, provider_id, model_label, skill_sha256, prompt_sha256, input_tokens, output_tokens, source_tokens, started_at, duration_ms, status, error, output_sha256)
    VALUES (?, ?, ?, 'structured-extraction', ?, ?, ?, ?, 10, 10, 10, ?, 1, 'completed', NULL, ?)`)
    .run(input.id, input.sourceId, input.projectId, input.providerId, input.modelLabel, input.skillSha256, input.promptSha256, new Date().toISOString(), sha256(input.id));
  return input.id;
}

/* ------------------------------------------------------------------ loading */

describe('skill revision loading', () => {
  it('loads the shipped seed revision from skills/ and it is the built-in skill byte for byte', () => {
    const assets = loadSkillRegistry({ externalDir: null });
    const seed = assets.find((asset) => asset.skillId === DEFAULT_EXTRACTION_SKILL_ID);
    expect(seed).toBeDefined();
    expect(seed!.source).toBe('seed');
    expect(seed!.version).toBe('2.0.0');
    expect(seed!.promptTemplateVersion).toBe('source-extraction-prompt-v2');
    expect(seed!.body).toBe(SOURCE_EXTRACTION_SKILL);
    expect(seed!.sha256).toBe(sha256(SOURCE_EXTRACTION_SKILL));
  });

  it('lets an external directory overlay a shipped revision and extend the set', () => {
    const externalDir = temporaryDirectory('projectmanagair-external-');
    revisionFile({ directory: externalDir, version: '2.0.0', body: 'Organisation override of the shipped revision.' });
    revisionFile({ directory: externalDir, version: '2.1.0', body: 'Organisation candidate revision.' });
    revisionFile({ directory: externalDir, skillId: 'private-skill', version: '1.0.0', body: 'A private skill held outside Git.' });

    const assets = loadSkillRegistry({ externalDir });
    const overlaid = assets.find((asset) => asset.skillId === DEFAULT_EXTRACTION_SKILL_ID && asset.version === '2.0.0')!;
    expect(overlaid.source).toBe('external');
    expect(overlaid.body).toBe('Organisation override of the shipped revision.');
    expect(overlaid.body).not.toBe(SOURCE_EXTRACTION_SKILL);
    expect(assets.some((asset) => asset.skillId === DEFAULT_EXTRACTION_SKILL_ID && asset.version === '2.1.0')).toBe(true);
    expect(assets.some((asset) => asset.skillId === 'private-skill')).toBe(true);
  });

  it('reads the external directory from the environment', () => {
    const externalDir = temporaryDirectory('projectmanagair-external-');
    revisionFile({ directory: externalDir, version: '3.0.0', body: 'Environment-supplied revision.' });
    process.env[SKILL_REGISTRY_DIR_ENV] = externalDir;
    expect(loadSkillRegistry().some((asset) => asset.version === '3.0.0')).toBe(true);
  });

  it('orders versions numerically, not lexically', () => {
    expect(compareSkillVersions('2.10.0', '2.9.0')).toBe(1);
    expect(compareSkillVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareSkillVersions('1.0.0', '10.0.0')).toBe(-1);
  });

  it.each([
    ['no front matter fence', { raw: 'Just a body with no front matter.\n' }, /front matter fence/],
    ['unclosed front matter', { raw: '---\nskillId: source-extraction\n' }, /never closed/],
    ['an unknown front matter key', { raw: '---\nskillId: source-extraction\nversion: 4.0.0\npromptTemplateVersion: source-extraction-prompt-v2\nstatus: draft\nnotes: n\nowner: nobody\n---\nbody\n' }, /Unknown front matter key/],
    ['a missing key', { raw: '---\nskillId: source-extraction\nversion: 4.0.0\nstatus: draft\nnotes: n\n---\nbody\n' }, /missing "promptTemplateVersion"/],
    ['an unorderable version', { raw: '---\nskillId: source-extraction\nversion: 4\npromptTemplateVersion: source-extraction-prompt-v2\nstatus: draft\nnotes: n\n---\nbody\n' }, /major\.minor\.patch/],
    ['an unknown status', { status: 'shipped' }, /status "shipped"/],
    ['an empty body', { body: '   ' }, /body is empty/],
  ])('fails loudly on %s rather than skipping the revision', (_label, options, matcher) => {
    const externalDir = temporaryDirectory('projectmanagair-external-');
    revisionFile({ directory: externalDir, version: '2.5.0', body: 'A perfectly good sibling revision.' });
    revisionFile({ directory: externalDir, version: '4.0.0', ...(options as Record<string, string>) });
    // The whole load fails: a malformed revision is never quietly dropped, because dropping it
    // would silently change which contract the next run is graded against.
    expect(() => loadSkillRegistry({ externalDir })).toThrow(SkillRegistryError);
    expect(() => loadSkillRegistry({ externalDir })).toThrow(matcher as RegExp);
  });

  it('rejects a revision whose file name disagrees with its declared version', () => {
    const externalDir = temporaryDirectory('projectmanagair-external-');
    revisionFile({ directory: externalDir, version: '5.0.0', fileName: '5.0.1.md' });
    expect(() => loadSkillRegistry({ externalDir })).toThrow(/File name must be "5\.0\.0\.md"/);
  });

  it('names the offending file without quoting its body', () => {
    const externalDir = temporaryDirectory('projectmanagair-external-');
    const file = revisionFile({ directory: externalDir, version: '6.0.0', status: 'shipped', body: 'CONFIDENTIAL ORGANISATION CONTRACT TEXT' });
    try {
      parseSkillRevision('---\nskillId: source-extraction\nversion: 6.0.0\npromptTemplateVersion: p\nstatus: shipped\nnotes: n\n---\nCONFIDENTIAL ORGANISATION CONTRACT TEXT\n', file, 'external');
      throw new Error('expected a SkillRegistryError');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillRegistryError);
      expect((error as Error).message).toContain(file);
      expect((error as Error).message).not.toContain('CONFIDENTIAL');
    }
  });
});

/* ------------------------------------------------------------------ registration and lifecycle */

describe('registration and lifecycle', () => {
  it('registers the seed revision and bootstraps exactly one active revision, audited', async () => {
    const fixture = await openFixture();
    try {
      const result = syncSkillRegistry(fixture.db, { externalDir: null });
      expect(result.registered.some((entry) => entry.version === '2.0.0')).toBe(true);
      expect(result.bootstrapped).toEqual([{ skillId: DEFAULT_EXTRACTION_SKILL_ID, version: '2.0.0' }]);

      const active = readActiveSkillRevision(fixture.db)!;
      expect(active.version).toBe('2.0.0');
      expect(active.promotedAt).not.toBeNull();
      const events = readSkillAuditTrail(fixture.db, { skillId: DEFAULT_EXTRACTION_SKILL_ID });
      expect(events.map((entry) => entry.event)).toContain('registered');
      expect(events.find((entry) => entry.event === 'promoted')?.actor).toBe('registry-bootstrap');

      // Re-syncing is idempotent and does not touch the lifecycle.
      const again = syncSkillRegistry(fixture.db, { externalDir: null });
      expect(again.registered).toHaveLength(0);
      expect(again.bootstrapped).toHaveLength(0);
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.0.0');
    } finally {
      fixture.close();
    }
  });

  it('ensures a contract is in force without ever displacing a promotion decision', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Candidate body.' });
      expect(ensureSkillRegistrySynced(fixture.db, { externalDir })).not.toBeNull();
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.0.0');

      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      // A restart must not walk the promotion back.
      expect(ensureSkillRegistrySynced(fixture.db, { externalDir })).toBeNull();
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.1.0');
    } finally {
      fixture.close();
    }
  });

  it('records a file that declares itself active as a candidate when an active revision exists', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      syncSkillRegistry(fixture.db, { externalDir: null });
      revisionFile({ directory: externalDir, version: '2.1.0', status: 'active', body: 'A revision that would like to promote itself.' });
      syncSkillRegistry(fixture.db, { externalDir });
      const rows = readSkillRevisions(fixture.db, DEFAULT_EXTRACTION_SKILL_ID);
      expect(rows.find((row) => row.version === '2.1.0')!.status).toBe('candidate');
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.0.0');
    } finally {
      fixture.close();
    }
  });

  it('refuses a revision that was rewritten in place under the same version', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'First body.' });
      syncSkillRegistry(fixture.db, { externalDir });
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Silently different body.' });
      expect(() => syncSkillRegistry(fixture.db, { externalDir })).toThrow(/rewritten in place/);
    } finally {
      fixture.close();
    }
  });

  it('enforces at most one active revision per skill id in the database', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Candidate body.' });
      syncSkillRegistry(fixture.db, { externalDir });
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.0.0');

      // The constraint, not the application code, is what refuses this.
      expect(() => fixture.db.prepare("UPDATE extraction_skills SET status = 'active' WHERE skill_id = ? AND version = '2.1.0'").run(DEFAULT_EXTRACTION_SKILL_ID))
        .toThrow(/UNIQUE|constraint/i);
      expect(() => fixture.db.prepare(`INSERT INTO extraction_skills (skill_id, version, sha256, prompt_template_version, status, source, notes, created_at)
        VALUES (?, '9.9.9', 'x', 'source-extraction-prompt-v2', 'active', 'external', 'forged', '2026-01-01T00:00:00.000Z')`).run(DEFAULT_EXTRACTION_SKILL_ID))
        .toThrow(/UNIQUE|constraint/i);

      // A different skill id may of course have its own active revision.
      fixture.db.prepare(`INSERT INTO extraction_skills (skill_id, version, sha256, prompt_template_version, status, source, notes, created_at)
        VALUES ('other-skill', '1.0.0', 'y', 'source-extraction-prompt-v2', 'active', 'external', 'unrelated', '2026-01-01T00:00:00.000Z')`).run();
      expect(readActiveSkillRevision(fixture.db, 'other-skill')!.version).toBe('1.0.0');
    } finally {
      fixture.close();
    }
  });

  it('promotes a candidate, retires the previous active revision and records both timestamps', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Candidate body.' });
      syncSkillRegistry(fixture.db, { externalDir });

      const promotion = promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick', note: 'Benchmarked on the July sources.' });
      expect(promotion).toMatchObject({ version: '2.1.0', previousActiveVersion: '2.0.0', changed: true });

      const rows = readSkillRevisions(fixture.db, DEFAULT_EXTRACTION_SKILL_ID);
      const previous = rows.find((row) => row.version === '2.0.0')!;
      const current = rows.find((row) => row.version === '2.1.0')!;
      expect(previous.status).toBe('retired');
      expect(previous.retiredAt).not.toBeNull();
      expect(current.status).toBe('active');
      expect(current.promotedAt).not.toBeNull();
      expect(current.retiredAt).toBeNull();

      const events = readSkillAuditTrail(fixture.db, { skillId: DEFAULT_EXTRACTION_SKILL_ID });
      const promoted = events.find((entry) => entry.event === 'promoted' && entry.version === '2.1.0')!;
      expect(promoted).toMatchObject({ actor: 'warwick', toStatus: 'active', note: 'Benchmarked on the July sources.' });
      expect(events.find((entry) => entry.event === 'retired' && entry.version === '2.0.0')).toMatchObject({ fromStatus: 'active', toStatus: 'retired', actor: 'warwick' });

      // Promoting the revision that is already active is a no-op, not a second audit entry.
      const repeat = promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      expect(repeat.changed).toBe(false);
      expect(readSkillAuditTrail(fixture.db, { skillId: DEFAULT_EXTRACTION_SKILL_ID }).filter((entry) => entry.event === 'promoted' && entry.version === '2.1.0')).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('rolls back to a named prior version, audited, and refuses a version that was never active', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Candidate body.' });
      revisionFile({ directory: externalDir, version: '2.2.0', body: 'Never promoted body.' });
      syncSkillRegistry(fixture.db, { externalDir });
      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });

      const rollback = rollbackSkillRevision(fixture.db, { toVersion: '2.0.0', actor: 'warwick', note: 'Recall quality regressed.' });
      expect(rollback).toMatchObject({ version: '2.0.0', previousActiveVersion: '2.1.0', changed: true });
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.0.0');
      expect(readSkillRevisions(fixture.db, DEFAULT_EXTRACTION_SKILL_ID).find((row) => row.version === '2.1.0')!.status).toBe('retired');
      expect(readSkillAuditTrail(fixture.db, { skillId: DEFAULT_EXTRACTION_SKILL_ID }).find((entry) => entry.event === 'rolled-back')).toMatchObject({ version: '2.0.0', actor: 'warwick', note: 'Recall quality regressed.' });

      expect(() => rollbackSkillRevision(fixture.db, { toVersion: '2.2.0', actor: 'warwick' })).toThrow(/never been active/);
      expect(() => promoteSkillRevision(fixture.db, { version: '2.1.0', actor: '  ' })).toThrow(/named actor/);
    } finally {
      fixture.close();
    }
  });

  it('keeps the audit trail append-only', async () => {
    const fixture = await openFixture();
    try {
      syncSkillRegistry(fixture.db, { externalDir: null });
      expect(() => fixture.db.prepare('DELETE FROM extraction_skill_events').run()).toThrow(/append-only/);
      expect(() => fixture.db.prepare("UPDATE extraction_skill_events SET actor = 'someone else'").run()).toThrow(/append-only/);
    } finally {
      fixture.close();
    }
  });
});

/* ------------------------------------------------------------------ resolution and pinning */

describe('resolution and pinning', () => {
  it('resolves the active revision with full provenance and never leaks the body into the public projection', async () => {
    const fixture = await openFixture();
    try {
      syncSkillRegistry(fixture.db, { externalDir: null });
      const resolved = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null });
      expect(resolved).toMatchObject({
        skillId: DEFAULT_EXTRACTION_SKILL_ID,
        version: '2.0.0',
        sha256: sha256(SOURCE_EXTRACTION_SKILL),
        promptTemplateVersion: 'source-extraction-prompt-v2',
        status: 'active',
        source: 'seed',
        pinned: false,
        packetContractVersion: PACKET_CONTRACT_VERSION,
      });
      expect(resolved.text).toBe(SOURCE_EXTRACTION_SKILL);
      expect(publicSkillProvenance(resolved)).not.toHaveProperty('text');
      expect(JSON.stringify(publicSkillProvenance(resolved))).not.toContain('OUTPUT');
    } finally {
      fixture.close();
    }
  });

  it('refuses to resolve when nothing has been registered', async () => {
    const fixture = await openFixture();
    try {
      expect(() => resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null })).toThrow(/No active revision is registered/);
    } finally {
      fixture.close();
    }
  });

  it('lets a project pin override the active revision, and unpinning restore it', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Pinned candidate body.' });
      syncSkillRegistry(fixture.db, { externalDir });
      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      expect(resolveSkillForRun(fixture.db, fixture.projectId, { externalDir }).version).toBe('2.1.0');

      pinProjectSkill(fixture.db, { projectId: fixture.projectId, version: '2.0.0', actor: 'warwick', note: 'Customer is mid-audit.' });
      const pinned = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir });
      expect(pinned).toMatchObject({ version: '2.0.0', pinned: true, pinnedBy: 'warwick', status: 'retired' });
      expect(pinned.text).toBe(SOURCE_EXTRACTION_SKILL);
      // The pin is a project-level override; the registry-wide active revision is untouched.
      expect(readActiveSkillRevision(fixture.db)!.version).toBe('2.1.0');

      const unpinned = unpinProjectSkill(fixture.db, { projectId: fixture.projectId, actor: 'warwick' });
      expect(unpinned).toEqual({ changed: true, previousVersion: '2.0.0' });
      expect(resolveSkillForRun(fixture.db, fixture.projectId, { externalDir }).version).toBe('2.1.0');
      expect(unpinProjectSkill(fixture.db, { projectId: fixture.projectId, actor: 'warwick' })).toEqual({ changed: false, previousVersion: null });

      const events = readSkillAuditTrail(fixture.db, { projectId: fixture.projectId });
      expect(events.map((entry) => entry.event).sort()).toEqual(['pinned', 'unpinned']);
    } finally {
      fixture.close();
    }
  });

  it('refuses to resolve a revision whose file has been rewritten since it was registered', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Registered body.' });
      syncSkillRegistry(fixture.db, { externalDir });
      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Body swapped after registration.' });
      expect(() => resolveSkillForRun(fixture.db, fixture.projectId, { externalDir })).toThrow(/rewritten in place/);
    } finally {
      fixture.close();
    }
  });
});

/* ------------------------------------------------------------------ prompt template */

describe('prompt template versioning', () => {
  it('assembles a byte-identical prompt and the same prompt_sha256 across repeated calls', async () => {
    const fixture = await openFixture();
    try {
      syncSkillRegistry(fixture.db, { externalDir: null });
      const input = promptInput();
      const first = assembleExtractionPrompt(input, resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null }));
      const second = assembleExtractionPrompt(promptInput(), resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null }));
      const third = assembleExtractionPrompt(input, resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null }));
      expect(second.prompt).toBe(first.prompt);
      expect(third.prompt).toBe(first.prompt);
      expect(second.promptSha256).toBe(first.promptSha256);
      expect(first.promptSha256).toBe(sha256(first.prompt));
      expect(first).toMatchObject({
        skillId: DEFAULT_EXTRACTION_SKILL_ID,
        skillVersion: '2.0.0',
        skillSha256: sha256(SOURCE_EXTRACTION_SKILL),
        promptTemplateVersion: 'source-extraction-prompt-v2',
        packetContractVersion: PACKET_CONTRACT_VERSION,
      });
    } finally {
      fixture.close();
    }
  });

  it('changes the prompt when the skill changes and not when it does not', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'A materially different instruction set.' });
      syncSkillRegistry(fixture.db, { externalDir });
      const onSeed = assembleExtractionPrompt(promptInput(), resolveSkillForRun(fixture.db, fixture.projectId, { externalDir }));
      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      const onCandidate = assembleExtractionPrompt(promptInput(), resolveSkillForRun(fixture.db, fixture.projectId, { externalDir }));
      expect(onCandidate.prompt).not.toBe(onSeed.prompt);
      expect(onCandidate.promptSha256).not.toBe(onSeed.promptSha256);
      expect(onCandidate.prompt.startsWith('A materially different instruction set.')).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('refuses a template version this build does not implement', () => {
    expect(() => buildStructuredExtractionPrompt(promptInput(), 'skill text', 'source-extraction-prompt-v99'))
      .toThrow(/Unknown prompt template version/);
  });

  it('records the packet contract version the pipeline actually freezes against', () => {
    expect(PACKET_CONTRACT_VERSION).toBe(PACKET_VERSION);
  });
});

/* ------------------------------------------------------------------ provenance */

describe('run provenance', () => {
  it('records skill id, version, hash, template version, prompt hash, provider, model and packet contract version', async () => {
    const fixture = await openFixture();
    try {
      syncSkillRegistry(fixture.db, { externalDir: null });
      const sourceId = await ingestSource(fixture);
      const requests: StructuredExtractionRequest[] = [];
      const result = await orchestrateSourceExtraction(fixture.db, { sourceId, provider: capturingProvider(requests) });
      expect(result.runs.length).toBeGreaterThan(0);

      // Exactly the wiring sourcePipeline.insertRun will carry.
      const resolved = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir: null });
      for (const runId of result.runs) {
        recordExtractionRunProvenance(fixture.db, runId, {
          skillId: resolved.skillId,
          skillVersion: resolved.version,
          promptTemplateVersion: resolved.promptTemplateVersion,
          packetContractVersion: resolved.packetContractVersion,
        });
      }

      const provenance = readExtractionRunProvenance(fixture.db, result.runs[0])!;
      expect(provenance).toMatchObject({
        skillId: DEFAULT_EXTRACTION_SKILL_ID,
        skillVersion: '2.0.0',
        skillSha256: sha256(SOURCE_EXTRACTION_SKILL),
        promptTemplateVersion: 'source-extraction-prompt-v2',
        providerId: 'fake-structured-provider',
        modelLabel: 'synthetic-test-output-v1',
        packetContractVersion: PACKET_CONTRACT_VERSION,
      });
      expect(provenance.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(provenance.promptSha256).toBe(sha256(requests[0].prompt));
      for (const value of Object.values(provenance)) expect(value === null || value === '' || value === 0).toBe(false);

      expect(() => recordExtractionRunProvenance(fixture.db, 'extract:nope', { skillId: 'x', skillVersion: '1.0.0', promptTemplateVersion: 'p', packetContractVersion: 1 }))
        .toThrow(/does not exist/);
    } finally {
      fixture.close();
    }
  });

  it('evaluates one frozen source under two skill versions without overwriting either record', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({ directory: externalDir, version: '2.1.0', body: 'Candidate revision under benchmark.' });
      syncSkillRegistry(fixture.db, { externalDir });
      const sourceId = await ingestSource(fixture);

      // Pass one, on the active revision, through the real pipeline and a fake provider.
      const firstRequests: StructuredExtractionRequest[] = [];
      const first = await orchestrateSourceExtraction(fixture.db, { sourceId, provider: capturingProvider(firstRequests) });
      const firstResolved = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir });
      for (const runId of first.runs) recordExtractionRunProvenance(fixture.db, runId, { skillId: firstResolved.skillId, skillVersion: firstResolved.version, promptTemplateVersion: firstResolved.promptTemplateVersion, packetContractVersion: firstResolved.packetContractVersion });
      expect(firstResolved.version).toBe('2.0.0');

      // The pipeline refuses to re-extract a source that already has a frozen packet, so a
      // re-evaluation is a separate pass over the same frozen evidence rather than a re-run.
      const secondAttempt = await orchestrateSourceExtraction(fixture.db, { sourceId, provider: capturingProvider([]) });
      expect(secondAttempt.alreadyFrozen).toBe(true);
      expect(secondAttempt.runs).toEqual([]);

      // Pass two, on the candidate revision.
      promoteSkillRevision(fixture.db, { version: '2.1.0', actor: 'warwick' });
      const secondResolved = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir });
      expect(secondResolved.version).toBe('2.1.0');
      const packetRow = fixture.db.prepare('SELECT id, packet_json, packet_sha256 FROM extraction_packets WHERE id = ?').get(String(first.packetId)) as Record<string, unknown>;
      const packet = JSON.parse(String(packetRow.packet_json)) as { execution: { runs: string[] } };

      const documentId = String((fixture.db.prepare('SELECT id FROM source_documents WHERE project_id = ?').get(fixture.projectId) as { id: string }).id);
      const assembled = assembleExtractionPrompt(promptInput(), secondResolved);
      const secondRunId = insertRun(fixture.db, {
        id: 'extract:candidate-pass:0001',
        sourceId: documentId,
        projectId: fixture.projectId,
        providerId: 'fake-structured-provider',
        modelLabel: 'synthetic-test-output-v1',
        skillSha256: assembled.skillSha256,
        promptSha256: assembled.promptSha256,
      });
      recordExtractionRunProvenance(fixture.db, secondRunId, { skillId: assembled.skillId, skillVersion: assembled.skillVersion, promptTemplateVersion: assembled.promptTemplateVersion, packetContractVersion: assembled.packetContractVersion });
      packet.execution.runs = [secondRunId];
      const secondFreeze = freezePacketAndCreateChangeset(fixture.db, packet);

      // Two packets over one frozen source, keyed apart, neither overwriting the other.
      expect(secondFreeze.packetId).not.toBe(String(first.packetId));
      expect(secondFreeze.packetHash).not.toBe(String(first.packetHash));
      const packets = fixture.db.prepare('SELECT id FROM extraction_packets WHERE source_id = ? ORDER BY id').all(documentId) as Array<{ id: string }>;
      expect(packets).toHaveLength(2);
      expect(fixture.db.prepare('SELECT packet_json FROM extraction_packets WHERE id = ?').get(String(first.packetId))).toEqual({ packet_json: String(packetRow.packet_json) });

      // Two distinct provenance records, one per skill version.
      const firstProvenance = readExtractionRunProvenance(fixture.db, first.runs[0])!;
      const secondProvenance = readExtractionRunProvenance(fixture.db, secondRunId)!;
      expect(firstProvenance.skillVersion).toBe('2.0.0');
      expect(secondProvenance.skillVersion).toBe('2.1.0');
      expect(secondProvenance.skillSha256).not.toBe(firstProvenance.skillSha256);
      expect(secondProvenance.promptSha256).not.toBe(firstProvenance.promptSha256);

      // The packet-level provenance columns exist and must be written at INSERT time: a frozen
      // packet cannot be completed afterwards.
      expect(packetSkillProvenance(fixture.db, [secondRunId])).toEqual({ skillId: DEFAULT_EXTRACTION_SKILL_ID, skillVersion: '2.1.0', promptTemplateVersion: 'source-extraction-prompt-v2' });
      expect(() => fixture.db.prepare('UPDATE extraction_packets SET skill_version = ? WHERE id = ?').run('2.1.0', secondFreeze.packetId))
        .toThrow(/frozen artefacts/);
    } finally {
      fixture.close();
    }
  });
});

/* ------------------------------------------------------------------ the safety boundary */

describe('the safety contract is not registry controlled', () => {
  it('cannot widen the accepted row schema, however the revision is worded', async () => {
    const fixture = await openFixture();
    const externalDir = temporaryDirectory('projectmanagair-external-');
    try {
      revisionFile({
        directory: externalDir,
        version: '9.9.9',
        body: 'Row keys now include an extra "topic" key on every row, which the system accepts.',
      });
      syncSkillRegistry(fixture.db, { externalDir });
      promoteSkillRevision(fixture.db, { version: '9.9.9', actor: 'warwick', note: 'A revision that claims more than the validator allows.' });
      const resolved = resolveSkillForRun(fixture.db, fixture.projectId, { externalDir });
      const assembled = assembleExtractionPrompt(promptInput(), resolved);
      // The claim really is in the prompt: the registry did change what we ask for.
      expect(assembled.prompt).toContain('extra "topic" key');

      const row = {
        client_ref: 'Actions-1',
        op: 'add',
        target_id: null,
        proposed_id: '$ALLOC',
        title: 'Confirm the isolation certificate',
        summary: 'Alex will confirm the isolation certificate with the site team.',
        status: null,
        record_type: null,
        owner: null,
        due_date_raw: null,
        source_ref: 'SRCDOC-SKL-001',
        related_refs: [],
        supersedes: [],
        anchors: [{ segment_seq: 1, speaker: null, t_ms: null, quote: "I'll confirm the isolation certificate with the site team today." }],
        derivation: 'fact',
        reasoning: null,
        confidence: 'high',
        discharges_markers: [],
        details: {},
        topic: 'isolation',
      };

      // Provider-output validation rejects it.
      expect(() => parseStructuredExtractionOutput({
        rows: [{ registerName: 'Actions', row }],
        windowCoverage: [{ key: '1', status: 'reviewed', itemCount: 1, explanation: null }],
        categoryCoverage: [{ key: 'Actions', status: 'populated', itemCount: 1, explanation: null }],
      }, { providerId: 'fake-structured-provider' })).toThrow(/validation/i);

      // And so does the canonical packet schema, which never reads the registry at all.
      const sheets = Object.fromEntries(SOURCE_INTELLIGENCE_CATEGORIES.map((category) => [category, { rows: category === 'Actions' ? [row] : [] }]));
      const verdict = validatePacket(fixture.db, {
        packet_type: 'project_register_delta',
        packet_version: PACKET_VERSION,
        project_code: 'SKL',
        base_register_revision: 0,
        source: { source_id: 'SRCDOC-SKL-001', content_hash: 'a'.repeat(64), source_type: 'vtt-transcript', original_file_name: 'synthetic-call.vtt', event_date: null, duration_ms: null, participants: [] },
        sheets,
        coverage: { windows: [], categories: [] },
        execution: { runs: ['extract:none'] },
      });
      expect(verdict.packet).toBeNull();
      expect(verdict.verdict).toBe('quarantined');
      expect(verdict.issues.some((issue) => issue.rule === 'schema-strict' && /topic/.test(issue.message))).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
