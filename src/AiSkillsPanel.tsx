import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, Section, StatusChip, formatDateTime, humanize } from './components';

/**
 * Settings → AI Skills & Prompts.
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 * The model-facing intelligence — the instructions we send — is data, not code.
 * This page is where it becomes understandable and changeable without touching
 * the repository: read a revision, copy it, download it, upload an improved
 * draft, compare it against what is published, and publish it deliberately.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION
 * ----------------------------------
 * Nothing here can alter what the system ACCEPTS back from a model. The packet
 * contract, source coverage, anchor resolution, evidence verification, durable
 * identifier allocation, reconciliation legality, human review, human-event
 * precedence and deterministic replay are compiled in and unreachable from the
 * registry. Editing a prompt changes what we ask for; it never changes what
 * gets past the gate.
 */

type SkillStatus = 'draft' | 'candidate' | 'active' | 'retired';

type Benchmark = {
  id: string;
  benchmarkLabel: string;
  verdict: string;
  metrics: Record<string, unknown>;
  recordedBy: string;
  recordedAt: string;
  note: string | null;
};

type CatalogueVersion = {
  skillId: string;
  version: string;
  sha256: string;
  promptTemplateVersion: string;
  status: SkillStatus;
  source: string;
  notes: string | null;
  createdAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
  name: string;
  purpose: string | null;
  providerProfile: string | null;
  packetContractVersion: number;
  bodyPath: string | null;
  bodyCharacters: number | null;
  uploadedBy: string | null;
  recordedUses: number;
  lastUsedAt: string | null;
  latestBenchmark: Benchmark | null;
  benchmarkCount: number;
  pinnedProjects: Array<{ projectId: string; projectCode: string | null; projectName: string | null; pinnedBy: string; pinnedAt: string }>;
  bodyAvailable: boolean;
  bodyIssue: string | null;
};

type CatalogueEntry = {
  skillId: string;
  name: string;
  purpose: string | null;
  consumedBy: string | null;
  activeVersion: string | null;
  versions: CatalogueVersion[];
};

type RevisionBody = {
  skillId: string;
  version: string;
  status: SkillStatus;
  sha256: string;
  text: string;
  characters: number;
  editable: boolean;
  source: string;
  promptTemplateVersion: string;
  packetContractVersion: number;
  containsCustomerSource: false;
};

type AuditEntry = {
  id: string;
  skillId: string;
  version: string;
  projectId: string | null;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  note: string | null;
  occurredAt: string;
};

type RunSummary = { runId: string; kind: string; projectId: string | null; sourceId: string | null; providerId: string; modelLabel: string; status: string; startedAt: string };

type DiffLine = { kind: 'context' | 'added' | 'removed'; text: string };
type Comparison = {
  skillId: string;
  from: { version: string; status: string; sha256: string; promptTemplateVersion: string; characters: number };
  to: { version: string; status: string; sha256: string; promptTemplateVersion: string; characters: number };
  identical: boolean;
  addedLines: number;
  removedLines: number;
  promptTemplateChanged: boolean;
  packetContractChanged: boolean;
  diff: DiffLine[];
};

type DraftValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  frontMatter: { skillId: string; version: string; promptTemplateVersion: string; status: string; name: string; purpose: string | null; sha256: string; characters: number } | null;
};

const FIXED_SAFETY = [
  'Canonical packet contract and strict row schema',
  'Source window coverage and explicit category coverage',
  'Anchor resolution against stored segments',
  'Verbatim evidence verification and claim support',
  'Server-side durable identifier allocation',
  'Reconciliation legality and held conflicts',
  'Mandatory human review before any register change',
  'Human-event precedence over source assertions',
  'Deterministic replay from the frozen packet',
];

const EDITABLE_INTELLIGENCE = [
  'Extraction guidance and what to look for',
  'Worked examples',
  'Interpretation strategy and edge-case handling',
  'Terminology and register definitions',
  'Domain hints for this customer or sector',
  'Provider-specific advice and output shaping',
];

