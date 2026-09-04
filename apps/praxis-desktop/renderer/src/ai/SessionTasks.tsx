import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * The agent's self-reported task list, in the sessions inspector.
 *
 * Lives in the right pane rather than the transcript on purpose: the
 * transcript scrolls as new turns and tool calls arrive, so a checklist
 * printed into it scrolls away with everything else. This renders the
 * session's current `taskList` directly — a live field the host replaces
 * wholesale on every update, not an event log — so it stays in view and
 * current while the conversation keeps moving underneath it.
 *
 * Renders nothing when the session has never reported one: most sessions
 * (anything short, or any non-ACP provider) never will, and an empty
 * "Tasks" block would be noise every session pays for.
 */
export function SessionTasks({ session }: { session: AgentSessionRecord }) {
  const tasks = session.taskList;
  if (!tasks || tasks.length === 0) return null;

  const completed = tasks.filter(task => task.status === 'completed').length;

  return (
    <div className="agent-runtime-block session-tasks" data-testid="session-tasks">
      <div className="session-tasks-heading">
        <span className="rail-sub">Tasks</span>
        <span className="session-tasks-count" data-testid="session-tasks-count">{completed}/{tasks.length}</span>
      </div>
      <ul className="session-tasks-list">
        {tasks.map((task, index) => (
          <li key={index} className={`is-${task.status}`} data-testid="session-task">
            <Icon name={task.status === 'completed' ? 'check' : 'dot'} size={12} />
            <span>{task.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
