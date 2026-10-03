import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { useAssistantMention } from './useAssistantMention';

const MAX_LINES = 6;

interface AssistantComposerProps {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  onTeamReview: () => void;
  /** Bumped by the shell to pull focus into the box (on open). */
  focusSignal: number;
}

export function AssistantComposer({ value, onChange, busy, onSend, onTeamReview, focusSignal }: AssistantComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const mention = useAssistantMention(value, caret);

  useEffect(() => { ref.current?.focus(); }, [focusSignal]);

  // Grow with the text up to MAX_LINES, then scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3 || 18;
    const chrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    el.style.height = 'auto';
    const max = lineHeight * MAX_LINES + chrome;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const insert = (id: string) => {
    const next = mention.insert(id);
    if (!next) return;
    onChange(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="assistant-composer composer">
      {mention.open && (
        <ul className="assistant-mention-menu" role="listbox" aria-label="Mention a team member" data-testid="assistant-mention-menu">
          {mention.matches.map((persona, index) => (
            <li key={persona.id} role="option" aria-selected={index === mention.highlight}>
              <button
                type="button"
                className={`assistant-mention-option${index === mention.highlight ? ' is-active' : ''}`}
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
          if (mention.open) {
            const count = mention.matches.length;
            if (event.key === 'ArrowDown') { event.preventDefault(); mention.setHighlight(index => (index + 1) % count); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); mention.setHighlight(index => (index - 1 + count) % count); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insert(mention.matches[mention.highlight].id); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); mention.dismiss(); return; }
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
