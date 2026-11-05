import { subscribeConversation } from './conversationSubscription';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import type { DurableConversation, SubmitConversationCommand, WireImageAttachment, AgentPermissionMode, AgentSessionRecord, AgentToolMode, AssistantMessage, AssistantProposedAction, AssistantRole, AiProvider, PageAssistantContext, ReasoningEffort } from '@praxis/core';
import { onSessionChanged } from '../ai/sessionChangeStream';

export interface AssistantRuntimeOptions {
  provider?: AiProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: AgentPermissionMode;
  mode?: 'chat' | 'analysis' | 'review';
  toolMode?: AgentToolMode;
  workingDirectory?: string;
  /** Pasted or dropped images; the text-only chat path cannot carry them, so they ride an agent tool turn. */
  images?: WireImageAttachment[];
}

export interface AssistantComposerPreferences {
  provider?: AiProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: AgentPermissionMode;
  mode: 'chat' | 'analysis' | 'review';
  toolMode: AgentToolMode;
  workingDirectory: string;
}

/** A page's own handler for an action the assistant proposed on it. Returns a short outcome line. */
export type AssistantActionHandler = (action: AssistantProposedAction) => Promise<string | void> | string | void;

interface Registration {
  id: string;
  context: PageAssistantContext;
  onApply?: AssistantActionHandler;
}

/** When two pages are on screen at once (a board and its open ticket) the more specific one wins. */
const CONTEXT_PRIORITY: Record<PageAssistantContext['pageType'], number> = {
  general: 0,
  project: 0,
  board: 1,
  git: 2,
  'workflow-run': 3,
  workflow: 3,
  issue: 3
};

const DOCKED_KEY = 'tm-assistant-docked';
const OPEN_KEY = 'tm-assistant-open';

export interface AssistantController {
  runtimePreferences: AssistantComposerPreferences;
  setRuntimePreferences: Dispatch<SetStateAction<AssistantComposerPreferences>>;
  conversation?: DurableConversation;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  docked: boolean;
  setDocked: (docked: boolean) => void;
  messages: AssistantMessage[];
  busy: boolean;
  activeTurnStartedAt?: number;
  activeToolSession?: AgentSessionRecord;
  lastToolSession?: AgentSessionRecord;
  toolUsageSessions: AgentSessionRecord[];
  error?: string;
  draft: string;
  setDraft: (draft: string) => void;
  teamMembers: readonly AssistantRole[];
  toggleTeamMember: (role: AssistantRole) => void;
  /** The page context that will accompany the next turn, if attached. */
  pageContext?: PageAssistantContext;
  /** The registered context even when the user has detached it, so the pill can offer re-attach. */
  availableContext?: PageAssistantContext;
  contextDetached: boolean;
  setContextDetached: (detached: boolean) => void;
  projectId?: string;
  setProjectId: (projectId: string | undefined) => void;
  chatId?: string;
  send: (text: string, members?: readonly AssistantRole[], runtime?: AssistantRuntimeOptions) => Promise<boolean>;
  newChat: () => void;
  loadChat: (chatId: string) => Promise<void>;
  /** Called after a chat is deleted elsewhere (the sidebar) so an open transcript can reset. */
  chatDeleted: (chatId: string) => void;
  applyAction: (messageId: string, action: AssistantProposedAction) => Promise<void>;
  /** Outcome lines for actions already applied, keyed by message id. */
  appliedActions: Record<string, string>;
  register: (id: string, context: PageAssistantContext, onApply?: AssistantActionHandler) => void;
  unregister: (id: string) => void;
  setSessionDelegate: (delegate: ((prompt: string) => void) | undefined) => void;
}

const AssistantContext = createContext<AssistantController | undefined>(undefined);


