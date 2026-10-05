import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WireImageAttachment, AgentPermissionMode, AgentSessionRecord, AgentToolMode, AssistantMessage, AssistantProposedAction, AssistantRole, AiProvider, PageAssistantContext, ReasoningEffort } from '@praxis/core';

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
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  docked: boolean;
  setDocked: (docked: boolean) => void;
  messages: AssistantMessage[];
  busy: boolean;
  activeToolSession?: AgentSessionRecord;
  lastToolSession?: AgentSessionRecord;
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
  send: (text: string, members?: readonly AssistantRole[], runtime?: AssistantRuntimeOptions) => Promise<void>;
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

let idCounter = 0;
const newMessageId = () => `user-${Date.now().toString(36)}-${(idCounter += 1)}`;

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === '1';
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(() => readBool(OPEN_KEY, false));
  const [docked, setDockedState] = useState(() => readBool(DOCKED_KEY, false));
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeToolSession, setActiveToolSession] = useState<AgentSessionRecord>();
  const [lastToolSession, setLastToolSession] = useState<AgentSessionRecord>();
  const activeToolPrefix = useRef<string>();
  useEffect(() => window.praxis.ai.onSessionChanged(record => {
    if (activeToolPrefix.current && record.issueKey.startsWith(`${activeToolPrefix.current}-`)) {
      setActiveToolSession(record);
      if (['completed', 'failed', 'aborted'].includes(record.state)) setLastToolSession(record);
    }
  }), []);
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [teamMembers, setTeamMembers] = useState<AssistantRole[]>(['dev']);
  const [projectId, setProjectIdState] = useState<string | undefined>();
  const [chatId, setChatId] = useState<string | undefined>();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [detachedTitle, setDetachedTitle] = useState<string | undefined>();
  const [appliedActions, setAppliedActions] = useState<Record<string, string>>({});

  const messagesRef = useRef<AssistantMessage[]>([]);
  const chatIdRef = useRef<string | undefined>();
  const projectIdRef = useRef<string | undefined>();
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
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

  /** Saves the transcript, creating the chat on first use. Serialised so two quick turns cannot both create one. */
  const persist = useCallback((next: AssistantMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    const project = projectIdRef.current;
    if (!project || next.length === 0) return;
    persistQueue.current = persistQueue.current.then(async () => {
      try {
        let id = chatIdRef.current;
        if (!id) {
          const chat = await window.praxis.assistant.createChat(project, pageContextRef.current?.issueKey);
          id = chat.id;
          chatIdRef.current = id;
          setChatId(id);
        }
        await window.praxis.assistant.saveChat(id, messagesRef.current);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, []);

  const reset = useCallback(() => {
    messagesRef.current = [];
    chatIdRef.current = undefined;
    setMessages([]);
    setChatId(undefined);
    setError(undefined);
    setLastToolSession(undefined);
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
    if (!text) return;
    const context = pageContextRef.current;
    // A deliberate @mention remains a direct one-to-one override of the selected roster.
    const mention = /(?:^|\s)@(lead|dev|qa|security|product)\b/i.exec(text)?.[1]?.toLowerCase() as AssistantRole | undefined;
    const selected = mention ? [mention] : [...members];
    // "Detach" lasts one message: the page context re-attaches itself for the next turn.
    setDetachedTitle(undefined);
    const userMessage: AssistantMessage = {
      id: newMessageId(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      ...(context ? { contextTitle: context.title } : {})
    };
    const history = messagesRef.current;
    persist([...history, userMessage]);
    setError(undefined);
    setBusy(true);
    const toolSessionPrefix = runtime?.toolMode && runtime.toolMode !== 'project-only' ? `ASSISTANT-${crypto.randomUUID()}` : undefined;
    activeToolPrefix.current = toolSessionPrefix;
    setActiveToolSession(undefined);
    const selectedRuntime = { ...runtime, ...(toolSessionPrefix ? { toolSessionPrefix } : {}) };
    try {
      if (selected.length > 1) {
        // Run only the selected seats. Keep the lead last when selected so it can
        // synthesise the earlier replies; the UI default is a one-to-one with Dev.
        const order: AssistantRole[] = ['dev', 'qa', 'security', 'product', 'lead'];
        const produced: AssistantMessage[] = [];
        for (const personaId of order.filter(role => selected.includes(role))) {
          const result = await window.praxis.assistant.turn({
            message: text,
            personaId,
            context,
            history: [...history, ...produced],
            ...selectedRuntime
          } as Parameters<typeof window.praxis.assistant.turn>[0]);
          produced.push(...result.messages);
          persist([...messagesRef.current, ...result.messages]);
          if (result.messages.some(message => message.error)) break;
        }
      } else {
        const result = await window.praxis.assistant.turn({
          message: text,
          ...(selected[0] ? { personaId: selected[0] } : {}),
          context,
          history,
          ...selectedRuntime
        } as Parameters<typeof window.praxis.assistant.turn>[0]);
        persist([...messagesRef.current, ...result.messages]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      activeToolPrefix.current = undefined;
      setActiveToolSession(undefined);
    }
  }, [persist, teamMembers]);

  const loadChat = useCallback(async (id: string) => {
    const chat = await window.praxis.assistant.getChat(id);
    if (!chat) return;
    messagesRef.current = chat.messages;
    chatIdRef.current = chat.id;
    setMessages(chat.messages);
    setChatId(chat.id);
    setError(undefined);
    setAppliedActions({});
    setOpen(true);
  }, [setOpen]);

  const chatDeleted = useCallback((id: string) => {
    if (chatIdRef.current === id) reset();
  }, [reset]);

  const applyAction = useCallback(async (messageId: string, action: AssistantProposedAction) => {
    try {
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
    void window.praxis.assistant.getChat(id).then(chat => { if (!chat) reset(); });
  }), [reset]);

  const value = useMemo<AssistantController>(() => ({
    open, setOpen, toggle, docked, setDocked, messages, busy, activeToolSession, lastToolSession, error, draft, setDraft, teamMembers, toggleTeamMember,
    pageContext, availableContext, contextDetached, setContextDetached,
    projectId, setProjectId, chatId, send, newChat: reset, loadChat, chatDeleted,
    applyAction, appliedActions, register, unregister, setSessionDelegate
  }), [open, setOpen, toggle, docked, setDocked, messages, busy, activeToolSession, lastToolSession, error, draft, pageContext, availableContext, contextDetached,
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
