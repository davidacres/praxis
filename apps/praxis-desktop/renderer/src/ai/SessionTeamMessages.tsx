import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { personaMeta } from '../assistant/personaMeta';
import { useSessionTeam } from './sessionTeamStore';

/** A session's Virtual Team replies as ordinary chat turns; render at the end of any transcript. */
export function SessionTeamMessages({ sessionKey }: { sessionKey: string }) {
  const { messages, busy } = useSessionTeam(sessionKey);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (messages.length > 0 || busy) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy]);
  if (messages.length === 0 && !busy) return null;
  return (
    <>
      {messages.map(message => message.role === 'user' ? (
        <div className="session-chat-message is-user" key={message.id} data-testid="session-team-user">
          <div className="session-chat-author">You</div>
          <Markdown text={message.text} testId="session-chat-markdown" imageSessionId={sessionKey} />
        </div>
      ) : (
        <div className={`session-chat-message is-assistant${message.error ? ' is-error' : ''}`} key={message.id} data-testid={`assistant-message-${message.role}`}>
          <div className="session-chat-header">
            <div className="session-chat-author">
              <span className={`persona-badge persona-badge--${message.role}`}><Icon name={personaMeta(message.role).icon} size={12} /></span>
              <span>{personaMeta(message.role).name}</span>
            </div>
          </div>
          <Markdown text={message.text} testId="session-chat-markdown" imageSessionId={sessionKey} />
        </div>
      ))}
      {busy && <span className="placeholder-text" data-testid="session-team-thinking">The team member is thinking…</span>}
      <div ref={endRef} />
    </>
  );
}
