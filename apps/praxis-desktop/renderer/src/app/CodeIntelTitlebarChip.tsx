import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CodeIntelligenceResponse } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { useSettings } from '../settings/useSettings';
import '../ai/semanticSearchNotification.css';

// The title bar's code intelligence chip: which search the current project's folder has
// (Hybrid once its model is active, Keyword until then) and, while the index or the semantic
// vectors are still being built, how far that has got. Clicking opens code search. A folder
// with no index shows "Build index": clicking builds it, and on launch it asks once.
//
// The service exits after a few idle minutes and starts again on the next request, so the
// chip asks it once when it appears and afterwards only while it is running: polling while
// work is in progress, otherwise on window focus. It never wakes or holds an idle service.

const BUSY_POLL_MS = 3000;
/** "Not now" on the build prompt, per folder. */
export const INDEX_PROMPT_DISMISS_PREFIX = 'praxis:code-index-prompt-dismissed:';
/** Sent while the build prompt is open, so the semantic model notice waits its turn. */
export const INDEX_PROMPT_EVENT = 'praxis:code-index-prompt';
let indexPromptShowing = false;
/** Whether the build prompt is open now, for a notice that mounts after it opened. */
export const isIndexPromptOpen = () => indexPromptShowing;

const folderName = (folder: string) => trim(folder).split(/[\\/]/).pop() || folder;

/** The chip for a folder with no index: clicking builds one. */
export function unindexedState(folder: string): CodeIntelChipState {
  return { kind: 'unindexed', icon: 'zap', label: 'Build index', root: folder,
    title: `${folderName(folder)} has no code index. Click to build it for code search and your agents.` };
}

interface Repository { id: string; root: string; state: string }

export interface CodeIntelChipState {
  kind: 'unindexed' | 'indexing' | 'building' | 'hybrid' | 'keyword' | 'failed';
  icon: IconName;
  label: string;
  title: string;
  root: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const trim = (path: string) => path.replace(/[\\/]+$/, '');

/** The registered repository for a folder: the folder itself, one inside it, or one holding it. */
export function repositoryForFolder(repositories: Repository[], folder: string | undefined): Repository | undefined {
  if (!folder) return repositories.length === 1 ? repositories[0] : undefined;
  const target = trim(folder);
  const within = (path: string, parent: string) => path === parent || path.startsWith(parent + '/') || path.startsWith(parent + '\\');
  return repositories.find(repo => trim(repo.root) === target)
    ?? repositories.find(repo => within(trim(repo.root), target))
    ?? [...repositories].sort((a, b) => b.root.length - a.root.length).find(repo => within(target, trim(repo.root)));
}

/** What the chip says for a repository and its index status. */
export function describeIndex(repo: Repository, status: CodeIntelligenceResponse | undefined): CodeIntelChipState {
  const root = repo.root;
  if (repo.state === 'failed')
    return { kind: 'failed', icon: 'warning', label: 'Index failed', title: 'Code intelligence could not index this folder. Open Settings → Code Intelligence for details.', root };
  if (repo.state === 'pending' || repo.state === 'stale')
    return { kind: 'indexing', icon: 'refresh', label: 'Indexing…', title: 'Code intelligence is indexing this folder. Keyword search is available as files are indexed.', root };
  const models = Array.isArray(record(status?.data).models) ? (record(status?.data).models as unknown[]).map(record) : [];
  if (models.some(model => model.state === 'active'))
    return { kind: 'hybrid', icon: 'sparkles', label: 'Hybrid', title: 'Code search: keyword and semantic (hybrid). ⌘⇧F to search.', root };
  const building = models.find(model => model.state === 'building');
  if (building) {
    const coverage = record(building.coverage);
    const current = Number(coverage.current ?? 0), eligible = Number(coverage.eligible ?? 0);
    const percent = eligible > 0 ? Math.min(99, Math.floor(current / eligible * 100)) : 0;
    return {
      kind: 'building', icon: 'search', label: `Semantic ${percent}%`, root,
      title: `Code search: keyword only while the semantic index builds (${current.toLocaleString()} of ${eligible.toLocaleString()} symbols). ⌘⇧F to search.`
    };
  }
  return { kind: 'keyword', icon: 'search', label: 'Keyword', title: 'Code search: keyword only. Install the semantic model in Settings → Code Intelligence for semantic search. ⌘⇧F to search.', root };
}

export function CodeIntelTitlebarChip({ folder }: { folder?: string }) {
  const { settings } = useSettings();
  const ciSettings = settings?.ai.codeIntelligence;
  const enabled = folder ? (ciSettings?.projectOverrides?.[folder] ?? ciSettings?.enabled ?? true) : true;
  const [state, setState] = useState<CodeIntelChipState | undefined>();
  const [prompt, setPrompt] = useState(false);
  const [error, setError] = useState('');
  const [pollKey, setPollKey] = useState(0);

  // Undefined result: nothing to show. 'unchanged': the service is not running; keep what is shown.
  const refresh = useCallback(async (wake: boolean): Promise<CodeIntelChipState | undefined | 'unchanged'> => {
    const ci = window.praxis?.ai?.codeIntelligence;
    if (!ci || !enabled) return undefined;
    try {
      const owner = record((await ci({ action: 'owner-status' })).data);
      if (owner.running === false) {
        if (!wake) return 'unchanged';
        // Nothing was ever indexed here: say so without starting the service to ask.
        if (owner.hasIndex === false) return folder ? unindexedState(folder) : undefined;
      }
      const repositories = (await ci({ action: 'list' })).data;
      const repo = repositoryForFolder(Array.isArray(repositories)
        ? repositories.map(record).map(r => ({ id: String(r.id), root: String(r.root), state: String(r.state ?? 'ready') }))
        : [], folder);
      if (!repo) return folder ? unindexedState(folder) : undefined;
      const status = await ci({ action: 'query', tool: 'get_index_status', arguments: { repositoryId: repo.id, responseBudgetTokens: 8000 } });
      return describeIndex(repo, status.error ? undefined : status);
    } catch {
      return undefined;
    }
  }, [folder, enabled]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async (wake: boolean) => {
      const next = await refresh(wake);
      if (cancelled || next === 'unchanged') return;
      setState(next);
      if (next && (next.kind === 'indexing' || next.kind === 'building')) timer = window.setTimeout(() => void tick(false), BUSY_POLL_MS);
    };
    const onFocus = () => { window.clearTimeout(timer); void tick(false); };
    void tick(true);
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh, pollKey]);

