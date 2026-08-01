import type { ReactNode } from 'react';
import { EmptyState, Section } from './components';
import type { BriefMode, ReasoningMatter, ReasoningOutput } from './consultantReasoningContract';
import type { ReasoningEvidence } from './consultantReasoningRender';
import {
  MatterCard, RegisterCitations, ReasoningProvenanceStrip, ReasoningRefreshControl, ReasoningStatusBanners,
  useReasoningView,
} from './ConsultantReasoningPanel';

/**
 * The primary-navigation reasoning tabs.
 *
 * Each tab reads the SAME accepted, cached result the old single-page
 * Consultant Reasoning panel did — `useReasoningView` makes exactly the same
 * provider-free GET — and renders one slice of it in full, because each
 * section is now its own destination rather than one part of a long scroll.
 * There is therefore no "claim this matter once, cross-reference it
 * elsewhere" bookkeeping here: a matter that appears in two sections (the
 * meeting order and, say, Decisions Needed) is written out in full on both
 * tabs, because a consultant who opens Decisions Needed directly wants the
 * full record, not a pointer to a different tab.
 *
 * Generation itself is untouched: `ReasoningRefreshControl` is the same
 * component everywhere, so "one bounded call, only on press" cannot drift
 * between tabs.
 */

/** The common frame every reasoning tab shares: banners, empty state, body, refresh, provenance. */
function ReasoningTabShell({
  projectId, mode, title, kicker, description, prominentRefresh = false, children,
}: {
  projectId: string;
  mode: BriefMode;
  title: string;
  kicker: string;
  description?: string;
  prominentRefresh?: boolean;
  children: (result: ReasoningOutput, evidence: ReasoningEvidence) => ReactNode;
}) {
  const { view, busy, error, generate, state, cached, result, evidence, identity, blocked } = useReasoningView(projectId, mode);
  return (
    <Section id={title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')} title={title} kicker={kicker} count={result ? undefined : 0}>
      {description ? <p className="section-description">{description}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <ReasoningStatusBanners state={state} cached={cached} view={view} prominent={prominentRefresh} />
      {state === 'none' || !result ? (
        <div className="reasoning-empty">
          <h4>No consultant reasoning has been generated yet.</h4>
          <p>
            Reasoning is never produced automatically — opening this tab, navigating and refreshing the page all read the cache
            and cost nothing. Press Generate below, or open <a href={`#/projects/${encodeURIComponent(projectId)}/mined-data`}>Mined Data</a> to
            inspect the underlying registers directly while none exists.
          </p>
        </div>
      ) : children(result, evidence)}
      <ReasoningRefreshControl state={state} busy={busy} blocked={blocked} identity={identity} onGenerate={(force) => void generate(force)} prominent={prominentRefresh} />
      <ReasoningProvenanceStrip view={view} cached={cached} mode={mode} />
    </Section>
  );
}

/** A matter list for one section key, each written out in full. */
function MatterList({ ids, matters, evidence, empty }: { ids: string[]; matters: Map<string, ReasoningMatter>; evidence: ReasoningEvidence; empty: string }) {
  if (ids.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <ul className="matter-list">
      {ids.map((id) => {
        const matter = matters.get(id);
        if (!matter) return <li key={id}><code>{id}</code> — not defined by this result.</li>;
        return <li key={id}><MatterCard matter={matter} evidence={evidence} /></li>;
      })}
    </ul>
  );
}

function matterMap(result: ReasoningOutput): Map<string, ReasoningMatter> {
  return new Map((result.matters ?? []).map((matter) => [matter.matter_id, matter]));
}

/** Overview — the executive picture, top matters and a way in, not the whole report. */
export function OverviewReasoningCard({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Consultant reasoning"
      kicker="The accepted judgement over the complete approved register · one bounded call, only when asked"
      prominentRefresh
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        const topMatters = (result.meeting_order ?? []).slice(0, 5);
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
            <article className="reasoning-section">
              <header><h4>Top matters</h4><span>{topMatters.length} of {(result.meeting_order ?? []).length}</span></header>
              <p className="section-description">
                The most important items right now. Open <a href={`#/projects/${encodeURIComponent(projectId)}/meeting-brief`}>Meeting Brief</a> for
                the complete prioritised order and full detail.
              </p>
              {topMatters.length === 0 ? <EmptyState>Nothing was ordered for the meeting.</EmptyState> : (
                <ol className="matter-order compact">
                  {topMatters.map((id) => {
                    const matter = matters.get(id);
                    if (!matter) return <li key={id}><code>{id}</code></li>;
                    return (
                      <li key={id}>
                        <div className="matter-reference">
                          <span className={`importance-band band-${matter.priority}`}>{matter.priority}</span>
                          <strong>{matter.title}</strong>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </article>
            <p className="inline-note">
              <a href={`#/projects/${encodeURIComponent(projectId)}/recent-changes`}>See what has changed</a> since this result was generated, or{' '}
              open <a href={`#/projects/${encodeURIComponent(projectId)}/mined-data`}>Mined Data</a> for the full underlying evidence.
            </p>
          </>
        );
      }}
    </ReasoningTabShell>
  );
}

/** Meeting Brief — the accepted top-ten meeting order, in full. */
export function MeetingBriefTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Meeting Brief"
      kicker="The matters that genuinely deserve discussion in the next meeting, most important first"
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        const order = result.meeting_order ?? [];
        return (
          <article className="reasoning-section meeting-order">
            <header><h4>Meeting order</h4><span>{order.length}</span></header>
            <p className="section-description">At most ten. Each includes why it matters, the recommended move and any contradiction or confirmation warning.</p>
            {order.length === 0 ? <EmptyState>Nothing was ordered for the meeting.</EmptyState> : (
              <ol className="matter-order">
                {order.map((id) => {
                  const matter = matters.get(id);
                  if (!matter) return <li key={id}><code>{id}</code> — not defined by this result.</li>;
                  return <li key={id}><MatterCard matter={matter} evidence={evidence} /></li>;
                })}
              </ol>
            )}
          </article>
        );
      }}
    </ReasoningTabShell>
  );
}

/**
 * My Actions — the `needs-consultant` mode result, grouped by who actually
 * owns the work. `owner_class` comes straight from the accepted matter, so
 * "ownership decisions Warwick must make" is exactly the `unowned`/`shared`
 * group, not a guess layered on afterwards.
 */
export function MyActionsTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="needs-consultant"
      title="My Actions"
      kicker="What the consultant must personally move next, from the accepted needs-consultant reasoning"
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        const ids = result.consultant_next_actions ?? [];
        const groups: Array<{ key: string; label: string; description: string }> = [
          { key: 'consultant', label: 'Consultant-owned', description: 'Squarely yours to move.' },
          { key: 'shared', label: 'Shared', description: 'Joint action with the customer.' },
          { key: 'unowned', label: 'Ownership decision needed', description: 'Nobody owns this yet — decide who does.' },
          { key: 'customer', label: 'Customer-owned, tracked here', description: 'Not yours to do, kept visible because it blocks you.' },
          { key: 'not_applicable', label: 'Other', description: '' },
        ];
        const suggestedOrder = result.meeting_order ?? [];
        return (
          <>
            {suggestedOrder.length > 0 ? (
              <p className="inline-note">
                Suggested order, from this same result's own prioritisation: {suggestedOrder.map((id, index) => <code key={id}>{index > 0 ? ', ' : ''}{id}</code>)}
              </p>
            ) : null}
            {groups.map((group) => {
              const groupIds = ids.filter((id) => matters.get(id)?.owner_class === group.key);
              if (groupIds.length === 0) return null;
              return (
                <article key={group.key} className="reasoning-section">
                  <header><h4>{group.label}</h4><span>{groupIds.length}</span></header>
                  {group.description ? <p className="section-description">{group.description}</p> : null}
                  <MatterList ids={groupIds} matters={matters} evidence={evidence} empty="None." />
                </article>
              );
            })}
            {ids.length === 0 ? <EmptyState>Nothing currently qualifies as a consultant next action.</EmptyState> : null}
          </>
        );
      }}
    </ReasoningTabShell>
  );
}

