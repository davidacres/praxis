import { useState, useEffect, useMemo } from 'react';
import type { AgentSessionRecord, ProjectRecord, GitStatusSnapshot, GitCommitNode, WorkflowRunSummary, ScheduledRunView } from '@praxis/core';
import { sessionLastActivityAt } from '../app/sessionRecency';
import { sessionTitle, formatStarted, isSessionForProject } from '../ai/sessionNav';
import { isTerminalAgentState, agentStateLabel } from '../ai/aiSessionState';

export interface EasyModeCanvasProps {
  project?: ProjectRecord;
  sessions: AgentSessionRecord[];
  runs?: WorkflowRunSummary[];
  onSelectSession: (sessionKey: string) => void;
  onOpenFolder?: () => void;
  onOpenGit?: () => void;
  onOpenAutomations?: () => void;
  onOpenSessions?: () => void;
}

const DAY_MS = 86_400_000;
const SPARK = '▁▂▃▄▅▆▇█';

/** One block glyph per day, oldest first; a day with no activity stays the lowest bar. */
function sparkline(counts: number[]): string {
  const max = Math.max(...counts, 1);
  return counts.map(count => (count === 0 ? '▁' : SPARK[Math.max(1, Math.ceil((count / max) * (SPARK.length - 1)))])).join('');
}

function statusLetter(file: GitStatusSnapshot['files'][number]): string {
  if (file.conflicted) return '!';
  return file.worktreeStatus.trim() || file.indexStatus.trim() || '?';
}

interface LogEntry {
  key: string;
  at: string;
  kind: 'session' | 'run';
  text: string;
  meta: string;
  sessionKey?: string;
}

/**
 * The project's overview: a dense status console over data the shell already
 * holds (sessions, runs) plus the folder's git status. Nothing here starts work —
 * sessions and runs are started from the sidebar.
 */
