import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import fixtureJson from '../fixtures/portfolio.json';
import { App } from '../src/App';
import { buildPortfolioResponse, buildProjectResponse, portfolioFixtureSchema } from '../src/domain';

const fixture = portfolioFixtureSchema.parse(fixtureJson);
const jsonResponse = (data: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });

beforeEach(() => {
  window.location.hash = '#/';
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
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Fixture validation failed' }, false)));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Fixture validation failed');
  });

  it('keeps a truthful loading state while data is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App />);
    expect(screen.getByTestId('loading-state')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a stale data notice', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(buildPortfolioResponse(fixture, new Date('2026-08-05T12:00:00Z')))));
    render(<App />);
    expect(await screen.findByText('Fixture snapshot is stale')).toBeInTheDocument();
  });

  it('renders every required project detail section', async () => {
    window.location.hash = '#/projects/atlas';
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf)))));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument();
    for (const name of ['Actions', 'Risks and issues', 'Decisions', 'Open questions', 'Milestones', 'Work packages', 'AI write and verification status', 'Latest project activity']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('renders an honest empty state for an empty project section', async () => {
    window.location.hash = '#/projects/atlas';
    const response = buildProjectResponse(fixture, 'atlas', new Date(fixture.asOf));
    if (!response) throw new Error('Expected fixture project');
    response.project.openQuestions = [];
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(response)));
    render(<App />);
    expect(await screen.findByText('No open questions.')).toBeInTheDocument();
  });
});
