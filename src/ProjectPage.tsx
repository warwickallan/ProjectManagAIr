import { useEffect, useState, type FormEvent } from 'react';
import { useApi, type ProjectResponse } from './api';
import { AIChatPanel } from './AIChatPanel';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, ProgressBar, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

const sections = [
  ['overview', 'Overview'], ['inbox', 'Inbox'], ['actions', 'Actions'], ['risk-issue', 'Risks & Issues'], ['change', 'Changes'], ['decision', 'Decisions'], ['open-question', 'Open Questions'], ['milestone', 'Milestones'], ['work-package', 'Work Packages'], ['data-config', 'Data & Config'], ['meetings-comms', 'Meetings & Comms'], ['deliverable', 'Deliverables'], ['uat-training', 'UAT & Training'], ['handover', 'Handover'], ['sources', 'Sources'], ['activity', 'Activity / AI Writes / Verification'],
] as const;

export function ProjectPage({ projectId, focus }: { projectId: string; focus: string | null }) {
  const [reload, setReload] = useState(0);
  const state = useApi<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}?reload=${reload}`);

  useEffect(() => {
    if (state.status !== 'success' || !focus) return;
    const target = document.getElementById(sectionIdForFocus(focus));
    if (target) window.requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focus, state.status]);

  if (state.status === 'loading') return <LoadingState label="Loading project detail" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const { project, attentionLabel, attention, freshness, asOf } = state.data;
  return (
    <div className="page-stack project-page">
      <a className="back-link" href="#/projects"><span aria-hidden="true">{'<-'}</span> Portfolio</a>
      <PageIntro eyebrow={`${project.code} . ${project.stage}`} title={project.name} description={project.summary} aside={<FreshnessNotice freshness={freshness} asOf={asOf} />} />

      <section id="overview" className="project-hero panel" aria-label="Project summary">
        <div className="project-hero-status"><StatusChip value={project.deliveryStatus} /><span>Delivery status</span></div>
        <dl>
          <div><dt>Owner</dt><dd>{project.owner}</dd></div>
          <div><dt>Target date</dt><dd>{formatDate(project.targetDate)}</dd></div>
          <div><dt>Stage</dt><dd>{project.stage}</dd></div>
          <div><dt>Project root</dt><dd>{project.externalPath ?? 'Not recorded'}</dd></div>
        </dl>
      </section>

      <nav className="section-nav" aria-label="Project sections">
        {sections.map(([id, label]) => <a key={id} href={`#/projects/${project.id}?focus=${id}`}>{label}</a>)}
      </nav>

      <Section id="attention" title={attentionLabel} kicker="Project priority" count={attention.length} className="attention-panel">
        <AttentionList items={attention} emptyLabel="This project has nothing assigned to your attention." />
      </Section>

      <ProjectInbox projectId={project.id} sources={project.inboxSources} proposals={project.proposedChanges} onChanged={() => setReload((value) => value + 1)} />

      <Section id="actions" title="Actions" kicker="Concrete next steps" count={project.actions.length}>
        <RecordTable label="Project actions" columns={['Action', 'Owner', 'Priority', 'Due', 'Status']} rows={project.actions.map((action) => [<RecordTitle key="title" title={action.title} summary={action.summary} attention={action.needsUserAttention && action.attentionOwner === state.data.userConfig.userId ? attentionLabel : null} />, action.owner, <StatusChip key="priority" value={action.priority} />, formatDate(action.dueDate), <StatusChip key="status" value={action.status} />])} />
      </Section>

      <Section id="risk-issue" title="Risks and issues" kicker="Threats to delivery" count={project.risksIssues.length}>
        <div className="record-grid">{project.risksIssues.length === 0 ? <EmptyState /> : project.risksIssues.map((item) => <article className={`record-card severity-${item.severity}`} key={item.id}><header><div><span className="record-type">{item.kind}</span><h3>{item.title}</h3></div><StatusChip value={item.severity} /></header><p>{item.summary}</p><dl className="detail-list"><div><dt>Impact</dt><dd>{item.impact}</dd></div><div><dt>Response</dt><dd>{item.response}</dd></div><div><dt>Owner</dt><dd>{item.owner}</dd></div><div><dt>Target resolution</dt><dd>{formatDate(item.targetResolutionDate)}</dd></div></dl></article>)}</div>
      </Section>

      <Section id="change" title="Changes" kicker="Scope and delivery movement" count={project.changes.length}><Stacked records={project.changes.map((change) => ({ id: change.id, title: change.title, text: change.summary, chip: change.status, details: [['Type', change.changeType], ['Impact', change.impact], ['Owner', change.owner]] }))} empty="No changes recorded." /></Section>
      <Section id="decision" title="Decisions" kicker="Choices and outcomes" count={project.decisions.length}><Stacked records={project.decisions.map((decision) => ({ id: decision.id, title: decision.title, text: decision.summary, chip: decision.decisionStatus, details: [['Needed by', formatDate(decision.decisionNeededBy)], ['Options', decision.optionsSummary], ['Outcome', decision.outcome ?? 'Pending']] }))} empty="No decisions recorded." /></Section>
      <Section id="open-question" title="Open questions" kicker="Unknowns to resolve" count={project.openQuestions.length}><Stacked records={project.openQuestions.map((question) => ({ id: question.id, title: question.title, text: question.question, chip: question.blocking ? 'blocked' : question.status, details: [['Owner', question.owner], ['Answer needed', formatDate(question.answerNeededBy)]] }))} empty="No open questions." /></Section>

      <Section id="milestone" title="Milestones" kicker="Delivery checkpoints" count={project.milestones.length}>
        <div className="milestone-grid">{project.milestones.length === 0 ? <EmptyState /> : project.milestones.map((milestone) => <article className="milestone-card" key={milestone.id}><div className="record-line"><div><p className="record-type">{formatDate(milestone.targetDate)}</p><h3>{milestone.title}</h3></div><StatusChip value={milestone.milestoneStatus} /></div><p>{milestone.summary}</p><ProgressBar value={milestone.completionPercent} label="Milestone completion" /></article>)}</div>
      </Section>

      <Section id="work-package" title="Work packages" kicker="Bounded delivery units" count={project.workPackages.length}>
        <div className="work-package-list">{project.workPackages.length === 0 ? <EmptyState /> : project.workPackages.map((item) => <article className="work-package" key={item.id}><div className="work-package-main"><div className="record-line"><div><p className="record-type">Lead . {item.lead}</p><h3>{item.title}</h3></div><StatusChip value={item.workPackageStatus} /></div><p>{item.summary}</p>{item.blockerSummary ? <p className="blocker-note"><strong>Blocker:</strong> {item.blockerSummary}</p> : null}</div><div className="work-package-progress"><ProgressBar value={item.completionPercent} label="Work package completion" /><small>{formatDate(item.startDate)} - {formatDate(item.targetDate)}</small></div></article>)}</div>
      </Section>

      <PlaceholderSection id="data-config" title="Data & Configuration" />
      <PlaceholderSection id="meetings-comms" title="Meetings & Comms" />
      <Section id="deliverable" title="Deliverables" kicker="Outputs and evidence references" count={project.deliverables.length}><RecordTable label="Project deliverables" columns={['Deliverable', 'Type', 'Owner', 'Due', 'Status']} rows={project.deliverables.map((item) => [<RecordTitle key="title" title={item.title} summary={item.externalPath ? `${item.summary} Reference: ${item.externalPath}` : item.summary} attention={item.needsUserAttention && item.attentionOwner === state.data.userConfig.userId ? attentionLabel : null} />, item.deliverableType, item.owner, formatDate(item.dueDate), <StatusChip key="status" value={item.status} />])} /></Section>
      <PlaceholderSection id="uat-training" title="UAT & Training" />
      <PlaceholderSection id="handover" title="Handover" />

      <Section id="sources" title="Sources" kicker="Immutable originals and provenance" count={project.inboxSources.length + project.sourceEntityProvenance.length}>
        <SourceList sources={project.inboxSources} />
        <h3 className="subhead">Structured item provenance</h3>
        <Stacked records={project.sourceEntityProvenance.map((ref) => ({ id: ref.id, title: `${humanize(ref.entityType)} ${ref.entityId.slice(0, 8)}`, text: ref.sourcePath, chip: 'verified', details: [['Hash', ref.contentHash], ['Created', formatDateTime(ref.createdAt)]] }))} empty="No applied source provenance yet." />
      </Section>

      <Section id="activity" title="Activity / AI Writes / Verification" kicker="Writes, verification and file lifecycle" count={project.activity.length + project.aiWork.length + project.verifications.length + project.sourceFileHistory.length}>
        <h3 className="subhead">AI write and verification status</h3><div className="ai-grid">{project.aiWork.map((item) => <article className="ai-card" key={item.id}><header><span className="ai-mark" aria-hidden="true">AI</span><div><h3>{item.label}</h3><p>{humanize(item.relatedEntityType)}</p></div></header><div className="ai-status-row"><div><small>Write</small><StatusChip value={item.writeStatus} /></div><span aria-hidden="true">{'->'}</span><div><small>Verification</small><StatusChip value={item.verificationStatus} /></div></div><p>{item.statusDetail}</p></article>)}</div>
        <h3 className="subhead">File lifecycle</h3>
        <Stacked records={project.sourceFileHistory.map((item) => ({ id: item.id, title: humanize(item.action), text: item.toExternalPath, chip: 'verified', details: [['From', item.fromExternalPath ?? 'Initial intake'], ['Hash', item.contentHash], ['When', formatDateTime(item.occurredAt)]] }))} empty="No file moves have been recorded." />
        <h3 className="subhead">Latest project activity</h3><ActivityList activity={project.activity} />
      </Section>

      <AIChatPanel contextOptions={[{ contextType: 'selected-project', contextId: project.id, label: project.name, preview: project.summary }, ...project.actions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })), ...project.risksIssues.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })), ...project.decisions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary }))]} />
    </div>
  );
}

