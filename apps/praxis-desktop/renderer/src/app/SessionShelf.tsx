import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentSessionRecord, AgentTaskState, ProjectRecord } from '@praxis/core';
import { recencyBucket, sessionLastActivityAt } from './sessionRecency';
import { isConversationSession, isSynthesizedKey, sessionTitle } from '../ai/sessionNav';
import { sessionStatusLabel, sessionVisualState } from '../ai/aiSessionState';
import { providerLabel } from '../ai/modelProviders';
import { Icon } from '../ui/Icon';
import { flush as flushNotes, useNotesSession } from '../notes/notesSession';
import { ShelfGlyph } from './shelfGlyphs';
import { ShelfNewSessionCard, type ShelfStartInput } from './ShelfNewSessionCard';
import { ShelfNoteCard } from './ShelfNoteCard';

const SHELF_SESSION_LIMIT = 5;
const HOVER_DELAY_MS = 120;
// The sleeve's open keys for the two creation cards; session cards use their issue key.
const NOTES_KEY = 'praxis:notes';
const NEW_KEY = 'praxis:new-session';
// Window-local drafts survive card switches and sidebar expansion, without
// persisting unsent text to disk. Successful sends remove their draft.
const replyDrafts = new Map<string, string>();

type ShelfAction = 'new' | 'notes';

/** Sends text into an existing session the way its own composer would. */
async function sendToSession(session: AgentSessionRecord, text: string): Promise<void> {
  if (session.conversation?.state === 'running') {
    await window.praxis.ai.sendConversationMessage(session.issueKey, { participantId: session.conversation.currentSpeakerId, message: text });
  } else {
    await window.praxis.ai.continueSession(session.issueKey, text);
  }
}

/**
 * The collapsed sidebar's hidden shelf: a thin vertical line of session spines
 * at the workspace edge. Hovering (or focusing) a spine slides its card out of
 * the sleeve behind the edge — a book pulled from a bookshelf — showing the
 * session's latest exchange with a quick reply at the bottom of the card.
 *
 * Two tinted cells at the foot of the rail start a session or a note. Each card
 * slides out level with the cell that opened it, edged in that cell's colour; a
 * session started here stays here, as that session's preview card.
 */
