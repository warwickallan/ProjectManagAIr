/**
 * Deterministic thematic grouping.
 *
 * WHY THIS IS NOT A MODEL CALL
 * ----------------------------
 * "Which records are about the same thing" is answerable from structure the
 * project already holds: explicit relationships, supersession, work packages,
 * named entities, shared source segments and ownership. Spending a model call to
 * recover something the database already knows is both slower and less
 * trustworthy — the answer would change between two identical page loads.
 *
 * So the grouping is computed here, deterministically, and the model — when the
 * consultant explicitly asks for it — is given the groups and asked only for the
 * reasoning across them. That division is what keeps the default project
 * overview, the Meeting Brief and Needs Warwick at exactly zero provider calls.
 *
 * WHAT IS AND IS NOT AN EDGE
 * --------------------------
 * The failure mode to design against is the opposite of missing a theme: it is
 * sweeping unrelated rows into one because they share ordinary project
 * vocabulary. Every register row in an implementation project says "data",
 * "system", "customer", "update". A grouping built on that is worse than no
 * grouping, because it reads as insight.
 *
 * Structural edges — an explicit relationship, a supersession, a shared work
 * package, a shared named entity, anchors into the same passage of the same
 * source — are trusted outright: something in the project asserted them.
 *
 * Lexical similarity is trusted only when it is BOTH strong and DISTINCTIVE: at
 * least two shared tokens, Dice similarity at or above a high threshold, and at
 * least one shared token that is rare across this project's own rows. The
 * rarity test is computed from the project, so a word that is generic *here*
 * cannot join two records however common or uncommon it is in English.
 */

import type { DatabaseSync } from 'node:sqlite';
import { isUnownedOwner, isProjectConsultantOwner } from './registerProjection.js';

export const THEME_ENGINE_VERSION = 'deterministic-themes-v1';

/** Dice similarity two titles must reach before lexical evidence counts at all. */
export const THEME_TITLE_SIMILARITY = 0.6;

/** Shared meaningful tokens required alongside that similarity. */
export const THEME_MIN_SHARED_TOKENS = 2;

/**
 * A token appearing in more than this share of a project's rows is generic
 * *for this project* and cannot, on its own, justify a lexical edge.
 */
export const THEME_GENERIC_TOKEN_RATIO = 0.25;

/** How far apart two anchors may be and still count as the same passage. */
export const THEME_SEGMENT_RADIUS = 6;

/**
 * Below this many open rows, document frequency cannot distinguish a project's
 * generic vocabulary from a theme's, so no lexical edge is drawn at all.
 */
export const MIN_ROWS_FOR_LEXICAL_EDGES = 12;

/** Matches a name only at word boundaries, so "Ops" cannot match "workshops". */
function wordBoundaryRegex(name: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
}

export type ThemeEdgeKind =
  | 'related-id'
  | 'supersession'
  | 'work-package'
  | 'entity'
  | 'shared-source-passage'
  | 'distinctive-title';

export interface ThemeRow {
  id: string;
  registerName: string;
  title: string;
  summary: string;
  status: string;
  owner: string | null;
  dueDate: string | null;
  score: number;
  band: string;
  blocking: boolean;
  conflict: boolean;
  severity: string | null;
  /** True when the latest applied source touched this row: the "changes since" signal. */
  latestSource: boolean;
  consultantOwned: boolean;
  customerOwned: boolean;
  unowned: boolean;
  overdue: boolean;
  superseded: boolean;
  anchors: Array<{ sourceId: string; segmentSeq: number }>;
  workPackages: string[];
  relatedIds: string[];
  supersedesIds: string[];
}

export type ProjectTheme = {
  id: string;
  label: string;
  /** Every reason this group holds together, so the grouping is answerable. */
  basis: Array<{ kind: ThemeEdgeKind; detail: string }>;
  memberIds: string[];
  registerCounts: Record<string, number>;
  actionCount: number;
  milestoneCount: number;
  unresolvedDecisionCount: number;
  openQuestionCount: number;
  riskIssueCount: number;
  uncertaintyCount: number;
  customerDependency: boolean;
  consultantOwnedCount: number;
  blockingCount: number;
  overdueCount: number;
  conflictCount: number;
  sourceAnchorCount: number;
  earliestDueDate: string | null;
  topScore: number;
}

