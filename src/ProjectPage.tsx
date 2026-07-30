import { useMemo, useState } from 'react';
import { useApi, type ProjectResponse } from './api';
import { AIChatPanel } from './AIChatPanel';
import { ActivityList, AttentionList, EmptyState, ErrorState, FreshnessNotice, LoadingState, PageIntro, ProgressBar, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

type Project = ProjectResponse['project'];
type JsonRecord = Record<string, unknown>;
type RegisterRow = Project['registerRows'][number] & {
  derivation?: string;
  confidence?: string;
  dueDateRaw?: string | null;
  dueDateConfidence?: string;
  typedDetails?: JsonRecord;
  anchors?: Array<{ id: string; sourceId: string; segmentId: string; speaker: string | null; tMs: number | null; quote: string | null; verified: boolean }>;
  events?: Array<{ id: string; occurredAt: string; actor: string; eventType: string; field: string | null; previousValue: string | null; newValue: string | null; reason: string; evidenceRef: string | null }>;
  currentState?: { status: string; owner: string | null; dueDate: string | null; resolution: string | null; lastHumanEventAt: string | null } | null;
  score?: { value: number; band: string; inputs: JsonRecord; scoringVersion: string } | null;
};
type LensId = 'needsWarwick' | 'needsCustomer' | 'topRisksIssues' | 'decisionsRequired' | 'blockingQuestions' | 'dueNext' | 'challengeNextMeeting' | 'uncertainOrConflicting' | 'changesSinceLatestSource';
type OverviewMode = 'changes' | 'meeting' | 'needs-warwick';
type LensRecord = { id: string; registerName: string; title: string; summary: string; status: string; owner: string | null; dueDate: string | null; score: number; band: string; scoreInputs: JsonRecord };
type ProjectOverview = {
  leadMode: OverviewMode;
  computedMode: OverviewMode;
  pinnedMode: OverviewMode | null;
  modes: Record<'changes' | 'meeting' | 'needsWarwick', { available: boolean; changesetId?: string | null }>;
  lenses: Partial<Record<LensId, LensRecord[]>>;
};
type ChangeOperation = {
  id: string;
  seq: number;
  op: string;
  registerName: string;
  clientRef: string;
  targetExternalId: string | null;
  allocatedExternalId: string | null;
  proposedRow: JsonRecord;
  fieldDiff: JsonRecord;
  anchors: unknown[];
  confidence: string;
  derivation: string;
  status: string;
  reviewer: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};
type Changeset = {
  id: string;
  packetId: string;
  sourceId: string;
  createdAt: string;
  gateVerdict: string;
  gateReport: unknown;
  reviewStatus: string;
  appliedAt: string | null;
  deterministicHash: string;
  operations: ChangeOperation[];
};
type SourceDocumentSummary = {
  id: string;
  sourceType: string;
  originalFileName: string;
  eventDate: string | null;
  durationMs: number | null;
  wordCount: number;
  segmentCount: number;
  participants: string[];
  normaliserVersion: string;
  createdAt: string;
  metrics: { calls: number; inputTokens: number; outputTokens: number; durationMs: number };
};
type SourceIntelligence = { changesets: Changeset[]; sources: SourceDocumentSummary[] };
type ConsultantBrief = { id: string; selectionHash: string; briefMarkdown: string; citations: string[]; generationMode: string; stale: boolean };
type IntelligenceResponse = ProjectResponse & {
  projectOverview?: ProjectOverview;
  sourceIntelligence?: SourceIntelligence;
  consultantBrief?: ConsultantBrief;
};
type TabId = 'overview' | 'inbox' | 'actions' | 'risks' | 'decisions' | 'config-changes' | 'open-questions' | 'milestones' | 'entities' | 'sources' | 'uncertainty' | 'activity' | 'register-comparison' | 'work-packages' | 'data-config' | 'meetings-comms' | 'deliverables' | 'uat-training' | 'handover';

const primaryTabs: Array<[TabId, string]> = [
  ['overview', 'Overview'], ['inbox', 'Inbox'], ['actions', 'Actions'], ['risks', 'Risks & Issues'], ['decisions', 'Decisions'], ['config-changes', 'Config Changes'], ['open-questions', 'Open Questions'], ['milestones', 'Milestones'], ['entities', 'Entities'], ['sources', 'Sources'], ['uncertainty', 'Uncertainty'], ['activity', 'Activity / Verification'],
];
const moreTabs: Array<[TabId, string]> = [['register-comparison', 'Register Comparison'], ['work-packages', 'Work Packages'], ['data-config', 'Data & Configuration'], ['meetings-comms', 'Meetings & Comms'], ['deliverables', 'Deliverables'], ['uat-training', 'UAT & Training'], ['handover', 'Handover']];

const registerForTab: Partial<Record<TabId, string>> = {
  actions: 'Actions', risks: 'Risks_Issues', decisions: 'Decisions', 'config-changes': 'Config_Changes', 'open-questions': 'Open_Questions', milestones: 'Milestones', entities: 'Entities', uncertainty: 'Uncertainty', sources: 'Sources',
};

const overviewModes: Array<{ id: OverviewMode; label: string; description: string; lens: LensId }> = [
  { id: 'changes', label: 'Changes since latest source', description: 'Lead with newly applied or unacknowledged source movement.', lens: 'changesSinceLatestSource' },
  { id: 'meeting', label: 'Meeting brief', description: 'Lead with the records to challenge or resolve in the next meeting.', lens: 'challengeNextMeeting' },
  { id: 'needs-warwick', label: 'Needs Warwick', description: 'Lead with the highest-ranked consultant actions.', lens: 'needsWarwick' },
];

const lensDefinitions: Array<{ id: LensId; label: string }> = [
  { id: 'needsWarwick', label: 'Needs Warwick' },
  { id: 'needsCustomer', label: 'Needs the customer' },
  { id: 'topRisksIssues', label: 'Top risks and issues' },
  { id: 'decisionsRequired', label: 'Decisions required' },
  { id: 'blockingQuestions', label: 'Blocking questions' },
  { id: 'dueNext', label: 'Due next' },
  { id: 'challengeNextMeeting', label: 'Challenge next meeting' },
  { id: 'uncertainOrConflicting', label: 'Uncertain or conflicting' },
  { id: 'changesSinceLatestSource', label: 'Changes since latest source' },
];

export function ProjectPage({ projectId, tab }: { projectId: string; tab: string | null }) {
  const [reload, setReload] = useState(0);
  const state = useApi<IntelligenceResponse>(`/api/projects/${encodeURIComponent(projectId)}?reload=${reload}`);
  if (state.status === 'loading') return <LoadingState label="Loading project detail" />;
  if (state.status === 'error') return <ErrorState message={state.error} />;

  const { project, attentionLabel, attention, freshness, asOf } = state.data;
  const projectOverview = project.projectOverview as ProjectOverview | undefined;
  const sourceIntelligence = project.sourceIntelligence as SourceIntelligence | undefined;
  const consultantBrief = project.consultantBrief as ConsultantBrief | undefined;
  const activeTab = normalizeTab(tab);
  const recordFocus = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('record');
  const onChanged = () => setReload((value) => value + 1);
  return (
    <div className="page-stack project-page">
      <a className="back-link" href="#/projects"><span aria-hidden="true">{'<-'}</span> Portfolio</a>
      <PageIntro eyebrow={`${project.code} . ${project.stage}`} title={project.name} description={project.summary} aside={<FreshnessNotice freshness={freshness} asOf={asOf} />} />
      <ProjectTabNav projectId={project.id} activeTab={activeTab} />
      <ProjectTabContent project={project} activeTab={activeTab} attention={attention} attentionLabel={attentionLabel} userId={state.data.userConfig.userId} projectOverview={projectOverview} sourceIntelligence={sourceIntelligence} consultantBrief={consultantBrief} focusedRecordId={recordFocus} onChanged={onChanged} />
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

function ProjectTabContent({ project, activeTab, attention, attentionLabel, userId, projectOverview, sourceIntelligence, consultantBrief, focusedRecordId, onChanged }: { project: Project; activeTab: TabId; attention: ProjectResponse['attention']; attentionLabel: string; userId: string; projectOverview?: ProjectOverview; sourceIntelligence?: SourceIntelligence; consultantBrief?: ConsultantBrief; focusedRecordId: string | null; onChanged: () => void }) {
  if (activeTab === 'overview') return <OverviewTab project={project} attention={attention} attentionLabel={attentionLabel} overview={projectOverview} brief={consultantBrief} onChanged={onChanged} />;
  if (activeTab === 'inbox') return <ProjectInbox projectId={project.id} userId={userId} sources={project.inboxSources} proposals={project.proposedChanges} sourceIntelligence={sourceIntelligence} onChanged={onChanged} />;
  if (activeTab === 'activity') return <ActivityTab project={project} />;
  if (activeTab === 'register-comparison') return <RegisterComparison project={project} />;
  if (activeTab === 'work-packages') return <WorkPackagesTab project={project} />;
  if (activeTab === 'deliverables') return <DeliverablesTab project={project} attentionLabel={attentionLabel} userId={userId} />;
  if (['data-config', 'meetings-comms', 'uat-training', 'handover'].includes(activeTab)) return <PlaceholderSection id={activeTab} title={labelFor(activeTab)} />;
  const registerName = registerForTab[activeTab];
  if (registerName) return <RegisterBackedTab project={project} tab={activeTab} registerName={registerName} attentionLabel={attentionLabel} userId={userId} focusedRecordId={focusedRecordId} />;
  return <OverviewTab project={project} attention={attention} attentionLabel={attentionLabel} overview={projectOverview} brief={consultantBrief} onChanged={onChanged} />;
}

function OverviewTab({ project, attention, attentionLabel, overview, brief, onChanged }: { project: Project; attention: ProjectResponse['attention']; attentionLabel: string; overview?: ProjectOverview; brief?: ConsultantBrief; onChanged: () => void }) {
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
      {overview ? <AdaptiveOverview projectId={project.id} overview={overview} onChanged={onChanged} /> : null}
      {brief ? <ConsultantBriefPanel brief={brief} /> : null}
      <Section id="attention" title={attentionLabel} kicker="Legacy operational attention" count={attention.length} className="attention-panel"><AttentionList items={attention} emptyLabel="This project has nothing assigned to your attention." /></Section>
      <RegisterComparison project={project} compact />
    </div>
  );
}

function AdaptiveOverview({ projectId, overview, onChanged }: { projectId: string; overview: ProjectOverview; onChanged: () => void }) {
  const [selectedMode, setSelectedMode] = useState<OverviewMode>(overview.leadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = overviewModes.find((item) => item.id === selectedMode) ?? overviewModes[2];

  async function pin(nextMode: OverviewMode | null) {
    try {
      setBusy(true);
      setError('');
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/overview/pin`, 'POST', { mode: nextMode });
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Overview mode could not be pinned.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="adaptive-overview" title={mode.label} kicker="Adaptive project overview" count={(overview.lenses[mode.lens] ?? []).length} className="adaptive-overview">
      <div className="mode-selector" role="tablist" aria-label="Project overview modes">
        {overviewModes.map((item) => {
          const available = overviewModeAvailable(overview, item.id);
          return <button key={item.id} type="button" role="tab" aria-selected={selectedMode === item.id} className={selectedMode === item.id ? 'mode-card active' : 'mode-card'} onClick={() => setSelectedMode(item.id)}><strong>{item.label}</strong><span>{item.description}</span><small>{available ? 'Available' : 'No current trigger'}</small></button>;
        })}
      </div>
      <div className="overview-command-row">
        <p>{overview.pinnedMode ? `${modeLabel(overview.pinnedMode)} is pinned.` : `Selected automatically from ${modeLabel(overview.computedMode)}.`}</p>
        <div className="action-row"><button className="button secondary" type="button" disabled={busy || overview.pinnedMode === selectedMode} onClick={() => void pin(selectedMode)}>Pin this mode</button>{overview.pinnedMode ? <button className="inline-button" type="button" disabled={busy} onClick={() => void pin(null)}>Use automatic mode</button> : null}</div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <LensRecordList projectId={projectId} rows={overview.lenses[mode.lens] ?? []} empty="No records currently qualify for this overview mode." />
      <ProjectLenses projectId={projectId} lenses={overview.lenses} />
    </Section>
  );
}

function ProjectLenses({ projectId, lenses }: { projectId: string; lenses: ProjectOverview['lenses'] }) {
  const [selectedLens, setSelectedLens] = useState<LensId>('needsWarwick');
  const definition = lensDefinitions.find((item) => item.id === selectedLens) ?? lensDefinitions[0];
  return (
    <div className="lens-workspace">
      <div className="lens-tabs" role="tablist" aria-label="Deterministic consultant lenses">
        {lensDefinitions.map((item) => <button key={item.id} type="button" role="tab" aria-selected={selectedLens === item.id} className={selectedLens === item.id ? 'active' : ''} onClick={() => setSelectedLens(item.id)}>{item.label}<span>{(lenses[item.id] ?? []).length}</span></button>)}
      </div>
      <div className="lens-result" role="tabpanel"><h3>{definition.label}</h3><LensRecordList projectId={projectId} rows={lenses[selectedLens] ?? []} empty={`Nothing currently appears in ${definition.label}.`} /></div>
    </div>
  );
}

function LensRecordList({ projectId, rows, empty }: { projectId: string; rows: LensRecord[]; empty: string }) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <ol className="lens-records">{rows.map((row) => <li key={`${row.registerName}:${row.id}`}><div><span className={`importance-band band-${row.band.toLowerCase()}`}>{row.band}</span><small>{humanize(row.registerName)} / score {row.score}</small><h4><a href={registerRowRoute(projectId, row.registerName, row.id)}>{row.title}</a></h4><p>{row.summary}</p></div><dl><div><dt>Status</dt><dd>{humanize(row.status)}</dd></div><div><dt>Owner</dt><dd>{row.owner ?? 'Unassigned'}</dd></div><div><dt>Due</dt><dd>{formatDate(row.dueDate)}</dd></div></dl></li>)}</ol>;
}

function ConsultantBriefPanel({ brief }: { brief: ConsultantBrief }) {
  const deterministic = brief.generationMode.includes('deterministic');
  return <Section id="consultant-brief" title="Implementation Consultant brief" kicker="Grounded reasoning" count={brief.citations.length} className="consultant-brief"><div className="brief-meta"><StatusChip value={brief.stale ? 'watch' : 'verified'} label={brief.stale ? 'Stale after state change' : 'Current selection'} /><StatusChip value={deterministic ? 'normal' : 'verified'} label={deterministic ? 'Deterministic fallback' : brief.generationMode} /><span>{brief.citations.length} cited records</span></div><BriefMarkdown markdown={brief.briefMarkdown} /></Section>;
}

function BriefMarkdown({ markdown }: { markdown: string }) {
  return <div className="brief-content">{markdown.split(/\r?\n/).map((line, index) => {
    const key = `${index}:${line.slice(0, 20)}`;
    if (line.startsWith('## ')) return <h3 key={key}>{line.slice(3)}</h3>;
    if (line.startsWith('# ')) return <h2 key={key}>{line.slice(2)}</h2>;
    if (line.startsWith('- ')) return <p className="brief-item" key={key}>{line.slice(2)}</p>;
    return line.trim() ? <p key={key}>{line}</p> : <span className="brief-gap" key={key} />;
  })}</div>;
}

function overviewModeAvailable(overview: ProjectOverview, mode: OverviewMode) {
  return mode === 'changes' ? overview.modes.changes.available : mode === 'meeting' ? overview.modes.meeting.available : overview.modes.needsWarwick.available;
}

function modeLabel(mode: OverviewMode) { return overviewModes.find((item) => item.id === mode)?.label ?? humanize(mode); }

function registerRowRoute(projectId: string, registerName: string, rowId: string) {
  const tab = Object.entries(registerForTab).find(([, register]) => register === registerName)?.[0] ?? 'overview';
  return `#/projects/${encodeURIComponent(projectId)}/${tab}?record=${encodeURIComponent(rowId)}`;
}

function RegisterBackedTab({ project, tab, registerName, attentionLabel, userId, focusedRecordId }: { project: Project; tab: TabId; registerName: string; attentionLabel: string; userId: string; focusedRecordId: string | null }) {
  const rows = project.registerRows.filter((row) => row.registerName === registerName) as RegisterRow[];
  if (rows.length > 0) return <RegisterTable title={labelFor(tab)} registerName={registerName} rows={rows} comparisonRows={project.registerComparisonRows.filter((row) => row.registerName === registerName)} focusedRecordId={focusedRecordId} />;
  if (tab === 'actions') return <Section id="actions" title="Actions" kicker="Concrete next steps" count={project.actions.length}><RecordTable label="Project actions" columns={['ID', 'Action', 'Owner', 'Priority', 'Due', 'Status']} rows={project.actions.map((action) => [action.id, <RecordTitle key="title" title={action.title} summary={action.summary} attention={action.needsUserAttention && action.attentionOwner === userId ? attentionLabel : null} />, action.owner, <StatusChip key="priority" value={action.priority} />, formatDate(action.dueDate), <StatusChip key="status" value={action.status} />])} /></Section>;
  if (tab === 'risks') return <Section id="risks" title="Risks and issues" kicker="Threats to delivery" count={project.risksIssues.length}><RecordTable label="Project risks and issues" columns={['ID', 'Risk / issue', 'Kind', 'Severity', 'Impact', 'Status']} rows={project.risksIssues.map((item) => [item.id, <RecordTitle key="title" title={item.title} summary={item.summary} attention={null} />, item.kind, <StatusChip key="severity" value={item.severity} />, item.impact, <StatusChip key="status" value={item.status} />])} /></Section>;
  if (tab === 'decisions') return <Section id="decisions" title="Decisions" kicker="Choices and outcomes" count={project.decisions.length}><Stacked records={project.decisions.map((decision) => ({ id: decision.id, title: decision.title, text: decision.summary, chip: decision.decisionStatus, details: [['Needed by', formatDate(decision.decisionNeededBy)], ['Options', decision.optionsSummary], ['Outcome', decision.outcome ?? 'Pending']] }))} empty="No decisions recorded." /></Section>;
  if (tab === 'config-changes') return <Section id="config-changes" title="Config Changes" kicker="Configuration movement" count={project.changes.length}><Stacked records={project.changes.map((change) => ({ id: change.id, title: change.title, text: change.summary, chip: change.status, details: [['Type', change.changeType], ['Impact', change.impact], ['Owner', change.owner]] }))} empty="No config changes recorded." /></Section>;
  if (tab === 'open-questions') return <Section id="open-questions" title="Open Questions" kicker="Unknowns to resolve" count={project.openQuestions.length}><Stacked records={project.openQuestions.map((question) => ({ id: question.id, title: question.title, text: question.question, chip: question.blocking ? 'blocked' : question.status, details: [['Owner', question.owner], ['Answer needed', formatDate(question.answerNeededBy)]] }))} empty="No open questions." /></Section>;
  if (tab === 'milestones') return <MilestonesTab project={project} />;
  return <RegisterTable title={labelFor(tab)} registerName={registerName} rows={rows} comparisonRows={[]} focusedRecordId={focusedRecordId} />;
}

function RegisterTable({ title, registerName, rows, comparisonRows, focusedRecordId }: { title: string; registerName: string; rows: RegisterRow[]; comparisonRows: Project['registerComparisonRows']; focusedRecordId: string | null }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'id' | 'title' | 'status'>('id');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const statuses = useMemo(() => Array.from(new Set(rows.map(currentRowStatus).filter(Boolean))).sort(), [rows]);
  const filtered = rows.filter((row) => {
    const haystack = `${row.externalRegisterId} ${row.title} ${row.summary} ${currentRowStatus(row)} ${row.sourceRef ?? ''} ${row.sourceAnchor ?? ''}`.toLowerCase();
    return (status === 'all' || currentRowStatus(row) === status) && haystack.includes(search.toLowerCase());
  }).toSorted((a, b) => sortValue(a, sort).localeCompare(sortValue(b, sort)));
  const selected = rows.find((row) => row.externalRegisterId === (focusedRecordId ?? selectedId)) ?? null;
  const selectRow = (row: RegisterRow) => { setSelectedId(row.externalRegisterId); window.location.hash = `${window.location.hash.split('?')[0]}?record=${encodeURIComponent(row.externalRegisterId)}`; };
  return (
    <Section id={registerName} title={title} kicker="SQLite register" count={filtered.length}>
      <div className="table-tools"><input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search IDs, titles, sources" /><select className="input" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="input" value={sort} onChange={(event) => setSort(event.target.value as 'id' | 'title' | 'status')}><option value="id">Sort by ID</option><option value="title">Sort by title</option><option value="status">Sort by status</option></select><span>{filtered.length} rows</span></div>
      {filtered.length === 0 ? <EmptyState>No register rows loaded.</EmptyState> : <div className="table-wrap dense-table"><table><thead><tr><th>ID</th><th>Title</th><th>Importance</th><th>Status</th><th>Owner / due</th><th>Source</th><th>Related</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id} onClick={() => selectRow(row)}><td><button className="inline-button">{row.externalRegisterId}</button></td><td><strong>{row.title}</strong><small>{row.summary}</small></td><td>{row.score ? <span className={`importance-band band-${row.score.band.toLowerCase()}`}>{row.score.band} / {row.score.value}</span> : '-'}</td><td><StatusChip value={currentRowStatus(row)} /></td><td>{row.currentState?.owner ?? row.owner ?? 'Unassigned'}<small>{formatDate(row.currentState?.dueDate ?? row.dueDate)}</small></td><td>{row.sourceRef ?? '-'}<small>{row.sourceAnchor ?? ''}</small></td><td>{[...row.relatedIds, ...row.supersessionIds].join(', ') || '-'}</td></tr>)}</tbody></table></div>}
      {selected ? <RegisterDetail row={selected} comparisonRows={comparisonRows.filter((row) => row.externalRegisterId === selected.externalRegisterId)} onClose={() => { setSelectedId(null); window.location.hash = window.location.hash.split('?')[0]; }} /> : null}
    </Section>
  );
}

function RegisterDetail({ row, comparisonRows, onClose }: { row: RegisterRow; comparisonRows: Project['registerComparisonRows']; onClose: () => void }) {
  const current = row.currentState;
  return <aside className="detail-drawer intelligence-drawer" role="dialog" aria-modal="true" aria-labelledby="register-detail-title">
    <header><div><p className="section-kicker">{humanize(row.registerName)}</p><h3 id="register-detail-title">{row.externalRegisterId}</h3></div><button className="button secondary" onClick={onClose}>Close</button></header>
    <div className="drawer-title"><div><h4>{row.title}</h4><p>{row.summary}</p></div>{row.score ? <span className={`importance-band band-${row.score.band.toLowerCase()}`}>{row.score.band} / score {row.score.value}</span> : null}</div>
    <h4>Projected current state</h4><dl className="inline-details"><div><dt>Status</dt><dd>{humanize(current?.status ?? row.recordStatus)}</dd></div><div><dt>Owner</dt><dd>{current?.owner ?? row.owner ?? 'Unassigned'}</dd></div><div><dt>Due date</dt><dd>{formatDate(current?.dueDate ?? row.dueDate)}</dd></div><div><dt>Resolution</dt><dd>{current?.resolution ?? 'Not recorded'}</dd></div><div><dt>Last human event</dt><dd>{current?.lastHumanEventAt ? formatDateTime(current.lastHumanEventAt) : 'None'}</dd></div><div><dt>Scoring version</dt><dd>{row.score?.scoringVersion ?? 'Not scored'}</dd></div></dl>
    <h4>Typed register detail</h4><DetailFieldList values={row.typedDetails ?? {}} empty="No typed detail is stored for this row." />
    <h4>Importance explanation</h4><DetailFieldList values={row.score?.inputs ?? {}} empty="No scoring inputs are available." />
    <h4>Evidence and source anchors</h4>{(row.anchors ?? []).length === 0 ? <EmptyState>No mechanically resolved anchors are available.</EmptyState> : <ol className="anchor-list">{(row.anchors ?? []).map((anchor) => <li key={anchor.id}><div className="anchor-meta"><StatusChip value={anchor.verified ? 'verified' : 'failed'} label={anchor.verified ? 'Verified quote' : 'Unverified'} /><span>{anchor.speaker ?? 'Unknown speaker'}</span><span>{formatAnchorTime(anchor.tMs)}</span></div><blockquote>{anchor.quote ?? 'No quotation retained.'}</blockquote><small>Source {anchor.sourceId} / segment {anchor.segmentId}</small></li>)}</ol>}
    <h4>Human operational history</h4>{(row.events ?? []).length === 0 ? <EmptyState>No human events have been recorded.</EmptyState> : <ol className="event-timeline">{(row.events ?? []).map((event) => <li key={event.id}><span className="event-dot" aria-hidden="true" /><div><div className="record-line"><strong>{humanize(event.eventType)}</strong><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time></div><p>{event.reason}</p><small>{event.actor}{event.field ? ` / ${fieldLabel(event.field)}: ${event.previousValue ?? 'empty'} -> ${event.newValue ?? 'empty'}` : ''}{event.evidenceRef ? ` / ${event.evidenceRef}` : ''}</small></div></li>)}</ol>}
    <h4>Relationships</h4><dl className="inline-details"><div><dt>Related records</dt><dd>{row.relatedIds.length ? row.relatedIds.map((id) => <a key={id} href={registerRowRoute(row.projectId, registerForId(id), id)}>{id}</a>) : '-'}</dd></div><div><dt>Supersedes / reverses</dt><dd>{row.supersessionIds.length ? row.supersessionIds.map((id) => <a key={id} href={registerRowRoute(row.projectId, registerForId(id), id)}>{id}</a>) : '-'}</dd></div><div><dt>Work packages</dt><dd>{row.workPackageTags.join(', ') || '-'}</dd></div></dl>
    <h4>Extraction and packet provenance</h4><dl className="inline-details"><div><dt>Import / extraction run</dt><dd>{row.importRunId}</dd></div><div><dt>Derivation</dt><dd>{row.derivation ?? 'fact'}</dd></div><div><dt>Confidence</dt><dd>{row.confidence ?? 'Unknown'}</dd></div><div><dt>Source reference</dt><dd>{row.sourceRef ?? '-'}</dd></div><div><dt>Source anchor</dt><dd>{row.sourceAnchor ?? '-'}</dd></div><div><dt>Original location</dt><dd>{row.originalTabName} / row {row.originalRowNumber ?? '-'}</dd></div><div><dt>Original status</dt><dd>{row.originalStatusWording ?? '-'}</dd></div><div><dt>Raw due wording</dt><dd>{row.dueDateRaw ?? '-'} ({row.dueDateConfidence ?? 'none'})</dd></div></dl>
    <details className="drawer-details"><summary>Original fields</summary><DetailFieldList values={row.rawRow} empty="No raw fields are retained." /></details>
    <details className="drawer-details"><summary>Field comparison ({comparisonRows.length})</summary><Stacked records={comparisonRows.map((item) => ({ id: item.id, title: item.fieldName ?? 'Row', text: item.detail ?? '', chip: item.comparisonStatus, details: [['Status', item.comparisonStatus]] }))} empty="No field comparison rows." /></details>
  </aside>;
}

function DetailFieldList({ values, empty }: { values: JsonRecord; empty: string }) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <dl className="raw-field-list">{entries.map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(value)}</dd></div>)}</dl>;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayValue).join('; ');
  if (typeof value === 'object' && value) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '');
}

