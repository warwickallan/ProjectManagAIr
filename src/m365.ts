import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const graphRoot = 'https://graph.microsoft.com/v1.0';
const scopes = ['openid', 'profile', 'offline_access', 'Calendars.Read', 'Mail.ReadWrite'];

export interface M365Config {
  tenantId: string;
  clientId: string;
}

export interface DeviceCodeStart {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  message: string;
  expiresIn: number;
  interval: number;
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}

let deviceCode: DeviceCodeStart | null = null;
let tokenSet: TokenSet | null = null;
let accountId: string | null = null;

export function requiredScopes(): string[] {
  return [...scopes];
}

export function loadM365Config(): M365Config | null {
  const configured = process.env.PROJECTMANAGAIR_M365_CONFIG
    ? path.resolve(process.env.PROJECTMANAGAIR_M365_CONFIG)
    : path.join(repoRoot, 'config', 'm365-auth.local.json');
  if (!existsSync(configured)) return null;
  const parsed = JSON.parse(readFileSync(configured, 'utf8')) as Partial<M365Config>;
  if (!parsed.tenantId || !parsed.clientId) return null;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(parsed.clientId)) return null;
  return { tenantId: parsed.tenantId, clientId: parsed.clientId };
}

function authBase(config: M365Config): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0`;
}

async function postForm(url: string, form: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: string; status?: number };
    error.code = typeof body.error === 'string' ? body.error : undefined;
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function startDeviceCode(): Promise<DeviceCodeStart> {
  const config = loadM365Config();
  if (!config) throw new Error('Missing local Microsoft 365 config: create ignored config/m365-auth.local.json from config/m365-auth.example.json.');
  const body = await postForm(`${authBase(config)}/devicecode`, { client_id: config.clientId, scope: scopes.join(' ') });
  deviceCode = {
    userCode: String(body.user_code),
    deviceCode: String(body.device_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete: typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
    message: String(body.message),
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval ?? 5),
  };
  return deviceCode;
}

export async function pollDeviceCode(db: DatabaseSync) {
  const config = loadM365Config();
  if (!config) throw new Error('Missing local Microsoft 365 config.');
  if (!deviceCode) throw new Error('No device-code flow has been started.');
  try {
    const body = await postForm(`${authBase(config)}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: deviceCode.deviceCode,
    });
    tokenSet = normalizeToken(body);
    const profile = await graphGet<Record<string, unknown>>('/me?$select=id,displayName,userPrincipalName,mail');
    accountId = String(profile.id);
    upsertAccount(db, accountId, profile, config.tenantId);
    return { authenticated: true, account: safeAccount(profile), tokenStore: 'session-only' as const };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as Error & { code?: string }).code) : 'unknown';
    if (code === 'authorization_pending') return { authenticated: false, pending: true, message: 'Authorization is still pending.' };
    throw error;
  }
}

function normalizeToken(body: Record<string, unknown>): TokenSet {
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: Date.now() + Math.max(0, Number(body.expires_in ?? 3600) - 60) * 1000,
    scope: String(body.scope ?? scopes.join(' ')),
  };
}

async function refreshAccessToken(): Promise<void> {
  const config = loadM365Config();
  if (!config || !tokenSet?.refreshToken) throw new Error('Microsoft 365 session is not authenticated.');
  const body = await postForm(`${authBase(config)}/token`, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: tokenSet.refreshToken,
    scope: scopes.join(' '),
  });
  tokenSet = normalizeToken(body);
}

async function accessToken(): Promise<string> {
  if (!tokenSet) throw new Error('Microsoft 365 session is not authenticated.');
  if (Date.now() >= tokenSet.expiresAt) await refreshAccessToken();
  return tokenSet.accessToken;
}

async function graphGet<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${graphRoot}${pathOrUrl}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', Prefer: 'outlook.timezone="Europe/London"' } });
  return graphResponse<T>(response);
}

async function graphPost<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${graphRoot}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await graphResponse<T>(response) };
}

async function graphPatch(path: string, body: unknown): Promise<number> {
  const response = await fetch(`${graphRoot}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Graph PATCH failed with HTTP ${response.status}: ${await response.text()}`);
  return response.status;
}

async function graphResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as { error?: { message?: string } } : null;
    throw new Error(record?.error?.message ?? `Graph request failed with HTTP ${response.status}`);
  }
  return body as T;
}

function safeAccount(profile: Record<string, unknown>) {
  return {
    id: String(profile.id),
    displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
    userPrincipalName: typeof profile.userPrincipalName === 'string' ? profile.userPrincipalName : null,
    mail: typeof profile.mail === 'string' ? profile.mail : null,
  };
}

