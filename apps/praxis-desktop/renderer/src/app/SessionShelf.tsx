import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { recencyBucket, sessionLastActivityAt } from './sessionRecency';
import { isConversationSession, sessionTitle } from '../ai/sessionNav';
import { agentStateLaneClass, sessionStatusLabel, sessionVisualState } from '../ai/aiSessionState';
import { Icon } from '../ui/Icon';

const SHELF_SESSION_LIMIT = 5;

/**
 * The collapsed sidebar's hidden shelf: a thin vertical line of session spines
 * at the workspace edge. Hovering (or focusing) a spine slides its card out of
 * the sleeve behind the edge — a book pulled from a bookshelf — showing the
 * session's latest exchange with a quick reply at the bottom of the card.
 */
export function SessionShelf({ sessions, activeSessionKey, onSelectSession }: {
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  onSelectSession: (key: string) => void;
}) {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = window.setTimeout(() => setToday(new Date()), midnight.getTime() - now.getTime());
    return () => window.clearTimeout(timer);
  }, [today]);
  const shelfSessions = [...sessions]
    .filter(session => !session.parentSessionKey && !session.workflowRunId)
    .sort((a, b) => sessionLastActivityAt(b).localeCompare(sessionLastActivityAt(a)))
    .slice(0, SHELF_SESSION_LIMIT);
  const isTodaySession = (session: AgentSessionRecord) =>
    recencyBucket(sessionLastActivityAt(session), today) === 'today';
  // `revealed` is the logical open state; `mounted` keeps the closing card in
  // the DOM until its slide-back transition ends, so the shelf never pops.
  const [revealed, setRevealed] = useState<string>();
  const [mounted, setMounted] = useState<string>();
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;
  const closeTimer = useRef<number>();
  const sleeveRef = useRef<HTMLDivElement>(null);
  const spinesRef = useRef<HTMLDivElement>(null);
  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const deferClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setRevealed(undefined), 140);
  };
  const reveal = (key: string) => { cancelClose(); setRevealed(key); setMounted(key); };
  const close = () => { cancelClose(); setRevealed(undefined); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  // Leaving the shelf by keyboard tucks the card away once focus is elsewhere.
  useEffect(() => {
    const spines = spinesRef.current;
    const sleeve = sleeveRef.current;
    if (!spines || !sleeve) return;
    const handle = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (spines.contains(next) || sleeve.contains(next)) return;
      if (spines.matches(':hover') || sleeve.matches(':hover')) return;
      deferClose();
    };
    spines.addEventListener('focusout', handle);
    sleeve.addEventListener('focusout', handle);
    return () => {
      spines.removeEventListener('focusout', handle);
      sleeve.removeEventListener('focusout', handle);
    };
  }, []);
  // The sleeve must stay out of the tab order while tucked away, or its reply
  // field would trap keyboard users on an invisible card.
  const open = revealed !== undefined;
  useEffect(() => {
    const sleeve = sleeveRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (sleeve) sleeve.inert = !open;
  }, [open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      const index = shelfSessions.findIndex(session => session.issueKey === revealed);
      setRevealed(undefined);
      spinesRef.current?.querySelectorAll<HTMLButtonElement>('.session-shelf__spine')[index]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, revealed, shelfSessions]);
  return <nav className="session-shelf" aria-label="Session shelf" data-testid="session-shelf">
    <div className="session-shelf__spines" ref={spinesRef} onScroll={close}>
      {shelfSessions.map(session => <ShelfSpine key={session.issueKey} session={session}
        today={isTodaySession(session)}
        active={activeSessionKey === session.issueKey} open={revealed === session.issueKey}
        onReveal={() => reveal(session.issueKey)} onHide={deferClose} />)}
    </div>
    <div className={`session-shelf__sleeve${open ? ' is-open' : ''}`} ref={sleeveRef}
      aria-hidden={!open}
      onPointerEnter={cancelClose} onPointerLeave={deferClose}>
      {shelfSessions.map(session => mounted === session.issueKey
        ? <ShelfCard key={session.issueKey} session={session} open={revealed === session.issueKey}
          onClosed={key => setMounted(current => current === key && revealedRef.current !== key ? undefined : current)}
          onOpenSession={key => { close(); onSelectSession(key); }} />
        : null)}
    </div>
  </nav>;
}

