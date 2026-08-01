import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Section, StatusChip, formatDate, formatDateTime, humanize } from './components';
import type { BriefMode, ReasoningMatter, ReasoningOutput, Violation } from './consultantReasoningContract';
import type { ReasoningEvidence, ResolvedRegisterRow } from './consultantReasoningRender';

/**
 * Consultant Reasoning — the primary briefing surface.
 *
 * The GET this component performs on mount is provider-free by construction:
 * it reads the reasoning cache, reconciles staleness against the current
 * project-state hash, and resolves the cited register IDs to canonical rows.
 * It reports `providerCallsThisRequest: 0` and that is the whole guarantee.
 *
 * A model call happens on exactly one path: the operator presses Generate or
 * Refresh, which POSTs once. Nothing here regenerates on mount, on a tab
 * change, on a mode change, on a page refresh, or when the register moves
 * underneath a cached result. When state moves, the previous reasoning stays
 * on screen, bannered stale, until someone chooses to spend a call.
 *
 * Division of labour, which is why any of this can be trusted: the model
 * produced the judgement and cited register IDs; every quote in the drill-down
 * below was resolved from the database by Project ManagAIr and was never
 * written by a model.
 */

export type ReasoningState = 'none' | 'current' | 'stale' | 'failed';

export interface CachedReasoning {
  id: string;
  runId: string;
  mode: string;
  resultJson: ReasoningOutput;
  resultSha256: string;
  citedRegisterIds: string[];
  projectStateHash: string;
  registerRevision: number;
  skillId: string;
  skillVersion: string;
  promptTemplateVersion: string;
  providerId: string;
  modelLabel: string;
  generatedAt: string;
  stale: boolean;
  staleReason: string | null;
}

export interface ReasoningViewResponse {
  projectId: string;
  mode: string;
  current: CachedReasoning | null;
  latest: CachedReasoning | null;
  state: ReasoningState;
  projectStateHash: string;
  registerRevision: number;
  identity: {
    skillId: string;
    skillVersion: string | null;
    promptTemplateVersion: string | null;
    providerId: string;
    modelLabel: string;
    providerAvailable: boolean;
    providerDetail: string;
    skillResolved: boolean;
  };
  lastFailure: { status: string; error: string | null; violations: Violation[]; createdAt: string } | null;
  providerCallsThisRequest: 0;
  evidence: ReasoningEvidence;
}

export interface GenerateResponse {
  view: ReasoningViewResponse;
  providerCalls: 0 | 1;
  outcome: string;
  violations: Violation[];
  message: string | null;
  runId: string | null;
}

const MODES: Array<{ id: BriefMode; label: string; description: string }> = [
  { id: 'meeting', label: 'Meeting', description: 'What genuinely deserves discussion in the next meeting, in order.' },
  { id: 'needs-consultant', label: 'Needs the consultant', description: 'What the consultant must personally move next.' },
  { id: 'status', label: 'Status', description: 'Where delivery actually stands against the approved record.' },
  { id: 'handover', label: 'Handover', description: 'What a successor would need in order to take this over.' },
];

/** Rendered after the meeting order, in this order. Exported so single-section tabs can pick one. */
export const SECTIONS: Array<{ key: keyof ReasoningOutput; title: string; note?: string }> = [
  { key: 'decisions_required', title: 'Decisions required' },
  { key: 'customer_dependencies', title: 'Customer dependencies' },
  { key: 'consultant_next_actions', title: 'Consultant next actions' },
  { key: 'risks_and_blockers', title: 'Risks and blockers' },
  { key: 'unanswered_questions', title: 'Unanswered questions', note: 'Questions already answered by later state have been reconciled out.' },
  { key: 'contradictions_and_state_conflicts', title: 'Contradictions and state conflicts' },
  { key: 'recent_changes', title: 'Recent changes' },
  { key: 'confirmation_warnings', title: 'Confirmation warnings', note: 'Stale, conflicted or weakly supported. Do not read these as confirmed truth.' },
];

/**
 * The read/generate lifecycle for one reasoning mode, extracted so every
 * primary-navigation tab that shows a slice of the same accepted result
 * (Overview, Meeting Brief, My Actions, ...) shares one fetch, one staleness
 * reconciliation and one Generate/Refresh path, rather than each re-deriving
 * it. The GET is provider-free by construction; POST (`generate`) is the only
 * path that can spend a model call, and only ever fires on an explicit press.
 */
