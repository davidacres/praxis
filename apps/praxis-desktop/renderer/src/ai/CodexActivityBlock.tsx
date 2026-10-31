import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import type { ThoughtToolCall } from '../ui/ThoughtBlock';
import { parseCodexActivityUpdates } from './codexActivity';

interface CodexActivityBlockProps {
  steps: readonly string[];
  caption?: string;
  toolCalls?: readonly ThoughtToolCall[];
  streaming?: boolean;
  testIdPrefix?: string;
}

/** Presents Codex CLI's ACP thought chunks as the progress updates they read like. */
export function CodexActivityBlock({
  steps,
  caption,
  toolCalls = [],
  streaming = false,
  testIdPrefix = 'session'
}: CodexActivityBlockProps) {
  const updates = steps.flatMap(parseCodexActivityUpdates);
  const latest = updates.at(-1);
  const disclosureId = `${testIdPrefix}-activity-disclosure`;

  if (updates.length === 0 && toolCalls.length === 0) return null;

  return (
    <details
      className={`session-chat-activity${streaming ? ' session-chat-activity-streaming' : ''}`}
      data-testid={disclosureId}
    >
      <summary className="session-chat-activity-summary" data-testid={`${testIdPrefix}-activity-summary`}>
        <Icon name="radio-tower" size={11} />
        <span className="session-chat-activity-label">Activity</span>
        {latest && <span className="session-chat-activity-current">{latest}</span>}
        {caption && <span className="session-chat-activity-meta">{caption}</span>}
      </summary>
      <div className="session-chat-activity-content" data-testid={`${testIdPrefix}-activity-history`}>
        {toolCalls.length > 0 && (
          <ul className="session-chat-thought-tools" data-testid={`${testIdPrefix}-activity-tools`}>
            {toolCalls.map((call, callIndex) => (
              <li key={call.callId ?? `${call.name}-${callIndex}`} className={call.ok === false ? 'is-failed' : undefined}>
                <Icon name={call.ok === false ? 'close' : call.ok ? 'check' : 'tools'} size={11} />
                <span className="session-chat-thought-tool-name">{call.name}</span>
                {call.detail && <span className="session-chat-thought-tool-detail">{call.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <ol className="session-chat-activity-updates">
          {updates.map((update, index) => (
            <li key={`${index}-${update}`} data-testid={`${testIdPrefix}-activity-update`}>
              <Markdown text={update} testId={`${testIdPrefix}-activity-markdown`} />
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
