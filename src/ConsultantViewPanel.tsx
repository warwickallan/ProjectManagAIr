import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';

/**
 * Meeting Brief and Needs Warwick.
 *
 * The deterministic content on this panel arrives with the project payload and
 * costs nothing. The GET this component performs on mount cannot reach a
 * provider's `generate`: it reads the synthesis cache, reconciles staleness, and
 * reports whether the provider is reachable. A model call happens on exactly one
 * path — the operator presses Generate or Refresh, which POSTs once.
 *
 * Nothing here regenerates on a tab change, a filter change, a page refresh, a
 * row being opened, or the deterministic selection moving. When the selection
 * moves, the previous narrative stays on screen, labelled stale, with the reason
 * it went stale, until someone chooses to spend a call.
 */

type ConsultantMode = 'meeting' | 'needs-warwick';

type ThemeSummary = {
  id: string;
  label: string;
  memberIds: string[];
  basis: Array<{ kind: string; detail: string }>;
  actionCount: number;
  milestoneCount: number;
  unresolvedDecisionCount: number;
  openQuestionCount: number;
  riskIssueCount: number;
  uncertaintyCount: number;
  customerDependency: boolean;
  blockingCount: number;
  overdueCount: number;
  conflictCount: number;
  sourceAnchorCount: number;
  earliestDueDate: string | null;
};

type SelectionRecord = {
  id: string;
  registerName: string;
  title: string;
  summary: string;
  status: string;
  owner: string | null;
  ownership: 'consultant' | 'customer' | 'unowned';
  dueDate: string | null;
  overdue: boolean;
  blocking: boolean;
  conflict: boolean;
  band: string;
  score: number;
  themeLabel: string | null;
  unlocks: number;
  evidence: { sourceId: string; segmentSeq: number } | null;
};

type DeterministicView = {
  mode: ConsultantMode;
  themeEngineVersion: string;
  themes: ThemeSummary[];
  sections: Array<{ key: string; title: string; description: string; rowIds: string[] }>;
  records: SelectionRecord[];
  selectedIds: string[];
  selectionHash: string;
  providerCalls: 0;
};

type Synthesis = {
  id: string;
  cacheKey: string;
  selectionHash: string;
  briefMarkdown: string;
  citations: string[];
  selectedIds: string[];
  providerId: string;
  modelLabel: string | null;
  skillId: string | null;
  skillVersion: string | null;
  promptTemplateVersion: string | null;
  packetContractVersion: number | null;
  inputTokens: number;
  outputTokens: number;
  generatedAt: string;
  stale: boolean;
  staleReason: string | null;
  staleAt: string | null;
  state: 'none' | 'current' | 'stale' | 'failed';
};

type ConsultantViewResponse = {
  projectId: string;
  mode: ConsultantMode;
  deterministic: DeterministicView;
  synthesis: Synthesis | null;
  identity: { skillId: string; skillVersion: string | null; promptTemplateVersion: string | null; providerId: string; modelLabel: string; packetContractVersion: number; providerAvailable: boolean; providerDetail: string | null };
  synthesisState: 'none' | 'current' | 'stale' | 'failed';
  failure: { message: string; recoveryAction: string } | null;
  providerCallsThisRequest: number;
  removedLines?: number;
  factualLines?: number;
};

const MODES: Array<{ id: ConsultantMode; label: string; description: string }> = [
  { id: 'meeting', label: 'Meeting Brief', description: 'What to challenge, decide and chase in the next meeting.' },
  { id: 'needs-warwick', label: 'Needs Warwick', description: 'What the consultant must personally do next.' },
];

