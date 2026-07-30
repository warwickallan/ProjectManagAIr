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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      throw new SkillRegistryError(`Unknown front matter key "${key}"; expected ${REQUIRED_KEYS.join(', ')}`, file);
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
    body,
    sha256: sha256(body),
    source,
    file,
    characters: body.length,
  };
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
  const seeds = loadSkillRegistry({ ...options, externalDir: null }).filter((asset) => asset.skillId === skillId);
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
      db.prepare(`INSERT INTO extraction_skills (skill_id, version, sha256, prompt_template_version, status, source, notes, created_at, promoted_at, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(asset.skillId, asset.version, asset.sha256, asset.promptTemplateVersion, status, asset.source, asset.notes, nowIso(), status === 'retired' ? nowIso() : null);
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
    if (templateChanged || notesChanged || sourceChanged) {
      db.prepare('UPDATE extraction_skills SET prompt_template_version = ?, notes = ?, source = ? WHERE skill_id = ? AND version = ?')
        .run(asset.promptTemplateVersion, asset.notes, asset.source, asset.skillId, asset.version);
      audit(db, {
        skillId: asset.skillId,
        version: asset.version,
        event: 'refreshed',
        toStatus: String(existing.status) as SkillStatus,
        actor,
        note: [templateChanged ? `promptTemplateVersion=${asset.promptTemplateVersion}` : null, notesChanged ? 'notes' : null, sourceChanged ? `source=${asset.source}` : null].filter(Boolean).join(' '),
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
  if (readActiveSkillRevision(db, options.skillId ?? DEFAULT_EXTRACTION_SKILL_ID)) return null;
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
