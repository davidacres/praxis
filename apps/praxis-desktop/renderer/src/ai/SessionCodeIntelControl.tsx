import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { CodeIntelligenceRequest, CodeIntelligenceResponse } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useSettings } from '../settings/useSettings';
import './sessionCodeIntelControl.css';

interface SessionCodeIntelControlProps {
  workingDirectory?: string;
  provider?: string;
  testId: string;
  disabled?: boolean;
}

interface RepositoryItem {
  id: string;
  root: string;
  state: string;
  generation: number;
}

export function SessionCodeIntelControl({
  workingDirectory,
  provider,
  testId,
  disabled = false
}: SessionCodeIntelControlProps) {
  const { settings, update } = useSettings();
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number }>();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [repo, setRepo] = useState<RepositoryItem | undefined>();
  const [status, setStatus] = useState<CodeIntelligenceResponse | undefined>();
  const [busy, setBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | undefined>();

  const codeIntelSettings = settings?.ai.codeIntelligence;
  const globalEnabled = codeIntelSettings?.enabled ?? true;
  const projectOverrides = codeIntelSettings?.projectOverrides ?? {};

  const effectiveEnabled = workingDirectory
    ? (projectOverrides[workingDirectory] !== undefined ? projectOverrides[workingDirectory] : globalEnabled)
    : false;

  const refreshRepo = useCallback(async () => {
    if (!workingDirectory || !window.praxis?.ai?.codeIntelligence) {
      setRepo(undefined);
      setStatus(undefined);
      return;
    }
    try {
      const res = await window.praxis.ai.codeIntelligence({ action: 'list' });
      if (res && Array.isArray(res.data)) {
        const normalizedWd = workingDirectory.replace(/[\\/]+$/, '');
        const found = (res.data as Array<Record<string, unknown>>).find(r => {
          const rootStr = typeof r.root === 'string' ? r.root.replace(/[\\/]+$/, '') : '';
          return rootStr === normalizedWd;
        });
        if (found) {
          const repoItem: RepositoryItem = {
            id: String(found.id),
            root: String(found.root),
            state: String(found.state ?? 'ready'),
            generation: Number(found.generation ?? 1)
          };
          setRepo(repoItem);
          const st = await window.praxis.ai.codeIntelligence({
            action: 'query',
            tool: 'get_index_status',
            arguments: { repositoryId: repoItem.id, responseBudgetTokens: 8000 }
          });
          setStatus(st);
          return;
        }
      }
      setRepo(undefined);
      setStatus(undefined);
    } catch {
      setRepo(undefined);
      setStatus(undefined);
    }
  }, [workingDirectory]);

  useEffect(() => {
    void refreshRepo();
  }, [refreshRepo]);

  useEffect(() => {
    if (!menuPosition) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setMenuPosition(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [menuPosition]);

  const toggleProject = async () => {
    if (!workingDirectory) return;
    const next = !effectiveEnabled;
    await update({
      ai: {
        codeIntelligence: {
          projectOverrides: {
            ...projectOverrides,
            [workingDirectory]: next
          }
        }
      }
    });
  };

  const toggleGlobal = async () => {
    await update({
      ai: {
        codeIntelligence: {
          enabled: !globalEnabled
        }
      }
    });
  };

  const indexNow = async () => {
    if (!workingDirectory) return;
    setBusy(true);
    setActionError(undefined);
    try {
      if (repo?.id) {
        await window.praxis.ai.codeIntelligence({ action: 'index', repositoryId: repo.id });
      } else {
        const reg = await window.praxis.ai.codeIntelligence({ action: 'register', root: workingDirectory });
        const newId = (reg.data as Record<string, unknown>)?.repositoryId;
        if (typeof newId === 'string') {
          await window.praxis.ai.codeIntelligence({ action: 'index', repositoryId: newId });
        }
      }
      await refreshRepo();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rebuildIndex = async () => {
    if (!repo?.id) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await window.praxis.ai.codeIntelligence({ action: 'rebuild', repositoryId: repo.id });
      await refreshRepo();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Determine chip label
  let chipLabel = 'Code Intel: Off';
  let chipTone = '';
  if (!workingDirectory) {
    chipLabel = 'Code Intel: No folder';
  } else if (!effectiveEnabled) {
    chipLabel = 'Code Intel: Off';
  } else if (busy || repo?.state === 'indexing') {
    chipLabel = 'Code Intel: Indexing…';
    chipTone = ' is-indexing';
  } else if (repo) {
    const gen = status?.indexGeneration ?? repo.generation;
    chipLabel = `Code Intel: Ready (Gen ${gen})`;
    chipTone = ' is-ready';
  } else {
    chipLabel = 'Code Intel: Auto';
    chipTone = ' is-auto';
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-code-intel-chip${menuPosition ? ' active' : ''}${chipTone}`}
        data-testid={`${testId}-code-intel-chip`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(menuPosition)}
        disabled={disabled}
        title={!workingDirectory ? 'Select or configure a working folder to enable code intelligence.' : 'Code Intelligence index and search settings'}
        onClick={() => {
          if (menuPosition) {
            setMenuPosition(undefined);
            return;
          }
          const rect = chipRef.current?.getBoundingClientRect();
          if (rect) setMenuPosition({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
        }}
      >
        <Icon name="sparkles" size={14} />
        <span>{chipLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className="composer-provider-menu session-code-intel-menu"
            role="dialog"
            aria-label="Code intelligence"
            data-testid={`${testId}-code-intel-menu`}
            style={{ position: 'fixed', bottom: menuPosition.bottom, left: menuPosition.left }}
          >
            <div className="session-code-intel-header">
              <Icon name="sparkles" size={16} />
              <div>
                <strong>Code Intelligence</strong>
                <span className="session-code-intel-sub">Local semantic &amp; keyword code indexing</span>
              </div>
            </div>

            {workingDirectory ? (
              <div className="session-code-intel-body">
                <div className="session-code-intel-toggle-row">
                  <div>
                    <span className="session-code-intel-label">Enable for this project</span>
                    <span className="session-code-intel-path" title={workingDirectory}>
                      {workingDirectory}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm ${effectiveEnabled ? 'btn-primary' : 'btn-secondary'}`}
                    data-testid={`${testId}-code-intel-project-toggle`}
                    onClick={() => void toggleProject()}
                  >
                    {effectiveEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>

                {effectiveEnabled && (
                  <div className="session-code-intel-status-box">
                    <div className="session-code-intel-meta-line">
                      <span>Status:</span>
                      <strong>{busy ? 'Working…' : repo ? repo.state : 'Ready to index'}</strong>
                    </div>
                    {repo && (
                      <div className="session-code-intel-meta-line">
                        <span>Generation:</span>
                        <span>{status?.indexGeneration ?? repo.generation}</span>
                      </div>
                    )}
                    {provider && (
                      <div className="session-code-intel-meta-line">
                        <span>Active provider:</span>
                        <span>{provider} (auto-granted)</span>
                      </div>
                    )}

                    <div className="session-code-intel-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`${testId}-code-intel-index-btn`}
                        disabled={busy}
                        onClick={() => void indexNow()}
                      >
                        {repo ? 'Index now' : 'Index folder now'}
                      </button>
                      {repo && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          data-testid={`${testId}-code-intel-rebuild-btn`}
                          disabled={busy || repo.state === 'paused'}
                          onClick={() => void rebuildIndex()}
                        >
                          Rebuild index
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`${testId}-code-intel-search-btn`}
                        onClick={() => {
                          setMenuPosition(undefined);
                          window.dispatchEvent(
                            new CustomEvent('praxis:open-code-search', {
                              detail: { workingDirectory }
                            })
                          );
                        }}
                      >
                        Search symbols (⌘⇧F)
                      </button>
                    </div>
                  </div>
                )}

                {actionError && <div className="error-banner session-code-intel-error">{actionError}</div>}
              </div>
            ) : (
              <div className="session-code-intel-body">
                <p className="settings-hint">
                  No working folder is set for this session. Connect a folder or select a board to use code intelligence.
                </p>
              </div>
            )}

            <div className="session-code-intel-footer">
              <label className="session-code-intel-global-toggle">
                <input
                  type="checkbox"
                  data-testid={`${testId}-code-intel-global-toggle`}
                  checked={globalEnabled}
                  onChange={() => void toggleGlobal()}
                />
                <span>Enable by default across all projects</span>
              </label>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
