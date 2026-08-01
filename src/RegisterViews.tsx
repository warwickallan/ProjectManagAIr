import { useEffect, useMemo, useState } from 'react';
import type { ProjectResponse } from './api';
import { EmptyState, Section, StatusChip, formatDate, formatDateTime, humanize, postJson } from './components';

/**
 * The granular register surface.
 *
 * These components used to live inside `ProjectPage.tsx` and were reachable
 * only from the per-register tabs. They are extracted verbatim so the same
 * table and drawer can back both the legacy per-register tabs and the single
 * "Mined Data" workspace, without a second implementation drifting from this
 * one. Nothing here changed behaviour in the move.
 */

type Project = ProjectResponse['project'];
type JsonRecord = Record<string, unknown>;

export type RegisterRow = Project['registerRows'][number] & {
  derivation?: string;
  confidence?: string;
  dueDateRaw?: string | null;
  dueDateConfidence?: string;
  typedDetails?: JsonRecord;
  anchors?: Array<{ id: string; sourceId: string; segmentId: string; speaker: string | null; tMs: number | null; quote: string | null; verified: boolean }>;
  events?: Array<{ id: string; occurredAt: string; actor: string; eventType: string; field: string | null; previousValue: string | null; newValue: string | null; reason: string; evidenceRef: string | null; origin: 'source' | 'human' | 'system' }>;
  currentState?: { status: string; owner: string | null; dueDate: string | null; resolution: string | null; lastHumanEventAt: string | null } | null;
  score?: { value: number; band: string; inputs: JsonRecord; scoringVersion: string } | null;
};

/**
 * Which project tab owns each register. Lives here rather than in
 * `ProjectPage` because `registerRowRoute` — used by the drawer's relationship
 * links — needs it, and a register row must resolve to the same deep link
 * wherever it is rendered from.
 */
export const registerForTab: Record<string, string | undefined> = {
  actions: 'Actions', risks: 'Risks_Issues', decisions: 'Decisions', 'config-changes': 'Config_Changes', 'open-questions': 'Open_Questions', milestones: 'Milestones', entities: 'Entities', uncertainty: 'Uncertainty', sources: 'Sources',
};

/**
 * Every register-row citation and relationship link — from a Consultant
 * Reasoning matter's supporting records to a row's own "related" list — opens
 * Mined Data at the correct register sub-tab with the row focused, never a
 * removed legacy per-register primary tab.
 */
export function registerRowRoute(projectId: string, registerName: string, rowId: string) {
  return `#/projects/${encodeURIComponent(projectId)}/mined-data?register=${encodeURIComponent(registerName)}&record=${encodeURIComponent(rowId)}`;
}