export function useReasoningView(projectId: string, mode: BriefMode) {
  const [view, setView] = useState<ReasoningViewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{ outcome: string; providerCalls: number; message: string | null } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError('');
      // Read only. This route cannot reach a provider.
      const response = await getJson<ReasoningViewResponse>(`/api/projects/${encodeURIComponent(projectId)}/consultant-reasoning?mode=${encodeURIComponent(mode)}`, signal);
      setView(response);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : 'The consultant reasoning could not be read.');
    }
  }, [projectId, mode]);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setOutcome(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function generate(force: boolean) {
    try {
      setBusy(true);
      setError('');
      const response = await postJson<GenerateResponse>(`/api/projects/${encodeURIComponent(projectId)}/consultant-reasoning`, { mode, force });
      setView(response.view);
      setOutcome({ outcome: response.outcome, providerCalls: response.providerCalls, message: response.message });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Consultant reasoning generation failed.');
    } finally {
      setBusy(false);
    }
  }

  const state: ReasoningState = view?.state ?? 'none';
  const cached = view?.current ?? view?.latest ?? null;
  const result = cached?.resultJson ?? null;
  const evidence: ReasoningEvidence = view?.evidence ?? { rows: {}, unresolved: [] };
  const identity = view?.identity ?? null;
  const skillResolved = identity ? identity.skillResolved : true;
  const providerAvailable = identity ? identity.providerAvailable : true;
  const blocked = !skillResolved || !providerAvailable;
  const stateChanged = Boolean(view && view.latest && view.latest.projectStateHash !== view.projectStateHash);

  return { view, busy, error, outcome, generate, state, cached, result, evidence, identity, skillResolved, providerAvailable, blocked, stateChanged };
}

/**
 * Shared stale/failed banners plus the provenance-and-refresh footer, so
 * every reasoning-backed tab shows the same staleness and generation
 * behaviour instead of six independent copies of it.
 */
