import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentEventSummary, AgentSessionRecord, AgentTaskState, ProjectRecord } from '@praxis/core';
import { recencyBucket, sessionLastActivityAt } from './sessionRecency';
import { isConversationSession, isSynthesizedKey, sessionTitle } from '../ai/sessionNav';
import { sessionStatusLabel, sessionVisualState } from '../ai/aiSessionState';
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
const LIST_KEY = 'praxis:all-sessions';
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
  const allShelfSessions = [...listed]
    .filter(session => !session.parentSessionKey && !session.workflowRunId)
    .sort((a, b) => sessionLastActivityAt(b).localeCompare(sessionLastActivityAt(a)));
  const shelfSessions = allShelfSessions.slice(0, SHELF_SESSION_LIMIT);
  const hiddenCount = allShelfSessions.length - shelfSessions.length;
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
  const moreButtonRef = useRef<HTMLButtonElement>(null);
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
  const holdsInput = () => revealedRef.current === NOTES_KEY || revealedRef.current === NEW_KEY || revealedRef.current === LIST_KEY;
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
      const anchor = mounted === NOTES_KEY ? notesButtonRef.current : anchoredToNew ? newButtonRef.current
        : mounted === LIST_KEY ? moreButtonRef.current : undefined;
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
  const creating = revealed === NOTES_KEY || revealed === NEW_KEY || revealed === LIST_KEY ? revealed : undefined;
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
      else if (revealed === LIST_KEY) moreButtonRef.current?.focus();
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

  // ↑/↓ on a spine or the card's arrows move to the neighbouring spine; focusing it reveals its card.
  const step = (from: string, direction: -1 | 1) => {
    const index = shelfSessions.findIndex(session => session.issueKey === from);
    const spines = spinesRef.current?.querySelectorAll<HTMLButtonElement>('.session-shelf__spine');
    spines?.[index + direction]?.focus();
  };
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
        onReveal={() => reveal(session.issueKey)} onHover={() => hover(session.issueKey)} onLeave={cancelHover}
        onStep={direction => step(session.issueKey, direction)} />)}
      {hiddenCount > 0 && <button type="button" ref={moreButtonRef} className="session-shelf__more" data-testid="session-shelf-more"
        aria-label={`All sessions (${hiddenCount} more)`} aria-expanded={revealed === LIST_KEY} aria-controls="session-shelf-list-card"
        onClick={() => toggle(LIST_KEY)}>+{hiddenCount}</button>}
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
          position={{ index: shelfSessions.findIndex(item => item.issueKey === session.issueKey), count: shelfSessions.length }}
          onStep={direction => step(session.issueKey, direction)}
          onOpenSession={key => { close(); onSelectSession(key); }} />
        : null)}
      {mounted === LIST_KEY && <ShelfListCard open={revealed === LIST_KEY} offset={cardOffset} sessions={allShelfSessions}
        onOpenSession={key => { close(); onSelectSession(key); }}
        onClosed={() => setMounted(current => current === LIST_KEY && revealedRef.current !== LIST_KEY ? undefined : current)} />}
    </div>
  </nav>;
}

/** What a session needs, as the shelf draws it: one of six states, each with its own spine and card. */
export type ShelfState = 'run' | 'appr' | 'wait' | 'done' | 'fail' | 'idle';

export function shelfState(session: AgentSessionRecord): ShelfState {
  const state: AgentTaskState = sessionVisualState(session);
  if (state === 'awaiting_approval') return 'appr';
  if (state === 'awaiting_input') return 'wait';
  if (state === 'completed') return 'done';
  if (state === 'failed') return 'fail';
  if (state === 'aborted' || state === 'not_started' || state === 'paused') return 'idle';
  return 'run';
}

const LANE: Record<ShelfState, 'running' | 'awaiting' | 'done' | 'failed' | 'idle'> = {
  run: 'running', appr: 'awaiting', wait: 'awaiting', done: 'done', fail: 'failed', idle: 'idle'
};

/** The agent's task list as done / total, counting the step in progress as half done. */
function taskProgress(session: AgentSessionRecord): { done: number; total: number; current?: number } | undefined {
  const list = session.taskList;
  if (!list?.length) return undefined;
  const done = list.filter(item => item.status === 'completed').length;
  const current = list.findIndex(item => item.status === 'in_progress');
  return { done, total: list.length, ...(current >= 0 ? { current } : {}) };
}

/** Pixel-fit caps for the two states that need you: ! for an approval, a squared ? for a question. */
function NeedGlyph({ state }: { state: 'appr' | 'wait' }) {
  return <svg width={9} height={9} viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="butt" aria-hidden focusable="false">
    <path d={state === 'appr' ? 'M4.5 1V5.5M4.5 7V8' : 'M2.5 2.5V1.5H6.5V4.5H4.5V5.5M4.5 7V8'} />
  </svg>;
}