export function RegisterTable({ title, registerName, rows, comparisonRows, focusedRecordId, userId, onChanged }: { title: string; registerName: string; rows: RegisterRow[]; comparisonRows: Project['registerComparisonRows']; focusedRecordId: string | null; userId?: string; onChanged?: () => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'id' | 'title' | 'status'>('id');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const statuses = useMemo(() => statusFilterOptions(registerName, rows.map(currentRowStatus)), [registerName, rows]);
  const filtered = rows.filter((row) => {
    const haystack = `${row.externalRegisterId} ${row.title} ${row.summary} ${currentRowStatus(row)} ${row.sourceRef ?? ''} ${row.sourceAnchor ?? ''}`.toLowerCase();
    return (status === 'all' || currentRowStatus(row) === status) && haystack.includes(search.toLowerCase());
  }).toSorted((a, b) => sortValue(a, sort).localeCompare(sortValue(b, sort)));
  const selected = rows.find((row) => row.externalRegisterId === (focusedRecordId ?? selectedId)) ?? null;
  const selectRow = (row: RegisterRow) => { setSelectedId(row.externalRegisterId); window.location.hash = `${window.location.hash.split('?')[0]}?record=${encodeURIComponent(row.externalRegisterId)}`; };
  return (
    <Section id={registerName} title={title} kicker="SQLite register" count={filtered.length}>
      <p className="table-hint">Select a row or choose Update to review evidence, add notes and change its current state.</p>
      <div className="table-tools"><input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search IDs, titles, sources" /><select className="input" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select className="input" value={sort} onChange={(event) => setSort(event.target.value as 'id' | 'title' | 'status')}><option value="id">Sort by ID</option><option value="title">Sort by title</option><option value="status">Sort by status</option></select><span>{filtered.length} rows</span></div>
      {filtered.length === 0 ? <EmptyState>No register rows loaded.</EmptyState> : <div className="table-wrap dense-table"><table><thead><tr><th>ID</th><th>Title</th><th>Importance</th><th>Status</th><th>Owner / due</th><th>Source</th><th>Related</th><th>Update</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id} onClick={() => selectRow(row)}><td><button className="inline-button">{row.externalRegisterId}</button></td><td><strong>{row.title}</strong><small>{row.summary}</small></td><td>{row.score ? <span className={`importance-band band-${row.score.band.toLowerCase()}`}>{row.score.band} / {row.score.value}</span> : '-'}</td><td><StatusChip value={currentRowStatus(row)} /></td><td>{row.currentState?.owner ?? row.owner ?? 'Unassigned'}<small>{formatDate(row.currentState?.dueDate ?? row.dueDate)}</small></td><td>{row.sourceRef ?? '-'}<small>{row.sourceAnchor ?? ''}</small></td><td>{[...row.relatedIds, ...row.supersessionIds].join(', ') || '-'}</td><td><button type="button" className="row-update-button" aria-label={`Update ${row.externalRegisterId}: ${row.title}`} onClick={(event) => { event.stopPropagation(); selectRow(row); }}>Update <span aria-hidden="true">{'›'}</span></button></td></tr>)}</tbody></table></div>}
      {selected ? <RegisterDetail row={selected} comparisonRows={comparisonRows.filter((row) => row.externalRegisterId === selected.externalRegisterId)} userId={userId} onChanged={onChanged} onClose={() => { setSelectedId(null); window.location.hash = window.location.hash.split('?')[0]; }} /> : null}
    </Section>
  );
}

