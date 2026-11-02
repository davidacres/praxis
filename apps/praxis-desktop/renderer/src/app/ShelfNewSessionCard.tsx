import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentSessionRecord, AgentToolMode, AiProvider, AiProviderStatus, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { providerLabel } from '../ai/modelProviders';
import { isProviderUsableForSessions } from '../ai/providerAvailability';
import { sessionTitle } from '../ai/sessionNav';

/** What the shelf hands App to start a session in place, with the composer's defaults for everything else. */
export interface ShelfStartInput {
  goal: string;
  title: string;
  projectId?: string;
  issueKey?: string;
  provider?: AiProvider;
  toolMode: AgentToolMode;
}

/** A goal being written survives tucking the card away; a started session clears it. */
let goalDraft = '';
const TITLE_MAX = 80;
const STOP_WORDS = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'into', 'make', 'what', 'have', 'then', 'them', 'they', 'your', 'about', 'there', 'when', 'some']);

function significantWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(word => !STOP_WORDS.has(word)));
}

/** Today's session this goal most likely belongs to: the same ticket first, then two or more shared title words. */
export function matchingSession(goal: string, ticketKey: string | undefined, sessions: AgentSessionRecord[]): AgentSessionRecord | undefined {
  if (!goal.trim()) return undefined;
  if (ticketKey) {
    const byTicket = sessions.find(session => session.linkedIssueKey === ticketKey || session.issueKey === ticketKey);
    if (byTicket) return byTicket;
  }
  const wanted = significantWords(goal);
  if (wanted.size < 2) return undefined;
  let best: AgentSessionRecord | undefined;
  let bestScore = 1;
  for (const session of sessions) {
    const words = significantWords(sessionTitle(session));
    let score = 0;
    wanted.forEach(word => { if (words.has(word)) score += 1; });
    if (score > bestScore) { best = session; bestScore = score; }
  }
  return best;
}

