import { useMemo, useState } from 'react';
import { useApi, type ProjectResponse } from './api';
import { AIChatPanel } from './AIChatPanel';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, ProgressBar, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

type Project = ProjectResponse['project'];
type RegisterRow = Project['registerRows'][number];
type TabId = 'overview' | 'inbox' | 'actions' | 'risks' | 'decisions' | 'config-changes' | 'open-questions' | 'milestones' | 'entities' | 'sources' | 'uncertainty' | 'activity' | 'register-comparison' | 'work-packages' | 'data-config' | 'meetings-comms' | 'deliverables' | 'uat-training' | 'handover';

const primaryTabs: Array<[TabId, string]> = [
  ['overview', 'Overview'], ['inbox', 'Inbox'], ['actions', 'Actions'], ['risks', 'Risks & Issues'], ['decisions', 'Decisions'], ['config-changes', 'Config Changes'], ['open-questions', 'Open Questions'], ['milestones', 'Milestones'], ['entities', 'Entities'], ['sources', 'Sources'], ['uncertainty', 'Uncertainty'], ['activity', 'Activity / Verification'],
];
const moreTabs: Array<[TabId, string]> = [['register-comparison', 'Register Comparison'], ['work-packages', 'Work Packages'], ['data-config', 'Data & Configuration'], ['meetings-comms', 'Meetings & Comms'], ['deliverables', 'Deliverables'], ['uat-training', 'UAT & Training'], ['handover', 'Handover']];

const registerForTab: Partial<Record<TabId, string>> = {
  actions: 'Actions', risks: 'Risks_Issues', decisions: 'Decisions', 'config-changes': 'Config_Changes', 'open-questions': 'Open_Questions', milestones: 'Milestones', entities: 'Entities', uncertainty: 'Uncertainty', sources: 'Sources',
};

export function ProjectPage({ projectId, tab }: { projectId: string; tab: string | null }) {
  const [reload, setReload] = useState(0);
  const state = useApi<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}?reload=${reload}`);
  if (state.status === 'loading') return <LoadingState label="Loading project detail" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const { project, attentionLabel, attention, freshness, asOf } = state.data;
  const activeTab = normalizeTab(tab);
  return (
    <div className="page-stack project-page">
      <a className="back-link" href="#/projects"><span aria-hidden="true">{'<-'}</span> Portfolio</a>
      <PageIntro eyebrow={`${project.code} . ${project.stage}`} title={project.name} description={project.summary} aside={<FreshnessNotice freshness={freshness} asOf={asOf} />} />
      <ProjectTabNav projectId={project.id} activeTab={activeTab} />
      <ProjectTabContent project={project} activeTab={activeTab} attention={attention} attentionLabel={attentionLabel} userId={state.data.userConfig.userId} onChanged={() => setReload((value) => value + 1)} />
      <AIChatPanel contextOptions={[{ contextType: 'selected-project', contextId: project.id, label: project.name, preview: project.summary }, ...project.actions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })), ...project.risksIssues.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary })), ...project.decisions.map((item) => ({ contextType: 'project-record' as const, contextId: item.id, label: item.title, preview: item.summary }))]} />
    </div>
  );
}

function normalizeTab(tab: string | null): TabId {
  const aliases: Record<string, TabId> = { 'risk-issue': 'risks', change: 'config-changes', decision: 'decisions', 'open-question': 'open-questions', milestone: 'milestones', 'work-package': 'work-packages', deliverable: 'deliverables', 'ai-work': 'activity' };
  const value = tab ? aliases[tab] ?? tab : 'overview';
  return [...primaryTabs, ...moreTabs].some(([id]) => id === value) ? value as TabId : 'overview';
}

function ProjectTabNav({ projectId, activeTab }: { projectId: string; activeTab: TabId }) {
  return (
    <nav className="section-nav tab-nav" aria-label="Project tabs">
      {primaryTabs.map(([id, label]) => <a key={id} className={activeTab === id ? 'active' : ''} href={`#/projects/${projectId}/${id}`}>{label}</a>)}
      <label className="more-tabs"><span className="sr-only">More project tabs</span><select className="input" value={moreTabs.some(([id]) => id === activeTab) ? activeTab : ''} onChange={(event) => { if (event.target.value) window.location.hash = `#/projects/${projectId}/${event.target.value}`; }}><option value="">More</option>{moreTabs.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    </nav>
  );
}

