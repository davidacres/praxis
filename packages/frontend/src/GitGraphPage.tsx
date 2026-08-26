import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { GitCommitDetails, GitRepositorySnapshot, GitStatusSnapshot } from '@ticket-manager/core';
import { useSettings } from './useSettings';

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

export function GitGraphPage() {
  const { settings, update } = useSettings();
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot>();
  const [selectedHash, setSelectedHash] = useState<string>();
  const [details, setDetails] = useState<GitCommitDetails>();
  const [branchFilter, setBranchFilter] = useState<string>();
  const [mergesOnly, setMergesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const [status, setStatus] = useState<GitStatusSnapshot>();
  const [changesOpen, setChangesOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [busyAction, setBusyAction] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const defaultFocusApplied = useRef(false);
  const visualSettings = settings?.gitVisual ?? { branchColorsEnabled: true, mergeMarkersEnabled: true, orientation: 'vertical' as const, performanceMode: false };
  const gitSettings = settings?.git ?? { executablePath: '', defaultBranch: '', fetchIntervalMinutes: 0 };

  const load = async (repositoryPath?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.ticketManager.git.open(repositoryPath);
      setSnapshot(next);
      setSelectedHash(current => current && next.commits.some(commit => commit.hash === current) ? current : next.commits[0]?.hash);
      setStatus(await window.ticketManager.git.status(next.repositoryPath));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

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
    setStatus(await window.ticketManager.git.status(next.repositoryPath));
    setSelectedHash(next.commits[0]?.hash);
  };

  const refreshStatus = async () => {
    if (snapshot) setStatus(await window.ticketManager.git.status(snapshot.repositoryPath));
  };

  useEffect(() => {
    if (!snapshot || !selectedHash) return;
    setDetails(undefined);
    setDiff(undefined);
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
          <button className="git-action-button git-danger-button" disabled={!branchFilter || snapshot.branches.find(branch => branch.name === branchFilter)?.isCurrent || snapshot.branches.find(branch => branch.name === branchFilter)?.isRemote || busyAction !== undefined} onClick={() => { if (branchFilter && window.confirm(`Delete branch ${branchFilter}? Git will only delete it when it has been merged.`)) void runAction('Deleting branch', async () => adoptSnapshot(await window.ticketManager.git.deleteBranch(snapshot.repositoryPath, branchFilter))); }}>Delete</button>
          <button className="git-action-button" disabled={busyAction !== undefined} onClick={() => void runAction('Pulling changes', async () => adoptSnapshot(await window.ticketManager.git.pull(snapshot.repositoryPath)))}>Pull</button>
          <button className="git-action-button" disabled={busyAction !== undefined} onClick={() => void runAction('Pushing changes', async () => adoptSnapshot(await window.ticketManager.git.push(snapshot.repositoryPath)))}>Push</button>
        </>}
        <span className="git-toolbar-spacer" />
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

      {error && <div className="git-error" role="alert"><strong>Git is unavailable</strong><span>{error}</span><button onClick={() => void load()}>Try again</button></div>}
      {busyAction && <div className="git-progress" role="status"><span className="git-progress-dot" />{busyAction}…</div>}
      {loading && !snapshot && <div className="git-empty"><div className="git-spinner" /><h2>Reading repository history</h2><p>Building the branch map from your installed Git.</p></div>}
      {!loading && !snapshot && !error && <div className="git-empty"><div className="git-empty-icon">⌘</div><h2>No repository selected</h2><p>Open a folder containing a Git repository to explore its history.</p></div>}

      {changesOpen && snapshot && status && <section className="git-changes-panel" aria-label="Working tree changes" data-testid="git-changes-panel">
        <div className="git-changes-heading"><div><strong>Working tree</strong><span>{status.files.length ? `${status.files.length} changed files` : 'Clean'}</span></div><div className="git-changes-actions">{status.files.length > 0 && <button onClick={() => void runAction('Staging all files', async () => { const next = await window.ticketManager.git.stage(snapshot.repositoryPath, status.files.map(file => file.path)); setStatus(next); return next; })}>Stage all</button>}<button onClick={() => void refreshStatus()}>↻</button></div></div>
        {status.files.length === 0 ? <div className="git-clean-state"><span>✓</span><div><b>Everything is committed</b><small>No local file changes to stage.</small></div></div> : <>
          <div className="git-change-list">{status.files.map(file => <div className="git-change-row" key={file.path}><input type="checkbox" checked={file.staged} onChange={() => void runAction(file.staged ? 'Unstaging file' : 'Staging file', async () => { const next = file.staged ? await window.ticketManager.git.unstage(snapshot.repositoryPath, [file.path]) : await window.ticketManager.git.stage(snapshot.repositoryPath, [file.path]); setStatus(next); return next; })} /><span className="git-change-status">{file.indexStatus !== ' ' ? file.indexStatus : file.worktreeStatus}</span><span>{file.path}</span><small>{file.staged ? 'staged' : 'unstaged'}</small></div>)}</div>
          <div className="git-commit-form"><textarea aria-label="Commit message" placeholder="Describe the changes…" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} /><button disabled={!status.files.some(file => file.staged) || !commitMessage.trim() || busyAction !== undefined} onClick={() => void runAction('Committing changes', async () => { const next = await window.ticketManager.git.commit(snapshot.repositoryPath, commitMessage); setCommitMessage(''); await adoptSnapshot(next); return next; })}>Commit staged</button></div>
        </>}
      </section>}

      {snapshot && <div className="git-workspace">
        <aside className="git-refs" aria-label="Branches">
          <div className="git-panel-title">Branches <span>{snapshot.branches.length}</span></div>
          <div className="git-ref-group">LOCAL</div>
          {snapshot.branches.filter(branch => !branch.isRemote).map(branch => <button key={branch.ref} title={branch.name} className={`git-ref-row${branchFilter === branch.name ? ' selected' : ''}`} onClick={() => setBranchFilter(branchFilter === branch.name ? undefined : branch.name)}><i style={{ background: resolveRefColor(branch.name) }} /> <span>{branch.name}</span>{branch.isCurrent && <b>HEAD</b>}</button>)}
          <div className="git-ref-group">REMOTE</div>
          {snapshot.branches.filter(branch => branch.isRemote).slice(0, 12).map(branch => <button key={branch.ref} title={branch.name} className="git-ref-row remote" onClick={() => setBranchFilter(branch.name)}><i style={{ background: resolveRefColor(branch.name) }} /> <span>{branch.name}</span></button>)}
          {snapshot.tags.length > 0 && <><div className="git-ref-group">TAGS</div>{snapshot.tags.slice(0, 12).map(tag => <div key={tag} title={tag} className="git-ref-row git-tag-row"><i style={{ background: resolveRefColor(`tag:${tag}`) }} /> <span>{tag}</span></div>)}</>}
          <div className="git-legend"><div><i className="legend-split" /> Branch split</div><div><i className="legend-merge" /> Merge commit</div></div>
        </aside>

        <div className={`git-history${visualSettings.orientation === 'horizontal' ? ' git-history-horizontal' : ''}`} style={visualSettings.orientation === 'vertical' ? { '--git-graph-width': `${graphWidth}px` } as CSSProperties : undefined} role="list" aria-label="Commit history">
          <div className="git-history-header"><span className="git-history-title">History</span><span>Message</span><span>Author</span><span>Date</span></div>
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
                {commits.map(commit => <button key={commit.hash} className={`git-horizontal-commit${selectedHash === commit.hash ? ' selected' : ''}`} onClick={() => setSelectedHash(commit.hash)} role="listitem" title={`${commit.shortHash} · ${commit.message}`}><span className="git-horizontal-commit-message"><strong>{commit.message}</strong><small>{commit.refs.slice(0, 2).map(ref => <em key={ref} style={{ color: resolveRefColor(ref) }}>{ref}</em>)}{visualSettings.mergeMarkersEnabled && commit.isDivergence && <em className="topology split">Split</em>}{visualSettings.mergeMarkersEnabled && commit.isMerge && <em className="topology merge">Merge</em>}</small></span><span>{commit.author}</span><time>{formatDate(commit.date)}</time></button>)}
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
              {commits.map(commit => <button key={commit.hash} title={`${commit.shortHash} · ${commit.message}`} style={{ height: rowHeight }} className={`git-commit-row${selectedHash === commit.hash ? ' selected' : ''}`} onClick={() => setSelectedHash(commit.hash)} role="listitem"><span className="git-graph-spacer" /><span className="git-commit-message"><strong>{commit.message}</strong><small>{commit.refs.slice(0, 2).map(ref => <em key={ref} style={{ color: resolveRefColor(ref) }}>{ref}</em>)}{visualSettings.mergeMarkersEnabled && commit.isDivergence && <em className="topology split">Split</em>}{visualSettings.mergeMarkersEnabled && commit.isMerge && <em className="topology merge">Merge</em>}</small></span><span className="git-commit-author">{commit.author}</span><span className="git-commit-date">{formatDate(commit.date)}</span></button>)}
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
            <div className="git-inspector-section"><div className="git-inspector-section-title">Changed files <span>{details.changedFiles.length}</span></div>{details.changedFiles.slice(0, 8).map(file => <div className="git-file-row" key={file.path}><span>◇ {file.path}</span><small><i>+{file.additions}</i> <b>-{file.deletions}</b></small></div>)}{details.changedFiles.length === 0 && <p className="git-muted">No file changes in this commit.</p>}</div>
            <button className="git-diff-button" onClick={() => snapshot && void window.ticketManager.git.getDiff(snapshot.repositoryPath, details.hash).then(result => setDiff(result.patch)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>View full diff ↗</button>
            {diff && <pre className="git-diff-preview">{diff.slice(0, 6000)}</pre>}
          </>}
        </aside>
      </div>}
    </section>
  );
}
