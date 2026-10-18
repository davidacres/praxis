import { useCallback, useEffect, useState } from 'react';
import type { CodeIntelligenceResponse } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';

// The title bar's code intelligence chip: which search the current project's folder has
// (Hybrid once its model is active, Keyword until then) and, while the index or the semantic
// vectors are still being built, how far that has got. Clicking opens code search.
//
// The service exits after a few idle minutes and starts again on the next request, so the
// chip asks it once when it appears and afterwards only while it is running: polling while
// work is in progress, otherwise on window focus. It never wakes or holds an idle service.

const BUSY_POLL_MS = 3000;

interface Repository { id: string; root: string; state: string }

export interface CodeIntelChipState {
  kind: 'indexing' | 'building' | 'hybrid' | 'keyword' | 'failed';
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
  const [state, setState] = useState<CodeIntelChipState | undefined>();

  // Undefined result: nothing to show. 'unchanged': the service is not running; keep what is shown.
  const refresh = useCallback(async (wake: boolean): Promise<CodeIntelChipState | undefined | 'unchanged'> => {
    const ci = window.praxis?.ai?.codeIntelligence;
    if (!ci) return undefined;
    try {
      const owner = record((await ci({ action: 'owner-status' })).data);
      if (owner.running === false) {
        if (!wake) return 'unchanged';
        // Nothing was ever indexed here: no chip, and no service started just to say so.
        if (owner.hasIndex === false) return undefined;
      }
      const repositories = (await ci({ action: 'list' })).data;
      const repo = repositoryForFolder(Array.isArray(repositories)
        ? repositories.map(record).map(r => ({ id: String(r.id), root: String(r.root), state: String(r.state ?? 'ready') }))
        : [], folder);
      if (!repo) return undefined;
      const status = await ci({ action: 'query', tool: 'get_index_status', arguments: { repositoryId: repo.id, responseBudgetTokens: 8000 } });
      return describeIndex(repo, status.error ? undefined : status);
    } catch {
      return undefined;
    }
  }, [folder]);

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
  }, [refresh]);

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
        onClick={() => window.dispatchEvent(new CustomEvent('praxis:open-code-search', { detail: { workingDirectory: state.root } }))}
      >
        <Icon name={state.icon} size={12} className={`titlebar-code-intel-icon is-${state.icon}`} />
        <span>{state.label}</span>
      </button>
    </div>
  );
}
