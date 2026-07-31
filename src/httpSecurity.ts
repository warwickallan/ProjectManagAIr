/**
 * Local HTTP surface guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * Project ManagAIr binds to loopback and has no authentication, but "loopback"
 * is not a security boundary against a web page the consultant happens to
 * visit. Two concrete attacks reach this server from an ordinary browser tab:
 *
 *  1. DNS rebinding. The attacker serves a page from `evil.example` with a
 *     very short DNS TTL, then re-answers `evil.example` as `127.0.0.1`. The
 *     browser now treats `http://evil.example:4318/` as same-origin with the
 *     attacker page, so every response is readable and no CORS preflight is
 *     involved. That is enough to repoint `projectsRoot` at an attacker-chosen
 *     folder and then drive `/api/files/open`.
 *
 *  2. Cross-origin simple requests. A page on some other local port
 *     (`http://localhost:5173`, another dev server, an Electron app) can issue
 *     a form POST that the browser will not preflight. It cannot read the
 *     response, but every route here is state-changing, so a blind write is
 *     already the whole attack.
 *
 * The two controls below are deliberately independent.
 *
 * HOST POLICY (primary control, defeats rebinding)
 * ------------------------------------------------
 * `Host` is a forbidden header: page JavaScript cannot set it. A browser
 * fetching `http://evil.example:4318/api/...` must send `Host: evil.example:4318`.
 * So requiring `Host` to be a loopback literal (`127.0.0.0/8`, `::1`,
 * `localhost`) rejects every rebinding attempt at the first byte, regardless of
 * what the DNS resolver was tricked into returning. The port, when an allowlist
 * is configured, must be a port this process is actually serving on; that also
 * catches misconfiguration. When no ports are configured any numeric port is
 * accepted, because the Windows launcher deliberately falls back to a nearby
 * free loopback port.
 *
 * We read `request.headers.host` directly rather than Express's `req.hostname`
 * so that `X-Forwarded-Host` can never influence the decision, whatever the
 * `trust proxy` setting is.
 *
 * ORIGIN POLICY (second control, defeats cross-origin local pages)
 * ---------------------------------------------------------------
 * `Origin` and `Referer` are also forbidden headers. When either is present it
 * must be loopback. That is the easy half.
 *
 * The hard half is an ABSENT `Origin`, and the decision matters:
 *
 *  - Requiring `Origin` unconditionally would break every legitimate
 *    non-browser client: curl, PowerShell `Invoke-RestMethod`, the Playwright
 *    `request` fixture used by the E2E suite, and the local launcher's health
 *    probe. None of them send `Origin`.
 *  - Accepting an absent `Origin` unconditionally would leave the exact hole
 *    the review names: a cross-origin HTML form POST is a "simple request", is
 *    not preflighted... except that browsers DO attach `Origin` to every
 *    request whose method is not GET/HEAD, including form submissions. So a
 *    state-changing request with no `Origin` at all is not something a modern
 *    browser produces.
 *
 * The discriminator is `Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest`.
 * Chrome, Edge, Firefox and Safari attach these to every request, and they are
 * forbidden headers too, so a page cannot strip them. curl and friends never
 * send them. That gives a policy that is strict against browsers and permissive
 * for tooling:
 *
 *   safe methods (GET/HEAD/OPTIONS)
 *     Host must be loopback. Origin/Referer, if present, must be loopback.
 *     Absent Origin is fine (browsers omit it on same-origin navigations).
 *
 *   state-changing methods (POST/PUT/PATCH/DELETE and anything else)
 *     Host must be loopback, AND one of:
 *       - Origin present and loopback                                  -> allow
 *       - Origin absent and no Sec-Fetch-* headers present             -> allow
 *         (non-browser client)
 *       - Origin absent but Sec-Fetch-* present                        -> deny
 *         (a browser that withheld Origin: not a shape any real browser
 *          produces for a state-changing request, so treat it as forged)
 *     and in every branch a present `Referer` must also be loopback.
 *
 * `Sec-Fetch-Site: same-origin` on a rebound request is accompanied by an
 * attacker `Origin` and an attacker `Host`, so it fails both controls anyway.
 *
 * Nothing here sets Access-Control-Allow-Origin, so a rejected cross-origin
 * request also cannot read the rejection body.
 */

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface GuardRequestLike {
  method?: string;
  headers: HeaderBag;
}

export interface GuardResponseLike {
  status(code: number): GuardResponseLike;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

export interface LocalOriginGuardOptions {
  /**
   * Ports accepted in the `Host` header. Pass the port this process is actually
   * listening on. Omit (or pass an empty array) to accept any numeric port,
   * which is what the Windows launcher's free-port fallback needs.
   */
  ports?: readonly number[] | null;
  /** Extra hostnames to treat as loopback. Use sparingly; defaults are enough. */
  extraHostnames?: readonly string[];
  /** Methods treated as non-state-changing. */
  safeMethods?: readonly string[];
  /** Environment used for the `PROJECTMANAGAIR_EXTRA_ALLOWED_PORTS` override. */
  env?: NodeJS.ProcessEnv;
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; status: number; code: GuardDenialCode; reason: string };

export type GuardDenialCode =
  | 'host-missing'
  | 'host-not-loopback'
  | 'host-port-not-allowed'
  | 'origin-not-loopback'
  | 'referer-not-loopback'
  | 'origin-required';

const defaultSafeMethods = ['GET', 'HEAD', 'OPTIONS'] as const;
const loopbackNames = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
const secFetchHeaders = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'] as const;

function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]).trim() : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Split a `host:port` authority, handling the `[::1]:4318` bracketed IPv6 form. */
export function splitAuthority(value: string): { hostname: string; port: number | null } | null {
  const authority = value.trim();
  if (!authority) return null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return null;
    const hostname = authority.slice(1, close).toLowerCase();
    const rest = authority.slice(close + 1);
    if (!rest) return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { hostname, port };
  }
  const colon = authority.indexOf(':');
  if (colon < 0) return { hostname: authority.toLowerCase(), port: null };
  if (authority.indexOf(':', colon + 1) >= 0) {
    // Unbracketed IPv6 literal such as `::1`. There is no port in this form.
    return { hostname: authority.toLowerCase(), port: null };
  }
  const port = Number(authority.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { hostname: authority.slice(0, colon).toLowerCase(), port };
}