function ShelfSpine({ session, today, active, open, onReveal, onHover, onLeave, onStep }: {
  session: AgentSessionRecord;
  today: boolean;
  active: boolean;
  open: boolean;
  onReveal: () => void;
  onHover: () => void;
  onLeave: () => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const title = sessionTitle(session);
  const state = shelfState(session);
  const progress = taskProgress(session);
  const changes = session.changeSummary;
  const changed = changes ? changes.added + changes.removed : 0;
  const attention = state === 'appr' || state === 'wait';
  return <button type="button" className={`session-shelf__spine is-${state}${today ? ' is-today' : ''}${progress ? ' has-track' : ''}`}
    data-testid="session-shelf-spine" data-session-key={session.issueKey} data-state={state}
    aria-description={attention ? sessionStatusLabel(session) : undefined} data-recency={today ? 'today' : 'earlier'}
    aria-label={`Preview ${title}`} aria-expanded={open} aria-current={active ? 'true' : undefined}
    onPointerEnter={onHover} onPointerLeave={onLeave} onFocus={onReveal} onClick={onReveal}
    onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); onStep(event.key === 'ArrowDown' ? 1 : -1); }
    }}>
    {progress && <span className="session-shelf__track" data-testid="session-shelf-track" aria-hidden>
      <span className="session-shelf__track-fill" style={{ height: `${Math.round(((progress.done + (progress.current !== undefined ? 0.5 : 0)) / progress.total) * 100)}%` }} />
    </span>}
    {changed > 0 && <span className="session-shelf__diff" data-testid="session-shelf-diff" aria-hidden>
      <span className="session-shelf__diff-add" style={{ flexGrow: changes!.added }} />
      <span className="session-shelf__diff-del" style={{ flexGrow: changes!.removed }} />
    </span>}
    {attention && <span className="session-shelf__attention" data-testid="session-shelf-attention" aria-hidden><NeedGlyph state={state} /></span>}
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

/** What a working session is doing right now: its latest tool call, else its latest words. */
function latestActivity(session: AgentSessionRecord): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type === 'tool_start') return (event.data?.argsSummary || event.summary || '').trim() || undefined;
    if (event.type === 'message' || event.type === 'intent') return (event.summary || event.detail || '').trim() || undefined;
  }
  return undefined;
}

/**
 * The permission the agent is blocked on: the oldest `permission_requested` after the
 * last `permission_completed`, the one `respondToPermission` resolves next. Duplicated
 * from SessionsPage's helper rather than shared, to keep this file independent of it.
 */
function pendingPermission(events: AgentEventSummary[]): AgentEventSummary | undefined {
  const lastCompleted = events.map(event => event.type).lastIndexOf('permission_completed');
  return events.slice(lastCompleted + 1).find(event => event.type === 'permission_requested');
}

function failureText(session: AgentSessionRecord): string {
  const lastError = [...session.events].reverse().find(event => event.type === 'error');
  return session.lastError || lastError?.detail || lastError?.summary || 'The session stopped with an error.';
}

