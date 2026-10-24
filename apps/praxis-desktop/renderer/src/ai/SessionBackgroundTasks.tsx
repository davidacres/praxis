import { useEffect, useState } from 'react';
import type { AgentSessionRecord, BackgroundTaskState } from '@praxis/core';
import { Icon } from '../ui/Icon';
import './sessionBackgroundTasks.css';

const LABEL: Record<BackgroundTaskState, string> = {
  running: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed',
  stopped: 'Stopped', exited: 'Exited · result unavailable', unknown: 'Status unknown'
};

export function SessionBackgroundTasks({ session }: { session: AgentSessionRecord }) {
  const tasks = session.backgroundTasks ?? [];
  const running = tasks.filter(task => task.state === 'running').length;
  const paused = tasks.filter(task => task.state === 'paused').length;
  const unknown = tasks.filter(task => task.state === 'unknown').length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running && !paused) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, paused]);
  if (!tasks.length) return null;
  return (
    <details className="session-background-tasks" open data-testid="session-background-tasks">
      <summary>
        <Icon name="terminal" size={14} />
        <strong>Background tasks</strong>
        <span role="status">{[running ? `${running} running` : '', paused ? `${paused} paused` : '', unknown ? `${unknown} status unknown` : ''].filter(Boolean).join(' · ') || 'All tracked tasks finished'}</span>
      </summary>
      {session.state === 'completed' && (running > 0 || paused > 0) && <p>The AI turn finished. Background work is {running > 0 ? 'still running' : 'paused'}.</p>}
      <ul>
        {[...tasks].sort((a, b) => Number(b.state === 'running' || b.state === 'paused' || b.state === 'unknown') - Number(a.state === 'running' || a.state === 'paused' || a.state === 'unknown')).map(task => {
          const end = task.completedAt ? Date.parse(task.completedAt) : now;
          const seconds = Math.max(0, Math.floor((end - Date.parse(task.startedAt)) / 1000));
          return <li key={task.id} data-state={task.state} data-testid="session-background-task">
            <div className="session-background-task-heading">
              <strong>{task.label}</strong>
              <span className="session-background-task-state">{LABEL[task.state] ?? 'Status unknown'}</span>
              {(task.state === 'running' || task.completedAt) && Number.isFinite(seconds) && <span>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>}
            </div>
            {task.detail && <p>{task.detail}</p>}
          </li>;
        })}
      </ul>
      <p className="session-background-task-note">Tracks work reported by the provider or observed through Praxis shell tools. An unknown status does not mean the task finished.</p>
    </details>
  );
}
