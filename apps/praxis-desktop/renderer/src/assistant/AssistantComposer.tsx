import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { SessionComposerCard, SessionComposerHeader, SessionComposerInput, SessionContextRing } from '../ai/SessionComposerFrame';
import { SessionComposerToolbar } from '../ai/SessionComposerToolbar';
import { SessionComposerActivityOrbit } from '../ai/SessionComposerActivityOrbit';
import { useAssistantMention } from './useAssistantMention';

interface AssistantComposerProps {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  sendLabel: string;
  /** Bumped by the shell to pull focus into the box (on open). */
  focusSignal: number;
  composerOptions: ReactNode;
  headerOptions: ReactNode;
}

export function AssistantComposer({ value, onChange, busy, onSend, sendLabel, focusSignal, composerOptions, headerOptions }: AssistantComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const mention = useAssistantMention(value, caret);

  useEffect(() => { ref.current?.focus(); }, [focusSignal]);

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
    <SessionComposerCard className={`assistant-composer${busy ? ' is-collapsed is-running' : ''}`} data-testid="assistant-composer">
      {busy && <SessionComposerActivityOrbit testId="assistant-composer-activity-orbit" />}
      {!busy && <SessionComposerHeader data-testid="assistant-mode-panel">{headerOptions}</SessionComposerHeader>}
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
      <SessionComposerInput
        ref={ref}
        value={value}
        collapsed={busy}
        placeholder="Ask selected members… or @mention a member"
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
      <SessionComposerToolbar>
        {busy ? <span className="composer-chip session-runtime-chip is-readonly session-activity-chip" data-testid="assistant-composer-activity-chip"><Icon name="sparkles" size={13} /> The team is thinking…</span> : composerOptions}
        <span className="spacer" />
        {!busy && <span className="session-context-chip" data-testid="assistant-context-indicator" title="Context usage is not reported for Virtual Team chat" role="img" aria-label="Context usage unavailable">
          <SessionContextRing percent={0} />
        </span>}
        {!busy && <button type="button" className="composer-send" aria-label={sendLabel} title={sendLabel} data-testid="assistant-send" disabled={!value.trim()} onClick={onSend}>
          <Icon name="arrow-up" size={15} />
        </button>}
      </SessionComposerToolbar>
    </SessionComposerCard>
  );
}
