CREATE TABLE IF NOT EXISTS microsoft_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  user_principal_name TEXT,
  mail TEXT,
  tenant_id_label TEXT,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES microsoft_accounts(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  conversation_id TEXT,
  internet_message_id TEXT,
  sender_name TEXT,
  sender_address TEXT,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  body_preview TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  importance TEXT NOT NULL DEFAULT 'normal',
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  web_link TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE(account_id, graph_id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES microsoft_accounts(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  organizer_name TEXT,
  organizer_address TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  location_display_name TEXT,
  is_online_meeting INTEGER NOT NULL DEFAULT 0,
  online_meeting_provider TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  show_as TEXT,
  response_status TEXT,
  web_link TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE(account_id, graph_id)
);

CREATE TABLE IF NOT EXISTS connector_sync_state (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES microsoft_accounts(id) ON DELETE CASCADE,
  connector TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  range_start TEXT,
  range_end TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS connector_actions (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES microsoft_accounts(id) ON DELETE SET NULL,
  connector TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  graph_status INTEGER,
  audit_summary TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_context_refs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL,
  context_id TEXT NOT NULL,
  label TEXT NOT NULL,
  selected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_items_account_folder_received ON mail_items(account_id, folder_name, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_account_start ON calendar_events(account_id, start_at);
CREATE INDEX IF NOT EXISTS idx_connector_actions_target ON connector_actions(target_type, target_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session ON ai_chat_messages(session_id, created_at);