export function ReasoningStatusBanners({ state, cached, view, prominent = false }: { state: ReasoningState; cached: CachedReasoning | null; view: ReasoningViewResponse | null; prominent?: boolean }) {
  const stateChanged = Boolean(view && view.latest && view.latest.projectStateHash !== view.projectStateHash);
  return (
    <>
      {state === 'stale' && cached ? (
        <div className={`reasoning-banner stale${prominent ? ' prominent' : ''}`} role="status">
          <StatusChip value="watch" label="Stale" />
          <div>
            <strong>Project state has changed since this reasoning was generated.</strong>
            <p>
              It was generated against project-state hash <code className="hash">{shortHash(cached.projectStateHash, 12)}</code>; the register now stands at{' '}
              <code className="hash">{shortHash(view?.projectStateHash, 12)}</code>
              {stateChanged ? '' : ' (the stored result was marked stale explicitly)'}.
              {cached.staleReason ? ` ${cached.staleReason}` : ''}
            </p>
            <p>Nothing has been regenerated. The previous judgement is shown below unchanged — press Refresh to spend one call.</p>
          </div>
        </div>
      ) : null}
      {state === 'failed' && view?.lastFailure ? (
        <div className="reasoning-banner failed" role="alert">
          <StatusChip value="failed" label={`Run ${humanize(view.lastFailure.status)}`} />
          <div>
            <strong>The last reasoning run was not accepted, and was preserved rather than retried.</strong>
            <p>{view.lastFailure.error ?? 'The provider returned no error detail.'}</p>
            <p className="inline-note">Recorded {formatDateTime(view.lastFailure.createdAt)}. Nothing is retrying, and nothing was charged again.</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The Generate/Refresh control and disabled-reason text. Shared so the behaviour — one bounded call, only on press — cannot drift between tabs. */
export function ReasoningRefreshControl({ state, busy, blocked, identity, onGenerate, prominent = false }: { state: ReasoningState; busy: boolean; blocked: boolean; identity: ReasoningViewResponse['identity'] | null; onGenerate: (force: boolean) => void; prominent?: boolean }) {
  return (
    <div className={`action-row${prominent ? ' reasoning-refresh-prominent' : ''}`}>
      <button className="button" type="button" disabled={busy || blocked} onClick={() => onGenerate(state !== 'none')}>
        {busy ? 'Generating…' : state === 'none' ? 'Generate consultant reasoning' : 'Refresh consultant reasoning'}
      </button>
      <span className="inline-note">
        {blocked
          ? !identity?.skillResolved
            ? 'No publishable consultant-reasoning skill revision is resolved, so generation is disabled. Publish or pin a revision in Settings → AI Skills & Prompts.'
            : `The configured provider is unavailable (${identity?.providerDetail ?? 'not reachable'}), so generation is disabled. Check the provider in Settings → AI Skills & Prompts.`
          : 'One press, at most one bounded model call. Nothing on this page generates on its own.'}
      </span>
    </div>
  );
}

/** Compact provenance strip, reused on every reasoning-backed tab. */
export function ReasoningProvenanceStrip({ view, cached, mode }: { view: ReasoningViewResponse | null; cached: CachedReasoning | null; mode: BriefMode }) {
  const identity = view?.identity ?? null;
  return (
    <details className="reasoning-provenance compact">
      <summary>Provenance {cached ? `— generated ${formatDateTime(cached.generatedAt)}` : '— never generated'}</summary>
      <dl className="inline-details">
        <div><dt>Skill</dt><dd>{identity ? `${identity.skillId}@${identity.skillVersion ?? 'unresolved'}` : 'Not read yet'}</dd></div>
        <div><dt>Provider / model</dt><dd>{identity ? `${identity.providerId} / ${identity.modelLabel}` : 'Not read yet'}</dd></div>
        <div><dt>Project-state hash</dt><dd className="hash">{shortHash(view?.projectStateHash, 16)}</dd></div>
        <div><dt>Result hash</dt><dd className="hash">{shortHash(cached?.resultSha256, 16)}</dd></div>
        <div><dt>Calls made by this read</dt><dd>{view?.providerCallsThisRequest ?? 0}</dd></div>
      </dl>
      {cached ? <a className="button secondary" href={`/api/projects/${encodeURIComponent(view?.projectId ?? '')}/consultant-reasoning/download?mode=${encodeURIComponent(mode)}`} download>Download Markdown</a> : null}
    </details>
  );
}

export function ConsultantReasoningPanel({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<BriefMode>('meeting');
  const { view, busy, error, outcome, generate, state, cached, result, evidence, identity, providerAvailable, blocked } = useReasoningView(projectId, mode);

  return (
    <Section
      id="consultant-reasoning"
      title="Consultant reasoning"
      kicker="Judgement over the complete approved register · one bounded call, only when asked"
      count={result?.matters?.length ?? 0}
      className="consultant-reasoning"
    >
      <div className="mode-selector" role="tablist" aria-label="Consultant reasoning modes">
        {MODES.map((entry) => (
          <button key={entry.id} type="button" role="tab" aria-selected={mode === entry.id} className={mode === entry.id ? 'mode-card active' : 'mode-card'} onClick={() => setMode(entry.id)}>
            <strong>{entry.label}</strong><span>{entry.description}</span><small>Reading costs nothing</small>
          </button>
        ))}
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <ReasoningStatusBanners state={state} cached={cached} view={view} />

      {state === 'failed' && view?.lastFailure && view.lastFailure.violations.length > 0 ? (
        <div className="reasoning-banner failed" role="alert">
          <h4>Contract violations ({view.lastFailure.violations.length})</h4>
          <ul className="violation-list">
            {view.lastFailure.violations.map((violation, index) => (
              <li key={`${violation.code}:${violation.path}:${index}`}>
                <span className="violation-code">{violation.code}</span>
                <code className="hash">{violation.path}</code>
                <p>{violation.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state === 'none' || !result ? (
        <div className="reasoning-empty">
          <h4>No consultant reasoning has been generated for this mode.</h4>
          <p>
            Reasoning is never produced automatically. Opening this project, changing tabs and refreshing the page all read the
            cache and cost nothing, so a result exists only once someone has explicitly asked for one — or once an earlier
            result has been superseded by new approved state.
          </p>
          <p>
            The zero-call deterministic surfaces further down this page are unaffected: they are computed from the register by
            rule and remain available whether or not any reasoning exists.
          </p>
          <p>
            To inspect, audit or correct the underlying rows the reasoning would read, open the{' '}
            <a href={`#/projects/${encodeURIComponent(projectId)}/mined-data`}>Mined Data</a> tab.
          </p>
        </div>
      ) : (
        <ReasoningBody result={result} evidence={evidence} />
      )}

      {evidence.unresolved.length > 0 ? (
        <p className="inline-note" role="status">
          {evidence.unresolved.length} cited record(s) no longer resolve ({evidence.unresolved.join(', ')}). The register moved
          after this result was generated — regenerate before relying on it.
        </p>
      ) : null}

      <div className="reasoning-provenance">
        <h4>Provenance</h4>
        <dl className="inline-details">
          <div><dt>Skill</dt><dd>{identity ? `${identity.skillId}@${identity.skillVersion ?? 'unresolved'}` : 'Not read yet'}</dd></div>
          <div><dt>Prompt template</dt><dd>{identity?.promptTemplateVersion ?? 'Not resolved'}</dd></div>
          <div><dt>Provider / model</dt><dd>{identity ? `${identity.providerId} / ${identity.modelLabel}` : 'Not read yet'}</dd></div>
          <div><dt>Provider status</dt><dd>{providerAvailable ? 'Available' : `Unavailable — ${identity?.providerDetail ?? 'not reachable'}`}</dd></div>
          <div><dt>Project-state hash</dt><dd className="hash">{shortHash(view?.projectStateHash, 16)}</dd></div>
          <div><dt>Register revision</dt><dd>{view?.registerRevision ?? '-'}</dd></div>
          <div><dt>Generated</dt><dd>{cached ? formatDateTime(cached.generatedAt) : 'Never'}</dd></div>
          <div><dt>Result hash</dt><dd className="hash">{shortHash(cached?.resultSha256, 16)}</dd></div>
          <div><dt>Calls made by this read</dt><dd>{view?.providerCallsThisRequest ?? 0}</dd></div>
        </dl>
        {cached ? <a className="button secondary" href={`/api/projects/${encodeURIComponent(projectId)}/consultant-reasoning/download?mode=${encodeURIComponent(mode)}`} download>Download Markdown</a> : null}
      </div>

      {outcome ? (
        <p className="inline-note" role="status">
          Outcome: {humanize(outcome.outcome)} · {outcome.providerCalls} provider call{outcome.providerCalls === 1 ? '' : 's'} made.
          {outcome.message ? ` ${outcome.message}` : ''}
        </p>
      ) : null}

      <ReasoningRefreshControl state={state} busy={busy} blocked={blocked} identity={identity} onGenerate={(force) => void generate(force)} />
    </Section>
  );
}

/**
 * The accepted result.
 *
 * Each matter is written out in full exactly once — in the meeting order if it
 * appears there, otherwise in the first section that lists it. Every later
 * mention is a cross-reference by matter ID. Repeating the prose in every
 * section is how a brief becomes unreadable and how a consultant stops
 * believing the ordering means anything.
 */
function ReasoningBody({ result, evidence }: { result: ReasoningOutput; evidence: ReasoningEvidence }) {
  const matters = new Map((result.matters ?? []).map((matter) => [matter.matter_id, matter]));
  const detailedIn = new Map<string, string>();
  const claim = (sectionKey: string, ids: string[]) => {
    for (const id of ids) if (matters.has(id) && !detailedIn.has(id)) detailedIn.set(id, sectionKey);
  };
  claim('meeting_order', result.meeting_order ?? []);
  for (const section of SECTIONS) claim(String(section.key), (result[section.key] as string[] | undefined) ?? []);
  const unplaced = [...matters.keys()].filter((id) => !detailedIn.has(id));
  for (const id of unplaced) detailedIn.set(id, 'other_matters');

  return (
    <>
      <div className="reasoning-summary">
        <h4>Executive summary</h4>
        {(result.executive_summary ?? []).length === 0 ? <EmptyState>The result carried no executive summary.</EmptyState> : (
          <ul className="reasoning-summary-list">
            {(result.executive_summary ?? []).map((point, index) => (
              <li key={`${index}:${point.text.slice(0, 24)}`}>
                <p>{point.text}</p>
                <RegisterCitations ids={point.supporting_register_ids ?? []} evidence={evidence} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <article className="reasoning-section meeting-order">
        <header><h4>Meeting order</h4><span>{(result.meeting_order ?? []).length}</span></header>
        <p className="section-description">The matters that genuinely deserve discussion, most important first. At most ten.</p>
        {(result.meeting_order ?? []).length === 0 ? <EmptyState>Nothing was ordered for the meeting.</EmptyState> : (
          <ol className="matter-order">
            {(result.meeting_order ?? []).map((id) => {
              const matter = matters.get(id);
              if (!matter) return <li key={id}><code>{id}</code> — not defined by this result.</li>;
              return <li key={id}><MatterCard matter={matter} evidence={evidence} /></li>;
            })}
          </ol>
        )}
      </article>

      {SECTIONS.map((section) => {
        const ids = (result[section.key] as string[] | undefined) ?? [];
        return (
          <article key={String(section.key)} className="reasoning-section">
            <header><h4>{section.title}</h4><span>{ids.length}</span></header>
            {section.note ? <p className="section-description">{section.note}</p> : null}
            {ids.length === 0 ? <EmptyState>Nothing currently qualifies.</EmptyState> : (
              <ul className="matter-list">
                {ids.map((id) => {
                  const matter = matters.get(id);
                  if (!matter) return <li key={id}><code>{id}</code> — not defined by this result.</li>;
                  if (detailedIn.get(id) !== String(section.key)) return <li key={id}><MatterReference matter={matter} where={detailedIn.get(id) ?? 'meeting_order'} /></li>;
                  return <li key={id}><MatterCard matter={matter} evidence={evidence} /></li>;
                })}
              </ul>
            )}
          </article>
        );
      })}

      {unplaced.length > 0 ? (
        <article className="reasoning-section">
          <header><h4>Other matters</h4><span>{unplaced.length}</span></header>
          <p className="section-description">Raised by the reasoning but not placed in any section above.</p>
          <ul className="matter-list">{unplaced.map((id) => <li key={id}><MatterCard matter={matters.get(id) as ReasoningMatter} evidence={evidence} /></li>)}</ul>
        </article>
      ) : null}

      <details className="reasoning-notes">
        <summary>State observations and limitations ({(result.state_observations ?? []).length + (result.limitations ?? []).length})</summary>
        <h4>State observations — for human review, not applied</h4>
        {(result.state_observations ?? []).length === 0 ? <EmptyState>No state observations were raised.</EmptyState> : (
          <ul className="reasoning-summary-list">
            {(result.state_observations ?? []).map((point, index) => (
              <li key={`obs:${index}`}>
                <p>{point.observation}</p>
                <RegisterCitations ids={point.supporting_register_ids ?? []} evidence={evidence} />
              </li>
            ))}
          </ul>
        )}
        <h4>Limitations</h4>
        {(result.limitations ?? []).length === 0 ? <EmptyState>No limitations were declared.</EmptyState> : (
          <ul className="reasoning-summary-list">
            {(result.limitations ?? []).map((point, index) => (
              <li key={`lim:${index}`}>
                <p>{point.text}</p>
                <RegisterCitations ids={point.supporting_register_ids ?? []} evidence={evidence} />
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}

export function MatterReference({ matter, where }: { matter: ReasoningMatter; where: string }) {
  return (
    <div className="matter-reference">
      <code>{matter.matter_id}</code>
      <strong>{matter.title}</strong>
      <small>Set out in full under {humanize(where.replaceAll('_', '-'))}.</small>
    </div>
  );
}

export function MatterCard({ matter, evidence }: { matter: ReasoningMatter; evidence: ReasoningEvidence }) {
  const unconfirmed = matter.state !== 'confirmed_current';
  const weak = matter.evidence_strength !== 'strong';
  return (
    <article className={`matter-card${unconfirmed || weak ? ' matter-flagged' : ''}`}>
      <div className="record-line">
        <div>
          <p className="record-type">{matter.matter_id} · {humanize(matter.classification.replaceAll('_', '-'))}</p>
          <strong>{matter.title}</strong>
        </div>
        <span className={`importance-band band-${matter.priority}`}>{matter.priority}</span>
      </div>

      {unconfirmed || weak ? (
        <p className="matter-warning" role="status">
          <strong>Not settled truth.</strong>{' '}
          {unconfirmed ? `State is "${humanize(matter.state.replaceAll('_', '-'))}", not confirmed current. ` : ''}
          {weak ? `Evidence is ${matter.evidence_strength}, not strong. ` : ''}
          Confirm before acting on it.
        </p>
      ) : null}

      <dl className="inline-details">
        <div><dt>Priority</dt><dd>{humanize(matter.priority)}</dd></div>
        <div><dt>State</dt><dd>{humanize(matter.state.replaceAll('_', '-'))}</dd></div>
        <div><dt>Owner class</dt><dd>{humanize(matter.owner_class.replaceAll('_', '-'))}</dd></div>
        <div><dt>Evidence strength</dt><dd>{humanize(matter.evidence_strength)}</dd></div>
        <div><dt>Classification</dt><dd>{humanize(matter.classification.replaceAll('_', '-'))}</dd></div>
      </dl>

      <div className="matter-prose">
        <p><strong>Situation.</strong> {matter.situation}</p>
        <p><strong>Why it matters.</strong> {matter.why_it_matters}</p>
        <p><strong>Recommended move.</strong> {matter.recommended_move}</p>
        <p><strong>Reasoning.</strong> {matter.reasoning}</p>
      </div>

      {(matter.related_matter_ids ?? []).length > 0 ? (
        <p className="matter-related">Related: {(matter.related_matter_ids ?? []).map((id) => <code key={id}>{id}</code>)}</p>
      ) : null}

      <RegisterCitations ids={matter.supporting_register_ids ?? []} evidence={evidence} label="Supporting records" />
    </article>
  );
}

/** The drill-down. Every quote here came out of the register, never a model. */
export function RegisterCitations({ ids, evidence, label = 'Cites' }: { ids: string[]; evidence: ReasoningEvidence; label?: string }) {
  if (ids.length === 0) return null;
  return (
    <div className="register-citations">
      <p className="citation-label">{label} ({ids.length})</p>
      {ids.map((id) => {
        const row = evidence.rows?.[id];
        return (
          <details key={id} className="citation">
            <summary><code>{id}</code>{row ? ` — ${row.title}` : ' — no longer resolves in the register'}</summary>
            {row ? <RegisterEvidence row={row} /> : <p className="inline-note">This record could not be resolved. The register moved after this result was generated.</p>}
          </details>
        );
      })}
    </div>
  );
}

function RegisterEvidence({ row }: { row: ResolvedRegisterRow }) {
  return (
    <div className="citation-body">
      <div className="record-line">
        <div><p className="record-type">{humanize(row.register.replaceAll('_', '-'))}</p><strong>{row.title}</strong>{row.summary ? <p>{row.summary}</p> : null}</div>
        <StatusChip value={row.status} />
      </div>
      <dl className="inline-details">
        <div><dt>Register</dt><dd>{humanize(row.register.replaceAll('_', '-'))}</dd></div>
        <div><dt>Status</dt><dd>{humanize(row.status)}</dd></div>
        <div><dt>Owner</dt><dd>{row.owner ?? 'Unowned'}</dd></div>
        <div><dt>Due date</dt><dd>{formatDate(row.dueDate)}{row.overdue ? ' — overdue' : ''}</dd></div>
        {row.severity ? <div><dt>Severity</dt><dd>{humanize(row.severity)}</dd></div> : null}
        {row.superseded ? <div><dt>Superseded</dt><dd>Yes</dd></div> : null}
      </dl>
      {row.unanchored ? (
        <p className="no-anchor" role="status">
          No source anchor on this row. It came from a reaffirmation or a live-session change rather than a quoted passage, so it
          requires confirmation before it is relied on.
        </p>
      ) : (
        <ol className="anchor-list">
          {row.anchors.map((anchor, index) => (
            <li key={`${anchor.sourceId}:${anchor.segmentId}:${index}`}>
              <div className="anchor-meta">
                <StatusChip value={anchor.verified ? 'verified' : 'failed'} label={anchor.verified ? 'Verified quote' : 'Unverified quote match'} />
                <span>{anchor.speaker ?? 'Unknown speaker'}</span>
                <span>{anchorTime(anchor.tMs)}</span>
              </div>
              <blockquote>{anchor.quote ?? 'No quotation retained.'}</blockquote>
              <small>Source {anchor.sourceId} / segment {anchor.segmentId}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function shortHash(value: string | null | undefined, length: number): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, length) : '-';
}

function anchorTime(value: number | null): string {
  if (value === null) return 'No timestamp';
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
