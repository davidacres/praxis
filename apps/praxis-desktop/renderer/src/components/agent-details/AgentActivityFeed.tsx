import { useMemo, useState } from 'react';
import type { AgentEventSummary, AgentSessionRecord, AgentToolFileChange } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { useDialogs } from '../../ui/dialogs';
import { agentEventIcon, agentEventToneClass, isTerminalAgentState } from '../../ai/aiSessionState';
import { isLatestEditToPath, liveActivity } from '../../ai/sessionNav';
import { providerIconName, providerLabel } from '../../ai/modelProviders';
import { ToolExecutionCard } from './ToolExecutionCard';
import { LiveTurnActivityIndicator } from '../../ai/LiveTurnActivityIndicator';
import { GadgetBlockList } from '../../ai/gadgets';
import { useSessionGadgets } from '../../ai/gadgets/useSessionGadgets';
import { gadgetMessageKey, visibleMessageText } from '../../ai/gadgets/messageText';

export interface AgentActivityFeedProps {
  session: AgentSessionRecord;
  subagentId?: string;
  viewMode?: 'conversation' | 'all';
  onSelectSession?: (sessionKey: string) => void;
  isExecuting?: boolean;
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
  | { type: 'message'; text: string; timestamp: string; modelId?: string }
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

interface TaskProgress {
  total: number;
  completed: number;
}

function getTaskProgress(text: string): TaskProgress | null {
  const lines = text.split('\n');
  let total = 0;
  let completed = 0;
  for (const line of lines) {
    const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+/);
    if (match) {
      total++;
      if (match[1].toLowerCase() === 'x') {
        completed++;
      }
    }
  }
  return total > 0 ? { total, completed } : null;
}

