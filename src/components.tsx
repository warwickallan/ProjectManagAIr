import type { ReactNode } from 'react';
import type { AttentionItem, Freshness, ActivityEvent } from './domain';

type ActiveNav = 'today' | 'inbox' | 'calendar' | 'portfolio' | 'needs-you' | 'ai-chat' | 'settings';

export function AppFrame({ active, children }: { active: ActiveNav; children: ReactNode }) {
  const nav = [
    ['today', '#/today', 'Today'],
    ['inbox', '#/inbox', 'Inbox'],
    ['calendar', '#/calendar', 'Calendar'],
    ['portfolio', '#/projects', 'Projects'],
    ['needs-you', '#/needs-you', 'Needs You'],
    ['ai-chat', '#/ai-chat', 'AI Chat'],
    ['settings', '#/settings', 'Settings'],
  ] as const;
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#/today" aria-label="Project ManagAIr today home">
          <span className="brand-mark" aria-hidden="true">PM</span>
          <span><strong>Project ManagAIr</strong><small>Implementation Cockpit</small></span>
        </a>
        <nav className="nav-list">
          {nav.map(([id, href, label]) => (
            <a key={id} className={active === id ? 'nav-link active' : 'nav-link'} href={href}>{label}</a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="pulse-dot" aria-hidden="true" />
          <span><strong>Local Cockpit</strong><small>Loopback only</small></span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="mobile-brand">Project ManagAIr</span>
          <div className="topbar-badges" aria-label="Environment status">
            <span className="meta-badge demo">Local projection</span>
            <span className="meta-badge">M365 optional</span>
          </div>
        </header>
        <main id="main-content" className="content">{children}</main>
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading Cockpit data' }: { label?: string }) {
  return (
    <div className="state-panel loading-state" aria-busy="true" aria-live="polite" data-testid="loading-state">
      <span className="sr-only">{label}</span>
      <div className="skeleton wide" />
      <div className="skeleton-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
      <div className="skeleton tall" />
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state-panel error-state" role="alert">
      <span className="state-glyph" aria-hidden="true">!</span>
      <div><h1>Could not load the Cockpit</h1><p>{message}</p><p>Check that the local server is running, then refresh this page.</p></div>
    </div>
  );
}

export function EmptyState({ children = 'No records available.' }: { children?: ReactNode }) {
  return <div className="empty-state" role="status"><span aria-hidden="true">○</span><p>{children}</p></div>;
}

export function FreshnessNotice({ freshness, asOf }: { freshness: Freshness; asOf: string }) {
  const stamp = formatDateTime(asOf);
  if (freshness.status === 'stale') {
    return (
      <div className="freshness stale" role="status">
        <strong>Data snapshot is stale</strong>
        <span>As of {stamp} - {freshness.hoursOld} hours old</span>
      </div>
    );
  }
  return <div className="freshness"><span className="pulse-dot" aria-hidden="true" /><span>Data current - {stamp}</span></div>;
}

export function PageIntro({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) {
  return (
    <header className="page-intro">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lede">{description}</p></div>
      {aside ? <div className="page-intro-aside">{aside}</div> : null}
    </header>
  );
}

export function Section({ id, title, kicker, count, children, className = '' }: { id: string; title: string; kicker?: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`panel section-panel ${className}`}>
      <header className="section-head">
        <div>{kicker ? <p className="section-kicker">{kicker}</p> : null}<h2>{title}</h2></div>
        {typeof count === 'number' ? <span className="count-badge" aria-label={`${count} records`}>{count}</span> : null}
      </header>
      {children}
    </section>
  );
}

const statusTone: Record<string, string> = {
  'on-track': 'good', complete: 'good', achieved: 'good', verified: 'good', decided: 'good', accepted: 'good', free: 'good', completed: 'good',
  watch: 'watch', 'at-risk': 'watch', 'in-progress': 'info', active: 'info', 'in-review': 'info', pending: 'watch', tentative: 'watch', normal: 'neutral',
  blocked: 'bad', critical: 'bad', failed: 'bad', missed: 'bad', overdue: 'bad', busy: 'bad', high: 'bad',
  // Source-intake processing states (migration 011). `quarantined` used to have no
  // tone at all because the schema did not admit it.
  quarantined: 'bad', rejected: 'bad', awaiting_processing: 'watch', awaiting_metadata: 'watch', processing: 'info', awaiting_review: 'watch', archived: 'neutral',
  // Human register-event statuses (015).
  applied: 'good', mitigated: 'watch', cancelled: 'neutral', reverted: 'neutral', resolved: 'good', ratified: 'good', parked: 'watch', superseded: 'neutral',
};

export function StatusChip({ value, label }: { value: string; label?: string }) {
  const tone = statusTone[value] ?? 'neutral';
  return <span className={`status-chip ${tone}`}><span aria-hidden="true" />{label ?? humanize(value)}</span>;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-meta"><span>{label}</span><strong>{value}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function AttentionList({ items, emptyLabel = 'Nothing needs your attention.' }: { items: AttentionItem[]; emptyLabel?: string }) {
  if (items.length === 0) return <EmptyState>{emptyLabel}</EmptyState>;
  return (
    <ol className="attention-list">
      {items.map((item) => (
        <li key={item.id} className={`attention-row urgency-${item.urgency}`}>
          <div className="urgency-marker" aria-hidden="true" />
          <div className="attention-main">
            <div className="attention-meta"><StatusChip value={item.urgency === 'now' ? 'critical' : item.urgency} label={item.urgency} /><span>{item.projectName}</span><span>{humanize(item.sourceEntityType)}</span></div>
            <h3><a href={item.route}>{item.title}</a></h3>
            <p>{item.reason}</p>
          </div>
          <div className="attention-due"><small>{item.dueAt ? 'Due' : 'Status'}</small><strong>{item.dueAt ? formatDate(item.dueAt) : 'Open'}</strong><a href={item.route} aria-label={`Open ${item.title}`}>View <span aria-hidden="true">{'->'}</span></a></div>
        </li>
      ))}
    </ol>
  );
}

export function ActivityList({ activity, projectNames }: { activity: ActivityEvent[]; projectNames?: Record<string, string> }) {
  if (activity.length === 0) return <EmptyState>No recent activity.</EmptyState>;
  return (
    <ol className="activity-list">
      {activity.map((item) => (
        <li key={item.id}>
          <span className={`activity-icon ${item.eventType}`} aria-hidden="true">{activityGlyph(item.eventType)}</span>
          <div><div className="activity-meta"><strong>{projectNames?.[item.projectId] ?? item.actor}</strong><span>{formatRelativeStamp(item.occurredAt)}</span></div><p>{item.summary}</p><small>{projectNames ? item.actor : humanize(item.eventType)}</small></div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------------- *
 * D1 — surfacing extraction failure.
 *
 * The pipeline records `processing_stage`, `processing_error` and
 * `processing_recovery_action` on the intake row, and nothing rendered any of
 * them: a quarantined source showed a "Processing" chip forever, and the only
 * way to learn what had happened was to open the database. These components
 * are pure functions of the row — no effects, no mirrored state.
 * ------------------------------------------------------------------------- */

export interface SourceProcessingSnapshot {
  originalFileName?: string;
  processingStatus: string;
  processingStage?: string | null;
  processingError?: string | null;
  processingRecoveryAction?: string | null;
  updatedAt?: string | null;
}

const FAILED_PROCESSING_STATUSES = new Set(['failed', 'quarantined', 'rejected']);
const FAILED_PROCESSING_STAGES = new Set(['failed', 'quarantined']);
const OPEN_PROCESSING_STATUSES = new Set(['awaiting_processing', 'processing']);

export interface SourceProcessingView {
  failed: boolean;
  inProgress: boolean;
  needsAttention: boolean;
  /** Goal 1 — waiting on a human to confirm mandatory meeting metadata, not on any pipeline step. */
  awaitingMetadata: boolean;
  stage: string | null;
  error: string | null;
  recovery: string | null;
  chipValue: string;
  chipLabel: string;
}

export function sourceProcessingView(source: SourceProcessingSnapshot): SourceProcessingView {
  const stage = source.processingStage?.trim() || null;
  const error = source.processingError?.trim() || null;
  const recovery = source.processingRecoveryAction?.trim() || null;
  const failed = FAILED_PROCESSING_STATUSES.has(source.processingStatus) || (stage !== null && FAILED_PROCESSING_STAGES.has(stage));
  const awaitingMetadata = !failed && source.processingStatus === 'awaiting_metadata';
  const inProgress = !failed && !awaitingMetadata && OPEN_PROCESSING_STATUSES.has(source.processingStatus);
  const chipValue = failed ? 'failed' : awaitingMetadata ? 'awaiting_metadata' : source.processingStatus;
  return {
    failed,
    inProgress,
    awaitingMetadata,
    // An in-progress source that has already recorded an error is the stalled
    // case: it will never move on its own, so it must not read as ordinary
    // progress. Awaiting metadata is always attention-worthy — by
    // definition nothing proceeds until a human acts, error or not.
    needsAttention: failed || awaitingMetadata || (inProgress && error !== null),
    stage,
    error,
    recovery,
    chipValue,
    chipLabel: awaitingMetadata ? 'Awaiting meeting details' : processingLabel(source.processingStatus, stage, failed),
  };
}

function processingLabel(status: string, stage: string | null, failed: boolean): string {
  const base = humanize(status.replaceAll('_', '-'));
  if (failed && stage && stage !== status) return `${base} - ${humanize(stage.replaceAll('_', '-'))}`;
  if (!failed && stage) return `${base} - ${humanize(stage.replaceAll('_', '-'))}`;
  return base;
}

/** What went wrong and what to do about it, for one source. Renders nothing when nothing is wrong. */
export function SourceProcessingNotice({ source }: { source: SourceProcessingSnapshot }) {
  const view = sourceProcessingView(source);
  if (!view.needsAttention) return null;
  // Waiting for meeting details is a NORMAL, expected state that every new
  // source passes through — it needs the consultant's attention, but it is not
  // a failure and must not be dressed as one. Previously it rendered the
  // failure notice verbatim, so a healthy source one second old announced "This
  // source reported a problem while processing" and "the pipeline recorded no
  // error detail for this failure", which is alarming and simply untrue.
  if (view.awaitingMetadata && !view.error) {
    return (
      <div className="awaiting-note" role="status">
        <strong>Waiting for you to confirm the meeting details.</strong>
        <p>Nothing is extracted and no AI call is made until the meeting subject, primary work package and meeting date are answered. The meeting date may be answered as &ldquo;unknown&rdquo;.</p>
      </div>
    );
  }
  return (
    <div className="quarantine-note" role="alert">
      <strong>{view.failed ? 'This source stopped before it was extracted.' : 'This source reported a problem while processing.'}</strong>
      <p><strong>What went wrong:</strong> {view.error ?? 'The pipeline recorded no error detail for this failure. Check the source processing job for this file.'}</p>
      <p><strong>What to do:</strong> {view.recovery ?? 'No recovery action was recorded. Retry this source from the quarantine lane, and if it fails again capture the job error before re-uploading.'}</p>
      <dl className="inline-details">
        <div><dt>Stage reached</dt><dd>{view.stage ?? 'Not recorded'}</dd></div>
        <div><dt>State</dt><dd>{view.chipLabel}</dd></div>
        {source.updatedAt ? <div><dt>Last change</dt><dd>{formatDateTime(source.updatedAt)}</dd></div> : null}
      </dl>
    </div>
  );
}

/** The same information gathered to the top of a page, so a failure is seen without scrolling. */
export function SourceProcessingAlerts({ sources }: { sources: Array<SourceProcessingSnapshot & { id: string; originalFileName: string }> }) {
  const blocked = sources.filter((source) => sourceProcessingView(source).needsAttention);
  if (blocked.length === 0) return null;
  return (
    <section className="source-processing-alerts" aria-label="Sources that need attention">
      <h3 className="subhead">{blocked.length === 1 ? '1 source needs attention' : `${blocked.length} sources need attention`}</h3>
      <div className="stacked-records">
        {blocked.map((source) => (
          <article className="stacked-record" key={source.id}>
            <div className="record-line">
              {/* "Extraction did not complete" is false for a source that is
                  simply waiting for its meeting details, which is the ordinary
                  first state of every upload. */}
              <div><h3>{source.originalFileName}</h3><p>{sourceProcessingView(source).awaitingMetadata && !sourceProcessingView(source).error ? 'Waiting for meeting details.' : 'Extraction did not complete.'}</p></div>
              <StatusChip value={sourceProcessingView(source).chipValue} label={sourceProcessingView(source).chipLabel} />
            </div>
            <SourceProcessingNotice source={source} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function formatDate(value: string | null): string {
  if (!value || value === '9999-12-31') return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function formatRelativeStamp(value: string): string {
  return formatDateTime(value).replace(' UTC', '');
}

export function humanize(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityGlyph(type: ActivityEvent['eventType']): string {
  return ({ progress: 'UP', decision: 'OK', risk: '!', milestone: 'MS', ai: 'AI' } as const)[type];
}

/** The one `fetch` wrapper every command action in the Cockpit posts through. */
export async function postJson<T = unknown>(url: string, method: 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}