/** How long ago, in the band's few characters. */
function ageLabel(iso: string | undefined, now: number): string | undefined {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} d`;
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

/** A path as the session's folder knows it: relative when inside it. */
function shortPath(path: string, root: string | undefined): string {
  const posix = path.replace(/\\/g, '/');
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  return base && posix.startsWith(`${base}/`) ? posix.slice(base.length + 1) : posix;
}

const BAND_LABEL: Partial<Record<ShelfState, string>> = { run: 'Working', appr: 'Needs approval', wait: 'Needs your reply' };

/**
 * One session's card. The band names its state; the body leads with what that
 * state needs — the live step and Stop while working, the exact request with Deny
 * and Approve, the question with a reply, the error with Try again — then the
 * agent's own task list and the files its tools changed, when it reported them.
 */
function ShelfCard({ session, open, offset, instant, position, onOpenSession, onStep, onClosed }: {
  session: AgentSessionRecord;
  open: boolean;
  onOpenSession: (key: string) => void;
  onStep: (direction: -1 | 1) => void;
  onClosed: (key: string) => void;
  offset: number;
  instant?: boolean;
  position: { index: number; count: number };
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
  const full = session.events.length > 0 ? session : (hydrated ?? session);
  const title = sessionTitle(session);
  const shownKey = session.linkedIssueKey ?? (isConversationSession(session) ? undefined : session.issueKey);
  // Only a real tracker key earns the chip; a synthesized SESSION-<hex> handle is not the user's.
  const ticketKey = shownKey && !isSynthesizedKey(shownKey) ? shownKey : undefined;
  const state = shelfState(session);
  const label = BAND_LABEL[state] ?? sessionStatusLabel(session);
  const now = Date.now();
  const message = latestMessage(full);
  const activity = state === 'run' ? latestActivity(full) : undefined;
  const permission = state === 'appr' ? pendingPermission(full.events) : undefined;
  const progress = taskProgress(session);
  const changes = session.changeSummary ?? full.changeSummary;
  // The card mounts tucked, then opens on the next frame — that first painted
  // position is what the slide-out transition animates from. A card taking over
  // from the new-session card is already out, so it skips the slide.
  const [shown, setShown] = useState(Boolean(instant && open));
  useEffect(() => { setShown(open); }, [open]);
  const [reply, setReply] = useState(() => replyDrafts.get(session.issueKey) ?? '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [answering, setAnswering] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const sendText = async (text: string) => {
    if (!text || sending) return;
    setSending(true);
    await run(async () => {
      await sendToSession(session, text);
      replyDrafts.delete(session.issueKey);
      setReply('');
      setSent(true);
    });
    setSending(false);
  };
  const send = (event: FormEvent) => { event.preventDefault(); void sendText(reply.trim()); };
  const answer = async (decision: 'allow_once' | 'allow_always' | 'deny') => {
    if (answering) return;
    setAnswering(true);
    await run(() => window.praxis.ai.respondToPermission(session.issueKey, decision));
    setAnswering(false);
  };
  const placeholder = state === 'run' ? 'Add to the conversation…'
    : state === 'fail' ? 'Tell it how to carry on…'
    : state === 'wait' ? 'Reply…' : 'Follow up…';
  const visibleTasks = progress && session.taskList
    ? session.taskList.slice(Math.max(0, Math.min((progress.current ?? progress.done) - 1, session.taskList.length - 5)), Math.max(0, Math.min((progress.current ?? progress.done) - 1, session.taskList.length - 5)) + 5)
    : [];
  return <article className={`session-shelf__card session-shelf__card--session${shown ? ' is-open' : ''}`}
    data-lane={LANE[state]} data-state={state} style={{ marginTop: offset }} aria-label={`Session preview: ${title}`} data-testid="session-shelf-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(session.issueKey); }}>
    <header className="session-shelf__band session-shelf__band--session">
      <span className="session-shelf__band-label" data-testid="session-shelf-status">{label}</span>
      {ticketKey && <span className="session-shelf__chip session-shelf__chip--context"><Icon name="ticket" size={12} />
        <span className="session-shelf__key session-shelf__chip-value">{ticketKey}</span></span>}
      <span className="session-shelf__grow" />
      {state === 'run' ? <Elapsed since={session.startedAt} />
        : <span className="session-shelf__elapsed">{ageLabel(session.lastActivityAt ?? session.completedAt ?? session.startedAt, now)}</span>}
      <span className="session-shelf__nav">
        <button type="button" aria-label="Previous session" disabled={position.index === 0} onClick={() => onStep(-1)}><Icon name="chevron-up" size={12} /></button>
        <button type="button" aria-label="Next session" disabled={position.index >= position.count - 1} onClick={() => onStep(1)}><Icon name="chevron-down" size={12} /></button>
      </span>
    </header>
    <h2 className="session-shelf__title">{title}</h2>
    {progress && <div className="session-shelf__plan" data-testid="session-shelf-plan">
      <div className="session-shelf__plan-head"><span>Step {Math.min(progress.total, (progress.current ?? progress.done - 1) + 1)} of {progress.total}</span>
        <span className="session-shelf__plan-bar"><i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></span></div>
      <ul>{visibleTasks.map(item => <li key={item.content} className={`is-${item.status}`}><span aria-hidden />{item.content}</li>)}</ul>
    </div>}
    {state === 'appr' && (permission
      ? <div className="session-shelf__request" data-testid="session-shelf-permission">
        <code>{permission.summary}</code>
        {permission.detail && <span>{permission.detail}</span>}
      </div>
      : <p className="session-shelf__message">Loading the request…</p>)}
    {state === 'fail' && <div className="session-shelf__alert" role="alert" data-testid="shelf-failed-error">
      <Icon name="warning" size={12} /><span>{failureText(full)}</span></div>}
    {state !== 'appr' && state !== 'fail' && (activity ?? message) && <p className="session-shelf__message">{activity ?? message}</p>}
    {changes && changes.files.length > 0 && <div className="session-shelf__changes" data-testid="session-shelf-changes">
      <div className="session-shelf__changes-head"><Icon name="file" size={12} />
        <span>{changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}</span>
        <span className="session-shelf__add">+{changes.added}</span><span className="session-shelf__del">−{changes.removed}</span></div>
      {state !== 'run' && <ul>{changes.files.slice(0, 3).map(file => {
        const shown = shortPath(file.path, session.worktreePath ?? session.workingDirectory);
        const slash = shown.lastIndexOf('/');
        return <li key={file.path} title={shown}>
        <span><b>{shown.slice(slash + 1)}</b>{slash > 0 && <span className="session-shelf__dir">{shown.slice(0, slash)}</span>}</span>
        <span className="session-shelf__add">+{file.added}</span><span className="session-shelf__del">−{file.removed}</span></li>;
      })}
        {changes.files.length > 3 && <li className="session-shelf__more-files">and {changes.files.length - 3} more</li>}</ul>}
    </div>}
    {state === 'appr'
      ? <div className="session-shelf__row">
        <label className="session-shelf__check"><input type="checkbox" checked={alwaysAllow} onChange={event => setAlwaysAllow(event.target.checked)}
          data-testid="shelf-permission-always" />Always allow</label>
        <span className="session-shelf__grow" />
        <button type="button" className="session-shelf__secondary" data-testid="shelf-permission-deny" disabled={answering || !permission}
          onClick={() => { void answer('deny'); }}>Deny</button>
        <button type="button" className="session-shelf__primary" data-testid="shelf-permission-allow" disabled={answering || !permission}
          onClick={() => { void answer(alwaysAllow ? 'allow_always' : 'allow_once'); }}>Approve</button>
      </div>
      : <form className="session-shelf__reply" onSubmit={send} data-testid="session-shelf-reply">
        <div className="session-shelf__reply-row">
          <input value={reply} disabled={sending} placeholder={placeholder} autoComplete="off"
            aria-label={`Quick reply to ${title}`} data-testid="session-shelf-reply-input"
            onChange={event => {
              const value = event.target.value;
              setReply(value); setSent(false);
              if (value) replyDrafts.set(session.issueKey, value); else replyDrafts.delete(session.issueKey);
            }} />
          <button type="submit" className="session-shelf__send" disabled={!reply.trim() || sending}
            aria-label="Send quick reply"><Icon name="arrow-right" size={14} /></button>
        </div>
      </form>}
    {error && <p className="session-shelf__reply-error" role="alert">{error}</p>}
    {sent && !error && <p className="session-shelf__reply-sent" role="status">Reply sent</p>}
    <footer className="session-shelf__foot">
      {state === 'run'
        ? <button type="button" className="session-shelf__foot-action" data-testid="shelf-stop"
          onClick={() => { void run(() => window.praxis.ai.abort(session.issueKey)); }}><Icon name="close-square" size={12} />Stop</button>
        : state === 'fail'
          ? <button type="button" className="session-shelf__foot-action" data-testid="shelf-try-again"
            onClick={() => { void sendText('Try again.'); }}><Icon name="refresh" size={12} />Try again</button>
          : state === 'appr' ? <span>Approving lets this one action run</span>
          : changes && changes.files.length > 0
            ? <button type="button" className="session-shelf__foot-action" onClick={() => onOpenSession(session.issueKey)}>Review changes</button>
            : <span>↵ to send</span>}
      <button type="button" onClick={() => onOpenSession(session.issueKey)}>Open session ↗</button>
    </footer>
  </article>;
}

/** Every session the shelf can show, past its five: a searchable list that opens the one you pick. */
function ShelfListCard({ open, offset, sessions, onOpenSession, onClosed }: {
  open: boolean;
  offset: number;
  sessions: AgentSessionRecord[];
  onOpenSession: (key: string) => void;
  onClosed: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(open); }, [open]);
  const [query, setQuery] = useState('');
  const now = Date.now();
  const matches = sessions.filter(session => sessionTitle(session).toLowerCase().includes(query.trim().toLowerCase()));
  return <article id="session-shelf-list-card" className={`session-shelf__card session-shelf__card--list${shown ? ' is-open' : ''}`}
    style={{ marginTop: offset }} aria-label="All sessions" data-testid="session-shelf-list-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(); }}>
    <header className="session-shelf__band"><span className="session-shelf__band-label">{sessions.length} sessions</span></header>
    <input className="session-shelf__search" value={query} placeholder="Find a session…" aria-label="Find a session" data-autofocus
      data-testid="shelf-list-search" onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && matches[0]) onOpenSession(matches[0].issueKey); }} />
    <ul className="session-shelf__list">
      {matches.slice(0, 12).map(session => {
        const state = shelfState(session);
        return <li key={session.issueKey}><button type="button" data-state={state} onClick={() => onOpenSession(session.issueKey)}>
          <span className="session-shelf__swatch" aria-hidden /><span className="session-shelf__list-title">{sessionTitle(session)}</span>
          <span className="session-shelf__elapsed">{BAND_LABEL[state] && state !== 'run' ? BAND_LABEL[state] : ageLabel(sessionLastActivityAt(session), now)}</span>
        </button></li>;
      })}
      {matches.length === 0 && <li className="session-shelf__empty">No session matches “{query}”.</li>}
    </ul>
  </article>;
}
