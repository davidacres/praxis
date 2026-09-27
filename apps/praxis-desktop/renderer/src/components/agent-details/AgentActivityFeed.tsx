import { useMemo, useState } from 'react';
import type { AgentEventSummary, AgentSessionRecord, AgentToolFileChange } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { useDialogs } from '../../ui/dialogs';
import { agentEventIcon, agentEventToneClass, isTerminalAgentState } from '../../ai/aiSessionState';
import { isLatestEditToPath } from '../../ai/sessionNav';
import { ToolExecutionCard } from './ToolExecutionCard';

export interface AgentActivityFeedProps {
  session: AgentSessionRecord;
  subagentId?: string;
}

interface PairedToolItem {
  id: string;
  toolName: string;
  kind?: string;
  argsSummary?: string;
  args?: Record<string, unknown> | string;
  result?: string;
  diff?: string;
  fileChanges?: AgentToolFileChange[];
  duration?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  timestamp: string;
}

type TimelineItem =
  | { type: 'tool'; item: PairedToolItem; timestamp: string }
  | { type: 'event'; event: AgentEventSummary; timestamp: string }
  | { type: 'prompt'; text: string; timestamp: string }
  | { type: 'reasoning'; text: string; timestamp: string };

function formatTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function formatDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const ms = end - start;
  if (ms < 1000) return '<1s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function extractToolName(event: AgentEventSummary): string {
  return (
    event.data?.toolName?.trim() ||
    event.summary.match(/(?:running tool|tool (?:completed|failed)|tool):?\s*([\w.-]+)/i)?.[1] ||
    event.summary
  );
}