function ProjectTabContent({ project, activeTab, attention, attentionLabel, userId, onChanged }: { project: Project; activeTab: TabId; attention: ProjectResponse['attention']; attentionLabel: string; userId: string; onChanged: () => void }) {
  if (activeTab === 'overview') return <OverviewTab project={project} attention={attention} attentionLabel={attentionLabel} />;
  if (activeTab === 'inbox') return <ProjectInbox projectId={project.id} sources={project.inboxSources} proposals={project.proposedChanges} onChanged={onChanged} />;
  if (activeTab === 'activity') return <ActivityTab project={project} />;
  if (activeTab === 'register-comparison') return <RegisterComparison project={project} />;
  if (activeTab === 'work-packages') return <WorkPackagesTab project={project} />;
  if (activeTab === 'deliverables') return <DeliverablesTab project={project} attentionLabel={attentionLabel} userId={userId} />;
  if (['data-config', 'meetings-comms', 'uat-training', 'handover'].includes(activeTab)) return <PlaceholderSection id={activeTab} title={labelFor(activeTab)} />;
  const registerName = registerForTab[activeTab];
  if (registerName) return <RegisterBackedTab project={project} tab={activeTab} registerName={registerName} attentionLabel={attentionLabel} userId={userId} />;
  return <OverviewTab project={project} attention={attention} attentionLabel={attentionLabel} />;
}

function OverviewTab({ project, attention, attentionLabel }: { project: Project; attention: ProjectResponse['attention']; attentionLabel: string }) {
  return (
    <div className="page-stack">
      <section id="overview" className="project-hero panel" aria-label="Project summary">
        <div className="project-hero-status"><StatusChip value={project.deliveryStatus} /><span>Delivery status</span></div>
        <dl>
          <div><dt>Owner</dt><dd>{project.owner}</dd></div>
          <div><dt>Target date</dt><dd>{formatDate(project.targetDate)}</dd></div>
          <div><dt>Stage</dt><dd>{project.stage}</dd></div>
          <div><dt>Storage schema</dt><dd>{project.storageSchemaVersion}</dd></div>
        </dl>
      </section>
      <Section id="attention" title={attentionLabel} kicker="Project priority" count={attention.length} className="attention-panel"><AttentionList items={attention} emptyLabel="This project has nothing assigned to your attention." /></Section>
      <RegisterComparison project={project} compact />
    </div>
  );
}

function RegisterBackedTab({ project, tab, registerName, attentionLabel, userId }: { project: Project; tab: TabId; registerName: string; attentionLabel: string; userId: string }) {
  const rows = project.registerRows.filter((row) => row.registerName === registerName);
  if (rows.length > 0) return <RegisterTable title={labelFor(tab)} registerName={registerName} rows={rows} comparisonRows={project.registerComparisonRows.filter((row) => row.registerName === registerName)} />;
  if (tab === 'actions') return <Section id="actions" title="Actions" kicker="Concrete next steps" count={project.actions.length}><RecordTable label="Project actions" columns={['ID', 'Action', 'Owner', 'Priority', 'Due', 'Status']} rows={project.actions.map((action) => [action.id, <RecordTitle key="title" title={action.title} summary={action.summary} attention={action.needsUserAttention && action.attentionOwner === userId ? attentionLabel : null} />, action.owner, <StatusChip key="priority" value={action.priority} />, formatDate(action.dueDate), <StatusChip key="status" value={action.status} />])} /></Section>;
  if (tab === 'risks') return <Section id="risks" title="Risks and issues" kicker="Threats to delivery" count={project.risksIssues.length}><RecordTable label="Project risks and issues" columns={['ID', 'Risk / issue', 'Kind', 'Severity', 'Impact', 'Status']} rows={project.risksIssues.map((item) => [item.id, <RecordTitle key="title" title={item.title} summary={item.summary} attention={null} />, item.kind, <StatusChip key="severity" value={item.severity} />, item.impact, <StatusChip key="status" value={item.status} />])} /></Section>;
  if (tab === 'decisions') return <Section id="decisions" title="Decisions" kicker="Choices and outcomes" count={project.decisions.length}><Stacked records={project.decisions.map((decision) => ({ id: decision.id, title: decision.title, text: decision.summary, chip: decision.decisionStatus, details: [['Needed by', formatDate(decision.decisionNeededBy)], ['Options', decision.optionsSummary], ['Outcome', decision.outcome ?? 'Pending']] }))} empty="No decisions recorded." /></Section>;
  if (tab === 'config-changes') return <Section id="config-changes" title="Config Changes" kicker="Configuration movement" count={project.changes.length}><Stacked records={project.changes.map((change) => ({ id: change.id, title: change.title, text: change.summary, chip: change.status, details: [['Type', change.changeType], ['Impact', change.impact], ['Owner', change.owner]] }))} empty="No config changes recorded." /></Section>;
  if (tab === 'open-questions') return <Section id="open-questions" title="Open Questions" kicker="Unknowns to resolve" count={project.openQuestions.length}><Stacked records={project.openQuestions.map((question) => ({ id: question.id, title: question.title, text: question.question, chip: question.blocking ? 'blocked' : question.status, details: [['Owner', question.owner], ['Answer needed', formatDate(question.answerNeededBy)]] }))} empty="No open questions." /></Section>;
  if (tab === 'milestones') return <MilestonesTab project={project} />;
  return <RegisterTable title={labelFor(tab)} registerName={registerName} rows={rows} comparisonRows={[]} />;
}