export interface ProjectThemeResult {
  engineVersion: THEME_ENGINE_VERSION_TYPE;
  themes: ProjectTheme[];
  /** Rows that legitimately belong to no theme. Never forced into one. */
  ungroupedIds: string[];
  rows: ThemeRow[];
}

type THEME_ENGINE_VERSION_TYPE = typeof THEME_ENGINE_VERSION;

const CLOSED_STATUS = /resolved|closed|complete|superseded|rejected|ratified|done|cancelled/i;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'them', 'then', 'there',
  'they', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your', 'we', 'our', 'not', 'can', 'should',
  'need', 'needs', 'must', 'may', 'about', 'after', 'before', 'when', 'which', 'who', 'what', 'how',
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function dice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function sharedTokens(left: Set<string>, right: Set<string>): string[] {
  const result: string[] = [];
  for (const token of left) if (right.has(token)) result.push(token);
  return result.sort();
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(value: string): string {
    const seen = this.parent.get(value);
    if (seen === undefined) { this.parent.set(value, value); return value; }
    if (seen === value) return value;
    const root = this.find(seen);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    // Union by identifier, never by insertion order or size: the resulting
    // grouping must be identical on two machines reading the same database.
    if (a === b) return;
    if (a < b) this.parent.set(b, a);
    else this.parent.set(a, b);
  }
}

/**
 * A JSON array column, read defensively.
 *
 * `?? '[]'` covers NULL but not the empty string, and a single `''` in one row
 * would throw out of `readThemeRows` — taking down every project route, because
 * the deterministic views are on the project payload. A malformed value means
 * "no tags", not "the project cannot be opened".
 */
function jsonStringArray(value: unknown): string[] {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readThemeRows(db: DatabaseSync, projectId: string): ThemeRow[] {
  const rows = db.prepare(`SELECT r.external_register_id, r.register_name, r.title, r.summary, r.related_ids_json, r.supersession_ids_json, r.work_package_tags_json, r.record_status,
      s.status, s.owner, s.due_date, sc.score, sc.band, sc.inputs_json
    FROM project_register_rows r
    JOIN register_row_state s ON s.project_id = r.project_id AND s.external_register_id = r.external_register_id
    JOIN register_row_scores sc ON sc.project_id = r.project_id AND sc.external_register_id = r.external_register_id
    WHERE r.project_id = ? ORDER BY r.external_register_id`).all(projectId) as Array<Record<string, unknown>>;
  const today = db.prepare("SELECT date('now') today").get() as { today: string };
  // One ordered read instead of one query per row. The explicit ORDER BY is what
  // makes `anchors[0]` — which reaches the selection hash as a record's evidence
  // — a property of the data rather than of physical row order, which changes
  // whenever a source is re-applied.
  const anchorsByRow = new Map<string, Array<{ sourceId: string; segmentSeq: number }>>();
  for (const anchor of db.prepare('SELECT external_register_id, source_id, segment_id FROM register_row_anchors WHERE project_id = ? ORDER BY external_register_id, source_id, segment_id, rowid').all(projectId) as Array<Record<string, unknown>>) {
    const parsed = /:seg:(\d+)$/.exec(String(anchor.segment_id));
    if (!parsed) continue;
    const key = String(anchor.external_register_id);
    anchorsByRow.set(key, [...(anchorsByRow.get(key) ?? []), { sourceId: String(anchor.source_id), segmentSeq: Number(parsed[1]) }]);
  }
  // The project's consultant owner, read once. `isProjectConsultantOwner` issues
  // its own query per call, which made ownership classification an N+1 over every
  // register row on the project-open path.
  const consultantOwners = new Map<string, boolean>();
  const classifyOwner = (owner: string | null): boolean => {
    const key = owner ?? '';
    if (!consultantOwners.has(key)) consultantOwners.set(key, isProjectConsultantOwner(db, projectId, owner));
    return consultantOwners.get(key)!;
  };
  return rows.map((row) => {
    const inputs = JSON.parse(String(row.inputs_json)) as Record<string, unknown>;
    const owner = row.owner === null || row.owner === undefined ? null : String(row.owner);
    const unowned = isUnownedOwner(owner);
    const consultantOwned = !unowned && classifyOwner(owner);
    const dueDate = row.due_date ? String(row.due_date) : null;
    return {
      id: String(row.external_register_id),
      registerName: String(row.register_name),
      title: String(row.title),
      summary: String(row.summary ?? ''),
      status: String(row.status),
      owner,
      dueDate,
      score: Number(row.score),
      band: String(row.band),
      blocking: Boolean(inputs.blocking),
      conflict: Number(inputs.conflict ?? 0) > 0,
      severity: inputs.severity ? String(inputs.severity) : null,
      latestSource: Number(inputs.latestSource ?? 0) > 0,
      consultantOwned,
      customerOwned: !unowned && !consultantOwned,
      unowned,
      overdue: Boolean(dueDate && dueDate < today.today && !CLOSED_STATUS.test(String(row.status))),
      superseded: String(row.record_status) === 'superseded',
      // An anchor whose segment id does not carry a parseable sequence is
      // DROPPED, never defaulted. Defaulting to zero put every such anchor at
      // the same point of the same source, and `shared-source-passage` is a
      // structural edge trusted outright — so one malformed id shape swept every
      // anchored row in a source into a single theme.
      anchors: anchorsByRow.get(String(row.external_register_id)) ?? [],
      workPackages: jsonStringArray(row.work_package_tags_json),
      relatedIds: jsonStringArray(row.related_ids_json),
      supersedesIds: jsonStringArray(row.supersession_ids_json),
    };
  });
}

/** Entity names and aliases, used to join rows that name the same thing. */
function readEntityNames(db: DatabaseSync, projectId: string): Array<{ id: string; names: string[] }> {
  const rows = db.prepare('SELECT external_register_id, entity_name, aliases_json FROM register_entities WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.external_register_id),
    names: [String(row.entity_name), ...jsonStringArray(row.aliases_json)]
      .map((name) => name.trim())
      // A short name is not a name for matching purposes: "Ops" as a substring
      // matches "workshops". The word-boundary test below is the real guard;
      // this is belt and braces.
      .filter((name) => name.length >= 3),
  }));
}

