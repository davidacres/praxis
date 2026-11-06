import { useAssistant } from './AssistantProvider';
import { AssistantActionCard } from './AssistantActionCard';
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
  const a = useAssistant();
  const pinned = Boolean(a.conversation?.pinnedMessageIds.includes(message.id));
  /**
   * One pin/unpin command per click, fenced by conversation + command id + revision + message id.
   * The marker that follows is read from the next snapshot, never from a renderer-side cache, so a
   * pin made in another window appears here too.
   */
  const togglePin = () => {
    const conversation = a.conversation;
    if (!conversation) return;
    void window.praxis.assistant.control({
      conversationId: conversation.id,
      commandId: crypto.randomUUID(),
      expectedRevision: conversation.revision,
      action: pinned ? 'unpin' : 'pin',
      messageId: message.id
    }).catch(err => a.reportError(err instanceof Error ? err.message : String(err)));
  };
  /**
   * The accessible name is the visible label — the durableTeamChat spec (and a screen reader
   * hearing the surrounding message) both rely on that. The role and message identity ride the
   * tooltip and `data-*` instead of making the button say something the ink does not.
   */
  const pinButton = (
    <button
      type="button"
      className="btn btn-sm assistant-pin-decision"
      aria-pressed={pinned}
      title={`${pinned ? 'Unpin' : 'Pin'} ${message.role === 'user' ? 'your' : `${personaMeta(message.role).name}'s`} decision (${message.id}) — pinned decisions are kept verbatim in later context`}
      data-testid={pinned ? 'assistant-unpin-decision' : 'assistant-pin-decision'}
      data-message-id={message.id}
      data-message-role={message.role}
      onClick={togglePin}
    >{pinned ? 'Unpin decision' : 'Pin decision'}</button>
  );
  if (message.role === 'user') {
    // The bubble itself keeps only the message text; the pin control sits beside it in a row, so
    // the bubble's own text content stays exactly what the user wrote.
    return (
      <div className="assistant-message-row is-user">
        <div className="assistant-message is-user" data-testid="assistant-message-user"><span>{message.text}</span></div>
        {pinned && <span className="assistant-pinned-marker" data-testid="assistant-pinned-marker" title="You pinned this as a decision the team keeps verbatim"><Icon name="pin" size={11} /> Pinned decision</span>}
        {a.conversation?.messages.some(item => item.id === message.id) && pinButton}
      </div>
    );
  }
  const persona = personaMeta(message.role);
  const action = message.proposedAction;
  const owned = a.conversation?.messages.some(item => item.id === message.id);
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
      {action && owned && <AssistantActionCard action={action} applied={a.appliedActions[message.id]} disabled={false} onApply={() => void a.applyAction(message.id, action)} />}
      {action && !owned && <div className="assistant-action-card"><div className="assistant-action-summary">Suggested action: {action.summary}</div></div>}
      {owned && a.conversation && <>
        {pinned && <span className="assistant-pinned-marker" data-testid="assistant-pinned-marker" title="You pinned this as a decision the team keeps verbatim"><Icon name="pin" size={11} /> Pinned decision</span>}
        {pinButton}
      </>}
    </article>
  );
}
