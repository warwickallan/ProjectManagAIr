/**
 * Versioned extraction skill registry.
 *
 * THE BOUNDARY THIS MODULE DEFENDS
 * --------------------------------
 * A skill revision can change **what we ask the model for**. It can never change
 * **what we accept back**.
 *
 * Registry-governed (data, revisable without a code change):
 *   - the instructional text sent to the provider (the "skill");
 *   - which revision is in force for a project, and when it changed.
 *
 * NOT registry-governed (code, and deliberately unreachable from here):
 *   - the strict canonical packet schema (`packetRowSchema` / `packetSchema` in
 *     `sourceIntelligence.ts`, `structuredExtractionOutputSchema` in `extractionProvider.ts`);
 *   - source coverage, anchor and evidence rules, quote verification;
 *   - packet validation, reconciliation, human review, deterministic replay.
 *
 * So a revision that *claims* an extra row key is allowed does not make that row
 * acceptable: the validator never reads the registry. Everything the registry can
 * touch is instructional; everything that protects the register is compiled in.
 *
 * PRIVACY
 * -------
 * A revision body loaded from the external registry directory is customer-adjacent.
 * It is read into memory to build the prompt and hashed; it is never written to the
 * database, never logged, never put in an error message and never returned from an
 * API response. Only `skillId`, `version`, `sha256`, `promptTemplateVersion`,
 * `status`, `source`, `notes` and timestamps are persisted — see
 * {@link publicSkillProvenance} for the shape that is safe to serve.
 *
 * LIFECYCLE
 * ---------
 * draft → candidate → active → retired, plus per-project pins. Every transition is
 * an explicit call that writes a row to `extraction_skill_events`; nothing here
 * promotes a revision as a side effect of loading it, except the one audited
 * bootstrap of a skill id that has no active revision at all.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

/* ------------------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------------------ */

/** The skill id every extraction pass resolves unless a caller names another. */
export const DEFAULT_EXTRACTION_SKILL_ID = 'source-extraction';

/** Directory holding private revisions outside Git. Overlays and extends `skills/`. */
export const SKILL_REGISTRY_DIR_ENV = 'PROJECTMANAGAIR_SKILL_REGISTRY_DIR';

/**
 * The packet contract the registry records against a run.
 *
 * Deliberately duplicated rather than imported from `sourceIntelligence.ts`: importing it
 * would close the cycle skillRegistry → sourceIntelligence → extractionProvider → skillRegistry
 * and leave a `const` in the temporal dead zone at module init. `tests/skillRegistry.test.ts`
 * asserts the two stay equal, which is the cheap half of the trade.
 */
export const PACKET_CONTRACT_VERSION = 1;

/** Version recorded when the legacy single-file skill override is in force. */
export const LEGACY_FILE_SKILL_VERSION = '0.0.0-external-file';

export const SKILL_STATUSES = ['draft', 'candidate', 'active', 'retired'] as const;
export type SkillStatus = typeof SKILL_STATUSES[number];

export const SKILL_SOURCES = ['seed', 'external'] as const;
export type SkillSource = typeof SKILL_SOURCES[number];

export const SKILL_EVENTS = ['registered', 'refreshed', 'promoted', 'retired', 'rolled-back', 'pinned', 'unpinned'] as const;
export type SkillEvent = typeof SKILL_EVENTS[number];

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The shipped seed directory: versioned data assets committed to the repository. */
export const SEED_SKILL_DIR = path.join(repoRoot, 'skills');

/**
 * Where an uploaded draft is written when no external registry directory is
 * configured.
 *
 * Never the seed directory. `skills/` is tracked by Git, and an uploaded
 * revision is written by an operator who may legitimately paste organisation- or
 * customer-specific guidance into it. `/.runtime/` is git-ignored, so an upload
 * cannot leak into a commit by accident.
 */
export const DEFAULT_UPLOAD_SKILL_DIR = path.join(repoRoot, '.runtime', 'skills');

/**
 * The directory an upload writes to: the configured external registry directory
 * when there is one, otherwise the git-ignored local runtime directory.
 */
export function resolveWritableSkillDir(options: LoadSkillRegistryOptions = {}): string {
  const env = options.env ?? process.env;
  const external = options.externalDir !== undefined ? options.externalDir : (env[SKILL_REGISTRY_DIR_ENV] ?? '').trim() || null;
  return external ?? (options.uploadDir ?? DEFAULT_UPLOAD_SKILL_DIR);
}

/**
 * Which code path actually resolves each skill id.
 *
 * Deliberately compiled in rather than declared in a revision: a revision must
 * never be able to claim it is in force somewhere it is not. A skill id absent
 * from this map is registered, versioned and inspectable but nothing reads it —
 * and the UI says exactly that instead of implying the model is using it.
 */
export const SKILL_CONSUMERS: Readonly<Record<string, string>> = Object.freeze({
  'source-extraction': 'Structured extraction pass over each source window.',
  'consultant-brief': 'On-demand consultant synthesis for Meeting Brief and Needs Warwick.',
  'consultant-reasoning': 'Bounded reasoning pass over the complete approved register state, on explicit Generate or Refresh.',
});

/** Maximum size of an uploaded revision. A skill is instructions, not a corpus. */
export const MAX_SKILL_UPLOAD_BYTES = 256 * 1024;

/* ------------------------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------------------------ */

/**
 * Every registry failure is this type and every one of them is loud. A malformed
 * revision is never skipped: skipping it would silently change which contract a
 * run is graded against, which is the exact failure the registry exists to stop.
 */
export class SkillRegistryError extends Error {
  readonly file: string | null;

  constructor(message: string, file: string | null = null) {
    super(file ? `${message} (${file})` : message);
    this.name = 'SkillRegistryError';
    this.file = file;
  }
}

/* ------------------------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------------------------ */

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Ordered version scheme: three numeric components, compared numerically, never lexically. */
export function parseSkillVersion(value: string): [number, number, number] {
  if (!VERSION_PATTERN.test(value)) {
    throw new SkillRegistryError(`Skill version "${value}" is not major.minor.patch`);
  }
  const [major, minor, patch] = value.split('.').map((part) => Number.parseInt(part, 10));
  return [major, minor, patch];
}

export function compareSkillVersions(left: string, right: string): number {
  const a = parseSkillVersion(left);
  const b = parseSkillVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------------------------ *
 * Revision files
 * ------------------------------------------------------------------------------------ */

export interface SkillRevisionFrontMatter {
  skillId: string;
  version: string;
  promptTemplateVersion: string;
  status: SkillStatus;
  notes: string;
  /** Human-readable label. Falls back to a title-cased skill id when absent. */
  name: string;
  /** One sentence on what this skill is for, shown in Settings. */
  purpose: string | null;
  /** Set only where a revision is written for one provider family. */
  providerProfile: string | null;
}

export interface SkillRevisionAsset extends SkillRevisionFrontMatter {
  /** The instructional text actually sent to the provider. Never persisted. */
  body: string;
  /** sha256 of `body` — this is what lands in `extraction_runs.skill_sha256`. */
  sha256: string;
  source: SkillSource;
  /** Absolute path of the file this revision was read from. */
  file: string;
  characters: number;
}

const REQUIRED_KEYS = ['skillId', 'version', 'promptTemplateVersion', 'status', 'notes'] as const;

/**
 * Optional front matter. Presentation and routing metadata only: nothing here
 * can change what the validator accepts, which is the whole point of the
 * registry boundary.
 */
const OPTIONAL_KEYS = ['name', 'purpose', 'providerProfile'] as const;
const KNOWN_KEYS: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

/** `source-extraction` → `Source Extraction`, used when a revision names no label. */
function titleCaseSkillId(skillId: string): string {
  return skillId.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

/**
 * Parse one revision file: `---` fenced `key: value` front matter, then the body.
 *
 * Deliberately not YAML. The front matter is a fixed five-key record with scalar values,
 * so a hand-rolled parser that rejects everything it does not understand is both smaller
 * and stricter than a YAML dependency that would happily accept anchors, nesting and
 * type coercion into a field that decides which contract a model is graded against.
 */
export function parseSkillRevision(text: string, file: string, source: SkillSource): SkillRevisionAsset {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new SkillRegistryError('Skill revision must open with a "---" front matter fence', file);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) throw new SkillRegistryError('Skill revision front matter is never closed with "---"', file);

  const values = new Map<string, string>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 0) throw new SkillRegistryError(`Front matter line ${index + 1} is not "key: value"`, file);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) throw new SkillRegistryError(`Front matter line ${index + 1} has an empty key`, file);
    if (values.has(key)) throw new SkillRegistryError(`Front matter key "${key}" appears more than once`, file);
    if (!KNOWN_KEYS.includes(key)) {
      throw new SkillRegistryError(`Unknown front matter key "${key}"; expected one of ${KNOWN_KEYS.join(', ')}`, file);
    }
    values.set(key, value);
  }
  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) throw new SkillRegistryError(`Front matter is missing "${key}"`, file);
  }

  const skillId = values.get('skillId')!;
  const version = values.get('version')!;
  const promptTemplateVersion = values.get('promptTemplateVersion')!;
  const status = values.get('status')!;
  const notes = values.get('notes')!;

  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
    throw new SkillRegistryError(`skillId "${skillId}" must be lower-case kebab-case`, file);
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new SkillRegistryError(`version "${version}" is not major.minor.patch`, file);
  }
  if (!promptTemplateVersion) throw new SkillRegistryError('promptTemplateVersion is empty', file);
  if (!(SKILL_STATUSES as readonly string[]).includes(status)) {
    throw new SkillRegistryError(`status "${status}" is not one of ${SKILL_STATUSES.join(', ')}`, file);
  }
  if (!notes) throw new SkillRegistryError('notes is empty; a revision must say why it exists', file);

  // The path is part of the contract, so a file that disagrees with its own front matter
  // is malformed rather than merely untidy: `skills/<skillId>/<version>.md`.
  const expectedFile = `${version}.md`;
  if (path.basename(file) !== expectedFile) {
    throw new SkillRegistryError(`File name must be "${expectedFile}" to match its declared version`, file);
  }
  if (path.basename(path.dirname(file)) !== skillId) {
    throw new SkillRegistryError(`Parent directory must be "${skillId}" to match its declared skillId`, file);
  }

  const body = lines.slice(closing + 1).join('\n').trim();
  if (!body) throw new SkillRegistryError('Skill revision body is empty; there is no contract to hash', file);

  return {
    skillId,
    version,
    promptTemplateVersion,
    status: status as SkillStatus,
    notes,
    name: values.get('name')?.trim() || titleCaseSkillId(skillId),
    purpose: values.get('purpose')?.trim() || null,
    providerProfile: values.get('providerProfile')?.trim() || null,
    body,
    sha256: sha256(body),
    source,
    file,
    characters: body.length,
  };
}

