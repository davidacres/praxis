import { useCallback, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AiProvider,
  ChatBlock,
  GadgetActionResult,
  GadgetActionValue,
  WireImageAttachment
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { useDialogs } from '../ui/dialogs';
import { providerIconName, providerLabel } from './modelProviders';
import { formatCost, liveActivity } from './sessionNav';
import { LiveTurnActivityIndicator, formatElapsedDuration } from './LiveTurnActivityIndicator';
import { GadgetBlockList } from './gadgets';
import { useSessionGadgets } from './gadgets/useSessionGadgets';
import { gadgetMessageKey, stripGadgetFences, visibleMessageText } from './gadgets/messageText';
import { captionText, collectThoughtRuns, thoughtCaption, thoughtRunStartingAt } from './chatThought';
import { collectTurnTools } from './chatToolCalls';
import { collectMessageRuns, messageRunCovering, messageRunStartingAt } from './chatTurns';

/** Image thumbnails for a user turn in the chat transcript; click enlarges. */
export function TranscriptAttachments({ attachments }: { attachments: WireImageAttachment[] | undefined }) {
  const [enlarged, setEnlarged] = useState<{ image: WireImageAttachment; index: number }>();
  if (!attachments?.length) return null;
  return (
    <div className="session-chat-attachments" data-testid="session-chat-attachments">
      {attachments.map((image, index) => (
        <button
          key={`${index}-${image.dataBase64.length}`}
          type="button"
          className="session-chat-attachment"
          data-testid="session-chat-attachment"
          title="View full size"
          onClick={() => setEnlarged({ image, index })}
        >
          <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={`Attached image ${index + 1}`} />
        </button>
      ))}
      {enlarged && createPortal(
        <div
          className="session-image-lightbox"
          data-testid="session-image-lightbox"
          role="dialog"
          aria-label={`Attached image ${enlarged.index + 1}, full size`}
          onClick={() => setEnlarged(undefined)}
        >
          <img src={`data:${enlarged.image.mimeType};base64,${enlarged.image.dataBase64}`} alt={`Attached image ${enlarged.index + 1}`} />
        </div>,
        document.body
      )}
    </div>
  );
}

function decodeContextText(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function parseTerminalContext(detail: string | undefined) {
  const match = detail?.match(/^<terminal_context cwd="([^"]*)" captured_at="([^"]*)">\n([\s\S]*?)\n<\/terminal_context>\n\n([\s\S]*)$/);
  return match ? {
    cwd: decodeContextText(match[1]),
    capturedAt: match[2],
    output: decodeContextText(match[3]),
    message: match[4]
  } : undefined;
}

function formatMessageTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFullDateTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    return '';
  }
}

export interface TaskProgress {
  total: number;
  completed: number;
}

