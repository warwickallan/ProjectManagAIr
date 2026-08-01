/**
 * Source safety, made understandable without database knowledge.
 *
 * Two surfaces:
 *
 *   - `SourceSafetyChips` — the verdict a consultant needs the moment a file
 *     lands, rendered on the Inbox row itself: duplicate result, whether a
 *     decision is owed, what is known about the meeting date, and whether the
 *     source has been retired.
 *
 *   - `SourceSafetyDetail` — the full record: hashes, every filename this
 *     content has arrived under, the comparison table, extraction and changeset
 *     history, the register rows this source created or affected, and the
 *     governed Discard and Void actions.
 *
 * Both dangerous actions (Discard, Void) require an explicit confirmation step
 * AND a mandatory reason before the button will submit. The service enforces
 * the same rules, so the UI is the courtesy, not the control.
 */
import { useCallback, useEffect, useState } from 'react';

export type SourceClassification =
  | 'exact-duplicate' | 'normalised-duplicate' | 'possible-overlap'
  | 'similar-filename-different-content' | 'previously-voided-duplicate'
  | 'cross-project-match' | 'apparently-new';

export type SourceLifecycleState = 'active' | 'duplicate' | 'wrong-project' | 'wrong-file' | 'discarded' | 'voided';

export interface SourceSafetySummary {
  comparisonClassification: SourceClassification;
  comparisonLabel: string;
  comparisonDetail: string;
  comparisonMatchCount: number;
  awaitingDuplicateDecision: boolean;
  duplicateBlocksExtraction: boolean;
  chronologyState: 'confirmed' | 'approximate' | 'unknown';
  chronologyBasis: string;
  chronologyLabel: string;
  metadataConfirmed: boolean;
  lifecycleState: SourceLifecycleState;
  lifecycleLabel: string;
  lifecycleReason: string | null;
  hasAppliedChangeset: boolean;
}

/** Chip tone per verdict — red for "stop", amber for "decide", plain for "carry on". */
const CLASSIFICATION_TONE: Record<SourceClassification, string> = {
  'exact-duplicate': 'critical',
  'normalised-duplicate': 'critical',
  'previously-voided-duplicate': 'critical',
  'possible-overlap': 'attention',
  'cross-project-match': 'attention',
  'similar-filename-different-content': 'neutral',
  'apparently-new': 'success',
};

const LIFECYCLE_TONE: Record<SourceLifecycleState, string> = {
  active: 'neutral', duplicate: 'critical', 'wrong-project': 'critical',
  'wrong-file': 'critical', discarded: 'critical', voided: 'critical',
};