export function AgentActivityFeed({ session, subagentId }: AgentActivityFeedProps) {
  const { confirm } = useDialogs();
  const [undoingChange, setUndoingChange] = useState<string>();
  const [error, setError] = useState<string>();

  const undoEdit = async (eventTimestamp: string, path: string) => {
    const ok = await confirm({
      title: `Undo edit to ${path}?`,
      message: `${path} will be restored to what it was immediately before this edit.`,
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

  const timelineItems = useMemo(() => {
    const rawEvents = session.events ?? [];
    const filteredEvents = subagentId && subagentId !== session.issueKey
      ? rawEvents.filter(e => e.data?.callId === subagentId || e.summary.includes(subagentId))
      : rawEvents;

    const items: TimelineItem[] = [];
    const openToolsByCallId = new Map<string, PairedToolItem>();
    const openToolsByName = new Map<string, PairedToolItem[]>();

    for (let i = 0; i < filteredEvents.length; i++) {
      const event = filteredEvents[i];

      // 1. Tool start
      if (event.type === 'tool_start') {
        const name = extractToolName(event);
        const callId = event.data?.callId || `tool-start-${event.timestamp}-${i}`;
        const toolItem: PairedToolItem = {
          id: callId,
          toolName: name,
          kind: event.data?.kind,
          argsSummary: event.data?.argsSummary || event.detail,
          status: 'running',
          startedAt: event.timestamp,
          timestamp: event.timestamp
        };

        if (event.data?.callId) {
          openToolsByCallId.set(event.data.callId, toolItem);
        } else {
          const list = openToolsByName.get(name) || [];
          list.push(toolItem);
          openToolsByName.set(name, list);
        }

        items.push({ type: 'tool', item: toolItem, timestamp: event.timestamp });
        continue;
      }

      // 2. Tool complete
      if (event.type === 'tool_complete') {
        const name = extractToolName(event);
        let pairedItem: PairedToolItem | undefined;

        if (event.data?.callId && openToolsByCallId.has(event.data.callId)) {
          pairedItem = openToolsByCallId.get(event.data.callId);
          openToolsByCallId.delete(event.data.callId);
        } else {
          const list = openToolsByName.get(name);
          if (list && list.length > 0) {
            pairedItem = list.shift();
          }
        }

        if (pairedItem) {
          pairedItem.status = event.data?.ok === false ? 'failed' : 'completed';
          pairedItem.completedAt = event.timestamp;
          pairedItem.duration = formatDuration(pairedItem.startedAt, event.timestamp);
          pairedItem.result = event.detail;
          pairedItem.diff = event.data?.diff;
          pairedItem.fileChanges = event.data?.fileChanges;
        } else {
          // Completed without start event
          const standalone: PairedToolItem = {
            id: event.data?.callId || `tool-complete-${event.timestamp}-${i}`,
            toolName: name,
            kind: event.data?.kind,
            argsSummary: event.data?.argsSummary,
            result: event.detail,
            diff: event.data?.diff,
            fileChanges: event.data?.fileChanges,
            status: event.data?.ok === false ? 'failed' : 'completed',
            completedAt: event.timestamp,
            timestamp: event.timestamp
          };
          items.push({ type: 'tool', item: standalone, timestamp: event.timestamp });
        }
        continue;
      }

      // 3. Prompt
      if (event.type === 'user_input_completed') {
        items.push({
          type: 'prompt',
          text: event.summary || event.detail || '',
          timestamp: event.timestamp
        });
        continue;
      }

      // 4. Model Reasoning / Thoughts
      if (event.reasoning || (event.type === 'plan' && event.detail)) {
        items.push({
          type: 'reasoning',
          text: event.reasoning || event.detail || '',
          timestamp: event.timestamp
        });
      }

      // 5. Lifecycle / other events
      if (
        event.type === 'error' ||
        event.type === 'warning' ||
        event.type === 'aborted' ||
        (event.type === 'info' && !/automatically|completed the follow-up/i.test(event.summary))
      ) {
        items.push({
          type: 'event',
          event,
          timestamp: event.timestamp
        });
      }
    }

    return items;
  }, [session.events, subagentId, session.issueKey]);

  if (timelineItems.length === 0) {
    return (
      <div className="agent-activity-empty" data-testid="agent-activity-empty">
        <Icon name="tools" size={32} />
        <span>No activity recorded yet for this agent.</span>
        <p className="hint">
          Actions, tool calls, and model reasoning will appear here as the agent works.
        </p>
      </div>
    );
  }

  const undoDisabled = !isTerminalAgentState(session.state);

  return (
    <div className="agent-activity-feed" data-testid="agent-activity-feed">
      {error && (
        <div className="agent-activity-error-banner" data-testid="agent-activity-error">
          <Icon name="warning" size={14} />
          <span>{error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="agent-activity-timeline">
        {timelineItems.map((item, index) => {
          if (item.type === 'prompt') {
            return (
              <div
                key={`prompt-${item.timestamp}-${index}`}
                className="agent-timeline-item agent-timeline-prompt"
                data-testid="agent-timeline-prompt"
              >
                <div className="agent-timeline-marker">
                  <Icon name="chats" size={14} />
                </div>
                <div className="agent-timeline-card">
                  <div className="agent-timeline-card-header">
                    <span className="agent-timeline-label">User Input</span>
                    <span className="agent-timeline-time">{formatTime(item.timestamp)}</span>
                  </div>
                  <div className="agent-timeline-card-body">
                    <Markdown text={item.text} testId="prompt-markdown" />
                  </div>
                </div>
              </div>
            );
          }

          if (item.type === 'reasoning') {
            return (
              <div
                key={`thought-${item.timestamp}-${index}`}
                className="agent-timeline-item agent-timeline-thought"
                data-testid="agent-timeline-thought"
              >
                <div className="agent-timeline-marker">
                  <Icon name="sparkles" size={14} />
                </div>
                <div className="agent-timeline-card">
                  <details className="agent-thought-disclosure" open>
                    <summary className="agent-timeline-card-header">
                      <span className="agent-timeline-label">Reasoning / Thought Process</span>
                      <span className="agent-timeline-time">{formatTime(item.timestamp)}</span>
                    </summary>
                    <div className="agent-timeline-card-body agent-thought-content">
                      <Markdown text={item.text} testId="thought-markdown" />
                    </div>
                  </details>
                </div>
              </div>
            );
          }

          if (item.type === 'tool') {
            const tool = item.item;
            return (
              <div
                key={`tool-${tool.id}-${index}`}
                className="agent-timeline-item agent-timeline-tool"
                data-testid="agent-timeline-tool-item"
              >
                <div className="agent-timeline-marker">
                  <Icon name="tools" size={14} />
                </div>
                <div className="agent-timeline-content">
                  <ToolExecutionCard
                    toolName={tool.toolName}
                    kind={tool.kind}
                    argsSummary={tool.argsSummary}
                    args={tool.args}
                    result={tool.result}
                    diff={tool.diff}
                    fileChanges={tool.fileChanges}
                    duration={tool.duration}
                    status={tool.status}
                    startedAt={tool.startedAt}
                    completedAt={tool.completedAt}
                    onUndo={(ts, path) => void undoEdit(ts, path)}
                    canUndo={(ts, path) => isLatestEditToPath(session.events ?? [], ts, path)}
                    undoDisabled={undoDisabled}
                    undoingKey={undoingChange}
                  />
                </div>
              </div>
            );
          }

          if (item.type === 'event') {
            const event = item.event;
            return (
              <div
                key={`event-${event.timestamp}-${index}`}
                className="agent-timeline-item agent-timeline-event"
                data-testid="agent-timeline-lifecycle-event"
              >
                <div className="agent-timeline-marker">
                  <span className={agentEventToneClass(event.type)}>
                    <Icon name={agentEventIcon(event.type)} size={14} />
                  </span>
                </div>
                <div className="agent-timeline-card">
                  <div className="agent-timeline-card-header">
                    <span className="agent-timeline-label">{event.summary}</span>
                    <span className="agent-timeline-time">{formatTime(event.timestamp)}</span>
                  </div>
                  {event.detail && <div className="agent-timeline-card-body hint">{event.detail}</div>}
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
