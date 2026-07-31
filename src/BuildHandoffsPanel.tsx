import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Section, StatusChip, formatDateTime, humanize } from './components';

/**
 * Settings → Build Handoffs.
 *
 * A cloud build session leaves a manifest and, where the branch is not already
 * on origin, a bundle. This panel shows what is waiting and finishes it in one
 * press: verify, fetch, push, confirm the remote SHA, open or update the draft
 * pull request. GitHub is the canonical build record; the Google Drive mirror is
 * an optional convenience and is shown as one.
 *
 * It holds no Git logic. Reading this page is a filesystem read — it cannot push
 * anything or spend a network call — and Finalise POSTs to a route that calls the
 * same `finalizeBuild` engine `finish-projectmanagair-build.cmd` calls.
 */

type FinalizeState = 'COMPLETED' | 'PARTIAL' | 'FAILED';

type DeliverableResult = {
  path: string;
  title: string;
  classification: string;
  required: boolean;
  sha256: string | null;
  uploadStatus: string;
  driveFileId: string | null;
  driveUrl: string | null;
  googleDocId: string | null;
  googleDocUrl: string | null;
  uploadedAt: string | null;
  error: string | null;
};

type DriveStatus = 'disabled' | 'not_configured' | 'skipped' | 'mirrored' | 'failed';

type GitHandoffSummary = { path: string | null; status: 'present' | 'missing' | 'unverified' | 'not-declared' };

type DriveSummary = {
  status: DriveStatus;
  required: boolean;
  attempted: boolean;
  folderId: string | null;
  folderName: string | null;
  folderUrl: string | null;
  requiredCount: number;
  uploadedCount: number;
  connectionRequired: boolean;
  error: string | null;
};

type LastRun = {
  state: FinalizeState;
  finishedAt: string;
  localHeadSha: string | null;
  remoteHeadSha: string | null;
  pullRequest: { number: number; url: string; draft: boolean; headSha: string | null; created: boolean } | null;
  gitHandoff: GitHandoffSummary;
  drive: DriveSummary;
  deliverables: DeliverableResult[];
  lastError: string | null;
  completionManifestPath: string;
};

type Handoff = {
  manifestPath: string;
  fileName: string;
  state: 'pending' | 'completed';
  readable: boolean;
  parseError: string | null;
  modifiedAt: string;
  repository: string | null;
  branch: string | null;
  baseBranch: string | null;
  baselineSha: string | null;
  expectedHeadSha: string | null;
  origin: { model: string; session: string | null } | null;
  createdAt: string | null;
  handoffDocumentPath: string | null;
  bundlePath: string | null;
  bundlePresent: boolean;
  lastRun: LastRun | null;
  driveDeclared: boolean;
  driveFolderName: string | null;
  gitHandoffPath: string | null;
  requiredDeliverables: number;
};

type HandoffsResponse = { root: string; pending: string; completed: string; handoffs: Handoff[] };

type FinalizeResponse = {
  state: FinalizeState;
  branch: string;
  expectedHeadSha: string;
  remoteHeadSha: string | null;
  pullRequest: LastRun['pullRequest'];
  gitHandoff: GitHandoffSummary;
  drive: DriveSummary;
  deliverables: DeliverableResult[];
  steps: Array<{ key: string; title: string; status: 'ok' | 'skipped' | 'failed'; detail: string; mutated: boolean }>;
  errors: string[];
  completionManifestPath: string | null;
};

