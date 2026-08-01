import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import fixtureJson from '../fixtures/portfolio.json';
import { App } from '../src/App';
import { formatDate } from '../src/components';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);
const jsonResponse = (data: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });

/** Synthetic identity, matching the shape both consultant panels read. */
const syntheticIdentity = {
  skillId: 'consultant-reasoning', skillVersion: '0.1.0', promptTemplateVersion: 'consultant-reasoning-prompt-v1',
  providerId: 'local-stub', modelLabel: 'stub-model', packetContractVersion: 1,
  providerAvailable: false, providerDetail: 'no provider configured in this environment', skillResolved: true,
};

/** A read of the reasoning cache that has never been generated: zero calls, no result. */
const reasoningView = {
  projectId: 'atlas', mode: 'meeting', current: null, latest: null, state: 'none',
  projectStateHash: '0'.repeat(64), registerRevision: 1, identity: syntheticIdentity,
  lastFailure: null, providerCallsThisRequest: 0, evidence: { rows: {}, unresolved: [] },
};

/** The demoted deterministic fallback panel's read. */
const consultantView = {
  projectId: 'atlas', mode: 'meeting', deterministic: null, synthesis: null,
  identity: syntheticIdentity, synthesisState: 'none', failure: null, providerCallsThisRequest: 0,
};

beforeEach(() => {
  window.location.hash = '#/projects';
  vi.restoreAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe('Cockpit states and routes', () => {
  it('renders a person-neutral personalized portfolio and two project cards', async () => {
    const customFixture = { ...fixture, userConfig: { userId: 'current-user', displayName: 'Priya' } };
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(buildPortfolioResponse(customFixture, new Date(customFixture.asOf)))));
    render(<App />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Needs Priya' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project Beacon' })).toBeInTheDocument();
  });

  it('renders the error state when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Database read failed' }, false)));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database read failed');
  });

  it('keeps a truthful loading state while data is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App />);
    expect(screen.getByTestId('loading-state')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a stale data notice', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(buildPortfolioResponse(fixture, new Date('2026-08-05T12:00:00Z')))));
    render(<App />);
    expect(await screen.findByText('Data snapshot is stale')).toBeInTheDocument();
  });

  it('renders true project tab routes for required project detail sections', async () => {
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/consultant-reasoning')) return jsonResponse(reasoningView);
      if (url.includes('/consultant-view')) return jsonResponse(consultantView);
      return jsonResponse(response);
    }));
    for (const [route, heading] of [
      ['meeting-brief', /Meeting Brief/i], ['my-actions', /My Actions/i], ['customer-dependencies', /Customer Dependencies/i],
      ['decisions-needed', /Decisions Needed/i], ['risks-blockers', /Risks & Blockers/i], ['questions', /^Questions$/i],
      ['recent-changes', /Recent Changes/i], ['work-packages', /Work Packages/i], ['activity', /AI write and verification status/i],
    ] as const) {
      cleanup();
      window.location.hash = `#/projects/atlas/${route}`;
      render(<App />);
      expect(await screen.findByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('does not keep the nine raw registers as independent primary tabs, and redirects an old register URL into the equivalent Mined Data state', async () => {
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/consultant-reasoning')) return jsonResponse(reasoningView);
      if (url.includes('/consultant-view')) return jsonResponse(consultantView);
      return jsonResponse(response);
    }));
    window.location.hash = '#/projects/atlas/overview';
    render(<App />);
    await screen.findByRole('heading', { name: 'Project Atlas' });
    for (const label of ['Actions', 'Risks & Issues', 'Decisions', 'Config Changes', 'Open Questions', 'Milestones', 'Entities', 'Sources', 'Uncertainty']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }

    cleanup();
    window.location.hash = '#/projects/atlas/actions?record=SYN-A-001';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Mined Data' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/projects/atlas/mined-data?register=Actions&record=SYN-A-001');
  });

  it('renders the Mined Data workspace on its own route rather than falling back to Overview', async () => {
    window.location.hash = '#/projects/atlas/mined-data';
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(response)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Mined Data' })).toBeInTheDocument();
    // The fallback to 'overview' would have rendered the project hero instead.
    expect(screen.queryByRole('heading', { name: /Consultant reasoning/i })).not.toBeInTheDocument();
  });

  it('never posts to the consultant-reasoning endpoint while navigating the cockpit', async () => {
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    const calls: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.fn((input: unknown, init?: { method?: string }) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/consultant-reasoning')) return jsonResponse(reasoningView);
      if (url.includes('/consultant-view')) return jsonResponse(consultantView);
      return jsonResponse(response);
    });
    vi.stubGlobal('fetch', fetchSpy);
    for (const route of ['overview', 'meeting-brief', 'my-actions', 'customer-dependencies', 'decisions-needed', 'risks-blockers', 'questions', 'recent-changes', 'mined-data', 'actions', 'decisions'] as const) {
      cleanup();
      window.location.hash = `#/projects/atlas/${route}`;
      render(<App />);
      expect(await screen.findByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument();
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method.toUpperCase() === 'GET')).toBe(true);
    expect(calls.filter((call) => call.url.includes('consultant-reasoning') && call.method.toUpperCase() === 'POST')).toHaveLength(0);
  });

  it('leads the overview with consultant reasoning, explains the ungenerated state and disables Generate when no provider is reachable', async () => {
    window.location.hash = '#/projects/atlas/overview';
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/consultant-reasoning')) return jsonResponse(reasoningView);
      if (url.includes('/consultant-view')) return jsonResponse(consultantView);
      return jsonResponse(response);
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Consultant reasoning' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /No consultant reasoning has been generated/i })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Mined Data' }).every((link) => link.getAttribute('href') === '#/projects/atlas/mined-data')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Generate consultant reasoning' })).toBeDisabled();
    // Demoted to a collapsed <details>/<summary>, not a competing heading.
    expect(screen.getByText(/Zero-call deterministic fallback/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Zero-call deterministic fallback/i })).not.toBeInTheDocument();
  });

  it('renders an honest empty state for an empty register inside Mined Data', async () => {
    window.location.hash = '#/projects/atlas/mined-data?register=Open_Questions';
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    if (!response) throw new Error('Expected fixture project');
    response.project.registerRows = response.project.registerRows.filter((row) => row.registerName !== 'Open_Questions');
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(response)));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Mined Data' })).toBeInTheDocument();
    expect(await screen.findByText('No register rows loaded.')).toBeInTheDocument();
  });
});


describe('date presentation', () => {
  it('does not display the legacy unscheduled sentinel as a real date', () => {
    expect(formatDate('9999-12-31')).toBe('Not set');
  });
});