export function ConsultantViewPanel({ projectId, deterministicViews }: { projectId: string; deterministicViews: DeterministicView[] }) {
  const [mode, setMode] = useState<ConsultantMode>('meeting');
  const [view, setView] = useState<ConsultantViewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);

  // Deterministic content is already on the project payload, so it renders
  // before this fetch resolves and remains correct if the fetch fails.
  const fallbackDeterministic = deterministicViews.find((entry) => entry.mode === mode) ?? null;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError('');
      // Read only. This route cannot call a provider.
      const response = await getJson<ConsultantViewResponse>(`/api/projects/${encodeURIComponent(projectId)}/consultant-view?mode=${encodeURIComponent(mode)}`, signal);
      setView(response);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : 'The consultant view could not be read.');
    }
  }, [projectId, mode]);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function generate(force: boolean) {
    try {
      setBusy(true);
      setError('');
      const response = await postJson<ConsultantViewResponse>(`/api/projects/${encodeURIComponent(projectId)}/consultant-view`, { mode, force });
      setView(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Consultant view generation failed.');
    } finally {
      setBusy(false);
    }
  }

  const deterministic = view?.deterministic ?? fallbackDeterministic;
  const synthesis = view?.synthesis ?? null;
  const state = view?.synthesisState ?? 'none';

  return (
    <Section
      id="consultant-view"
      title={MODES.find((entry) => entry.id === mode)?.label ?? 'Consultant view'}
      kicker="Deterministic by default · synthesised only on request"
      count={deterministic?.selectedIds.length ?? 0}
      className="consultant-view"
    >
      <div className="mode-selector" role="tablist" aria-label="Consultant view modes">
        {MODES.map((entry) => (
          <button key={entry.id} type="button" role="tab" aria-selected={mode === entry.id} className={mode === entry.id ? 'mode-card active' : 'mode-card'} onClick={() => setMode(entry.id)}>
            <strong>{entry.label}</strong><span>{entry.description}</span><small>Zero model calls</small>
          </button>
        ))}
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {!deterministic ? <EmptyState>This project has no deterministic consultant view yet.</EmptyState> : (
        <>
          <div className="consultant-sections">
            {deterministic.sections.map((section) => (
              <article key={section.key} className="consultant-section">
                <header><h4>{section.title}</h4><span>{section.rowIds.length}</span></header>
                <p className="section-description">{section.description}</p>
                {section.rowIds.length === 0 ? <EmptyState>Nothing currently qualifies.</EmptyState> : (
                  <ul className="consultant-record-list">
                    {section.rowIds.map((id) => {
                      const record = deterministic.records.find((entry) => entry.id === id);
                      if (!record) return <li key={id}><code>{id}</code></li>;
                      return (
                        <li key={id}>
                          <div className="record-line">
                            <div>
                              <p className="record-type">{humanize(record.registerName)} · {record.id}{record.themeLabel ? ` · theme: ${record.themeLabel}` : ''}</p>
                              <strong>{record.title}</strong>
                              <p>{record.summary}</p>
                            </div>
                            <span className={`importance-band band-${record.band.toLowerCase()}`}>{record.band} / {record.score}</span>
                          </div>
                          <dl className="inline-details">
                            <div><dt>Status</dt><dd>{humanize(record.status)}</dd></div>
                            <div><dt>Owner</dt><dd>{record.owner ?? 'Unassigned'} ({record.ownership})</dd></div>
                            <div><dt>Due</dt><dd>{formatDate(record.dueDate)}{record.overdue ? ' — overdue' : ''}</dd></div>
                            {record.unlocks > 0 ? <div><dt>Unlocks</dt><dd>{record.unlocks} record(s) in its theme</dd></div> : null}
                            {record.blocking ? <div><dt>Blocking</dt><dd>Yes</dd></div> : null}
                            {record.conflict ? <div><dt>Conflict</dt><dd>Held for adjudication</dd></div> : null}
                          </dl>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </article>
            ))}
          </div>

          <details className="consultant-themes">
            <summary>Deterministic themes ({deterministic.themes.length}) · {deterministic.themeEngineVersion}</summary>
            <p className="section-description">
              Grouped from explicit relationships, supersession, work packages, named entities, shared source passages and
              distinctive shared vocabulary. Records sharing only generic project words are deliberately not grouped.
            </p>
            {deterministic.themes.length === 0 ? <EmptyState>No records group into a theme yet.</EmptyState> : (
              <ul className="theme-list">{deterministic.themes.map((theme) => (
                <li key={theme.id}>
                  <div className="record-line"><div><strong>{theme.label}</strong><p>{theme.memberIds.join(', ')}</p></div><span>{theme.memberIds.length} records</span></div>
                  <dl className="inline-details">
                    <div><dt>Actions</dt><dd>{theme.actionCount}</dd></div>
                    <div><dt>Milestones</dt><dd>{theme.milestoneCount}</dd></div>
                    <div><dt>Unresolved decisions</dt><dd>{theme.unresolvedDecisionCount}</dd></div>
                    <div><dt>Open questions</dt><dd>{theme.openQuestionCount}</dd></div>
                    <div><dt>Risks / issues</dt><dd>{theme.riskIssueCount}</dd></div>
                    <div><dt>Customer dependency</dt><dd>{theme.customerDependency ? 'Yes' : 'No'}</dd></div>
                    <div><dt>Source anchors</dt><dd>{theme.sourceAnchorCount}</dd></div>
                    <div><dt>Earliest due</dt><dd>{formatDate(theme.earliestDueDate)}</dd></div>
                  </dl>
                  <details><summary>Why these are grouped</summary><ul>{theme.basis.map((entry) => <li key={`${entry.kind}:${entry.detail}`}>{entry.detail}</li>)}</ul></details>
                </li>
              ))}</ul>
            )}
          </details>
        </>
      )}

      <div className="synthesis-panel">
        <header className="record-line">
          <div>
            <h4>Consultant reasoning</h4>
            <p className="section-description">
              Everything above is deterministic and free. Generating reasoning across it makes exactly one bounded model call.
            </p>
          </div>
          <StatusChip
            value={state === 'current' ? 'verified' : state === 'stale' ? 'watch' : state === 'failed' ? 'failed' : 'pending'}
            label={state === 'current' ? 'Current' : state === 'stale' ? 'Stale' : state === 'failed' ? 'Generation failed' : 'Not generated'}
          />
        </header>

        {view ? (
          <dl className="inline-details">
            <div><dt>Consultant Brief skill</dt><dd>{view.identity.skillVersion ? `${view.identity.skillId} ${view.identity.skillVersion}` : 'No published revision'}</dd></div>
            <div><dt>Provider / model</dt><dd>{view.identity.providerId} / {view.identity.modelLabel}</dd></div>
            <div><dt>Provider status</dt><dd>{view.identity.providerAvailable ? 'Available' : `Unavailable — ${view.identity.providerDetail ?? 'not reachable'}`}</dd></div>
            <div><dt>Selected records</dt><dd>{deterministic?.selectedIds.length ?? 0}</dd></div>
            <div><dt>Selection hash</dt><dd className="hash">{deterministic?.selectionHash.slice(0, 16)}</dd></div>
            <div><dt>Calls made by this request</dt><dd>{view.providerCallsThisRequest}</dd></div>
          </dl>
        ) : null}

        {view?.failure ? (
          <div className="provider-failure" role="alert">
            <StatusChip value="failed" label="Not generated" />
            <p><strong>{view.failure.message}</strong></p>
            <p>{view.failure.recoveryAction}</p>
            <p className="inline-note">The deterministic view above is unaffected and is not AI-generated. Nothing is retrying.</p>
          </div>
        ) : null}

        {synthesis ? (
          <article className="synthesis-body">
            <div className="brief-meta">
              {/* Driven by `state`, not by the stored `stale` column: a narrative
                  superseded by a new skill version or model has an unchanged
                  selection hash, so the column still reads 0 while the view is
                  genuinely stale. */}
              <StatusChip value={synthesis.state === 'current' ? 'verified' : 'watch'} label={synthesis.state === 'current' ? 'Current' : 'Stale'} />
              <span>{formatDateTime(synthesis.generatedAt)}</span>
              <span>{synthesis.providerId} / {synthesis.modelLabel ?? 'unrecorded model'}</span>
              <span>{synthesis.skillId ?? 'unrecorded skill'} {synthesis.skillVersion ?? ''}</span>
              <span>{synthesis.selectedIds.length} selected records</span>
              <span>{synthesis.inputTokens} in / {synthesis.outputTokens} out tokens</span>
            </div>
            {synthesis.state !== 'current' && synthesis.staleReason ? <p className="inline-note">Stale since {formatDateTime(synthesis.staleAt ?? synthesis.generatedAt)}: {synthesis.staleReason} Nothing has been regenerated — press Refresh to spend one call.</p> : null}
            {typeof view?.removedLines === 'number' && view.removedLines > 0 ? <p className="inline-note">{view.removedLines} of {view.factualLines} factual lines were removed because they cited nothing in the selection. What you are reading is what survived.</p> : null}
            <div className="brief-content">{synthesis.briefMarkdown.split(/\r?\n/).map((line, index) => {
              const key = `${index}:${line.slice(0, 20)}`;
              if (line.startsWith('### ')) return <h5 key={key}>{line.slice(4)}</h5>;
              if (line.startsWith('## ')) return <h4 key={key}>{line.slice(3)}</h4>;
              if (line.startsWith('# ')) return <h3 key={key}>{line.slice(2)}</h3>;
              if (line.startsWith('- ')) return <p className="brief-item" key={key}>{line.slice(2)}</p>;
              return line.trim() ? <p key={key}>{line}</p> : <span className="brief-gap" key={key} />;
            })}</div>
            <div className="action-row">
              <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(synthesis.briefMarkdown)}>Copy</button>
              <a className="button secondary" href={`/api/projects/${encodeURIComponent(projectId)}/consultant-view/download?mode=${encodeURIComponent(mode)}`} download>Download Markdown</a>
              <button className="button secondary" onClick={() => setShowEvidence((value) => !value)}>{showEvidence ? 'Hide cited evidence' : 'View cited evidence'}</button>
            </div>
            {showEvidence ? (
              <div className="cited-evidence">
                <h5>Cited records ({synthesis.citations.length})</h5>
                {synthesis.citations.length === 0 ? <EmptyState>The narrative cited nothing.</EmptyState> : (
                  <ul>{synthesis.citations.map((id) => {
                    const record = deterministic?.records.find((entry) => entry.id === id);
                    return <li key={id}><strong>{id}</strong> {record ? `— ${record.title}` : '— not in the current selection'}{record?.evidence ? <small> · anchored at {record.evidence.sourceId} segment {record.evidence.segmentSeq}</small> : null}</li>;
                  })}</ul>
                )}
              </div>
            ) : null}
          </article>
        ) : null}

        <div className="action-row">
          <button
            className="button"
            disabled={busy || !(view?.identity.providerAvailable ?? true)}
            onClick={() => void generate(state !== 'none')}
          >
            {busy ? 'Generating…' : state === 'none' ? 'Generate consultant view' : 'Refresh consultant view'}
          </button>
          <span className="inline-note">One press, at most one bounded model call. Nothing on this page generates on its own.</span>
        </div>
      </div>
    </Section>
  );
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}