export function SessionShelf({ sessions, activeSessionKey, onSelectSession, onOpenComposer, onStartSession, onOpenAiSettings, notesProjectId, ticketKey, projects }: {
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  onSelectSession: (key: string) => void;
  /** Opens the full New Session page, carrying any goal typed so far. */
  onOpenComposer: (goal?: string) => void;
  /** Starts a session without leaving the page; resolves with the new record. */
  onStartSession: (input: ShelfStartInput) => Promise<AgentSessionRecord>;
  onOpenAiSettings: () => void;
  notesProjectId?: string;
  /** The ticket open behind the shelf, offered as a new session's context. */
  ticketKey?: string;
  projects: ProjectRecord[];
}) {
  const notesState = useNotesSession();
  const notesUnsaved = notesState.dirty || notesState.save === 'error';
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = window.setTimeout(() => setToday(new Date()), midnight.getTime() - now.getTime());
    return () => window.clearTimeout(timer);
  }, [today]);
  // A session started from the shelf is shown at once, before the session list catches up with it.
  const [started, setStarted] = useState<AgentSessionRecord>();
  const startedListed = started !== undefined && sessions.some(session => session.issueKey === started.issueKey);
  useEffect(() => { if (startedListed) setStarted(undefined); }, [startedListed]);
  const listed = started && !startedListed ? [started, ...sessions] : sessions;
  // The key of a session started here, whose card stays level with the new-session cell until another card opens.
  const [startedKey, setStartedKey] = useState<string>();
  const shelfSessions = [...listed]
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
  const hoverTimer = useRef<number>();
  const flagTimer = useRef<number>();
  const [cardOffset, setCardOffset] = useState(0);
  const [prefill, setPrefill] = useState<{ id: number; text: string }>();
  const [flag, setFlag] = useState<{ action: ShelfAction; top: number }>();
  const cancelHover = () => window.clearTimeout(hoverTimer.current);
  const shelfRef = useRef<HTMLElement>(null);
  const sleeveRef = useRef<HTMLDivElement>(null);
  const spinesRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const notesButtonRef = useRef<HTMLButtonElement>(null);
  // Every way of tucking the notes card away saves first, so dismissal never loses text.
  const dismiss = () => {
    if (revealedRef.current === NOTES_KEY) void flushNotes();
    setRevealed(undefined);
    setStartedKey(undefined);
  };
  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const deferClose = () => {
    cancelHover();
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      // A reply being edited stays open until focus leaves or the user clicks away.
      if (sleeveRef.current?.contains(document.activeElement)) return;
      dismiss();
    }, 140);
  };
  const reveal = (key: string) => {
    cancelHover(); cancelClose();
    if (revealedRef.current === NOTES_KEY && key !== NOTES_KEY) void flushNotes();
    if (key !== startedKey) setStartedKey(undefined);
    setRevealed(key); setMounted(key); setFlag(undefined);
  };
  const close = () => { cancelHover(); cancelClose(); dismiss(); };
  // The creation cards are typed into, so a passing pointer never replaces them.
  const holdsInput = () => revealedRef.current === NOTES_KEY || revealedRef.current === NEW_KEY;
  const hover = (key: string) => {
    if (holdsInput()) return;
    cancelHover(); cancelClose();
    hoverTimer.current = window.setTimeout(() => reveal(key), HOVER_DELAY_MS);
  };
  const toggle = (key: string) => { if (revealedRef.current === key) close(); else reveal(key); };
  // The label flag replaces the native tooltip: it slides out at the cell's own height.
  const showFlag = (action: ShelfAction, delay: number) => {
    window.clearTimeout(flagTimer.current);
    flagTimer.current = window.setTimeout(() => {
      const button = action === 'new' ? newButtonRef.current : notesButtonRef.current;
      const shelf = shelfRef.current;
      if (!button || !shelf) return;
      setFlag({ action, top: button.getBoundingClientRect().top - shelf.getBoundingClientRect().top });
    }, delay);
  };
  const hideFlag = () => { window.clearTimeout(flagTimer.current); setFlag(undefined); };
  useEffect(() => () => {
    window.clearTimeout(closeTimer.current); window.clearTimeout(hoverTimer.current); window.clearTimeout(flagTimer.current);
    if (revealedRef.current === NOTES_KEY) void flushNotes();
  }, []);
  // Creation cards (and a session just started from one) sit level with their cell;
  // session cards stay beside their spine. Both are clamped inside the workspace at every size.
  const anchoredToNew = mounted === NEW_KEY || (mounted !== undefined && mounted === startedKey);
  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    const card = sleeveRef.current?.querySelector<HTMLElement>('.session-shelf__card');
    if (!shelf || !card) return;
    const position = () => {
      const height = card.getBoundingClientRect().height;
      const shelfTop = shelf.getBoundingClientRect().top;
      const sleevePad = parseFloat(getComputedStyle(sleeveRef.current!).paddingTop) || 0;
      const room = Math.max(0, shelf.clientHeight - sleevePad - height);
      const anchor = mounted === NOTES_KEY ? notesButtonRef.current : anchoredToNew ? newButtonRef.current : undefined;
      if (anchor) {
        setCardOffset(Math.max(0, Math.min(anchor.getBoundingClientRect().bottom - shelfTop - sleevePad - height, room)));
        return;
      }
      const spine = Array.from(spinesRef.current?.querySelectorAll<HTMLElement>('[data-session-key]') ?? [])
        .find(element => element.dataset.sessionKey === mounted);
      if (!spine) return;
      const bounds = spine.getBoundingClientRect();
      const centre = (bounds.top + bounds.bottom) / 2 - shelfTop - sleevePad;
      setCardOffset(Math.max(0, Math.min(centre - height / 2, shelf.clientHeight - 2 * sleevePad - height)));
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(shelf); observer.observe(card);
    return () => observer.disconnect();
  }, [mounted, anchoredToNew]);
  // Capture outside presses even when another control stops propagation or a
  // click on non-focusable content leaves the reply field focused.
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      // Pickers' menus are portalled to <body>, so choosing from one is not an outside press.
      if ((target as Element).closest?.('[role="listbox"]')) return;
      if (spinesRef.current?.contains(target) || actionsRef.current?.contains(target) || sleeveRef.current?.querySelector('.session-shelf__card')?.contains(target)) return;
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(hoverTimer.current);
      dismiss();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, []);
  // Leaving the shelf by keyboard tucks the card away once focus is elsewhere.
  useEffect(() => {
    const spines = spinesRef.current;
    const sleeve = sleeveRef.current;
    const actions = actionsRef.current;
    if (!spines || !sleeve || !actions) return;
    const handle = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (spines.contains(next) || sleeve.contains(next) || actions.contains(next)) return;
      // A picker's portalled menu takes focus from inside the card; that is not leaving.
      if ((next as Element | null)?.closest?.('[role="listbox"]')) return;
      if (spines.matches(':hover') || sleeve.matches(':hover') || actions.matches(':hover')) return;
      deferClose();
    };
    const regions = [spines, sleeve, actions];
    regions.forEach(region => region.addEventListener('focusout', handle));
    return () => regions.forEach(region => region.removeEventListener('focusout', handle));
  }, []);
  // The sleeve must stay out of the tab order while tucked away, or its fields
  // would trap keyboard users on an invisible card.
  const open = revealed !== undefined;
  useEffect(() => {
    const sleeve = sleeveRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (sleeve) sleeve.inert = !open;
  }, [open]);
  // Opening a creation card moves focus into its first field, so typing starts at once and
  // the card is not tucked away when the pointer leaves. After the inert effect above:
  // an inert sleeve cannot take focus.
  const creating = revealed === NOTES_KEY || revealed === NEW_KEY ? revealed : undefined;
  // The sleeve is still visibility: hidden on the frame it opens, and a hidden field
  // ignores focus(), so keep trying for the first few frames of the slide.
  useEffect(() => {
    if (!creating) return;
    let frame = 0;
    let handle = 0;
    // Stop as soon as focus is anywhere in the card, so a quick click on one of its
    // controls (the project picker) is never pulled back to the first field.
    const tryFocus = () => {
      if (sleeveRef.current?.contains(document.activeElement) || document.activeElement?.closest('[role="listbox"]')) return;
      const field = sleeveRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('.session-shelf__card [data-autofocus]');
      field?.focus({ preventScroll: true });
      if (field && document.activeElement === field) field.setSelectionRange(field.value.length, field.value.length);
      else if ((frame += 1) < 20) handle = requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => cancelAnimationFrame(handle);
  }, [creating, prefill?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open) return;
      // An open drop-down (a card's picker) handles Escape first and prevents it.
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (revealed === NOTES_KEY) notesButtonRef.current?.focus();
      else if (revealed === NEW_KEY || revealed === startedKey) newButtonRef.current?.focus();
      else {
        const index = shelfSessions.findIndex(session => session.issueKey === revealed);
        spinesRef.current?.querySelectorAll<HTMLButtonElement>('.session-shelf__spine')[index]?.focus();
      }
      // Restoring focus can reveal the spine again; close after that event.
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, revealed, shelfSessions, startedKey]);

  const projectName = projects.find(project => project.id === notesProjectId)?.name;
  const flagLabel = flag?.action === 'new'
    ? { title: 'New session', detail: projectName ? `in ${projectName}` : undefined }
    : { title: 'Note', detail: notesUnsaved ? '· unsaved draft' : projectName ? `· ${projectName}` : undefined };
  const flagShown = flag && !(flag.action === 'new' ? revealed === NEW_KEY : revealed === NOTES_KEY);
  const actionButton = (action: ShelfAction) => {
    const key = action === 'new' ? NEW_KEY : NOTES_KEY;
    const expanded = revealed === key || (action === 'new' && revealed !== undefined && revealed === startedKey);
    return <button type="button" ref={action === 'new' ? newButtonRef : notesButtonRef}
      className={`session-shelf__action session-shelf__action--${action}${flagShown && flag.action === action ? ' is-flagged' : ''}`}
      data-testid={action === 'new' ? 'session-shelf-new' : 'session-shelf-notes'}
      // The flag is this control's tooltip; an empty title keeps the native one from doubling it.
      title="" aria-label={action === 'new' ? 'New session' : 'Notes'}
      aria-expanded={expanded} aria-controls={action === 'new' ? 'session-shelf-new-card' : 'session-shelf-notes-card'}
      onPointerEnter={() => showFlag(action, HOVER_DELAY_MS)} onPointerLeave={hideFlag}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) showFlag(action, 0); }} onBlur={hideFlag}
      onClick={() => toggle(key)}>
      <ShelfGlyph name={action === 'new' ? 'session' : 'note'} />
      {action === 'notes' && notesUnsaved && <span className="session-shelf__unsaved" data-testid="session-shelf-notes-unsaved" aria-hidden />}
    </button>;
  };
  return <nav className="session-shelf" aria-label="Session shelf" data-testid="session-shelf" ref={shelfRef}
    onPointerEnter={cancelClose} onPointerLeave={deferClose}>
    <div className="session-shelf__spines" ref={spinesRef} onScroll={() => { if (!holdsInput()) close(); }}>
      {shelfSessions.map(session => <ShelfSpine key={session.issueKey} session={session}
        today={isTodaySession(session)}
        active={activeSessionKey === session.issueKey} open={revealed === session.issueKey}
        onReveal={() => reveal(session.issueKey)} onHover={() => hover(session.issueKey)} onLeave={cancelHover} />)}
    </div>
    <div className="session-shelf__actions" ref={actionsRef}>
      {actionButton('new')}
      {actionButton('notes')}
    </div>
    {flagShown && <div className={`session-shelf__flag session-shelf__flag--${flag.action}`} style={{ top: flag.top }}
      aria-hidden data-testid="session-shelf-flag">
      {flagLabel.title}{flagLabel.detail && <small>{flagLabel.detail}</small>}
    </div>}
    <div className={`session-shelf__sleeve${open ? ' is-open' : ''}`} ref={sleeveRef}
      aria-hidden={!open}>
      {mounted === NOTES_KEY && <ShelfNoteCard open={revealed === NOTES_KEY} offset={cardOffset}
        projectId={notesProjectId} projects={projects}
        onUseAsGoal={text => { setPrefill({ id: Date.now(), text }); reveal(NEW_KEY); }}
        onClosed={() => setMounted(current => current === NOTES_KEY && revealedRef.current !== NOTES_KEY ? undefined : current)} />}
      {mounted === NEW_KEY && <ShelfNewSessionCard open={revealed === NEW_KEY} offset={cardOffset}
          projectId={notesProjectId} projects={projects} ticketKey={ticketKey} prefill={prefill}
          sessions={shelfSessions.filter(isTodaySession)}
          onStart={async input => {
            const record = await onStartSession(input);
            setStarted(record); setStartedKey(record.issueKey);
            setRevealed(record.issueKey); setMounted(record.issueKey);
          }}
          onContinue={async (session, text) => { await sendToSession(session, text); reveal(session.issueKey); }}
          onOpenComposer={goal => { close(); onOpenComposer(goal); }}
          onOpenAiSettings={() => { close(); onOpenAiSettings(); }}
          onClosed={() => setMounted(current => current === NEW_KEY && revealedRef.current !== NEW_KEY ? undefined : current)} />}
      {shelfSessions.map(session => mounted === session.issueKey
        ? <ShelfCard key={session.issueKey} session={session} open={revealed === session.issueKey} offset={cardOffset}
          // A session started from the shelf replaces the new-session card in place, already open.
          instant={session.issueKey === startedKey}
          onClosed={key => setMounted(current => current === key && revealedRef.current !== key ? undefined : current)}
          onOpenSession={key => { close(); onSelectSession(key); }} />
        : null)}
    </div>
  </nav>;
}

