import { useEffect, useState } from 'react';
import type { AgentSessionRecord, Board, Connection, ConnectionCheck, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { isConversationSession } from '../ai/sessionNav';
import { AiUsageDashboardPanel } from './AiUsageDashboardPanel';
import { WorkspaceActivityHeatmap } from './WorkspaceActivityHeatmap';

interface OverviewPageProps {
  projects: ProjectRecord[];
  connections: Connection[];
  sessions: AgentSessionRecord[];
  connectionChecks: Record<string, ConnectionCheck | undefined>;
  onNewProject: () => void;
  onNewSession: () => void;
  /** Opens the lightweight "New conversation" composer (FX-BE-142). */
  onNewConversation: () => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenConnections: () => void;
  /** Opens Settings → AI Usage. */
  onOpenAiUsage: () => void;
  onOpenBoard: (board: Board) => void;
}

const stateLabel: Record<AgentSessionRecord['state'], string> = {
  not_started: 'Not started', planning: 'Planning', awaiting_approval: 'Awaiting approval', executing: 'Executing',
  awaiting_input: 'Awaiting input', paused: 'Paused', completed: 'Completed', failed: 'Failed', aborted: 'Aborted'
};

export function OverviewPage({ projects, connections, sessions, connectionChecks, onNewProject, onNewSession, onNewConversation, onOpenProjects, onOpenSessions, onOpenConnections, onOpenAiUsage, onOpenBoard }: OverviewPageProps) {
  const recentSessions = sessions.filter(session => !isConversationSession(session)).slice(0, 4);
  const [runtime, setRuntime] = useState<{ profiles: number; hosts: number; skills: number }>();
  useEffect(() => { void window.praxis.agentRuntime.list().then(snapshot => setRuntime({ profiles: snapshot.profiles?.length ?? 0, hosts: (snapshot.runtimeHosts ?? snapshot.agents).length, skills: snapshot.skills.length })).catch(() => setRuntime({ profiles: 0, hosts: 0, skills: 0 })); }, []);

  return (
    <div className="overview-page" data-testid="overview-page">
      <header className="overview-hero">
        <div><div className="eyebrow">Workspace overview</div><h1>Good to see you.</h1><p>Keep projects, tickets, and AI work moving from one place.</p></div>
        <div className="overview-actions"><button className="btn" type="button" onClick={onNewProject}><Icon name="plus" size={14} /> Add project</button><button className="btn" type="button" onClick={onNewSession}><Icon name="robot" size={14} /> New session</button><button className="btn btn-primary" type="button" onClick={onNewConversation}><Icon name="chats" size={14} /> New conversation</button></div>
      </header>

      {projects.length === 0 && sessions.filter(session => !isConversationSession(session)).length === 0 && <section className="overview-starter-strip" aria-label="Getting started">
        <div className="overview-starter-heading"><span className="eyebrow">Start here</span><strong>Build your workspace in three steps</strong><small>Everything you need to move from an idea to visible delivery progress.</small></div>
        <button className="overview-starter-card starter-project" type="button" onClick={onNewProject}><span className="overview-starter-number">01</span><span className="overview-starter-art"><Icon name="folder-open" size={24} /></span><strong>Add a project</strong><small>Open a folder, create one, or start without files.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-connection" type="button" onClick={onOpenConnections}><span className="overview-starter-number">02</span><span className="overview-starter-art"><Icon name="plug" size={24} /></span><strong>Connect your tracker</strong><small>Bring tickets into one workspace.</small><Icon name="chevron-right" size={15} /></button>
        <button className="overview-starter-card starter-session" type="button" onClick={onNewSession}><span className="overview-starter-number">03</span><span className="overview-starter-art"><Icon name="robot" size={24} /></span><strong>Start an AI session</strong><small>Turn a ticket into visible progress.</small><Icon name="chevron-right" size={15} /></button>
      </section>}

      <AiUsageDashboardPanel onOpenDetails={onOpenAiUsage} onNewConversation={onNewConversation} />

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

function PanelHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className="overview-panel-heading"><h2>{title}</h2>{action && <button className="btn btn-quiet" type="button" onClick={onAction}>{action} <Icon name="chevron-right" size={13} /></button>}</div>; }
function EmptyOverview({ icon, text, action, onAction }: { icon: 'robot' | 'folder-open' | 'zap' | 'columns' | 'git-branch' | 'plug'; text: string; action?: string; onAction?: () => void }) { return <div className="overview-empty"><Icon name={icon} size={22} /><span>{text}</span>{action && <button className="btn" type="button" onClick={onAction}>{action}</button>}</div>; }
