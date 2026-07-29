import { useApi, type PortfolioResponse } from './api';
import { ActivityList, AttentionList, ErrorState, FreshnessNotice, LoadingState, PageIntro, Section, StatusChip, formatDate } from './components';

const statDefinitions = [
  { key: 'projects', label: 'Active projects', accent: 'blue' },
  { key: 'attention', label: 'Need attention', accent: 'coral' },
  { key: 'highRiskIssues', label: 'High risks & issues', accent: 'amber' },
  { key: 'pendingDecisions', label: 'Pending decisions', accent: 'violet' },
  { key: 'aiAwaitingVerification', label: 'AI checks outstanding', accent: 'teal' },
] as const;

export function PortfolioPage() {
  const state = useApi<PortfolioResponse>('/api/portfolio');
  if (state.status === 'loading') return <LoadingState label="Loading portfolio" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const data = state.data;
  const projectNames = Object.fromEntries(data.projects.map((project) => [project.id, project.name]));

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Portfolio control"
        title="Implementation focus, without the noise."
        description="Two fictional projects. One clear view of decisions, blockers, delivery signals, and AI verification."
        aside={<FreshnessNotice freshness={data.freshness} asOf={data.asOf} />}
      />

      <div className="demo-banner" role="note">
        <span aria-hidden="true">◇</span>
        <div><strong>{data.environment}</strong><p>Every name, date, project, and delivery record on this screen is synthetic.</p></div>
        <span className="read-only-seal">Read only</span>
      </div>

      <section className="stats-grid" aria-label="Portfolio summary">
        {statDefinitions.map((definition) => (
          <article className={`stat-card ${definition.accent}`} key={definition.key}>
            <span className="stat-icon" aria-hidden="true">{statGlyph(definition.key)}</span>
            <div><strong>{data.counts[definition.key]}</strong><span>{definition.label}</span></div>
          </article>
        ))}
      </section>

      <Section id="attention" title={data.attentionLabel} kicker="Portfolio priority" count={data.attention.length} className="attention-panel">
        <p className="section-description">The queue is derived from explicit ownership, delivery urgency, and verification state. It is not manually curated.</p>
        <AttentionList items={data.attention} />
      </Section>

      <section className="portfolio-block" aria-labelledby="projects-heading">
        <header className="block-heading"><div><p className="section-kicker">Delivery landscape</p><h2 id="projects-heading">Implementation projects</h2></div><span>{data.projects.length} fictional projects</span></header>
        <div className="project-grid">
          {data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}
        </div>
      </section>

      <Section id="activity" title="Latest project activity" kicker="Across the portfolio" count={data.activity.length}>
        <ActivityList activity={data.activity} projectNames={projectNames} />
      </Section>
    </div>
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
        <span>{project.nextMilestone ? formatDate(project.nextMilestone.targetDate) : '—'}</span>
      </div>
      <footer className="project-card-foot"><span>Owner · {project.owner}</span><a href={`#/projects/${project.id}`}>Open project <span aria-hidden="true">→</span></a></footer>
    </article>
  );
}

function statGlyph(key: typeof statDefinitions[number]['key']): string {
  return ({ projects: '◇', attention: '!', highRiskIssues: '△', pendingDecisions: '?', aiAwaitingVerification: 'AI' } as const)[key];
}
