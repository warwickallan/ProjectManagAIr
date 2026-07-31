/**
 * The Google Drive consent flow's security controls.
 *
 * Loopback is not a security boundary. While the consent listener is open, any
 * page the operator happens to be visiting can scan local ports and post an
 * authorisation code of its own to the callback; if that code were accepted, the
 * refresh token this build stores would belong to someone else's Google account
 * and every safe_for_drive deliverable from then on would be mirrored into their
 * Drive. The two controls that stop it — an unguessable `state` and PKCE — are
 * therefore asserted here rather than assumed.
 *
 * No network: the token endpoint is a stub and the redirect is driven by an
 * ordinary local fetch.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginDriveAuthorization } from '../src/buildFinalizerPorts';

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function paths() {
  const root = mkdtempSync(path.join(tmpdir(), 'pma-drive-auth-'));
  directories.push(root);
  const clientConfig = path.join(root, 'google-drive.local.json');
  writeFileSync(clientConfig, JSON.stringify({ clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret' }), 'utf8');
  return { clientConfig, tokenStore: path.join(root, 'google-drive-token.local.json') };
}

describe('the Google Drive consent flow', () => {
  it('binds the callback to this process with state and PKCE, and stores only the refresh token', async () => {
    const credentials = paths();
    let exchangeBody: URLSearchParams | null = null;
    const flow = await beginDriveAuthorization({
      paths: credentials,
      tokenEndpoint: 'https://token.invalid/token',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        exchangeBody = new URLSearchParams(init.body);
        return new Response(JSON.stringify({ refresh_token: '1//0gTESTREFRESHTOKEN' }), { status: 200 });
      }) as unknown as typeof fetch,
      timeoutMs: 20_000,
    });

    const authorize = new URL(flow.authorizationUrl);
    const state = authorize.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThan(20);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    // The client secret is not in the URL the operator's browser is sent to.
    expect(flow.authorizationUrl).not.toContain('GOCSPX-test-secret');

    // A code injected without the right state is refused, and the flow stays
    // open for the consent the operator is actually giving.
    const injected = await fetch(`http://127.0.0.1:${flow.port}/oauth2/callback?code=attacker-code&state=guessed`);
    expect(injected.status).toBe(400);
    expect(exchangeBody).toBeNull();

    // The real redirect completes.
    const accepted = await fetch(`http://127.0.0.1:${flow.port}/oauth2/callback?code=real-code&state=${encodeURIComponent(state!)}`);
    expect(accepted.status).toBe(200);
    await flow.completed;

    expect(exchangeBody!.get('code')).toBe('real-code');
    // PKCE: the verifier proves the exchange comes from the process that asked.
    expect(exchangeBody!.get('code_verifier')).toBeTruthy();

    const stored = JSON.parse(readFileSync(credentials.tokenStore, 'utf8')) as Record<string, unknown>;
    expect(stored.refreshToken).toBe('1//0gTESTREFRESHTOKEN');
    // No access token, no client secret, nothing else.
    expect(Object.keys(stored).sort()).toEqual(['obtainedAt', 'refreshToken']);
  });
});
