import { useEffect } from 'react';
import { useApi, type ProjectResponse } from './api';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, ProgressBar, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

const sections = [
  ['attention', 'Attention'], ['actions', 'Actions'], ['risk-issue', 'Risks & issues'], ['decision', 'Decisions'],
  ['open-question', 'Open questions'], ['milestone', 'Milestones'], ['work-package', 'Work packages'], ['ai-work', 'AI status'], ['activity', 'Activity'],
] as const;

export function ProjectPage({ projectId, focus }: { projectId: string; focus: string | null }) {
  const state = useApi<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}`);

  useEffect(() => {
    if (state.status !== 'success' || !focus) return;
    const target = document.getElementById(focus);
    if (target) window.requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focus, state.status]);

  if (state.status === 'loading') return <LoadingState label="Loading project detail" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const { project, attentionLabel, attention, freshness, asOf } = state.data;
  return (
    <div className="page-stack project-page">
      <a className="back-link" href="#/"><span aria-hidden="true">←</span> Portfolio</a>
      <PageIntro
        eyebrow={`${project.code} · ${project.stage}`}
        title={project.name}
        description={project.summary}
        aside={<FreshnessNotice freshness={freshness} asOf={asOf} />}
      />

      <section className="project-hero panel" aria-label="Project summary">
        <div className="project-hero-status"><StatusChip value={project.deliveryStatus} /><span>Delivery status</span></div>
        <dl>
          <div><dt>Owner</dt><dd>{project.owner}</dd></div>
          <div><dt>Target date</dt><dd>{formatDate(project.targetDate)}</dd></div>
          <div><dt>Stage</dt><dd>{project.stage}</dd></div>
          <div><dt>Last updated</dt><dd>{formatDateTime(project.updatedAt)}</dd></div>
        </dl>
      </section>

      <nav className="section-nav" aria-label="Project sections">
        {sections.map(([id, label]) => <a key={id} href={`#/projects/${project.id}?focus=${id}`}>{label}</a>)}
      </nav>

      <Section id="attention" title={attentionLabel} kicker="Project priority" count={attention.length} className="attention-panel">
        <AttentionList items={attention} emptyLabel="This project has nothing assigned to your attention." />
      </Section>

      <Section id="actions" title="Actions" kicker="Concrete next steps" count={project.actions.length}>
        <RecordTable
          label="Project actions"
          columns={['Action', 'Owner', 'Priority', 'Due', 'Status']}
          rows={project.actions.map((action) => [
            <RecordTitle key="title" title={action.title} summary={action.summary} attention={action.needsUserAttention && action.attentionOwner === state.data.userConfig.userId ? attentionLabel : null} />,
            action.owner,
            <StatusChip key="priority" value={action.priority} />,
            formatDate(action.dueDate),
            <StatusChip key="status" value={action.status} />,
          ])}
        />
      </Section>

      <Section id="risk-issue" title="Risks and issues" kicker="Threats to delivery" count={project.risksIssues.length}>
        <div className="record-grid">
          {project.risksIssues.length === 0 ? <EmptyState /> : project.risksIssues.map((item) => (
            <article className={`record-card severity-${item.severity}`} key={item.id}>
              <header><div><span className="record-type">{item.kind}</span><h3>{item.title}</h3></div><StatusChip value={item.severity} /></header>
              <p>{item.summary}</p>
              <dl className="detail-list"><div><dt>Impact</dt><dd>{item.impact}</dd></div><div><dt>Response</dt><dd>{item.response}</dd></div><div><dt>Owner</dt><dd>{item.owner}</dd></div><div><dt>Target resolution</dt><dd>{formatDate(item.targetResolutionDate)}</dd></div></dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="decision" title="Decisions" kicker="Choices and outcomes" count={project.decisions.length}>
        <div className="stacked-records">
          {project.decisions.length === 0 ? <EmptyState /> : project.decisions.map((decision) => (
            <article className="stacked-record" key={decision.id}>
              <div className="record-line"><div><h3>{decision.title}</h3><p>{decision.summary}</p></div><StatusChip value={decision.decisionStatus} /></div>
              <dl className="inline-details"><div><dt>Needed by</dt><dd>{formatDate(decision.decisionNeededBy)}</dd></div><div><dt>Options</dt><dd>{decision.optionsSummary}</dd></div>{decision.outcome ? <div><dt>Outcome</dt><dd>{decision.outcome}</dd></div> : null}</dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="open-question" title="Open questions" kicker="Unknowns to resolve" count={project.openQuestions.length}>
        <div className="stacked-records">
          {project.openQuestions.length === 0 ? <EmptyState>No open questions.</EmptyState> : project.openQuestions.map((question) => (
            <article className="stacked-record question-record" key={question.id}>
              <div className="record-line"><div><h3>{question.title}</h3><p>{question.question}</p></div>{question.blocking ? <StatusChip value="blocked" label="Blocking" /> : <StatusChip value={question.status} />}</div>
              <dl className="inline-details"><div><dt>Owner</dt><dd>{question.owner}</dd></div><div><dt>Answer needed</dt><dd>{formatDate(question.answerNeededBy)}</dd></div></dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="milestone" title="Milestones" kicker="Delivery checkpoints" count={project.milestones.length}>
        <div className="milestone-grid">
          {project.milestones.length === 0 ? <EmptyState /> : project.milestones.map((milestone) => (
            <article className="milestone-card" key={milestone.id}>
              <div className="record-line"><div><p className="record-type">{formatDate(milestone.targetDate)}</p><h3>{milestone.title}</h3></div><StatusChip value={milestone.milestoneStatus} /></div>
              <p>{milestone.summary}</p><ProgressBar value={milestone.completionPercent} label="Milestone completion" />
            </article>
          ))}
        </div>
      </Section>

      <Section id="work-package" title="Work packages" kicker="Bounded delivery units" count={project.workPackages.length}>
        <div className="work-package-list">
          {project.workPackages.length === 0 ? <EmptyState /> : project.workPackages.map((item) => (
            <article className="work-package" key={item.id}>
              <div className="work-package-main"><div className="record-line"><div><p className="record-type">Lead · {item.lead}</p><h3>{item.title}</h3></div><StatusChip value={item.workPackageStatus} /></div><p>{item.summary}</p>{item.blockerSummary ? <p className="blocker-note"><strong>Blocker:</strong> {item.blockerSummary}</p> : null}</div>
              <div className="work-package-progress"><ProgressBar value={item.completionPercent} label="Work package completion" /><small>{formatDate(item.startDate)} — {formatDate(item.targetDate)}</small></div>
            </article>
          ))}
        </div>
      </Section>

      <Section id="ai-work" title="AI write and verification status" kicker="Visibility only — no AI executes here" count={project.aiWork.length}>
        <div className="ai-grid">
          {project.aiWork.length === 0 ? <EmptyState>No AI work records.</EmptyState> : project.aiWork.map((item) => (
            <article className="ai-card" key={item.id}>
              <header><span className="ai-mark" aria-hidden="true">AI</span><div><h3>{item.label}</h3><p>{humanize(item.relatedEntityType)}</p></div></header>
              <div className="ai-status-row"><div><small>Write</small><StatusChip value={item.writeStatus} /></div><span aria-hidden="true">→</span><div><small>Verification</small><StatusChip value={item.verificationStatus} /></div></div>
              <p>{item.statusDetail}</p>
              <dl className="detail-list"><div><dt>Method</dt><dd>{item.verificationMethod ?? 'Not set'}</dd></div><div><dt>Verified by</dt><dd>{item.verifiedBy ?? 'Pending'}</dd></div></dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="activity" title="Latest project activity" kicker="Recent meaningful changes" count={project.activity.length}>
        <ActivityList activity={project.activity} />
      </Section>
    </div>
  );
}

function RecordTitle({ title, summary, attention }: { title: string; summary: string; attention: string | null }) {
  return <div className="table-title"><strong>{title}</strong><span>{summary}</span>{attention ? <em>{attention}</em> : null}</div>;
}

function RecordTable({ label, columns, rows }: { label: string; columns: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="table-wrap"><table><caption className="sr-only">{label}</caption><thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
  );
}
