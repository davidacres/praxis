import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { PERSONAS } from './personaMeta';

interface AssistantComposerProps {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  onTeamReview: () => void;
  /** Bumped by the shell to pull focus into the box (on open). */
  focusSignal: number;
}

/** The `@partial` token ending at the caret, if any. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@(\w*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2].toLowerCase() } : undefined;
}

export function AssistantComposer({ value, onChange, busy, onSend, onTeamReview, focusSignal }: AssistantComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const mention = mentionQuery(value, caret);
  const matches = mention ? PERSONAS.filter(persona => persona.id.startsWith(mention.query)) : [];
  const menuOpen = matches.length > 0;

  useEffect(() => { ref.current?.focus(); }, [focusSignal]);
  useEffect(() => setHighlight(0), [mention?.query]);

  const insert = (id: string) => {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${id} ${value.slice(caret)}`;
    const position = mention.start + id.length + 2;
    onChange(next);
    setCaret(position);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  };

  return (
    <div className="assistant-composer composer">
      {menuOpen && (
        <ul className="assistant-mention-menu" role="listbox" aria-label="Mention a team member" data-testid="assistant-mention-menu">
          {matches.map((persona, index) => (
            <li key={persona.id} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={`assistant-mention-option${index === highlight ? ' is-active' : ''}`}
                onMouseDown={event => { event.preventDefault(); insert(persona.id); }}
              >
                <span className={`persona-badge persona-badge--${persona.id}`}><Icon name={persona.icon} size={12} /></span>
                <span>@{persona.id}</span>
                <small>{persona.name}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        className="composer-input assistant-input"
        value={value}
        rows={2}
        placeholder="Ask the team… use @qa, @dev, @security"
        aria-label="Message the virtual team"
        data-testid="assistant-input"
        disabled={busy}
        onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={event => {
          if (menuOpen) {
            if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight(index => (index + 1) % matches.length); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(index => (index - 1 + matches.length) % matches.length); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insert(matches[highlight].id); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCaret(0); return; }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (value.trim() && !busy) onSend();
          }
        }}
      />
      <div className="composer-controls">
        <button type="button" className="btn btn-sm assistant-team-review" disabled={busy} onClick={onTeamReview} data-testid="assistant-team-review">
          <Icon name="sparkles" size={12} /> Team Review
        </button>
        <span className="spacer" />
        <button type="button" className="composer-send" aria-label="Send to the team" data-testid="assistant-send" disabled={!value.trim() || busy} onClick={onSend}>
          <Icon name="arrow-up" size={13} />
        </button>
      </div>
    </div>
  );
}
