import { useEffect, useState } from 'react';
import { useApi, type PortfolioResponse } from './api';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, Section, StatusChip, formatDate } from './components';

type StorageSettings = { projectsRoot: string | null; projectFolderNamingFormat: string; exists: boolean; writable: boolean; configured: boolean; verifiedAt: string | null; lastWriteTestAt: string | null; message?: string; writeTest?: boolean };

const statDefinitions = [
  { key: 'projects', label: 'Active projects', accent: 'blue' },
  { key: 'attention', label: 'Need attention', accent: 'coral' },
  { key: 'highRiskIssues', label: 'High risks & issues', accent: 'amber' },
  { key: 'pendingDecisions', label: 'Pending decisions', accent: 'violet' },
  { key: 'awaitingSourceReview', label: 'Sources to review', accent: 'teal' },
] as const;

export function PortfolioPage({ initialSection }: { initialSection?: 'attention' } = {}) {
  const state = useApi<PortfolioResponse>('/api/portfolio');
  const [refreshKey, setRefreshKey] = useState(0);
  if (state.status === 'loading') return <LoadingState label="Loading portfolio" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const data = state.data;
  if (initialSection === 'attention') window.requestAnimationFrame(() => document.getElementById('attention')?.scrollIntoView({ block: 'start' }));
  const projectNames = Object.fromEntries(data.projects.map((project) => [project.id, project.name]));
  const isEmpty = data.projects.length === 0;

  return (
    <div className="page-stack" key={refreshKey}>
      <PageIntro
        eyebrow="Portfolio control"
        title="Project portfolio workspace"
        description="Create projects, manage local OneDrive-backed workspaces, review source intake, and operate the portfolio from the Cockpit."
        aside={<FreshnessNotice freshness={data.freshness} asOf={data.asOf} />}
      />

      <div className="demo-banner" role="note">
        <span aria-hidden="true">PM</span>
        <div><strong>{data.environment}</strong><p>{isEmpty ? 'No projects exist in the local operational database yet.' : 'Project lifecycle state is backed by the local operational database.'}</p></div>
        <span className="read-only-seal">Local only</span>
      </div>

      <StorageSettingsPanel />
      <NewProjectPanel onCreated={(projectId) => { window.location.hash = `#/projects/${projectId}`; setRefreshKey((key) => key + 1); }} />

      <section className="stats-grid" aria-label="Portfolio summary">
        {statDefinitions.map((definition) => (
          <article className={`stat-card ${definition.accent}`} key={definition.key}>
            <span className="stat-icon" aria-hidden="true">{statGlyph(definition.key)}</span>
            <div><strong>{data.counts[definition.key]}</strong><span>{definition.label}</span></div>
          </article>
        ))}
      </section>

      <Section id="attention" title={data.attentionLabel} kicker="Portfolio priority" count={data.attention.length} className="attention-panel">
        <p className="section-description">The queue is derived from explicit ownership, delivery urgency, source review, and verification state.</p>
        <AttentionList items={data.attention} emptyLabel={isEmpty ? 'Create a project to start building portfolio attention.' : 'Nothing needs your attention.'} />
      </Section>

      <section className="portfolio-block" aria-labelledby="projects-heading">
        <header className="block-heading"><div><p className="section-kicker">Delivery landscape</p><h2 id="projects-heading">Implementation projects</h2></div><span>{data.projects.length} projects</span></header>
        {isEmpty ? <EmptyState>No projects have been created in Project ManagAIr yet.</EmptyState> : (
          <div className="project-grid">
            {data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}
          </div>
        )}
      </section>

      <Section id="activity" title="Latest project activity" kicker="Across the portfolio" count={data.activity.length}>
        <ActivityList activity={data.activity} projectNames={projectNames} />
      </Section>
    </div>
  );
}

function StorageSettingsPanel() {
  const state = useApi<StorageSettings>('/api/project-storage/settings');
  const [projectsRoot, setProjectsRoot] = useState('');
  const [naming, setNaming] = useState('{code} - {name}');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedSettings, setSavedSettings] = useState<StorageSettings | null>(null);

  useEffect(() => {
    if (state.status !== 'success' || savedSettings) return;
    setProjectsRoot(state.data.projectsRoot ?? '');
    setNaming(state.data.projectFolderNamingFormat);
  }, [savedSettings, state]);

  if (state.status === 'loading') return <div className="panel settings-panel">Loading storage settings</div>;
  if (state.status === 'error') return <ErrorState message={state.error} />;
  const settings = savedSettings ?? state.data;

  async function save() {
    setBusy(true);
    const result = await postJson<StorageSettings>('/api/project-storage/settings', 'POST', { projectsRoot, projectFolderNamingFormat: naming });
    setSavedSettings(result);
    setMessage(result.projectsRoot ? 'Local project storage configuration saved outside Git.' : 'Storage root cleared.');
    setBusy(false);
  }

  async function verify(writeTest = false) {
    setBusy(true);
    const result = await postJson<StorageSettings>('/api/project-storage/verify', 'POST', { writeTest });
    setSavedSettings(result);
    setMessage(result.message ?? (result.writable ? 'Path verified.' : 'Path is not writable.'));
    setBusy(false);
  }

  return (
    <section className="panel settings-panel" aria-labelledby="storage-heading">
      <header className="section-head"><div><p className="section-kicker">Local OneDrive configuration</p><h2 id="storage-heading">Project storage root</h2></div><StatusChip value={settings.writable ? 'verified' : settings.configured ? 'watch' : 'pending'} label={settings.writable ? 'Writable' : settings.configured ? 'Needs check' : 'Not set'} /></header>
      <div className="form-grid two">
        <label><span className="field-label">Projects root</span><input className="input" value={projectsRoot} onChange={(event) => setProjectsRoot(event.target.value)} placeholder="Enter local synced projects root" /></label>
        <label><span className="field-label">Folder naming</span><input className="input" value={naming} onChange={(event) => setNaming(event.target.value)} /></label>
      </div>
      <p className="section-description">Current configured root: {settings.projectsRoot ?? 'Not set'}. The local JSON file is ignored by Git.</p>
      <div className="action-row"><button className="button" onClick={save} disabled={busy}>Save</button><button className="button secondary" onClick={() => verify(false)} disabled={busy || !settings.configured}>Verify path</button><button className="button secondary" onClick={() => verify(true)} disabled={busy || !settings.configured}>Write test</button></div>
      {message ? <p className="inline-note">{message}</p> : null}
    </section>
  );
}