function fieldLabel(value: string) { return humanize(value.replaceAll('_', '-')); }
function formatAnchorTime(value: number | null) { if (value === null) return 'No timestamp'; const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function registerForId(id: string) { const marker = id.match(/-([ADRQMCESU])-/)?.[1]; return ({ A: 'Actions', D: 'Decisions', R: 'Risks_Issues', Q: 'Open_Questions', M: 'Milestones', C: 'Config_Changes', E: 'Entities', S: 'Sources', U: 'Uncertainty' } as Record<string, string>)[marker ?? ''] ?? 'Actions'; }
function currentRowStatus(row: RegisterRow) { return row.currentState?.status ?? row.recordStatus; }
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
    <div className="record-line"><div><p className="record-type">Sealed benchmark comparison . {formatDateTime(report.createdAt)}</p><h3>Benchmark-Informed Extraction Comparison</h3></div><StatusChip value={report.comparisonStatus} /></div>
    {totals ? <div className="metric-grid compact"><div><strong>{totals.expectedRows ?? 0}</strong><small>Expected rows</small></div><div><strong>{totals.extractedRows ?? 0}</strong><small>Extracted rows</small></div><div><strong>{totals.exactMatches ?? 0}</strong><small>Exact</small></div><div><strong>{totals.semanticMatches ?? 0}</strong><small>Semantic</small></div><div><strong>{totals.precision ?? 0}</strong><small>Precision</small></div><div><strong>{totals.recall ?? 0}</strong><small>Recall</small></div></div> : null}
    {summary.registers ? <RecordTable label="Benchmark-informed extraction comparison" columns={['Register', 'Expected', 'Extracted', 'Exact', 'Semantic', 'Missing', 'Additional', 'Field mismatches', 'Status', 'Anchor', 'WP', 'Precision', 'Recall']} rows={summary.registers.map((row) => [humanize(row.registerName), String(row.expectedRows), String(row.extractedRows), String(row.exactMatches), String(row.semanticMatches), String(row.missingItems.length), String(row.additionalItems.length), String(row.fieldLevelMismatches), String(row.statusDifferences), String(row.sourceAnchorDifferences), String(row.workPackageTagDifferences), row.precision.toFixed(3), row.recall.toFixed(3)])} /> : null}
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

function ProjectInbox({ projectId, userId, sources, proposals, sourceIntelligence, onChanged }: { projectId: string; userId: string; sources: Project['inboxSources']; proposals: Project['proposedChanges']; sourceIntelligence?: SourceIntelligence; onChanged: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  async function upload(files: FileList | File[]) {
    try { setError(''); const payloadFiles = await Promise.all(Array.from(files).map(async (file) => ({ name: file.name, type: file.type, dataBase64: await fileToBase64(file) }))); const result = await postJson<{ results: Array<{ duplicate: boolean; extractedCount?: number }> }>(`/api/projects/${encodeURIComponent(projectId)}/sources`, 'POST', { files: payloadFiles }); setMessage(`${result.results.length} file(s) received. ${result.results.filter((item) => item.duplicate).length} duplicate(s) skipped.`); onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Source intake failed.'); }
  }
  const pendingIntelligence = sourceIntelligence?.changesets.flatMap((changeset) => changeset.operations).filter((operation) => operation.status === 'pending').length ?? 0;
  return <Section id="inbox" title="Project Inbox" kicker="Source intake and review" count={sources.length + proposals.filter((proposal) => proposal.status === 'proposed').length + pendingIntelligence}>
    <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}><input id="source-picker" className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files) void upload(event.target.files); }} /><label className="button" htmlFor="source-picker">Choose files</label><p>Drop VTT, TXT, EML or DOCX source files here. Originals are retained immutably before extraction and review.</p></div>
    {message ? <p className="inline-note">{message}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    {sourceIntelligence ? <ReviewLanes projectId={projectId} userId={userId} intelligence={sourceIntelligence} onChanged={onChanged} /> : null}
    {proposals.length ? <details className="legacy-proposals"><summary>Legacy source proposals ({proposals.length})</summary><div className="stacked-records">{proposals.map((proposal) => <article className="stacked-record" key={proposal.id}><div className="record-line"><div><h3>{proposal.payload.sourceMetadata.originalFileName}</h3><p>{proposal.payload.items.length} legacy proposed item(s)</p></div><StatusChip value={proposal.status} /></div><ul className="proposal-list">{proposal.payload.items.map((item) => <li key={item.id}><strong>{humanize(item.type)}</strong><span>{item.title}</span></li>)}</ul>{proposal.status === 'proposed' ? <p className="inline-note">Read-only historical proposal. Use governed changesets for review and apply.</p> : null}</article>)}</div></details> : null}
    <h3 className="subhead">Sources</h3><SourceList sources={sources} />
  </Section>;
}

