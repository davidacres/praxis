import { useEffect, useState } from 'react';
import type {
  CodeIntelligenceOwnerStatus,
  CodeIntelligenceRequest,
  CodeIntelligenceResponse,
  McpServerConfig,
  SemanticModelStatus,
  SemanticModelProgressEvent,
  AppSettingsPatch
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { useDialogs } from '../ui/dialogs';
import './codeIntelligence.css';

type ObjectValue = Record<string, unknown>;
interface Repository {
  id: string;
  root: string;
  state: string;
  generation: number;
}

function record(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function CodeIntelligencePanel({
  servers,
  onServersChange,
  update
}: {
  providers?: Array<{ value: string; label: string }>;
  servers?: McpServerConfig[];
  onServersChange?: (servers: McpServerConfig[]) => Promise<void>;
  update?: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const { confirm, prompt } = useDialogs();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleanupResult, setCleanupResult] = useState('');
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<CodeIntelligenceResponse>();
  const [owner, setOwner] = useState<CodeIntelligenceOwnerStatus>();

  // Semantic model state
  const [modelStatus, setModelStatus] = useState<SemanticModelStatus>({
    installed: false,
    active: false
  });
  const [downloadProgress, setDownloadProgress] = useState<SemanticModelProgressEvent>();
  const [downloading, setDownloading] = useState(false);

  const selected = repositories.find(repository => repository.id === repositoryId);

  async function call(request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse> {
    if (!window.praxis?.ai?.codeIntelligence) {
      throw new Error('Code intelligence is unavailable.');
    }
    const result = await window.praxis.ai.codeIntelligence(request);
    if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result;
  }

  async function refresh(nextId?: string): Promise<void> {
    const result = await call({ action: 'list' });
    const list = items(result.data).map(value => {
      const r = record(value);
      return {
        id: String(r.id),
        root: String(r.root),
        state: String(r.state),
        generation: Number(r.generation)
      };
    });
    setRepositories(list);
    setRepositoryId(current => nextId || (list.some(r => r.id === current) ? current : list[0]?.id || ''));
  }

  // Never starts the service: a stopped service must stay visibly stopped.
  async function refreshOwner(): Promise<void> {
    setOwner(record((await call({ action: 'owner-status' })).data) as unknown as CodeIntelligenceOwnerStatus);
  }

  async function refreshModelStatus(): Promise<void> {
    if (window.praxis?.ai?.getSemanticModelStatus) {
      try {
        const ms = await window.praxis.ai.getSemanticModelStatus();
        setModelStatus(ms);
        if (ms.downloading) setDownloading(true);
      } catch {
        // Soft fail
      }
    }
  }

  async function work(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void work(async () => {
      await refresh();
      await refreshModelStatus();
      await refreshOwner();
    });

    if (window.praxis?.ai?.onSemanticModelProgress) {
      const unsubscribe = window.praxis.ai.onSemanticModelProgress(ev => {
        setDownloadProgress(ev);
        if (ev.percent < 100) {
          setDownloading(true);
        } else {
          setDownloading(false);
          void refreshModelStatus();
        }
      });
      return () => unsubscribe();
    }
  }, []);

  useEffect(() => {
    setStatus(undefined);
    if (repositoryId) {
      void work(async () => {
        setStatus(
          await call({
            action: 'query',
            tool: 'get_index_status',
            arguments: { repositoryId, responseBudgetTokens: 8000 }
          })
        );
      });
    }
  }, [repositoryId]);

  // Index, rebuild, relocation and vector work run in the background; poll so the
  // generation, coverage and queued-work line follow them instead of freezing.
  const ownerStopped = owner?.running === false;
  useEffect(() => {
    // An index status query starts the service on demand, which would undo Stop.
    if (!repositoryId || ownerStopped) return;
    let disposed = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (busy || inFlight) return;
      inFlight = true;
      void call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } })
        .then(next => { if (!disposed) setStatus(next); })
        .catch(() => { /* Explicit actions report errors; background polling keeps the last result. */ })
        .finally(() => { inFlight = false; });
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [repositoryId, busy, ownerStopped]);

  const handleDownloadModel = async () => {
    if (!window.praxis?.ai?.downloadSemanticModel) return;
    setDownloading(true);
    setError('');
    try {
      const res = await window.praxis.ai.downloadSemanticModel();
      setModelStatus(res);
      await refresh();
      if (repositoryId) {
        setStatus(
          await call({
            action: 'query',
            tool: 'get_index_status',
            arguments: { repositoryId, responseBudgetTokens: 8000 }
          })
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Model download failed.');
    } finally {
      setDownloading(false);
      setDownloadProgress(undefined);
    }
  };

  const handleDeleteModel = async () => {
    if (!window.praxis?.ai?.deleteSemanticModel) return;
    const ok = await confirm({
      title: 'Remove Semantic Search Model?',
      message: 'This removes the offline model files to free disk space (~130 MB). Code search will continue using standard keyword matching.',
      confirmLabel: 'Remove Model',
      danger: true
    });
    if (!ok) return;

    setBusy(true);
    try {
      await window.praxis.ai.deleteSemanticModel();
      await refreshModelStatus();
      if (repositoryId) {
        setStatus(
          await call({
            action: 'query',
            tool: 'get_index_status',
            arguments: { repositoryId, responseBudgetTokens: 8000 }
          })
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetFactory = async () => {
    const ok = await confirm({
      title: 'Reset Code Intelligence to Factory Defaults?',
      message:
        'This will clear all local index databases, unregister all repositories, delete the offline semantic search model, and restore default settings. Your source code files will not be touched.',
      confirmLabel: 'Reset to Factory Defaults',
      danger: true
    });
    if (!ok) return;

    setBusy(true);
    setError('');
    try {
      if (window.praxis?.ai?.resetCodeIntelligence) {
        await window.praxis.ai.resetCodeIntelligence();
      }
      localStorage.removeItem('praxis:semantic-search-prompt-dismissed');
      localStorage.removeItem('praxis:semantic-search-update-dismissed');
      setRepositoryId('');
      setStatus(undefined);
      setModelStatus({ installed: false, active: false });
      setRepositories([]);
      if (servers && onServersChange) {
        await onServersChange(
          servers.filter(
            server => !server.id.startsWith('praxis-code-intelligence-') && !server.env?.PRAXIS_CODE_INTELLIGENCE_PROVIDER
          )
        );
      }
      if (update) {
        await update({
          ai: {
            codeIntelligence: {
              enabled: false
            }
          }
        });
      }
      await refresh();
      await refreshModelStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset code intelligence.');
    } finally {
      setBusy(false);
    }
  };

  const contexts = items(record(status?.data).contexts);

  return (
    <div className="code-intelligence-panel" data-testid="code-intelligence-panel" aria-busy={busy}>
      {/* Semantic Search Card */}
      <div className="code-intelligence-card" data-testid="semantic-model-card">
        <div className="code-intelligence-card-header">
          <h5>
            <Icon name="sparkles" size={15} />
            <span>Semantic Search</span>
          </h5>
          <span
            className={`code-intelligence-status-badge${modelStatus.installed ? ' active' : ''}`}
            data-testid="semantic-model-badge"
          >
            {downloading
              ? 'Downloading…'
              : modelStatus.installed
              ? 'Semantic search active'
              : modelStatus.updateAvailable
              ? 'Model update required'
              : 'Standard keyword search active'}
          </span>
        </div>

        <p className="settings-hint" style={{ margin: 0 }}>
          Enhances code search with natural language semantic understanding using an offline local model running directly on your CPU. When inactive, search operates in standard keyword and symbol mode.
        </p>

        {downloading && (
          <div className="code-intelligence-progress-wrap" data-testid="semantic-model-progress">
            <div className="code-intelligence-progress-bar">
              <div
                className="code-intelligence-progress-fill"
                style={{ width: `${downloadProgress?.percent ?? 0}%` }}
              />
            </div>
            <div className="code-intelligence-meta">
              {downloadProgress
                ? `Downloading… ${downloadProgress.percent}% (${(downloadProgress.bytesDownloaded / 1024 / 1024).toFixed(1)} MB / ${(downloadProgress.totalBytes / 1024 / 1024).toFixed(1)} MB)`
                : 'Preparing download…'}
            </div>
          </div>
        )}

        <div className="code-intelligence-actions">
          {!modelStatus.installed ? (
            <button
              className="btn btn-sm btn-primary"
              type="button"
              data-testid="semantic-model-download-btn"
              disabled={busy || downloading}
              onClick={() => void handleDownloadModel()}
            >
              <Icon name="sparkles" size={13} />
              <span>
                {downloading
                  ? 'Downloading…'
                  : modelStatus.updateAvailable
                  ? 'Update Semantic Search Model (~130 MB)'
                  : 'Enable Semantic Search (~130 MB)'}
              </span>
            </button>
          ) : (
            <button
              className="btn btn-sm btn-secondary"
              type="button"
              data-testid="semantic-model-delete-btn"
              disabled={busy || downloading}
              onClick={() => void handleDeleteModel()}
            >
              <span>Delete Model</span>
            </button>
          )}
        </div>

        {modelStatus.installed && (
          <details className="code-intelligence-details" data-testid="semantic-model-advanced-details">
            <summary>Model details</summary>
            <div className="code-intelligence-advanced-body">
              <div className="code-intelligence-model-meta" data-testid="semantic-model-metadata">
                <div className="code-intelligence-model-meta-item">
                  <span className="label">Model ID</span>
                  <span className="value">{modelStatus.modelId}</span>
                </div>
                <div className="code-intelligence-model-meta-item">
                  <span className="label">Architecture</span>
                  <span className="value">{modelStatus.architecture}</span>
                </div>
                {modelStatus.fingerprint && (
                  <div className="code-intelligence-model-meta-item">
                    <span className="label">Model Fingerprint</span>
                    <span className="value">{modelStatus.fingerprint.slice(0, 16)}…</span>
                  </div>
                )}
                {modelStatus.sizeBytes !== undefined && (
                  <div className="code-intelligence-model-meta-item">
                    <span className="label">Disk Size</span>
                    <span className="value">{(modelStatus.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                )}
              </div>
            </div>
          </details>
        )}
      </div>

      {/* Service Card */}
      <div className="code-intelligence-card" data-testid="code-intel-service-card">
        <div className="code-intelligence-card-header">
          <h5>
            <Icon name="server" size={15} />
            <span>Service</span>
          </h5>
          <span
            className={`code-intelligence-status-badge${owner?.outdated ? ' warning' : owner?.running ? ' active' : ''}`}
            data-testid="code-intel-service-badge"
          >
            {!owner ? 'Checking…' : owner.outdated ? 'Outdated build' : owner.running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <p className="settings-hint" style={{ margin: 0 }} data-testid="code-intel-service-status">
          {!owner
            ? 'Checking the background service…'
            : owner.running
            ? `Process ${owner.processId ?? '?'} · started ${owner.startedUtc ? new Date(owner.startedUtc).toLocaleString() : 'unknown'} · build ${(owner.build ?? '').slice(0, 8)}${
                owner.outdated ? ` (this app's build is ${(owner.currentBuild ?? '').slice(0, 8)}; restart to use it)` : ' (current)'
              }`
            : 'Stopped. It starts again automatically the next time Praxis or an agent needs code intelligence.'}
        </p>
        <div className="code-intelligence-actions">
          {owner?.running === false ? (
            <button
              className="btn btn-sm"
              type="button"
              data-testid="code-intel-service-start-btn"
              disabled={busy}
              onClick={() => void work(async () => { setOwner(record((await call({ action: 'owner-start' })).data) as unknown as CodeIntelligenceOwnerStatus); await refresh(); })}
            >
              Start
            </button>
          ) : (
            <>
              <button
                className="btn btn-sm"
                type="button"
                data-testid="code-intel-service-restart-btn"
                disabled={busy || !owner}
                onClick={() => void work(async () => { setOwner(record((await call({ action: 'owner-restart' })).data) as unknown as CodeIntelligenceOwnerStatus); await refresh(); })}
              >
                Restart
              </button>
              <button
                className="btn btn-sm btn-secondary"
                type="button"
                data-testid="code-intel-service-stop-btn"
                disabled={busy || !owner}
                onClick={() => void work(async () => setOwner(record((await call({ action: 'owner-stop' })).data) as unknown as CodeIntelligenceOwnerStatus))}
              >
                Stop
              </button>
            </>
          )}
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="Refresh service status"
            disabled={busy}
            onClick={() => void work(() => refreshOwner())}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      {/* Indexed Repositories Card */}
      <div className="code-intelligence-card" data-testid="indexed-repos-card">
        <div className="code-intelligence-card-header">
          <h5>
            <Icon name="folder" size={15} />
            <span>Indexed Repositories</span>
          </h5>
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="Refresh repositories"
            title="Refresh repositories"
            onClick={() => void work(() => refresh())}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>

        <ChipSelect
          ariaLabel="Indexed repository"
          block
          value={repositoryId}
          disabled={busy || repositories.length === 0}
          options={repositories.map(repo => ({
            value: repo.id,
            label: repo.root.split('/').pop() || repo.root,
            meta: `${repo.root} (${repo.state})`
          }))}
          onChange={setRepositoryId}
          placeholder="No registered repositories"
        />

        {selected ? (
          <>
            <div className="code-intelligence-meta">
              <span>{selected.root}</span>
              <span> · </span>
              <strong>{selected.state}</strong>
              <span> · </span>
              <span>Generation {status?.indexGeneration ?? selected.generation}</span>
              <span> · </span>
              <span>{status?.freshness?.state || 'Coverage current'}</span>
            </div>

            {(Number(record(record(status?.data).jobsByState).pending) > 0 ||
              Number(record(record(status?.data).jobsByState).leased) > 0) && (
              <p className="settings-hint" role="status" style={{ margin: 0 }}>
                Background work: {String(record(record(status?.data).jobsByState).pending)} queued ·{' '}
                {String(record(record(status?.data).jobsByState).leased)} running
              </p>
            )}

            <div className="code-intelligence-actions">
              <button
                className="btn btn-sm"
                type="button"
                data-testid="code-intel-index-btn"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await call({ action: 'index', repositoryId });
                    await refresh();
                    setStatus(
                      await call({
                        action: 'query',
                        tool: 'get_index_status',
                        arguments: { repositoryId, responseBudgetTokens: 8000 }
                      })
                    );
                  })
                }
              >
                Index now
              </button>

              <button
                className="btn btn-sm"
                type="button"
                data-testid="code-intel-rebuild-btn"
                disabled={busy || selected.state === 'paused'}
                onClick={() =>
                  void work(async () => {
                    await call({ action: 'rebuild', repositoryId });
                    await refresh();
                    setStatus(
                      await call({
                        action: 'query',
                        tool: 'get_index_status',
                        arguments: { repositoryId, responseBudgetTokens: 8000 }
                      })
                    );
                  })
                }
              >
                Rebuild index
              </button>

              <button
                className="btn btn-sm"
                type="button"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await call({
                      action: selected.state === 'paused' ? 'resume' : 'pause',
                      repositoryId
                    });
                    await refresh();
                  })
                }
              >
                {selected.state === 'paused' ? 'Resume indexing' : 'Pause indexing'}
              </button>

              <button
                className="btn btn-sm"
                type="button"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const destination = await prompt({
                      title: 'Relocate repository',
                      label: 'New repository folder',
                      initialValue: selected.root,
                      message:
                        'This clears the old index. Source files are preserved.',
                      confirmLabel: 'Relocate repository',
                      validate: value =>
                        !value.trim()
                          ? 'Enter the new repository folder.'
                          : value.trim() === selected.root
                          ? 'Choose a different folder.'
                          : undefined
                    });
                    if (!destination) return;
                    await call({ action: 'relocate', repositoryId, root: destination.trim() });
                    setStatus(undefined);
                    await refresh(repositoryId);
                    if (servers && onServersChange) {
                      await onServersChange(
                        servers.filter(
                          server =>
                            !(
                              server.env?.PRAXIS_CODE_INTELLIGENCE_PROVIDER &&
                              server.args?.includes(repositoryId)
                            )
                        )
                      );
                    }
                  })
                }
              >
                Relocate
              </button>

              <button
                className="btn btn-sm btn-secondary"
                type="button"
                data-testid="code-intel-unregister-btn"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const ok = await confirm({
                      title: 'Unregister repository?',
                      message: 'This removes its search index. Source files are not affected.',
                      danger: true,
                      confirmLabel: 'Unregister'
                    });
                    if (!ok) return;
                    await call({ action: 'unregister', repositoryId });
                    await refresh();
                  })
                }
              >
                Unregister
              </button>
            </div>

            {contexts.length > 0 && (
              <details className="code-intelligence-contexts">
                <summary>
                  Projects:{' '}
                  {(['complete', 'partial', 'syntaxOnly'] as const)
                    .map(
                      resolution =>
                        [
                          resolution,
                          contexts.filter(val => record(val).resolution === resolution).length
                        ] as const
                    )
                    .filter(([, count]) => count > 0)
                    .map(
                      ([resolution, count]) =>
                        `${count} ${resolution === 'syntaxOnly' ? 'syntax-only' : resolution}`
                    )
                    .join(' · ')}
                </summary>
                <ul>
                  {contexts.map(val => {
                    const ctx = record(val);
                    return (
                      <li key={String(ctx.contextId)}>
                        {String(ctx.resolution)} · {String(ctx.state)} ·{' '}
                        {items(ctx.capabilities).map(String).join(', ')}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}

            {items(record(status?.data).diagnostics).length > 0 && (
              <details className="code-intelligence-details">
                <summary>Index diagnostics</summary>
                <pre>{JSON.stringify(record(status?.data).diagnostics, null, 2)}</pre>
              </details>
            )}
          </>
        ) : (
          <p className="settings-hint" style={{ margin: 0 }}>
            No repositories indexed yet. Repositories are automatically indexed when opened in projects or sessions.
          </p>
        )}
      </div>

      <div className="code-intelligence-card" data-testid="code-intel-cleanup-card">
        <div className="code-intelligence-card-header">
          <h5>
            <Icon name="trash" size={15} />
            <span>Worktree cleanup</span>
          </h5>
        </div>
        <p className="settings-hint" style={{ margin: 0 }}>
          Remove indexes for deleted Praxis worktrees. Existing folders and worktrees whose removal cannot be confirmed are kept. Cleanup also runs automatically when Praxis starts.
        </p>
        <div className="code-intelligence-actions">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            data-testid="code-intel-cleanup-btn"
            disabled={busy}
            onClick={() => void work(async () => {
              const ok = await confirm({
                title: 'Clean up worktree indexes?',
                message: 'This unregisters search indexes for confirmed deleted Praxis worktrees. Source files and indexes for existing folders are preserved.',
                danger: true,
                confirmLabel: 'Run cleanup'
              });
              if (!ok) return;
              setCleanupResult('');
              setCleanupWarnings([]);
              const result = await call({ action: 'cleanup' });
              const count = Number(record(result.data).removedCount);
              setCleanupResult(count === 0 ? 'No obsolete worktree indexes found.' : `Removed ${count} obsolete worktree ${count === 1 ? 'index' : 'indexes'}.`);
              setCleanupWarnings((result.warnings ?? []).map(warning => warning.message));
              await refresh();
            })}
          >
            Run cleanup
          </button>
        </div>
        {cleanupResult && <p className="settings-hint" role="status" data-testid="code-intel-cleanup-result" style={{ margin: 0 }}>{cleanupResult}</p>}
        {cleanupWarnings.length > 0 && (
          <details className="code-intelligence-details">
            <summary>Some indexes could not be checked or removed ({cleanupWarnings.length})</summary>
            <ul>{cleanupWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </details>
        )}
      </div>

      {/* Factory Reset Card */}
      <div className="code-intelligence-card" data-testid="code-intel-reset-card">
        <div className="code-intelligence-card-header">
          <h5>
            <Icon name="trash" size={15} />
            <span>Factory Reset</span>
          </h5>
        </div>

        <p className="settings-hint" style={{ margin: 0 }}>
          Reset code intelligence back to its initial factory state. This clears all local index databases, unregisters all repositories, deletes the downloaded offline semantic search model, and restores default code intelligence settings. Source code files on disk are never modified.
        </p>

        <div className="code-intelligence-actions" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            data-testid="code-intel-reset-factory-btn"
            disabled={busy || downloading}
            onClick={handleResetFactory}
          >
            Reset to factory defaults
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {busy && <p className="settings-hint">Working…</p>}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