function NewProjectPanel({ onCreated }: { onCreated: (projectId: string) => void }) {
  const [form, setForm] = useState({ code: '', name: '', customer: '', description: '', status: 'on-track', owner: '', startDate: '', targetDate: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = { ...form, startDate: form.startDate || undefined, targetDate: form.targetDate || undefined };
      const result = await postJson<{ projectId: string }>('/api/projects', 'POST', payload);
      onCreated(result.projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Project could not be created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel" aria-labelledby="new-project-heading">
      <header className="section-head"><div><p className="section-kicker">New project</p><h2 id="new-project-heading">+ New Project</h2></div></header>
      <form onSubmit={submit} className="lifecycle-form">
        <div className="form-grid four">
          <label><span className="field-label">Project code</span><input className="input" required value={form.code} onChange={(event) => set('code', event.target.value)} /></label>
          <label><span className="field-label">Project name</span><input className="input" required value={form.name} onChange={(event) => set('name', event.target.value)} /></label>
          <label><span className="field-label">Customer</span><input className="input" required value={form.customer} onChange={(event) => set('customer', event.target.value)} /></label>
          <label><span className="field-label">Status</span><select className="input" value={form.status} onChange={(event) => set('status', event.target.value)}><option value="on-track">On track</option><option value="watch">Watch</option><option value="at-risk">At risk</option><option value="blocked">Blocked</option><option value="complete">Complete</option></select></label>
          <label><span className="field-label">Owner</span><input className="input" required value={form.owner} onChange={(event) => set('owner', event.target.value)} /></label>
          <label><span className="field-label">Start date</span><input className="input" type="date" value={form.startDate} onChange={(event) => set('startDate', event.target.value)} /></label>
          <label><span className="field-label">Target completion</span><input className="input" type="date" value={form.targetDate} onChange={(event) => set('targetDate', event.target.value)} /></label>
        </div>
        <label><span className="field-label">Description</span><textarea className="input textarea" required value={form.description} onChange={(event) => set('description', event.target.value)} /></label>
        <div className="action-row"><button className="button" disabled={busy}>Create project</button>{error ? <span className="form-error">{error}</span> : null}</div>
      </form>
    </section>
  );
}

function ProjectCard({ project }: { project: PortfolioResponse['projects'][number] }) {
  return (
    <article className="project-card">
      <div className="project-card-top">
        <span className="project-code">{project.code}</span>
        <StatusChip value={project.deliveryStatus} />
      </div>
      <div className="project-card-body">
        <p className="project-stage">{project.stage}</p>
        <h3><a href={`#/projects/${project.id}`}>{project.name}</a></h3>
        <p>{project.summary}</p>
      </div>
      <dl className="project-signals">
        <div><dt>Needs attention</dt><dd className={project.attentionCount > 0 ? 'signal-hot' : ''}>{project.attentionCount}</dd></div>
        <div><dt>High risks / issues</dt><dd>{project.highRiskIssueCount}</dd></div>
        <div><dt>Target</dt><dd>{formatDate(project.targetDate)}</dd></div>
      </dl>
      <div className="milestone-strip">
        <div><small>Next milestone</small><strong>{project.nextMilestone?.title ?? 'Not set'}</strong></div>
        <span>{project.nextMilestone ? formatDate(project.nextMilestone.targetDate) : '-'}</span>
      </div>
      <footer className="project-card-foot"><span>Owner - {project.owner}</span><a href={`#/projects/${project.id}`}>Open project <span aria-hidden="true">{'->'}</span></a></footer>
    </article>
  );
}

async function postJson<T>(url: string, method: 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}

function statGlyph(key: typeof statDefinitions[number]['key']): string {
  return ({ projects: 'PM', attention: '!', highRiskIssues: '!', pendingDecisions: '?', awaitingSourceReview: 'SRC' } as const)[key];
}
