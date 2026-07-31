import {
  createLocalOriginGuard,
  evaluateHost,
  evaluateLocalRequest,
  isLoopbackHostname,
  isLoopbackOriginValue,
  splitAuthority,
  type GuardDecision,
  type HeaderBag,
} from '../src/httpSecurity';

const servedPort = 4318;
const e2ePort = 4321;
const ports = [servedPort, e2ePort];

function decide(method: string, headers: HeaderBag, options = { ports }): GuardDecision {
  return evaluateLocalRequest({ method, headers }, options);
}

/** Headers a real Chrome/Edge/Firefox request carries. Sec-Fetch-* are forbidden headers. */
function browser(headers: HeaderBag): HeaderBag {
  return { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', ...headers };
}

describe('loopback authority parsing', () => {
  it('splits the host:port forms an HTTP client can send', () => {
    expect(splitAuthority('127.0.0.1:4318')).toEqual({ hostname: '127.0.0.1', port: 4318 });
    expect(splitAuthority('localhost')).toEqual({ hostname: 'localhost', port: null });
    expect(splitAuthority('[::1]:4321')).toEqual({ hostname: '::1', port: 4321 });
    expect(splitAuthority('[::1]')).toEqual({ hostname: '::1', port: null });
    expect(splitAuthority('127.0.0.1:not-a-port')).toBeNull();
    expect(splitAuthority('')).toBeNull();
  });

  it('recognises the loopback range and nothing else', () => {
    for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]'.slice(1, -1)]) {
      expect(isLoopbackHostname(name)).toBe(true);
    }
    for (const name of ['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', '10.0.0.5', '192.168.1.4', '0.0.0.0', '128.0.0.1', '']) {
      expect(isLoopbackHostname(name)).toBe(false);
    }
  });
});

describe('Host policy (DNS rebinding)', () => {
  it('rejects a rebound attacker hostname even though it resolves to 127.0.0.1', () => {
    // The browser resolves evil.example to 127.0.0.1 but still sends the
    // attacker's name in Host, which page JavaScript cannot change.
    const decision = decide('POST', browser({ host: 'evil.example:4318', origin: 'http://evil.example:4318' }));
    expect(decision).toMatchObject({ allowed: false, status: 403, code: 'host-not-loopback' });
  });

  it('rejects a rebinding attempt that hides the port and omits Origin', () => {
    expect(decide('POST', browser({ host: 'rebind.attacker.test' }))).toMatchObject({ allowed: false, code: 'host-not-loopback' });
  });

  it('rejects a hostname that merely embeds a loopback literal', () => {
    expect(decide('GET', { host: '127.0.0.1.attacker.test:4318' })).toMatchObject({ allowed: false, code: 'host-not-loopback' });
  });

  it('rejects a missing Host header', () => {
    expect(decide('POST', {})).toMatchObject({ allowed: false, code: 'host-missing' });
  });

  it('allows every loopback Host form the launcher and the Cockpit produce', () => {
    for (const host of ['127.0.0.1:4318', 'localhost:4318', '[::1]:4318', '127.0.0.1']) {
      expect(evaluateHost(host, { ports })).toEqual({ allowed: true });
    }
  });

  it('allows the E2E server port and rejects a port this process does not serve', () => {
    expect(decide('POST', browser({ host: `127.0.0.1:${e2ePort}`, origin: `http://127.0.0.1:${e2ePort}` }))).toEqual({ allowed: true });
    expect(decide('POST', browser({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }))).toMatchObject({ allowed: false, code: 'host-port-not-allowed' });
  });

  it('accepts any loopback port when no port allowlist is configured (launcher free-port fallback)', () => {
    expect(evaluateHost('127.0.0.1:51234', {})).toEqual({ allowed: true });
    expect(evaluateHost('evil.example:51234', {})).toMatchObject({ allowed: false, code: 'host-not-loopback' });
  });

  it('reads the allowlist extension from the environment', () => {
    const env = { PROJECTMANAGAIR_EXTRA_ALLOWED_PORTS: '4321, 7000' } as NodeJS.ProcessEnv;
    expect(evaluateHost('127.0.0.1:7000', { ports: [servedPort], env })).toEqual({ allowed: true });
    expect(evaluateHost('127.0.0.1:7001', { ports: [servedPort], env })).toMatchObject({ allowed: false, code: 'host-port-not-allowed' });
  });
});