function ReviewLanes({ projectId, userId, intelligence, onChanged }: { projectId: string; userId: string; intelligence: SourceIntelligence; onChanged: () => void }) {
  return <div className="source-intelligence-review"><div className="review-heading"><div><p className="section-kicker">Source Intelligence</p><h3>Governed review lanes</h3></div><span>{intelligence.changesets.length} changesets / {intelligence.sources.length} normalised sources</span></div><SourceMetrics sources={intelligence.sources} />{intelligence.changesets.length === 0 ? <EmptyState>No Source Intelligence changesets are waiting.</EmptyState> : intelligence.changesets.map((changeset) => <ChangesetReview key={changeset.id} projectId={projectId} userId={userId} changeset={changeset} onChanged={onChanged} />)}</div>;
}

function SourceMetrics({ sources }: { sources: SourceDocumentSummary[] }) {
  if (sources.length === 0) return null;
  const totals = sources.reduce((sum, source) => ({ words: sum.words + source.wordCount, segments: sum.segments + source.segmentCount, calls: sum.calls + source.metrics.calls, input: sum.input + source.metrics.inputTokens, output: sum.output + source.metrics.outputTokens }), { words: 0, segments: 0, calls: 0, input: 0, output: 0 });
  return <dl className="source-metrics"><div><dt>Words</dt><dd>{totals.words.toLocaleString()}</dd></div><div><dt>Segments</dt><dd>{totals.segments.toLocaleString()}</dd></div><div><dt>Model calls</dt><dd>{totals.calls}</dd></div><div><dt>Input tokens</dt><dd>{totals.input.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{totals.output.toLocaleString()}</dd></div></dl>;
}

function ChangesetReview({ projectId, userId, changeset, onChanged }: { projectId: string; userId: string; changeset: Changeset; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pendingAdditions = changeset.operations.filter((operation) => operation.op === 'add' && operation.status === 'pending');
  const individual = changeset.operations.filter((operation) => operation.op !== 'add');
  const reviewedAdditions = changeset.operations.filter((operation) => operation.op === 'add' && operation.status !== 'pending');

  async function decide(operations: ChangeOperation[], status: 'accepted' | 'rejected') {
    if (operations.length === 0) return;
    try {
      setBusy(true);
      setError('');
      setMessage('');
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changeset.id)}/review`, 'POST', { reviewer: userId, decisions: operations.map((operation) => ({ operationId: operation.id, status })) });
      setMessage(`${operations.length} operation(s) ${status}.`);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Review decision failed.');
    } finally {
      setBusy(false);
    }
  }

  async function applyChangeset() {
    try {
      setBusy(true);
      setError('');
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changeset.id)}/apply`, 'POST', { actor: userId });
      setMessage('Reviewed changeset applied to canonical state.');
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reviewed changeset could not be applied.');
    } finally {
      setBusy(false);
    }
  }

  return <article className="changeset-card"><header className="changeset-head"><div><p className="record-type">{formatDateTime(changeset.createdAt)} / {changeset.operations.length} operations</p><h4>{changeset.id}</h4><small>Packet {changeset.packetId} / deterministic {changeset.deterministicHash.slice(0, 12)}</small></div><div><StatusChip value={changeset.gateVerdict === 'quarantined' ? 'failed' : 'verified'} label={`Gate: ${humanize(changeset.gateVerdict)}`} /><StatusChip value={changeset.reviewStatus} /></div></header>
    {changeset.gateVerdict === 'quarantined' ? <p className="quarantine-note" role="status">This changeset is quarantined. Resolve validation blockers before human review.</p> : null}
    {pendingAdditions.length ? <section className="review-lane additions-lane"><header><div><h5>Additions</h5><p>Fast batch lane for new records only.</p></div><span>{pendingAdditions.length} pending</span></header><div className="addition-list">{pendingAdditions.map((operation) => <OperationSummary key={operation.id} operation={operation} />)}</div><div className="action-row"><button className="button" disabled={busy || changeset.gateVerdict === 'quarantined'} onClick={() => void decide(pendingAdditions, 'accepted')}>Accept all additions</button><button className="button secondary" disabled={busy || changeset.gateVerdict === 'quarantined'} onClick={() => void decide(pendingAdditions, 'rejected')}>Reject all additions</button></div></section> : null}
    {individual.length ? <section className="review-lane individual-lane"><header><div><h5>Individual review</h5><p>Updates, resolutions, links, supersessions, duplicates and conflicts are reviewed one by one.</p></div><span>{individual.filter((operation) => operation.status === 'pending').length} pending</span></header><div className="operation-list">{individual.map((operation) => <OperationReview key={operation.id} operation={operation} busy={busy} disabled={changeset.gateVerdict === 'quarantined'} onDecision={(status) => void decide([operation], status)} />)}</div></section> : null}
    {reviewedAdditions.length ? <details className="reviewed-operations"><summary>Reviewed additions ({reviewedAdditions.length})</summary><div className="addition-list">{reviewedAdditions.map((operation) => <OperationSummary key={operation.id} operation={operation} />)}</div></details> : null}
    {message ? <p className="inline-note" role="status">{message}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    {changeset.reviewStatus === 'ready-to-apply' ? <div className="apply-bar"><div><strong>Every operation has a human decision.</strong><span>Application is explicit and revision-checked.</span></div><button className="button" disabled={busy} onClick={() => void applyChangeset()}>Apply reviewed changeset</button></div> : null}
  </article>;
}

