import { useEffect, useState } from 'react';
import { useApi } from './api';
import { ErrorState, LoadingState, PageIntro, Section, StatusChip } from './components';

type StorageSettings = { projectsRoot: string | null; projectFolderNamingFormat: string; exists: boolean; writable: boolean; configured: boolean; verifiedAt: string | null; lastWriteTestAt: string | null; message?: string; writeTest?: boolean };

export function SettingsPage() {
  return (
    <div className="page-stack">
      <PageIntro eyebrow="Cockpit settings" title="Settings" description="Manage local-only Project ManagAIr configuration outside Git." />
      <StorageSettingsPanel />
    </div>
  );
}

function StorageSettingsPanel() {
  const state = useApi<StorageSettings>('/api/project-storage/settings');
  const [projectsRoot, setProjectsRoot] = useState('');
  const [naming, setNaming] = useState('{code} - {name}');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedSettings, setSavedSettings] = useState<StorageSettings | null>(null);

  useEffect(() => {
    if (state.status !== 'success' || savedSettings) return;
    setProjectsRoot(state.data.projectsRoot ?? '');
    setNaming(state.data.projectFolderNamingFormat);
  }, [savedSettings, state]);

  if (state.status === 'loading') return <div className="panel settings-panel">Loading storage settings</div>;
  if (state.status === 'error') return <ErrorState message={state.error} />;
  const settings = savedSettings ?? state.data;

  async function save() {
    setBusy(true);
    const result = await postJson<StorageSettings>('/api/project-storage/settings', 'POST', { projectsRoot, projectFolderNamingFormat: naming });
    setSavedSettings(result);
    setMessage(result.projectsRoot ? 'Local project storage configuration saved outside Git.' : 'Storage root cleared.');
    setBusy(false);
  }

  async function verify(writeTest = false) {
    setBusy(true);
    const result = await postJson<StorageSettings>('/api/project-storage/verify', 'POST', { writeTest });
    setSavedSettings(result);
    setMessage(result.message ?? (result.writable ? 'Path verified.' : 'Path is not writable.'));
    setBusy(false);
  }

  return (
    <Section id="project-storage" title="Project Storage Root" kicker="Local OneDrive configuration" count={settings.configured ? 1 : 0}>
      <div className="settings-status-row"><StatusChip value={settings.writable ? 'verified' : settings.configured ? 'watch' : 'pending'} label={settings.writable ? 'Writable' : settings.configured ? 'Needs check' : 'Not set'} /><span>{settings.lastWriteTestAt ? 'Write/read/delete test recorded' : 'No write test recorded'}</span></div>
      <div className="form-grid two">
        <label><span className="field-label">Projects root</span><input className="input" value={projectsRoot} onChange={(event) => setProjectsRoot(event.target.value)} placeholder="Enter local synced projects root" /></label>
        <label><span className="field-label">Folder naming</span><input className="input" value={naming} onChange={(event) => setNaming(event.target.value)} /></label>
      </div>
      <p className="section-description">The local JSON file is ignored by Git. Reports and screenshots should use relative project folders rather than the full configured path.</p>
      <div className="action-row"><button className="button" onClick={save} disabled={busy}>Save</button><button className="button secondary" onClick={() => verify(false)} disabled={busy || !settings.configured}>Verify path</button><button className="button secondary" onClick={() => verify(true)} disabled={busy || !settings.configured}>Write test</button></div>
      {message ? <p className="inline-note">{message}</p> : null}
    </Section>
  );
}

async function postJson<T>(url: string, method: 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
  return data as T;
}
