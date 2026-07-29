# Microsoft 365 Workday Cockpit

This build adds reusable Microsoft 365 connector foundations without installing packages or storing credentials in Git.

## Local Configuration

Copy `config/m365-auth.example.json` to ignored `config/m365-auth.local.json` and set:

- `tenantId`: Microsoft Entra tenant ID, or `organizations` while testing an organization-only public client.
- `clientId`: application/client ID for a public-client app registration.

Do not commit the local file. Tenant IDs, client IDs tied to Warwick's tenant, account names, tokens, mail content, and calendar content are local operational data.

## Authentication

Project ManagAIr uses Microsoft identity platform device-code flow against:

`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`

and token polling against:

`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`

Initial delegated scopes:

- `openid`
- `profile`
- `offline_access`
- `Calendars.Read`
- `Mail.ReadWrite`

Tokens are session-only in this build. A secure persistent Windows-user token store was not added because there is no approved zero-install encrypted token-store implementation in the current dependency set. Refresh tokens are not written to SQLite or Git.

## Graph Operations

Calendar uses a bounded Microsoft Graph `calendarView` query. Inbox uses `mailFolders/inbox/messages`. The visible Inbox Delete action is implemented as Graph message `move` with `destinationId: "deleteditems"`; hard deletion is not implemented.

Microsoft 365 remains authoritative. SQLite stores a local projection and action audit history only.

## Added SQLite Projection Tables

- `microsoft_accounts`
- `mail_items`
- `calendar_events`
- `connector_sync_state`
- `connector_actions`
- `ai_chat_sessions`
- `ai_chat_messages`
- `ai_context_refs`

## Administrative Prerequisite

A Microsoft Entra public-client application registration is required before real Graph proof can run. It must allow public client/device-code flow and delegated Microsoft Graph permissions for `Calendars.Read` and `Mail.ReadWrite`. Tenant consent policy may require an administrator to approve these permissions before Warwick can sign in.

## AI Chat

The chat panel uses a provider-neutral interface. It probes existing local CLIs only:

1. Claude Code CLI, preferred when `claude` is available on PATH.
2. Codex CLI, discovered for status only in this build unless a supported non-interactive provider mode is explicitly enabled later.

The UI sends only explicitly selected context records. It does not send whole mailbox contents, attachments, all calendar history, unrelated project folders, or automatic email sends.