function ShelfSpine({ session, today, active, open, onReveal, onHover, onLeave }: {
  session: AgentSessionRecord;
  today: boolean;
  active: boolean;
  open: boolean;
  onReveal: () => void;
  onHover: () => void;
  onLeave: () => void;
}) {
  const title = sessionTitle(session);
  const state = sessionVisualState(session);
  const attention = state === 'awaiting_input' || state === 'awaiting_approval';
  return <button type="button" className={`session-shelf__spine${today ? ' is-today' : ''}`}
    data-testid="session-shelf-spine" data-session-key={session.issueKey} aria-description={attention ? sessionStatusLabel(session) : undefined} data-recency={today ? 'today' : 'earlier'}
    aria-label={`Preview ${title}`} aria-expanded={open} aria-current={active ? 'true' : undefined}
    onPointerEnter={onHover} onPointerLeave={onLeave} onFocus={onReveal} onClick={onReveal}>
    {attention && <span className="session-shelf__attention" data-testid="session-shelf-attention" aria-hidden />}
  </button>;
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

/** The band's word and lane for a session: what it needs from you, not its internal state name. */
function bandFor(session: AgentSessionRecord): { label: string; lane: 'running' | 'awaiting' | 'done' | 'failed' | 'idle' } {
  const state: AgentTaskState = sessionVisualState(session);
  if (state === 'awaiting_input' || state === 'awaiting_approval') return { label: 'Waiting for you', lane: 'awaiting' };
  if (state === 'completed') return { label: sessionStatusLabel(session), lane: 'done' };
  if (state === 'failed' || state === 'aborted') return { label: sessionStatusLabel(session), lane: 'failed' };
  if (state === 'not_started' || state === 'paused') return { label: sessionStatusLabel(session), lane: 'idle' };
  return { label: 'Working', lane: 'running' };
}

/** How long a working session has been running, as m:ss, ticking while the card is open. */
function Elapsed({ since }: { since?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = since ? Date.parse(since) : NaN;
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return <span className="session-shelf__elapsed" aria-label={`Running for ${label}`}>{label}</span>;
}

function ShelfCard({ session, open, offset, instant, onOpenSession, onClosed }: {
  session: AgentSessionRecord;
  open: boolean;
  onOpenSession: (key: string) => void;
  onClosed: (key: string) => void;
  offset: number;
  instant?: boolean;
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
  const shownKey = session.linkedIssueKey ?? (isConversationSession(session) ? undefined : session.issueKey);
  // Only a real tracker key earns the chip; a synthesized SESSION-<hex> handle is not the user's.
  const ticketKey = shownKey && !isSynthesizedKey(shownKey) ? shownKey : undefined;
  const status = sessionStatusLabel(session);
  const band = bandFor(session);
  const message = latestMessage(session.events.length > 0 ? session : (hydrated ?? session));
  // The card mounts tucked, then opens on the next frame — that first painted
  // position is what the slide-out transition animates from. A card taking over
  // from the new-session card is already out, so it skips the slide.
  const [shown, setShown] = useState(Boolean(instant && open));
  useEffect(() => { setShown(open); }, [open]);
  const [reply, setReply] = useState(() => replyDrafts.get(session.issueKey) ?? '');
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
      await sendToSession(session, text);
      replyDrafts.delete(session.issueKey);
      setReply('');
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return <article className={`session-shelf__card session-shelf__card--session${shown ? ' is-open' : ''}`}
    data-lane={band.lane} style={{ marginTop: offset }} aria-label={`Session preview: ${title}`} data-testid="session-shelf-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(session.issueKey); }}>
    <header className="session-shelf__band session-shelf__band--session">
      <span className="session-shelf__band-label" data-testid="session-shelf-status">{band.label}</span>
      {ticketKey && <span className="session-shelf__chip session-shelf__chip--context"><Icon name="ticket" size={12} />
        <span className="session-shelf__key session-shelf__chip-value">{ticketKey}</span></span>}
      {band.lane === 'running' && <><span className="session-shelf__grow" /><Elapsed since={session.startedAt} /></>}
    </header>
    <h2 className="session-shelf__title">{title}</h2>
    {message && <p className="session-shelf__message">{message}</p>}
    <p className="session-shelf__agent"><span className="session-shelf__agent-dot" aria-hidden />
      {session.provider ? `${providerLabel(session.provider)} · ${status}` : status}</p>
    <form className="session-shelf__reply" onSubmit={send} data-testid="session-shelf-reply">
      <div className="session-shelf__reply-row">
        <input value={reply} disabled={sending} placeholder={band.lane === 'running' ? 'Add to the conversation…' : 'Quick reply…'} autoComplete="off"
          aria-label={`Quick reply to ${title}`} data-testid="session-shelf-reply-input"
          onChange={event => {
            const value = event.target.value;
            setReply(value); setSent(false);
            if (value) replyDrafts.set(session.issueKey, value); else replyDrafts.delete(session.issueKey);
          }} />
        <button type="submit" className="session-shelf__send" disabled={!reply.trim() || sending}
          aria-label="Send quick reply"><Icon name="arrow-right" size={14} /></button>
      </div>
      {error && <p className="session-shelf__reply-error" role="alert">{error}</p>}
      {sent && !error && <p className="session-shelf__reply-sent" role="status">Reply sent</p>}
    </form>
    <footer className="session-shelf__foot">
      <span>{band.lane === 'running' ? 'Esc tucks it away, it keeps running' : '↵ to send'}</span>
      <button type="button" onClick={() => onOpenSession(session.issueKey)}>Open session ↗</button>
    </footer>
  </article>;
}