function RegisterTable({ title, registerName, rows, comparisonRows }: { title: string; registerName: string; rows: RegisterRow[]; comparisonRows: Project['registerComparisonRows'] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'id' | 'title' | 'status'>('id');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const statuses = useMemo(() => Array.from(new Set(rows.map((row) => row.recordStatus).filter(Boolean))).sort(), [rows]);
  const filtered = rows.filter((row) => {
    const haystack = `${row.externalRegisterId} ${row.title} ${row.summary} ${row.recordStatus} ${row.sourceRef ?? ''} ${row.sourceAnchor ?? ''}`.toLowerCase();
    return (status === 'all' || row.recordStatus === status) && haystack.includes(search.toLowerCase());
  }).toSorted((a, b) => sortValue(a, sort).localeCompare(sortValue(b, sort)));
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  return (
    <Section id={registerName} title={title} kicker="SQLite register" count={filtered.length}>
      <div className="table-tools"><input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search IDs, titles, sources" /><select className="input" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="input" value={sort} onChange={(event) => setSort(event.target.value as 'id' | 'title' | 'status')}><option value="id">Sort by ID</option><option value="title">Sort by title</option><option value="status">Sort by status</option></select><span>{filtered.length} rows</span></div>
      {filtered.length === 0 ? <EmptyState>No register rows loaded.</EmptyState> : <div className="table-wrap dense-table"><table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Type</th><th>Source</th><th>Related</th><th>Fields</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id} onClick={() => setSelectedId(row.id)}><td><button className="inline-button">{row.externalRegisterId}</button></td><td><strong>{row.title}</strong><small>{row.summary}</small></td><td><StatusChip value={row.recordStatus} /></td><td>{row.recordType ?? '-'}</td><td>{row.sourceRef ?? '-'}<small>{row.sourceAnchor ?? ''}</small></td><td>{[...row.relatedIds, ...row.supersessionIds].join(', ') || '-'}</td><td>{Object.keys(row.rawRow).length}</td></tr>)}</tbody></table></div>}
      {selected ? <RegisterDetail row={selected} comparisonRows={comparisonRows.filter((row) => row.externalRegisterId === selected.externalRegisterId)} onClose={() => setSelectedId(null)} /> : null}
    </Section>
  );
}

function RegisterDetail({ row, comparisonRows, onClose }: { row: RegisterRow; comparisonRows: Project['registerComparisonRows']; onClose: () => void }) {
  return <aside className="detail-drawer" aria-label="Register row detail"><header><div><p className="section-kicker">{row.registerName}</p><h3>{row.externalRegisterId}</h3></div><button className="button secondary" onClick={onClose}>Close</button></header><h4>{row.title}</h4><dl className="inline-details"><div><dt>Original tab</dt><dd>{row.originalTabName}</dd></div><div><dt>Original row</dt><dd>{row.originalRowNumber ?? '-'}</dd></div><div><dt>Source ref</dt><dd>{row.sourceRef ?? '-'}</dd></div><div><dt>Source anchor</dt><dd>{row.sourceAnchor ?? '-'}</dd></div><div><dt>Original status</dt><dd>{row.originalStatusWording ?? '-'}</dd></div><div><dt>Related IDs</dt><dd>{row.relatedIds.join(', ') || '-'}</dd></div><div><dt>Supersession IDs</dt><dd>{row.supersessionIds.join(', ') || '-'}</dd></div></dl><h4>Original fields</h4><div className="raw-field-list">{Object.entries(row.rawRow).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(Array.isArray(value) ? value.join('; ') : typeof value === 'object' && value ? JSON.stringify(value) : value ?? '')}</dd></div>)}</div><h4>Comparison</h4><Stacked records={comparisonRows.map((item) => ({ id: item.id, title: item.fieldName ?? 'Row', text: item.detail ?? '', chip: item.comparisonStatus, details: [['Status', item.comparisonStatus]] }))} empty="No field comparison rows." /></aside>;
}