function currentAccountId() {
  if (!accountId) throw new Error('Microsoft 365 account has not been established for this session.');
  return accountId;
}

function upsertAccount(db: DatabaseSync, id: string, profile: Record<string, unknown>, tenantLabel: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO microsoft_accounts (id, display_name, user_principal_name, mail, tenant_id_label, connected_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, user_principal_name = excluded.user_principal_name, mail = excluded.mail, tenant_id_label = excluded.tenant_id_label, last_seen_at = excluded.last_seen_at`)
    .run(id, typeof profile.displayName === 'string' ? profile.displayName : null, typeof profile.userPrincipalName === 'string' ? profile.userPrincipalName : null, typeof profile.mail === 'string' ? profile.mail : null, tenantLabel, now, now);
}

function syncState(db: DatabaseSync, resource: string, status: string, startedAt: string, completedAt: string | null, itemCount: number, rangeStart?: string, rangeEnd?: string, error?: string) {
  const id = `m365:${resource}:${startedAt}`;
  db.prepare(`INSERT INTO connector_sync_state (id, account_id, connector, resource, status, started_at, completed_at, range_start, range_end, item_count, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, accountId, 'microsoft-graph', resource, status, startedAt, completedAt, rangeStart ?? null, rangeEnd ?? null, itemCount, error ?? null);
}

export function authStatus() {
  const config = loadM365Config();
  return {
    configured: Boolean(config),
    authenticated: Boolean(tokenSet),
    scopes,
    tokenStore: 'session-only',
    accountId,
    configurationPath: 'config/m365-auth.local.json',
  };
}

interface GraphCollection<T> { value: T[]; '@odata.nextLink'?: string }

export async function syncCalendarView(db: DatabaseSync, start: string, end: string) {
  const startedAt = new Date().toISOString();
  const select = 'id,subject,organizer,attendees,location,isOnlineMeeting,onlineMeetingProvider,start,end,showAs,responseStatus,webLink';
  const url = `/me/calendar/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=100&$orderby=start/dateTime&$select=${encodeURIComponent(select)}`;
  try {
    const collection = await graphGet<GraphCollection<Record<string, unknown>>>(url);
    const account = currentAccountId();
    const now = new Date().toISOString();
    const statement = db.prepare(`INSERT INTO calendar_events (id, account_id, graph_id, subject, organizer_name, organizer_address, attendees_json, location_display_name, is_online_meeting, online_meeting_provider, start_at, end_at, show_as, response_status, web_link, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, graph_id) DO UPDATE SET subject = excluded.subject, organizer_name = excluded.organizer_name, organizer_address = excluded.organizer_address, attendees_json = excluded.attendees_json, location_display_name = excluded.location_display_name, is_online_meeting = excluded.is_online_meeting, online_meeting_provider = excluded.online_meeting_provider, start_at = excluded.start_at, end_at = excluded.end_at, show_as = excluded.show_as, response_status = excluded.response_status, web_link = excluded.web_link, last_synced_at = excluded.last_synced_at`);
    for (const item of collection.value) {
      const graphId = String(item.id);
      const organizer = item.organizer as { emailAddress?: { name?: string; address?: string } } | undefined;
      const startValue = item.start as { dateTime?: string; timeZone?: string } | undefined;
      const endValue = item.end as { dateTime?: string; timeZone?: string } | undefined;
      const response = item.responseStatus as { response?: string } | undefined;
      const location = item.location as { displayName?: string } | undefined;
      statement.run(`event:${account}:${graphId}`, account, graphId, String(item.subject ?? '(no subject)'), organizer?.emailAddress?.name ?? null, organizer?.emailAddress?.address ?? null, JSON.stringify(item.attendees ?? []), location?.displayName ?? null, item.isOnlineMeeting ? 1 : 0, item.onlineMeetingProvider ? String(item.onlineMeetingProvider) : null, String(startValue?.dateTime ?? ''), String(endValue?.dateTime ?? ''), item.showAs ? String(item.showAs) : null, response?.response ?? null, item.webLink ? String(item.webLink) : null, now);
    }
    syncState(db, 'calendarView', 'completed', startedAt, new Date().toISOString(), collection.value.length, start, end);
    return readCalendarProjection(db, start, end);
  } catch (error) {
    syncState(db, 'calendarView', 'failed', startedAt, new Date().toISOString(), 0, start, end, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function readCalendarProjection(db: DatabaseSync, start: string, end: string) {
  const account = accountId;
  const rows = account ? db.prepare('SELECT * FROM calendar_events WHERE account_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at').all(account, start, end) : [];
  const state = db.prepare("SELECT * FROM connector_sync_state WHERE connector = 'microsoft-graph' AND resource = 'calendarView' ORDER BY started_at DESC LIMIT 1").get() ?? null;
  return { events: rows, syncState: state };
}

export async function syncInbox(db: DatabaseSync) {
  const startedAt = new Date().toISOString();
  const select = 'id,conversationId,internetMessageId,from,subject,receivedDateTime,isRead,bodyPreview,hasAttachments,importance,parentFolderId,webLink';
  try {
    const collection = await graphGet<GraphCollection<Record<string, unknown>>>(`/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$select=${encodeURIComponent(select)}`);
    const account = currentAccountId();
    const now = new Date().toISOString();
    const statement = db.prepare(`INSERT INTO mail_items (id, account_id, graph_id, conversation_id, internet_message_id, sender_name, sender_address, subject, received_at, is_read, body_preview, has_attachments, importance, folder_id, folder_name, web_link, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, graph_id) DO UPDATE SET conversation_id = excluded.conversation_id, internet_message_id = excluded.internet_message_id, sender_name = excluded.sender_name, sender_address = excluded.sender_address, subject = excluded.subject, received_at = excluded.received_at, is_read = excluded.is_read, body_preview = excluded.body_preview, has_attachments = excluded.has_attachments, importance = excluded.importance, folder_id = excluded.folder_id, folder_name = excluded.folder_name, web_link = excluded.web_link, last_synced_at = excluded.last_synced_at`);
    for (const item of collection.value) {
      const graphId = String(item.id);
      const from = item.from as { emailAddress?: { name?: string; address?: string } } | undefined;
      statement.run(`mail:${account}:${graphId}`, account, graphId, item.conversationId ? String(item.conversationId) : null, item.internetMessageId ? String(item.internetMessageId) : null, from?.emailAddress?.name ?? null, from?.emailAddress?.address ?? null, String(item.subject ?? '(no subject)'), String(item.receivedDateTime), item.isRead ? 1 : 0, item.bodyPreview ? String(item.bodyPreview).slice(0, 500) : null, item.hasAttachments ? 1 : 0, item.importance ? String(item.importance) : 'normal', item.parentFolderId ? String(item.parentFolderId) : 'inbox', 'inbox', item.webLink ? String(item.webLink) : null, now);
    }
    syncState(db, 'mailInbox', 'completed', startedAt, new Date().toISOString(), collection.value.length);
    return readInboxProjection(db);
  } catch (error) {
    syncState(db, 'mailInbox', 'failed', startedAt, new Date().toISOString(), 0, undefined, undefined, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function readInboxProjection(db: DatabaseSync) {
  const account = accountId;
  const messages = account ? db.prepare("SELECT * FROM mail_items WHERE account_id = ? AND folder_name = 'inbox' ORDER BY received_at DESC LIMIT 50").all(account) : [];
  const state = db.prepare("SELECT * FROM connector_sync_state WHERE connector = 'microsoft-graph' AND resource = 'mailInbox' ORDER BY started_at DESC LIMIT 1").get() ?? null;
  return { messages, syncState: state };
}

export async function markMessageRead(db: DatabaseSync, graphId: string, isRead: boolean) {
  const status = await graphPatch(`/me/messages/${encodeURIComponent(graphId)}`, { isRead });
  db.prepare('UPDATE mail_items SET is_read = ? WHERE graph_id = ?').run(isRead ? 1 : 0, graphId);
  recordAction(db, 'mail.markRead', 'mail', graphId, 'completed', status, `Message marked ${isRead ? 'read' : 'unread'} in Microsoft Graph.`);
  return readInboxProjection(db);
}

export async function moveMessageToDeletedItems(db: DatabaseSync, graphId: string) {
  const result = await graphPost<Record<string, unknown>>(`/me/messages/${encodeURIComponent(graphId)}/move`, { destinationId: 'deleteditems' });
  db.prepare("UPDATE mail_items SET folder_name = 'deleteditems', folder_id = 'deleteditems', last_synced_at = ? WHERE graph_id = ?").run(new Date().toISOString(), graphId);
  recordAction(db, 'mail.moveToDeletedItems', 'mail', graphId, 'completed', result.status, 'Message moved to Deleted Items by Microsoft Graph move action.');
  return { moved: true, graphStatus: result.status, inbox: readInboxProjection(db) };
}

function recordAction(db: DatabaseSync, actionType: string, targetType: string, targetId: string, status: string, graphStatus: number, summary: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO connector_actions (id, account_id, connector, action_type, target_type, target_id, status, requested_at, completed_at, graph_status, audit_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`action:${actionType}:${targetId}:${now}`, accountId, 'microsoft-graph', actionType, targetType, targetId, status, now, now, graphStatus, summary);
}