export function RegisterDetail({ row, comparisonRows, userId, onChanged, onClose }: { row: RegisterRow; comparisonRows: Project['registerComparisonRows']; userId?: string; onChanged?: () => void; onClose: () => void }) {
  const current = row.currentState;
  return <aside className="detail-drawer intelligence-drawer" role="dialog" aria-modal="true" aria-labelledby="register-detail-title">
    <header><div><p className="section-kicker">{humanize(row.registerName)}</p><h3 id="register-detail-title">{row.externalRegisterId}</h3></div><button className="button secondary" onClick={onClose}>Close</button></header>
    <div className="drawer-title"><div><h4>{row.title}</h4><p>{row.summary}</p></div>{row.score ? <span className={`importance-band band-${row.score.band.toLowerCase()}`}>{row.score.band} / score {row.score.value}</span> : null}</div>
    {onChanged ? <><h4>Update current state</h4><RegisterUpdateForm row={row} userId={userId ?? 'current-user'} onChanged={onChanged} /></> : null}
    <h4>Projected current state</h4><dl className="inline-details"><div><dt>Status</dt><dd>{humanize(current?.status ?? row.recordStatus)}</dd></div><div><dt>Owner</dt><dd>{current?.owner ?? row.owner ?? 'Unassigned'}</dd></div><div><dt>Due date</dt><dd>{formatDate(current?.dueDate ?? row.dueDate)}</dd></div><div><dt>Resolution</dt><dd>{current?.resolution ?? 'Not recorded'}</dd></div><div><dt>Last human event</dt><dd>{current?.lastHumanEventAt ? formatDateTime(current.lastHumanEventAt) : 'None'}</dd></div><div><dt>Scoring version</dt><dd>{row.score?.scoringVersion ?? 'Not scored'}</dd></div></dl>
    <h4>Typed register detail</h4><DetailFieldList values={row.typedDetails ?? {}} empty="No typed detail is stored for this row." />
    <h4>Importance explanation</h4><DetailFieldList values={row.score?.inputs ?? {}} empty="No scoring inputs are available." />
    <h4>Evidence and source anchors</h4>{(row.anchors ?? []).length === 0 ? <EmptyState>No mechanically resolved anchors are available.</EmptyState> : <ol className="anchor-list">{(row.anchors ?? []).map((anchor) => <li key={anchor.id}><div className="anchor-meta"><StatusChip value={anchor.verified ? 'verified' : 'failed'} label={anchor.verified ? 'Verified quote' : 'Unverified'} /><span>{anchor.speaker ?? 'Unknown speaker'}</span><span>{formatAnchorTime(anchor.tMs)}</span></div><blockquote>{anchor.quote ?? 'No quotation retained.'}</blockquote><small>Source {anchor.sourceId} / segment {anchor.segmentId}</small></li>)}</ol>}
    <h4>History</h4>
    <p className="inline-note">The complete timeline for this row: source-derived creation and updates, human notes and corrections, in the order they were recorded. The original mined value stays inspectable above and is never rewritten by a later event.</p>
    {(row.events ?? []).length === 0 ? <EmptyState>No events have been recorded for this row yet.</EmptyState> : <ol className="event-timeline">{(row.events ?? []).map((event) => <li key={event.id} className={`event-origin-${event.origin}`}><span className="event-dot" aria-hidden="true" /><div><div className="record-line"><strong>{humanize(event.eventType)}</strong><StatusChip value={originTone(event.origin)} label={originLabel(event.origin)} /><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time></div><p>{event.reason}</p><small>{event.actor}{event.field ? ` / ${fieldLabel(event.field)}: ${event.previousValue ?? 'empty'} -> ${event.newValue ?? 'empty'}` : ''}{event.evidenceRef ? ` / ${event.evidenceRef}` : ''}</small></div></li>)}</ol>}
    <h4>Relationships</h4><dl className="inline-details"><div><dt>Related records</dt><dd>{row.relatedIds.length ? row.relatedIds.map((id) => <a key={id} href={registerRowRoute(row.projectId, registerForId(id), id)}>{id}</a>) : '-'}</dd></div><div><dt>Supersedes / reverses</dt><dd>{row.supersessionIds.length ? row.supersessionIds.map((id) => <a key={id} href={registerRowRoute(row.projectId, registerForId(id), id)}>{id}</a>) : '-'}</dd></div><div><dt>Work packages</dt><dd>{row.workPackageTags.join(', ') || '-'}</dd></div></dl>
    <h4>Extraction and packet provenance</h4><dl className="inline-details"><div><dt>Import / extraction run</dt><dd>{row.importRunId}</dd></div><div><dt>Derivation</dt><dd>{row.derivation ?? 'fact'}</dd></div><div><dt>Confidence</dt><dd>{row.confidence ?? 'Unknown'}</dd></div><div><dt>Source reference</dt><dd>{row.sourceRef ?? '-'}</dd></div><div><dt>Source anchor</dt><dd>{row.sourceAnchor ?? '-'}</dd></div><div><dt>Original location</dt><dd>{row.originalTabName} / row {row.originalRowNumber ?? '-'}</dd></div><div><dt>Original status</dt><dd>{row.originalStatusWording ?? '-'}</dd></div><div><dt>Raw due wording</dt><dd>{row.dueDateRaw ?? '-'} ({row.dueDateConfidence ?? 'none'})</dd></div></dl>
    <details className="drawer-details"><summary>Original fields</summary><DetailFieldList values={row.rawRow} empty="No raw fields are retained." /></details>
    <details className="drawer-details"><summary>Field comparison ({comparisonRows.length})</summary><Stacked records={comparisonRows.map((item) => ({ id: item.id, title: item.fieldName ?? 'Row', text: item.detail ?? '', chip: item.comparisonStatus, details: [['Status', item.comparisonStatus]] }))} empty="No field comparison rows." /></details>
  </aside>;
}

export function DetailFieldList({ values, empty }: { values: JsonRecord; empty: string }) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <dl className="raw-field-list">{entries.map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(value)}</dd></div>)}</dl>;
}

export function Stacked({ records, empty }: { records: Array<{ id: string; title: string; text: string; chip: string; details: Array<[string, string]> }>; empty: string }) {
  if (records.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <div className="stacked-records">{records.map((record) => <article className="stacked-record" key={record.id}><div className="record-line"><div><h3>{record.title}</h3><p>{record.text}</p></div><StatusChip value={record.chip} /></div><dl className="inline-details">{record.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>)}</div>;
}

export function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayValue).join('; ');
  if (typeof value === 'object' && value) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '');
}