export function getTaskProgress(text: string): TaskProgress | null {
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

export interface SessionChatThreadProps {
  session: AgentSessionRecord;
  subagentId?: string;
  isExecuting?: boolean;
  onSelectSession?: (sessionKey: string) => void;
  testIdVariant?: 'classic' | 'timeline';
  showOpeningGoal?: boolean;
  conversationEvents?: AgentEventSummary[];
  optimisticFollowUp?: { message: string; images?: WireImageAttachment[]; suppressPreviousResponse?: boolean };
  optimisticTerminalContext?: { cwd: string; output: string; message: string };
  visibleResponseText?: string;
  shouldRenderResponseFallback?: boolean;
  livePendingConversationMessages?: Array<{ participantId?: string; message: string }>;
  activeTurnStartedAt?: number;
  liveActivityText?: string;
  activityProvider?: AiProvider;
  scrollRef?: Ref<HTMLDivElement>;
  className?: string;
  testId?: string;
  gadgetBlocks?: Record<string, ChatBlock[]>;
  gadgetResults?: Record<string, GadgetActionResult>;
  busyGadgetId?: string;
  onSubmitGadgetAction?: (gadgetId: string, actionId: string, value: GadgetActionValue) => void;
}

export function SessionChatThread({
  session,
  subagentId,
  isExecuting = false,
  onSelectSession,
  testIdVariant = 'classic',
  showOpeningGoal: showOpeningGoalProp,
  conversationEvents: propConversationEvents,
  optimisticFollowUp,
  optimisticTerminalContext,
  visibleResponseText,
  shouldRenderResponseFallback,
  livePendingConversationMessages = [],
  activeTurnStartedAt,
  liveActivityText,
  activityProvider,
  scrollRef,
  className = '',
  testId = 'session-chat-thread',
  gadgetBlocks: propGadgetBlocks,
  gadgetResults: propGadgetResults,
  busyGadgetId: propBusyGadgetId,
  onSubmitGadgetAction: propOnSubmitGadgetAction
}: SessionChatThreadProps) {
  const { confirm } = useDialogs();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string>();

  // Filter raw events by subagent if scoped
  const rawEvents = useMemo(() => {
    const list = session.events ?? [];
    if (!subagentId || subagentId === session.issueKey) return list;
    return list.filter(e => e.data?.callId === subagentId || e.summary.includes(subagentId));
  }, [session.events, subagentId, session.issueKey]);

  // Extract conversation turns
  const conversationEvents = useMemo(() => {
    if (propConversationEvents) return propConversationEvents;
    return rawEvents.filter(
      event =>
        (event.type === 'message' || event.type === 'user_input_completed') && Boolean(event.detail || event.summary)
    );
  }, [propConversationEvents, rawEvents]);

  const hasAnyPrompt = useMemo(
    () => conversationEvents.some(event => event.type === 'user_input_completed'),
    [conversationEvents]
  );

  const showOpeningGoal = showOpeningGoalProp ?? (testIdVariant === 'classic' ? true : !hasAnyPrompt);

  const turnTools = useMemo(() => collectTurnTools(rawEvents), [rawEvents]);
  const toolCallsAt = useCallback(
    (event: AgentEventSummary) => turnTools.get(event)?.calls.length || undefined,
    [turnTools]
  );

  const thoughtRuns = useMemo(() => collectThoughtRuns(conversationEvents), [conversationEvents]);
  const messageRuns = useMemo(
    () => collectMessageRuns(
      conversationEvents,
      event =>
        event.type === 'message'
          ? visibleMessageText(event.detail ?? event.summary ?? '')
          : '',
      { toolCallsAt, isIntermediate: event => turnTools.get(event)?.followedByTools === true }
    ),
    [conversationEvents, toolCallsAt, turnTools]
  );

  // Fallback to internal session gadgets if parent doesn't provide them
  const internalGadgets = useSessionGadgets(session, rawEvents);
  const gadgetBlocks = propGadgetBlocks ?? internalGadgets.gadgetBlocks;
  const gadgetResults = propGadgetResults ?? internalGadgets.gadgetResults;
  const busyGadgetId = propBusyGadgetId ?? internalGadgets.busyGadgetId;
  const submitGadgetAction = propOnSubmitGadgetAction ?? internalGadgets.submitGadgetAction;

  const copyMessageText = (key: string, text: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => prev === key ? null : prev), 2000);
    }).catch(() => undefined);
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
      setBranchError(err instanceof Error ? err.message : String(err));
    }
  };

  const isSelectedFailed = session.state === 'failed';

  return (
    <div
      className={`session-chat-scroll session-chat-thread ${className}`.trim()}
      ref={scrollRef}
      data-testid={testId}
    >
      {branchError && (
        <div className="agent-activity-error-banner" data-testid="agent-activity-error">
          <Icon name="warning" size={14} />
          <span>{branchError}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBranchError(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Opening Task Goal */}
      {showOpeningGoal && session.taskDefinition?.goal && (
        <div
          className="session-chat-message is-user"
          data-testid={testIdVariant === 'timeline' ? 'agent-timeline-prompt' : undefined}
        >
          <div className="session-chat-header">
            <div className="session-chat-author">You</div>
            <div className="session-chat-header-actions">
              {session.startedAt && (
                <span
                  className="session-chat-timestamp"
                  title={formatFullDateTime(session.startedAt)}
                >
                  {formatMessageTime(session.startedAt)}
                </span>
              )}
              <button
                type="button"
                className="icon-btn icon-btn-sm session-chat-action-btn session-chat-quote-btn"
                aria-label="Quote to reply"
                title="Quote message (or highlight text to quote selection)"
                data-testid="session-chat-quote-btn"
                onClick={() => handleQuote(session.taskDefinition.goal)}
              >
                <Icon name="chats" size={12} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm session-chat-copy-btn"
                aria-label="Copy message text"
                title={copiedKey === 'user-goal' ? 'Copied!' : 'Copy message text'}
                onClick={() => copyMessageText('user-goal', session.taskDefinition.goal)}
              >
                <Icon name={copiedKey === 'user-goal' ? 'check' : 'copy'} size={12} />
              </button>
            </div>
          </div>
          <Markdown
            text={session.taskDefinition.goal}
            testId="session-chat-markdown"
            imageSessionId={session.issueKey}
          />
        </div>
      )}

      {/* Conversation Events */}
      {conversationEvents.map((event, index) => {
        // A gadget answer is shown by the answered gadget itself. It stays in
        // the list so message indices (which key gadget blocks) do not move.
        if (event.gadgetAnswer) return null;
        const terminalContext = event.type === 'user_input_completed' ? parseTerminalContext(event.detail) : undefined;
        const messageKey = `event-${event.timestamp}-${index}`;
        const rawText = event.type === 'message'
          ? visibleMessageText(event.detail ?? event.summary ?? '')
          : stripGadgetFences(terminalContext?.message ?? event.detail ?? event.summary ?? '');

        if (messageRunCovering(messageRuns, index)) return null;

        const thoughtRun = thoughtRunStartingAt(thoughtRuns, index);
        const messageRun = messageRunStartingAt(messageRuns, index);
        const narration = messageRun?.narration ?? [];
        const thoughtSteps = [...(thoughtRun?.steps ?? []), ...narration];
        const caption = thoughtRun
          ? thoughtCaption(thoughtRun, conversationEvents, toolCallsAt)
          : captionText(messageRun?.durationMs, messageRun?.toolCalls);
        const lastMember = messageRun
          ? conversationEvents[messageRun.memberIndices[messageRun.memberIndices.length - 1]]
          : event;
        const turnToolCalls = (lastMember && turnTools.get(lastMember)?.calls) ?? [];
        const hasThought = Boolean(thoughtRun) || narration.length > 0;
        const captionShown = hasThought && Boolean(caption);
        const telemetrySource = messageRun ?? event;
        const toolNames = messageRun ? messageRun.toolNames : event.toolNames;
        const hasTelemetry = event.type === 'message' && (
          (!captionShown && telemetrySource.durationMs !== undefined) ||
          telemetrySource.tokenUsage !== undefined ||
          telemetrySource.cost !== undefined ||
          telemetrySource.modelId !== undefined ||
          (!captionShown && toolNames && toolNames.length > 0)
        );
        const toolCallCount = messageRun?.toolCalls ?? toolNames?.length ?? 0;
        const cardGadgetBlocks = (messageRun ? messageRun.memberIndices : [index])
          .flatMap(member => gadgetBlocks[gadgetMessageKey(member)] ?? []);
        const runText = messageRun ? messageRun.parts.join('\n\n') : rawText;
        const progress = event.type === 'message' ? getTaskProgress(runText) : null;
        const isAssistant = event.type === 'message';

        const outerTestId = testIdVariant === 'timeline'
          ? (isAssistant ? 'agent-timeline-message' : 'agent-timeline-prompt')
          : (isAssistant ? 'session-chat-assistant' : 'session-chat-user');

        const innerTestId = testIdVariant === 'timeline'
          ? (isAssistant ? 'session-chat-assistant' : 'session-chat-user')
          : (isAssistant ? 'agent-timeline-message' : 'agent-timeline-prompt');

        return (
          <div
            className={`session-chat-message ${isAssistant ? `is-assistant session-chat-participant-${event.speaker?.participantId ?? 'legacy'}${event.speaker ? ` session-chat-provider-${event.speaker.provider}` : ''}` : 'is-user'}`}
            key={`${event.timestamp}-${index}`}
            data-testid={outerTestId}
          >
            {/* Dual test ID hook for full cross-view assertion compatibility */}
            <span data-testid={innerTestId} style={{ display: 'none' }} aria-hidden="true" />

            <div className="session-chat-header">
              <div className="session-chat-author">
                {isAssistant ? (
                  event.speaker ? (
                    <>
                      <Icon name={providerIconName(event.speaker.provider)} size={13} />
                      {`${providerLabel(event.speaker.provider)}${event.speaker.model ? ` · ${event.speaker.model}` : ''}`}
                    </>
                  ) : (
                    <>
                      <Icon name={session.provider ? providerIconName(session.provider) : 'robot'} size={13} />
                      <span>{event.modelId || (session.provider ? providerLabel(session.provider) : 'AI agent')}</span>
                    </>
                  )
                ) : (
                  'You'
                )}
              </div>
              <div className="session-chat-header-actions">
                {event.timestamp && (
                  <span
                    className="session-chat-timestamp"
                    title={formatFullDateTime(event.timestamp)}
                  >
                    {formatMessageTime(event.timestamp)}
                  </span>
                )}
                {isAssistant && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm session-chat-action-btn session-chat-branch-btn"
                    aria-label="Branch session from this turn"
                    title="Branch session from this turn"
                    data-testid="session-chat-branch-btn"
                    onClick={() => void handleBranch(runText)}
                  >
                    <Icon name="git-branch" size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn icon-btn-sm session-chat-action-btn session-chat-quote-btn"
                  aria-label="Quote to reply"
                  title="Quote message (or highlight text to quote selection)"
                  data-testid="session-chat-quote-btn"
                  onClick={() => handleQuote(runText)}
                >
                  <Icon name="chats" size={12} />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm session-chat-copy-btn"
                  aria-label="Copy message text"
                  title={copiedKey === messageKey ? 'Copied!' : 'Copy message text'}
                  onClick={() => copyMessageText(messageKey, runText)}
                >
                  <Icon name={copiedKey === messageKey ? 'check' : 'copy'} size={12} />
                </button>
              </div>
            </div>

            {terminalContext && (
              <details className="session-chat-terminal-context">
                <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{terminalContext.cwd}</span></summary>
                <pre>{terminalContext.output}</pre>
              </details>
            )}

            {hasThought && (
              <details className="session-chat-thought" data-testid="session-thought-disclosure">
                <summary className="session-chat-thought-summary" data-testid="session-thought-summary">
                  <Icon name="sparkles" size={11} />
                  <span className="session-chat-thought-label">Thought</span>
                  {caption && <span className="session-chat-thought-meta">{caption}</span>}
                </summary>
                <div className="session-chat-thought-content">
                  {turnToolCalls.length > 0 && (
                    <ul className="session-chat-thought-tools" data-testid="session-thought-tools">
                      {turnToolCalls.map((call, callIndex) => (
                        <li key={callIndex} className={call.ok === false ? 'is-failed' : undefined}>
                          <Icon name={call.ok === false ? 'close' : call.ok ? 'check' : 'tools'} size={11} />
                          <span className="session-chat-thought-tool-name">{call.name}</span>
                          {call.detail && <span className="session-chat-thought-tool-detail">{call.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {thoughtSteps.map((step, stepIndex) => (
                    <Markdown
                      key={stepIndex}
                      text={step}
                      testId="session-thought-markdown"
                      imageSessionId={session?.issueKey}
                    />
                  ))}
                </div>
              </details>
            )}

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

            <Markdown
              text={runText}
              testId="session-chat-markdown"
              imageSessionId={session?.issueKey}
            />

            {event.type === 'user_input_completed' && <TranscriptAttachments attachments={event.attachments} />}

            {cardGadgetBlocks.length > 0 && (
              <div className="session-chat-gadgets" data-testid="session-chat-gadgets">
                <GadgetBlockList
                  blocks={cardGadgetBlocks}
                  busyGadgetId={busyGadgetId}
                  results={gadgetResults}
                  onSubmit={(gadgetId, actionId, value) => void submitGadgetAction(gadgetId, actionId, value as GadgetActionValue)}
                />
              </div>
            )}

            {hasTelemetry && (
              <div className="session-chat-telemetry-bar" data-testid="session-chat-telemetry">
                {!captionShown && telemetrySource.durationMs !== undefined && (
                  <span className="session-telemetry-chip" title={`Turn duration: ${(telemetrySource.durationMs / 1000).toFixed(1)}s`}>
                    <Icon name="zap" size={11} />
                    <span>{formatElapsedDuration(telemetrySource.durationMs)}</span>
                  </span>
                )}
                {telemetrySource.tokenUsage && (
                  <span
                    className="session-telemetry-chip"
                    title={`Input: ${(telemetrySource.tokenUsage.inputTokens ?? 0).toLocaleString()} tokens${telemetrySource.tokenUsage.cachedInputTokens ? ` (${telemetrySource.tokenUsage.cachedInputTokens.toLocaleString()} cached)` : ''} · Output: ${(telemetrySource.tokenUsage.outputTokens ?? 0).toLocaleString()} tokens${telemetrySource.tokenUsage.reasoningTokens ? ` (${telemetrySource.tokenUsage.reasoningTokens.toLocaleString()} reasoning)` : ''}`}
                  >
                    <Icon name="sparkles" size={11} />
                    <span>{(telemetrySource.tokenUsage.totalTokens ?? ((telemetrySource.tokenUsage.inputTokens ?? 0) + (telemetrySource.tokenUsage.outputTokens ?? 0))).toLocaleString()} tok</span>
                  </span>
                )}
                {telemetrySource.cost && telemetrySource.cost.amount > 0 && (
                  <span className="session-telemetry-chip" title="Estimated turn cost">
                    <span>{formatCost(telemetrySource.cost) ?? `${telemetrySource.cost.amount.toFixed(4)} ${telemetrySource.cost.currency}`}</span>
                  </span>
                )}
                {telemetrySource.modelId && (
                  <span className="session-telemetry-chip" title={`Model: ${telemetrySource.modelId}`}>
                    <Icon name="robot" size={11} />
                    <span>{telemetrySource.modelId}</span>
                  </span>
                )}
                {!captionShown && toolNames && toolNames.length > 0 && (
                  <button
                    type="button"
                    className="session-telemetry-chip is-clickable"
                    title="View tool execution details in Activity tab"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('praxis:session-tab', { detail: { tab: 'activity' } }));
                    }}
                  >
                    <Icon name="tools" size={11} />
                    <span>{toolCallCount} tool {toolCallCount === 1 ? 'call' : 'calls'}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Optimistic Follow Up */}
      {optimisticFollowUp?.suppressPreviousResponse && (
        <div
          className="session-chat-message is-user"
          data-testid={testIdVariant === 'timeline' ? 'agent-timeline-prompt' : 'session-chat-user'}
          data-pending="true"
        >
          <div className="session-chat-header">
            <div className="session-chat-author">You</div>
            <div className="session-chat-header-actions">
              <span className="session-chat-timestamp">Just now</span>
            </div>
          </div>
          {optimisticTerminalContext && (
            <details className="session-chat-terminal-context">
              <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{optimisticTerminalContext.cwd}</span></summary>
              <pre>{optimisticTerminalContext.output}</pre>
            </details>
          )}
          <Markdown
            text={stripGadgetFences(optimisticTerminalContext?.message ?? optimisticFollowUp.message)}
            testId="session-chat-markdown"
            imageSessionId={session?.issueKey}
          />
          {optimisticFollowUp.images?.length
            ? <TranscriptAttachments attachments={optimisticFollowUp.images} />
            : null}
        </div>
      )}

      {/* Response Fallback */}
      {shouldRenderResponseFallback && visibleResponseText && (
        <div
          className="session-chat-message is-assistant session-chat-participant-legacy"
          data-testid={testIdVariant === 'timeline' ? 'agent-timeline-message' : 'session-response'}
        >
          <div className="session-chat-header">
            <div className="session-chat-author">
              {session?.conversation?.state === 'running'
                ? (() => { const speaker = session.conversation.participants.find(participant => participant.id === session.conversation?.currentSpeakerId); return speaker ? <><Icon name={providerIconName(speaker.provider)} size={13} />{`${providerLabel(speaker.provider)}${speaker.model ? ` · ${speaker.model}` : ''}`}</> : 'AI agent'; })()
                : 'AI agent'}
            </div>
            <div className="session-chat-header-actions">
              <button
                type="button"
                className="icon-btn icon-btn-sm session-chat-copy-btn"
                aria-label="Copy message text"
                title={copiedKey === 'fallback-response' ? 'Copied!' : 'Copy message text'}
                onClick={() => copyMessageText('fallback-response', visibleResponseText)}
              >
                <Icon name={copiedKey === 'fallback-response' ? 'check' : 'copy'} size={12} />
              </button>
            </div>
          </div>
          <Markdown text={visibleResponseText} testId="session-chat-markdown" imageSessionId={session?.issueKey} />
        </div>
      )}

      {/* Pending Directed Conversation Messages */}
      {livePendingConversationMessages.map((pending, index) => (
        <div
          className="session-chat-message is-user"
          key={`pending-${pending.participantId}-${index}-${pending.message}`}
          data-testid={testIdVariant === 'timeline' ? 'agent-timeline-prompt' : 'session-chat-user'}
          data-pending="true"
        >
          <div className="session-chat-author">You</div>
          <Markdown text={stripGadgetFences(pending.message)} testId="session-chat-markdown" imageSessionId={session?.issueKey} />
        </div>
      ))}

      {/* In-Progress Active Turn / Streaming Turn Indicator */}
      {isExecuting && (
        <div
          className={`session-chat-message is-assistant is-running${session.provider ? ` session-chat-provider-${session.provider}` : ''}`}
          data-testid="session-chat-live-turn"
        >
          <div className="session-chat-header">
            <div className="session-chat-author">
              <Icon name={session.provider ? providerIconName(session.provider) : 'robot'} size={13} />
              <span>{session.model || (session.provider ? providerLabel(session.provider) : 'AI agent')}</span>
            </div>
          </div>
          {session.reasoningText && (
            <div className="session-chat-streaming-text" data-testid="session-chat-streaming-text">
              <Markdown text={session.reasoningText} testId="session-chat-markdown-streaming" />
            </div>
          )}
          <LiveTurnActivityIndicator
            startedAt={activeTurnStartedAt ?? session.events?.[session.events.length - 1]?.timestamp ?? session.startedAt}
            statusText={liveActivityText ?? liveActivity(session) ?? 'Working…'}
            provider={activityProvider ?? session.provider}
            model={session.model}
          />
        </div>
      )}

      {!isExecuting && !visibleResponseText && conversationEvents.length === 0 && !isSelectedFailed && (
        <span className="placeholder-text">Waiting for the agent to respond…</span>
      )}
    </div>
  );
}
