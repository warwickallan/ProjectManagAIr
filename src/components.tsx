import type { ReactNode } from 'react';
import type { AttentionItem, Freshness, ActivityEvent } from './domain';

export function AppFrame({ active, children }: { active: 'portfolio' | 'project'; children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#/" aria-label="Project ManagAIr portfolio home">
          <span className="brand-mark" aria-hidden="true">PM</span>
          <span><strong>Project ManagAIr</strong><small>Implementation Cockpit</small></span>
        </a>
        <nav className="nav-list">
          <a className={active === 'portfolio' ? 'nav-link active' : 'nav-link'} href="#/">
            <span aria-hidden="true">⌂</span> Portfolio
          </a>
          <span className={active === 'project' ? 'nav-link active nav-static' : 'nav-link nav-static'}>
            <span aria-hidden="true">◇</span> Project detail
          </span>
        </nav>
        <div className="sidebar-foot">
          <span className="pulse-dot" aria-hidden="true" />
          <span><strong>Local Cockpit</strong><small>No live connections</small></span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="mobile-brand">Project ManagAIr</span>
          <div className="topbar-badges" aria-label="Environment status">
            <span className="meta-badge demo">Fictional demo data</span>
            <span className="meta-badge">Read only</span>
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

export function EmptyState({ children = 'No records in this fictional project.' }: { children?: ReactNode }) {
  return <div className="empty-state" role="status"><span aria-hidden="true">○</span><p>{children}</p></div>;
}

export function FreshnessNotice({ freshness, asOf }: { freshness: Freshness; asOf: string }) {
  const stamp = formatDateTime(asOf);
  if (freshness.status === 'stale') {
    return (
      <div className="freshness stale" role="status">
        <strong>Fixture snapshot is stale</strong>
        <span>As of {stamp} · {freshness.hoursOld} hours old</span>
      </div>
    );
  }
  return <div className="freshness"><span className="pulse-dot" aria-hidden="true" /><span>Snapshot current · {stamp}</span></div>;
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
  'on-track': 'good', complete: 'good', achieved: 'good', verified: 'good', decided: 'good',
  watch: 'watch', 'at-risk': 'watch', 'in-progress': 'info', active: 'info', 'in-review': 'info', pending: 'watch',
  blocked: 'bad', critical: 'bad', failed: 'bad', missed: 'bad', overdue: 'bad',
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
          <div className="attention-due"><small>{item.dueAt ? 'Due' : 'Status'}</small><strong>{item.dueAt ? formatDate(item.dueAt) : 'Open'}</strong><a href={item.route} aria-label={`Open ${item.title}`}>View <span aria-hidden="true">→</span></a></div>
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

export function formatDate(value: string | null): string {
  if (!value) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value));
}

export function formatRelativeStamp(value: string): string {
  return formatDateTime(value).replace(' UTC', '');
}

export function humanize(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityGlyph(type: ActivityEvent['eventType']): string {
  return ({ progress: '↗', decision: '✓', risk: '!', milestone: '◆', ai: 'AI' } as const)[type];
}