export function AgentActivityFeed({
  session,
  subagentId,
  viewMode = 'conversation',
  onSelectSession,
  isExecuting: isExecutingProp
}: AgentActivityFeedProps) {
  const isExecuting = isExecutingProp ?? !isTerminalAgentState(session.state);
  const { confirm } = useDialogs();
  const [undoingChange, setUndoingChange] = useState<string>();
  const [error, setError] = useState<string>();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { gadgetBlocks, gadgetResults, submitGadgetAction } = useSessionGadgets(session, session.events ?? []);

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleQuote = (fullText: string) => {
    const selection = window.getSelection()?.toString().trim();
    const textToQuote = selection || fullText;
    const quoteBlock = textToQuote
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n') + '\n\n';

    const composer = document.querySelector('[data-testid="session-follow-up-input"]') as HTMLTextAreaElement | null;
    if (composer) {
      const currentVal = composer.value;
      const newVal = currentVal ? `${currentVal}\n\n${quoteBlock}` : quoteBlock;
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (proto) {
        proto.call(composer, newVal);
      } else {
        composer.value = newVal;
      }
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.focus();
      composer.setSelectionRange(newVal.length, newVal.length);
    }
  };

  const handleBranch = async (text: string) => {
    const previewText = text.slice(0, 100).replace(/\n/g, ' ');
    const ok = await confirm({
      title: 'Branch session from this turn?',
      message: `Create a new session starting from this turn: "${previewText}…"?`,
      confirmLabel: 'Branch Session',
      danger: false
    });
    if (!ok) return;

    try {
      const record = await window.praxis.ai.delegate({
        projectId: session.projectId,
        task: {
          goal: `Branch of ${session.issueKey}: continue from "${previewText}"`
        },
        provider: session.provider,
        model: session.model,
        mode: session.mode || 'chat'
      });
      if (record?.issueKey && onSelectSession) {
        onSelectSession(record.issueKey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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

      // 3. User Prompt
      if (event.type === 'user_input_completed') {
        items.push({
          type: 'prompt',
          text: event.summary || event.detail || '',
          timestamp: event.timestamp
        });
        continue;
      }

      // 4. Assistant Message
      if (event.type === 'message') {
        if (event.reasoning) {
          items.push({
            type: 'reasoning',
            text: event.reasoning,
            timestamp: event.timestamp
          });
        }
        const text = event.detail || event.summary;
        if (text) {
          items.push({
            type: 'message',
            text,
            modelId: event.modelId,
            timestamp: event.timestamp
          });
        }
        continue;
      }

      // 5. Model Reasoning / Thoughts (standalone plan or reasoning event)
      if (event.reasoning || (event.type === 'plan' && event.detail)) {
        items.push({
          type: 'reasoning',
          text: event.reasoning || event.detail || '',
          timestamp: event.timestamp
        });
      }

      // 6. Lifecycle / other events
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

    // Ensure initial task goal is represented at the top of the timeline if no prompt exists
    const hasAnyPrompt = items.some(i => i.type === 'prompt');
    const goalText = session.taskDefinition?.goal || session.purpose?.goal;
    if (!hasAnyPrompt && goalText) {
      items.unshift({
        type: 'prompt',
        text: goalText,
        timestamp: session.startedAt || new Date().toISOString()
      });
    }

    if (viewMode === 'conversation') {
      return items.filter(
        item =>
          item.type === 'prompt' ||
          item.type === 'message' ||
          (item.type === 'event' && item.event.type === 'error')
      );
    }

    return items;
  }, [session.events, session.taskDefinition?.goal, session.purpose?.goal, session.startedAt, subagentId, session.issueKey, viewMode]);

  if (timelineItems.length === 0 && (!isExecuting || viewMode !== 'conversation')) {
    return (
      <div className="agent-activity-empty" data-testid="agent-activity-empty">
        <Icon name={viewMode === 'conversation' ? 'chats' : 'tools'} size={32} />
        <span>
          {viewMode === 'conversation'
            ? 'No conversation messages yet.'
            : 'No activity recorded yet for this agent.'}
        </span>
        <p className="hint">
          {viewMode === 'conversation'
            ? 'Ask a question or provide follow-up instructions below.'
            : 'Actions, tool calls, and model reasoning will appear here as the agent works.'}
        </p>
      </div>
    );
  }

  if (viewMode === 'conversation') {
    const providerClass = session.provider ? ` session-chat-provider-${session.provider}` : '';
    const authorName = session.model || (session.provider ? providerLabel(session.provider) : 'AI agent');
    const authorIcon = session.provider ? providerIconName(session.provider) : 'robot';

    return (
      <div className="agent-activity-feed is-chat" data-testid="agent-activity-feed">
        {error && (
          <div className="agent-activity-error-banner" data-testid="agent-activity-error">
            <Icon name="warning" size={14} />
            <span>{error}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(undefined)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="session-chat-thread" data-testid="session-chat-thread">
          {timelineItems.map((item, index) => {
            if (item.type === 'prompt') {
              const copyId = `prompt-${index}`;
              return (
                <div
                  key={`prompt-${item.timestamp}-${index}`}
                  className="session-chat-message is-user"
                  data-testid="agent-timeline-prompt"
                >
                  <div className="session-chat-header">
                    <div className="session-chat-author">You</div>
                    <div className="session-chat-header-actions">
                      {item.timestamp && (
                        <span className="session-chat-timestamp">
                          {formatTime(item.timestamp)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-action-btn session-chat-quote-btn"
                        aria-label="Quote to reply"
                        title="Quote message (or highlight text to quote selection)"
                        data-testid="session-chat-quote-btn"
                        onClick={() => handleQuote(item.text)}
                      >
                        <Icon name="chats" size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-copy-btn"
                        aria-label="Copy message text"
                        title={copiedKey === copyId ? 'Copied!' : 'Copy message text'}
                        onClick={() => handleCopy(copyId, item.text)}
                      >
                        <Icon name={copiedKey === copyId ? 'check' : 'copy'} size={12} />
                      </button>
                    </div>
                  </div>
                  <Markdown text={item.text} testId="session-chat-markdown" />
                </div>
              );
            }

            if (item.type === 'message') {
              const copyId = `msg-${index}`;
              const displayText = visibleMessageText(item.text);
              const progress = getTaskProgress(displayText);
              const cardGadgetBlocks = gadgetBlocks[gadgetMessageKey(index)] ?? [];

              return (
                <div
                  key={`msg-${item.timestamp}-${index}`}
                  className={`session-chat-message is-assistant${providerClass}`}
                  data-testid="agent-timeline-message"
                >
                  <div className="session-chat-header">
                    <div className="session-chat-author">
                      <Icon name={authorIcon} size={13} />
                      <span>{item.modelId || authorName}</span>
                    </div>
                    <div className="session-chat-header-actions">
                      {item.timestamp && (
                        <span className="session-chat-timestamp">
                          {formatTime(item.timestamp)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-action-btn session-chat-branch-btn"
                        aria-label="Branch session from this turn"
                        title="Branch session from this turn"
                        data-testid="session-chat-branch-btn"
                        onClick={() => void handleBranch(displayText)}
                      >
                        <Icon name="git-branch" size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-action-btn session-chat-quote-btn"
                        aria-label="Quote to reply"
                        title="Quote message (or highlight text to quote selection)"
                        data-testid="session-chat-quote-btn"
                        onClick={() => handleQuote(displayText)}
                      >
                        <Icon name="chats" size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-copy-btn"
                        aria-label="Copy message text"
                        title={copiedKey === copyId ? 'Copied!' : 'Copy message text'}
                        onClick={() => handleCopy(copyId, displayText)}
                      >
                        <Icon name={copiedKey === copyId ? 'check' : 'copy'} size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Task checklist progress if tasks are found in message */}
                  {progress && (
                    <div className="session-chat-tasks-progress" data-testid="session-chat-tasks-progress">
                      <div className="session-chat-tasks-progress-header">
                        <span className="session-chat-tasks-label">
                          <Icon name="check" size={12} />
                          Tasks Progress ({progress.completed} of {progress.total} completed)
                        </span>
                        <span className="session-chat-tasks-count">
                          {Math.round((progress.completed / progress.total) * 100)}%
                        </span>
                      </div>
                      <div className="session-chat-tasks-progress-bar">
                        <div
                          className="session-chat-tasks-progress-fill"
                          style={{ width: `${(progress.completed / progress.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <Markdown text={displayText} testId="session-chat-markdown" />

                  {/* Interactive Gadgets in message (choices, forms, diffs, confirmations) */}
                  {cardGadgetBlocks.length > 0 && (
                    <div className="session-chat-gadgets" data-testid="session-chat-gadgets">
                      <GadgetBlockList
                        blocks={cardGadgetBlocks}
                        results={gadgetResults}
                        onSubmit={(gadgetId, actionId, value) => void submitGadgetAction(gadgetId, actionId, value)}
                      />
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'event' && item.event.type === 'error') {
              return (
                <div
                  key={`err-${item.timestamp}-${index}`}
                  className="agent-activity-error-banner"
                  data-testid="agent-timeline-error-event"
                >
                  <Icon name="warning" size={14} />
                  <span>{item.event.summary}</span>
                </div>
              );
            }

            return null;
          })}

          {/* Feature 3: Live in-progress active turn indicator */}
          {isExecuting && (
            <div
              className={`session-chat-message is-assistant is-running${providerClass}`}
              data-testid="session-chat-live-turn"
            >
              <div className="session-chat-header">
                <div className="session-chat-author">
                  <Icon name={authorIcon} size={13} />
                  <span>{authorName}</span>
                </div>
              </div>
              {session.reasoningText && (
                <div className="session-chat-streaming-text" data-testid="session-chat-streaming-text">
                  <Markdown text={session.reasoningText} testId="session-chat-markdown-streaming" />
                </div>
              )}
              <LiveTurnActivityIndicator
                startedAt={session.events?.[session.events.length - 1]?.timestamp ?? session.startedAt}
                statusText={liveActivity(session) ?? 'Working…'}
                provider={session.provider}
                model={session.model}
              />
            </div>
          )}
        </div>
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

          if (item.type === 'message') {
            return (
              <div
                key={`msg-${item.timestamp}-${index}`}
                className="agent-timeline-item agent-timeline-message"
                data-testid="agent-timeline-message"
              >
                <div className="agent-timeline-marker agent-timeline-marker--assistant">
                  <Icon name="robot" size={14} />
                </div>
                <div className="agent-timeline-card agent-timeline-card--assistant">
                  <div className="agent-timeline-card-header">
                    <span className="agent-timeline-label">Assistant</span>
                    <span className="agent-timeline-time">{formatTime(item.timestamp)}</span>
                  </div>
                  <div className="agent-timeline-card-body">
                    <Markdown text={item.text} testId="message-markdown" />
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
                  <details className="agent-thought-disclosure">
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