function ProjectInbox({ projectId, sources, proposals, onChanged }: { projectId: string; sources: ProjectResponse['project']['inboxSources']; proposals: ProjectResponse['project']['proposedChanges']; onChanged: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  async function upload(files: FileList | File[]) {
    try {
      setError('');
      const payloadFiles = await Promise.all(Array.from(files).map(async (file) => ({ name: file.name, type: file.type, dataBase64: await fileToBase64(file) })));
      const result = await postJson<{ results: Array<{ duplicate: boolean; extractedCount?: number }> }>(`/api/projects/${encodeURIComponent(projectId)}/sources`, 'POST', { files: payloadFiles });
      setMessage(`${result.results.length} file(s) received. ${result.results.filter((item) => item.duplicate).length} duplicate(s) skipped.`);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Source intake failed.');
    }
  }

  async function review(id: string, decision: 'approve' | 'reject') {
    try {
      setError('');
      await postJson(`/api/proposed-changes/${encodeURIComponent(id)}/${decision}`, 'POST', { reviewer: 'Warwick' });
      setMessage(decision === 'approve' ? 'Proposal approved and applied.' : 'Proposal rejected.');
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Review action failed.');
    }
  }

  return (
    <Section id="inbox" title="Project Inbox" kicker="Source intake and review" count={sources.length + proposals.filter((proposal) => proposal.status === 'proposed').length}>
      <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}>
        <input id="source-picker" className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files) void upload(event.target.files); }} />
        <label className="button" htmlFor="source-picker">Choose files</label>
        <p>Drop VTT, text, Office, PDF, email, spreadsheet, or image files here. Unsupported formats are retained with an honest processing state.</p>
      </div>
      {message ? <p className="inline-note">{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <h3 className="subhead">Review proposals</h3>
      <div className="stacked-records">
        {proposals.length === 0 ? <EmptyState>No source proposals are waiting.</EmptyState> : proposals.map((proposal) => <article className="stacked-record" key={proposal.id}><div className="record-line"><div><h3>{proposal.payload.sourceMetadata.originalFileName}</h3><p>{proposal.payload.items.length} proposed item(s) from {proposal.payload.provider}</p></div><StatusChip value={proposal.status} /></div><ul className="proposal-list">{proposal.payload.items.map((item) => <li key={item.id}><strong>{humanize(item.type)}</strong><span>{item.title}</span></li>)}</ul>{proposal.status === 'proposed' ? <div className="action-row"><button className="button" onClick={() => review(proposal.id, 'approve')}>Approve</button><button className="button secondary" onClick={() => review(proposal.id, 'reject')}>Reject</button></div> : null}</article>)}
      </div>
      <h3 className="subhead">Inbox sources</h3><SourceList sources={sources} />
    </Section>
  );
}