function OperationSummary({ operation }: { operation: ChangeOperation }) {
  return <article className="operation-summary"><span className="operation-seq">{operation.seq}</span><div><strong>{operationTitle(operation)}</strong><small>{humanize(operation.registerName)} / {operation.confidence} confidence / {operation.anchors.length} anchor(s)</small></div><StatusChip value={operation.status === 'pending' ? 'pending' : operation.status} /></article>;
}

function OperationReview({ operation, busy, disabled, onDecision }: { operation: ChangeOperation; busy: boolean; disabled: boolean; onDecision: (status: 'accepted' | 'rejected') => void }) {
  const pending = operation.status === 'pending';
  const held = ['conflict', 'unverified_link', 'possible_duplicate'].includes(operation.op);
  return <article className={`operation-review op-${operation.op}`}><div className="record-line"><div><p className="record-type">{operation.seq} / {humanize(operation.op)} / {humanize(operation.registerName)}</p><h5>{operationTitle(operation)}</h5></div><StatusChip value={held ? 'critical' : operation.status} label={humanize(operation.status)} /></div><p>{operationSummary(operation)}</p><dl className="inline-details"><div><dt>Target</dt><dd>{operation.targetExternalId ?? 'New ID allocated on apply'}</dd></div><div><dt>Confidence</dt><dd>{operation.confidence}</dd></div><div><dt>Derivation</dt><dd>{operation.derivation}</dd></div><div><dt>Anchors</dt><dd>{operation.anchors.length}</dd></div></dl>{Object.keys(operation.fieldDiff).length ? <details><summary>Field differences</summary><DetailFieldList values={operation.fieldDiff} empty="No differences." /></details> : null}{pending ? <div className="action-row">{held ? null : <button className="button" disabled={busy || disabled} onClick={() => onDecision('accepted')}>Accept {humanize(operation.op)}</button>}<button className="button secondary" disabled={busy || disabled} onClick={() => onDecision('rejected')}>{held ? 'Keep canonical state' : 'Reject'}</button></div> : <small>Reviewed by {operation.reviewer ?? 'unknown'}{operation.reviewedAt ? ` on ${formatDateTime(operation.reviewedAt)}` : ''}</small>}</article>;
}

function operationTitle(operation: ChangeOperation) { return String(operation.proposedRow.title ?? operation.proposedRow.question ?? operation.proposedRow.name ?? operation.targetExternalId ?? operation.clientRef); }
function operationSummary(operation: ChangeOperation) { return String(operation.proposedRow.summary ?? operation.proposedRow.description ?? operation.proposedRow.question ?? 'Review the proposed structured fields and evidence anchors.'); }

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
