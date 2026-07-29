import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, PageIntro, Section, StatusChip, formatDateTime } from './components';
import { AIChatPanel } from './AIChatPanel';
import { M365AuthNotice } from './WorkdayPage';

type SyncState = { status: string; completed_at?: string | null; error_message?: string | null; item_count?: number } | null;
type Message = {
  graph_id: string;
  sender_name: string | null;
  sender_address: string | null;
  subject: string;
  received_at: string;
  is_read: number;
  body_preview: string | null;
  has_attachments: number;
  importance: string;
  folder_name: string;
  web_link: string | null;
};
type InboxResponse = { messages: Message[]; syncState: SyncState };
type M365Status = { configured: boolean; authenticated: boolean; configurationPath: string; scopes: string[]; tokenStore: string };

export function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [status, setStatus] = useState<M365Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, dataResponse] = await Promise.all([
        fetch('/api/m365/status').then((r) => r.json() as Promise<M365Status>),
        fetch(`/api/inbox${refresh ? '?refresh=1' : ''}`).then(async (r) => {
          if (!r.ok) throw new Error((await r.json()).error ?? 'Inbox query failed');
          return r.json() as Promise<InboxResponse>;
        }),
      ]);
      setStatus(statusResponse);
      setData(dataResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inbox query failed');
    } finally {
      setLoading(false);
    }
  };

  const postAction = async (message: Message, action: 'delete' | 'read' | 'unread') => {
    setBusyId(message.graph_id);
    setError(null);
    try {
      const url = action === 'delete' ? `/api/inbox/${encodeURIComponent(message.graph_id)}/delete` : `/api/inbox/${encodeURIComponent(message.graph_id)}/read-state`;
      const body = action === 'delete' ? {} : { isRead: action === 'read' };
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Mailbox action failed');
      const result = await response.json() as { inbox?: InboxResponse } & InboxResponse;
      setData(result.inbox ?? result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mailbox action failed');
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => { void load(false); }, []);

  if (loading && !data) return <LoadingState label="Loading inbox" />;

  return (
    <div className="page-stack">
      <PageIntro eyebrow="Outlook Inbox" title="Inbox control" description="A recoverable Microsoft Graph Inbox projection with explicit action audit." aside={<button className="button" onClick={() => void load(true)}>Refresh</button>} />
      <M365AuthNotice status={status} />
      {error ? <ErrorState message={error} /> : null}
      <Section id="inbox" title="Inbox" kicker={syncLabel(data?.syncState)} count={data?.messages.length ?? 0}>
        {!data || data.messages.length === 0 ? <EmptyState>No Inbox messages are available in the local projection. Configure Microsoft 365 auth, then refresh.</EmptyState> : (
          <div className="stacked-records">
            {data.messages.map((message) => (
              <article className={message.is_read ? 'stacked-record' : 'stacked-record unread'} key={message.graph_id}>
                <div className="record-line"><div><h3>{message.subject || '(no subject)'}</h3><p>{message.sender_name ?? message.sender_address ?? 'Unknown sender'} - {formatDateTime(message.received_at)}</p></div><StatusChip value={message.importance ?? 'normal'} /></div>
                <p>{message.body_preview ?? 'No preview available.'}</p>
                <dl className="inline-details"><div><dt>Status</dt><dd>{message.is_read ? 'Read' : 'Unread'}</dd></div><div><dt>Attachments</dt><dd>{message.has_attachments ? 'Yes' : 'No'}</dd></div><div><dt>Folder</dt><dd>{message.folder_name}</dd></div></dl>
                <div className="action-row">
                  {message.web_link ? <a className="inline-action" href={message.web_link} target="_blank" rel="noreferrer">Open in Outlook</a> : null}
                  <button className="button secondary" disabled={busyId === message.graph_id} onClick={() => void postAction(message, message.is_read ? 'unread' : 'read')}>{message.is_read ? 'Mark unread' : 'Mark read'}</button>
                  <button className="button danger" disabled={busyId === message.graph_id} onClick={() => void postAction(message, 'delete')}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>
      <AIChatPanel contextOptions={(data?.messages ?? []).map((message) => ({ contextType: 'selected-email', contextId: message.graph_id, label: message.subject || '(no subject)', preview: `${message.sender_name ?? message.sender_address ?? 'Unknown'}: ${message.body_preview ?? ''}` }))} />
    </div>
  );
}

function syncLabel(sync: SyncState | undefined): string {
  if (!sync) return 'Not synced';
  return sync.completed_at ? `Last sync ${formatDateTime(sync.completed_at)} (${sync.status})` : sync.status;
}