function Chip({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) {
  return <span className={`safety-chip safety-chip-${tone}`} title={title}>{children}</span>;
}

/**
 * The at-a-glance answer to "what is this file, and what do I owe it?"
 *
 * Deliberately shows the chronology chip even when everything is fine: "Meeting
 * date unknown" is a legitimate, permanent state, and hiding it would make the
 * unknown look like an omission somebody still has to fix.
 */
export function SourceSafetyChips({ summary }: { summary: SourceSafetySummary }) {
  return <div className="safety-chips">
    <Chip tone={CLASSIFICATION_TONE[summary.comparisonClassification] ?? 'neutral'} title={summary.comparisonDetail}>{summary.comparisonLabel}</Chip>
    {summary.awaitingDuplicateDecision
      ? <Chip tone="attention" title={summary.duplicateBlocksExtraction ? 'Nothing is extracted until you decide.' : 'Confirm whether this is the same meeting.'}>Decision needed</Chip>
      : null}
    <Chip tone={summary.chronologyState === 'unknown' ? 'attention' : 'neutral'} title={`Basis: ${summary.chronologyBasis}`}>{summary.chronologyLabel}</Chip>
    {summary.metadataConfirmed ? null : <Chip tone="attention">Meeting details not confirmed</Chip>}
    {summary.lifecycleState === 'active'
      ? null
      : <Chip tone={LIFECYCLE_TONE[summary.lifecycleState]} title={summary.lifecycleReason ?? undefined}>{summary.lifecycleLabel}</Chip>}
  </div>;
}

/* -------------------------------------------------------------------------- */

interface StoredComparison {
  id: string;
  classification: SourceClassification;
  label: string;
  matchedSourceId: string | null;
  matchedProjectId: string | null;
  matchedFileName: string | null;
  matchedMeetingSubject: string | null;
  matchedChronology: string | null;
  matchedLifecycleState: string | null;
  matchedProcessingStatus: string | null;
  rawHashMatch: boolean;
  canonicalMatch: boolean;
  overlapRatio: number;
  filenameSimilarity: number;
  detail: string;
  incomingFileName: string | null;
  blocksExtraction: boolean;
  requiresDecision: boolean;
  createdAt: string;
  decision: string | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

interface LifecycleEvent {
  id: string; occurredAt: string; actor: string; eventType: string;
  previousState: string; newState: string; reason: string;
}

interface SafetyRecord {
  sourceId: string;
  intakeSourceId: string | null;
  fileName: string;
  alternateNames: Array<{ fileName: string; firstSeenAt: string }>;
  contentHash: string;
  canonicalFingerprint: string | null;
  chunkCount: number;
  immutablePath: string | null;
  lifecycleState: SourceLifecycleState;
  lifecycleLabel: string;
  lifecycleReason: string | null;
  lifecycleActor: string | null;
  lifecycleAt: string | null;
  comparisons: StoredComparison[];
  pendingDecision: StoredComparison | null;
  lifecycleHistory: LifecycleEvent[];
  changesets: Array<{ id: string; reviewStatus: string; appliedAt: string | null; voidedAt: string | null; gateVerdict: string }>;
  extractionRuns: Array<{ id: string; status: string; providerId: string; startedAt: string; inputTokens: number; outputTokens: number }>;
  affectedRows: Array<{ externalRegisterId: string; registerName: string; title: string; effective: boolean; reviewFlag: string | null; reviewDetail: string | null }>;
  canDiscard: boolean;
  canVoid: boolean;
}

const DECISION_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'retain-as-new', label: 'Retain as new', hint: 'This really is a different meeting. Let it proceed.' },
  { value: 'mark-duplicate', label: 'Mark duplicate', hint: 'The same meeting is already here. Retire this copy.' },
  { value: 'mark-wrong-project', label: 'Mark wrong project', hint: 'The transcript is real but belongs to another project.' },
  { value: 'mark-wrong-file', label: 'Mark wrong file', hint: 'The wrong file was uploaded.' },
  { value: 'discard', label: 'Discard', hint: 'This should not be here at all.' },
];

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Request failed.');
  return payload;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * A dangerous action: an explicit arm step, then a mandatory reason, then the
 * confirm button. Arming is separate from confirming so that neither a stray
 * click nor an empty reason can retire a source.
 */
