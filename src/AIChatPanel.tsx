import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, PageIntro, Section, StatusChip } from './components';

export type AIContextOption = {
  contextType: 'current-day-calendar' | 'selected-event' | 'selected-email' | 'selected-project' | 'project-record';
  contextId: string;
  label: string;
  preview?: string;
};

type Provider = { id: string; label: string; available: boolean; detail: string; executablePath: string | null };

type ChatResponse = { sessionId: string; response: string; provider: Provider; contextSent: AIContextOption[] };

const defaultPrompts = [
  'summarise selected email',
  'identify required action',
  'draft a reply without sending',
  'summarise today',
  'identify schedule conflicts',
  'answer using selected Project ManagAIr context',
];

export function AIChatPanel({ contextOptions }: { contextOptions: AIContextOption[] }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="chat-tab" onClick={() => setOpen(true)}>AI Chat</button>;
  return (
    <aside className="chat-panel" aria-label="AI chat panel">
      <div className="chat-panel-head"><strong>AI Chat</strong><button className="button secondary" onClick={() => setOpen(false)}>Collapse</button></div>
      <AIChatComposer contextOptions={contextOptions} compact />
    </aside>
  );
}

export function AIChatPage() {
  return (
    <div className="page-stack">
      <PageIntro eyebrow="AI Chat" title="Grounded assistant" description="Provider-neutral chat that sends only the context records you explicitly select." />
      <AIChatComposer contextOptions={[]} />
    </div>
  );
}

function AIChatComposer({ contextOptions, compact = false }: { contextOptions: AIContextOption[]; compact?: boolean }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState(defaultPrompts[0]);
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/ai/providers').then((r) => r.json()).then((body: { providers: Provider[] }) => setProviders(body.providers)).catch(() => setProviders([]));
  }, []);

  const selectedOptions = contextOptions.filter((option) => selected.has(contextKey(option)));
  const send = async () => {
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      const result = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ prompt, contextRefs: selectedOptions }) });
      if (!result.ok) throw new Error((await result.json()).error ?? 'AI chat failed');
      setResponse(await result.json() as ChatResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI chat failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="ai-chat" title="AI Chat" kicker="Explicit context only" count={selectedOptions.length} className={compact ? 'compact-chat' : ''}>
      <div className="provider-row">
        {providers.length === 0 ? <StatusChip value="failed" label="No provider probe yet" /> : providers.map((provider) => <StatusChip key={provider.id} value={provider.available ? 'verified' : 'failed'} label={`${provider.label}: ${provider.available ? 'available' : 'unavailable'}`} />)}
      </div>
      <label className="field-label">Prompt</label>
      <select className="input" value={prompt} onChange={(event) => setPrompt(event.target.value)}>
        {defaultPrompts.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <textarea className="input textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <div className="context-box">
        <strong>Context that will be sent</strong>
        {contextOptions.length === 0 ? <EmptyState>No context records are available on this route. Open Today, Inbox, or a Project page to select records.</EmptyState> : contextOptions.map((option) => (
          <label key={contextKey(option)} className="context-option">
            <input type="checkbox" checked={selected.has(contextKey(option))} onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(contextKey(option)); else next.delete(contextKey(option));
              setSelected(next);
            }} />
            <span><b>{option.label}</b><small>{option.contextType} - {option.preview ?? 'No preview'}</small></span>
          </label>
        ))}
      </div>
      <button className="button" disabled={busy || selectedOptions.length === 0} onClick={() => void send()}>{busy ? 'Sending' : 'Send to selected provider'}</button>
      {error ? <ErrorState message={error} /> : null}
      {response ? <div className="chat-response"><strong>{response.provider.label}</strong><p>{response.response}</p><small>Sent {response.contextSent.length} selected context record(s).</small></div> : null}
    </Section>
  );
}

function contextKey(option: AIContextOption): string {
  return `${option.contextType}:${option.contextId}`;
}