export function BuildHandoffsPanel() {
  const [data, setData] = useState<HandoffsResponse | null>(null);
  const [error, setError] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ manifestPath: string; result: FinalizeResponse } | null>(null);
  const [driveUrl, setDriveUrl] = useState('');

  const reload = useCallback(async () => {
    try {
      setError('');
      setData(await getJson<HandoffsResponse>('/api/build-handoffs'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Build handoffs could not be read.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function finalize(handoff: Handoff, dryRun: boolean) {
    try {
      setBusyPath(handoff.manifestPath);
      setError('');
      setLastResult(null);
      const result = await postJson<FinalizeResponse>('/api/build-handoffs/finalize', { manifestPath: handoff.manifestPath, dryRun });
      setLastResult({ manifestPath: handoff.manifestPath, result });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The finaliser could not be run.');
    } finally {
      setBusyPath(null);
    }
  }

  async function connectDrive() {
    try {
      setError('');
      const { authorizationUrl } = await postJson<{ authorizationUrl: string }>('/api/build-handoffs/connect-drive', {});
      setDriveUrl(authorizationUrl);
      window.open(authorizationUrl, '_blank', 'noopener');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Google Drive connection could not be started.');
    }
  }

  const pending = data?.handoffs.filter((entry) => entry.state === 'pending') ?? [];
  const completed = data?.handoffs.filter((entry) => entry.state === 'completed') ?? [];

  return (
    <Section id="build-handoffs" title="Build Handoffs" kicker="Finish a cloud build without touching Git" count={pending.length}>
      <p className="section-description">
        A cloud build leaves a manifest here, and a bundle when the branch is not already on origin. Finalise verifies the
        bundle and the exact SHA, creates the branch, pushes it, confirms what origin actually points at, opens or updates the
        draft pull request, and confirms the sanitised build record is committed. It never merges, never force-pushes and never
        touches your working tree. The same engine runs from <code>finish-projectmanagair-build.cmd</code>.
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {driveUrl ? (
        <p className="inline-note">
          Google Drive authorisation opened in a new tab. If it did not open, use this link: <a href={driveUrl} target="_blank" rel="noreferrer">Connect Google Drive</a>. Then press Retry.
        </p>
      ) : null}

      {!data ? <p>Reading build handoffs</p> : (
        <>
          <h4 className="subhead">Pending ({pending.length})</h4>
          {pending.length === 0 ? <EmptyState>Nothing is waiting to be finalised. Handoffs appear in {data.pending}.</EmptyState> : (
            <div className="handoff-list">
              {pending.map((handoff) => (
                <HandoffCard
                  key={handoff.manifestPath}
                  handoff={handoff}
                  busy={busyPath === handoff.manifestPath}
                  anyBusy={busyPath !== null}
                  result={lastResult?.manifestPath === handoff.manifestPath ? lastResult.result : null}
                  onFinalize={(dryRun) => void finalize(handoff, dryRun)}
                  onConnectDrive={() => void connectDrive()}
                />
              ))}
            </div>
          )}

          <h4 className="subhead">Completed ({completed.length})</h4>
          {completed.length === 0 ? <EmptyState>No build has been finalised on this machine yet.</EmptyState> : (
            <div className="handoff-list">
              {completed.map((handoff) => (
                <HandoffCard
                  key={handoff.manifestPath}
                  handoff={handoff}
                  busy={busyPath === handoff.manifestPath}
                  anyBusy={busyPath !== null}
                  result={lastResult?.manifestPath === handoff.manifestPath ? lastResult.result : null}
                  onFinalize={(dryRun) => void finalize(handoff, dryRun)}
                  onConnectDrive={() => void connectDrive()}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** What the committed, canonical build record looks like right now. */
function gitHandoffLabel(handoff: Handoff, gitHandoff: GitHandoffSummary | null) {
  if (gitHandoff?.status === 'present') return <>Committed — <code>{gitHandoff.path}</code></>;
  if (gitHandoff?.status === 'missing') return <>MISSING from the commit — <code>{gitHandoff.path}</code></>;
  if (gitHandoff?.status === 'unverified') return <>Declared, not yet verified — <code>{gitHandoff.path}</code></>;
  if (handoff.gitHandoffPath) return <>Declared, not yet verified — <code>{handoff.gitHandoffPath}</code></>;
  return 'Not declared — this build cannot finalise until it commits one';
}

/** Plain words for the optional mirror. Never phrased as something outstanding. */
function driveLabel(handoff: Handoff, drive: DriveSummary | null) {
  if (!handoff.driveDeclared) return 'not enabled for this build';
  switch (drive?.status) {
    case 'mirrored': return `${drive.uploadedCount} deliverable(s) mirrored`;
    case 'not_configured': return 'Drive is not connected on this machine';
    case 'failed': return `not mirrored — ${drive.error ?? 'unknown reason'}`;
    case 'skipped': return 'not run this time';
    case 'disabled': return 'not enabled for this build';
    default:
      // A completion record written by an engine that predates `drive.status`.
      // Read what it does carry rather than asserting something false about it.
      if (!drive) return 'enabled, not attempted yet';
      if (drive.uploadedCount > 0) return `${drive.uploadedCount} deliverable(s) mirrored`;
      if (drive.connectionRequired) return 'Drive is not connected on this machine';
      if (drive.error) return `not mirrored — ${drive.error}`;
      return drive.attempted ? 'attempted, nothing mirrored' : 'enabled, not attempted yet';
  }
}

function HandoffCard({ handoff, busy, anyBusy, result, onFinalize, onConnectDrive }: {
  handoff: Handoff;
  busy: boolean;
  anyBusy: boolean;
  result: FinalizeResponse | null;
  onFinalize: (dryRun: boolean) => void;
  onConnectDrive: () => void;
}) {
  const run = handoff.lastRun;
  const drive = result?.drive ?? run?.drive ?? null;
  const gitHandoff = result?.gitHandoff ?? run?.gitHandoff ?? null;
  const deliverables = result?.deliverables ?? run?.deliverables ?? [];
  const pullRequest = result?.pullRequest ?? run?.pullRequest ?? null;
  const remoteSha = result?.remoteHeadSha ?? run?.remoteHeadSha ?? null;
  const state: FinalizeState | null = result?.state ?? run?.state ?? null;

  if (!handoff.readable) {
    return (
      <article className="handoff-card unreadable">
        <div className="record-line"><div><p className="record-type">{handoff.fileName}</p><h5>This manifest cannot be read</h5></div><StatusChip value="failed" label="Unreadable" /></div>
        <p className="form-error">{handoff.parseError}</p>
        <small>{handoff.manifestPath}</small>
      </article>
    );
  }

  return (
    <article className="handoff-card">
      <header className="record-line">
        <div>
          <p className="record-type">{handoff.repository} · {handoff.origin?.model ?? 'unknown model'}{handoff.origin?.session ? ` · session ${handoff.origin.session}` : ''}</p>
          <h5>{handoff.branch} → {handoff.baseBranch}</h5>
          <small>Created {handoff.createdAt ? formatDateTime(handoff.createdAt) : 'unknown'} · {handoff.fileName}</small>
        </div>
        <div className="handoff-chips">
          <StatusChip value={handoff.state === 'completed' ? 'verified' : 'pending'} label={humanize(handoff.state)} />
          {state ? <StatusChip value={state === 'COMPLETED' ? 'verified' : state === 'PARTIAL' ? 'watch' : 'failed'} label={state} /> : null}
        </div>
      </header>

      <dl className="inline-details handoff-details">
        <div><dt>Expected SHA</dt><dd className="hash">{handoff.expectedHeadSha}</dd></div>
        <div><dt>Baseline SHA</dt><dd className="hash">{handoff.baselineSha}</dd></div>
        <div><dt>Bundle</dt><dd>{handoff.bundlePath ? (handoff.bundlePresent ? 'Present' : 'MISSING') : 'Not needed'}</dd></div>
        <div><dt>Local branch</dt><dd>{run?.localHeadSha ? (run.localHeadSha === handoff.expectedHeadSha ? 'At the expected SHA' : run.localHeadSha) : 'Not created yet'}</dd></div>
        <div><dt>Remote branch</dt><dd>{remoteSha ? (remoteSha === handoff.expectedHeadSha ? 'Verified at the expected SHA' : remoteSha) : 'Not pushed yet'}</dd></div>
        <div><dt>Pull request</dt><dd>{pullRequest ? <a href={pullRequest.url} target="_blank" rel="noreferrer">#{pullRequest.number}{pullRequest.draft ? ' (draft)' : ''}</a> : 'Not opened yet'}</dd></div>
        <div><dt>Build record in Git</dt><dd>{gitHandoffLabel(handoff, gitHandoff)}</dd></div>
        <div><dt>Last finalised</dt><dd>{run ? formatDateTime(run.finishedAt) : 'Never'}</dd></div>
      </dl>

      <p className="optional-mirror">
        <span className="optional-tag">Optional</span> Google Drive mirror — {driveLabel(handoff, drive)}. A build is complete
        without it: GitHub is the canonical record.
      </p>

      {handoff.handoffDocumentPath ? <p className="inline-note">Handoff document: <code>{handoff.handoffDocumentPath}</code></p> : null}

      {drive?.connectionRequired ? (
        <div className="drive-connection" role="status">
          <StatusChip value="watch" label="Google Drive not connected (optional)" />
          <p>{drive.error ?? 'Google Drive has not been authorised on this machine.'}</p>
          <p className="inline-note">
            This does not affect the build. The pushed branch, the verified remote SHA, the pull request and the committed build
            record are the finalisation; connect Drive only if you also want the optional mirror.
          </p>
          <button className="button secondary" type="button" onClick={onConnectDrive}>Connect Google Drive (optional)</button>
        </div>
      ) : null}

      {(result?.errors.length ?? 0) > 0 || run?.lastError ? (
        <div className="handoff-errors" role="alert">
          <strong>Outstanding</strong>
          <ul>{(result?.errors ?? [run!.lastError!]).map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : null}

      {deliverables.length > 0 ? (
        <details className="handoff-deliverables">
          <summary>Deliverables ({deliverables.filter((entry) => ['uploaded', 'updated'].includes(entry.uploadStatus)).length} mirrored of {deliverables.length} declared)</summary>
          <ul>
            {deliverables.map((entry) => (
              <li key={entry.path}>
                <strong>{entry.title}</strong>
                <span className={`deliverable-class class-${entry.classification.replace(/_/g, '-')}`}>{humanize(entry.classification)}</span>
                {entry.driveUrl ? <a href={entry.driveUrl} target="_blank" rel="noreferrer">Open in Drive</a> : null}
                {entry.googleDocUrl ? <a href={entry.googleDocUrl} target="_blank" rel="noreferrer">Google Doc</a> : null}
                <small>{entry.uploadStatus}{entry.error ? ` — ${entry.error}` : ''}{entry.uploadedAt ? ` · ${formatDateTime(entry.uploadedAt)}` : ''}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {result ? (
        <details className="handoff-steps" open>
          <summary>What happened ({result.steps.length} steps)</summary>
          <ol>
            {result.steps.map((step) => (
              <li key={step.key} className={`step-${step.status}`}>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
          {result.completionManifestPath ? <small>Completion manifest: <code>{result.completionManifestPath}</code></small> : null}
        </details>
      ) : null}

      <div className="action-row">
        <button className="button" type="button" disabled={anyBusy} onClick={() => onFinalize(false)}>
          {busy ? 'Working…' : run ? 'Retry' : 'Finalise'}
        </button>
        <button className="button secondary" type="button" disabled={anyBusy} onClick={() => onFinalize(true)}>Dry run</button>
        {drive?.folderUrl ? <a className="button secondary" href={drive.folderUrl} target="_blank" rel="noreferrer">Open Drive folder</a> : null}
        {drive && !drive.connectionRequired && handoff.driveDeclared && drive.uploadedCount < drive.requiredCount ? (
          <button className="button secondary" type="button" disabled={anyBusy} onClick={() => onFinalize(false)}>Retry Drive upload</button>
        ) : null}
      </div>
    </article>
  );
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}