function RegisterComparison({ project, compact = false }: { project: Project; compact?: boolean }) {
  const rows = compact ? project.registerComparisonSummary.filter((row) => row.sqliteRowCount > 0) : project.registerComparisonSummary;
  const latestBlindReport = project.blindExtractionComparisonReports[0];
  return <Section id="register-comparison" title="Register Comparison" kicker="Canonical workbook parity" count={rows.length}>
    <RecordTable label="Register comparison" columns={['Register', 'Workbook rows', 'SQLite rows', 'IDs', 'Exact fields', 'Normalised', 'Mismatches', 'Status']} rows={rows.map((row) => [humanize(row.registerName), String(row.sourceWorkbookRowCount), String(row.sqliteRowCount), String(row.matchingDurableIds), String(row.exactFieldMatches), String(row.normalisedFieldMatches), String(row.fieldMismatches), <StatusChip key="status" value={row.overallStatus} />])} />
    {!compact && latestBlindReport ? <BlindComparisonReport report={latestBlindReport} /> : null}
  </Section>;
}

function BlindComparisonReport({ report }: { report: Project['blindExtractionComparisonReports'][number] }) {
  const summary = report.summary as { totals?: { expectedRows?: number; extractedRows?: number; exactMatches?: number; semanticMatches?: number; missingItems?: number; additionalItems?: number; precision?: number; recall?: number }; registers?: Array<{ registerName: string; expectedRows: number; extractedRows: number; exactMatches: number; semanticMatches: number; missingItems: string[]; additionalItems: string[]; fieldLevelMismatches: number; statusDifferences: number; sourceAnchorDifferences: number; workPackageTagDifferences: number; precision: number; recall: number }> };
  const totals = summary.totals;
  return <div className="blind-report">
    <div className="record-line"><div><p className="record-type">Sealed benchmark comparison . {formatDateTime(report.createdAt)}</p><h3>Blind PTW Extraction Comparison</h3></div><StatusChip value={report.comparisonStatus} /></div>
    {totals ? <div className="metric-grid compact"><div><strong>{totals.expectedRows ?? 0}</strong><small>Expected rows</small></div><div><strong>{totals.extractedRows ?? 0}</strong><small>Extracted rows</small></div><div><strong>{totals.exactMatches ?? 0}</strong><small>Exact</small></div><div><strong>{totals.semanticMatches ?? 0}</strong><small>Semantic</small></div><div><strong>{totals.precision ?? 0}</strong><small>Precision</small></div><div><strong>{totals.recall ?? 0}</strong><small>Recall</small></div></div> : null}
    {summary.registers ? <RecordTable label="Blind extraction comparison" columns={['Register', 'Expected', 'Extracted', 'Exact', 'Semantic', 'Missing', 'Additional', 'Field mismatches', 'Status', 'Anchor', 'WP', 'Precision', 'Recall']} rows={summary.registers.map((row) => [humanize(row.registerName), String(row.expectedRows), String(row.extractedRows), String(row.exactMatches), String(row.semanticMatches), String(row.missingItems.length), String(row.additionalItems.length), String(row.fieldLevelMismatches), String(row.statusDifferences), String(row.sourceAnchorDifferences), String(row.workPackageTagDifferences), row.precision.toFixed(3), row.recall.toFixed(3)])} /> : null}
    <details className="report-details"><summary>Detailed difference report</summary><pre>{report.reportMarkdown}</pre></details>
  </div>;
}

function MilestonesTab({ project }: { project: Project }) {
  return <Section id="milestones" title="Milestones" kicker="Delivery checkpoints" count={project.milestones.length}><div className="milestone-grid">{project.milestones.length === 0 ? <EmptyState /> : project.milestones.map((milestone) => <article className="milestone-card" key={milestone.id}><div className="record-line"><div><p className="record-type">{milestone.id} . {formatDate(milestone.targetDate)}</p><h3>{milestone.title}</h3></div><StatusChip value={milestone.milestoneStatus} /></div><p>{milestone.summary}</p><ProgressBar value={milestone.completionPercent} label="Milestone completion" /></article>)}</div></Section>;
}