/** True for `localhost`, `::1` and anything in 127.0.0.0/8. */
export function isLoopbackHostname(hostname: string, extraHostnames: readonly string[] = []): boolean {
  // `new URL('http://[::1]').hostname` keeps the brackets; strip them so both
  // the Host-header and the Origin/Referer paths compare the same literal.
  const name = hostname.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1').replace(/\.$/, '');
  if (!name) return false;
  if (loopbackNames.has(name)) return true;
  if (extraHostnames.some((candidate) => candidate.trim().toLowerCase() === name)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 127;
}

function allowedPorts(options: LocalOriginGuardOptions): number[] {
  const configured = (options.ports ?? []).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  const env = options.env ?? process.env;
  const extra = String(env.PROJECTMANAGAIR_EXTRA_ALLOWED_PORTS ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return [...new Set([...configured, ...extra])];
}

/** Evaluate a `Host` authority against the loopback + port policy. */
export function evaluateHost(host: string | null, options: LocalOriginGuardOptions = {}): GuardDecision {
  if (!host) return { allowed: false, status: 403, code: 'host-missing', reason: 'A Host header is required.' };
  const parts = splitAuthority(host);
  if (!parts || !isLoopbackHostname(parts.hostname, options.extraHostnames ?? [])) {
    return { allowed: false, status: 403, code: 'host-not-loopback', reason: 'Host must be a loopback address.' };
  }
  const ports = allowedPorts(options);
  if (ports.length > 0 && parts.port !== null && !ports.includes(parts.port)) {
    return { allowed: false, status: 403, code: 'host-port-not-allowed', reason: 'Host port is not served by this process.' };
  }
  return { allowed: true };
}

/** True when an `Origin`/`Referer` value points at a loopback http(s) URL. */
export function isLoopbackOriginValue(value: string, options: LocalOriginGuardOptions = {}): boolean {
  const candidate = value.trim();
  if (!candidate || candidate === 'null') return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!isLoopbackHostname(url.hostname, options.extraHostnames ?? [])) return false;
  const ports = allowedPorts(options);
  if (ports.length > 0 && url.port && !ports.includes(Number(url.port))) return false;
  return true;
}

function looksLikeBrowser(headers: HeaderBag): boolean {
  return secFetchHeaders.some((name) => headerValue(headers, name) !== null);
}

/**
 * The whole policy as a pure function. `request` only needs `method` and
 * `headers`, so this is directly unit-testable without an HTTP server.
 */
export function evaluateLocalRequest(request: GuardRequestLike, options: LocalOriginGuardOptions = {}): GuardDecision {
  const headers = request.headers ?? {};
  const hostDecision = evaluateHost(headerValue(headers, 'host'), options);
  if (!hostDecision.allowed) return hostDecision;

  const origin = headerValue(headers, 'origin');
  if (origin !== null && !isLoopbackOriginValue(origin, options)) {
    return { allowed: false, status: 403, code: 'origin-not-loopback', reason: 'Origin must be a loopback address.' };
  }

  const referer = headerValue(headers, 'referer');
  if (referer !== null && !isLoopbackOriginValue(referer, options)) {
    return { allowed: false, status: 403, code: 'referer-not-loopback', reason: 'Referer must be a loopback address.' };
  }

  const safeMethods = (options.safeMethods ?? defaultSafeMethods).map((method) => method.toUpperCase());
  const method = String(request.method ?? 'GET').toUpperCase();
  if (safeMethods.includes(method)) return { allowed: true };

  if (origin === null && looksLikeBrowser(headers)) {
    // A browser stripped Origin from a state-changing request. Browsers do not
    // do this; something is forging a "simple request". Fail closed.
    return {
      allowed: false,
      status: 403,
      code: 'origin-required',
      reason: 'A browser-issued state-changing request must carry a loopback Origin header.',
    };
  }
  return { allowed: true };
}

/**
 * Express-compatible middleware. Mount it as the FIRST `app.use(...)`, before
 * the body parser, so a rejected request is never parsed or acted on.
 */
export function createLocalOriginGuard(options: LocalOriginGuardOptions = {}) {
  return function localOriginGuard(request: GuardRequestLike, response: GuardResponseLike, next: (error?: unknown) => void): void {
    const decision = evaluateLocalRequest(request, options);
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    response.status(decision.status).json({ error: decision.reason, code: decision.code });
  };
}