function ShelfSpine({ session, today, active, open, onReveal, onHide }: {
  session: AgentSessionRecord;
  today: boolean;
  active: boolean;
  open: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  const title = sessionTitle(session);
  return <button type="button" className={`session-shelf__spine${today ? ' is-today' : ''}`}
    data-testid="session-shelf-spine" data-recency={today ? 'today' : 'earlier'}
    aria-label={`Preview ${title}`} aria-expanded={open} aria-current={active ? 'true' : undefined}
    onPointerEnter={onReveal} onFocus={onReveal} onClick={onReveal} onBlur={onHide} />;
}

/** The last assistant or user message in the session, for the card's quote block. */
function latestMessage(session: AgentSessionRecord): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== 'message' && event.type !== 'user_input_completed') continue;
    const text = (event.detail || event.summary || '').trim();
    if (text) return text;
  }
  return undefined;
}

function ShelfCard({ session, open, onOpenSession, onClosed }: {
  session: AgentSessionRecord;
  open: boolean;
  onOpenSession: (key: string) => void;
  onClosed: (key: string) => void;
}) {
  const [hydrated, setHydrated] = useState<AgentSessionRecord>();
  useEffect(() => {
    if (session.eventsLoaded || session.events.length > 0) return;
    let cancelled = false;
    void window.praxis.ai.getSession(session.issueKey).then(full => {
      if (!cancelled && full) setHydrated(full);
    });
    return () => { cancelled = true; };
  }, [session.issueKey, session.eventsLoaded, session.events.length]);
  const title = sessionTitle(session);
  const ticketKey = session.linkedIssueKey ?? (isConversationSession(session) ? undefined : session.issueKey);
  const status = sessionStatusLabel(session);
  const lane = agentStateLaneClass(sessionVisualState(session));
  const message = latestMessage(session.events.length > 0 ? session : (hydrated ?? session));
  // The card mounts tucked, then opens on the next frame — that first painted
  // position is what the slide-out transition animates from.
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(open); }, [open]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    setError(undefined);
    try {
      if (session.conversation?.state === 'running') {
        await window.praxis.ai.sendConversationMessage(session.issueKey, {
          participantId: session.conversation.currentSpeakerId,
          message: text
        });
      } else {
        await window.praxis.ai.continueSession(session.issueKey, text);
      }
      setReply('');
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return <article className={`session-shelf__card${shown ? ' is-open' : ''}`}
    aria-label={`Session preview: ${title}`} data-testid="session-shelf-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(session.issueKey); }}>
    <header className="session-shelf__meta">
      {ticketKey && <span className="session-shelf__key">{ticketKey}</span>}
      <span className={`session-shelf__status ${lane}`} data-testid="session-shelf-status">{status}</span>
    </header>
    <h2 className="session-shelf__title">{title}</h2>
    {message && <p className="session-shelf__message">{message}</p>}
    <p className="session-shelf__agent"><span className={`session-shelf__agent-dot ${lane}`} aria-hidden />{status}</p>
    <form className="session-shelf__reply" onSubmit={send} data-testid="session-shelf-reply">
      <div className="session-shelf__reply-row">
        <input value={reply} disabled={sending} placeholder="Quick reply…" autoComplete="off"
          aria-label={`Quick reply to ${title}`} data-testid="session-shelf-reply-input"
          onChange={event => { setReply(event.target.value); setSent(false); }} />
        <button type="submit" className="session-shelf__send" disabled={!reply.trim() || sending}
          aria-label="Send quick reply"><Icon name="arrow-right" size={14} /></button>
      </div>
      {error && <p className="session-shelf__reply-error" role="alert">{error}</p>}
      {sent && !error && <p className="session-shelf__reply-sent" role="status">Reply sent</p>}
    </form>
    <footer className="session-shelf__foot">
      <span>↵ to send</span>
      <button type="button" onClick={() => onOpenSession(session.issueKey)}>Open session ↗</button>
    </footer>
  </article>;
}
