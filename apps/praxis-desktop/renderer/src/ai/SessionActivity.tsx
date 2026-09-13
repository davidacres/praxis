import { useState } from 'react';
import type { AgentEventSummary, AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { agentEventIcon, agentEventToneClass, isTerminalAgentState } from './aiSessionState';
import { isLatestEditToPath } from './sessionNav';
import { ToolCompletionGadget } from './gadgets/ToolCompletionGadget';

/**
 * What the agent *did* — tool runs and lifecycle events — as the inspector's
 * Activity tab.
 *
 * This used to sit as a collapsed `<details>` at the bottom of the transcript,
 * where it was neither part of the conversation nor visible enough to diagnose
 * with: the failure count, the one urgent thing it carries, was hidden behind a
 * closed disclosure. The conversation window is for conversation; a machine
 * log belongs with the session's other facts.
 *
 * Self-contained on purpose. The undo flow (confirm, busy, error) came across
 * with it rather than staying behind as props threaded from the page, because
 * nothing outside this tab needs any of that state.
 */

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

/**
 * The event store is deliberately more detailed than the default Activity
 * view. These are useful for resume, audit, and diagnostics, but not useful
 * as a user's chronological feed: provider startup, model reasoning, chat
 * copies, and terminal lifecycle markers are represented elsewhere in the
 * console.
 */
function shouldShowActivityEvent(event: AgentEventSummary): boolean {
  switch (event.type) {
    case 'plan':
    case 'error':
    case 'warning':
    case 'aborted':
      return true;
    case 'info':
      // Keep explicit user-facing state changes such as a pause, but omit
      // automatic runtime bookkeeping from the normal-user digest.
      return !/automatically|idle|completed the follow-up|completed the task/i.test(event.summary);
    default:
      return false;
  }
}

export function SessionActivity({ session }: { session: AgentSessionRecord }) {
  const { confirm } = useDialogs();
  const [undoingChange, setUndoingChange] = useState<string>();
  const [error, setError] = useState<string>();

  /**
   * "The agent got a hunk wrong, recovery today is a follow-up message" — this
   * is the other half: revert one recorded edit in place, from the row that
   * shows it, rather than asking the agent to fix its own mistake. Writes the
   * file back to `oldText`; only offered while it's still the latest edit to
   * that path (`isLatestEditToPath`) and the session isn't mid-turn, both
   * re-checked server-side since this button's state can go stale while the
   * dialog is open.
   */
  const undoEdit = async (eventTimestamp: string, path: string) => {
    const ok = await confirm({
      title: `Undo the edit to ${path}?`,
      message: `${path} is restored to what it was immediately before this edit — overwriting the file on disk now. This cannot be undone by Praxis.`,
      confirmLabel: 'Undo edit',
      danger: true
    });
    if (!ok) return;
    setUndoingChange(`${eventTimestamp}|${path}`);
    setError(undefined);
    try {
      await window.praxis.ai.undoToolFileChange(session.issueKey, eventTimestamp, path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUndoingChange(undefined);
    }
  };

  const lifecycleEvents = session.events.filter(shouldShowActivityEvent);
  const hasToolActivity = session.events.some(
    event => event.type === 'tool_start' || event.type === 'tool_complete'
  );

  if (!hasToolActivity && lifecycleEvents.length === 0) {
    return (
      <div className="empty-state" data-testid="session-activity-empty">
        <Icon name="tools" size={24} />
        <span>Tool runs and lifecycle events appear here.</span>
      </div>
    );
  }

  return (
    <div className="session-events" data-testid="session-events">
      <ToolCompletionGadget
        events={session.events}
        onUndo={(eventTimestamp, path) => void undoEdit(eventTimestamp, path)}
        canUndo={(eventTimestamp, path) => isLatestEditToPath(session.events, eventTimestamp, path)}
        undoingKey={undoingChange}
        undoDisabled={!isTerminalAgentState(session.state)}
      />
      {lifecycleEvents.map((event, index) => (
        <div className="event-row" key={`${event.timestamp}-${index}`} data-testid="session-event-row">
          <span className="event-time">{formatTime(event.timestamp)}</span>
          <span className={agentEventToneClass(event.type)}>
            <Icon name={agentEventIcon(event.type)} size={13} />
          </span>
          <span className="event-body">
            <span className="event-summary">{event.summary}</span>
            {event.detail && event.type !== 'plan' && <div className="event-detail">{event.detail}</div>}
          </span>
        </div>
      ))}
      {error && <p className="hint is-danger" data-testid="session-activity-error">{error}</p>}
    </div>
  );
}
