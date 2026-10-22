import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { EMPTY_REASON_COPY, type ThoughtEmptyReason } from './thoughtDisplay';

/**
 * One tool call in a thought block's timeline. Structurally identical to
 * `chatToolCalls.ToolCallRow`; redeclared here so `src/ui` stays free of
 * `src/ai` imports rather than depending on the caller's collection code.
 */
export interface ThoughtToolCall {
  name: string;
  callId?: string;
  /** Short human summary of the arguments, e.g. the file path. */
  detail?: string;
  /** Undefined while the call is still running. */
  ok?: boolean;
}



export interface ThoughtBlockProps {
  /**
   * Reasoning steps in order, already merged by `chatThought.mergeReasoningStep`
   * so cumulative and incremental providers both land here as distinct steps.
   */
  steps?: readonly string[];
  /** `4m 2s · 3 tool calls` — see `chatThought.captionText`. */
  caption?: string;
  /** Tool-call timeline shown above the reasoning inside the block. */
  toolCalls?: readonly ThoughtToolCall[];
  /**
   * A live turn. Opens the block by default and pulses the marker, so the user
   * sees reasoning arrive. Settling a turn keeps the same widget — previously
   * the streaming variant was a separate open `<details>` labelled "Thoughts"
   * that collapsed and moved a DOM level deeper the instant the turn finished.
   */
  streaming?: boolean;
  /** Shown when there is neither a step nor a tool call to display. */
  emptyReason?: ThoughtEmptyReason;
  /**
   * Prefix for the block's test ids, so each surface keeps the ids its e2e
   * spec already asserts on (`session`, `review`).
   */
  testIdPrefix?: string;
  /** Session key for image resolution inside the reasoning markdown. */
  imageSessionId?: string;
  className?: string;
  /** Extra content rendered inside the block, after the tool timeline. */
  children?: ReactNode;
}

/**
 * The single reasoning widget for every surface that shows model thinking.
 *
 * Before this component the same reasoning string was rendered by five
 * different widgets with two labels ("Thought"/"Thoughts"), two default-open
 * behaviours and three class namespaces, so identical content looked different
 * depending on where it appeared and whether the turn was still streaming.
 * See `docs/research/model-reasoning-response-shapes.md` §5, §F9.
 */
export function ThoughtBlock({
  steps = [],
  caption,
  toolCalls = [],
  streaming = false,
  emptyReason = 'unknown',
  testIdPrefix = 'session',
  imageSessionId,
  className = '',
  children
}: ThoughtBlockProps) {
  const visibleSteps = steps.filter(step => step.trim().length > 0);
  const disclosureId = `${testIdPrefix}-thought-disclosure`;
  const summaryId = `${testIdPrefix}-thought-summary`;
  const reasoningId = `${testIdPrefix}-thought-reasoning`;
  // One id for both the streaming and the settled state: the whole point of
  // this component is that a live turn and the turn it settles into render the
  // same DOM, differing only by whether the disclosure is open.
  const markdownId = `${testIdPrefix}-thought-markdown`;
  const toolsId = `${testIdPrefix}-thought-tools`;

  const isEmpty = visibleSteps.length === 0 && toolCalls.length === 0 && !children;

  // A live turn streams its reasoning open; once settled the same block is a
  // collapsed caption. Keeping one widget for both is what removes the jolt.
  const classes = ['session-chat-thought', className.trim()];
  if (streaming) classes.push('session-chat-thought-streaming');
  if (isEmpty) classes.push('session-chat-thought-empty');

  return (
    <details className={classes.filter(Boolean).join(' ')} data-testid={disclosureId} open={streaming || undefined}>
      <summary className="session-chat-thought-summary" data-testid={summaryId}>
        <Icon name="sparkles" size={11} />
        <span className="session-chat-thought-label">Thought</span>
        {caption && <span className="session-chat-thought-meta">{caption}</span>}
      </summary>
      <div className={`session-chat-thought-content${streaming ? ' session-chat-streaming-text' : ''}`}>
        {isEmpty ? (
          <p className="session-chat-thought-none" data-testid={`${testIdPrefix}-thought-none`}>
            {EMPTY_REASON_COPY[emptyReason]}
          </p>
        ) : (
          <>
            {toolCalls.length > 0 && (
              <ul className="session-chat-thought-tools" data-testid={toolsId}>
                {toolCalls.map((call, callIndex) => (
                  <li key={call.callId ?? `${call.name}-${callIndex}`} className={call.ok === false ? 'is-failed' : undefined}>
                    <Icon name={call.ok === false ? 'close' : call.ok ? 'check' : 'tools'} size={11} />
                    <span className="session-chat-thought-tool-name">{call.name}</span>
                    {call.detail && <span className="session-chat-thought-tool-detail">{call.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
            {/* The tool timeline above is the index of the turn; the model's raw
                reasoning is the archive — one expander in, never streamed
                beside the timeline. */}
            {visibleSteps.length > 0 && (
              <details className="session-chat-thought-reasoning" data-testid={reasoningId} open={streaming || undefined}>
                <summary className="session-chat-thought-reasoning-summary">
                  <Icon name="chats" size={11} />
                  Show full reasoning
                </summary>
                <div className="session-chat-thought-reasoning-content">
                  {visibleSteps.map((step, stepIndex) => (
                    <Markdown key={stepIndex} text={step} testId={markdownId} imageSessionId={imageSessionId} />
                  ))}
                </div>
              </details>
            )}
            {children}
          </>
        )}
      </div>
    </details>
  );
}