  // An unindexed folder asks once whether to build, unless the person said "Not now" for it.
  useEffect(() => {
    let dismissed = false;
    // '*' turns the prompt off for every folder.
    try { dismissed = Boolean(state?.kind === 'unindexed' && (localStorage.getItem(INDEX_PROMPT_DISMISS_PREFIX + state.root) || localStorage.getItem(INDEX_PROMPT_DISMISS_PREFIX + '*'))); } catch { /* storage unavailable */ }
    setPrompt(state?.kind === 'unindexed' && !dismissed);
  }, [state?.kind, state?.root]);
  useEffect(() => {
    indexPromptShowing = prompt;
    window.dispatchEvent(new CustomEvent(INDEX_PROMPT_EVENT, { detail: { open: prompt } }));
  }, [prompt]);

  const build = async () => {
    if (state?.kind !== 'unindexed') return;
    setPrompt(false);
    setError('');
    // Registering queues the first index (and activates an installed model); then follow it.
    setState({ ...describeIndex({ id: '', root: state.root, state: 'pending' }, undefined) });
    try {
      const registered = await window.praxis.ai.codeIntelligence({ action: 'register', root: state.root });
      if (registered.error) throw new Error(registered.error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState(unindexedState(state.root));
      setPrompt(true);
      return;
    }
    setPollKey(key => key + 1);
  };
  const notNow = () => {
    if (state) try { localStorage.setItem(INDEX_PROMPT_DISMISS_PREFIX + state.root, 'true'); } catch { /* storage unavailable */ }
    setPrompt(false);
  };

  if (!state) return null;
  return (
    <div className="titlebar-group titlebar-code-intel">
      <button
        type="button"
        className={`titlebar-code-intel-chip is-${state.kind}`}
        data-testid="titlebar-code-intel"
        data-state={state.kind}
        aria-label={state.title}
        title={state.title}
        onClick={() => state.kind === 'unindexed'
          ? void build()
          : window.dispatchEvent(new CustomEvent('praxis:open-code-search', { detail: { workingDirectory: state.root } }))}
      >
        <Icon name={state.icon} size={12} className={`titlebar-code-intel-icon is-${state.icon}`} />
        <span>{state.label}</span>
      </button>
      {prompt && createPortal(
        <aside className="semantic-search-notification" role="region" aria-label="Build code index" data-testid="code-index-prompt">
          <div className="semantic-search-notification-header">
            <div className="semantic-search-notification-title-wrap">
              <span className="semantic-search-notification-icon" aria-hidden="true"><Icon name="zap" size={16} /></span>
              <h4 className="semantic-search-notification-title">Index {folderName(state.root)}?</h4>
            </div>
            <button type="button" className="semantic-search-notification-close" aria-label="Dismiss" onClick={notNow}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <p className="semantic-search-notification-body">
            This project&apos;s code has no index yet. Building one lets code search (⌘⇧F) and your AI agents find symbols,
            callers and code by meaning. It runs locally in the background and keeps itself up to date.
          </p>
          {error && <div className="error-banner" role="alert" style={{ fontSize: 'var(--text-xs, 11px)', padding: '6px 10px' }}>{error}</div>}
          <div className="semantic-search-notification-actions">
            <button type="button" className="btn btn-sm btn-ghost" data-testid="code-index-prompt-dismiss" onClick={notNow}>Not now</button>
            <button type="button" className="btn btn-sm btn-primary" data-testid="code-index-prompt-build" onClick={() => void build()}>Build index</button>
          </div>
        </aside>,
        document.body
      )}
    </div>
  );
}