function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === '1';
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [runtimePreferences, setRuntimePreferences] = useState<AssistantComposerPreferences>({ model: '', reasoningEffort: 'medium', permissionMode: 'manual', mode: 'chat', toolMode: 'project-only', workingDirectory: '' });
  const pendingSubmissions = useRef(new Map<string, SubmitConversationCommand>());
  const [open, setOpenState] = useState(() => readBool(OPEN_KEY, false));
  const [docked, setDockedState] = useState(() => readBool(DOCKED_KEY, false));
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [conversation, setConversation] = useState<DurableConversation>();
  const busy = Boolean(conversation?.turns.some(t => ['running', 'cancelling', 'awaiting_approval'].includes(t.state)));
  const [activeTurnStartedAt, setActiveTurnStartedAt] = useState<number>();
  const [activeToolSession, setActiveToolSession] = useState<AgentSessionRecord>();
  const [lastToolSession, setLastToolSession] = useState<AgentSessionRecord>();
  const [toolUsageSessions, setToolUsageSessions] = useState<AgentSessionRecord[]>([]);
  const activeToolPrefix = useRef<string>();
  useEffect(() => onSessionChanged(record => {
    if (activeToolPrefix.current && record.teamChatExecution?.conversationId === activeToolPrefix.current) {
      setActiveToolSession(record);
      setToolUsageSessions(current => current.some(item => item.sessionId === record.sessionId)
        ? current.map(item => item.sessionId === record.sessionId ? record : item) : [...current, record]);
      if (['completed', 'failed', 'aborted'].includes(record.state)) setLastToolSession(record);
    }
  }), []);
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [teamMembers, setTeamMembers] = useState<AssistantRole[]>(['dev']);
  const [projectId, setProjectIdState] = useState<string | undefined>();
  const [chatId, setChatId] = useState<string | undefined>();
  // Bumped to re-read the open chat when the same id is opened again without a loaded transcript.
  const [chatLoad, setChatLoad] = useState(0);
  /** The chat id whose snapshot the subscription last delivered successfully. */
  const loadedChatIdRef = useRef<string | undefined>();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [detachedTitle, setDetachedTitle] = useState<string | undefined>();
  const [appliedActions, setAppliedActions] = useState<Record<string, string>>({});

  const messagesRef = useRef<AssistantMessage[]>([]);
  const chatIdRef = useRef<string | undefined>();
  const generation = useRef(0);
  const creation = useRef<Promise<string>>();
  const projectIdRef = useRef<string | undefined>();

  const delegateRef = useRef<((prompt: string) => void) | undefined>();
  const registrationsRef = useRef<Registration[]>([]);
  registrationsRef.current = registrations;
  projectIdRef.current = projectId;

  const setOpen = useCallback((next: boolean) => {
    localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    setOpenState(next);
  }, []);
  const toggle = useCallback(() => setOpen(!readBool(OPEN_KEY, false)), [setOpen]);
  const setDocked = useCallback((next: boolean) => {
    localStorage.setItem(DOCKED_KEY, next ? '1' : '0');
    setDockedState(next);
  }, []);

  const register = useCallback((id: string, context: PageAssistantContext, onApply?: AssistantActionHandler) => {
    setRegistrations(current => {
      const index = current.findIndex(entry => entry.id === id);
      const next: Registration = { id, context, onApply };
      return index < 0 ? [...current, next] : current.map((entry, i) => (i === index ? next : entry));
    });
  }, []);
  const unregister = useCallback((id: string) => {
    setRegistrations(current => (current.some(entry => entry.id === id) ? current.filter(entry => entry.id !== id) : current));
  }, []);

  const active = useMemo(() => {
    let best: Registration | undefined;
    for (const entry of registrations) {
      if (!best || CONTEXT_PRIORITY[entry.context.pageType] >= CONTEXT_PRIORITY[best.context.pageType]) best = entry;
    }
    return best;
  }, [registrations]);
  const availableContext = active?.context;
  const contextDetached = Boolean(availableContext && detachedTitle === availableContext.title);
  const pageContext = contextDetached ? undefined : availableContext;
  const pageContextRef = useRef<PageAssistantContext | undefined>();
  pageContextRef.current = pageContext;
  const activeRef = useRef<Registration | undefined>();
  activeRef.current = active;

  const setContextDetached = useCallback((detached: boolean) => {
    setDetachedTitle(detached ? activeRef.current?.context.title : undefined);
  }, []);

  useEffect(() => {
    if (!chatId) return;
    activeToolPrefix.current = chatId;
    loadedChatIdRef.current = undefined;
    return subscribeConversation(window.praxis.assistant, chatId, snapshot => {
      loadedChatIdRef.current = snapshot ? chatId : undefined;
      setConversation(snapshot);
      messagesRef.current = snapshot?.messages ?? [];
      setMessages(snapshot?.messages ?? []);
      const active = snapshot?.turns.find(t => !['completed', 'cancelled', 'queued'].includes(t.state));
      setActiveTurnStartedAt(active ? Date.parse(snapshot!.messages.find(m => m.id === active.userMessageId)?.createdAt ?? '') : undefined);
      setError(current => current && snapshot?.turns.some(t => t.attempts.some(a => a.error === current) || t.contextRequiredReason === current) &&
        !snapshot.turns.some(t => !['completed', 'cancelled'].includes(t.state) && (t.attempts.at(-1)?.error === current || t.contextRequiredReason === current)) ? undefined : current);
    }, error => { setError(error instanceof Error ? error.message : String(error)); });
  }, [chatId, chatLoad]);

  useEffect(() => {
    if (!chatId) return;
    let disposed = false;
    void window.praxis.ai.listSessions().then(async sessions => {
      const owned = sessions.filter(record => record.teamChatExecution?.conversationId === chatId);
      const loaded = await Promise.all(owned.map(record => window.praxis.ai.getSession(record.issueKey)));
      if (disposed) return;
      const records = loaded.filter((record): record is AgentSessionRecord => Boolean(record));
      setToolUsageSessions(current => [...current, ...records.filter(record => !current.some(item => item.sessionId === record.sessionId))]);
      const active = records.find(record => !['completed', 'failed', 'aborted'].includes(record.state));
      if (active) setActiveToolSession(active);
      else if (records.length) setLastToolSession(records.at(-1));
    }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; };
  }, [chatId]);

  const reset = useCallback(() => {
    generation.current++;
    creation.current = undefined;
    setConversation(undefined);
    activeToolPrefix.current = undefined;
    messagesRef.current = [];
    chatIdRef.current = undefined;
    setMessages([]);
    setChatId(undefined);
    setError(undefined);
    setActiveToolSession(undefined);
    setLastToolSession(undefined);
    setToolUsageSessions([]);
    setAppliedActions({});
  }, []);

  const setProjectId = useCallback((next: string | undefined) => {
    if (projectIdRef.current === next) return;
    projectIdRef.current = next;
    setProjectIdState(next);
    reset();
  }, [reset]);

  const toggleTeamMember = useCallback((role: AssistantRole) => {
    setTeamMembers(current => current.includes(role) ? current.filter(member => member !== role) : [...current, role]);
  }, []);

  const send = useCallback(async (raw: string, members: readonly AssistantRole[] = teamMembers, runtime?: AssistantRuntimeOptions) => {
    const text = raw.trim();
    if (!text) return false;
    const selectedGeneration = generation.current;
    const context = pageContextRef.current && structuredClone(pageContextRef.current);
    const project = projectIdRef.current;
    const capturedRuntime = structuredClone(runtime ?? {});
    const selected = [...members];
    try {
      let id = chatIdRef.current;
      if (!id) {
        creation.current ??= window.praxis.assistant.createChat(project ?? '', context?.issueKey).then(chat => chat.id);
        id = await creation.current;
        if (generation.current === selectedGeneration) {
          chatIdRef.current = id;
          setChatId(id);
        }
      }
      const snapshot = await window.praxis.assistant.getConversation(id);
      if (!snapshot) throw new Error('Conversation was deleted.');
      const pendingKey = `${id}:${text}`;
      const pending = pendingSubmissions.current.get(pendingKey);
      const attachmentRefs = pending?.attachmentRefs ?? (capturedRuntime.images?.length ? await window.praxis.assistant.stageAttachments(id, capturedRuntime.images) : []);
      const { images: _images, ...options } = capturedRuntime;
      const command: SubmitConversationCommand = pending ?? {
        conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot.revision, text,
        selectedParticipantIds: selected.map(role => `part-${role}`), attachmentRefs,
        ...(context ? { context } : {}),
        runtimeOptions: Object.fromEntries(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      };
      pendingSubmissions.current.set(pendingKey, command);
      // One transport retry, with exactly the same command identity and payload.
      if (generation.current === selectedGeneration) setError(undefined);
      try { await window.praxis.assistant.submitTurn(command); }
      catch { await window.praxis.assistant.submitTurn(command); }
      pendingSubmissions.current.delete(pendingKey);
      if (generation.current === selectedGeneration) {
        setDraft(current => current.trim() === text ? '' : current);
        setDetachedTitle(undefined);
      }
      return true;
    } catch (err) {
      if (generation.current === selectedGeneration) setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [teamMembers]);

  const loadChat = useCallback(async (id: string) => {
    // Re-opening the open chat keeps its transcript while its subscription holds a
    // loaded snapshot (it stays live across windows). Otherwise reload it, bumping
    // `chatLoad` because setting the same id would not re-run the subscription.
    if (chatIdRef.current === id && loadedChatIdRef.current === id) { setOpen(true); return; }
    if (chatIdRef.current === id) setChatLoad(n => n + 1);
    generation.current++;
    creation.current = undefined;
    chatIdRef.current = id;
    setChatId(id);
    setConversation(undefined);
    setMessages([]);
    messagesRef.current = [];
    setError(undefined);
    setAppliedActions({});
    setActiveToolSession(undefined);
    setLastToolSession(undefined);
    setToolUsageSessions([]);
    setOpen(true);
  }, [setOpen]);

  const chatDeleted = useCallback((id: string) => {
    if (chatIdRef.current === id) reset();
  }, [reset]);

  const applyAction = useCallback(async (messageId: string, action: AssistantProposedAction) => {
    try {
      const source = messagesRef.current.find(message => message.id === messageId) as import('@praxis/core').ConversationMessage | undefined;
      const origin = source?.context;
      const current = activeRef.current?.context;
      if (!origin || !current || origin.pageType !== current.pageType || origin.projectId !== current.projectId ||
          origin.issueKey !== current.issueKey || origin.entityId !== current.entityId || origin.title !== current.title) throw new Error('Return to the originating page to apply this proposal.');
      let outcome: string | void;
      if (action.kind === 'delegate-session') {
        if (!delegateRef.current) throw new Error('Starting a coding session is not available here.');
        delegateRef.current(action.prompt);
        outcome = 'Opened in a new session composer.';
      } else {
        const handler = activeRef.current?.onApply;
        if (!handler) throw new Error('This page cannot apply that change.');
        outcome = await handler(action);
      }
      setAppliedActions(current => ({ ...current, [messageId]: outcome || 'Applied.' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setSessionDelegate = useCallback((delegate: ((prompt: string) => void) | undefined) => {
    delegateRef.current = delegate;
  }, []);

  // Another window (or the sidebar) deleting the open chat must not leave a ghost transcript that re-creates it.
  useEffect(() => window.praxis.assistant.onChatsChanged(() => {
    const id = chatIdRef.current;
    if (!id) return;
    void window.praxis.assistant.getChat(id).then(chat => { if (!chat && chatIdRef.current === id) reset(); });
  }), [reset]);

  const value = useMemo<AssistantController>(() => ({
    runtimePreferences, setRuntimePreferences, conversation, open, setOpen, toggle, docked, setDocked, messages, busy, activeTurnStartedAt, activeToolSession, lastToolSession, toolUsageSessions, error, draft, setDraft, teamMembers, toggleTeamMember,
    pageContext, availableContext, contextDetached, setContextDetached,
    projectId, setProjectId, chatId, send, newChat: reset, loadChat, chatDeleted,
    applyAction, appliedActions, register, unregister, setSessionDelegate
  }), [runtimePreferences, conversation, open, setOpen, toggle, docked, setDocked, messages, busy, activeTurnStartedAt, activeToolSession, lastToolSession, toolUsageSessions, error, draft, pageContext, availableContext, contextDetached,
    setContextDetached, projectId, setProjectId, chatId, send, reset, loadChat, chatDeleted, applyAction,
    teamMembers, toggleTeamMember,
    appliedActions, register, unregister, setSessionDelegate]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantController {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('useAssistant must be used inside <AssistantProvider>.');
  return value;
}

/**
 * A page advertises what it shows (and how to apply changes the team proposes)
 * for as long as it is mounted. Pass `undefined` while the page has nothing to
 * share yet. Re-registers only when the serialised context changes.
 */
export function useRegisterPageAssistantContext(context: PageAssistantContext | undefined, onApply?: AssistantActionHandler): void {
  // Optional on purpose: a surface rendered outside the provider (a detached window) just doesn't advertise.
  const assistant = useContext(AssistantContext);
  const register = assistant?.register;
  const unregister = assistant?.unregister;
  const idRef = useRef(`page-${Math.random().toString(36).slice(2)}`);
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const key = context ? JSON.stringify(context) : '';
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    const id = idRef.current;
    if (contextRef.current) register?.(id, contextRef.current, action => applyRef.current?.(action));
    else unregister?.(id);
  }, [key, register, unregister]);
  useEffect(() => {
    const id = idRef.current;
    return () => unregister?.(id);
  }, [unregister]);
}
