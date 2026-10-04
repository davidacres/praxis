import type { AssistantMessage } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { personaMeta } from './personaMeta';

interface AssistantMessageCardProps {
  message: AssistantMessage;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AssistantMessageCard({ message }: AssistantMessageCardProps) {
  if (message.role === 'user') {
    return (
      <div className="assistant-message is-user" data-testid="assistant-message-user">
        <span>{message.text}</span>
      </div>
    );
  }
  const persona = personaMeta(message.role);
  const action = message.proposedAction;
  return (
    <article
      className={`assistant-message is-persona persona-${persona.id}${message.error ? ' is-error' : ''}`}
      data-testid={`assistant-message-${persona.id}`}
    >
      <header className="assistant-message-head">
        <span className={`persona-badge persona-badge--${persona.id}`}>
          <Icon name={persona.icon} size={12} />
          <span>{persona.badge}</span>
        </span>
        <strong>{persona.name}</strong>
        <time>{formatTime(message.createdAt)}</time>
      </header>
      <div className="assistant-message-body"><Markdown text={message.text} /></div>
      {message.choices && message.choices.length > 0 && (
        <p className="assistant-message-suggestions" data-testid="assistant-message-suggestions">
          Suggestions: {message.choices.map(choice => choice.label).join(' · ')}
        </p>
      )}
      {action && (
        <div className="assistant-action-card" data-testid="assistant-action-card">
          <div className="assistant-action-summary">
            <Icon name="sparkles" size={13} />
            <span>Suggested action: {action.summary}</span>
          </div>
        </div>
      )}
    </article>
  );
}
