import { useEffect, useState } from 'react';
import type { CodeIntelligenceRequest, CodeIntelligenceResponse, McpServerConfig } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { useDialogs } from '../ui/dialogs';
import './codeIntelligence.css';

type ObjectValue = Record<string, unknown>;
interface Repository { id: string; root: string; state: string; generation: number }
function record(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function items(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export function CodeIntelligencePanel({ providers, servers, onServersChange }: {
  providers: Array<{ value: string; label: string }>;
  servers: McpServerConfig[];
  onServersChange: (servers: McpServerConfig[]) => Promise<void>;
}) {
  const { confirm } = useDialogs();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [root, setRoot] = useState(''); const [manifest, setManifest] = useState(''); const [excludes, setExcludes] = useState('');
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState('');
  const [bundle, setBundle] = useState(''); const [fingerprint, setFingerprint] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [response, setResponse] = useState<CodeIntelligenceResponse>(); const [status, setStatus] = useState<CodeIntelligenceResponse>();
  const selected = repositories.find(repository => repository.id === repositoryId);
  async function call(request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse> {
    const result = await window.praxis.ai.codeIntelligence(request);
    if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result;
  }
  async function refresh(nextId?: string): Promise<void> {
    const result = await call({ action: 'list' });
    const list = items(result.data).map(value => { const r = record(value); return { id: String(r.id), root: String(r.root), state: String(r.state), generation: Number(r.generation) }; });
    setRepositories(list); setRepositoryId(current => nextId || (list.some(r => r.id === current) ? current : list[0]?.id || ''));
  }
  async function work(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Code intelligence is unavailable.'); } finally { setBusy(false); }
  }
  useEffect(() => { void work(() => refresh()); }, []);
  useEffect(() => {
    setResponse(undefined); setStatus(undefined);
    if (repositoryId) void work(async () => setStatus(await call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } })));
  }, [repositoryId]);
  useEffect(() => {
    if (!repositoryId) return;
    let disposed = false; let inFlight = false;
    const timer = window.setInterval(() => {
      if (busy || inFlight) return;
      inFlight = true;
      void call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } })
        .then(next => { if (!disposed) setStatus(next); })
        .catch(() => { /* Explicit actions report errors; background status polling preserves the last result. */ })
        .finally(() => { inFlight = false; });
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [repositoryId, busy]);
  async function runTool(tool: string, arguments_: ObjectValue): Promise<void> {
    setResponse(await call({ action: 'query', tool, arguments: { ...arguments_, repositoryId, responseBudgetTokens: 8000 } }));
  }
  const matches = items(record(response?.data).matches);
  const fragments = items(record(response?.data).fragments);
  const contexts = items(record(status?.data).contexts);
  return (
    <section className="code-intelligence-panel" data-testid="code-intelligence-panel" aria-busy={busy}>
      <h4 className="settings-subsection-title">Code intelligence</h4>
      <p className="settings-hint">Index C# locally for source search and static navigation. Registration never builds projects, restores packages, or downloads models.</p>
      <fieldset disabled={busy}>
        <legend>Register a repository</legend>
        <label>Repository folder<input className="input" value={root} onChange={event => setRoot(event.target.value)} placeholder="Absolute repository path" /></label>
        <label>Passive context manifest (optional)<input className="input" value={manifest} onChange={event => setManifest(event.target.value)} placeholder="context.praxis.json" /></label>
        <label>Excluded folders<input className="input" value={excludes} onChange={event => setExcludes(event.target.value)} placeholder="private;secrets" /></label>
        <div className="code-intelligence-actions">
          <button className="btn" type="button" disabled={!root.trim()} onClick={() => void work(async () => {
            const result = await call({ action: 'register', root: root.trim(), ...(manifest.trim() ? { manifest: manifest.trim() } : {}), excludes: excludes.split(';').map(value => value.trim()).filter(Boolean) });
            await refresh(String(record(result.data).repositoryId));
          })}>Register repository</button>
          <button className="btn" type="button" onClick={() => void work(() => refresh())}>Refresh repositories</button>
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Local embedding model</legend>
        <p className="settings-hint">Install a provisioned MiniLM bundle. Its model and tokenizer checksums are verified locally.</p>
        <label>Model bundle folder<input className="input" value={bundle} onChange={event => setBundle(event.target.value)} /></label>
        <button className="btn" type="button" disabled={!bundle.trim()} onClick={() => void work(async () => {
          const result = await call({ action: 'model-install', bundle: bundle.trim() }); setFingerprint(String(record(result.data).fingerprint));
        })}>Install local model</button>
        <label>Model fingerprint<input className="input" value={fingerprint} onChange={event => setFingerprint(event.target.value)} placeholder="sha256:…" /></label>
        <button className="btn" type="button" disabled={!repositoryId || !fingerprint.startsWith('sha256:')} onClick={() => void work(async () => {
          await call({ action: 'model-activate', repositoryId, fingerprint }); setStatus(await call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } }));
        })}>Activate for this repository</button>
      </fieldset>
      <ChipSelect ariaLabel="Indexed repository" block value={repositoryId} disabled={busy || repositories.length === 0}
        options={repositories.map(repository => ({ value: repository.id, label: repository.root, meta: repository.state }))}
        onChange={setRepositoryId} placeholder="No registered repositories" />
      {selected && <>
        <p className="settings-hint">{selected.state} · Generation {selected.generation} · {status?.freshness?.state || 'Coverage unavailable'}</p>
        {(Number(record(record(status?.data).jobsByState).pending) > 0 || Number(record(record(status?.data).jobsByState).leased) > 0) &&
          <p className="settings-hint" role="status">Background work: {String(record(record(status?.data).jobsByState).pending)} queued · {String(record(record(status?.data).jobsByState).leased)} running</p>}
        {items(record(status?.data).models).map(value => { const model = record(value); const coverage = record(model.coverage); return <p className="settings-hint" key={String(model.fingerprint)}>
          Local model: {String(model.state)} · {String(coverage.current)}/{String(coverage.eligible)} current vectors
        </p>; })}
        <div className="code-intelligence-actions">
          <button className="btn" type="button" disabled={busy} onClick={() => void work(async () => {
            await call({ action: 'index', repositoryId }); await refresh(); setStatus(await call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } }));
          })}>Index now</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void work(async () => { await call({ action: selected.state === 'paused' ? 'resume' : 'pause', repositoryId }); await refresh(); })}>{selected.state === 'paused' ? 'Resume indexing' : 'Pause indexing'}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void work(async () => {
            if (!(await confirm({ title: 'Unregister repository?', message: 'This removes its index and provider grants. Source files are preserved.', danger: true, confirmLabel: 'Unregister' }))) return;
            await call({ action: 'unregister', repositoryId }); await refresh();
          })}>Unregister</button>
        </div>
        {contexts.length > 0 && <ul className="code-intelligence-contexts">{contexts.map(value => { const context = record(value); return <li key={String(context.contextId)}>{String(context.resolution)} · {String(context.state)} · {items(context.capabilities).map(String).join(', ')}</li>; })}</ul>}
        {items(record(status?.data).diagnostics).length > 0 && <details><summary>Index diagnostics</summary><pre>{JSON.stringify(record(status?.data).diagnostics, null, 2)}</pre></details>}
        <form onSubmit={event => { event.preventDefault(); void work(() => runTool('search_code', { query, limit: 20, mode: 'hybrid' })); }}>
          <label>Search source<input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Symbol name or description" /></label>
          <button className="btn" type="submit" disabled={busy || !query.trim()}>Search code</button>
        </form>
        {response?.warnings?.map(warning => <p className="settings-hint" key={warning.code}>{warning.message}</p>)}
        {matches.map(value => {
          const match = record(value); const symbol = record(match.symbol); const symbolId = String(symbol.symbolId);
          return <article className="code-intelligence-match" key={symbolId}>
            <strong>{String(symbol.qualifiedName)}</strong><code>{String(symbol.signature)}</code>
            <span className="settings-hint">{String(symbol.resolution)}</span>
            <div className="code-intelligence-actions">
              {(['get_source', 'explain_symbol', 'get_callers', 'get_callees', 'trace_flow'] as const).map(tool => <button className="btn" type="button" disabled={busy} key={tool} onClick={() => void work(() => runTool(tool, { symbolId }))}>{({ get_source: 'Source', explain_symbol: 'Explain', get_callers: 'Callers', get_callees: 'Callees', trace_flow: 'Static trace' })[tool]}</button>)}
              <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(symbolId)}>Copy symbol ID</button>
            </div>
          </article>;
        })}
        {fragments.map((value, index) => { const fragment = record(value); return <article key={index}><p className="settings-hint">Hash verified: {String(fragment.currentHash)}</p><pre>{String(fragment.text)}</pre></article>; })}
        {response && matches.length === 0 && fragments.length === 0 && <pre className="code-intelligence-result">{JSON.stringify(response.data, null, 2)}</pre>}
        {items(response?.evidence).length > 0 && <details><summary>Source evidence</summary>{items(response?.evidence).map(value => { const evidence = record(value); return typeof evidence.fileId === 'string' && evidence.range ?
          <button className="btn" type="button" key={String(evidence.id)} disabled={busy} onClick={() => void work(() => runTool('get_source', { fileId: evidence.fileId, range: evidence.range, expectedContentHash: evidence.contentHash }))}>Read {String(evidence.path)}</button> : null; })}</details>}
        <fieldset disabled={busy}>
          <legend>Provider access</legend>
          <p className="settings-hint">Granting access lets the selected provider receive code and tool results. Local indexing needs no provider access.</p>
          <ChipSelect ariaLabel="Code intelligence provider" block value={provider} options={providers} onChange={setProvider} placeholder="Choose a destination provider" />
          <div className="code-intelligence-actions">
            <button className="btn" type="button" disabled={!provider} onClick={() => void work(async () => {
              if (!(await confirm({ title: 'Allow code access for this provider?', message: `Code from ${selected.root} may be sent to ${provider} when its agent uses the tools.`, confirmLabel: 'Allow provider access' }))) return;
              const result = await call({ action: 'connect', repositoryId, provider });
              if (result.mcpServer) await onServersChange([...servers.filter(server => server.id !== result.mcpServer!.id), result.mcpServer]);
            })}>Allow provider access</button>
            <button className="btn" type="button" disabled={!provider} onClick={() => void work(async () => {
              await call({ action: 'revoke', repositoryId, provider });
              await onServersChange(servers.filter(server => !(server.env?.PRAXIS_CODE_INTELLIGENCE_PROVIDER === provider && server.args?.includes(repositoryId))));
            })}>Revoke provider access</button>
          </div>
        </fieldset>
      </>}
      <div aria-live="polite">{busy && <p className="settings-hint">Working…</p>}{error && <p className="error-banner" role="alert">{error}</p>}</div>
    </section>
  );
}