function WorkPackagesTab({ project }: { project: Project }) {
  return <Section id="work-packages" title="Work Packages" kicker="Bounded delivery units" count={project.workPackages.length}><div className="work-package-list">{project.workPackages.length === 0 ? <EmptyState /> : project.workPackages.map((item) => <article className="work-package" key={item.id}><div className="work-package-main"><div className="record-line"><div><p className="record-type">{item.id} . Lead . {item.lead}</p><h3>{item.title}</h3></div><StatusChip value={item.workPackageStatus} /></div><p>{item.summary}</p>{item.blockerSummary ? <p className="blocker-note"><strong>Blocker:</strong> {item.blockerSummary}</p> : null}</div><div className="work-package-progress"><ProgressBar value={item.completionPercent} label="Work package completion" /><small>{formatDate(item.startDate)} - {formatDate(item.targetDate)}</small></div></article>)}</div></Section>;
}

function DeliverablesTab({ project, attentionLabel, userId }: { project: Project; attentionLabel: string; userId: string }) {
  return <Section id="deliverables" title="Deliverables" kicker="Outputs and evidence references" count={project.deliverables.length}><RecordTable label="Project deliverables" columns={['ID', 'Deliverable', 'Type', 'Owner', 'Due', 'Status']} rows={project.deliverables.map((item) => [item.id, <RecordTitle key="title" title={item.title} summary={item.externalPath ? `${item.summary} Reference: ${safePathLabel(item.externalPath)}` : item.summary} attention={item.needsUserAttention && item.attentionOwner === userId ? attentionLabel : null} />, item.deliverableType, item.owner, formatDate(item.dueDate), <StatusChip key="status" value={item.status} />])} /></Section>;
}

function ActivityTab({ project }: { project: Project }) {
  return <Section id="activity" title="Activity / Verification" kicker="Writes, verification and file lifecycle" count={project.activity.length + project.aiWork.length + project.verifications.length + project.sourceFileHistory.length}><h3 className="subhead">AI write and verification status</h3><div className="ai-grid">{project.aiWork.map((item) => <article className="ai-card" key={item.id}><header><span className="ai-mark" aria-hidden="true">AI</span><div><h3>{item.label}</h3><p>{humanize(item.relatedEntityType)}</p></div></header><div className="ai-status-row"><div><small>Write</small><StatusChip value={item.writeStatus} /></div><span aria-hidden="true">{'->'}</span><div><small>Verification</small><StatusChip value={item.verificationStatus} /></div></div><p>{item.statusDetail}</p></article>)}</div><h3 className="subhead">File lifecycle</h3><Stacked records={project.sourceFileHistory.map((item) => ({ id: item.id, title: humanize(item.action), text: safePathLabel(item.toExternalPath), chip: 'verified', details: [['From', item.fromExternalPath ? safePathLabel(item.fromExternalPath) : 'Initial intake'], ['Hash', item.contentHash], ['When', formatDateTime(item.occurredAt)]] }))} empty="No file moves have been recorded." /><h3 className="subhead">Latest project activity</h3><ActivityList activity={project.activity} /></Section>;
}

function ProjectInbox({ projectId, sources, proposals, onChanged }: { projectId: string; sources: Project['inboxSources']; proposals: Project['proposedChanges']; onChanged: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  async function upload(files: FileList | File[]) {
    try { setError(''); const payloadFiles = await Promise.all(Array.from(files).map(async (file) => ({ name: file.name, type: file.type, dataBase64: await fileToBase64(file) }))); const result = await postJson<{ results: Array<{ duplicate: boolean; extractedCount?: number }> }>(`/api/projects/${encodeURIComponent(projectId)}/sources`, 'POST', { files: payloadFiles }); setMessage(`${result.results.length} file(s) received. ${result.results.filter((item) => item.duplicate).length} duplicate(s) skipped.`); onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Source intake failed.'); }
  }
  async function review(id: string, decision: 'approve' | 'reject') {
    try { setError(''); await postJson(`/api/proposed-changes/${encodeURIComponent(id)}/${decision}`, 'POST', { reviewer: 'Warwick' }); setMessage(decision === 'approve' ? 'Proposal approved and applied.' : 'Proposal rejected.'); onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Review action failed.'); }
  }
  return <Section id="inbox" title="Project Inbox" kicker="Source intake and review" count={sources.length + proposals.filter((proposal) => proposal.status === 'proposed').length}><div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}><input id="source-picker" className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files) void upload(event.target.files); }} /><label className="button" htmlFor="source-picker">Choose files</label><p>Drop VTT, text, Office, PDF, email, spreadsheet, or image files here. Unsupported formats are retained with an honest processing state.</p></div>{message ? <p className="inline-note">{message}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<h3 className="subhead">Review proposals</h3><div className="stacked-records">{proposals.length === 0 ? <EmptyState>No source proposals are waiting.</EmptyState> : proposals.map((proposal) => <article className="stacked-record" key={proposal.id}><div className="record-line"><div><h3>{proposal.payload.sourceMetadata.originalFileName}</h3><p>{proposal.payload.items.length} proposed item(s) from {proposal.payload.provider}</p></div><StatusChip value={proposal.status} /></div><ul className="proposal-list">{proposal.payload.items.map((item) => <li key={item.id}><strong>{humanize(item.type)}</strong><span>{item.title}</span></li>)}</ul>{proposal.status === 'proposed' ? <div className="action-row"><button className="button" onClick={() => review(proposal.id, 'approve')}>Approve</button><button className="button secondary" onClick={() => review(proposal.id, 'reject')}>Reject</button></div> : null}</article>)}</div><h3 className="subhead">Sources</h3><SourceList sources={sources} /></Section>;
}

