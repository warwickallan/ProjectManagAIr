import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, PageIntro, Section, StatusChip, formatDate, formatDateTime, formatTime } from './components';
import { AIChatPanel } from './AIChatPanel';

type SyncState = { status: string; completed_at?: string | null; error_message?: string | null; item_count?: number } | null;
type CalendarEvent = {
  graph_id: string;
  subject: string;
  organizer_name: string | null;
  organizer_address: string | null;
  attendees_json: string;
  location_display_name: string | null;
  is_online_meeting: number;
  online_meeting_provider: string | null;
  start_at: string;
  end_at: string;
  show_as: string | null;
  response_status: string | null;
  web_link: string | null;
};
type TodayResponse = { events: CalendarEvent[]; syncState: SyncState };

type M365Status = { configured: boolean; authenticated: boolean; configurationPath: string; scopes: string[]; tokenStore: string };

export function TodayPage({ mode }: { mode: 'day' | 'week' }) {
  const range = useMemo(() => rangeFor(mode), [mode]);
  const [data, setData] = useState<TodayResponse | null>(null);
  const [status, setStatus] = useState<M365Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, dataResponse] = await Promise.all([
        fetch('/api/m365/status').then((r) => r.json() as Promise<M365Status>),
        fetch(`/api/today?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}${refresh ? '&refresh=1' : ''}`).then(async (r) => {
          if (!r.ok) throw new Error((await r.json()).error ?? 'Calendar query failed');
          return r.json() as Promise<TodayResponse>;
        }),
      ]);
      setStatus(statusResponse);
      setData(dataResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calendar query failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(false); }, [range.start, range.end]);

  if (loading && !data) return <LoadingState label="Loading calendar" />;

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow={mode === 'day' ? 'Today' : 'Calendar'}
        title={mode === 'day' ? 'Today command view' : 'Week calendar'}
        description="Read-only Microsoft Graph calendar projection with explicit sync state."
        aside={<button className="button" onClick={() => void load(true)}>Refresh</button>}
      />
      <M365AuthNotice status={status} />
      {error ? <ErrorState message={error} /> : null}
      <Section id="calendar" title={mode === 'day' ? 'Today calendar' : 'Week calendar'} kicker={syncLabel(data?.syncState)} count={data?.events.length ?? 0}>
        <div className="time-ruler"><span style={{ left: `${currentTimePercent()}%` }} /></div>
        {!data || data.events.length === 0 ? <EmptyState>No calendar events are available in the local projection. Configure Microsoft 365 auth, then refresh.</EmptyState> : (
          <div className="stacked-records">
            {data.events.map((event) => <CalendarEventCard key={event.graph_id} event={event} />)}
          </div>
        )}
      </Section>
      <AIChatPanel contextOptions={(data?.events ?? []).map((event) => ({ contextType: 'selected-event', contextId: event.graph_id, label: event.subject, preview: `${formatTime(event.start_at)}-${formatTime(event.end_at)} ${event.organizer_name ?? ''}` }))} />
    </div>
  );
}

function CalendarEventCard({ event }: { event: CalendarEvent }) {
  const attendees = safeAttendees(event.attendees_json);
  return (
    <article className="stacked-record">
      <div className="record-line"><div><h3>{event.subject}</h3><p>{formatDateTime(event.start_at)} to {formatTime(event.end_at)}</p></div><StatusChip value={event.show_as ?? 'busy'} /></div>
      <dl className="inline-details">
        <div><dt>Organiser</dt><dd>{event.organizer_name ?? event.organizer_address ?? 'Not shown'}</dd></div>
        <div><dt>Attendees</dt><dd>{attendees.length ? attendees.join(', ') : 'None shown'}</dd></div>
        <div><dt>Location</dt><dd>{event.is_online_meeting ? `Online meeting${event.online_meeting_provider ? ` (${event.online_meeting_provider})` : ''}` : event.location_display_name ?? 'Not set'}</dd></div>
        <div><dt>Status</dt><dd>{event.response_status ?? 'Not shown'}</dd></div>
      </dl>
      {event.web_link ? <a className="inline-action" href={event.web_link} target="_blank" rel="noreferrer">Open Outlook event</a> : null}
    </article>
  );
}

export function M365AuthNotice({ status }: { status: M365Status | null }) {
  const [device, setDevice] = useState<{ message: string; verificationUri: string; userCode: string } | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const start = async () => {
    setAuthMessage(null);
    const response = await fetch('/api/m365/auth/start', { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok) { setAuthMessage(body.error ?? 'Could not start Microsoft sign-in.'); return; }
    setDevice(body);
  };

  const poll = async () => {
    setAuthMessage(null);
    const response = await fetch('/api/m365/auth/poll', { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok) { setAuthMessage(body.error ?? 'Microsoft sign-in polling failed.'); return; }
    setAuthMessage(body.authenticated ? 'Microsoft 365 connected. Refresh the page data.' : body.message ?? 'Authorization is still pending.');
  };

  if (!status) return null;
  if (status.authenticated) return <div className="demo-banner"><span aria-hidden="true">OK</span><div><strong>Microsoft 365 connected</strong><p>Session token store: {status.tokenStore}. Scopes: {status.scopes.join(', ')}</p></div></div>;
  return (
    <div className="demo-banner">
      <span aria-hidden="true">M365</span>
      <div><strong>Microsoft 365 not connected</strong><p>{status.configured ? 'Start device-code sign-in, complete it in the browser, then poll.' : `Create ignored ${status.configurationPath} before signing in.`}</p>{device ? <p>Code {device.userCode}. Open {device.verificationUri}</p> : null}{authMessage ? <p>{authMessage}</p> : null}</div>
      {status.configured ? <div className="action-row"><button className="button secondary" onClick={() => void start()}>Start sign-in</button><button className="button secondary" onClick={() => void poll()}>Poll sign-in</button></div> : null}
    </div>
  );
}

function rangeFor(mode: 'day' | 'week') {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + (mode === 'day' ? 1 : 7));
  return { start: start.toISOString(), end: end.toISOString() };
}

function syncLabel(sync: SyncState | undefined): string {
  if (!sync) return 'Not synced';
  return sync.completed_at ? `Last sync ${formatDateTime(sync.completed_at)} (${sync.status})` : sync.status;
}

function currentTimePercent(): number {
  const now = new Date();
  return ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
}

function safeAttendees(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as Array<{ emailAddress?: { name?: string; address?: string } }>;
    return parsed.map((item) => item.emailAddress?.name ?? item.emailAddress?.address ?? '').filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}
