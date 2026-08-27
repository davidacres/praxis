import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { GitCommitDetails, GitDiffRequest, GitRepositoryPreflight, GitRepositorySnapshot, GitStatusSnapshot } from '@ticket-manager/core';
import { useSettings } from './useSettings';
import { GitDiffWorkspace } from './GitDiffWorkspace';
import { GitConflictWorkspace } from './GitConflictWorkspace';

const LANE_COLORS = ['#1687ff', '#d900e8', '#ff2d55', '#ff8a00', '#d6e800', '#31d7b1', '#00b8d9', '#8c63ff', '#ff4f9a'];
const LANE_GAP = 18;
const GRAPH_INSET = 24;

function verticalEdgePath(x1: number, y1: number, x2: number, y2: number, firstParent: boolean): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const direction = x2 > x1 ? 1 : -1;
  const radius = Math.min(9, Math.abs(x2 - x1) / 2, Math.max(2, (y2 - y1) / 4));
  if (firstParent) {
    return `M ${x1} ${y1} L ${x1} ${y2 - radius} Q ${x1} ${y2} ${x1 + direction * radius} ${y2} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} Q ${x1} ${y1 + radius} ${x1 + direction * radius} ${y1 + radius} L ${x2 - direction * radius} ${y1 + radius} Q ${x2} ${y1 + radius} ${x2} ${y1 + radius * 2} L ${x2} ${y2}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(new Date(value));
}

function branchColor(branch: string): string {
  if (branch.startsWith('tag:')) return '#e6a84a';
  if (branch === 'main' || branch === 'master') return '#5b8cff';
  if (branch.startsWith('hotfix/')) return '#e56b62';
  if (branch.startsWith('release/')) return '#d879b8';
  return '#46c98d';
}

export function GitGraphPage({ repositoryPath, initialView }: { repositoryPath?: string; initialView?: 'graph' | 'changes' | 'conflicts' }) {
  const { settings, update } = useSettings();
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot>();
  const [selectedHash, setSelectedHash] = useState<string>();
  const [details, setDetails] = useState<GitCommitDetails>();
  const [branchFilter, setBranchFilter] = useState<string>();
  const [mergesOnly, setMergesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [preflight, setPreflight] = useState<GitRepositoryPreflight>();
  const [diffRequest, setDiffRequest] = useState<GitDiffRequest>();
  const [diffInitialPath, setDiffInitialPath] = useState<string>();
  const [status, setStatus] = useState<GitStatusSnapshot>();
  const [changesOpen, setChangesOpen] = useState(initialView === 'changes');
  const [commitMessage, setCommitMessage] = useState('');
  const [busyAction, setBusyAction] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareLeft, setCompareLeft] = useState('');
  const [compareRight, setCompareRight] = useState('');
  const [compareBaseHash, setCompareBaseHash] = useState<string>();
  const [conflictPath, setConflictPath] = useState<string>();
  const [smartVisibility, setSmartVisibility] = useState(false);
  const [pinnedBranches, setPinnedBranches] = useState<Set<string>>(new Set());
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; hash: string }>();
  const defaultFocusApplied = useRef(false);
  const visualSettings = settings?.gitVisual ?? { branchColorsEnabled: true, mergeMarkersEnabled: true, orientation: 'vertical' as const, performanceMode: false };
  const gitSettings = settings?.git ?? { executablePath: '', defaultBranch: '', fetchIntervalMinutes: 0 };

  const load = async (repositoryPath?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.ticketManager.git.open(repositoryPath);
      setSnapshot(next);
      setCompareLeft(current => current || next.currentBranch || next.branches.find(branch => !branch.isRemote)?.name || 'HEAD');
      setCompareRight(current => current || next.branches.find(branch => !branch.isRemote && branch.name !== next.currentBranch)?.name || next.currentBranch || 'HEAD');
      setSelectedHash(current => current && next.commits.some(commit => commit.hash === current) ? current : next.commits[0]?.hash);
      const nextStatus = await window.ticketManager.git.status(next.repositoryPath);
      setStatus(nextStatus);
      setConflictPath(nextStatus.files.find(file => file.conflicted)?.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const inspectAndLoad = async (candidate?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.ticketManager.git.preflight(candidate);
      setPreflight(result);
      if (result.status === 'repository' || result.status === 'worktree') {
        await load(result.repositoryPath);
      } else {
        setLoading(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  };

  useEffect(() => { void inspectAndLoad(repositoryPath); }, [repositoryPath]);
  useEffect(() => { if (initialView === 'changes') setChangesOpen(true); }, [initialView]);

  useEffect(() => {
    const defaultBranch = settings?.git.defaultBranch.trim();
    if (defaultFocusApplied.current || !snapshot || !defaultBranch) return;
    if (snapshot.branches.some(branch => !branch.isRemote && branch.name === defaultBranch)) {
      setBranchFilter(defaultBranch);
    }
    defaultFocusApplied.current = true;
  }, [settings, snapshot]);

  const runAction = async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusyAction(label);
    setError(undefined);
    try {
      return await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  };

  const adoptSnapshot = async (next: GitRepositorySnapshot) => {
    setSnapshot(next);
    defaultFocusApplied.current = false;
    setBranchFilter(undefined);
    const nextStatus = await window.ticketManager.git.status(next.repositoryPath);
    setStatus(nextStatus);
    setConflictPath(nextStatus.files.find(file => file.conflicted)?.path);
    setSelectedHash(next.commits[0]?.hash);
  };

  const refreshStatus = async () => {
    if (snapshot) setStatus(await window.ticketManager.git.status(snapshot.repositoryPath));
  };

  useEffect(() => {
    if (!snapshot || !selectedHash) return;
    setDetails(undefined);
    void window.ticketManager.git.getCommit(snapshot.repositoryPath, selectedHash)
      .then(setDetails)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [snapshot, selectedHash]);

  useEffect(() => {
    const intervalMinutes = gitSettings.fetchIntervalMinutes;
    if (!snapshot || intervalMinutes <= 0) return;
    const timer = window.setInterval(() => {
      void runAction('Fetching remote refs', async () => adoptSnapshot(await window.ticketManager.git.fetch(snapshot.repositoryPath)));
    }, intervalMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.repositoryPath, gitSettings.fetchIntervalMinutes]);

  const filteredCommits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (snapshot?.commits ?? []).filter(commit => {
      if (mergesOnly && !commit.isMerge) return false;
      if (branchFilter && !commit.branchHints.includes(branchFilter)) return false;
      const timestamp = new Date(commit.date).getTime();
      if (fromDate && timestamp < new Date(`${fromDate}T00:00:00`).getTime()) return false;
      if (toDate && timestamp > new Date(`${toDate}T23:59:59`).getTime()) return false;
      return !needle || `${commit.message} ${commit.author} ${commit.hash}`.toLowerCase().includes(needle);
    });
  }, [snapshot, branchFilter, mergesOnly, query, fromDate, toDate]);
  const commits = visualSettings.performanceMode ? filteredCommits.slice(0, 800) : filteredCommits;

  const commitRows = useMemo(() => new Map(commits.map((commit, index) => [commit.hash, index])), [commits]);
  const laneCount = Math.max(3, Math.min(10, Math.max(...commits.map(commit => commit.lane + 1), 1)));
  const graphWidth = Math.round((GRAPH_INSET * 2 + Math.max(2, laneCount - 1) * LANE_GAP) * zoom);
  const rowHeight = Math.round(32 * zoom);
  const resolveLaneColor = (lane: number) => visualSettings.branchColorsEnabled ? LANE_COLORS[lane % LANE_COLORS.length] : '#8d98aa';
  const resolveRefColor = (ref: string) => visualSettings.branchColorsEnabled ? branchColor(ref) : '#9aa4b5';
  const visibleBranches = useMemo(() => {
    const branches = snapshot?.branches ?? [];
    if (!smartVisibility) return branches;
    const relevant = new Set([snapshot?.currentBranch, branchFilter].filter((name): name is string => Boolean(name)));
    branches.forEach(branch => { if (branch.isCurrent || (branch.upstream && relevant.has(branch.name))) { relevant.add(branch.name); if (branch.upstream) relevant.add(branch.upstream); } });
    return branches.filter(branch => relevant.has(branch.name));
  }, [snapshot, smartVisibility, branchFilter]);

  const openDiff = (request: GitDiffRequest, path?: string) => {
    setDiffInitialPath(path);
    setDiffRequest(request);
  };
  const openCommitMenu = (event: ReactMouseEvent, hash: string) => {
    event.preventDefault();
    setSelectedHash(hash);
    setCommitMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 250), hash });
  };

  if (snapshot && diffRequest) {
    return <section className="git-page git-page-diff" aria-label="Git Graph" data-testid="git-graph-page">
      <GitDiffWorkspace
        repositoryPath={snapshot.repositoryPath}
        request={diffRequest}
        initialPath={diffInitialPath}
        onClose={() => { setDiffRequest(undefined); setDiffInitialPath(undefined); }}
        onStatusChanged={refreshStatus}
      />
    </section>;
  }

  if (snapshot && conflictPath) {
    return <section className="git-page git-page-diff" aria-label="Git Graph" data-testid="git-graph-page">
      <GitConflictWorkspace repositoryPath={snapshot.repositoryPath} path={conflictPath} canAbort={Boolean(status?.operation)} onClose={() => setConflictPath(undefined)} onResolved={async () => { const next = await window.ticketManager.git.status(snapshot.repositoryPath); setStatus(next); setConflictPath(next.files.find(file => file.conflicted)?.path); }} onAbort={async () => { await adoptSnapshot(await window.ticketManager.git.abortConflict(snapshot.repositoryPath)); setConflictPath(undefined); }} />
    </section>;
  }

  if (!snapshot && !loading) {
    const chooseFolder = async () => {
      const picked = await window.ticketManager.dialog.pickFolder('Choose Git workspace');
      if (picked) await inspectAndLoad(picked);
    };
    const initialize = async () => {
      if (!preflight?.requestedPath || !window.confirm(`Initialize Git in ${preflight.requestedPath}? This creates a .git directory in that folder.`)) return;
      setLoading(true);
      try {
        const result = await window.ticketManager.git.initialize(preflight.requestedPath);
        setPreflight(result);
        if (result.repositoryPath) await load(result.repositoryPath);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    };
    const clone = async () => {
      const url = window.prompt('Repository URL');
      if (!url) return;
      const parent = await window.ticketManager.dialog.pickFolder('Choose clone destination');
      if (!parent) return;
      const name = window.prompt('Folder name (optional)') ?? undefined;
      setLoading(true);
      try {
        const result = await window.ticketManager.git.clone(url, parent, name);
        setPreflight(result);
        if (result.repositoryPath) await load(result.repositoryPath);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    };
    const noWorkspace = preflight?.status === 'no-workspace';
    const notRepo = preflight?.status === 'not-a-repository';
    return <section className="git-page git-onboarding" aria-label="Git workspace setup" data-testid="git-onboarding">
      <div className="git-onboarding-art">⌘</div>
      <div className="git-eyebrow">PROJECT GIT WORKSPACE</div>
      <h1>{noWorkspace ? 'Attach a workspace to use Git Graph' : notRepo ? 'This workspace is not a Git repository' : 'Git Graph needs a usable workspace'}</h1>
      <p>{noWorkspace ? 'Git history, branches, and diffs belong to a project folder. Attach one to continue.' : preflight?.message ?? 'Choose another workspace to continue.'}</p>
      {preflight?.requestedPath && <code className="git-onboarding-path">{preflight.requestedPath}</code>}
      <div className="git-onboarding-actions">
        {notRepo && <button className="git-button git-primary-button" data-testid="git-initialize" onClick={() => void initialize()}>Initialize Git</button>}
        <button className="git-button git-open-button" data-testid="git-choose-workspace" onClick={() => void chooseFolder()}>Choose another folder</button>
        <button className="git-button" data-testid="git-clone-repository" onClick={() => void clone()}>Clone repository</button>
      </div>
      {error && <div className="git-error" role="alert">{error}</div>}
    </section>;
  }

  return (
    <section className="git-page" aria-label="Git Graph" data-testid="git-graph-page">
      <header className="git-header">
        <div>
          <div className="git-eyebrow">REPOSITORY HISTORY</div>
          <h1><span className="git-logo">⌘</span> Git Graph <span className="git-repo-name">{snapshot?.repositoryName ?? 'Repository'}</span></h1>
        </div>
        <div className="git-header-actions">
          <label className="git-search"><span>⌕</span><input aria-label="Search commits" placeholder="Search commits" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <button className="git-button" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
          <button className="git-button git-open-button" data-testid="git-open-repository" onClick={() => void window.ticketManager.dialog.pickFolder('Open Git repository').then(path => { if (path) void load(path); })} disabled={loading}>Open repository</button>
          <button className={`git-button git-settings-button${settingsOpen ? ' active' : ''}`} aria-label="Git settings" onClick={() => setSettingsOpen(value => !value)}>⚙</button>
          {snapshot && <button className={`git-button git-changes-button${changesOpen ? ' active' : ''}`} data-testid="git-changes" onClick={() => { setChangesOpen(value => !value); void refreshStatus(); }}>Changes{status?.files.length ? ` ${status.files.length}` : ''}</button>}
        </div>
      </header>

      <div className="git-toolbar">
        <div className="git-branch-picker">
          <span className="git-toolbar-label">Branch</span>
          <select aria-label="Branch filter" value={branchFilter ?? ''} onChange={event => setBranchFilter(event.target.value || undefined)}>
            <option value="">All branches</option>
            {(snapshot?.branches ?? []).map(branch => <option key={branch.ref} value={branch.name}>{branch.isRemote ? `↗ ${branch.name}` : `● ${branch.name}`}</option>)}
          </select>
        </div>
        <button className={`git-filter${mergesOnly ? ' active' : ''}`} onClick={() => setMergesOnly(value => !value)}>◇ Merges only</button>
        <label className="git-date-filter">From <input aria-label="From date" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label>
        <label className="git-date-filter">To <input aria-label="To date" type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label>
        {snapshot && <>
          <button className="git-action-button" onClick={() => { const name = window.prompt('New branch name'); if (name) void runAction('Creating branch', async () => adoptSnapshot(await window.ticketManager.git.createBranch(snapshot.repositoryPath, name))); }}>+ Branch</button>
          <button className="git-action-button" disabled={!branchFilter || busyAction !== undefined} onClick={() => { if (branchFilter && window.confirm(`Switch to ${branchFilter}?`)) void runAction('Checking out branch', async () => adoptSnapshot(await window.ticketManager.git.checkout(snapshot.repositoryPath, branchFilter))); }}>Checkout</button>
          <button className="git-action-button" disabled={!branchFilter || snapshot.branches.find(branch => branch.name === branchFilter)?.isRemote || busyAction !== undefined} onClick={() => { if (!branchFilter) return; const name = window.prompt(`Rename ${branchFilter} to:`, branchFilter); if (name && name !== branchFilter) void runAction('Renaming branch', async () => adoptSnapshot(await window.ticketManager.git.renameBranch(snapshot.repositoryPath, branchFilter, name))); }}>Rename</button>
          <button className="git-action-button git-danger-button" disabled={!branchFilter || snapshot.branches.find(branch => branch.name === branchFilter)?.isCurrent || snapshot.branches.find(branch => branch.name === branchFilter)?.isRemote || busyAction !== undefined} onClick={() => { if (branchFilter && window.confirm(`Delete branch ${branchFilter}? Git will only delete it when it has been merged.`)) void runAction('Deleting branch', async () => adoptSnapshot(await window.ticketManager.git.deleteBranch(snapshot.repositoryPath, branchFilter))); }}>Delete</button>
          <button className="git-action-button" disabled={!branchFilter || branchFilter === snapshot.currentBranch || busyAction !== undefined} onClick={() => { if (branchFilter && window.confirm(`Merge ${branchFilter} into ${snapshot.currentBranch ?? 'the checked-out branch'}? Praxis will preserve the branch history and open the conflict editor if needed.`)) void runAction('Merging branch', async () => adoptSnapshot(await window.ticketManager.git.merge(snapshot.repositoryPath, branchFilter))); }}>Merge into current</button>
          <button className="git-action-button" disabled={!branchFilter || branchFilter === snapshot.currentBranch || busyAction !== undefined} onClick={() => { if (branchFilter && window.confirm(`Rebase ${snapshot.currentBranch ?? 'the checked-out branch'} onto ${branchFilter}? This rewrites the current branch’s commits and should not be used after sharing them.`)) void runAction('Rebasing branch', async () => adoptSnapshot(await window.ticketManager.git.rebase(snapshot.repositoryPath, branchFilter))); }}>Rebase current</button>
          <button className="git-action-button" disabled={busyAction !== undefined} onClick={() => void runAction('Pulling changes', async () => adoptSnapshot(await window.ticketManager.git.pull(snapshot.repositoryPath)))}>Pull</button>
          <button className="git-action-button" disabled={busyAction !== undefined} onClick={() => void runAction('Pushing changes', async () => adoptSnapshot(await window.ticketManager.git.push(snapshot.repositoryPath)))}>Push</button>
          <button className="git-action-button" disabled={busyAction !== undefined} onClick={() => { if (window.confirm('Restore the most recent Praxis stash onto the current branch? Conflicts will open in the resolver.')) void runAction('Restoring stash', async () => adoptSnapshot(await window.ticketManager.git.popStash(snapshot.repositoryPath))); }}>Pop stash</button>
          <button className={`git-action-button${compareOpen ? ' active' : ''}`} onClick={() => { setCompareOpen(value => !value); setSettingsOpen(false); }}>Compare…</button>
        </>}
        <span className="git-toolbar-spacer" />
        <button className={`git-filter${smartVisibility ? ' active' : ''}`} onClick={() => setSmartVisibility(value => !value)}>Smart visibility</button>
        <span className="git-result-count">{commits.length.toLocaleString()} commits</span>
        <div className="git-zoom-controls" aria-label="Graph zoom"><button aria-label="Zoom out" onClick={() => setZoom(value => Math.max(.7, Number((value - .1).toFixed(1))))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setZoom(value => Math.min(1.6, Number((value + .1).toFixed(1))))}>+</button></div>
        <span className="git-head-chip">HEAD <b>{snapshot?.currentBranch ?? 'detached'}</b></span>
      </div>

      {settingsOpen && <section className="git-settings-panel" aria-label="Git settings panel">
        <div className="git-settings-heading"><strong>Git Graph settings</strong><span>Saved for this desktop app</span></div>
        <label>Git executable<input aria-label="Git executable path" value={gitSettings.executablePath} placeholder="System default (git)" onChange={event => void update({ git: { executablePath: event.target.value } })} /></label>
        <label>Default branch focus<input aria-label="Default branch focus" value={gitSettings.defaultBranch} placeholder="No default focus" onChange={event => void update({ git: { defaultBranch: event.target.value } })} /></label>
        <label>Fetch interval (minutes)<input aria-label="Fetch interval" type="number" min="0" max="1440" value={gitSettings.fetchIntervalMinutes} onChange={event => void update({ git: { fetchIntervalMinutes: Number(event.target.value) || 0 } })} /></label>
        <label>Graph orientation<select aria-label="Graph orientation" value={visualSettings.orientation} onChange={event => void update({ gitVisual: { orientation: event.target.value as 'vertical' | 'horizontal' } })}><option value="vertical">Vertical timeline</option><option value="horizontal">Horizontal timeline</option></select></label>
        <label className="git-setting-check"><input type="checkbox" checked={visualSettings.branchColorsEnabled} onChange={event => void update({ gitVisual: { branchColorsEnabled: event.target.checked } })} /> Branch colors</label>
        <label className="git-setting-check"><input type="checkbox" checked={visualSettings.mergeMarkersEnabled} onChange={event => void update({ gitVisual: { mergeMarkersEnabled: event.target.checked } })} /> Merge markers</label>
        <label className="git-setting-check"><input type="checkbox" checked={visualSettings.performanceMode} onChange={event => void update({ gitVisual: { performanceMode: event.target.checked } })} /> Performance mode (show newest 800 commits)</label>
      </section>}

      {compareOpen && snapshot && <section className="git-compare-panel" aria-label="Compare revisions">
        <div><strong>Compare revisions</strong><span>Choose any two local or remote branches, tags, or commit references.</span></div>
        <label>From<select aria-label="Compare from" value={compareLeft} onChange={event => setCompareLeft(event.target.value)}>{snapshot.branches.map(branch => <option key={branch.ref} value={branch.name}>{branch.name}</option>)}</select></label>
        <span className="git-compare-arrow">→</span>
        <label>To<select aria-label="Compare to" value={compareRight} onChange={event => setCompareRight(event.target.value)}>{snapshot.branches.map(branch => <option key={branch.ref} value={branch.name}>{branch.name}</option>)}</select></label>
        <button disabled={!compareLeft || !compareRight || compareLeft === compareRight} onClick={() => openDiff({ kind: 'compare', left: compareLeft, right: compareRight })}>Open comparison</button>
      </section>}

      {error && <div className="git-error" role="alert"><strong>Git is unavailable</strong><span>{error}</span><button onClick={() => void load()}>Try again</button></div>}
      {busyAction && <div className="git-progress" role="status"><span className="git-progress-dot" />{busyAction}…</div>}
      {loading && !snapshot && <div className="git-empty"><div className="git-spinner" /><h2>Reading repository history</h2><p>Building the branch map from your installed Git.</p></div>}
      {!loading && !snapshot && !error && <div className="git-empty"><div className="git-empty-icon">⌘</div><h2>No repository selected</h2><p>Open a folder containing a Git repository to explore its history.</p></div>}

      {changesOpen && snapshot && status && <section className="git-changes-panel" aria-label="Working tree changes" data-testid="git-changes-panel">
        <div className="git-changes-heading"><div><strong>Working tree</strong><span>{status.files.length ? `${status.files.length} changed files` : 'Clean'}</span></div><div className="git-changes-actions">{status.files.some(file => !file.staged) && <button onClick={() => openDiff({ kind: 'working' })}>Review unstaged</button>}{status.files.some(file => file.staged) && <button onClick={() => openDiff({ kind: 'staged' })}>Review staged</button>}{status.files.length > 0 && <button onClick={() => { const message = window.prompt('Optional stash description:', 'Work in progress'); if (message !== null) void runAction('Stashing changes', async () => adoptSnapshot(await window.ticketManager.git.stash(snapshot.repositoryPath, message))); }}>Stash changes</button>}{status.files.length > 0 && <button onClick={() => void runAction('Staging all files', async () => { const next = await window.ticketManager.git.stage(snapshot.repositoryPath, status.files.map(file => file.path)); setStatus(next); return next; })}>Stage all</button>}<button onClick={() => void refreshStatus()}>↻</button></div></div>
        {status.files.length === 0 ? <div className="git-clean-state"><span>✓</span><div><b>Everything is committed</b><small>No local file changes to stage.</small></div></div> : <>
          <div className="git-change-list">{status.files.map(file => <div className={`git-change-row${file.conflicted ? ' conflicted' : ''}`} key={file.path}>{file.conflicted ? <span className="git-conflict-indicator">!</span> : <input aria-label={`${file.staged ? 'Unstage' : 'Stage'} ${file.path}`} type="checkbox" checked={file.staged} onChange={() => void runAction(file.staged ? 'Unstaging file' : 'Staging file', async () => { const next = file.staged ? await window.ticketManager.git.unstage(snapshot.repositoryPath, [file.path]) : await window.ticketManager.git.stage(snapshot.repositoryPath, [file.path]); setStatus(next); return next; })} />}<span className="git-change-status">{file.indexStatus !== ' ' ? file.indexStatus : file.worktreeStatus}</span><button className="git-change-file" onClick={() => file.conflicted ? setConflictPath(file.path) : openDiff({ kind: file.staged ? 'staged' : 'working' }, file.path)}>{file.path}</button><small>{file.conflicted ? 'resolve' : file.staged ? 'staged' : 'unstaged'}</small></div>)}</div>
          <div className="git-commit-form"><textarea aria-label="Commit message" placeholder="Describe the changes…" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} /><button disabled={!status.files.some(file => file.staged) || !commitMessage.trim() || busyAction !== undefined} onClick={() => void runAction('Committing changes', async () => { const next = await window.ticketManager.git.commit(snapshot.repositoryPath, commitMessage); setCommitMessage(''); await adoptSnapshot(next); return next; })}>Commit staged</button></div>
        </>}
      </section>}

      {snapshot && <div className="git-workspace">
        <aside className="git-refs" aria-label="Branches">
          <div className="git-panel-title">Branches <span>{snapshot.branches.length}</span></div>
          <div className="git-ref-group">LOCAL</div>
          {visibleBranches.filter(branch => !branch.isRemote).sort((a, b) => Number(pinnedBranches.has(b.name)) - Number(pinnedBranches.has(a.name))).map(branch => <button key={branch.ref} title={`${branch.name} · double-click to check out · right-click to ${pinnedBranches.has(branch.name) ? 'unpin' : 'pin'}`} className={`git-ref-row${branchFilter === branch.name ? ' selected' : ''}${pinnedBranches.has(branch.name) ? ' pinned' : ''}`} onClick={() => setBranchFilter(branchFilter === branch.name ? undefined : branch.name)} onDoubleClick={() => { if (!branch.isCurrent) void runAction('Checking out branch', async () => adoptSnapshot(await window.ticketManager.git.checkout(snapshot.repositoryPath, branch.name))); }} onContextMenu={event => { event.preventDefault(); setPinnedBranches(current => { const next = new Set(current); if (next.has(branch.name)) next.delete(branch.name); else next.add(branch.name); return next; }); }}><i style={{ background: resolveRefColor(branch.name) }} /> <span>{branch.name}</span>{pinnedBranches.has(branch.name) && <em>PIN</em>}{branch.isCurrent && <b>HEAD</b>}</button>)}
          <div className="git-ref-group">REMOTE</div>
          {visibleBranches.filter(branch => branch.isRemote).slice(0, 12).map(branch => <button key={branch.ref} title={branch.name} className="git-ref-row remote" onClick={() => setBranchFilter(branch.name)}><i style={{ background: resolveRefColor(branch.name) }} /> <span>{branch.name}</span></button>)}
          {snapshot.tags.length > 0 && <><div className="git-ref-group">TAGS</div>{snapshot.tags.slice(0, 12).map(tag => <div key={tag} title={tag} className="git-ref-row git-tag-row"><i style={{ background: resolveRefColor(`tag:${tag}`) }} /> <span>{tag}</span></div>)}</>}
          <div className="git-legend"><div><i className="legend-split" /> Branch split</div><div><i className="legend-merge" /> Merge commit</div></div>
        </aside>

        <div className={`git-history${visualSettings.orientation === 'horizontal' ? ' git-history-horizontal' : ''}`} style={visualSettings.orientation === 'vertical' ? { '--git-graph-width': `${graphWidth}px` } as CSSProperties : undefined} role="list" aria-label="Commit history">
          <div className="git-history-header"><span className="git-history-title">History</span><span>Message</span><span>Author</span><span>Date</span></div>
          {status && status.files.length > 0 && <button className="git-wip-row" role="listitem" onClick={() => openDiff({ kind: 'working' })}><span className="git-wip-node">●</span><span><strong>Working changes</strong><small>{status.files.filter(file => !file.staged).length} unstaged · {status.files.filter(file => file.staged).length} staged</small></span><b>Review</b></button>}
          {visualSettings.orientation === 'horizontal' ? <div className="git-horizontal-scroll">
            <div className="git-horizontal-canvas">
              <svg className="git-horizontal-lines" width={Math.max(1, commits.length) * 190} height={Math.max(1, laneCount) * 34} aria-hidden="true">
                {Array.from({ length: laneCount }, (_, lane) => <line key={`horizontal-lane-${lane}`} className="git-lane-guide" x1="0" y1={17 + lane * 34} x2={Math.max(1, commits.length) * 190} y2={17 + lane * 34} />)}
                {commits.flatMap((commit, index) => commit.parents.map(parent => {
                  const parentIndex = commitRows.get(parent);
                  if (parentIndex === undefined) return null;
                  const x1 = index * 190 + 32;
                  const x2 = parentIndex * 190 + 32;
                  const y1 = 17 + commit.lane * 34;
                  const y2 = 17 + (commits[parentIndex]?.lane ?? commit.lane) * 34;
                  return <path className="git-edge" key={`${commit.hash}-${parent}`} d={`M ${x1} ${y1} C ${x1 + 48} ${y1}, ${x2 - 48} ${y2}, ${x2} ${y2}`} stroke={resolveLaneColor(commit.lane)} />;
                }))}
                {commits.map((commit, index) => { const x = index * 190 + 32; const y = 17 + commit.lane * 34; return <g key={commit.hash}>{commit.isMerge && <circle className="git-merge-ring" cx={x} cy={y} r="10" />}<circle className={`git-node${selectedHash === commit.hash ? ' selected' : ''}`} cx={x} cy={y} r={commit.isMerge ? 7 : 6} fill={resolveLaneColor(commit.lane)} />{visualSettings.mergeMarkersEnabled && commit.isDivergence && <path className="git-split-marker" d={`M ${x - 9} ${y - 12} l 9 -7 l 9 7`} />}</g>; })}
              </svg>
              <div className="git-horizontal-commits">
                {commits.map(commit => <button key={commit.hash} className={`git-horizontal-commit${selectedHash === commit.hash ? ' selected' : ''}`} onClick={() => setSelectedHash(commit.hash)} onContextMenu={event => openCommitMenu(event, commit.hash)} role="listitem" title={`${commit.shortHash} · ${commit.message}`}><span className="git-horizontal-commit-message"><strong>{commit.message}</strong><small>{commit.refs.slice(0, 2).map(ref => <em key={ref} style={{ color: resolveRefColor(ref) }}>{ref}</em>)}{visualSettings.mergeMarkersEnabled && commit.isDivergence && <em className="topology split">Split</em>}{visualSettings.mergeMarkersEnabled && commit.isMerge && <em className="topology merge">Merge</em>}</small></span><span>{commit.author}</span><time>{formatDate(commit.date)}</time></button>)}
              </div>
            </div>
          </div> : <div className="git-rows">
            <svg className="git-lines" width={graphWidth} height={Math.max(1, commits.length) * rowHeight} aria-hidden="true">
              {commits.flatMap((commit, index) => commit.parents.map((parent, parentOffset) => {
                const parentIndex = commitRows.get(parent);
                if (parentIndex === undefined) return null;
                const parentCommit = commits[parentIndex];
                const x1 = GRAPH_INSET + commit.lane * LANE_GAP;
                const x2 = GRAPH_INSET + (parentCommit?.lane ?? commit.lane) * LANE_GAP;
                const y1 = index * rowHeight + rowHeight / 2;
                const y2 = parentIndex * rowHeight + rowHeight / 2;
                const edgeLane = parentOffset === 0 ? commit.lane : (parentCommit?.lane ?? commit.lane);
                return <path className="git-edge" key={`${commit.hash}-${parent}`} d={verticalEdgePath(x1, y1, x2, y2, parentOffset === 0)} stroke={resolveLaneColor(edgeLane)} />;
              }))}
              {commits.map((commit, index) => { const x = GRAPH_INSET + commit.lane * LANE_GAP; const y = index * rowHeight + rowHeight / 2; return <g key={commit.hash}>{commit.isMerge && <circle className="git-merge-ring" cx={x} cy={y} r="9" stroke={resolveLaneColor(commit.lane)} /> }<circle className={`git-node${selectedHash === commit.hash ? ' selected' : ''}`} cx={x} cy={y} r={commit.isMerge ? 6 : 5} fill={resolveLaneColor(commit.lane)} />{visualSettings.mergeMarkersEnabled && commit.isDivergence && <circle className="git-split-marker" cx={x} cy={y} r="8" />}</g>; })}
            </svg>
            <div className="git-commit-list">
              {commits.map(commit => <button key={commit.hash} title={`${commit.shortHash} · ${commit.message}`} style={{ height: rowHeight }} className={`git-commit-row${selectedHash === commit.hash ? ' selected' : ''}`} onClick={() => setSelectedHash(commit.hash)} onContextMenu={event => openCommitMenu(event, commit.hash)} role="listitem"><span className="git-graph-spacer" /><span className="git-commit-message"><strong>{commit.message}</strong><small>{commit.refs.slice(0, 2).map(ref => <em key={ref} style={{ color: resolveRefColor(ref) }}>{ref}</em>)}{visualSettings.mergeMarkersEnabled && commit.isDivergence && <em className="topology split">Split</em>}{visualSettings.mergeMarkersEnabled && commit.isMerge && <em className="topology merge">Merge</em>}</small></span><span className="git-commit-author">{commit.author}</span><span className="git-commit-date">{formatDate(commit.date)}</span></button>)}
            </div>
          </div>}
          {commits.length === 0 && <div className="git-no-results">No commits match these filters.</div>}
        </div>

        <aside className="git-inspector" aria-label="Commit details">
          {!details ? <div className="git-inspector-empty">Select a commit to inspect its story.</div> : <>
            <div className="git-inspector-kicker">COMMIT DETAILS</div>
            <h2>{details.message}</h2>
            <div className="git-sha">{details.shortHash} · {formatDate(details.date)}</div>
            <div className="git-author-card"><span className="git-avatar">{details.author.slice(0, 1).toUpperCase()}</span><span><b>{details.author}</b><small>committed this change</small></span></div>
            <div className="git-topology-card"><div><span>Parents</span><b>{details.parents.length || 'None'}</b></div><div><span>Children</span><b>{details.children.length || 'None'}</b></div><div><span>Changed files</span><b>{details.changedFiles.length}</b></div></div>
            <div className="git-commit-compare-actions">
              <button className={compareBaseHash === details.hash ? 'selected' : ''} onClick={() => setCompareBaseHash(details.hash)}>{compareBaseHash === details.hash ? 'Comparison starts here' : 'Set as comparison start'}</button>
              {compareBaseHash && compareBaseHash !== details.hash && <button className="primary" onClick={() => openDiff({ kind: 'compare', left: compareBaseHash, right: details.hash })}>Compare with {compareBaseHash.slice(0, 8)}</button>}
            </div>
            <div className="git-inspector-section"><div className="git-inspector-section-title">Changed files <span>{details.changedFiles.length}</span></div>{details.changedFiles.slice(0, 8).map(file => <button className="git-file-row" key={file.path} onClick={() => openDiff({ kind: 'commit', left: details.hash }, file.path)}><span>◇ {file.path}</span><small><i>+{file.additions}</i> <b>-{file.deletions}</b></small></button>)}{details.changedFiles.length === 0 && <p className="git-muted">No file changes in this commit.</p>}</div>
            <button className="git-diff-button" onClick={() => openDiff({ kind: 'commit', left: details.hash })}>Open clear diff ↗</button>
          </>}
        </aside>
      </div>}
      {commitMenu && snapshot && <div className="git-context-menu" style={{ left: commitMenu.x, top: commitMenu.y }} role="menu" aria-label="Commit actions">
        <div><strong>{commitMenu.hash.slice(0, 8)}</strong><button onClick={() => setCommitMenu(undefined)}>×</button></div>
        <button role="menuitem" onClick={() => { setCompareBaseHash(commitMenu.hash); setCommitMenu(undefined); }}>Set as comparison start</button>
        <button role="menuitem" onClick={() => { const name = window.prompt('New branch name:'); if (name) void runAction('Creating branch', async () => adoptSnapshot(await window.ticketManager.git.createBranch(snapshot.repositoryPath, name, commitMenu.hash))); setCommitMenu(undefined); }}>Create branch here</button>
        <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(commitMenu.hash); setCommitMenu(undefined); }}>Copy commit SHA</button>
        <button role="menuitem" onClick={() => { if (window.confirm(`Cherry-pick ${commitMenu.hash.slice(0, 8)} onto ${snapshot.currentBranch ?? 'the current branch'}?`)) void runAction('Cherry-picking commit', async () => adoptSnapshot(await window.ticketManager.git.cherryPick(snapshot.repositoryPath, commitMenu.hash))); setCommitMenu(undefined); }}>Cherry-pick commit</button>
        <button className="danger" role="menuitem" onClick={() => { if (window.confirm(`Create a new commit that reverses ${commitMenu.hash.slice(0, 8)}? Published history will be preserved.`)) void runAction('Reverting commit', async () => adoptSnapshot(await window.ticketManager.git.revert(snapshot.repositoryPath, commitMenu.hash))); setCommitMenu(undefined); }}>Revert with new commit</button>
      </div>}
    </section>
  );
}