const titleFromGoal = (goal: string) => {
  const line = goal.split('\n').find(part => part.trim())?.trim() ?? 'New session';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const ACCESS_LABEL: Record<AgentToolMode, string> = { full: 'edits', 'read-only': 'read-only', 'project-only': 'project only' };

/**
 * The shelf's new-session card: one goal field that has focus the moment the card
 * opens, starters while it is empty, and every other setting folded into one
 * summary chip. ↵ starts the session right here — the card then becomes that
 * session's preview — and ⌘↵ adds the goal to a matching session from today.
 */
export function ShelfNewSessionCard({ open, offset, projectId, projects, ticketKey, sessions, prefill, onStart, onContinue, onOpenComposer, onOpenAiSettings, onClosed }: {
  open: boolean;
  offset: number;
  projectId?: string;
  projects: ProjectRecord[];
  /** The ticket open behind the shelf, offered as context. */
  ticketKey?: string;
  /** Today's top-level sessions, for "add to this instead". */
  sessions: AgentSessionRecord[];
  /** Text handed over from a note ("Use as goal"); a new `id` replaces the goal. */
  prefill?: { id: number; text: string };
  onStart: (input: ShelfStartInput) => Promise<void>;
  onContinue: (session: AgentSessionRecord, text: string) => Promise<void>;
  onOpenComposer: (goal: string) => void;
  onOpenAiSettings: () => void;
  onClosed: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(open); }, [open]);
  const [goal, setGoalState] = useState(goalDraft);
  const setGoal = (value: string) => { goalDraft = value; setGoalState(value); };
  useEffect(() => { if (prefill) setGoal(prefill.text); }, [prefill?.id]);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const startersRef = useRef<HTMLUListElement>(null);

  const [statuses, setStatuses] = useState<AiProviderStatus[]>();
  const [provider, setProvider] = useState<AiProvider>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.praxis.ai.listProviderStatuses(), window.praxis.settings.get()]).then(([list, settings]) => {
      if (cancelled) return;
      const usable = list.filter(isProviderUsableForSessions);
      setStatuses(usable);
      setProvider(current => current ?? (usable.find(status => status.provider === settings.ai.activeProvider) ?? usable[0])?.provider);
    }).catch(() => { if (!cancelled) setStatuses([]); });
    return () => { cancelled = true; };
  }, [open]);
  const noProvider = statuses !== undefined && statuses.length === 0;

  const [chosenProject, setChosenProject] = useState(projectId);
  useEffect(() => { setChosenProject(projectId); }, [projectId]);
  const project = projects.find(item => item.id === chosenProject);
  const [toolMode, setToolMode] = useState<AgentToolMode>(project?.defaultAiToolMode ?? 'full');
  useEffect(() => { setToolMode(project?.defaultAiToolMode ?? 'full'); }, [project?.id]);
  const [ticketAttached, setTicketAttached] = useState(true);
  useEffect(() => { setTicketAttached(true); }, [ticketKey]);
  const ticket = ticketAttached ? ticketKey : undefined;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const match = useMemo(() => matchingSession(goal, ticket, sessions), [goal, ticket, sessions]);

  const starters = ticket
    ? [`Work on ${ticket}`, `Explain what ${ticket} needs`, `Review the changes for ${ticket}`]
    : ['Explain this codebase', 'Review my uncommitted changes', 'Run the tests and fix failures'];

  const start = async () => {
    const text = goal.trim();
    if (!text || sending || noProvider) return;
    setSending(true);
    setError(undefined);
    try {
      await onStart({ goal: text, title: titleFromGoal(text), projectId: chosenProject, issueKey: ticket, provider, toolMode });
      setGoal('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  const addToMatch = async () => {
    const text = goal.trim();
    if (!text || !match || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onContinue(match, text);
      setGoal('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  const onGoalKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && match) void addToMatch();
      else void start();
    } else if (event.key === 'ArrowDown' && !goal) {
      event.preventDefault();
      startersRef.current?.querySelector('button')?.focus();
    }
  };
  const onStarterKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const buttons = Array.from(startersRef.current?.querySelectorAll('button') ?? []);
    if (event.key === 'ArrowDown') { event.preventDefault(); buttons[index + 1]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); (buttons[index - 1] ?? goalRef.current)?.focus(); }
  };
  const pick = (text: string) => {
    setGoal(text);
    requestAnimationFrame(() => { goalRef.current?.focus(); goalRef.current?.setSelectionRange(text.length, text.length); });
  };

  const summary = `${provider ? providerLabel(provider) : 'Default agent'} · ${ACCESS_LABEL[toolMode]} · ${project?.name ?? 'No project'}`;
  return <article id="session-shelf-new-card" className={`session-shelf__card session-shelf__card--new${shown ? ' is-open' : ''}`}
    style={{ marginTop: offset }} aria-label="New session" data-testid="session-shelf-new-card"
    onTransitionEnd={event => { if (event.propertyName === 'transform' && !shown) onClosed(); }}>
    <header className="session-shelf__band session-shelf__band--new">
      <span className="session-shelf__band-label">New session</span>
      {ticket && <span className="session-shelf__chip session-shelf__chip--context" data-testid="shelf-new-ticket">
        <Icon name="ticket" size={12} /><span className="session-shelf__chip-value">{ticket}</span>
        <button type="button" className="session-shelf__chip-remove" aria-label={`Detach ${ticket}`} onClick={() => setTicketAttached(false)}>
          <Icon name="close" size={10} /></button>
      </span>}
    </header>
    {error && <div className="session-shelf__alert" role="alert" data-testid="shelf-new-error">
      <Icon name="warning" size={12} /><span>{error}</span>
      <button type="button" onClick={() => { void start(); }}>Retry</button>
    </div>}
    <textarea ref={goalRef} className="session-shelf__goal" value={goal} rows={2} data-autofocus
      placeholder={ticket ? `What should the agent do on ${ticket}?` : 'What should the agent do?'}
      aria-label="Session goal" data-testid="shelf-new-goal" disabled={sending}
      onChange={event => { setGoal(event.target.value); setError(undefined); }} onKeyDown={onGoalKey} />
    {!goal && !noProvider && <ul className="session-shelf__starters" ref={startersRef} aria-label="Starters">
      {starters.map((text, index) => <li key={text}>
        <button type="button" onClick={() => pick(text)} onKeyDown={event => onStarterKey(event, index)}>
          {text}{index === 0 && <kbd aria-hidden>↓</kbd>}</button>
      </li>)}
    </ul>}
    {match && !noProvider && <button type="button" className="session-shelf__match" data-testid="shelf-new-match"
      onClick={() => { void addToMatch(); }} disabled={sending}>
      <Icon name="git-branch" size={12} /><span>Add to <b>{sessionTitle(match)}</b></span><kbd aria-hidden>⌘↵</kbd>
    </button>}
    {noProvider
      ? <>
        <div className="session-shelf__alert session-shelf__alert--warn" data-testid="shelf-new-no-provider">
          <Icon name="plug" size={12} /><span>No AI provider is set up yet. Your goal will wait here.</span>
        </div>
        <div className="session-shelf__row session-shelf__row--end">
          <button type="button" className="session-shelf__primary" onClick={onOpenAiSettings}>Set up a provider</button>
        </div>
      </>
      : <div className="session-shelf__row">
        <button type="button" className="session-shelf__summary" aria-expanded={settingsOpen} data-testid="shelf-new-summary"
          aria-label={`Session settings: ${summary}`} onClick={() => setSettingsOpen(value => !value)}>
          <span className="session-shelf__summary-dot" aria-hidden />
          <b>{provider ? providerLabel(provider) : 'Default agent'}</b>
          <span>· {ACCESS_LABEL[toolMode]} · {project?.name ?? 'No project'}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        <span className="session-shelf__grow" />
        <button type="button" className="session-shelf__send session-shelf__send--start" data-testid="shelf-new-start"
          aria-label="Start session" disabled={!goal.trim() || sending} aria-busy={sending} onClick={() => { void start(); }}>
          <Icon name="arrow-up" size={14} /></button>
      </div>}
    {settingsOpen && !noProvider && <div className="session-shelf__settings" data-testid="shelf-new-settings">
      <label><span>Agent</span>
        <ChipSelect block ariaLabel="Agent" value={provider ?? ''} placeholder="Default agent"
          options={(statuses ?? []).map(status => ({ value: status.provider, label: providerLabel(status.provider) }))}
          onChange={value => setProvider(value as AiProvider)} /></label>
      <label><span>Access</span>
        <ChipSelect block ariaLabel="Access" value={toolMode}
          options={[{ value: 'full', label: 'Can edit files' }, { value: 'read-only', label: 'Read only' }, { value: 'project-only', label: 'Project only' }]}
          onChange={value => setToolMode(value as AgentToolMode)} /></label>
      <label><span>Project</span>
        <ChipSelect block ariaLabel="Project" value={chosenProject ?? ''} placeholder="No project"
          options={projects.map(item => ({ value: item.id, label: item.name }))}
          onChange={setChosenProject} /></label>
      <button type="button" className="session-shelf__link" onClick={() => onOpenComposer(goal)}>More options in the full composer ↗</button>
    </div>}
  </article>;
}