function SourceList({ sources }: { sources: Project['inboxSources'] }) {
  const [openError, setOpenError] = useState('');
  async function openSource(filePath: string) { try { setOpenError(''); await postJson('/api/files/open', 'POST', { path: filePath }); } catch (caught) { setOpenError(caught instanceof Error ? caught.message : 'Could not open original file.'); } }
  if (sources.length === 0) return <EmptyState>No sources have been taken into this project yet.</EmptyState>;
  return <div className="stacked-records">{openError ? <p className="form-error" role="alert">{openError}</p> : null}{sources.map((source) => <article className="stacked-record" key={source.id}><div className="record-line"><div><h3>{source.originalFileName}</h3><p>{safePathLabel(source.currentExternalPath)}</p></div><StatusChip value={source.processingStatus} /></div><dl className="inline-details"><div><dt>Type</dt><dd>{source.sourceType}</dd></div><div><dt>Hash</dt><dd>{source.contentHash}</dd></div><div><dt>Received</dt><dd>{formatDateTime(source.originalReceivedAt)}</dd></div><div><dt>Processor</dt><dd>{source.processorProvider}</dd></div></dl><button className="inline-button" onClick={() => openSource(source.currentExternalPath)}>Open original</button></article>)}</div>;
}

function PlaceholderSection({ id, title }: { id: string; title: string }) { return <Section id={id} title={title} kicker="SQLite-backed workspace" count={0}><EmptyState>This workspace tab is ready for approved source-derived records.</EmptyState></Section>; }
function Stacked({ records, empty }: { records: Array<{ id: string; title: string; text: string; chip: string; details: Array<[string, string]> }>; empty: string }) { if (records.length === 0) return <EmptyState>{empty}</EmptyState>; return <div className="stacked-records">{records.map((record) => <article className="stacked-record" key={record.id}><div className="record-line"><div><h3>{record.title}</h3><p>{record.text}</p></div><StatusChip value={record.chip} /></div><dl className="inline-details">{record.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>)}</div>; }
function RecordTitle({ title, summary, attention }: { title: string; summary: string; attention: string | null }) { return <div className="table-title"><strong>{title}</strong><span>{summary}</span>{attention ? <em>{attention}</em> : null}</div>; }
function RecordTable({ label, columns, rows }: { label: string; columns: string[]; rows: Array<Array<React.ReactNode>> }) { if (rows.length === 0) return <EmptyState />; return <div className="table-wrap"><table><caption className="sr-only">{label}</caption><thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>; }
function sortValue(row: RegisterRow, sort: 'id' | 'title' | 'status') { if (sort === 'title') return row.title; if (sort === 'status') return row.recordStatus; return row.externalRegisterId; }
function labelFor(tab: TabId) { return [...primaryTabs, ...moreTabs].find(([id]) => id === tab)?.[1] ?? humanize(tab); }
function safePathLabel(value: string) { const normal = value.replace(/\\/g, '/'); const marker = '/Projects/'; const index = normal.lastIndexOf(marker); return index >= 0 ? normal.slice(index + marker.length) : normal.split('/').slice(-3).join('/'); }
function fileToBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
async function postJson<T = unknown>(url: string, method: 'POST', body: unknown): Promise<T> { const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }); const data = (await response.json().catch(() => null)) as T | { error?: string } | null; if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`); return data as T; }