/* ------------------------------------------------------------------------------------ *
 * Draft validation and upload
 * ------------------------------------------------------------------------------------ */

/**
 * Placeholders a revision of a given prompt template must still contain.
 *
 * A revision may rewrite the guidance completely; it may not silently delete the
 * hooks the prompt assembler needs, because the result would be a prompt that
 * omits the source, the categories or the output contract and a pass that fails
 * for a reason nobody can see from the registry.
 *
 * These are substrings, matched case-insensitively, deliberately chosen to be
 * things the instructions genuinely have to say rather than templating syntax.
 */
export const REQUIRED_SKILL_MARKERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'source-extraction-prompt-v2': ['rows', 'windowCoverage', 'categoryCoverage', 'anchors', 'client_ref'],
  'consultant-brief-prompt-v1': ['markdown', 'cite'],
  // The reasoning contract's load-bearing vocabulary: a revision that stops
  // naming its matters, its sections or its citation requirement has stopped
  // being a revision of this skill.
  'consultant-reasoning-prompt-v1': ['matters', 'supporting_register_ids', 'meeting_order', 'executive_summary'],
});

export interface SkillDraftValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Present only when the document parsed; null when it did not. */
  frontMatter: (SkillRevisionFrontMatter & { sha256: string; characters: number }) | null;
}

export interface ValidateSkillDraftInput {
  text: string;
  /** Original upload file name, used only to report a mismatch back to the operator. */
  fileName?: string | null;
  /** The skill id the operator believes they are uploading a revision of. */
  expectedSkillId?: string | null;
  currentPacketContractVersion?: number;
}

/**
 * Validate an uploaded revision without writing anything.
 *
 * Everything the upload route enforces is enforced here, so "Validate draft" in
 * the UI and the upload itself can never disagree about whether a document is
 * acceptable.
 */
export function validateSkillDraft(db: DatabaseSync, input: ValidateSkillDraftInput): SkillDraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = input.text ?? '';

  if (!text.trim()) return { ok: false, errors: ['The uploaded document is empty.'], warnings, frontMatter: null };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SKILL_UPLOAD_BYTES) {
    return { ok: false, errors: [`The uploaded document is ${bytes} bytes; the limit is ${MAX_SKILL_UPLOAD_BYTES}.`], warnings, frontMatter: null };
  }
  // A lone surrogate or a NUL byte means this is not the UTF-8 Markdown the
  // registry stores, and hashing it would produce a revision nobody can reread.
  if (text.includes('\u0000')) {
    return { ok: false, errors: ['The uploaded document contains NUL bytes; a skill revision must be UTF-8 Markdown.'], warnings, frontMatter: null };
  }

  let asset: SkillRevisionAsset;
  const declaredId = text.match(/^\s*---\s*\n(?:.*\n)*?\s*skillId:\s*([^\n]*)/)?.[1]?.trim() ?? '';
  const declaredVersion = text.match(/^\s*---\s*\n(?:.*\n)*?\s*version:\s*([^\n]*)/)?.[1]?.trim() ?? '';
  // parseSkillRevision also checks the path agrees with the front matter, so the
  // draft is parsed against the path it would be written to.
  const notionalPath = path.join('registry', declaredId || 'unknown', `${declaredVersion || 'unknown'}.md`);
  try {
    asset = parseSkillRevision(text, notionalPath, 'external');
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof SkillRegistryError ? error.message.replace(` (${notionalPath})`, '') : String(error)],
      warnings,
      frontMatter: null,
    };
  }

  if (input.expectedSkillId && asset.skillId !== input.expectedSkillId) {
    errors.push(`The document declares skillId "${asset.skillId}" but was uploaded against "${input.expectedSkillId}".`);
  }
  // A brand new skill id is legitimate, but it is a different act from revising
  // an existing skill and the operator should see that it is what they did.
  const known = db.prepare('SELECT count(*) count FROM extraction_skills WHERE skill_id = ?').get(asset.skillId) as { count: number };
  if (Number(known.count) === 0) warnings.push(`"${asset.skillId}" is a new skill id; this upload registers it for the first time.`);

  const existing = db.prepare('SELECT status, sha256 FROM extraction_skills WHERE skill_id = ? AND version = ?').get(asset.skillId, asset.version) as { status: string; sha256: string } | undefined;
  if (existing) {
    errors.push(`Version ${asset.version} of ${asset.skillId} is already registered (${existing.status}). Published versions are immutable — choose a new version number.`);
  }
  const highest = db.prepare('SELECT version FROM extraction_skills WHERE skill_id = ?').all(asset.skillId) as Array<{ version: string }>;
  if (highest.length > 0) {
    const latest = highest.map((row) => row.version).sort(compareSkillVersions).at(-1)!;
    if (compareSkillVersions(asset.version, latest) <= 0) {
      errors.push(`Version ${asset.version} does not follow the highest registered version ${latest}; versions must increase.`);
    }
  }

  const markers = REQUIRED_SKILL_MARKERS[asset.promptTemplateVersion];
  if (!markers) {
    // Not a warning. `buildStructuredExtractionPrompt` throws on a template
    // version this build does not implement, so a revision naming an unknown one
    // is publishable and then breaks every extraction with an error that names
    // the template rather than the publication that caused it.
    errors.push(`Prompt template "${asset.promptTemplateVersion}" is not implemented by this build; known templates are ${Object.keys(REQUIRED_SKILL_MARKERS).join(', ')}.`);
  } else {
    const folded = asset.body.toLowerCase();
    const missing = markers.filter((marker) => !folded.includes(marker.toLowerCase()));
    if (missing.length > 0) errors.push(`The revision does not mention required contract elements: ${missing.join(', ')}.`);
  }

  const contract = input.currentPacketContractVersion ?? PACKET_CONTRACT_VERSION;
  if (contract !== PACKET_CONTRACT_VERSION) {
    errors.push(`This build accepts packet contract version ${PACKET_CONTRACT_VERSION}; the caller asserted ${contract}.`);
  }

  if (input.fileName && path.basename(input.fileName) !== `${asset.version}.md`) {
    warnings.push(`The uploaded file was named "${path.basename(input.fileName)}"; it will be stored as ${asset.version}.md.`);
  }
  if (asset.status === 'active') {
    warnings.push('The document declares status "active". An upload always creates a draft; publishing is a separate, confirmed action.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    frontMatter: {
      skillId: asset.skillId,
      version: asset.version,
      promptTemplateVersion: asset.promptTemplateVersion,
      status: asset.status,
      notes: asset.notes,
      name: asset.name,
      purpose: asset.purpose,
      providerProfile: asset.providerProfile,
      sha256: asset.sha256,
      characters: asset.characters,
    },
  };
}

