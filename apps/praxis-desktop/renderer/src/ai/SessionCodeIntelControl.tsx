import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { CodeIntelligenceResponse } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { useSettings } from '../settings/useSettings';
import { describeIndex, repositoryForFolder, type CodeIntelChipState } from '../app/CodeIntelTitlebarChip';
import './sessionCodeIntelControl.css';

export type CodeSearchMode = 'hybrid' | 'lexical' | 'vector';

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

/** Mirrors PANEL_WIDTH in sessionCodeIntelControl.css. */
const PANEL_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
/** Below this, opening above the chip would cover the composer itself. */
const MIN_SPACE_ABOVE = 180;

/**
 *
 * Closed chip matches the titlebar chip vocabulary and sibling composer chips:
 * icon, mode title ("Hybrid Intel", "Keyword Intel", "Semantic Intel"),
 * status pill ("Active", "Off"), and chevron.
 *
 * Open popover provides:
 * 1. Search mode switcher (Hybrid, Keyword, Semantic) that updates the chip and persists preference.
 * 2. Search input allowing searching directly from the chip, with live symbol matches.
 * 3. Engine capabilities breakdown (AST Symbol Graph, Semantic Vectors, and Caller / Callee Index).
 * 4. Cost-labelled maintenance actions (~30s re-index, destructive reset & rebuild).
 * 5. Scope toggles and advanced settings navigation.
 */
