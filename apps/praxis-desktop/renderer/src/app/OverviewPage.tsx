import { useEffect, useState } from 'react';
import type { AgentSessionRecord, Board, Connection, ConnectionCheck, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { isTerminalAgentState } from '../ai/aiSessionState';
import { isConversationSession } from '../ai/sessionNav';
import { AiUsageDashboardPanel } from './AiUsageDashboardPanel';
import { WorkspaceActivityHeatmap } from './WorkspaceActivityHeatmap';

interface OverviewPageProps {
  projects: ProjectRecord[];
  boards: Board[];
  connections: Connection[];
  sessions: AgentSessionRecord[];
  connectionChecks: Record<string, ConnectionCheck | undefined>;
  onNewProject: () => void;
  onNewSession: () => void;
  /** Opens the lightweight "New conversation" composer (FX-BE-142). */
  onNewConversation: () => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  /** Opens Conversations, optionally to one conversation directly. */
  onOpenConversations: (sessionKey?: string) => void;
  onOpenConnections: () => void;
  /** Opens Settings → AI Usage. */
  onOpenAiUsage: () => void;
  onOpenBoard: (board: Board) => void;
  onOpenProject: (project: ProjectRecord) => void;
}

const stateLabel: Record<AgentSessionRecord['state'], string> = {
  not_started: 'Not started', planning: 'Planning', awaiting_approval: 'Awaiting approval', executing: 'Executing',
  awaiting_input: 'Awaiting input', paused: 'Paused', completed: 'Completed', failed: 'Failed', aborted: 'Aborted'
};

export function OverviewPage({ projects, boards, connections, sessions, connectionChecks, onNewProject, onNewSession, onNewConversation, onOpenProjects, onOpenSessions, onOpenConversations, onOpenConnections, onOpenAiUsage, onOpenBoard, onOpenProject }: OverviewPageProps) {
  const activeSessions = sessions.filter(session => !isTerminalAgentState(session.state) && !isConversationSession(session));
  const healthyConnections = connections.filter(connection => connectionChecks[connection.id]?.status !== 'error').length;
  const recentProjects = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const recentSessions = sessions.filter(session => !isConversationSession(session)).slice(0, 4);
  const recentConversations = sessions.filter(isConversationSession).slice(0, 4);
  const [runtime, setRuntime] = useState<{ profiles: number; hosts: number; skills: number }>();
  useEffect(() => { void window.praxis.agentRuntime.list().then(snapshot => setRuntime({ profiles: snapshot.profiles?.length ?? 0, hosts: (snapshot.runtimeHosts ?? snapshot.agents).length, skills: snapshot.skills.length })).catch(() => setRuntime({ profiles: 0, hosts: 0, skills: 0 })); }, []);

  return (
    <div className="overview-page" data-testid="overview-page">
      <header className="overview-hero">
        <div><div className="eyebrow">Workspace overview</div><h1>Good to see you.</h1><p>Keep projects, tickets, and AI work moving from one place.</p></div>
        <div className="overview-actions"><button className="btn" type="button" onClick={onNewProject}><Icon name="plus" size={14} /> Add project</button><button className="btn" type="button" onClick={onNewSession}><Icon name="robot" size={14} /> New session</button><button className="btn btn-primary" type="button" onClick={onNewConversation}><Icon name="chats" size={14} /> New conversation</button></div>
      </header>

      <section className="overview-stat-grid" aria-label="Workspace summary">
        <OverviewStat icon="folder-open" label="Projects" value={projects.length} detail={projects.length ? 'Configured workspaces' : 'Create your first project'} onClick={onOpenProjects} />
        <OverviewStat icon="columns" label="Boards" value={boards.length} detail="Available board views" />
        <OverviewStat icon="robot" label="Active sessions" value={activeSessions.length} detail={activeSessions.length ? 'AI work in progress' : 'No sessions running'} onClick={onOpenSessions} tone={activeSessions.length ? 'accent' : undefined} />
        <OverviewStat icon="plug" label="Connections" value={connections.length} detail={`${healthyConnections} available`} onClick={onOpenConnections} tone={connections.some(connection => connectionChecks[connection.id]?.status === 'error') ? 'warning' : undefined} />
      </section>

      {projects.length === 0 && sessions.filter(session => !isConversationSession(session)).length === 0 && <section className="overview-starter-strip" aria-label="Getting started">
        <div className="overview-starter-heading"><span className="eyebrow">Start here</span><strong>Build your workspace in three steps</strong><small>Everything you need to move from an idea to visible delivery progress.</small></div>
        <button className="overview-starter-card starter-project" type="button" onClick={onNewProject}><span className="overview-starter-number">01</span><span className="overview-starter-art"><Icon name="folder-open" size={24} /></span><strong>Add a project</strong><small>Open a folder, create one, or start without files.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-connection" type="button" onClick={onOpenConnections}><span className="overview-starter-number">02</span><span className="overview-starter-art"><Icon name="plug" size={24} /></span><strong>Connect your tracker</strong><small>Bring tickets into one workspace.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-session" type="button" onClick={onNewSession}><span className="overview-starter-number">03</span><span className="overview-starter-art"><Icon name="robot" size={24} /></span><strong>Start an AI session</strong><small>Turn a ticket into visible progress.</small><Icon name="chevron-right" size={15} /></button>
      </section>}

      <AiUsageDashboardPanel onOpenDetails={onOpenAiUsage} onNewConversation={onNewConversation} />

      <div className="overview-columns overview-columns-3">
        <section className="overview-panel overview-sessions"><PanelHeading title="Active AI sessions" action={activeSessions.length ? 'View all' : undefined} onAction={onOpenSessions} />
          {activeSessions.length === 0 ? <div className="overview-empty overview-empty-sessions" data-testid="overview-sessions-empty"><Icon name="robot" size={22} /><span>No active sessions yet.<small>A session turns a ticket into visible progress: the agent plans the work, asks before it uses a tool, and reports what it changed.</small></span><button className="btn btn-primary" type="button" onClick={onNewSession}>New session</button></div> : activeSessions.map(session => <SessionCard key={session.issueKey} session={session} onOpen={() => onOpenSessions()} />)}
        </section>
        <section className="overview-panel overview-conversations"><PanelHeading title="Recent conversations" action={recentConversations.length ? 'View all' : undefined} onAction={() => onOpenConversations()} />
          {recentConversations.length === 0 ? <div className="overview-empty overview-empty-sessions" data-testid="overview-conversations-empty"><Icon name="chats" size={22} /><span>No conversations yet.<small>Talk to the AI with no project or ticket required — brainstorm, ask questions, or think something through.</small></span><button className="btn btn-primary" type="button" onClick={onNewConversation}>New conversation</button></div> : <div className="overview-activity-list">{recentConversations.map(session => <div className="overview-activity-row" key={session.issueKey}><span className={`overview-activity-marker overview-status-${session.state}`} role="img" aria-label={`Status: ${stateLabel[session.state]}`} title={stateLabel[session.state]}><Icon name="chats" size={12} /></span><span><strong>{session.title || 'Conversation'}</strong><small>{new Date(session.startedAt).toLocaleString()}</small></span><button className="btn btn-quiet" type="button" onClick={() => onOpenConversations(session.issueKey)}>Open</button></div>)}</div>}
        </section>
        <section className="overview-panel"><PanelHeading title="Recent projects" action={projects.length ? 'View projects' : undefined} onAction={onOpenProjects} />
          {recentProjects.length === 0 ? <EmptyOverview icon="folder-open" text="Add a project from a folder, create a new folder, or start without files." action="Add project" onAction={onNewProject} /> : <div className="overview-project-grid">{recentProjects.map((project, index) => <button className={`overview-project-card project-tone-${index % 4}`} key={project.id} type="button" onClick={() => onOpenProject(project)}><span className="overview-project-art"><Icon name="folder-open" size={18} /></span><span className="overview-project-copy"><strong>{project.name}</strong><small>{project.key} · {project.type}</small></span><span className="overview-project-arrow"><Icon name="chevron-right" size={14} /></span></button>)}</div>}
        </section>
      </div>

      <div className="overview-columns overview-columns-activity">
        <section className="overview-panel overview-activity"><PanelHeading title="Recent activity" action={recentSessions.length ? 'Open sessions' : undefined} onAction={onOpenSessions} />
          {recentSessions.length === 0 ? <EmptyOverview icon="zap" text="Session activity will appear here as you work." /> : <div className="overview-activity-list">{recentSessions.map((session, index) => <div className="overview-activity-row" key={session.issueKey}><span className={`overview-activity-marker overview-status-${session.state}`} role="img" aria-label={`Status: ${stateLabel[session.state]}`} title={stateLabel[session.state]}><Icon name={index === 0 ? 'robot' : 'check-square'} size={12} /></span><span><strong>{session.title || session.issueKey}</strong><small>{new Date(session.startedAt).toLocaleString()}</small></span><button className="btn btn-quiet" type="button" onClick={onOpenSessions}>Open</button></div>)}</div>}
        </section>

        <WorkspaceActivityHeatmap
          sessions={sessions}
          connections={connections}
          connectionChecks={connectionChecks}
          runtime={runtime}
          onOpenConnections={onOpenConnections}
        />
      </div>
    </div>
  );
}

function OverviewStat({ icon, label, value, detail, onClick, tone }: { icon: 'folder-open' | 'columns' | 'robot' | 'plug'; label: string; value: number; detail: string; onClick?: () => void; tone?: 'accent' | 'warning' }) {
  const content = <><span className={`overview-stat-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></>;
  return onClick ? <button className="overview-stat" type="button" onClick={onClick}>{content}<Icon name="chevron-right" size={15} /></button> : <div className="overview-stat">{content}</div>;
}
function PanelHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className="overview-panel-heading"><h2>{title}</h2>{action && <button className="btn btn-quiet" type="button" onClick={onAction}>{action} <Icon name="chevron-right" size={13} /></button>}</div>; }
function EmptyOverview({ icon, text, action, onAction }: { icon: 'robot' | 'folder-open' | 'zap' | 'columns' | 'git-branch' | 'plug'; text: string; action?: string; onAction?: () => void }) { return <div className="overview-empty"><Icon name={icon} size={22} /><span>{text}</span>{action && <button className="btn" type="button" onClick={onAction}>{action}</button>}</div>; }
function SessionCard({ session, onOpen }: { session: AgentSessionRecord; onOpen: () => void }) { const progress = session.state === 'planning' ? 35 : session.state === 'awaiting_approval' ? 55 : 78; return <button className={`overview-session-card overview-session-${session.provider ?? 'agent'}`} type="button" onClick={onOpen}><div className="overview-session-card-top"><span className={`overview-status-dot overview-status-${session.state}`} role="img" aria-label={`Status: ${stateLabel[session.state]}`} title={stateLabel[session.state]} /><strong>{session.title || session.issueKey}</strong></div><small>{session.provider ?? 'Agent'} · Started {new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><div className="overview-timeline"><span className="timeline-node done" /><span className="timeline-line done" /><span className={`timeline-node ${progress >= 35 ? 'done' : ''}`} /><span className={`timeline-line ${progress >= 55 ? 'done' : ''}`} /><span className={`timeline-node ${progress >= 55 ? 'done' : ''}`} /><span className={`timeline-line ${progress >= 78 ? 'done' : ''}`} /><span className={`timeline-node ${progress >= 78 ? 'done' : ''}`} /></div><div className="overview-progress"><span style={{ width: `${progress}%` }} /></div></button>; }