function SourceList({ sources }: { sources: ProjectResponse['project']['inboxSources'] }) {
  const [openError, setOpenError] = useState('');
  async function openSource(filePath: string) {
    try {
      setOpenError('');
      await postJson('/api/files/open', 'POST', { path: filePath });
    } catch (caught) {
      setOpenError(caught instanceof Error ? caught.message : 'Could not open original file.');
    }
  }
  if (sources.length === 0) return <EmptyState>No sources have been taken into this project yet.</EmptyState>;
  return <div className="stacked-records">{openError ? <p className="form-error" role="alert">{openError}</p> : null}{sources.map((source) => <article className="stacked-record" key={source.id}><div className="record-line"><div><h3>{source.originalFileName}</h3><p>{source.currentExternalPath}</p></div><StatusChip value={source.processingStatus} /></div><dl className="inline-details"><div><dt>Type</dt><dd>{source.sourceType}</dd></div><div><dt>Hash</dt><dd>{source.contentHash}</dd></div><div><dt>Received</dt><dd>{formatDateTime(source.originalReceivedAt)}</dd></div><div><dt>Processor</dt><dd>{source.processorProvider}</dd></div></dl><button className="inline-button" onClick={() => openSource(source.currentExternalPath)}>Open original</button></article>)}</div>;
}
function PlaceholderSection({ id, title }: { id: string; title: string }) {
  return <Section id={id} title={title} kicker="SQLite-backed workspace" count={0}><EmptyState>This workspace tab is ready for approved source-derived records.</EmptyState></Section>;
}

function Stacked({ records, empty }: { records: Array<{ id: string; title: string; text: string; chip: string; details: Array<[string, string]> }>; empty: string }) {
  if (records.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <div className="stacked-records">{records.map((record) => <article className="stacked-record" key={record.id}><div className="record-line"><div><h3>{record.title}</h3><p>{record.text}</p></div><StatusChip value={record.chip} /></div><dl className="inline-details">{record.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>)}</div>;
}

function sectionIdForFocus(focus: string) {
  return ({ action: 'actions', change: 'change', 'ai-work': 'activity', deliverable: 'deliverable', milestone: 'milestone', 'work-package': 'work-package', decision: 'decision', 'open-question': 'open-question', 'risk-issue': 'risk-issue' } as Record<string, string>)[focus] ?? focus;
}

function RecordTitle({ title, summary, attention }: { title: string; summary: string; attention: string | null }) {
  return <div className="table-title"><strong>{title}</strong><span>{summary}</span>{attention ? <em>{attention}</em> : null}</div>;
}

function RecordTable({ label, columns, rows }: { label: string; columns: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <EmptyState />;
  return <div className="table-wrap"><table><caption className="sr-only">{label}</caption><thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function postJson<T = unknown>(url: string, method: 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}
