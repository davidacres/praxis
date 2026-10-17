import { useEffect, useState } from 'react';
import type {
  CodeIntelligenceRequest,
  CodeIntelligenceResponse,
  McpServerConfig,
  SemanticModelStatus,
  SemanticModelProgressEvent
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
  onServersChange
}: {
  providers?: Array<{ value: string; label: string }>;
  servers?: McpServerConfig[];
  onServersChange?: (servers: McpServerConfig[]) => Promise<void>;
}) {
  const { confirm, prompt } = useDialogs();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<CodeIntelligenceResponse>();

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
      message: 'This removes the offline model files to free disk space (~90 MB). Code search will continue using standard keyword matching.',
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
              <span>{downloading ? 'Downloading…' : 'Enable Semantic Search (~90 MB)'}</span>
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
