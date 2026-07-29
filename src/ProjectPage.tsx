import { useEffect } from 'react';
import { useApi, type ProjectResponse } from './api';
import { AIChatPanel } from './AIChatPanel';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, ProgressBar, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

const sections = [
  ['attention', 'Attention'], ['actions', 'Actions'], ['risk-issue', 'Risks & issues'], ['change', 'Changes'], ['decision', 'Decisions'],
  ['open-question', 'Open questions'], ['milestone', 'Milestones'], ['work-package', 'Work packages'], ['deliverable', 'Deliverables'], ['ai-work', 'AI status'], ['provenance', 'Provenance'], ['activity', 'Activity'],
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
      <a className="back-link" href="#/projects"><span aria-hidden="true">{'<-'}</span> Portfolio</a>
      <PageIntro
        eyebrow={`${project.code} . ${project.stage}`}
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

      <Section id="change" title="Changes" kicker="Scope and delivery movement" count={project.changes.length}>
        <div className="stacked-records">
          {project.changes.length === 0 ? <EmptyState>No changes recorded.</EmptyState> : project.changes.map((change) => (
            <article className="stacked-record" key={change.id}>
              <div className="record-line"><div><h3>{change.title}</h3><p>{change.summary}</p></div><StatusChip value={change.status} /></div>
              <dl className="inline-details"><div><dt>Type</dt><dd>{change.changeType}</dd></div><div><dt>Impact</dt><dd>{change.impact}</dd></div><div><dt>Owner</dt><dd>{change.owner}</dd></div></dl>
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
              <div className="work-package-main"><div className="record-line"><div><p className="record-type">Lead . {item.lead}</p><h3>{item.title}</h3></div><StatusChip value={item.workPackageStatus} /></div><p>{item.summary}</p>{item.blockerSummary ? <p className="blocker-note"><strong>Blocker:</strong> {item.blockerSummary}</p> : null}</div>
              <div className="work-package-progress"><ProgressBar value={item.completionPercent} label="Work package completion" /><small>{formatDate(item.startDate)} - {formatDate(item.targetDate)}</small></div>
            </article>
          ))}
        </div>
      </Section>

      <Section id="deliverable" title="Deliverables" kicker="Outputs and evidence references" count={project.deliverables.length}>
        <RecordTable
          label="Project deliverables"
          columns={['Deliverable', 'Type', 'Owner', 'Due', 'Status']}
          rows={project.deliverables.map((item) => [
            <RecordTitle key="title" title={item.title} summary={item.externalPath ? `${item.summary} Reference: ${item.externalPath}` : item.summary} attention={item.needsUserAttention && item.attentionOwner === state.data.userConfig.userId ? attentionLabel : null} />,
            item.deliverableType,
            item.owner,
            formatDate(item.dueDate),
            <StatusChip key="status" value={item.status} />,
          ])}
        />
      </Section>

      <Section id="ai-work" title="AI write and verification status" kicker="Visibility only - no AI executes here" count={project.aiWork.length + project.verifications.length}>
        <div className="ai-grid">
          {project.aiWork.length === 0 ? <EmptyState>No AI work records.</EmptyState> : project.aiWork.map((item) => (
            <article className="ai-card" key={item.id}>
              <header><span className="ai-mark" aria-hidden="true">AI</span><div><h3>{item.label}</h3><p>{humanize(item.relatedEntityType)}</p></div></header>
              <div className="ai-status-row"><div><small>Write</small><StatusChip value={item.writeStatus} /></div><span aria-hidden="true">{'->'}</span><div><small>Verification</small><StatusChip value={item.verificationStatus} /></div></div>
              <p>{item.statusDetail}</p>
              <dl className="detail-list"><div><dt>Method</dt><dd>{item.verificationMethod ?? 'Not set'}</dd></div><div><dt>Verified by</dt><dd>{item.verifiedBy ?? 'Pending'}</dd></div></dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="provenance" title="Freshness and provenance" kicker="External source references only" count={project.projectSources.length + project.provenance.length}>
        <div className="stacked-records">
          {project.projectSources.length === 0 && project.provenance.length === 0 ? <EmptyState>No provenance references recorded.</EmptyState> : null}
          {project.projectSources.map((source) => (
            <article className="stacked-record" key={source.id}>
              <div className="record-line"><div><h3>{source.label}</h3><p>{source.externalPath}</p></div><StatusChip value={source.sourceType} /></div>
              <dl className="inline-details"><div><dt>Last seen</dt><dd>{source.lastSeenAt ? formatDateTime(source.lastSeenAt) : 'Not recorded'}</dd></div><div><dt>Classification</dt><dd>{source.dataClassification}</dd></div></dl>
            </article>
          ))}
          {project.provenance.map((ref) => (
            <article className="stacked-record" key={ref.id}>
              <div className="record-line"><div><h3>{ref.label}</h3><p>{ref.externalPath}</p></div><StatusChip value={ref.evidenceKind} /></div>
              <dl className="inline-details"><div><dt>Entity</dt><dd>{humanize(ref.entityType)} / {ref.entityId}</dd></div><div><dt>Captured</dt><dd>{ref.capturedAt ? formatDateTime(ref.capturedAt) : 'Not recorded'}</dd></div></dl>
            </article>
          ))}
        </div>
      </Section>

      <Section id="activity" title="Latest project activity" kicker="Recent meaningful changes" count={project.activity.length}>
        <ActivityList activity={project.activity} />
      </Section>
      <AIChatPanel contextOptions={[
        { contextType: 'selected-project', contextId: project.id, label: project.name, preview: project.summary },
        ...project.actions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })),
        ...project.risksIssues.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })),
        ...project.decisions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })),
      ]} />
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