export function AiSkillsPanel() {
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError('');
      const [catalogueResponse, auditResponse] = await Promise.all([
        getJson<{ catalogue: CatalogueEntry[] }>('/api/extraction-skills'),
        getJson<{ events: AuditEntry[] }>('/api/extraction-skills/audit'),
      ]);
      setCatalogue(catalogueResponse.catalogue);
      setAudit(auditResponse.events);
      setSelectedSkillId((current) => current ?? catalogueResponse.catalogue[0]?.skillId ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The skill registry could not be read.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const selectedSkill = useMemo(() => catalogue?.find((entry) => entry.skillId === selectedSkillId) ?? null, [catalogue, selectedSkillId]);
  const selectedRevision = useMemo(() => {
    if (!selectedSkill) return null;
    return selectedSkill.versions.find((version) => version.version === selectedVersion)
      ?? selectedSkill.versions.find((version) => version.version === selectedSkill.activeVersion)
      ?? selectedSkill.versions.at(-1)
      ?? null;
  }, [selectedSkill, selectedVersion]);

  async function act(label: string, run: () => Promise<unknown>) {
    try {
      setBusy(true);
      setError('');
      setNotice('');
      await run();
      setNotice(label);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  if (error && !catalogue) return <Section id="ai-skills" title="AI Skills & Prompts" kicker="Model-facing intelligence" count={0}><p className="form-error" role="alert">{error}</p></Section>;
  if (!catalogue) return <Section id="ai-skills" title="AI Skills & Prompts" kicker="Model-facing intelligence" count={0}><p>Loading the skill registry</p></Section>;

  return (
    <Section id="ai-skills" title="AI Skills & Prompts" kicker="Model-facing intelligence, managed as data" count={catalogue.length}>
      <p className="section-description">
        These are the instructions the model receives. Publishing a revision changes what the system <strong>asks for</strong>.
        It can never change what the system <strong>accepts back</strong> — those rules are compiled into the application and are
        listed below.
      </p>
      {notice ? <p className="inline-note" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="skill-registry">
        <nav className="skill-list" aria-label="Registered skills">
          {catalogue.map((entry) => (
            <button
              key={entry.skillId}
              type="button"
              className={entry.skillId === selectedSkill?.skillId ? 'skill-list-item active' : 'skill-list-item'}
              onClick={() => { setSelectedSkillId(entry.skillId); setSelectedVersion(null); }}
            >
              <strong>{entry.name}</strong>
              <small>{entry.skillId}</small>
              <span>{entry.activeVersion ? `Published ${entry.activeVersion}` : 'No published version'}</span>
              <em>{entry.versions.length} version{entry.versions.length === 1 ? '' : 's'}</em>
            </button>
          ))}
        </nav>
        {selectedSkill ? (
          <SkillDetail
            skill={selectedSkill}
            revision={selectedRevision}
            busy={busy}
            onSelectVersion={setSelectedVersion}
            onAct={act}
            onReload={reload}
          />
        ) : <EmptyState>No skills are registered.</EmptyState>}
      </div>

      <div className="skill-contract-grid">
        <article>
          <h4>Editable model intelligence</h4>
          <p>Governed by the registry. Change these by publishing a new revision — no code change, no deployment.</p>
          <ul>{EDITABLE_INTELLIGENCE.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <article className="fixed-contract">
          <h4>Fixed application safety</h4>
          <p>Compiled in and unreachable from the registry. A revision cannot weaken, bypass or reinterpret any of these.</p>
          <ul>{FIXED_SAFETY.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
      </div>

      <details className="skill-audit">
        <summary>Registry audit trail ({audit.length})</summary>
        {audit.length === 0 ? <EmptyState>No lifecycle events have been recorded.</EmptyState> : (
          <div className="table-wrap dense-table">
            <table>
              <thead><tr><th>When</th><th>Skill</th><th>Version</th><th>Event</th><th>From</th><th>To</th><th>Actor</th><th>Note</th></tr></thead>
              <tbody>{audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.skillId}</td>
                  <td>{entry.version}</td>
                  <td><StatusChip value={entry.event === 'retired' ? 'watch' : 'verified'} label={humanize(entry.event)} /></td>
                  <td>{entry.fromStatus ?? '-'}</td>
                  <td>{entry.toStatus ?? '-'}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.note ?? '-'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </details>
    </Section>
  );
}

function SkillDetail({ skill, revision, busy, onSelectVersion, onAct, onReload }: {
  skill: CatalogueEntry;
  revision: CatalogueVersion | null;
  busy: boolean;
  onSelectVersion: (version: string) => void;
  onAct: (label: string, run: () => Promise<unknown>) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [body, setBody] = useState<RevisionBody | null>(null);
  const [bodyError, setBodyError] = useState('');
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [draftText, setDraftText] = useState('');
  const [draftValidation, setDraftValidation] = useState<DraftValidation | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [pinProjectId, setPinProjectId] = useState('');

  useEffect(() => {
    setBody(null);
    setBodyError('');
    setRuns(null);
    setComparison(null);
    if (!revision) return;
    const controller = new AbortController();
    getJson<RevisionBody>(`/api/extraction-skills/${encodeURIComponent(revision.skillId)}/versions/${encodeURIComponent(revision.version)}`, controller.signal)
      .then(setBody)
      .catch((caught: unknown) => { if (!controller.signal.aborted) setBodyError(caught instanceof Error ? caught.message : 'The revision text could not be read.'); });
    return () => controller.abort();
  }, [revision?.skillId, revision?.version]);

  useEffect(() => {
    setConfirmPublish(false);
    if (!revision || !skill.activeVersion) return;
    setCompareFrom(skill.activeVersion);
    setCompareTo(revision.version);
  }, [revision?.version, skill.activeVersion]);

  if (!revision) return <EmptyState>This skill has no registered versions.</EmptyState>;
  const isPublished = revision.status === 'active';
  const publishedVersion = skill.activeVersion;

  return (
    <div className="skill-detail">
      <header className="skill-detail-head">
        <div>
          <p className="section-kicker">{skill.skillId}</p>
          <h3>{skill.name}</h3>
          {skill.purpose ? <p>{skill.purpose}</p> : null}
          <p className="inline-note">
            {skill.consumedBy
              ? `In use: ${skill.consumedBy}`
              : 'Registered and versioned, but no code path resolves this skill yet — nothing sends it to a model.'}
          </p>
        </div>
        <label className="version-picker">
          <span className="field-label">Version</span>
          <select className="input" value={revision.version} onChange={(event) => onSelectVersion(event.target.value)}>
            {skill.versions.map((version) => (
              <option key={version.version} value={version.version}>
                {version.version} — {version.status}{version.version === publishedVersion ? ' (published)' : ''}
              </option>
            ))}
          </select>
        </label>
      </header>

      <dl className="inline-details skill-metadata">
        <div><dt>Status</dt><dd><StatusChip value={statusChip(revision.status)} label={humanize(revision.status)} /></dd></div>
        <div><dt>Skill ID</dt><dd>{revision.skillId}</dd></div>
        <div><dt>SHA-256</dt><dd className="hash">{revision.sha256}</dd></div>
        <div><dt>Prompt template</dt><dd>{revision.promptTemplateVersion}</dd></div>
        <div><dt>Packet contract</dt><dd>v{revision.packetContractVersion}</dd></div>
        <div><dt>Provider profile</dt><dd>{revision.providerProfile ?? 'Any provider honouring the packet contract'}</dd></div>
        <div><dt>Created</dt><dd>{formatDateTime(revision.createdAt)}</dd></div>
        <div><dt>Published</dt><dd>{revision.promotedAt ? formatDateTime(revision.promotedAt) : 'Never'}</dd></div>
        <div><dt>Retired</dt><dd>{revision.retiredAt ? formatDateTime(revision.retiredAt) : '-'}</dd></div>
        <div><dt>Recorded uses</dt><dd>{revision.recordedUses}{revision.lastUsedAt ? ` (last ${formatDateTime(revision.lastUsedAt)})` : ''}</dd></div>
        <div><dt>Origin</dt><dd>{revision.source}{revision.uploadedBy ? ` — uploaded by ${revision.uploadedBy}` : ''}</dd></div>
        <div><dt>Size</dt><dd>{revision.bodyCharacters ?? body?.characters ?? '-'} characters</dd></div>
      </dl>
      {revision.notes ? <p className="inline-note">{revision.notes}</p> : null}

      <h4>Latest benchmark</h4>
      {revision.latestBenchmark ? (
        <div className="benchmark-card">
          <div className="record-line">
            <div><p className="record-type">{formatDateTime(revision.latestBenchmark.recordedAt)} · recorded by {revision.latestBenchmark.recordedBy}</p><h5>{revision.latestBenchmark.benchmarkLabel}</h5></div>
            <StatusChip value={revision.latestBenchmark.verdict === 'pass' ? 'verified' : revision.latestBenchmark.verdict === 'fail' ? 'failed' : 'watch'} label={humanize(revision.latestBenchmark.verdict)} />
          </div>
          <dl className="inline-details">{Object.entries(revision.latestBenchmark.metrics).slice(0, 12).map(([key, value]) => (
            <div key={key}><dt>{humanize(key)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>
          ))}</dl>
          {revision.latestBenchmark.note ? <p className="inline-note">{revision.latestBenchmark.note}</p> : null}
          <small>{revision.benchmarkCount} recorded result{revision.benchmarkCount === 1 ? '' : 's'} for this version.</small>
        </div>
      ) : <EmptyState>This version has never been graded against a benchmark.</EmptyState>}

      <h4>Projects pinned to this version</h4>
      {revision.pinnedProjects.length === 0 ? <EmptyState>No project is pinned to this version; projects follow the published version.</EmptyState> : (
        <ul className="pin-list">{revision.pinnedProjects.map((pin) => (
          <li key={pin.projectId}>
            <strong>{pin.projectCode ?? pin.projectId}</strong> {pin.projectName ?? ''}
            <small>pinned by {pin.pinnedBy} on {formatDateTime(pin.pinnedAt)}</small>
            <button className="inline-button" disabled={busy} onClick={() => void onAct('Project pin removed.', () => postJson(`/api/projects/${encodeURIComponent(pin.projectId)}/extraction-skill/unpin`, { skillId: revision.skillId }))}>Remove pin</button>
          </li>
        ))}</ul>
      )}
      <div className="action-row">
        <label className="field-inline"><span className="field-label">Pin a project to {revision.version}</span><input className="input" value={pinProjectId} onChange={(event) => setPinProjectId(event.target.value)} placeholder="Project ID" /></label>
        <button className="button secondary" disabled={busy || !pinProjectId.trim()} onClick={() => void onAct(`Project pinned to ${revision.version}.`, () => postJson(`/api/projects/${encodeURIComponent(pinProjectId.trim())}/extraction-skill/pin`, { skillId: revision.skillId, version: revision.version }))}>Pin project</button>
      </div>

      <h4>Revision text</h4>
      {bodyError ? <p className="form-error" role="alert">{bodyError}</p> : null}
      {revision.bodyIssue ? <p className="form-error" role="alert">{revision.bodyIssue}</p> : null}
      {body ? (
        <>
          <p className="inline-note">
            This is the reusable template we send. It contains no customer source text — an assembled prompt, which does contain
            source windows, is never stored or served; only its SHA-256 is recorded against the run.
          </p>
          {body.editable
            ? <textarea className="input skill-body-editor" value={draftText || body.text} onChange={(event) => setDraftText(event.target.value)} rows={18} aria-label="Draft revision text" />
            : <pre className="skill-body">{body.text}</pre>}
          <div className="action-row">
            <button className="button secondary" disabled={busy} onClick={() => void navigator.clipboard?.writeText(body.text)}>Copy</button>
            <a className="button secondary" href={`/api/extraction-skills/${encodeURIComponent(body.skillId)}/versions/${encodeURIComponent(body.version)}/download`} download>Download</a>
            <button className="button secondary" disabled={busy} onClick={() => setDraftText(`${bumpFrontMatter(body.text, nextVersion(skill))}`)}>Create draft from this version</button>
            <button className="button secondary" disabled={busy || !runs === false} onClick={() => void getJson<{ runs: RunSummary[] }>(`/api/extraction-skills/${encodeURIComponent(body.skillId)}/versions/${encodeURIComponent(body.version)}/runs`).then((result) => setRuns(result.runs))}>Show runs that used this version</button>
          </div>
        </>
      ) : <p>Loading the revision text</p>}

      {runs ? (
        <details className="skill-runs" open>
          <summary>Runs that used {revision.version} ({runs.length})</summary>
          {runs.length === 0 ? <EmptyState>No run has used this version.</EmptyState> : (
            <div className="table-wrap dense-table">
              <table>
                <thead><tr><th>Run</th><th>Kind</th><th>Project</th><th>Source</th><th>Provider / model</th><th>Status</th><th>Started</th></tr></thead>
                <tbody>{runs.map((run) => (
                  <tr key={run.runId}><td className="hash">{run.runId}</td><td>{humanize(run.kind)}</td><td>{run.projectId ?? '-'}</td><td>{run.sourceId ?? '-'}</td><td>{run.providerId} / {run.modelLabel}</td><td><StatusChip value={run.status === 'completed' || run.status === 'complete' ? 'verified' : 'failed'} label={humanize(run.status)} /></td><td>{formatDateTime(run.startedAt)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </details>
      ) : null}

      <h4>Compare versions</h4>
      <div className="action-row">
        <label className="field-inline"><span className="field-label">From</span><select className="input" value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>{skill.versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select></label>
        <label className="field-inline"><span className="field-label">To</span><select className="input" value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>{skill.versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select></label>
        <button className="button secondary" disabled={busy || !compareFrom || !compareTo} onClick={() => void getJson<Comparison>(`/api/extraction-skills/compare?skillId=${encodeURIComponent(skill.skillId)}&from=${encodeURIComponent(compareFrom)}&to=${encodeURIComponent(compareTo)}`).then(setComparison)}>Compare</button>
      </div>
      {comparison ? <ComparisonView comparison={comparison} /> : null}

      <h4>Upload a new draft</h4>
      <p className="section-description">
        An upload always creates a new draft version. It can never overwrite a published version and never activates anything.
      </p>
      <input
        type="file"
        accept=".md,text/markdown"
        className="input"
        aria-label="Upload a Markdown skill revision"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void file.text().then((text) => { setDraftText(text); setDraftValidation(null); });
        }}
      />
      <textarea className="input skill-body-editor" value={draftText} onChange={(event) => { setDraftText(event.target.value); setDraftValidation(null); }} rows={10} placeholder="Or paste a Markdown revision with its --- front matter ---" aria-label="Draft revision to upload" />
      <div className="action-row">
        <button className="button secondary" disabled={busy || !draftText.trim()} onClick={() => void postJson<DraftValidation>('/api/extraction-skills/validate', { text: draftText, expectedSkillId: skill.skillId }).then(setDraftValidation)}>Validate draft</button>
        <button className="button" disabled={busy || !draftText.trim()} onClick={() => void onAct('Draft version created. It is not published; publish it deliberately below.', async () => { await postJson('/api/extraction-skills/drafts', { text: draftText, expectedSkillId: skill.skillId }); setDraftText(''); setDraftValidation(null); })}>Upload as draft</button>
      </div>
      {draftValidation ? (
        <div className={draftValidation.ok ? 'validation-report ok' : 'validation-report failed'} role="status">
          <StatusChip value={draftValidation.ok ? 'verified' : 'failed'} label={draftValidation.ok ? 'Draft is valid' : 'Draft rejected'} />
          {draftValidation.frontMatter ? <p>{draftValidation.frontMatter.skillId} {draftValidation.frontMatter.version} — {draftValidation.frontMatter.name}, prompt template {draftValidation.frontMatter.promptTemplateVersion}, {draftValidation.frontMatter.characters} characters.</p> : null}
          {draftValidation.errors.length ? <ul className="validation-errors">{draftValidation.errors.map((message) => <li key={message}>{message}</li>)}</ul> : null}
          {draftValidation.warnings.length ? <ul className="validation-warnings">{draftValidation.warnings.map((message) => <li key={message}>{message}</li>)}</ul> : null}
        </div>
      ) : null}

      <h4>Publish, roll back, retire</h4>
      {isPublished ? (
        <p className="inline-note">{revision.version} is the published version for {skill.skillId}. Publishing another version retires this one in the same transaction.</p>
      ) : (
        <div className="publish-panel">
          <p>
            Publishing changes the active-version pointer. It rewrites no history: {publishedVersion ?? 'no version'} stays registered
            and every past run keeps naming the version it actually used.
          </p>
          <dl className="inline-details">
            <div><dt>Currently published</dt><dd>{publishedVersion ?? 'None'}</dd></div>
            <div><dt>Candidate</dt><dd>{revision.version}</dd></div>
            <div><dt>Material text change</dt><dd>{comparison && comparison.from.version === publishedVersion && comparison.to.version === revision.version ? `${comparison.addedLines} line(s) added, ${comparison.removedLines} removed` : 'Run the comparison above to see it'}</dd></div>
            <div><dt>Latest benchmark</dt><dd>{revision.latestBenchmark ? `${revision.latestBenchmark.benchmarkLabel}: ${revision.latestBenchmark.verdict}` : 'Never graded'}</dd></div>
            <div><dt>Affected project pins</dt><dd>{revision.pinnedProjects.length === 0 ? 'None — pinned projects are unaffected by publication' : `${revision.pinnedProjects.length} project(s) already pinned here`}</dd></div>
            <div><dt>Rollback path</dt><dd>{publishedVersion ? `Roll back to ${publishedVersion} at any time` : 'No previously published version to roll back to'}</dd></div>
          </dl>
          <label className="confirm-row">
            <input type="checkbox" checked={confirmPublish} onChange={(event) => setConfirmPublish(event.target.checked)} />
            <span>I have read the difference and want {revision.version} to become the published revision for {skill.skillId}.</span>
          </label>
          <div className="action-row">
            <button className="button" disabled={busy || !confirmPublish || revision.status === 'retired'} onClick={() => void onAct(`${revision.version} published.`, () => postJson('/api/extraction-skills/promote', { skillId: revision.skillId, version: revision.version, note: 'Published from Settings → AI Skills & Prompts.' }))}>Approve and publish</button>
            <button className="button secondary" disabled={busy || !revision.promotedAt} onClick={() => void onAct(`Rolled back to ${revision.version}.`, () => postJson('/api/extraction-skills/rollback', { skillId: revision.skillId, toVersion: revision.version, note: 'Rolled back from Settings → AI Skills & Prompts.' }))}>Roll back to this version</button>
            <button className="button secondary" disabled={busy || revision.status === 'retired'} onClick={() => void onAct(`${revision.version} retired.`, () => postJson('/api/extraction-skills/retire', { skillId: revision.skillId, version: revision.version, note: 'Retired from Settings → AI Skills & Prompts.' }))}>Retire this version</button>
            <button className="button secondary" disabled={busy} onClick={() => void onReload()}>Refresh</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonView({ comparison }: { comparison: Comparison }) {
  return (
    <div className="skill-comparison">
      <div className="record-line">
        <div><p className="record-type">{comparison.from.version} → {comparison.to.version}</p><h5>{comparison.identical ? 'Identical bodies' : `${comparison.addedLines} added, ${comparison.removedLines} removed`}</h5></div>
        <StatusChip value={comparison.identical ? 'normal' : 'watch'} label={comparison.identical ? 'No text change' : 'Text changed'} />
      </div>
      {comparison.promptTemplateChanged ? <p className="form-error">The prompt template version changes between these revisions ({comparison.from.promptTemplateVersion} → {comparison.to.promptTemplateVersion}).</p> : null}
      {comparison.packetContractChanged ? <p className="form-error">The packet contract version differs between these revisions.</p> : null}
      <pre className="diff-view">{comparison.diff.map((line, index) => (
        <span key={`${index}:${line.text.slice(0, 12)}`} className={`diff-line diff-${line.kind}`}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}{line.text}{'\n'}</span>
      ))}</pre>
    </div>
  );
}

function statusChip(status: SkillStatus): string {
  if (status === 'active') return 'verified';
  if (status === 'retired') return 'normal';
  if (status === 'candidate') return 'watch';
  return 'pending';
}

function nextVersion(skill: CatalogueEntry): string {
  const versions = skill.versions.map((version) => version.version.split('.').map((part) => Number.parseInt(part, 10)));
  const highest = versions.sort((left, right) => (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2])).at(-1) ?? [1, 0, 0];
  return `${highest[0]}.${highest[1] + 1}.0`;
}

/**
 * Rewrite the front matter of a copied revision so the draft it produces is a
 * new version in draft status rather than a duplicate claiming to be published.
 */
function bumpFrontMatter(text: string, version: string): string {
  return text
    .replace(/^(\s*version:\s*).*$/m, `$1${version}`)
    .replace(/^(\s*status:\s*).*$/m, '$1draft')
    .replace(/^(\s*notes:\s*).*$/m, `$1Draft created from an earlier revision in Settings; describe the change before publishing.`);
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
