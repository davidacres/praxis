import type { AssistantMessage } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { personaMeta } from './personaMeta';
import { AssistantActionCard } from './AssistantActionCard';

interface AssistantMessageCardProps {
  message: AssistantMessage;
  /** Outcome line once the proposed action has been applied. */
  applied?: string;
  disabled: boolean;
  onChoice: (prompt: string) => void;
  onApply: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AssistantMessageCard({ message, applied, disabled, onChoice, onApply }: AssistantMessageCardProps) {
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
        <div className="assistant-choices" role="group" aria-label="Suggested replies">
          {message.choices.map(choice => (
            <button key={choice.label} type="button" className="assistant-chip" disabled={disabled} onClick={() => onChoice(choice.prompt)}>
              {choice.label}
            </button>
          ))}
        </div>
      )}
      {action && <AssistantActionCard action={action} applied={applied} disabled={disabled} onApply={onApply} />}
    </article>
  );
}