export function fieldLabel(value: string) { return humanize(value.replaceAll('_', '-')); }
export function formatAnchorTime(value: number | null) { if (value === null) return 'No timestamp'; const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
export function registerForId(id: string) { const marker = id.match(/-([ADRQMCESU])-/)?.[1]; return ({ A: 'Actions', D: 'Decisions', R: 'Risks_Issues', Q: 'Open_Questions', M: 'Milestones', C: 'Config_Changes', E: 'Entities', S: 'Sources', U: 'Uncertainty' } as Record<string, string>)[marker ?? ''] ?? 'Actions'; }
export function currentRowStatus(row: RegisterRow) { return row.currentState?.status ?? row.recordStatus; }
export function sortValue(row: RegisterRow, sort: 'id' | 'title' | 'status') { if (sort === 'title') return row.title; if (sort === 'status') return row.recordStatus; return row.externalRegisterId; }

/* -------------------------------------------------------------------------- *
 * Status-filter canonicalisation.
 *
 * `currentRowStatus` is either a small, fixed machine value that
 * `EVENT_TYPE_STATUS` in registerProjection.ts writes once a human event has
 * fired (`open`, `in-progress`, `blocked`, `completed`, `cancelled`,
 * `resolved`, `parked`, `ratified`, `rejected`, `superseded`, `mitigated`,
 * `accepted`, `achieved`, `missed`, `applied`, `verified`, `reverted`) or, for
 * a row no human event has ever touched, the raw status wording a source
 * document used verbatim ("To Do", "Agreed in Principle", "TBC", anything).
 * The filter dropdown used to show that raw string unmodified as both the
 * option's value and its label, so the same operational state could appear
 * under several different-looking options and every register's dropdown read
 * in whatever casing and wording its source documents happened to use.
 *
 * This groups recognised wording into the workflow vocabulary a consultant
 * actually thinks in, for the option's LABEL only. The option's `value` stays
 * the exact stored string returned by `currentRowStatus`, so filtering
 * behaviour, the event API payload and the audit trail are completely
 * unchanged — only what the option reads as changes. A raw value this
 * register's groups do not recognise is never forced into one: it falls back
 * to a plain humanized rendering of the stored string, exactly as before.
 * -------------------------------------------------------------------------- */

interface StatusGroup { label: string; rank: number; match: (normalized: string) => boolean }

function normalizeStatusText(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

const STATUS_GROUPS: Partial<Record<string, StatusGroup[]>> = {
  Actions: [
    { label: 'To do', rank: 0, match: (s) => /^(open|to-?do|not-?started|new|backlog|planned)$/.test(s) },
    { label: 'In progress', rank: 1, match: (s) => /in-?progress|started|underway|ongoing|^active$/.test(s) },
    { label: 'Blocked', rank: 2, match: (s) => /block|stuck|on-?hold|waiting/.test(s) },
    { label: 'Done', rank: 3, match: (s) => /complet|^done$|closed|resolved|finished/.test(s) },
    { label: 'Cancelled', rank: 4, match: (s) => /cancel|abandon|dropped|withdrawn/.test(s) },
  ],
  Open_Questions: [
    { label: 'Open', rank: 0, match: (s) => /^(open|pending|outstanding|awaiting|to-?do)$/.test(s) },
    { label: 'Answered', rank: 1, match: (s) => /answer|resolved|closed|complet/.test(s) },
    { label: 'Parked', rank: 2, match: (s) => /park|on-?hold|deferred/.test(s) },
  ],
  Risks_Issues: [
    { label: 'Open', rank: 0, match: (s) => /^(open|identified|new|active)$/.test(s) },
    { label: 'Mitigated', rank: 1, match: (s) => /mitigat/.test(s) },
    { label: 'Accepted', rank: 2, match: (s) => /accept/.test(s) },
    { label: 'Resolved', rank: 3, match: (s) => /resolv|closed|complet/.test(s) },
  ],
  Decisions: [
    { label: 'Proposed', rank: 0, match: (s) => /propos|draft/.test(s) },
    { label: 'Agreed in principle', rank: 1, match: (s) => /agreed-?in-?principle/.test(s) },
    { label: 'Agreed', rank: 2, match: (s) => /^agreed$/.test(s) },
    { label: 'Pending ratification', rank: 3, match: (s) => /pending-?ratification/.test(s) },
    { label: 'Ratified', rank: 4, match: (s) => /ratif|decided|approve|sign-?off|signed-?off|finalis|finaliz/.test(s) },
    { label: 'Rejected', rank: 5, match: (s) => /reject|declin/.test(s) },
    { label: 'Parked', rank: 6, match: (s) => /park|on-?hold|deferred/.test(s) },
    { label: 'Superseded', rank: 7, match: (s) => /supersed/.test(s) },
  ],
  Milestones: [
    { label: 'Upcoming', rank: 0, match: (s) => /^(not-?started|open|planned|pending|scheduled|to-?do|upcoming|forecast)$/.test(s) },
    { label: 'In progress', rank: 1, match: (s) => /in-?progress|underway|started|in-?flight|ongoing/.test(s) },
    { label: 'At risk', rank: 2, match: (s) => /at-?risk|slip|delayed|late/.test(s) },
    { label: 'Achieved', rank: 3, match: (s) => /achiev|complet|delivered|^done$|resolved|closed/.test(s) },
    { label: 'Missed', rank: 4, match: (s) => /miss|breach|overdue|not-?achieved|fail/.test(s) },
  ],
  Config_Changes: [
    { label: 'Proposed', rank: 0, match: (s) => /^(open|propos|planned|pending)$/.test(s) },
    { label: 'Applied', rank: 1, match: (s) => /appl/.test(s) },
    { label: 'Verified', rank: 2, match: (s) => /verif/.test(s) },
    { label: 'Reverted', rank: 3, match: (s) => /revert|rollback|rolled-?back/.test(s) },
  ],
  Uncertainty: [
    { label: 'Open', rank: 0, match: (s) => /^(open|uncertain|unclear|unknown)$/.test(s) },
    { label: 'Resolved', rank: 1, match: (s) => /resolv|closed|clarif/.test(s) },
  ],
  // Entities and Sources are reference-only rows with no status-change actions
  // (see `FIELD_ACTIONS_EXCLUDED` / the absence of a `STATUS_ACTIONS` entry
  // below): there is no workflow to group their status wording into, so they
  // are deliberately left out of this map and fall back to a plain humanized
  // label in whatever order the raw values sort in, exactly as before.
};

function statusGroupFor(registerName: string, raw: string): StatusGroup | undefined {
  return STATUS_GROUPS[registerName]?.find((group) => group.match(normalizeStatusText(raw)));
}

/** The status filter's options for one register: canonical label where recognised, workflow order, raw value untouched. */
export function statusFilterOptions(registerName: string, rawStatuses: string[]): Array<{ value: string; label: string }> {
  const distinct = Array.from(new Set(rawStatuses.filter(Boolean)));
  const groupMemberCounts = new Map<string, number>();
  for (const raw of distinct) {
    const group = statusGroupFor(registerName, raw);
    if (group) groupMemberCounts.set(group.label, (groupMemberCounts.get(group.label) ?? 0) + 1);
  }
  return distinct
    .toSorted((a, b) => {
      const rankDiff = (statusGroupFor(registerName, a)?.rank ?? 999) - (statusGroupFor(registerName, b)?.rank ?? 999);
      return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
    })
    .map((raw) => {
      const group = statusGroupFor(registerName, raw);
      const humanized = humanize(raw.replaceAll('_', '-'));
      // More than one raw wording maps to the same canonical group (e.g. two
      // different source spellings that both mean "open"): keep the raw
      // wording visible in parentheses so the two remain distinguishable
      // options rather than two identical-looking entries for different
      // stored values.
      const label = !group ? humanized : (groupMemberCounts.get(group.label) ?? 0) > 1 ? `${group.label} (${humanized})` : group.label;
      return { value: raw, label };
    });
}
function originTone(origin: string) { return origin === 'human' ? 'in-progress' : origin === 'system' ? 'neutral' : 'verified'; }
function originLabel(origin: string) { return origin === 'human' ? 'Human' : origin === 'system' ? 'System' : 'Source'; }

/* -------------------------------------------------------------------------- *
 * Human update surface.
 *
 * One action set per register, matching what that register's status actually
 * means (`recordRegisterEvent` in registerProjection.ts is the API this posts
 * to; `correctableFields` there is the authority on what a field event may
 * name — this list only has to agree with it, never duplicate its logic).
 * Deliberately compact: a status action, a plain field correction (owner,
 * due date) and a standalone note are the whole surface, not every column the
 * API happens to be able to reach.
 * -------------------------------------------------------------------------- */

interface StatusAction { id: string; label: string; eventType: string; resolutionField?: boolean }

const STATUS_ACTIONS: Record<string, StatusAction[]> = {
  Actions: [
    { id: 'complete', label: 'Complete', eventType: 'complete' },
    { id: 'start', label: 'In progress', eventType: 'start' },
    { id: 'block', label: 'Blocked', eventType: 'block' },
    { id: 'cancel', label: 'Cancelled', eventType: 'cancel' },
    { id: 'reopen', label: 'Reopen', eventType: 'reopen' },
  ],
  Open_Questions: [
    { id: 'close', label: 'Answer / Close', eventType: 'close', resolutionField: true },
    { id: 'park', label: 'Park', eventType: 'park' },
    { id: 'reopen', label: 'Reopen', eventType: 'reopen' },
  ],
  Risks_Issues: [
    { id: 'resolve', label: 'Resolve', eventType: 'resolve' },
    { id: 'mitigate', label: 'Mitigate', eventType: 'mitigate' },
    { id: 'accept', label: 'Accept', eventType: 'accept' },
    { id: 'reopen', label: 'Reopen', eventType: 'reopen' },
  ],
  Decisions: [
    { id: 'ratify', label: 'Ratify', eventType: 'ratify' },
    { id: 'reaffirm', label: 'Reaffirm', eventType: 'reaffirm' },
    { id: 'reject', label: 'Reject', eventType: 'reject' },
    { id: 'supersede', label: 'Supersede', eventType: 'supersede' },
  ],
  Milestones: [
    { id: 'achieve', label: 'Achieved', eventType: 'achieve' },
    { id: 'miss', label: 'Missed', eventType: 'miss' },
    { id: 'reopen', label: 'Reopen', eventType: 'reopen' },
  ],
  Config_Changes: [
    { id: 'apply', label: 'Applied', eventType: 'apply' },
    { id: 'verify', label: 'Verified', eventType: 'verify' },
    { id: 'revert', label: 'Reverted', eventType: 'revert' },
  ],
  Uncertainty: [
    { id: 'resolve', label: 'Resolved', eventType: 'resolve' },
    { id: 'reaffirm', label: 'Still uncertain', eventType: 'reaffirm' },
    { id: 'reopen', label: 'Reopen', eventType: 'reopen' },
  ],
};

/** Entities and Sources get a note and a correction only — nothing else in this ticket's scope claims a safe operation for them. */
const FIELD_ACTIONS_EXCLUDED = new Set(['Entities', 'Sources']);

type ActiveAction = { kind: 'note' } | { kind: 'status'; action: StatusAction } | { kind: 'field'; field: 'owner' | 'due_date'; label: string; eventType: string };

function fieldActionsFor(registerName: string): ActiveAction[] {
  if (FIELD_ACTIONS_EXCLUDED.has(registerName)) return [];
  const dueLabel = registerName === 'Milestones' ? 'Reschedule' : 'Change due date';
  const dueEvent = registerName === 'Milestones' ? 'reschedule' : 'correct';
  return [
    { kind: 'field', field: 'owner', label: 'Change owner', eventType: 'correct' },
    { kind: 'field', field: 'due_date', label: dueLabel, eventType: dueEvent },
  ];
}

export function RegisterUpdateForm({ row, userId, onChanged }: { row: RegisterRow; userId: string; onChanged: () => void }) {
  const [active, setActive] = useState<ActiveAction | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // `onChanged` refetches the whole project, which briefly renders the page's
  // top-level loading state and unmounts this component — so a confirmation
  // held only in local state would vanish before anyone read it. Stashing a
  // one-shot flag in the URL survives that remount; the effect below reads it
  // back exactly once, on the very next mount, and strips it immediately so
  // reopening this row later never shows a stale confirmation.
  useEffect(() => {
    const [hashPath, hashQuery] = window.location.hash.split('?');
    const params = new URLSearchParams(hashQuery ?? '');
    if (params.get('updated') !== '1') return;
    setMessage('Project state changed. Refresh Consultant Intelligence when you want an updated brief.');
    params.delete('updated');
    const rest = params.toString();
    window.location.hash = rest ? `${hashPath}?${rest}` : hashPath;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusActions = STATUS_ACTIONS[row.registerName] ?? [];
  const fieldActions = fieldActionsFor(row.registerName);
  const needsValue = active?.kind === 'field';

  function open(next: ActiveAction) { setActive(next); setValue(''); setReason(''); setError(''); }
  function cancel() { setActive(null); setValue(''); setReason(''); setError(''); }

  async function submit() {
    if (!active) return;
    const trimmedReason = reason.trim();
    const trimmedValue = value.trim();
    if (needsValue && !trimmedValue) { setError(`A new ${active.kind === 'field' ? fieldLabel(active.field) : ''} is required.`); return; }
    if (!trimmedReason) { setError(active.kind === 'note' ? 'A note needs text.' : 'A rationale is required.'); return; }
    const body: { actor: string; eventType: string; field?: string; newValue?: string; reason: string } =
      active.kind === 'note' ? { actor: userId, eventType: 'note', reason: trimmedReason }
        : active.kind === 'status' ? { actor: userId, eventType: active.action.eventType, reason: trimmedReason, ...(active.action.resolutionField ? { field: 'resolution', newValue: trimmedReason } : {}) }
          : { actor: userId, eventType: active.eventType, field: active.field, newValue: trimmedValue, reason: trimmedReason };
    try {
      setBusy(true);
      setError('');
      await postJson(`/api/projects/${encodeURIComponent(row.projectId)}/register-rows/${encodeURIComponent(row.externalRegisterId)}/events`, 'POST', body);
      setActive(null);
      setValue('');
      setReason('');
      const [hashPath, hashQuery] = window.location.hash.split('?');
      const params = new URLSearchParams(hashQuery ?? '');
      params.set('updated', '1');
      window.location.hash = `${hashPath}?${params.toString()}`;
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The update could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register-update">
      <div className="action-row">
        <button type="button" className="button secondary" disabled={busy} onClick={() => open({ kind: 'note' })}>Add note</button>
        {statusActions.map((action) => <button key={action.id} type="button" className="button secondary" disabled={busy} onClick={() => open({ kind: 'status', action })}>{action.label}</button>)}
        {fieldActions.map((action) => action.kind === 'field' ? <button key={action.field} type="button" className="button secondary" disabled={busy} onClick={() => open(action)}>{action.label}</button> : null)}
      </div>
      {active ? (
        <div className="update-form">
          {needsValue && active.kind === 'field' ? (
            <div className="update-form-value">
              <label htmlFor="register-update-value">{fieldLabel(active.field)}</label>
              {active.field === 'due_date' ? <input id="register-update-value" className="input" type="date" value={value} onChange={(event) => setValue(event.target.value)} />
                : <input id="register-update-value" className="input" type="text" value={value} onChange={(event) => setValue(event.target.value)} placeholder="New owner name" />}
            </div>
          ) : null}
          <label htmlFor="register-update-reason">{active.kind === 'note' ? 'Note' : active.kind === 'status' && active.action.resolutionField ? 'Answer' : 'Rationale'}</label>
          <textarea
            id="register-update-reason"
            className="input"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={active.kind === 'note' ? 'Add a standalone note. It will not change any field on this row.'
              : active.kind === 'status' && active.action.resolutionField ? 'The answer, recorded as this question\'s resolution.'
                : 'Why this change is being made (required).'}
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="action-row">
            <button type="button" className="button" disabled={busy} onClick={() => void submit()}>{active.kind === 'note' ? 'Save note' : active.kind === 'field' ? active.label : active.action.label}</button>
            <button type="button" className="button secondary" disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : null}
      {!active && message ? <p className="inline-note" role="status">{message}</p> : null}
    </div>
  );
}