function DangerousAction({ label, verb, description, disabled, onRun }: {
  label: string; verb: string; description: string; disabled?: boolean;
  onRun: (reason: string) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!armed) {
    return <button className="inline-button danger-button" disabled={disabled} onClick={() => { setArmed(true); setError(''); }}>{label}</button>;
  }
  return <div className="danger-confirm">
    <p className="danger-confirm-lede">{description}</p>
    <label>Reason (required)
      <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} placeholder="Why is this being done? This is recorded permanently." />
    </label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="action-row">
      <button className="button danger-button" disabled={busy || reason.trim().length === 0} onClick={async () => {
        setBusy(true); setError('');
        try { await onRun(reason.trim()); setArmed(false); setReason(''); }
        catch (caught) { setError(caught instanceof Error ? caught.message : 'Action failed.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Working…' : verb}</button>
      <button className="inline-button" disabled={busy} onClick={() => { setArmed(false); setReason(''); setError(''); }}>Cancel</button>
    </div>
  </div>;
}

/** The full source record, and the governed actions available on it. */
export function SourceSafetyDetail({ projectId, sourceId, userId, onChanged }: { projectId: string; sourceId: string; userId: string; onChanged: () => void }) {
  const [record, setRecord] = useState<SafetyRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/safety`);
      if (!response.ok) throw new Error('Could not load source safety record.');
      setRecord(await response.json() as SafetyRecord);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load source safety record.');
    } finally {
      setLoading(false);
    }
  }, [projectId, sourceId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="muted">Loading source record…</p>;
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!record) return null;

  const refresh = async () => { await load(); onChanged(); };

  return <div className="source-safety-detail">
    <section>
      <h4>Identity</h4>
      <dl className="inline-details">
        <div><dt>Immutable file</dt><dd>{record.fileName}</dd></div>
        <div><dt>Raw SHA-256</dt><dd className="hash-value">{record.contentHash}</dd></div>
        <div><dt>Transcript fingerprint</dt><dd className="hash-value">{record.canonicalFingerprint ?? 'Not computed'}</dd></div>
        <div><dt>Chunk fingerprints</dt><dd>{record.chunkCount}</dd></div>
        <div><dt>State</dt><dd>{record.lifecycleLabel}{record.lifecycleReason ? ` — ${record.lifecycleReason}` : ''}</dd></div>
      </dl>
      {record.alternateNames.length > 1
        ? <p className="muted">Seen under {record.alternateNames.length} filenames: {record.alternateNames.map((entry) => entry.fileName).join(', ')}. The filename is never used to decide identity.</p>
        : null}
    </section>

    <section>
      <h4>Comparison with existing sources</h4>
      {record.comparisons.length === 0
        ? <p className="muted">No comparison recorded. This source shares no content with anything already here.</p>
        : <table className="compact-table">
          <thead><tr><th>Result</th><th>Matched source</th><th>Filenames</th><th>Raw hash</th><th>Transcript</th><th>Overlap</th><th>State</th><th>Meeting</th><th>Decision</th></tr></thead>
          <tbody>{record.comparisons.map((row) => <tr key={row.id}>
            <td><Chip tone={CLASSIFICATION_TONE[row.classification] ?? 'neutral'}>{row.label}</Chip><span className="muted-block">{row.detail}</span></td>
            <td>{row.matchedSourceId ?? '—'}{row.matchedProjectId && row.matchedProjectId !== projectId ? <span className="muted-block">Project {row.matchedProjectId}</span> : null}</td>
            <td>{row.incomingFileName ?? '—'}{row.matchedFileName && row.matchedFileName !== row.incomingFileName ? <span className="muted-block">vs {row.matchedFileName}</span> : null}</td>
            <td>{row.rawHashMatch ? 'Match' : 'Different'}</td>
            <td>{row.canonicalMatch ? 'Match' : 'Different'}</td>
            <td>{percent(row.overlapRatio)}</td>
            <td>{row.matchedLifecycleState ?? '—'}{row.matchedProcessingStatus ? <span className="muted-block">{row.matchedProcessingStatus}</span> : null}</td>
            <td>{row.matchedMeetingSubject ?? '—'}<span className="muted-block">{row.matchedChronology ?? ''}</span></td>
            <td>{row.decision ? <>{row.decision}<span className="muted-block">{row.decidedBy} — {row.decisionReason}</span></> : <em>Not decided</em>}</td>
          </tr>)}</tbody>
        </table>}

      {record.pendingDecision
        ? <div className="decision-panel">
          <p><strong>This source needs a decision.</strong>{record.pendingDecision.blocksExtraction ? ' Nothing is extracted and no AI call is made until you choose.' : ' Confirm whether this is the same meeting.'}</p>
          <ComparisonDecider projectId={projectId} sourceId={sourceId} userId={userId} onDone={refresh} />
        </div>
        : null}
    </section>

    <section>
      <h4>Extraction and changesets</h4>
      {record.extractionRuns.length === 0 ? <p className="muted">No extraction has run for this source.</p>
        : <ul className="plain-list">{record.extractionRuns.map((run) => <li key={run.id}>{run.startedAt} — {run.providerId} — {run.status} ({run.inputTokens} in / {run.outputTokens} out)</li>)}</ul>}
      {record.changesets.length === 0 ? <p className="muted">No changeset was proposed from this source.</p>
        : <ul className="plain-list">{record.changesets.map((changeset) => <li key={changeset.id}>{changeset.id} — {changeset.reviewStatus}{changeset.appliedAt ? `, applied ${changeset.appliedAt}` : ''}{changeset.voidedAt ? `, VOIDED ${changeset.voidedAt}` : ''}</li>)}</ul>}
    </section>

    <section>
      <h4>Register rows created or affected ({record.affectedRows.length})</h4>
      {record.affectedRows.length === 0 ? <p className="muted">This source has changed no register rows.</p>
        : <table className="compact-table">
          <thead><tr><th>Record</th><th>Register</th><th>Title</th><th>In effective state</th><th>Review</th></tr></thead>
          <tbody>{record.affectedRows.map((row) => <tr key={row.externalRegisterId}>
            <td>{row.externalRegisterId}</td><td>{row.registerName}</td><td>{row.title}</td>
            <td>{row.effective ? 'Yes' : <strong>No — historical</strong>}</td>
            <td>{row.reviewFlag ? <Chip tone="attention" title={row.reviewDetail ?? undefined}>{row.reviewFlag === 'founding-source-voided' ? 'Founding source voided — review required' : row.reviewFlag === 'orphaned-by-source-void' ? 'Orphaned by source void — review required' : 'Related record changed — review required'}</Chip> : '—'}</td>
          </tr>)}</tbody>
        </table>}
    </section>

    <section>
      <h4>Source lifecycle history</h4>
      {record.lifecycleHistory.length === 0 ? <p className="muted">No lifecycle decision has been recorded for this source.</p>
        : <ul className="plain-list">{record.lifecycleHistory.map((event) => <li key={event.id}>
          <strong>{event.eventType}</strong> — {event.previousState} → {event.newState} — {event.actor} — {event.occurredAt}
          <span className="muted-block">{event.reason}</span>
        </li>)}</ul>}
    </section>

    <section>
      <h4>Actions</h4>
      {record.canDiscard
        ? <div className="action-row">
          {(['duplicate', 'wrong-project', 'wrong-file', 'discarded'] as const).map((state) => <DangerousAction
            key={state}
            label={state === 'duplicate' ? 'Mark duplicate' : state === 'wrong-project' ? 'Mark wrong project' : state === 'wrong-file' ? 'Mark wrong file' : 'Discard'}
            verb="Confirm"
            description={`The immutable file, both content hashes and all provenance are kept. Extraction and application are prevented. No project state changes and no AI call is made.`}
            onRun={async (reason) => { await postJson(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/discard`, { state, actor: userId, reason }); await refresh(); }}
          />)}
        </div>
        : null}
      {record.canVoid
        ? <DangerousAction
          label="Void source"
          verb="Void this source"
          description="This source has already changed the project. Voiding removes its contribution from current effective state by replaying the event log without it. Nothing is deleted: the file, the extraction packet, the raw response, the changeset and every event are all kept. Rows that only this source evidenced leave effective state and are flagged; rows another valid source evidences are kept and flagged for review. Consultant Reasoning is marked stale. No AI call is made."
          onRun={async (reason) => { await postJson(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/void`, { actor: userId, reason }); await refresh(); }}
        />
        : null}
      {!record.canDiscard && !record.canVoid
        ? <p className="muted">No lifecycle action is available: this source is already {record.lifecycleLabel.toLowerCase()}.</p>
        : null}
    </section>
  </div>;
}

/** The Inbox-side decision control: retain as new, or retire through the governed discard path. */
export function ComparisonDecider({ projectId, sourceId, userId, onDone }: { projectId: string; sourceId: string; userId: string; onDone: () => void }) {
  const [decision, setDecision] = useState('retain-as-new');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = DECISION_OPTIONS.find((option) => option.value === decision);
  return <div className="decision-form">
    <label>What is this source?
      <select value={decision} onChange={(event) => setDecision(event.target.value)}>
        {DECISION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {chosen ? <p className="muted">{chosen.hint}</p> : null}
    <label>Reason (required)
      <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} placeholder="Recorded permanently against this source." />
    </label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="action-row">
      <button className="button" disabled={busy || reason.trim().length === 0} onClick={async () => {
        setBusy(true); setError('');
        try {
          await postJson(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/comparison-decision`, { decision, actor: userId, reason: reason.trim() });
          setReason('');
          onDone();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Could not record the decision.');
        } finally { setBusy(false); }
      }}>{busy ? 'Recording…' : 'Record decision'}</button>
    </div>
  </div>;
}