describe('Origin and Referer policy', () => {
  it('rejects a cross-origin Origin even when Host is loopback', () => {
    expect(decide('POST', browser({ host: '127.0.0.1:4318', origin: 'http://evil.example' })))
      .toMatchObject({ allowed: false, code: 'origin-not-loopback' });
  });

  it('rejects another local port driving the API cross-origin', () => {
    // A page served by a different local dev server is still cross-origin, and
    // a form POST from it would not be preflighted.
    expect(decide('POST', browser({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:5173' })))
      .toMatchObject({ allowed: false, code: 'origin-not-loopback' });
  });

  it('rejects an opaque Origin', () => {
    expect(decide('POST', browser({ host: '127.0.0.1:4318', origin: 'null' })))
      .toMatchObject({ allowed: false, code: 'origin-not-loopback' });
  });

  it('rejects a non-loopback Referer even when Origin is absent', () => {
    expect(decide('GET', { host: '127.0.0.1:4318', referer: 'http://evil.example/page' }))
      .toMatchObject({ allowed: false, code: 'referer-not-loopback' });
  });

  it('accepts the Cockpit driving its own API', () => {
    expect(decide('POST', browser({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318', referer: 'http://127.0.0.1:4318/settings' })))
      .toEqual({ allowed: true });
  });

  it('classifies loopback origin values', () => {
    expect(isLoopbackOriginValue('http://localhost:4318')).toBe(true);
    expect(isLoopbackOriginValue('http://[::1]:4318')).toBe(true);
    expect(isLoopbackOriginValue('https://127.0.0.1:4318')).toBe(true);
    expect(isLoopbackOriginValue('http://evil.example')).toBe(false);
    expect(isLoopbackOriginValue('file:///etc/passwd')).toBe(false);
    expect(isLoopbackOriginValue('not a url')).toBe(false);
    expect(isLoopbackOriginValue('null')).toBe(false);
  });
});

describe('absent-Origin policy', () => {
  it('allows a non-browser client to POST without Origin (curl, PowerShell, Playwright request fixture)', () => {
    // No Sec-Fetch-* headers: nothing in this request came from a browser.
    expect(decide('POST', { host: '127.0.0.1:4318', 'user-agent': 'curl/8.5.0' })).toEqual({ allowed: true });
    expect(decide('POST', { host: `127.0.0.1:${e2ePort}` })).toEqual({ allowed: true });
  });

  it('rejects a browser-issued state-changing request that withheld Origin', () => {
    // Browsers attach Origin to every non-GET/HEAD request, including form
    // submissions, and Sec-Fetch-* cannot be removed by page script. A
    // state-changing request that looks like a browser but has no Origin is
    // therefore forged, and this is the "simple request" hole being closed.
    expect(decide('POST', browser({ host: '127.0.0.1:4318' })))
      .toMatchObject({ allowed: false, status: 403, code: 'origin-required' });
    expect(decide('POST', { host: '127.0.0.1:4318', 'sec-fetch-site': 'cross-site' }))
      .toMatchObject({ allowed: false, code: 'origin-required' });
  });

  it('allows browser GET navigations without Origin', () => {
    expect(decide('GET', browser({ host: '127.0.0.1:4318', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })))
      .toEqual({ allowed: true });
    expect(decide('HEAD', browser({ host: '127.0.0.1:4318' }))).toEqual({ allowed: true });
  });

  it('applies the state-changing policy to every unsafe method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      expect(decide(method, browser({ host: '127.0.0.1:4318' }))).toMatchObject({ allowed: false, code: 'origin-required' });
    }
  });
});

describe('middleware behaviour', () => {
  function run(method: string, headers: HeaderBag) {
    const guard = createLocalOriginGuard({ ports });
    const calls: { status: number | null; body: unknown; headers: Record<string, string>; nextCalled: boolean } = { status: null, body: null, headers: {}, nextCalled: false };
    const response = {
      status(code: number) { calls.status = code; return response; },
      setHeader(name: string, value: string) { calls.headers[name] = value; return response; },
      json(body: unknown) { calls.body = body; return response; },
    };
    guard({ method, headers }, response, () => { calls.nextCalled = true; });
    return calls;
  }

  it('calls next for an allowed request and never sets an allow-origin header', () => {
    const result = run('POST', browser({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318' }));
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeNull();
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('answers 403 with a coded body and does not call next for a rebound host', () => {
    const result = run('POST', browser({ host: 'evil.example:4318', origin: 'http://evil.example:4318' }));
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'host-not-loopback' });
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(result.headers['Cache-Control']).toBe('no-store');
  });
});