export function SessionCodeIntelControl({
  workingDirectory,
  provider,
  testId,
  disabled = false
}: SessionCodeIntelControlProps) {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [repo, setRepo] = useState<RepositoryItem | undefined>();
  const [status, setStatus] = useState<CodeIntelligenceResponse | undefined>();
  const [busy, setBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | undefined>();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');


  const codeIntelSettings = settings?.ai.codeIntelligence;
  const globalEnabled = codeIntelSettings?.enabled ?? true;
  const projectOverrides = codeIntelSettings?.projectOverrides ?? {};
  const projectSearchModes = codeIntelSettings?.projectSearchModes ?? {};

  const effectiveEnabled = workingDirectory
    ? (projectOverrides[workingDirectory] !== undefined ? projectOverrides[workingDirectory] : globalEnabled)
    : false;

  const folderName = workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) || workingDirectory;

  // The per-project switch only earns its place when it can change something.
  const hasOverride = workingDirectory ? projectOverrides[workingDirectory] !== undefined : false;
  const showProjectOverride = hasOverride || !globalEnabled;

  const refreshRepo = useCallback(async () => {
    if (!workingDirectory || !window.praxis?.ai?.codeIntelligence) {
      setRepo(undefined);
      setStatus(undefined);
      return;
    }
    try {
      const res = await window.praxis.ai.codeIntelligence({ action: 'list' });
      if (res && Array.isArray(res.data)) {
        const repos = (res.data as Array<Record<string, unknown>>).map(r => ({
          id: String(r.id),
          root: String(r.root),
          state: String(r.state ?? 'ready'),
          generation: Number(r.generation ?? 1)
        }));
        const found = (repositoryForFolder(repos, workingDirectory) ?? (repos.length === 1 ? repos[0] : undefined)) as RepositoryItem | undefined;
        if (found) {
          setRepo(found);
          const st = await window.praxis.ai.codeIntelligence({
            action: 'query',
            tool: 'get_index_status',
            arguments: { repositoryId: found.id, responseBudgetTokens: 8000 }
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

  // A folder change invalidates everything the panel is showing.
  useEffect(() => {
    setOpen(false);
    setPosition(undefined);
    setSearchQuery('');
  }, [workingDirectory]);

  // Measure before paint so the panel never renders at a stale or default spot.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const place = () => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceAbove = rect.top;
      const openAbove = spaceAbove >= MIN_SPACE_ABOVE || spaceAbove >= window.innerHeight - rect.bottom;
      const height = panelRef.current?.offsetHeight ?? 340;
      const gap = 6;
      const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
      const rawTop = openAbove ? rect.top - height - gap : rect.bottom + gap;
      const left = Math.min(
        Math.max(rect.left, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
      );
      setPosition({
        top: Math.min(Math.max(rawTop, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, maxTop)),
        left
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, workingDirectory, effectiveEnabled, repo?.state, status?.indexGeneration]);

  useEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        chipRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus search input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 60);
    } else {
      setSearchQuery('');
    }
  }, [open]);

  // Parse model and index details for capabilities breakdown
  const dataRecord = status?.data && typeof status.data === 'object' && !Array.isArray(status.data)
    ? (status.data as Record<string, unknown>)
    : {};
  const models = Array.isArray(dataRecord.models)
    ? (dataRecord.models as unknown[]).filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    : [];
  const activeModel = models.find(m => m.state === 'active');
  const buildingModel = models.find(m => m.state === 'building');
  const coverage = (activeModel?.coverage ?? buildingModel?.coverage) as Record<string, unknown> | undefined;
  const currentSymbols = Number(coverage?.current ?? 0);
  const eligibleSymbols = Number(coverage?.eligible ?? 0);
  const semanticPercent = eligibleSymbols > 0 ? Math.min(99, Math.floor((currentSymbols / eligibleSymbols) * 100)) : 0;
  const generation = status?.indexGeneration ?? repo?.generation;

  // Derive titlebar-unified state
  const titlebarState: CodeIntelChipState | undefined = repo
    ? describeIndex(repo, status)
    : undefined;

  // Search mode determination:
  // If user explicitly configured a mode for this project or globally, use that.
  // Otherwise default to hybrid if model active, or keyword if only keyword available.
  const configuredMode = workingDirectory ? projectSearchModes[workingDirectory] : undefined;
  const defaultMode: CodeSearchMode = (activeModel || titlebarState?.kind === 'hybrid')
    ? 'hybrid'
    : (titlebarState?.kind === 'keyword' ? 'lexical' : 'hybrid');
  const selectedMode: CodeSearchMode = configuredMode ?? defaultMode;

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

  const setMode = async (newMode: CodeSearchMode) => {
    if (!workingDirectory) return;
    await update({
      ai: {
        codeIntelligence: {
          projectSearchModes: {
            ...projectSearchModes,
            [workingDirectory]: newMode
          }
        }
      }
    });
  };

  const handleModeChange = async (newMode: CodeSearchMode) => {
    await setMode(newMode);
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

  const rebuildNow = async () => {
    if (!workingDirectory || !repo?.id) return;
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

  const openCodeSearch = (targetQuery?: string, targetMode?: CodeSearchMode) => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent('praxis:open-code-search', {
        detail: {
          workingDirectory,
          query: targetQuery !== undefined ? targetQuery : searchQuery,
          mode: targetMode ?? selectedMode
        }
      })
    );
  };

  const openAdvancedSettings = () => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent('praxis:open-settings', { detail: { category: 'code-intelligence' } })
    );
  };

  // Chip presentation
  type Tone = 'off' | 'folder' | 'indexing' | 'ready' | 'auto' | 'failed';
  let chipTone: Tone;
  let chipIcon: IconName;
  let chipLabel: string;
  let chipMeta: string | undefined;
  let chipMetaClass = '';
  let headingTitle: string;

  if (!workingDirectory) {
    chipTone = 'folder';
    chipIcon = 'sparkles';
    chipLabel = 'Code Intel';
    chipMeta = 'No folder';
    headingTitle = 'Code Intelligence';
  } else if (!effectiveEnabled) {
    chipTone = 'off';
    chipIcon = 'sparkles';
    chipLabel = 'Code Intel';
    chipMeta = 'Off';
    headingTitle = 'Code Intelligence (Off)';
  } else if (busy || repo?.state === 'indexing') {
    chipTone = 'indexing';
    chipIcon = 'refresh';
    chipLabel = 'Indexing…';
    chipMeta = 'Busy';
    headingTitle = 'Indexing in progress';
  } else if (titlebarState) {
    if (titlebarState.kind === 'failed') {
      chipTone = 'failed';
      chipIcon = 'warning';
      chipLabel = 'Index Failed';
      chipMeta = 'Failed';
      chipMetaClass = 'danger';
      headingTitle = 'Index Failed';
    } else if (titlebarState.kind === 'building') {
      chipTone = 'indexing';
      chipIcon = 'refresh';
      chipLabel = titlebarState.label;
      chipMeta = 'Busy';
      headingTitle = 'Building Semantic Index';
    } else {
      chipTone = 'ready';
      chipMeta = 'Active';
      chipMetaClass = 'ok';
      if (selectedMode === 'vector') {
        chipIcon = 'zap';
        chipLabel = 'Semantic Intel';
        headingTitle = 'Semantic Code Intelligence';
      } else if (selectedMode === 'lexical') {
        chipIcon = 'search';
        chipLabel = 'Keyword Intel';
        headingTitle = 'Keyword Code Intelligence';
      } else {
        chipIcon = 'sparkles';
        chipLabel = 'Hybrid Intel';
        headingTitle = 'Hybrid Code Intelligence';
      }
    }
  } else {
    chipTone = 'ready';
    chipMeta = 'Active';
    chipMetaClass = 'ok';
    if (selectedMode === 'vector') {
      chipIcon = 'zap';
      chipLabel = 'Semantic Intel';
      headingTitle = 'Semantic Code Intelligence';
    } else if (selectedMode === 'lexical') {
      chipIcon = 'search';
      chipLabel = 'Keyword Intel';
      headingTitle = 'Keyword Code Intelligence';
    } else {
      chipIcon = 'sparkles';
      chipLabel = 'Hybrid Intel';
      headingTitle = 'Hybrid Code Intelligence';
    }
  }

  const panel = (
    <div
      ref={panelRef}
      className="session-code-intel-panel"
      role="dialog"
      aria-label="Code intelligence"
      data-testid={`${testId}-code-intel-menu`}
      id={`${testId}-code-intel-panel`}
      style={{
        position: 'fixed',
        width: PANEL_WIDTH,
        visibility: position ? 'visible' : 'hidden',
        ...(position ? { top: position.top, left: position.left } : { top: 0, left: 0 })
      }}
    >
      {workingDirectory ? (
        <>
          {/* Header matching Design 4 */}
          <div className="session-code-intel-head">
            <strong className="session-code-intel-head-title">
              <span className="session-code-intel-dot" data-state={chipTone} aria-hidden="true" />
              <span>{headingTitle}</span>
            </strong>
            <span className="session-code-intel-repo-tag" title={workingDirectory}>
              {folderName}
            </span>
          </div>

          {/* Search section: mode switcher + search bar */}
          <div className="session-code-intel-search-section">
            <div className="session-code-intel-mode-selector" role="radiogroup" aria-label="Search mode">
              <button
                type="button"
                role="radio"
                aria-checked={selectedMode === 'hybrid'}
                className={`session-code-intel-mode-pill${selectedMode === 'hybrid' ? ' is-active' : ''}`}
                onClick={() => void handleModeChange('hybrid')}
                disabled={!effectiveEnabled || (!activeModel && !buildingModel)}
                title={!activeModel && !buildingModel ? 'Requires semantic model for hybrid search' : 'Hybrid: Keywords + semantic vectors'}
              >
                <Icon name="sparkles" size={11} />
                <span>Hybrid</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selectedMode === 'lexical'}
                className={`session-code-intel-mode-pill${selectedMode === 'lexical' ? ' is-active' : ''}`}
                onClick={() => void handleModeChange('lexical')}
                disabled={!effectiveEnabled}
                title="Keyword: Names and text matching only"
              >
                <Icon name="search" size={11} />
                <span>Keyword</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selectedMode === 'vector'}
                className={`session-code-intel-mode-pill${selectedMode === 'vector' ? ' is-active' : ''}`}
                onClick={() => void handleModeChange('vector')}
                disabled={!effectiveEnabled || (!activeModel && !buildingModel)}
                title={!activeModel && !buildingModel ? 'Requires semantic model in Settings → Code Intelligence' : 'Semantic: Meaning and concept matching'}
              >
                <Icon name="zap" size={11} />
                <span>Semantic</span>
              </button>
            </div>

            <form
              className="session-code-intel-search-form"
              onSubmit={e => {
                e.preventDefault();
                openCodeSearch(searchQuery, selectedMode);
              }}
            >
              <div className="session-code-intel-search-bar">
                <Icon name="search" size={13} className="session-code-intel-search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="session-code-intel-search-input"
                  data-testid={`${testId}-code-intel-search-input`}
                  placeholder="Search symbols, callers, code…"
                  value={searchQuery}
                  disabled={!effectiveEnabled}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="session-code-intel-search-clear"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="session-code-intel-search-btn"
                  data-testid={`${testId}-code-intel-search-btn`}
                  disabled={!effectiveEnabled}
                  title={searchQuery.trim() ? 'Search (Enter)' : 'Open Code Search (⌘⇧F)'}
                >
                  <span>Search</span>
                  <kbd>{searchQuery.trim() ? '↵' : '⌘⇧F'}</kbd>
                </button>
              </div>
            </form>
          </div>

          {/* Engine Capabilities Breakdown */}
          {effectiveEnabled && (
            <div className="session-code-intel-capabilities">
              <div className="session-code-intel-capability-row">
                <span className="session-code-intel-capability-name">
                  <Icon
                    name={repo && repo.state !== 'failed' ? 'check' : 'dot'}
                    size={13}
                    className={repo && repo.state !== 'failed' ? 'tone-green' : 'text-muted'}
                  />
                  <span>AST Symbol Graph</span>
                </span>
                <span className="session-code-intel-capability-meta">
                  {eligibleSymbols > 0 ? `${eligibleSymbols.toLocaleString()} symbols` : repo ? 'Active' : 'Not indexed'}
                </span>
              </div>

              <div className="session-code-intel-capability-row">
                <span className="session-code-intel-capability-name">
                  <Icon
                    name={activeModel ? 'check' : buildingModel ? 'refresh' : 'dot'}
                    size={13}
                    className={activeModel ? 'tone-green' : buildingModel ? 'tone-accent is-spinning' : 'text-muted'}
                  />
                  <span>Semantic Vectors</span>
                </span>
                <span className="session-code-intel-capability-meta">
                  {activeModel ? 'bge-small · 100%' : buildingModel ? `bge-small · ${semanticPercent}%` : 'Keyword only'}
                </span>
              </div>

              <div className="session-code-intel-capability-row">
                <span className="session-code-intel-capability-name">
                  <Icon
                    name={repo && repo.state !== 'failed' ? 'check' : 'dot'}
                    size={13}
                    className={repo && repo.state !== 'failed' ? 'tone-green' : 'text-muted'}
                  />
                  <span>Caller / Callee Index</span>
                </span>
                <span className="session-code-intel-capability-meta">
                  {generation ? `Gen ${generation}` : repo ? 'Ready' : 'Pending'}
                </span>
              </div>
            </div>
          )}

          {/* Action items with cost & consequence labels */}
          {effectiveEnabled && (
            <>
              <div className="session-code-intel-rule" />

              <button
                type="button"
                className="session-code-intel-opt"
                data-testid={`${testId}-code-intel-index-btn`}
                disabled={busy}
                onClick={() => void indexNow()}
              >
                <span className="session-code-intel-opt-icon">
                  <Icon name="refresh" size={13} className={busy ? 'is-spinning' : ''} />
                </span>
                <span className="session-code-intel-opt-body">
                  <strong>Re-index changes</strong>
                </span>
                <span className="session-code-intel-opt-meta">
                  {busy ? 'working…' : '~30s'}
                </span>
              </button>

              <button
                type="button"
                className="session-code-intel-opt"
                data-testid={`${testId}-code-intel-rebuild-btn`}
                disabled={busy}
                onClick={() => void rebuildNow()}
              >
                <span className="session-code-intel-opt-icon">
                  <Icon name="trash" size={13} />
                </span>
                <span className="session-code-intel-opt-body">
                  <strong>Reset &amp; rebuild</strong>
                </span>
                <span className="session-code-intel-opt-meta danger">
                  destructive
                </span>
              </button>
            </>
          )}

          <div className="session-code-intel-rule" />

          {/* Preferences */}
          <div className="session-code-intel-prefs">
            <div className="session-code-intel-pref">
              <span className="session-code-intel-pref-body">
                <strong>All projects</strong>
                <small>{folderName} · {provider ?? 'local'} · local only</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={globalEnabled}
                aria-label="Enable code intelligence by default for all projects"
                className="switch"
                data-testid={`${testId}-code-intel-global-toggle`}
                disabled={disabled}
                onClick={() => void toggleGlobal()}
              />
            </div>

            {showProjectOverride && (
              <div className="session-code-intel-pref">
                <span className="session-code-intel-pref-body">
                  <strong>This project</strong>
                  <small>{effectiveEnabled ? 'Overriding the default' : 'Off for this project'}</small>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={effectiveEnabled}
                  aria-label="Enable code intelligence for this project"
                  className="switch"
                  data-testid={`${testId}-code-intel-project-toggle`}
                  disabled={disabled}
                  onClick={() => void toggleProject()}
                />
              </div>
            )}
          </div>

          {/* Popover footer */}
          <div className="session-code-intel-footer">
            <span className="session-code-intel-footer-model">
              Mode: {selectedMode} · Model: {activeModel ? 'bge-small' : (provider ?? 'local')}
            </span>
            <button
              type="button"
              className="link-button session-code-intel-footer-link"
              onClick={openAdvancedSettings}
            >
              Advanced settings →
            </button>
          </div>

          {actionError && <div className="error-banner session-code-intel-error">{actionError}</div>}
        </>
      ) : (
        <p className="session-code-intel-empty">
          Connect a folder or select a board to use code intelligence.
        </p>
      )}
    </div>
  );

  return (
    <div className="session-code-intel" ref={rootRef}>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-code-intel-chip is-${chipTone}${open ? ' active' : ''}`}
        data-testid={`${testId}-code-intel-chip`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${testId}-code-intel-panel`}
        disabled={disabled}
        title={!workingDirectory ? 'Select or configure a working folder to enable code intelligence.' : 'Code Intelligence index and search settings'}
        onClick={() => {
          if (!open) void refreshRepo();
          setOpen(value => !value);
        }}
      >
        <Icon name={chipIcon} size={13} className={`session-code-intel-chip-icon${chipTone === 'indexing' ? ' is-spinning' : ''}`} />
        <span>{chipLabel}</span>
        {chipMeta && (
          <span className={`composer-chip-meta${chipMetaClass ? ` ${chipMetaClass}` : ''}`}>
            {chipMeta}
          </span>
        )}
        <Icon name="chevron-down" size={12} className="session-code-intel-chip-chevron" />
      </button>

      {open && createPortal(panel, document.body)}
    </div>
  );
}