import { useState } from 'react';
import type { AgentSessionRecord, ProjectRecord } from '@praxis/core';
import { PROJECT_BRIEF_FIELDS } from './projectBriefFields';
import { Icon } from '../ui/Icon';
import { agentStateLabel, isTerminalAgentState } from '../ai/aiSessionState';

function relativeDate(value: string | undefined): string {
  if (!value) return 'No activity yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No activity yet';
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isComplete(status: string): boolean {
  const value = status.toLowerCase();
  return value.includes('done') || value.includes('complete');
}

const dismissedKey = (id: string) => `praxis-project-getstarted-dismissed:${id}`;

export function ProjectWorkspace({ project, sessions, onStartSession, onStartTour }: { project: ProjectRecord; sessions: AgentSessionRecord[]; onStartSession: () => void; onStartTour: () => void }) {
  const [getStartedDismissed, setGetStartedDismissed] = useState(() => { try { return localStorage.getItem(dismissedKey(project.id)) === '1'; } catch { return false; } });
  const dismissGetStarted = () => { setGetStartedDismissed(true); try { localStorage.setItem(dismissedKey(project.id), '1'); } catch { /* private mode */ } };
  const projectKeys = new Set(project.workItems.map(item => item.key));
  const projectSessions = sessions.filter(session => projectKeys.has(session.issueKey) || Boolean(project.workspaceFolder && session.workingDirectory === project.workspaceFolder));
  const activeSessions = projectSessions.filter(session => !isTerminalAgentState(session.state));
  const completedItems = project.workItems.filter(item => isComplete(item.status)).length;
  const briefFields = PROJECT_BRIEF_FIELDS[project.type];
  const completedBrief = briefFields.filter(field => Boolean(project.brief[field.key]?.trim())).length;
  const totalSteps = projectSessions.reduce((sum, session) => sum + session.stepCount, 0);
  const latestItem = [...project.workItems].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const latestSession = [...projectSessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const lastActivity = [project.updatedAt, latestItem?.updatedAt, latestSession?.startedAt].filter(Boolean).sort().at(-1);
  const statusCounts = project.workflowStages.map((stage, index) => ({
    name: stage.name,
    count: project.workItems.filter(item => item.status.toLowerCase() === stage.name.toLowerCase()).length,
    // Position through the pipeline, 0 at the first stage and 1 at the last —
    // used to shade each segment from muted (not started) to accent (done), so
    // the bar reads as "how far right has the work moved", not "how full".
    position: project.workflowStages.length > 1 ? index / (project.workflowStages.length - 1) : 1
  }));
  const totalItems = project.workItems.length;
  const percentComplete = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;
  const activity = [
    ...project.workItems.map(item => ({ date: item.updatedAt, icon: isComplete(item.status) ? 'check-square' as const : 'ticket' as const, title: item.summary, detail: `${item.key} · ${item.status}` })),
    ...projectSessions.map(session => ({ date: session.startedAt, icon: 'chats' as const, title: session.title || session.issueKey, detail: `AI session · ${agentStateLabel(session.state)}` }))
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  return <main className="project-dashboard" data-testid="project-dashboard">
    <header className="project-dashboard-header">
      <div><span className="project-type-badge">{project.type}</span><h1>{project.name}</h1><p>{project.key} · {project.purpose || 'A focused project space for planning, delivery, and learning.'}</p></div>
      <div className="project-dashboard-updated"><span>LAST ACTIVITY</span><strong>{relativeDate(lastActivity)}</strong></div>
    </header>

    {projectSessions.length === 0 && !getStartedDismissed && (
      <section className="project-getstarted" aria-label="Get started" data-testid="project-getstarted">
        <div className="project-getstarted-copy">
          <span className="git-eyebrow">GET STARTED</span>
          <h2>Turn this project into progress</h2>
          <ol className="project-getstarted-steps">
            <li className="is-done"><Icon name="check" size={13} /> Project created</li>
            <li className={completedBrief > 0 ? 'is-done' : undefined}><Icon name={completedBrief > 0 ? 'check' : 'dot'} size={13} /> Brief drafted <em>{completedBrief}/{briefFields.length} sections</em></li>
            <li><Icon name="dot" size={13} /> Start your first session</li>
          </ol>
        </div>
        <div className="project-getstarted-actions">
          <button type="button" className="btn btn-primary" data-testid="project-getstarted-start" onClick={onStartSession}><Icon name="chats" size={14} /> Start a session</button>
          <button type="button" className="btn-quiet" data-testid="project-getstarted-tour" onClick={onStartTour}>Take a tour</button>
          <button type="button" className="btn-quiet" onClick={dismissGetStarted}>Dismiss</button>
        </div>
      </section>
    )}

    <section className="project-dashboard-metrics" aria-label="Project health">
      <article><span className="project-dashboard-metric-icon"><Icon name="ticket" size={16} /></span><div><small>WORK ITEMS</small><strong>{project.workItems.length}</strong><em>{completedItems} complete</em></div></article>
      <article><span className="project-dashboard-metric-icon"><Icon name="target" size={16} /></span><div><small>BRIEF READY</small><strong>{completedBrief}/{briefFields.length}</strong><em>{completedBrief === briefFields.length ? 'Fully shaped' : 'Sections answered'}</em></div></article>
      <article><span className="project-dashboard-metric-icon"><Icon name="chats" size={16} /></span><div><small>SESSIONS</small><strong>{projectSessions.length}</strong><em>{activeSessions.length ? `${activeSessions.length} active now` : 'No active sessions'}</em></div></article>
      <article><span className="project-dashboard-metric-icon"><Icon name="zap" size={16} /></span><div><small>AI STEPS</small><strong>{totalSteps.toLocaleString()}</strong><em>{project.defaultAiToolMode === 'project-only' ? 'Project tools' : 'Configured tools'}</em></div></article>
    </section>

    <div className="project-dashboard-grid">
      <section className="project-dashboard-card project-dashboard-progress" aria-labelledby="project-progress-title"><div className="project-dashboard-card-heading"><div><span className="git-eyebrow">MOMENTUM</span><h2 id="project-progress-title">Work progress</h2></div><span>{completedItems}/{totalItems} complete{totalItems ? ` · ${percentComplete}%` : ''}</span></div>{totalItems === 0 ? <p className="project-dashboard-empty">Work items will appear here as the project takes shape.</p> : <><div className="project-dashboard-flow" role="img" aria-label={statusCounts.map(item => `${item.name} ${item.count}`).join(', ')}>{statusCounts.filter(item => item.count > 0).map(item => <span key={item.name} className="project-dashboard-flow-seg" style={{ flexGrow: item.count, background: `color-mix(in srgb, var(--accent) ${Math.round(20 + item.position * 80)}%, var(--bg-sunken))` }} />)}</div><ul className="project-dashboard-flow-legend">{statusCounts.map(item => <li key={item.name} className={item.count ? undefined : 'is-empty'}><span className="project-dashboard-flow-key" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(20 + item.position * 80)}%, var(--bg-sunken))` }} />{item.name}<strong>{item.count}</strong></li>)}</ul></>}</section>
      <section className="project-dashboard-card project-dashboard-brief" aria-labelledby="project-brief-title"><div className="project-dashboard-card-heading"><div><span className="git-eyebrow">NORTH STAR</span><h2 id="project-brief-title">Project brief</h2></div><span>{completedBrief}/{briefFields.length}</span></div><p>{project.purpose || 'Add a purpose in project details to keep the team aligned.'}</p><div className="project-dashboard-brief-list">{briefFields.slice(0, 4).map(field => <div key={field.key}><span className={project.brief[field.key]?.trim() ? 'is-ready' : undefined}><Icon name={project.brief[field.key]?.trim() ? 'check' : 'dot'} size={12} /></span><strong>{field.label}</strong><small>{project.brief[field.key]?.trim() || 'Not answered yet'}</small></div>)}</div></section>
      <section className="project-dashboard-card project-dashboard-activity" aria-labelledby="project-activity-title"><div className="project-dashboard-card-heading"><div><span className="git-eyebrow">SIGNALS</span><h2 id="project-activity-title">Recent activity</h2></div><span>{activity.length ? 'Latest' : 'Waiting'}</span></div>{activity.length ? <div className="project-dashboard-activity-list">{activity.map(item => <div key={`${item.date}-${item.title}`}><span><Icon name={item.icon} size={13} /></span><div><strong>{item.title}</strong><small>{item.detail}</small></div><time>{relativeDate(item.date)}</time></div>)}</div> : <p className="project-dashboard-empty">No project activity yet. Start with a work item or an AI session.</p>}</section>
      <section className="project-dashboard-card project-dashboard-sessions" aria-labelledby="project-sessions-title"><div className="project-dashboard-card-heading"><div><span className="git-eyebrow">RUNTIME</span><h2 id="project-sessions-title">Sessions</h2></div><span>{activeSessions.length ? `${activeSessions.length} active` : 'Quiet'}</span></div>{projectSessions.length ? <div className="project-dashboard-session-list">{projectSessions.slice(0, 4).map(session => <div key={session.sessionId}><span className={isTerminalAgentState(session.state) ? undefined : 'is-live'}><Icon name="chats" size={13} /></span><div><strong>{session.title || session.issueKey}</strong><small>{agentStateLabel(session.state)} · {session.stepCount} steps</small></div><time>{relativeDate(session.startedAt)}</time></div>)}</div> : <div className="project-dashboard-empty project-dashboard-empty-session"><Icon name="chats" size={22} /><p>Sessions will show up here when work begins.</p></div>}</section>
    </div>
  </main>;
}
