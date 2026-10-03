import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';
import { AssistantComposer } from './AssistantComposer';
import { AssistantMessageCard } from './AssistantMessageCard';
import { useAssistant } from './AssistantProvider';
import { PERSONAS } from './personaMeta';

const GENERAL_PROMPTS = ['What should I work on next?', 'Explain how Praxis governs a workflow'];

/** The one conversation UI; the shell decides whether it floats or docks around it. */
export function AssistantPanel({ focusSignal }: { focusSignal: number }) {
  const a = useAssistant();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stuckToBottom.current) element.scrollTop = element.scrollHeight;
  }, [a.messages, a.busy]);

  const prompts = a.pageContext?.suggestedPrompts?.length ? a.pageContext.suggestedPrompts : a.pageContext ? [] : GENERAL_PROMPTS;
  const send = (text: string) => { a.setDraft(''); void a.send(text); };

  return (
    <section className="assistant-panel" aria-label="Virtual team assistant" data-testid="assistant-panel">
      <header className="assistant-header">
        <div className="assistant-header-title">
          <strong><Icon name="sparkles" size={14} /> Virtual Team</strong>
          <span className="assistant-roster" aria-label="Team roster">
            {PERSONAS.map(persona => (
              <span key={persona.id} className={`persona-badge persona-badge--${persona.id}`} title={`${persona.name} — @${persona.id}`}>
                <Icon name={persona.icon} size={11} />
              </span>
            ))}
          </span>
        </div>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="New team chat" data-testid="assistant-new-chat" onClick={a.newChat}>
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn-sm${a.docked ? ' is-active' : ''}`}
          aria-label={a.docked ? 'Unpin assistant to floating' : 'Pin assistant to the side'}
          aria-pressed={a.docked}
          data-testid="assistant-pin"
          onClick={() => a.setDocked(!a.docked)}
        >
          <Icon name="pin" size={13} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close assistant" data-testid="assistant-close" onClick={() => a.setOpen(false)}>
          <Icon name="close" size={13} />
        </button>
      </header>

      <div
        className="assistant-feed"
        ref={scrollRef}
        data-testid="assistant-feed"
        onScroll={event => {
          const el = event.currentTarget;
          stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {a.messages.length === 0 && (
          <div className="assistant-empty">
            <Icon name="sparkles" size={18} />
            <p>Ask your engineering team. The Tech Lead answers by default; <code>@qa</code>, <code>@dev</code>, <code>@security</code> and <code>@product</code> pull in a specialist.</p>
          </div>
        )}
        {a.messages.map(message => (
          <AssistantMessageCard
            key={message.id}
            message={message}
            applied={a.appliedActions[message.id]}
            disabled={a.busy}
            onChoice={send}
            onApply={() => message.proposedAction && void a.applyAction(message.id, message.proposedAction)}
          />
        ))}
        {a.busy && <div className="assistant-message is-persona"><span className="placeholder-text">The team is thinking…</span></div>}
      </div>

      {a.error && <div className="error-banner assistant-error" role="alert">{a.error}</div>}

      <div className="assistant-context-row">
        {a.availableContext && (
          <button
            type="button"
            className={`assistant-context-pill${a.contextDetached ? ' is-detached' : ''}`}
            data-testid="assistant-context-pill"
            aria-label={a.contextDetached ? `Attach context: ${a.availableContext.title}` : `Detach context: ${a.availableContext.title}`}
            onClick={() => a.setContextDetached(!a.contextDetached)}
          >
            <Icon name={a.contextDetached ? 'plus' : 'close'} size={10} />
            <span>Context: {a.availableContext.title}</span>
          </button>
        )}
        {prompts.length > 0 && (
          <div className="assistant-suggestions" data-testid="assistant-suggestions">
            {prompts.map(prompt => (
              <button key={prompt} type="button" className="assistant-chip" disabled={a.busy} onClick={() => send(prompt)}>{prompt}</button>
            ))}
          </div>
        )}
      </div>

      <AssistantComposer
        value={a.draft}
        onChange={a.setDraft}
        busy={a.busy}
        focusSignal={focusSignal}
        onSend={() => send(a.draft)}
        onTeamReview={() => void a.runTeamReview()}
      />
    </section>
  );
}