/**
 * Group a project's register rows into themes.
 *
 * Pure function of stored state: no clock beyond SQLite's own `date('now')` for
 * the overdue flag, no randomness, no provider. Running it twice on an unchanged
 * database produces byte-identical output, which is what lets a synthesis be
 * cached against it.
 */
export function buildProjectThemes(db: DatabaseSync, projectId: string): ProjectThemeResult {
  const rows = readThemeRows(db, projectId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const open = rows.filter((row) => !row.superseded);
  const tokenSets = new Map(open.map((row) => [row.id, new Set(tokens(`${row.title} ${row.summary}`))]));

  // Document frequency across this project's own rows. A token in more than
  // THEME_GENERIC_TOKEN_RATIO of them describes the project, not a theme.
  const frequency = new Map<string, number>();
  for (const set of tokenSets.values()) for (const token of set) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  // The floor is three, not two. A token shared by exactly two rows is the
  // normal shape of a real theme in a small project — "permit escalation" across
  // a configure row and a test row — and a floor of two declared precisely that
  // case generic, which both suppressed the edge and left the theme unnameable.
  // Genuinely generic vocabulary is what three or more rows share.
  const genericCutoff = Math.max(3, Math.ceil(open.length * THEME_GENERIC_TOKEN_RATIO));
  const distinctive = (token: string) => (frequency.get(token) ?? 0) < genericCutoff;

  const union = new UnionFind();
  const edges: Array<{ left: string; right: string; kind: ThemeEdgeKind; detail: string }> = [];
  const link = (left: string, right: string, kind: ThemeEdgeKind, detail: string) => {
    if (left === right || !byId.has(left) || !byId.has(right)) return;
    union.union(left, right);
    const [a, b] = left < right ? [left, right] : [right, left];
    edges.push({ left: a, right: b, kind, detail });
  };

  for (const row of open) {
    union.find(row.id);
    for (const related of row.relatedIds) link(row.id, related, 'related-id', `${row.id} names ${related} as a related record.`);
    for (const superseded of row.supersedesIds) link(row.id, superseded, 'supersession', `${row.id} supersedes ${superseded}.`);
  }

  const byWorkPackage = new Map<string, string[]>();
  for (const row of open) for (const tag of row.workPackages) byWorkPackage.set(tag, [...(byWorkPackage.get(tag) ?? []), row.id]);
  for (const [tag, members] of byWorkPackage) {
    for (let index = 1; index < members.length; index += 1) link(members[0], members[index], 'work-package', `Both sit in work package "${tag}".`);
  }

  // Two rows anchored within a few segments of each other in the same source are
  // talking about the same passage of the same conversation.
  const anchorsBySource = new Map<string, Array<{ id: string; seq: number }>>();
  for (const row of open) {
    for (const anchor of row.anchors) {
      anchorsBySource.set(anchor.sourceId, [...(anchorsBySource.get(anchor.sourceId) ?? []), { id: row.id, seq: anchor.segmentSeq }]);
    }
  }
  for (const [sourceId, anchors] of anchorsBySource) {
    const ordered = [...anchors].sort((left, right) => (left.seq - right.seq) || (left.id < right.id ? -1 : 1));
    for (let index = 0; index < ordered.length; index += 1) {
      for (let next = index + 1; next < ordered.length && ordered[next].seq - ordered[index].seq <= THEME_SEGMENT_RADIUS; next += 1) {
        if (ordered[next].id === ordered[index].id) continue;
        link(ordered[index].id, ordered[next].id, 'shared-source-passage', `Both are anchored within ${THEME_SEGMENT_RADIUS} segments of each other in ${sourceId}.`);
      }
    }
  }

  for (const entity of readEntityNames(db, projectId)) {
    // Whole-word matching, not substring. An unanchored `includes` let the
    // entity "Ops" join "workshops" to "laptops", and "Data" join three
    // unrelated rows through "database", "metadata" and "data protection" — the
    // exact generic-vocabulary grouping the rest of this module refuses to do.
    const distinctiveName = (name: string) => {
      const parts = tokens(name);
      // A name made entirely of vocabulary this project uses everywhere cannot
      // identify a theme, whatever the entity register calls it.
      return parts.length > 0 && parts.some(distinctive);
    };
    const usable = entity.names.filter(distinctiveName);
    if (usable.length === 0) continue;
    const mentions = open.filter((row) => usable.some((name) => wordBoundaryRegex(name).test(`${row.title} ${row.summary}`)));
    // An entity everything mentions is the project's own name, not a theme.
    if (mentions.length < 2 || mentions.length > genericCutoff) continue;
    for (let index = 1; index < mentions.length; index += 1) {
      link(mentions[0].id, mentions[index].id, 'entity', `Both name ${usable[0]}.`);
    }
  }

  // Lexical similarity last, and only where it is strong AND distinctive.
  //
  // With fewer than MIN_ROWS_FOR_LEXICAL_EDGES open rows, document frequency
  // measures nothing: in a two-row project every token appears in at most two
  // rows, so every token is "distinctive" and two rows about "customer data
  // system update" group on exactly the vocabulary this module exists to
  // ignore. Below that floor the grouping is structural only.
  for (let index = 0; open.length >= MIN_ROWS_FOR_LEXICAL_EDGES && index < open.length; index += 1) {
    for (let next = index + 1; next < open.length; next += 1) {
      const left = tokenSets.get(open[index].id)!;
      const right = tokenSets.get(open[next].id)!;
      const shared = sharedTokens(left, right);
      if (shared.length < THEME_MIN_SHARED_TOKENS) continue;
      if (dice(left, right) < THEME_TITLE_SIMILARITY) continue;
      const distinctiveShared = shared.filter(distinctive);
      // The whole guard: strong overlap made entirely of project-generic words
      // joins nothing.
      if (distinctiveShared.length === 0) continue;
      link(open[index].id, open[next].id, 'distinctive-title', `Both are about ${distinctiveShared.slice(0, 3).join(', ')}.`);
    }
  }

  const groups = new Map<string, string[]>();
  for (const row of open) {
    const root = union.find(row.id);
    groups.set(root, [...(groups.get(root) ?? []), row.id]);
  }

  const themes: ProjectTheme[] = [];
  const ungroupedIds: string[] = [];
  for (const [root, memberIds] of [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (memberIds.length < 2) { ungroupedIds.push(...memberIds); continue; }
    const members = memberIds.map((id) => byId.get(id)!).sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
    const memberSet = new Set(memberIds);
    const basis = edges
      .filter((edge) => memberSet.has(edge.left) && memberSet.has(edge.right))
      .map((edge) => ({ kind: edge.kind, detail: edge.detail }));
    const registerCounts: Record<string, number> = {};
    for (const member of members) registerCounts[member.registerName] = (registerCounts[member.registerName] ?? 0) + 1;
    const dueDates = members.map((member) => member.dueDate).filter((value): value is string => Boolean(value)).sort();
    themes.push({
      id: `theme:${projectId}:${root}`,
      label: themeLabel(members, distinctive),
      basis: dedupeBasis(basis),
      memberIds: members.map((member) => member.id),
      registerCounts,
      actionCount: registerCounts.Actions ?? 0,
      milestoneCount: registerCounts.Milestones ?? 0,
      unresolvedDecisionCount: members.filter((member) => member.registerName === 'Decisions' && !CLOSED_STATUS.test(member.status)).length,
      openQuestionCount: members.filter((member) => member.registerName === 'Open_Questions' && !CLOSED_STATUS.test(member.status)).length,
      riskIssueCount: registerCounts.Risks_Issues ?? 0,
      uncertaintyCount: registerCounts.Uncertainty ?? 0,
      customerDependency: members.some((member) => member.customerOwned && !CLOSED_STATUS.test(member.status)),
      consultantOwnedCount: members.filter((member) => member.consultantOwned || member.unowned).length,
      blockingCount: members.filter((member) => member.blocking).length,
      overdueCount: members.filter((member) => member.overdue).length,
      conflictCount: members.filter((member) => member.conflict).length,
      sourceAnchorCount: members.reduce((total, member) => total + member.anchors.length, 0),
      earliestDueDate: dueDates[0] ?? null,
      topScore: members[0]?.score ?? 0,
    });
  }

  return {
    engineVersion: THEME_ENGINE_VERSION,
    themes: themes.sort((left, right) => right.topScore - left.topScore || (left.id < right.id ? -1 : 1)),
    ungroupedIds: ungroupedIds.sort(),
    rows,
  };
}

function dedupeBasis(basis: Array<{ kind: ThemeEdgeKind; detail: string }>): Array<{ kind: ThemeEdgeKind; detail: string }> {
  const seen = new Set<string>();
  const result: Array<{ kind: ThemeEdgeKind; detail: string }> = [];
  for (const entry of basis) {
    const key = `${entry.kind}:${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  // Bounded so a large theme's basis stays readable; the count is what matters
  // beyond the first few.
  return result.slice(0, 12);
}

/**
 * Name a theme from the distinctive vocabulary its members actually share.
 *
 * A work package name wins when there is one, because somebody chose it
 * deliberately. Otherwise the two most distinctive tokens common to the most
 * members, which produces labels like "permit mapping" rather than "data".
 */
function themeLabel(members: ThemeRow[], distinctive: (token: string) => boolean): string {
  const workPackage = members.flatMap((member) => member.workPackages).sort()[0];
  if (workPackage) return workPackage;
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const token of new Set(tokens(member.title))) {
      if (!distinctive(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([leftToken, leftCount], [rightToken, rightCount]) => rightCount - leftCount || (leftToken < rightToken ? -1 : 1))
    .slice(0, 2)
    .map(([token]) => token);
  if (ranked.length > 0) return ranked.join(' / ');
  // Nothing distinctive is shared by two members, so the theme is held together
  // structurally. Say so rather than inventing a label from generic words.
  return `${members[0].id} and ${members.length - 1} related record${members.length === 2 ? '' : 's'}`;
}