export function CustomerDependenciesTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Customer Dependencies"
      kicker="Genuine external inputs, actions and decisions this project is waiting on"
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        return <MatterList ids={result.customer_dependencies ?? []} matters={matters} evidence={evidence} empty="Nothing currently qualifies as a customer dependency." />;
      }}
    </ReasoningTabShell>
  );
}

export function DecisionsNeededTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Decisions Needed"
      kicker="Decisions genuinely required, why they unlock work, and any conflicting position on record"
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        return <MatterList ids={result.decisions_required ?? []} matters={matters} evidence={evidence} empty="No decision is currently outstanding." />;
      }}
    </ReasoningTabShell>
  );
}

export function RisksBlockersTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Risks & Blockers"
      kicker="Reasoning-derived risks and delivery blockers — the judgement, not the raw Risks_Issues table"
      description="For the complete raw register, including closed and reference-only rows, open Mined Data."
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        return <MatterList ids={result.risks_and_blockers ?? []} matters={matters} evidence={evidence} empty="Nothing currently qualifies as a risk or blocker." />;
      }}
    </ReasoningTabShell>
  );
}

export function QuestionsTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Questions"
      kicker="Genuinely unanswered questions — reconciled against later state, not merely listed"
      description="A question the reasoning found answered, superseded or contradicted is left out here and explained instead under Decisions Needed, Recent Changes or its matter's own state label; it is never silently dropped."
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        return <MatterList ids={result.unanswered_questions ?? []} matters={matters} evidence={evidence} empty="No question is currently open." />;
      }}
    </ReasoningTabShell>
  );
}

export function RecentChangesTab({ projectId }: { projectId: string }) {
  return (
    <ReasoningTabShell
      projectId={projectId}
      mode="meeting"
      title="Recent Changes"
      kicker="What has moved since this reasoning was generated, and what the reasoning itself flagged as recent"
    >
      {(result, evidence) => {
        const matters = matterMap(result);
        return (
          <>
            <article className="reasoning-section">
              <header><h4>Flagged by the reasoning as recent</h4><span>{(result.recent_changes ?? []).length}</span></header>
              <MatterList ids={result.recent_changes ?? []} matters={matters} evidence={evidence} empty="The reasoning did not flag any change as recent." />
            </article>
            <article className="reasoning-section">
              <header><h4>Contradictions and state conflicts</h4><span>{(result.contradictions_and_state_conflicts ?? []).length}</span></header>
              <p className="section-description">Where the record disagrees with itself since or around this reasoning run.</p>
              <MatterList ids={result.contradictions_and_state_conflicts ?? []} matters={matters} evidence={evidence} empty="None flagged." />
            </article>
          </>
        );
      }}
    </ReasoningTabShell>
  );
}
