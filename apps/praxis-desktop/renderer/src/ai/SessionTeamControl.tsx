import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { PERSONAS } from '../assistant/personaMeta';
import { askSessionTeamMember, toggleSessionTeamMember, useSessionTeam } from './sessionTeamStore';

interface SessionTeamControlProps {
  session: AgentSessionRecord;
  disabled?: boolean;
  onError?: (message: string) => void;
}

const MENU_GAP = 4;

/**
 * A chip beside the send button that lists the Virtual Team and lets the user
 * add several members to this session. Adding a member starts nothing: the
 * session behaves as normal until the user asks a member (e.g. `@qa …`) to act.
 */
export function SessionTeamControl({ session, disabled = false, onError }: SessionTeamControlProps) {
  const { confirm } = useDialogs();
  const { members, busy } = useSessionTeam(session.issueKey);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const place = () => {
      if (!chipRef.current) return;
      const rect = chipRef.current.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 220;
      const width = menuRef.current?.offsetWidth ?? 240;
      const top = rect.top - MENU_GAP - height >= MENU_GAP ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP;
      const left = Math.max(MENU_GAP, Math.min(rect.right - width, window.innerWidth - width - MENU_GAP));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (role: (typeof PERSONAS)[number]['id']) => {
    const { adding, next } = toggleSessionTeamMember(session.issueKey, role);
    // A lone reviewing member usually means "review this" — offer, never assume.
    if (!(adding && next.length === 1 && (role === 'qa' || role === 'security'))) return;
    // Close the picker first so the dialog is never stacked on top of it.
    setOpen(false);
    const name = PERSONAS.find(persona => persona.id === role)?.name ?? role;
    void confirm({
      title: `Request a review from ${name}?`,
      message: `${name} will review this session's work so far. The session itself is not changed. Choose Not now to just keep ${name} on the team and ask later with @${role}.`,
      confirmLabel: 'Request review',
      cancelLabel: 'Not now',
      danger: false
    }).then(ok => {
      if (!ok) return;
      askSessionTeamMember(session, role, 'Review the work in this session so far. Report findings, risks and concrete recommendations. Do not make changes.')
        .catch(error => onError?.(error instanceof Error ? error.message : String(error)));
    });
  };

  const count = members.length;
  const title = count === 0 ? 'Add team members to this session' : `Team: ${members.map(id => PERSONAS.find(p => p.id === id)?.name ?? id).join(', ')}`;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-team-chip${open ? ' active' : ''}${count > 0 ? ' has-members' : ''}`}
        aria-label={count === 0 ? 'Session team' : `Session team, ${count} selected`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        data-testid="session-team-chip"
        disabled={disabled || busy}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name="users" size={14} />
        {count > 0 && <span className="composer-chip-meta" data-testid="session-team-count">{count}</span>}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="composer-provider-menu chip-select-menu session-team-menu"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Session team members"
          data-testid="session-team-menu"
          style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? undefined : 'hidden' }}
          onPointerDown={event => event.stopPropagation()}
        >
          <div className="popover-label">Team members — ask one with @mention</div>
          {PERSONAS.map(persona => {
            const selected = members.includes(persona.id);
            return (
              <button
                key={persona.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`composer-provider-option chip-select-option${selected ? ' active' : ''}`}
                data-testid={`session-team-member-${persona.id}`}
                onClick={() => toggle(persona.id)}
              >
                <span className={`persona-badge persona-badge--${persona.id}`}><Icon name={persona.icon} size={12} /></span>
                <span className="chip-select-option-text">
                  <span className="chip-select-option-label">{persona.name}</span>
                  <span className="chip-select-option-desc">@{persona.id}</span>
                </span>
                {selected && <Icon name="check" size={12} className="chip-select-check" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}