export interface UploadSkillDraftResult {
  skillId: string;
  version: string;
  status: SkillStatus;
  sha256: string;
  path: string;
  warnings: string[];
}

/**
 * Register an uploaded revision as a NEW DRAFT.
 *
 * Never a publication. The document's own `status` is ignored beyond a warning:
 * a revision becomes active only through {@link promoteSkillRevision}, which is
 * a separate, confirmed, audited action. Nor can an upload overwrite anything —
 * a version that already exists is rejected before a byte is written.
 */
export function uploadSkillDraft(db: DatabaseSync, input: ValidateSkillDraftInput & { actor: string; options?: LoadSkillRegistryOptions }): UploadSkillDraftResult {
  if (!input.actor?.trim()) throw new SkillRegistryError('Uploading a draft requires a named actor');
  const validation = validateSkillDraft(db, input);
  if (!validation.ok || !validation.frontMatter) {
    throw new SkillRegistryError(`Draft rejected: ${validation.errors.join(' ')}`);
  }
  const front = validation.frontMatter;
  const directory = resolveWritableSkillDir(input.options ?? {});
  const skillDirectory = path.join(directory, front.skillId);
  const file = path.join(skillDirectory, `${front.version}.md`);
  if (existsSync(file)) {
    throw new SkillRegistryError(`A revision file already exists at ${file}; published revisions are immutable`);
  }
  mkdirSync(skillDirectory, { recursive: true });
  // Two things happen to the document before it is written.
  //
  // 1. Line endings are normalised, so the same document uploaded from Windows
  //    and from the API hashes identically. The body hash is the revision's
  //    identity.
  // 2. The declared `status` is forced to `draft`. `syncSkillRegistry`'s
  //    bootstrap reads the FILE's status, not the database row, so a document
  //    declaring `status: active` could promote itself on the next sync of a
  //    database that had no active revision for that skill — an upload
  //    activating something, which this function's entire contract forbids.
  const normalized = input.text
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*status:\s*).*$/m, '$1draft');
  // `wx` refuses to write if anything already exists at the path, INCLUDING a
  // symlink, so a link planted at the destination cannot redirect an upload into
  // the Git-tracked seed directory.
  writeFileSync(file, normalized, { encoding: 'utf8', flag: 'wx' });

  const at = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`INSERT INTO extraction_skills
      (skill_id, version, sha256, prompt_template_version, status, source, notes, created_at, promoted_at, retired_at, name, purpose, provider_profile, packet_contract_version, body_path, body_characters, uploaded_by)
      VALUES (?, ?, ?, ?, 'draft', 'external', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(front.skillId, front.version, front.sha256, front.promptTemplateVersion, front.notes, at,
        front.name, front.purpose, front.providerProfile, PACKET_CONTRACT_VERSION, file, front.characters, input.actor);
    audit(db, { skillId: front.skillId, version: front.version, event: 'registered', toStatus: 'draft', actor: input.actor, note: `uploaded draft (${front.characters} characters)` });
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { skillId: front.skillId, version: front.version, status: 'draft', sha256: front.sha256, path: file, warnings: validation.warnings };
}

function readRevisionsFrom(directory: string, source: SkillSource): SkillRevisionAsset[] {
  if (!existsSync(directory)) return [];
  if (!statSync(directory).isDirectory()) {
    throw new SkillRegistryError(`Skill registry path is not a directory: ${directory}`);
  }
  const assets: SkillRevisionAsset[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const skillDirectory = path.join(directory, entry.name);
    for (const file of readdirSync(skillDirectory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const full = path.join(skillDirectory, file.name);
      assets.push(parseSkillRevision(readFileSync(full, 'utf8'), full, source));
    }
  }
  return assets;
}

export interface LoadSkillRegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the shipped `skills/` directory. Tests use it; production does not. */
  seedDir?: string;
  /** Overrides `PROJECTMANAGAIR_SKILL_REGISTRY_DIR`. */
  externalDir?: string | null;
  /**
   * The git-ignored local directory uploads land in when no external registry
   * directory is configured. Scanned by default: a revision that was uploaded
   * and registered but never loadable again would be a version the registry
   * knows about and can no longer show, compare or send.
   *
   * `null` excludes it — {@link loadSeedSkillBody} does exactly that, because
   * the built-in default must be the shipped text and nothing else.
   */
  uploadDir?: string | null;
}

/**
 * Load every revision the seed directory and the external directory offer.
 *
 * The external directory overlays the seed: a revision with the same (skillId, version)
 * replaces the shipped one, and any other revision extends the set. Overlaying is how an
 * organisation corrects a shipped revision without forking the repository; extending is
 * how it holds private revisions outside Git.
 */
export function loadSkillRegistry(options: LoadSkillRegistryOptions = {}): SkillRevisionAsset[] {
  const env = options.env ?? process.env;
  const seedDir = options.seedDir ?? SEED_SKILL_DIR;
  const externalDir = options.externalDir !== undefined ? options.externalDir : (env[SKILL_REGISTRY_DIR_ENV] ?? '').trim() || null;

  const byKey = new Map<string, SkillRevisionAsset>();
  for (const asset of readRevisionsFrom(seedDir, 'seed')) byKey.set(`${asset.skillId}@${asset.version}`, asset);
  // Uploads land here when no external directory is configured. Loaded before
  // the external directory so an organisation's registry still wins.
  const uploadDir = options.uploadDir !== undefined ? options.uploadDir : DEFAULT_UPLOAD_SKILL_DIR;
  if (uploadDir && uploadDir !== externalDir) {
    for (const asset of readRevisionsFrom(uploadDir, 'external')) byKey.set(`${asset.skillId}@${asset.version}`, asset);
  }
  if (externalDir) {
    if (!existsSync(externalDir)) {
      throw new SkillRegistryError(`${SKILL_REGISTRY_DIR_ENV} points at ${externalDir}, which does not exist`);
    }
    for (const asset of readRevisionsFrom(externalDir, 'external')) byKey.set(`${asset.skillId}@${asset.version}`, asset);
  }
  return [...byKey.values()].sort((left, right) => (
    left.skillId === right.skillId ? compareSkillVersions(left.version, right.version) : (left.skillId < right.skillId ? -1 : 1)
  ));
}

/** The shipped seed body for one skill id, used to keep the built-in default honest. */
export function loadSeedSkillBody(skillId = DEFAULT_EXTRACTION_SKILL_ID, options: LoadSkillRegistryOptions = {}): string {
  const seeds = loadSkillRegistry({ ...options, externalDir: null, uploadDir: null }).filter((asset) => asset.skillId === skillId);
  if (seeds.length === 0) throw new SkillRegistryError(`No shipped seed revision exists for skill "${skillId}"`);
  const declaredActive = seeds.filter((asset) => asset.status === 'active');
  return (declaredActive.length > 0 ? declaredActive : seeds).at(-1)!.body;
}

/* ------------------------------------------------------------------------------------ *
 * Database rows
 * ------------------------------------------------------------------------------------ */

export interface SkillRevisionRecord {
  skillId: string;
  version: string;
  sha256: string;
  promptTemplateVersion: string;
  status: SkillStatus;
  source: SkillSource;
  notes: string | null;
  createdAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
  name: string;
  purpose: string | null;
  providerProfile: string | null;
  packetContractVersion: number;
  bodyPath: string | null;
  bodyCharacters: number | null;
  uploadedBy: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: Record<string, unknown>): SkillRevisionRecord {
  return {
    skillId: String(row.skill_id),
    version: String(row.version),
    sha256: String(row.sha256),
    promptTemplateVersion: String(row.prompt_template_version),
    status: String(row.status) as SkillStatus,
    source: String(row.source) as SkillSource,
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
    createdAt: String(row.created_at),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    retiredAt: row.retired_at ? String(row.retired_at) : null,
    name: row.name ? String(row.name) : titleCaseSkillId(String(row.skill_id)),
    purpose: row.purpose ? String(row.purpose) : null,
    providerProfile: row.provider_profile ? String(row.provider_profile) : null,
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? PACKET_CONTRACT_VERSION : Number(row.packet_contract_version),
    bodyPath: row.body_path ? String(row.body_path) : null,
    bodyCharacters: row.body_characters === null || row.body_characters === undefined ? null : Number(row.body_characters),
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
  };
}

/** Registry metadata only. Safe to serve: no revision body ever appears here. */
export function readSkillRevisions(db: DatabaseSync, skillId?: string): SkillRevisionRecord[] {
  const rows = skillId
    ? db.prepare('SELECT * FROM extraction_skills WHERE skill_id = ? ORDER BY skill_id, version').all(skillId)
    : db.prepare('SELECT * FROM extraction_skills ORDER BY skill_id, version').all();
  return (rows as Array<Record<string, unknown>>).map(toRecord);
}

export function readActiveSkillRevision(db: DatabaseSync, skillId = DEFAULT_EXTRACTION_SKILL_ID): SkillRevisionRecord | null {
  const row = db.prepare("SELECT * FROM extraction_skills WHERE skill_id = ? AND status = 'active'").get(skillId) as Record<string, unknown> | undefined;
  return row ? toRecord(row) : null;
}

export interface SkillAuditEntry {
  id: string;
  skillId: string;
  version: string;
  projectId: string | null;
  event: SkillEvent;
  fromStatus: SkillStatus | null;
  toStatus: SkillStatus | null;
  actor: string;
  note: string | null;
  occurredAt: string;
}

export function readSkillAuditTrail(db: DatabaseSync, filter: { skillId?: string; projectId?: string; limit?: number } = {}): SkillAuditEntry[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.skillId) { clauses.push('skill_id = ?'); values.push(filter.skillId); }
  if (filter.projectId) { clauses.push('project_id = ?'); values.push(filter.projectId); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM extraction_skill_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .all(...values, filter.limit ?? 200) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    skillId: String(row.skill_id),
    version: String(row.version),
    projectId: row.project_id ? String(row.project_id) : null,
    event: String(row.event) as SkillEvent,
    fromStatus: row.from_status ? String(row.from_status) as SkillStatus : null,
    toStatus: row.to_status ? String(row.to_status) as SkillStatus : null,
    actor: String(row.actor),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    occurredAt: String(row.occurred_at),
  }));
}

/**
 * Audit ids sort by time then by the order they were written, so the trail reads in the order
 * the transitions happened even when several land in the same millisecond. The pid suffix keeps
 * two processes from colliding on the primary key without disturbing that ordering.
 */
let auditSequence = 0;

function audit(db: DatabaseSync, entry: {
  skillId: string;
  version: string;
  projectId?: string | null;
  event: SkillEvent;
  fromStatus?: SkillStatus | null;
  toStatus?: SkillStatus | null;
  actor: string;
  note?: string | null;
}): void {
  auditSequence += 1;
  const occurredAt = nowIso();
  const id = `skill-event:${occurredAt}:${String(auditSequence).padStart(6, '0')}:${process.pid}:${entry.skillId}:${entry.version}:${entry.event}`;
  db.prepare(`INSERT INTO extraction_skill_events (id, skill_id, version, project_id, event, from_status, to_status, actor, note, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, entry.skillId, entry.version, entry.projectId ?? null, entry.event, entry.fromStatus ?? null, entry.toStatus ?? null, entry.actor, entry.note ?? null, occurredAt);
}