export function EasyModeCanvas({
  project,
  sessions,
  runs = [],
  onSelectSession,
  onOpenFolder,
  onOpenGit,
  onOpenAutomations,
  onOpenSessions
}: EasyModeCanvasProps) {
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [commits, setCommits] = useState<GitCommitNode[]>([]);
  const [otherBranches, setOtherBranches] = useState(0);
  const [schedules, setSchedules] = useState<ScheduledRunView[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.workspaceFolder || !window.praxis?.git?.status) {
      setGitStatus(null);
      return;
    }
    setGitLoading(true);
    window.praxis.git.status(project.workspaceFolder)
      .then((status: GitStatusSnapshot) => { if (!cancelled) setGitStatus(status); })
      .catch(() => { if (!cancelled) setGitStatus(null); })
      .finally(() => { if (!cancelled) setGitLoading(false); });
    return () => { cancelled = true; };
  }, [project?.workspaceFolder]);

  // The graph is read once per folder: recent commits and a branch count. Failure just hides the panel's rows.
  useEffect(() => {
    let cancelled = false;
    setCommits([]);
    setOtherBranches(0);
    if (!project?.workspaceFolder || !window.praxis?.git?.open) return;
    window.praxis.git.open(project.workspaceFolder)
      .then(snapshot => {
        if (cancelled) return;
        setCommits(snapshot.commits.slice(0, 6));
        setOtherBranches(snapshot.branches.filter(branch => !branch.isRemote && !branch.isCurrent).length);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [project?.workspaceFolder]);

  useEffect(() => {
    if (!project || !window.praxis?.scheduledRuns?.list) return;
    let request = 0;
    const load = () => {
      const mine = ++request;
      window.praxis.scheduledRuns.list()
        .then(all => { if (mine === request) setSchedules(all.filter(view => view.run.projectId === project.id && !view.run.archived)); })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = window.praxis.scheduledRuns.onChanged(load);
    return () => { request += 1; unsubscribe(); };
  }, [project?.id]);

  const projectSessions = useMemo(
    () => (project ? sessions.filter(s => isSessionForProject(s, project, sessions)) : sessions),
    [project, sessions]
  );
  const byRecency = useMemo(
    () => [...projectSessions].sort((a, b) => Date.parse(sessionLastActivityAt(b)) - Date.parse(sessionLastActivityAt(a))),
    [projectSessions]
  );
  const activeSessions = useMemo(() => byRecency.filter(s => !isTerminalAgentState(s.state)), [byRecency]);
  const agentRows = useMemo(() => [...activeSessions, ...byRecency.filter(s => isTerminalAgentState(s.state))].slice(0, 5), [activeSessions, byRecency]);

  const openRuns = useMemo(() => runs.filter(run => !run.archived), [runs]);
  const liveRuns = openRuns.filter(run => run.status === 'running' || run.paused);

  const week = useMemo(() => {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const counts = new Array<number>(7).fill(0);
    for (const session of projectSessions) {
      const age = Math.floor((startOfToday - new Date(sessionLastActivityAt(session)).setHours(0, 0, 0, 0)) / DAY_MS);
      if (age >= 0 && age < 7) counts[6 - age] += Math.max(session.stepCount ?? 0, 1);
    }
    return { counts, steps: counts.reduce((a, b) => a + b, 0) };
  }, [projectSessions]);

  const log = useMemo<LogEntry[]>(() => {
    const entries: LogEntry[] = byRecency.map(session => ({
      key: `s:${session.issueKey}`,
      at: sessionLastActivityAt(session),
      kind: 'session',
      text: sessionTitle(session),
      meta: `${agentStateLabel(session.state)} · ${session.stepCount} steps`,
      sessionKey: session.issueKey
    }));
    for (const run of openRuns) {
      entries.push({ key: `r:${run.runId}`, at: run.endedAt ?? run.startedAt, kind: 'run', text: `run ${run.workflowName}`, meta: run.paused ? 'paused' : run.status });
    }
    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8);
  }, [byRecency, openRuns]);

  const nextSchedule = useMemo(() => schedules
    .filter(view => view.run.status === 'scheduled')
    .sort((a, b) => Date.parse(a.run.scheduledStartAt) - Date.parse(b.run.scheduledStartAt))[0], [schedules]);

  const needsYou = useMemo(() => {
    const items: Array<{ key: string; label: string; detail: string; onClick?: () => void }> = [];
    for (const session of activeSessions) {
      if (session.state === 'awaiting_approval' || session.state === 'awaiting_input') {
        items.push({ key: `s:${session.issueKey}`, label: sessionTitle(session), detail: agentStateLabel(session.state).toLowerCase(), onClick: () => onSelectSession(session.issueKey) });
      }
    }
    for (const run of openRuns) {
      if (run.status === 'awaiting-approval' || run.paused) {
        items.push({ key: `r:${run.runId}`, label: run.workflowName, detail: run.paused ? 'run paused' : 'review gate', onClick: onOpenAutomations });
      }
    }
    for (const view of schedules) {
      if (view.run.status === 'missed' || view.run.status === 'paused') {
        items.push({ key: `x:${view.run.id}`, label: view.run.name, detail: `scheduled run ${view.run.status}`, onClick: onOpenAutomations });
      }
    }
    return items;
  }, [activeSessions, openRuns, schedules, onSelectSession, onOpenAutomations]);

  const ticketCounts = useMemo(() => {
    const items = project?.workItems ?? [];
    if (!items.length) return [];
    const order = (project?.workflowStages ?? []).map(stage => stage.name);
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
  }, [project?.workItems, project?.workflowStages]);

  const files = gitStatus?.files ?? [];
  const additions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  const folderPath = project?.workspaceFolder ?? '';
  const branch = gitStatus?.branch || 'HEAD';

  return (
    <main className="easymode-canvas" data-testid="easymode-canvas">
      <div className="console">
        <div className="console__bar">
          <span className="console__title">
            <b>{project?.name || 'Workspace'}</b>
            {folderPath && <span className="console__path" title={folderPath}>{folderPath}</span>}
            {project?.type && <span className="console__dim">{project.type}</span>}
          </span>
          <span className="console__summary">
            {onOpenFolder && !folderPath ? (
              <button type="button" className="console__link" onClick={onOpenFolder} data-testid="easymode-chip-open-folder">open a folder</button>
            ) : (
              <button type="button" className="console__link" onClick={onOpenGit} disabled={!onOpenGit} data-testid="easymode-chip-git">
                {gitStatus ? `${branch}${files.length ? '*' : ''} · ${files.length} dirty${gitStatus.ahead ? ` · ↑${gitStatus.ahead}` : ''}${gitStatus.behind ? ` · ↓${gitStatus.behind}` : ''}` : gitLoading ? 'checking git…' : 'no git'}
              </button>
            )}
            <button type="button" className="console__link" onClick={onOpenSessions} data-testid="easymode-chip-sessions">
              {activeSessions.length} running · {projectSessions.length} sessions
            </button>
          </span>
        </div>

        {needsYou.length > 0 && (
          <section className="console__needs" aria-label="Needs you" data-testid="easymode-needs-you">
            <h2>needs you · {needsYou.length}</h2>
            {needsYou.map(item => (
              <button key={item.key} type="button" className="console__row console__row--button" onClick={item.onClick}>
                <span className="console__warn">▲ {item.label}</span>
                <span className="console__dim">{item.detail}</span>
              </button>
            ))}
          </section>
        )}

        <div className="console__grid" data-testid="easymode-overview-stats">
          <section className="console__panel" aria-label="Agents">
            <h2>agents</h2>
            {agentRows.length === 0 && <p className="console__dim">no sessions in this folder yet — press + beside Sessions in the sidebar</p>}
            {agentRows.map(session => {
              const running = !isTerminalAgentState(session.state);
              return (
                <button
                  key={session.issueKey}
                  type="button"
                  className="console__row console__row--button"
                  onClick={() => onSelectSession(session.issueKey)}
                  data-testid={`easymode-recent-session-${session.issueKey}`}
                >
                  <span className={running ? 'console__ok' : 'console__dim'} title={sessionTitle(session)}>{running ? '●' : '○'} {sessionTitle(session)}</span>
                  <span className="console__dim">{agentStateLabel(session.state)} · {session.stepCount}</span>
                </button>
              );
            })}
            {projectSessions.length > agentRows.length && onOpenSessions && (
              <button type="button" className="console__link" onClick={onOpenSessions} data-testid="easymode-view-all-sessions">all {projectSessions.length} sessions →</button>
            )}
          </section>

          <section className="console__panel" aria-label="Working tree" data-testid="easymode-git-card">
            <h2>working tree{gitStatus && (additions || deletions) ? <span className="console__dim"> +{additions} −{deletions}</span> : null}</h2>
            {!gitStatus && <p className="console__dim">{gitLoading ? 'checking git…' : folderPath ? 'not a git repository' : 'open a folder to see its git state'}</p>}
            {gitStatus && files.length === 0 && <p className="console__ok">clean{gitStatus.ahead ? ` · ${gitStatus.ahead} unpushed` : ''}</p>}
            {files.slice(0, 6).map(file => (
              <div key={file.path} className="console__row" title={file.path}>
                <span className="console__path-cell"><span className="console__warn">{statusLetter(file)}</span> {file.path}</span>
                {(file.additions || file.deletions) ? <span><span className="console__ok">+{file.additions ?? 0}</span> <span className="console__bad">−{file.deletions ?? 0}</span></span> : null}
              </div>
            ))}
            {files.length > 6 && <p className="console__dim">… {files.length - 6} more</p>}
            {onOpenGit && gitStatus && (
              <button type="button" className="console__link" onClick={onOpenGit} data-testid="easymode-tool-git">
                open git{otherBranches ? ` · ${otherBranches} other branch${otherBranches === 1 ? '' : 'es'}` : ''} →
              </button>
            )}
          </section>

          {commits.length > 0 && (
            <section className="console__panel" aria-label="Recent commits" data-testid="easymode-commits">
              <h2>recent commits</h2>
              {commits.map(commit => (
                <div key={commit.hash} className="console__row" title={`${commit.shortHash} · ${commit.author}`}>
                  <span className="console__path-cell"><span className="console__dim">{commit.shortHash}</span> {commit.message}</span>
                  <span className="console__dim">{formatStarted(commit.date)}</span>
                </div>
              ))}
              {onOpenGit && <button type="button" className="console__link" onClick={onOpenGit}>open graph →</button>}
            </section>
          )}

          {ticketCounts.length > 0 && (
            <section className="console__panel" aria-label="Tickets" data-testid="easymode-tickets">
              <h2>tickets · {project?.workItems.length}</h2>
              {ticketCounts.map(([status, count]) => (
                <div key={status} className="console__row"><span>{status}</span><span className="console__dim">{count}</span></div>
              ))}
            </section>
          )}

          <section className="console__panel" aria-label="Runs">
            <h2>runs</h2>
            {nextSchedule && (
              <div className="console__row" data-testid="easymode-next-schedule">
                <span>next · {nextSchedule.run.name}</span>
                <span className="console__dim">{new Date(nextSchedule.run.scheduledStartAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}
            {openRuns.length === 0 && !nextSchedule && <p className="console__dim">no runs yet</p>}
            {openRuns.slice(0, 4).map(run => (
              <div key={run.runId} className="console__row">
                <span>{run.workflowName}{run.issueKey ? ` ${run.issueKey}` : ''}</span>
                <span className={run.paused ? 'console__warn' : run.status === 'running' ? 'console__ok' : 'console__dim'}>{run.paused ? 'paused' : run.status}</span>
              </div>
            ))}
            {onOpenAutomations && (
              <button type="button" className="console__link" onClick={onOpenAutomations} data-testid="easymode-tool-automations">
                workflows{liveRuns.length ? ` · ${liveRuns.length} live` : ''} →
              </button>
            )}
          </section>

          <section className="console__panel" aria-label="Last 7 days">
            <h2>last 7 days</h2>
            <div className="console__spark" aria-label={`Agent steps per day: ${week.counts.join(', ')}`}>{sparkline(week.counts)}</div>
            <p className="console__dim">{week.steps} agent steps · {byRecency.length ? `last active ${formatStarted(sessionLastActivityAt(byRecency[0]))}` : 'no activity yet'}</p>
          </section>

          <section className="console__panel console__panel--wide" aria-label="Log">
            <h2>log</h2>
            {log.length === 0 && <p className="console__dim">nothing has happened here yet</p>}
            {log.map(entry => (
              <div key={entry.key} className="console__row">
                <span className="console__path-cell"><span className="console__dim">{formatStarted(entry.at)}</span> {entry.text}</span>
                <span className="console__dim">{entry.meta}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}
