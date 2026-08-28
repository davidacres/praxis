import { useEffect, useState } from 'react';
import type { AgentSessionRecord, Board, Connection, ConnectionCheck, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { isTerminalAgentState } from '../ai/aiSessionState';

interface OverviewPageProps {
  projects: ProjectRecord[];
  boards: Board[];
  connections: Connection[];
  sessions: AgentSessionRecord[];
  connectionChecks: Record<string, ConnectionCheck | undefined>;
  onNewProject: () => void;
  onNewSession: () => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenConnections: () => void;
  onOpenBoard: (board: Board) => void;
  onOpenProject: (project: ProjectRecord) => void;
}

const stateLabel: Record<AgentSessionRecord['state'], string> = {
  not_started: 'Not started', planning: 'Planning', awaiting_approval: 'Awaiting approval', executing: 'Executing',
  awaiting_input: 'Awaiting input', paused: 'Paused', completed: 'Completed', failed: 'Failed', aborted: 'Aborted'
};

export function OverviewPage({ projects, boards, connections, sessions, connectionChecks, onNewProject, onNewSession, onOpenProjects, onOpenSessions, onOpenConnections, onOpenBoard, onOpenProject }: OverviewPageProps) {
  const activeSessions = sessions.filter(session => !isTerminalAgentState(session.state));
  const healthyConnections = connections.filter(connection => connectionChecks[connection.id]?.status !== 'error').length;
  const recentProjects = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const recentSessions = sessions.slice(0, 4);
  const [runtime, setRuntime] = useState<{ agents: number; skills: number }>();
  useEffect(() => { void window.praxis.agentRuntime.list().then(snapshot => setRuntime({ agents: snapshot.agents.length, skills: snapshot.skills.length })).catch(() => setRuntime({ agents: 0, skills: 0 })); }, []);

  return (
    <div className="overview-page" data-testid="overview-page">
      <header className="overview-hero">
        <div><div className="eyebrow">Workspace overview</div><h1>Good to see you.</h1><p>Keep projects, tickets, and AI work moving from one place.</p></div>
        <div className="overview-actions"><button className="btn" type="button" onClick={onNewProject}><Icon name="plus" size={14} /> New project</button><button className="btn btn-primary" type="button" onClick={onNewSession}><Icon name="robot" size={14} /> New session</button></div>
      </header>

      <section className="overview-stat-grid" aria-label="Workspace summary">
        <OverviewStat icon="folder-open" label="Projects" value={projects.length} detail={projects.length ? 'Configured workspaces' : 'Create your first project'} onClick={onOpenProjects} />
        <OverviewStat icon="columns" label="Boards" value={boards.length} detail="Available board views" />
        <OverviewStat icon="robot" label="Active sessions" value={activeSessions.length} detail={activeSessions.length ? 'AI work in progress' : 'No sessions running'} onClick={onOpenSessions} tone={activeSessions.length ? 'accent' : undefined} />
        <OverviewStat icon="plug" label="Connections" value={connections.length} detail={`${healthyConnections} available`} onClick={onOpenConnections} tone={connections.some(connection => connectionChecks[connection.id]?.status === 'error') ? 'warning' : undefined} />
      </section>

      {projects.length === 0 && sessions.length === 0 && <section className="overview-starter-strip" aria-label="Getting started">
        <div className="overview-starter-heading"><span className="eyebrow">Start here</span><strong>Build your workspace in three steps</strong><small>Everything you need to move from an idea to visible delivery progress.</small></div>
        <button className="overview-starter-card starter-project" type="button" onClick={onNewProject}><span className="overview-starter-number">01</span><span className="overview-starter-art"><Icon name="folder-open" size={24} /></span><strong>Create a project</strong><small>Set a brief, board, and starter work.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-connection" type="button" onClick={onOpenConnections}><span className="overview-starter-number">02</span><span className="overview-starter-art"><Icon name="plug" size={24} /></span><strong>Connect your tracker</strong><small>Bring tickets into one workspace.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-session" type="button" onClick={onNewSession}><span className="overview-starter-number">03</span><span className="overview-starter-art"><Icon name="robot" size={24} /></span><strong>Start an AI session</strong><small>Turn a ticket into visible progress.</small><Icon name="chevron-right" size={15} /></button>
      </section>}

      <div className="overview-columns">
        <section className="overview-panel overview-sessions"><PanelHeading title="Active AI sessions" action={activeSessions.length ? 'View all' : undefined} onAction={onOpenSessions} />
          {activeSessions.length === 0 ? <><div className="overview-session-preview-grid"><PreviewSessionCard tone="blue" title="Plan your next change" detail="Start with a ticket and let the agent map the work." onOpen={onNewSession} /><PreviewSessionCard tone="purple" title="Build with confidence" detail="Follow approvals, tools, and progress in one session." onOpen={onNewSession} /><PreviewSessionCard tone="green" title="Review the outcome" detail="Keep delivery, tests, and feedback visible." onOpen={onOpenSessions} /></div><EmptyOverview icon="robot" text="No active sessions yet." action="New session" onAction={onNewSession} /></> : activeSessions.map(session => <SessionCard key={session.issueKey} session={session} onOpen={() => onOpenSessions()} />)}
        </section>
        <section className="overview-panel"><PanelHeading title="Recent projects" action={projects.length ? 'View projects' : undefined} onAction={onOpenProjects} />
          {recentProjects.length === 0 ? <EmptyOverview icon="folder-open" text="Create a project to get a brief, board, and starter work items." action="Create project" onAction={onNewProject} /> : <div className="overview-project-grid">{recentProjects.map((project, index) => <button className={`overview-project-card project-tone-${index % 4}`} key={project.id} type="button" onClick={() => onOpenProject(project)}><span className="overview-project-art"><Icon name="folder-open" size={18} /></span><span className="overview-project-copy"><strong>{project.name}</strong><small>{project.key} · {project.type}</small></span><span className="overview-project-arrow"><Icon name="chevron-right" size={14} /></span><span className="overview-project-meter"><i style={{ width: `${42 + index * 15}%` }} /></span></button>)}</div>}
        </section>
      </div>

      <section className="overview-panel overview-activity"><PanelHeading title="Recent activity" action={recentSessions.length ? 'Open sessions' : undefined} onAction={onOpenSessions} />
        {recentSessions.length === 0 ? <EmptyOverview icon="zap" text="Session activity will appear here as you work." /> : <div className="overview-activity-list">{recentSessions.map((session, index) => <div className="overview-activity-row" key={session.issueKey}><span className={`overview-activity-marker overview-status-${session.state}`}><Icon name={index === 0 ? 'robot' : 'check-square'} size={12} /></span><span><strong>{session.title || session.issueKey}</strong><small>{stateLabel[session.state]} · {new Date(session.startedAt).toLocaleString()}</small></span><button className="btn btn-quiet" type="button" onClick={onOpenSessions}>Open</button></div>)}</div>}
      </section>

      <div className="overview-columns overview-lower-grid">
        <section className="overview-panel"><PanelHeading title="Delivery worktrees" action={sessions.some(session => session.delivery) ? 'View sessions' : undefined} onAction={onOpenSessions} />
          {sessions.some(session => session.delivery) ? <div className="overview-delivery-list">{sessions.filter(session => session.delivery).slice(0, 4).map(session => <DeliveryCard key={session.issueKey} session={session} onOpen={onOpenSessions} />)}</div> : <EmptyOverview icon="git-branch" text="Delivery branches and merge requests will appear here when an implementation starts." action="Open sessions" onAction={onOpenSessions} />}
        </section>
        <section className="overview-panel"><PanelHeading title="Workspace health" action={connections.length ? 'Connections' : undefined} onAction={onOpenConnections} />
          {connections.length === 0 ? <EmptyOverview icon="plug" text="Connect a tracker to monitor workspace health." action="Connections" onAction={onOpenConnections} /> : <div className="overview-health-list">{connections.slice(0, 5).map(connection => { const check = connectionChecks[connection.id]; const status = check?.status === 'error' ? 'Unavailable' : check?.status === 'ok' ? 'Healthy' : 'Not checked'; const width = check?.status === 'error' ? 28 : check?.status === 'ok' ? 100 : 58; return <div className="overview-health-card" key={connection.id}><div className="overview-health-row"><span className={`overview-health-dot ${check?.status === 'error' ? 'error' : check?.status === 'ok' ? 'ok' : ''}`} /><span><strong>{connection.name}</strong><small>{connection.mode} · {status}</small></span><Icon name="chevron-right" size={14} /></div><div className="overview-health-bar"><i style={{ width: `${width}%` }} /></div></div>; })}</div>}
          <div className="overview-runtime-widget"><span className="overview-runtime-icon"><Icon name="zap" size={15} /></span><span><strong>Agent runtime</strong><small>{runtime ? `${runtime.agents} hosts · ${runtime.skills} skills indexed` : 'Checking hosts and skills…'}</small></span><span className="overview-health-dot ok" /></div>
        </section>
      </div>

      <section className="overview-panel overview-boards"><PanelHeading title="Boards" action={boards.length ? 'Open a board' : undefined} onAction={() => boards[0] && onOpenBoard(boards[0])} />
{boards.length === 0 ? <EmptyOverview icon="columns" text="Boards from your connections will appear here." action="Connections" onAction={onOpenConnections} /> : <div className="overview-board-grid">{boards.slice(0, 6).map((board, index) => <button className={`overview-board-card board-tone-${index % 4}`} data-testid="board-nav-item" type="button" key={`${board.connectionId ?? 'demo'}:${board.id}`} onClick={() => onOpenBoard(board)}><span className="overview-board-art"><Icon name="columns" size={17} /></span><span><strong>{board.name}</strong><small>{board.connectionId ? connections.find(connection => connection.id === board.connectionId)?.name ?? 'Connection' : 'Demo board'}</small></span><span className="overview-board-count">{index + 3}<small>views</small></span></button>)}</div>}
      </section>
    </div>
  );
}

function OverviewStat({ icon, label, value, detail, onClick, tone }: { icon: 'folder-open' | 'columns' | 'robot' | 'plug'; label: string; value: number; detail: string; onClick?: () => void; tone?: 'accent' | 'warning' }) {
  const content = <><span className={`overview-stat-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></>;
  return onClick ? <button className="overview-stat" type="button" onClick={onClick}>{content}<Icon name="chevron-right" size={15} /></button> : <div className="overview-stat">{content}</div>;
}
function PanelHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className="overview-panel-heading"><h2>{title}</h2>{action && <button className="btn btn-quiet" type="button" onClick={onAction}>{action} <Icon name="chevron-right" size={13} /></button>}</div>; }
function EmptyOverview({ icon, text, action, onAction }: { icon: 'robot' | 'folder-open' | 'zap' | 'columns' | 'git-branch' | 'plug'; text: string; action?: string; onAction?: () => void }) { return <div className="overview-empty"><Icon name={icon} size={22} /><span>{text}</span>{action && <button className="btn" type="button" onClick={onAction}>{action}</button>}</div>; }
function SessionCard({ session, onOpen }: { session: AgentSessionRecord; onOpen: () => void }) { const progress = session.state === 'planning' ? 35 : session.state === 'awaiting_approval' ? 55 : 78; return <button className={`overview-session-card overview-session-${session.provider ?? 'agent'}`} type="button" onClick={onOpen}><div className="overview-session-card-top"><span className={`overview-status-dot overview-status-${session.state}`} /><strong>{session.title || session.issueKey}</strong><span className="overview-session-state">{stateLabel[session.state]}</span></div><small>{session.provider ?? 'Agent'} · Started {new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><div className="overview-timeline"><span className="timeline-node done" /><span className="timeline-line done" /><span className={`timeline-node ${progress >= 35 ? 'done' : ''}`} /><span className={`timeline-line ${progress >= 55 ? 'done' : ''}`} /><span className={`timeline-node ${progress >= 55 ? 'done' : ''}`} /><span className={`timeline-line ${progress >= 78 ? 'done' : ''}`} /><span className={`timeline-node ${progress >= 78 ? 'done' : ''}`} /></div><div className="overview-progress"><span style={{ width: `${progress}%` }} /></div></button>; }
function PreviewSessionCard({ tone, title, detail, onOpen }: { tone: 'blue' | 'purple' | 'green'; title: string; detail: string; onOpen: () => void }) { return <button className={`overview-session-preview preview-${tone}`} type="button" onClick={onOpen}><div className="preview-card-heading"><span className="overview-status-dot" /><strong>{title}</strong><span className="preview-ready">Ready</span></div><div className="preview-steps"><span className="done" /><i /><span /><i /><span /><i /><span /></div><small>{detail}</small><div className="preview-sparkline"><b /><b /><b /><b /><b /><b /><b /></div><span className="preview-card-action">Open session <Icon name="chevron-right" size={13} /></span></button>; }
function DeliveryCard({ session, onOpen }: { session: AgentSessionRecord; onOpen: () => void }) { const delivery = session.delivery!; const phase = delivery.phase.replaceAll('-', ' '); return <button className="overview-delivery-card" type="button" onClick={onOpen}><div className="overview-delivery-heading"><Icon name="git-branch" size={15} /><strong>{session.issueKey}</strong><span>{phase}</span></div><small>{delivery.createdBranch || delivery.worktreeName || 'Worktree pending'}</small><div className="overview-delivery-steps"><span className="done">Plan</span><span className={delivery.phase === 'analysis' ? 'current' : 'done'}>Implement</span><span className={delivery.mergeRequest ? 'current' : ''}>Review</span><span>Merge</span></div></button>; }