/* ------------------------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------------------------ */

export interface SkillRegistrySyncResult {
  registered: Array<{ skillId: string; version: string; status: SkillStatus; source: SkillSource }>;
  refreshed: Array<{ skillId: string; version: string; status: SkillStatus; source: SkillSource }>;
  unchanged: number;
  /** The one audited bootstrap promotion, when a skill id had no active revision at all. */
  bootstrapped: Array<{ skillId: string; version: string }>;
}

export interface SyncSkillRegistryOptions extends LoadSkillRegistryOptions {
  actor?: string;
}

/**
 * Register or refresh every revision the registry directories offer.
 *
 * Registration is not promotion. A file declaring `status: active` is recorded as
 * `candidate` whenever the skill id already has an active revision, because promoting
 * by editing a file would be exactly the implicit state change the lifecycle forbids.
 * The single exception is bootstrap: a skill id with no active revision at all takes its
 * highest declared-active revision through the ordinary {@link promoteSkillRevision} path,
 * actor `registry-bootstrap`, so even that appears in the audit trail.
 *
 * A revision whose body hash has changed since it was registered is a hard error. Revisions
 * are immutable by construction; rewriting one in place would retro-date every run that
 * claims to have been graded against it.
 */
export function syncSkillRegistry(db: DatabaseSync, options: SyncSkillRegistryOptions = {}): SkillRegistrySyncResult {
  const actor = options.actor ?? 'registry-sync';
  const assets = loadSkillRegistry(options);
  const result: SkillRegistrySyncResult = { registered: [], refreshed: [], unchanged: 0, bootstrapped: [] };

  // Registration is all-or-nothing: a rewritten revision half way through the set must not leave
  // the registry describing a mixture of two loads.
  db.exec('BEGIN IMMEDIATE;');
  try {
    registerAssets(db, assets, actor, result);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  // Bootstrap runs after the commit because promotion is its own audited transaction.
  for (const skillId of [...new Set(assets.map((asset) => asset.skillId))]) {
    if (readActiveSkillRevision(db, skillId)) continue;
    const candidate = assets.filter((asset) => asset.skillId === skillId && asset.status === 'active').at(-1);
    if (!candidate) continue;
    promoteSkillRevision(db, { skillId, version: candidate.version, actor: 'registry-bootstrap', note: 'First activation of a skill id that had no active revision.' });
    result.bootstrapped.push({ skillId, version: candidate.version });
  }

  return result;
}

function registerAssets(db: DatabaseSync, assets: SkillRevisionAsset[], actor: string, result: SkillRegistrySyncResult): void {
  for (const asset of assets) {
    const existing = db.prepare('SELECT * FROM extraction_skills WHERE skill_id = ? AND version = ?').get(asset.skillId, asset.version) as Record<string, unknown> | undefined;
    if (!existing) {
      // `active` in a file is an intent, not a transition. It is recorded as `candidate`
      // and, where the skill has no active revision, promoted through the audited path below.
      const status: SkillStatus = asset.status === 'active' ? 'candidate' : asset.status;
      db.prepare(`INSERT INTO extraction_skills (skill_id, version, sha256, prompt_template_version, status, source, notes, created_at, promoted_at, retired_at, name, purpose, provider_profile, packet_contract_version, body_path, body_characters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .run(asset.skillId, asset.version, asset.sha256, asset.promptTemplateVersion, status, asset.source, asset.notes, nowIso(), status === 'retired' ? nowIso() : null,
          asset.name, asset.purpose, asset.providerProfile, PACKET_CONTRACT_VERSION, asset.file, asset.characters);
      audit(db, { skillId: asset.skillId, version: asset.version, event: 'registered', toStatus: status, actor, note: `source=${asset.source}` });
      result.registered.push({ skillId: asset.skillId, version: asset.version, status, source: asset.source });
      continue;
    }
    if (String(existing.sha256) !== asset.sha256) {
      throw new SkillRegistryError(
        `Revision ${asset.skillId}@${asset.version} was rewritten in place: the registered body hash ${String(existing.sha256).slice(0, 12)} no longer matches the file. Publish a new version instead`,
        asset.file,
      );
    }
    const templateChanged = String(existing.prompt_template_version) !== asset.promptTemplateVersion;
    const notesChanged = String(existing.notes ?? '') !== asset.notes;
    const sourceChanged = String(existing.source) !== asset.source;
    // Presentation metadata is not part of the revision's identity — the body
    // hash is — so a renamed or re-described revision refreshes in place rather
    // than demanding a new version number.
    const labelChanged = String(existing.name ?? '') !== asset.name
      || String(existing.purpose ?? '') !== String(asset.purpose ?? '')
      || String(existing.provider_profile ?? '') !== String(asset.providerProfile ?? '')
      || String(existing.body_path ?? '') !== asset.file;
    if (templateChanged || notesChanged || sourceChanged || labelChanged) {
      db.prepare('UPDATE extraction_skills SET prompt_template_version = ?, notes = ?, source = ?, name = ?, purpose = ?, provider_profile = ?, body_path = ?, body_characters = ?, packet_contract_version = COALESCE(packet_contract_version, ?) WHERE skill_id = ? AND version = ?')
        .run(asset.promptTemplateVersion, asset.notes, asset.source, asset.name, asset.purpose, asset.providerProfile, asset.file, asset.characters, PACKET_CONTRACT_VERSION, asset.skillId, asset.version);
      audit(db, {
        skillId: asset.skillId,
        version: asset.version,
        event: 'refreshed',
        toStatus: String(existing.status) as SkillStatus,
        actor,
        note: [templateChanged ? `promptTemplateVersion=${asset.promptTemplateVersion}` : null, notesChanged ? 'notes' : null, sourceChanged ? `source=${asset.source}` : null, labelChanged ? 'metadata' : null].filter(Boolean).join(' '),
      });
      result.refreshed.push({ skillId: asset.skillId, version: asset.version, status: String(existing.status) as SkillStatus, source: asset.source });
    } else {
      result.unchanged += 1;
    }
  }
}

/**
 * Register the registry directories once, if and only if the skill has no active revision yet.
 *
 * This is the safe call for a code path that must always have a contract in force — server
 * start-up, or an extraction entry point on a database that predates the registry. It cannot
 * displace an active revision: where one exists it does nothing at all, so a promotion decision
 * is never overwritten by a process restart.
 */
export function ensureSkillRegistrySynced(db: DatabaseSync, options: SyncSkillRegistryOptions & { skillId?: string } = {}): SkillRegistrySyncResult | null {
  const hasActive = Boolean(readActiveSkillRevision(db, options.skillId ?? DEFAULT_EXTRACTION_SKILL_ID));
  // A database that predates a shipped skill has an active extraction revision
  // and would previously have been left without the newer registry assets
  // forever. Registration is not promotion, so picking them up here cannot
  // displace anything an operator has decided.
  const unregistered = hasActive && loadSkillRegistry(options).some((asset) => !db.prepare('SELECT 1 FROM extraction_skills WHERE skill_id = ? AND version = ?').get(asset.skillId, asset.version));
  if (hasActive && !unregistered) return null;
  return syncSkillRegistry(db, options);
}

/* ------------------------------------------------------------------------------------ *
 * Lifecycle transitions
 * ------------------------------------------------------------------------------------ */

export interface PromotionResult {
  skillId: string;
  version: string;
  previousActiveVersion: string | null;
  promotedAt: string;
  changed: boolean;
}

function requireRevision(db: DatabaseSync, skillId: string, version: string): SkillRevisionRecord {
  const row = db.prepare('SELECT * FROM extraction_skills WHERE skill_id = ? AND version = ?').get(skillId, version) as Record<string, unknown> | undefined;
  if (!row) throw new SkillRegistryError(`Revision ${skillId}@${version} is not registered; run syncSkillRegistry first`);
  return toRecord(row);
}

function transitionActive(db: DatabaseSync, input: { skillId: string; version: string; actor: string; note?: string | null; event: 'promoted' | 'rolled-back' }): PromotionResult {
  const target = requireRevision(db, input.skillId, input.version);
  const current = readActiveSkillRevision(db, input.skillId);
  if (current && current.version === target.version) {
    return { skillId: target.skillId, version: target.version, previousActiveVersion: current.version, promotedAt: current.promotedAt ?? current.createdAt, changed: false };
  }
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (current) {
      // Retire first: the partial unique index allows exactly one active row per skill id,
      // so the order here is what keeps the transition legal rather than a race.
      db.prepare("UPDATE extraction_skills SET status = 'retired', retired_at = ? WHERE skill_id = ? AND version = ?").run(at, current.skillId, current.version);
      audit(db, { skillId: current.skillId, version: current.version, event: 'retired', fromStatus: 'active', toStatus: 'retired', actor: input.actor, note: `Superseded by ${target.version}.` });
    }
    db.prepare("UPDATE extraction_skills SET status = 'active', promoted_at = ?, retired_at = NULL WHERE skill_id = ? AND version = ?").run(at, target.skillId, target.version);
    audit(db, { skillId: target.skillId, version: target.version, event: input.event, fromStatus: target.status, toStatus: 'active', actor: input.actor, note: input.note ?? null });
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { skillId: target.skillId, version: target.version, previousActiveVersion: current?.version ?? null, promotedAt: at, changed: true };
}

/** Promote a draft or candidate to active, retiring the previous active revision. */
export function promoteSkillRevision(db: DatabaseSync, input: { skillId?: string; version: string; actor: string; note?: string | null }): PromotionResult {
  const skillId = input.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  if (!input.actor?.trim()) throw new SkillRegistryError('Promotion requires a named actor; an unattributed transition is not an audit record');
  return transitionActive(db, { skillId, version: input.version, actor: input.actor, note: input.note ?? null, event: 'promoted' });
}

/**
 * Roll back to a named prior version.
 *
 * "Prior" is enforced: only a revision that has been active before can be rolled back to,
 * so a rollback can never be used to slip an untested revision into production under a
 * gentler-sounding verb.
 */
export function rollbackSkillRevision(db: DatabaseSync, input: { skillId?: string; toVersion: string; actor: string; note?: string | null }): PromotionResult {
  const skillId = input.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  if (!input.actor?.trim()) throw new SkillRegistryError('Rollback requires a named actor; an unattributed transition is not an audit record');
  const target = requireRevision(db, skillId, input.toVersion);
  if (!target.promotedAt) {
    throw new SkillRegistryError(`Revision ${skillId}@${input.toVersion} has never been active, so there is nothing to roll back to. Promote it explicitly instead`);
  }
  return transitionActive(db, { skillId, version: input.toVersion, actor: input.actor, note: input.note ?? null, event: 'rolled-back' });
}

/* ------------------------------------------------------------------------------------ *
 * Project pinning
 * ------------------------------------------------------------------------------------ */

export interface SkillPin {
  projectId: string;
  skillId: string;
  version: string;
  pinnedBy: string;
  pinnedAt: string;
  note: string | null;
}

export function readSkillPin(db: DatabaseSync, projectId: string, skillId = DEFAULT_EXTRACTION_SKILL_ID): SkillPin | null {
  const row = db.prepare('SELECT * FROM extraction_skill_pins WHERE project_id = ? AND skill_id = ?').get(projectId, skillId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    skillId: String(row.skill_id),
    version: String(row.version),
    pinnedBy: String(row.pinned_by),
    pinnedAt: String(row.pinned_at),
    note: row.note === null || row.note === undefined ? null : String(row.note),
  };
}

/** Hold one project on one revision, whatever the active revision becomes. */
export function pinProjectSkill(db: DatabaseSync, input: { projectId: string; skillId?: string; version: string; actor: string; note?: string | null }): SkillPin {
  const skillId = input.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  if (!input.actor?.trim()) throw new SkillRegistryError('Pinning requires a named actor');
  requireRevision(db, skillId, input.version);
  const at = nowIso();
  db.prepare(`INSERT INTO extraction_skill_pins (project_id, skill_id, version, pinned_by, pinned_at, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, skill_id) DO UPDATE SET version = excluded.version, pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at, note = excluded.note`)
    .run(input.projectId, skillId, input.version, input.actor, at, input.note ?? null);
  audit(db, { skillId, version: input.version, projectId: input.projectId, event: 'pinned', actor: input.actor, note: input.note ?? null });
  return readSkillPin(db, input.projectId, skillId)!;
}

export function unpinProjectSkill(db: DatabaseSync, input: { projectId: string; skillId?: string; actor: string; note?: string | null }): { changed: boolean; previousVersion: string | null } {
  const skillId = input.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  if (!input.actor?.trim()) throw new SkillRegistryError('Unpinning requires a named actor');
  const existing = readSkillPin(db, input.projectId, skillId);
  if (!existing) return { changed: false, previousVersion: null };
  db.prepare('DELETE FROM extraction_skill_pins WHERE project_id = ? AND skill_id = ?').run(input.projectId, skillId);
  audit(db, { skillId, version: existing.version, projectId: input.projectId, event: 'unpinned', actor: input.actor, note: input.note ?? null });
  return { changed: true, previousVersion: existing.version };
}

/* ------------------------------------------------------------------------------------ *
 * Resolution for a run
 * ------------------------------------------------------------------------------------ */

export interface ResolvedSkillForRun {
  skillId: string;
  version: string;
  /** sha256 of the text actually sent, whatever its origin. */
  sha256: string;
  promptTemplateVersion: string;
  status: SkillStatus | 'external-path';
  source: SkillSource | 'external-path';
  /** The instructional text. Never persist, never log, never serve. */
  text: string;
  characters: number;
  pinned: boolean;
  pinnedBy: string | null;
  packetContractVersion: number;
  /** Present only for the legacy single-file override, so an operator can see what is in force. */
  path: string | null;
}

export interface ResolveSkillOptions extends LoadSkillRegistryOptions {
  skillId?: string;
  /**
   * The legacy single-file override (`PROJECTMANAGAIR_EXTRACTION_SKILL_PATH`), already
   * resolved by `resolveExtractionSkill()`. Passed in explicitly rather than read here so
   * the precedence between the two mechanisms is visible at the call site.
   */
  legacySkill?: { text: string; sha256: string; origin: string; path: string | null; characters: number } | null;
}

/**
 * The revision in force for one project: its pin if it has one, otherwise the active revision.
 *
 * The body is re-read from disk and its hash checked against the registered hash, so a run can
 * never be recorded as graded against a contract the model was not actually given.
 */
export function resolveSkillForRun(db: DatabaseSync, projectId: string, options: ResolveSkillOptions = {}): ResolvedSkillForRun {
  const skillId = options.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  const active = readActiveSkillRevision(db, skillId);

  const legacy = options.legacySkill;
  if (legacy && legacy.origin === 'external-file') {
    // Back-compatible escape hatch: the file wins, and says so in the provenance rather than
    // borrowing a registry version number it does not have.
    return {
      skillId,
      version: LEGACY_FILE_SKILL_VERSION,
      sha256: legacy.sha256,
      promptTemplateVersion: active?.promptTemplateVersion ?? DEFAULT_PROMPT_TEMPLATE_VERSION_FALLBACK,
      status: 'external-path',
      source: 'external-path',
      text: legacy.text,
      characters: legacy.characters,
      pinned: false,
      pinnedBy: null,
      packetContractVersion: PACKET_CONTRACT_VERSION,
      path: legacy.path,
    };
  }

  const pin = readSkillPin(db, projectId, skillId);
  const record = pin ? requireRevision(db, skillId, pin.version) : active;
  if (!record) {
    throw new SkillRegistryError(`No active revision is registered for skill "${skillId}". Run syncSkillRegistry, then promote a revision explicitly`);
  }

  const asset = loadSkillRegistry(options).find((entry) => entry.skillId === record.skillId && entry.version === record.version);
  if (!asset) {
    throw new SkillRegistryError(`Revision ${record.skillId}@${record.version} is registered but its file is not present in any registry directory`);
  }
  if (asset.sha256 !== record.sha256) {
    throw new SkillRegistryError(`Revision ${record.skillId}@${record.version} no longer hashes to its registered body; the file has been rewritten in place`, asset.file);
  }

  return {
    skillId: record.skillId,
    version: record.version,
    sha256: record.sha256,
    promptTemplateVersion: record.promptTemplateVersion,
    status: record.status,
    source: record.source,
    text: asset.body,
    characters: asset.characters,
    pinned: Boolean(pin),
    pinnedBy: pin?.pinnedBy ?? null,
    packetContractVersion: PACKET_CONTRACT_VERSION,
    path: null,
  };
}

/** Used only when the legacy override is in force before any revision has been registered. */
const DEFAULT_PROMPT_TEMPLATE_VERSION_FALLBACK = 'source-extraction-prompt-v2';

/**
 * The body-free projection of a resolved skill. This — never {@link ResolvedSkillForRun}
 * itself — is what may cross an API boundary or reach a log.
 */
export function publicSkillProvenance(resolved: ResolvedSkillForRun): Omit<ResolvedSkillForRun, 'text'> & { text?: never } {
  const { text: _body, ...rest } = resolved;
  return rest;
}

/* ------------------------------------------------------------------------------------ *
 * Run and packet provenance
 * ------------------------------------------------------------------------------------ */

export interface RunSkillProvenance {
  skillId: string;
  skillVersion: string;
  promptTemplateVersion: string;
  packetContractVersion: number;
}

/** The four registry columns migration 012 adds to `extraction_runs`, in insert order. */
export const EXTRACTION_RUN_PROVENANCE_COLUMNS = ['skill_id', 'skill_version', 'prompt_template_version', 'packet_contract_version'] as const;

export function runProvenanceOf(resolved: ResolvedSkillForRun): RunSkillProvenance {
  return {
    skillId: resolved.skillId,
    skillVersion: resolved.version,
    promptTemplateVersion: resolved.promptTemplateVersion,
    packetContractVersion: resolved.packetContractVersion,
  };
}

/**
 * Attach registry provenance to a run row that has already been inserted.
 *
 * Provided for the wiring in `sourcePipeline.insertRun`, which owns the INSERT. `extraction_runs`
 * carries no immutability trigger, so completing a row in place is legal here — unlike
 * `extraction_packets`, whose provenance must be supplied at INSERT time.
 */
export function recordExtractionRunProvenance(db: DatabaseSync, runId: string, provenance: RunSkillProvenance): void {
  const updated = db.prepare('UPDATE extraction_runs SET skill_id = ?, skill_version = ?, prompt_template_version = ?, packet_contract_version = ? WHERE id = ?')
    .run(provenance.skillId, provenance.skillVersion, provenance.promptTemplateVersion, provenance.packetContractVersion, runId);
  if (Number(updated.changes) !== 1) throw new SkillRegistryError(`Extraction run ${runId} does not exist, so its provenance cannot be recorded`);
}

export interface ExtractionRunProvenance extends RunSkillProvenance {
  runId: string;
  skillSha256: string;
  promptSha256: string;
  providerId: string;
  modelLabel: string;
}

/** Read back the complete provenance of one run: the eight fields §3 requires. */
export function readExtractionRunProvenance(db: DatabaseSync, runId: string): ExtractionRunProvenance | null {
  const row = db.prepare(`SELECT id, skill_id, skill_version, skill_sha256, prompt_template_version, prompt_sha256, provider_id, model_label, packet_contract_version
    FROM extraction_runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    runId: String(row.id),
    skillId: row.skill_id ? String(row.skill_id) : '',
    skillVersion: row.skill_version ? String(row.skill_version) : '',
    skillSha256: String(row.skill_sha256),
    promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : '',
    promptSha256: String(row.prompt_sha256),
    providerId: String(row.provider_id),
    modelLabel: String(row.model_label),
    packetContractVersion: row.packet_contract_version === null || row.packet_contract_version === undefined ? 0 : Number(row.packet_contract_version),
  };
}

/**
 * The skill provenance a freeze should stamp onto its packet, derived from the runs that
 * produced it. `freezePacketAndCreateChangeset` already reads `skill_sha256` and `prompt_sha256`
 * from the first run; this returns the registry half of the same record.
 *
 * `extraction_packets` is immutable by trigger, so these values must be supplied in the INSERT.
 */
export function packetSkillProvenance(db: DatabaseSync, runIds: readonly string[]): { skillId: string | null; skillVersion: string | null; promptTemplateVersion: string | null } {
  for (const runId of runIds) {
    const row = db.prepare('SELECT skill_id, skill_version, prompt_template_version FROM extraction_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    if (row?.skill_id) {
      return {
        skillId: String(row.skill_id),
        skillVersion: row.skill_version ? String(row.skill_version) : null,
        promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : null,
      };
    }
  }
  return { skillId: null, skillVersion: null, promptTemplateVersion: null };
}

export interface ExtractionPacketProvenance {
  packetId: string;
  skillId: string | null;
  skillVersion: string | null;
  promptTemplateVersion: string | null;
  skillSha256: string;
  promptSha256: string;
  packetContractVersion: number;
  packetSha256: string;
}

export function readExtractionPacketProvenance(db: DatabaseSync, packetId: string): ExtractionPacketProvenance | null {
  const row = db.prepare(`SELECT id, skill_id, skill_version, prompt_template_version, skill_sha256, prompt_sha256, packet_contract_version, packet_sha256
    FROM extraction_packets WHERE id = ?`).get(packetId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    packetId: String(row.id),
    skillId: row.skill_id ? String(row.skill_id) : null,
    skillVersion: row.skill_version ? String(row.skill_version) : null,
    promptTemplateVersion: row.prompt_template_version ? String(row.prompt_template_version) : null,
    skillSha256: String(row.skill_sha256),
    promptSha256: String(row.prompt_sha256),
    packetContractVersion: Number(row.packet_contract_version),
    packetSha256: String(row.packet_sha256),
  };
}

/* ------------------------------------------------------------------------------------ *
 * Retirement
 * ------------------------------------------------------------------------------------ */

/**
 * Retire a revision that is not in force.
 *
 * The active revision is deliberately not retirable here: retiring it would
 * leave the skill with no contract at all, and the honest way to stop using a
 * revision is to promote or roll back to another one, which retires it as part
 * of an atomic transition.
 */
export function retireSkillRevision(db: DatabaseSync, input: { skillId?: string; version: string; actor: string; note?: string | null }): { skillId: string; version: string; retiredAt: string; changed: boolean } {
  const skillId = input.skillId ?? DEFAULT_EXTRACTION_SKILL_ID;
  if (!input.actor?.trim()) throw new SkillRegistryError('Retirement requires a named actor; an unattributed transition is not an audit record');
  const target = requireRevision(db, skillId, input.version);
  if (target.status === 'active') {
    throw new SkillRegistryError(`Revision ${skillId}@${input.version} is the active revision. Promote or roll back to another revision instead; that retires this one atomically`);
  }
  if (target.status === 'retired') return { skillId, version: input.version, retiredAt: target.retiredAt ?? target.createdAt, changed: false };
  const pins = db.prepare('SELECT project_id FROM extraction_skill_pins WHERE skill_id = ? AND version = ?').all(skillId, input.version) as Array<{ project_id: string }>;
  if (pins.length > 0) {
    throw new SkillRegistryError(`Revision ${skillId}@${input.version} is pinned by ${pins.length} project(s); remove the pins before retiring it`);
  }
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare("UPDATE extraction_skills SET status = 'retired', retired_at = ? WHERE skill_id = ? AND version = ?").run(at, skillId, input.version);
    audit(db, { skillId, version: input.version, event: 'retired', fromStatus: target.status, toStatus: 'retired', actor: input.actor, note: input.note ?? null });
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { skillId, version: input.version, retiredAt: at, changed: true };
}

/* ------------------------------------------------------------------------------------ *
 * Reading a revision body
 * ------------------------------------------------------------------------------------ */

export interface SkillRevisionBody {
  skillId: string;
  version: string;
  status: SkillStatus;
  sha256: string;
  /** The instructional text. A reusable template — never an assembled prompt. */
  text: string;
  characters: number;
  /** Drafts may be replaced by uploading a new version; published revisions cannot. */
  editable: boolean;
  source: SkillSource;
  promptTemplateVersion: string;
  packetContractVersion: number;
  /**
   * What a download of this text does and does not contain, stated on the
   * artefact itself so a downloaded file cannot be mistaken for a run record.
   */
  containsCustomerSource: false;
}

/**
 * Read the text of one registered revision, re-hashed against the registry.
 *
 * WHAT THIS DELIBERATELY DOES AND DOES NOT SERVE
 * ----------------------------------------------
 * It serves the REUSABLE TEMPLATE — the instructions we send. That is the thing
 * Settings exists to let an operator read, copy, improve and publish, and it is
 * written by us, not derived from a customer document.
 *
 * It never serves an ASSEMBLED PROMPT. An assembled prompt contains the source
 * windows, which are customer material; only its SHA-256 is recorded, and there
 * is no route that returns one.
 */
export function readSkillRevisionBody(db: DatabaseSync, skillId: string, version: string, options: LoadSkillRegistryOptions = {}): SkillRevisionBody {
  const record = requireRevision(db, skillId, version);
  const asset = loadSkillRegistry(options).find((entry) => entry.skillId === skillId && entry.version === version);
  if (!asset) throw new SkillRegistryError(`Revision ${skillId}@${version} is registered but its file is not present in any registry directory`);
  if (asset.sha256 !== record.sha256) {
    throw new SkillRegistryError(`Revision ${skillId}@${version} no longer hashes to its registered body; the file has been rewritten in place`, asset.file);
  }
  return {
    skillId,
    version,
    status: record.status,
    sha256: record.sha256,
    text: asset.body,
    characters: asset.characters,
    editable: record.status === 'draft',
    source: record.source,
    promptTemplateVersion: record.promptTemplateVersion,
    packetContractVersion: record.packetContractVersion,
    containsCustomerSource: false,
  };
}

/* ------------------------------------------------------------------------------------ *
 * Version comparison
 * ------------------------------------------------------------------------------------ */

export interface SkillVersionDiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface SkillVersionComparison {
  skillId: string;
  from: { version: string; status: SkillStatus; sha256: string; promptTemplateVersion: string; characters: number };
  to: { version: string; status: SkillStatus; sha256: string; promptTemplateVersion: string; characters: number };
  identical: boolean;
  addedLines: number;
  removedLines: number;
  promptTemplateChanged: boolean;
  packetContractChanged: boolean;
  diff: SkillVersionDiffLine[];
}

/**
 * A longest-common-subsequence line diff between two revisions.
 *
 * Written out rather than pulled in as a dependency: the bodies are a few
 * hundred lines, the algorithm is fifteen lines, and a publication confirmation
 * screen must not depend on a package that could change what an operator sees
 * before they approve a change to the model's instructions.
 */
export function compareSkillRevisions(db: DatabaseSync, skillId: string, fromVersion: string, toVersion: string, options: LoadSkillRegistryOptions = {}): SkillVersionComparison {
  const from = readSkillRevisionBody(db, skillId, fromVersion, options);
  const to = readSkillRevisionBody(db, skillId, toVersion, options);
  const left = from.text.split('\n');
  const right = to.text.split('\n');

  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const diff: SkillVersionDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { diff.push({ kind: 'context', text: left[i] }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { diff.push({ kind: 'removed', text: left[i] }); i += 1; }
    else { diff.push({ kind: 'added', text: right[j] }); j += 1; }
  }
  while (i < left.length) { diff.push({ kind: 'removed', text: left[i] }); i += 1; }
  while (j < right.length) { diff.push({ kind: 'added', text: right[j] }); j += 1; }

  return {
    skillId,
    from: { version: from.version, status: from.status, sha256: from.sha256, promptTemplateVersion: from.promptTemplateVersion, characters: from.characters },
    to: { version: to.version, status: to.status, sha256: to.sha256, promptTemplateVersion: to.promptTemplateVersion, characters: to.characters },
    identical: from.sha256 === to.sha256,
    addedLines: diff.filter((line) => line.kind === 'added').length,
    removedLines: diff.filter((line) => line.kind === 'removed').length,
    promptTemplateChanged: from.promptTemplateVersion !== to.promptTemplateVersion,
    packetContractChanged: from.packetContractVersion !== to.packetContractVersion,
    diff,
  };
}

/* ------------------------------------------------------------------------------------ *
 * Benchmarks
 * ------------------------------------------------------------------------------------ */

export interface SkillBenchmarkRecord {
  id: string;
  skillId: string;
  version: string;
  projectId: string | null;
  sourceId: string | null;
  packetId: string | null;
  benchmarkLabel: string;
  verdict: string;
  metrics: Record<string, unknown>;
  recordedBy: string;
  recordedAt: string;
  note: string | null;
}

let benchmarkSequence = 0;

/**
 * Record a graded result against the exact revision that produced it.
 *
 * Append only, by database trigger. A benchmark is evidence about a version, and
 * a version whose score can be revised after the fact is a version whose score
 * means nothing.
 */
export function recordSkillBenchmark(db: DatabaseSync, input: {
  skillId: string;
  version: string;
  projectId?: string | null;
  sourceId?: string | null;
  packetId?: string | null;
  benchmarkLabel: string;
  verdict: string;
  metrics: Record<string, unknown>;
  recordedBy: string;
  note?: string | null;
}): SkillBenchmarkRecord {
  if (!input.recordedBy?.trim()) throw new SkillRegistryError('Recording a benchmark requires a named actor');
  if (!input.benchmarkLabel?.trim()) throw new SkillRegistryError('A benchmark result must name the benchmark it was measured against');
  requireRevision(db, input.skillId, input.version);
  benchmarkSequence += 1;
  const recordedAt = nowIso();
  const id = `skill-benchmark:${recordedAt}:${String(benchmarkSequence).padStart(4, '0')}:${process.pid}:${input.skillId}:${input.version}`;
  db.prepare(`INSERT INTO extraction_skill_benchmarks (id, skill_id, version, project_id, source_id, packet_id, benchmark_label, verdict, metrics_json, recorded_by, recorded_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.skillId, input.version, input.projectId ?? null, input.sourceId ?? null, input.packetId ?? null,
      input.benchmarkLabel, input.verdict, JSON.stringify(input.metrics), input.recordedBy, recordedAt, input.note ?? null);
  return { id, skillId: input.skillId, version: input.version, projectId: input.projectId ?? null, sourceId: input.sourceId ?? null, packetId: input.packetId ?? null, benchmarkLabel: input.benchmarkLabel, verdict: input.verdict, metrics: input.metrics, recordedBy: input.recordedBy, recordedAt, note: input.note ?? null };
}

export function readSkillBenchmarks(db: DatabaseSync, filter: { skillId?: string; version?: string; limit?: number } = {}): SkillBenchmarkRecord[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.skillId) { clauses.push('skill_id = ?'); values.push(filter.skillId); }
  if (filter.version) { clauses.push('version = ?'); values.push(filter.version); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM extraction_skill_benchmarks ${where} ORDER BY recorded_at DESC, id DESC LIMIT ?`)
    .all(...values, filter.limit ?? 100) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    skillId: String(row.skill_id),
    version: String(row.version),
    projectId: row.project_id ? String(row.project_id) : null,
    sourceId: row.source_id ? String(row.source_id) : null,
    packetId: row.packet_id ? String(row.packet_id) : null,
    benchmarkLabel: String(row.benchmark_label),
    verdict: String(row.verdict),
    metrics: JSON.parse(String(row.metrics_json)) as Record<string, unknown>,
    recordedBy: String(row.recorded_by),
    recordedAt: String(row.recorded_at),
    note: row.note === null || row.note === undefined ? null : String(row.note),
  }));
}

/* ------------------------------------------------------------------------------------ *
 * Usage: run → skill version, and skill version → runs
 * ------------------------------------------------------------------------------------ */

export interface SkillVersionRunSummary {
  runId: string;
  kind: 'extraction' | 'consultant-brief' | 'consultant-reasoning';
  projectId: string | null;
  sourceId: string | null;
  providerId: string;
  modelLabel: string;
  status: string;
  startedAt: string;
  promptSha256: string;
  skillSha256: string;
}

/**
 * Every run that used one revision, across both model-calling subsystems.
 *
 * This is the other half of run provenance: `readExtractionRunProvenance` answers
 * "which revision produced this run", and this answers "which runs did this
 * revision produce". Both directions are needed before a published revision can
 * be judged on evidence rather than on intent.
 */
export function readRunsForSkillVersion(db: DatabaseSync, skillId: string, version: string, limit = 100): SkillVersionRunSummary[] {
  const extraction = db.prepare(`SELECT id, project_id, source_id, provider_id, model_label, status, started_at, prompt_sha256, skill_sha256
    FROM extraction_runs WHERE skill_id = ? AND skill_version = ? ORDER BY started_at DESC LIMIT ?`)
    .all(skillId, version, limit) as Array<Record<string, unknown>>;
  const briefs = db.prepare(`SELECT id, project_id, provider_id, model_label, status, created_at, prompt_sha256, skill_sha256
    FROM consultant_brief_runs WHERE skill_id = ? AND skill_version = ? ORDER BY created_at DESC LIMIT ?`)
    .all(skillId, version, limit) as Array<Record<string, unknown>>;
  // The third model-calling subsystem. Omitting it made the Settings panel
  // report zero recorded uses for a revision that had genuinely produced a run,
  // which is precisely the "published on intent rather than evidence" problem
  // run provenance exists to prevent.
  const reasoning = db.prepare(`SELECT id, project_id, provider_id, model_label, status, created_at, prompt_sha256, skill_sha256
    FROM consultant_reasoning_runs WHERE skill_id = ? AND skill_version = ? ORDER BY created_at DESC LIMIT ?`)
    .all(skillId, version, limit) as Array<Record<string, unknown>>;
  const combined: SkillVersionRunSummary[] = [
    ...reasoning.map((row) => ({
      runId: String(row.id), kind: 'consultant-reasoning' as const, projectId: row.project_id ? String(row.project_id) : null, sourceId: null,
      providerId: String(row.provider_id), modelLabel: String(row.model_label), status: String(row.status), startedAt: String(row.created_at),
      promptSha256: String(row.prompt_sha256), skillSha256: row.skill_sha256 ? String(row.skill_sha256) : '',
    })),
    ...extraction.map((row) => ({
      runId: String(row.id), kind: 'extraction' as const, projectId: row.project_id ? String(row.project_id) : null, sourceId: row.source_id ? String(row.source_id) : null,
      providerId: String(row.provider_id), modelLabel: String(row.model_label), status: String(row.status), startedAt: String(row.started_at),
      promptSha256: String(row.prompt_sha256), skillSha256: String(row.skill_sha256),
    })),
    ...briefs.map((row) => ({
      runId: String(row.id), kind: 'consultant-brief' as const, projectId: row.project_id ? String(row.project_id) : null, sourceId: null,
      providerId: String(row.provider_id), modelLabel: String(row.model_label), status: String(row.status), startedAt: String(row.created_at),
      promptSha256: String(row.prompt_sha256), skillSha256: row.skill_sha256 ? String(row.skill_sha256) : '',
    })),
  ];
  return combined.sort((left, right) => (left.startedAt < right.startedAt ? 1 : left.startedAt > right.startedAt ? -1 : 0)).slice(0, limit);
}

function usageCount(db: DatabaseSync, skillId: string, version: string): number {
  const extraction = db.prepare('SELECT count(*) count FROM extraction_runs WHERE skill_id = ? AND skill_version = ?').get(skillId, version) as { count: number };
  const briefs = db.prepare('SELECT count(*) count FROM consultant_brief_runs WHERE skill_id = ? AND skill_version = ?').get(skillId, version) as { count: number };
  const reasoning = db.prepare('SELECT count(*) count FROM consultant_reasoning_runs WHERE skill_id = ? AND skill_version = ?').get(skillId, version) as { count: number };
  return Number(extraction.count) + Number(briefs.count) + Number(reasoning.count);
}

/* ------------------------------------------------------------------------------------ *
 * The Settings catalogue
 * ------------------------------------------------------------------------------------ */

export interface SkillCatalogueVersion extends SkillRevisionRecord {
  recordedUses: number;
  lastUsedAt: string | null;
  latestBenchmark: SkillBenchmarkRecord | null;
  benchmarkCount: number;
  pinnedProjects: Array<{ projectId: string; projectCode: string | null; projectName: string | null; pinnedBy: string; pinnedAt: string }>;
  /** True when the file this revision was registered from is present and still hashes to its registered body. */
  bodyAvailable: boolean;
  bodyIssue: string | null;
}

export interface SkillCatalogueEntry {
  skillId: string;
  name: string;
  purpose: string | null;
  /** The code path that resolves this skill, or null when nothing reads it yet. */
  consumedBy: string | null;
  activeVersion: string | null;
  versions: SkillCatalogueVersion[];
}

/**
 * Everything Settings → AI Skills & Prompts needs, in one read.
 *
 * No revision body is included: the list is metadata, and a body is fetched
 * explicitly per version so that reading one is a deliberate act with its own
 * route rather than a side effect of opening a settings page.
 */
export function readSkillCatalogue(db: DatabaseSync, options: LoadSkillRegistryOptions = {}): SkillCatalogueEntry[] {
  let assets: SkillRevisionAsset[] = [];
  let loadError: string | null = null;
  try {
    assets = loadSkillRegistry(options);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  const assetByKey = new Map(assets.map((asset) => [`${asset.skillId}@${asset.version}`, asset]));
  const records = readSkillRevisions(db);
  const bySkill = new Map<string, SkillRevisionRecord[]>();
  for (const record of records) {
    const list = bySkill.get(record.skillId) ?? [];
    list.push(record);
    bySkill.set(record.skillId, list);
  }
  const entries: SkillCatalogueEntry[] = [];
  for (const [skillId, list] of [...bySkill.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const ordered = [...list].sort((left, right) => compareSkillVersions(left.version, right.version));
    const active = ordered.find((record) => record.status === 'active') ?? null;
    const latest = ordered.at(-1)!;
    entries.push({
      skillId,
      name: (active ?? latest).name,
      purpose: (active ?? latest).purpose,
      consumedBy: SKILL_CONSUMERS[skillId] ?? null,
      activeVersion: active?.version ?? null,
      versions: ordered.map((record) => {
        const asset = assetByKey.get(`${record.skillId}@${record.version}`);
        const benchmarks = readSkillBenchmarks(db, { skillId: record.skillId, version: record.version, limit: 50 });
        const pins = db.prepare(`SELECT p.project_id, p.pinned_by, p.pinned_at, pr.code, pr.name
          FROM extraction_skill_pins p LEFT JOIN projects pr ON pr.id = p.project_id
          WHERE p.skill_id = ? AND p.version = ? ORDER BY p.project_id`).all(record.skillId, record.version) as Array<Record<string, unknown>>;
        const lastRun = readRunsForSkillVersion(db, record.skillId, record.version, 1)[0] ?? null;
        return {
          ...record,
          recordedUses: usageCount(db, record.skillId, record.version),
          lastUsedAt: lastRun?.startedAt ?? null,
          latestBenchmark: benchmarks[0] ?? null,
          benchmarkCount: benchmarks.length,
          pinnedProjects: pins.map((pin) => ({
            projectId: String(pin.project_id),
            projectCode: pin.code ? String(pin.code) : null,
            projectName: pin.name ? String(pin.name) : null,
            pinnedBy: String(pin.pinned_by),
            pinnedAt: String(pin.pinned_at),
          })),
          bodyAvailable: Boolean(asset) && asset!.sha256 === record.sha256,
          bodyIssue: loadError
            ?? (!asset
              ? 'The revision file is not present in any registry directory on this machine.'
              : asset.sha256 !== record.sha256
                ? 'The revision file no longer hashes to its registered body; it has been rewritten in place.'
                : null),
        };
      }),
    });
  }
  return entries;
}
