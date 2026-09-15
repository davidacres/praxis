import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AiAnalysisState,
  AiProviderStatus,
  AnyGadgetEnvelope,
  ChatBlock,
  GadgetActionResult,
  GadgetActionValue,
  PermissionDecision,
  SessionMode,
  TerminalSessionInfo
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { isTerminalAgentState } from './aiSessionState';
import { useDialogs } from '../ui/dialogs';
import { useSettings } from '../settings/useSettings';
import { BrowserPane } from '../browser/BrowserPane';
import { getActiveTerminalId, onActiveTerminalChanged } from './terminalSelection';
import { PROVIDER_LABELS, providerIconName } from './modelProviders';
import { basename, contextPressure, formatCost, isWorkflowStageSession, liveActivity, sessionLabel, sessionTitle, spendPressure } from './sessionNav';
import { SessionRuntimeActions, SessionTransitionDialogs } from './SessionHandover';
import { GadgetBlockList } from './gadgets';
import { gadgetMessageKey, groupBlocksByMessage, mayContainGadget, stripGadgetFences } from './gadgets/messageText';

/**
 * Switching mode is not just a flag: the session is told, in its own thread,
 * what the new mode means. These are the prompts the console used to send.
 */
const MODE_TRANSITION: Record<SessionMode, string> = {
  analysis:
    'Switch this conversation into Analysis mode. Inspect the relevant ticket and workspace read-only, then return a concrete analysis and implementation plan. Do not make changes.',
  review:
    'Switch this conversation into Review mode. Review the relevant ticket, workspace, and current implementation read-only, then report findings, risks, and actionable recommendations. Do not make changes.',
  chat:
    'Switch this conversation into Chat mode. Answer my next requests directly and do not inspect or modify tickets unless I explicitly ask.'
};

/** Every published gadget block for this session, searched by `gadgetId` — `gadgetBlocks` is keyed by message, not by gadget. */
function findGadgetEnvelope(blocks: Record<string, ChatBlock[]>, gadgetId: string): AnyGadgetEnvelope | undefined {
  for (const list of Object.values(blocks)) {
    for (const block of list) {
      if (block.type === 'gadget' && block.gadget.gadgetId === gadgetId) return block.gadget;
    }
  }
  return undefined;
}

/**
 * Turns a recorded choice/selection answer into the follow-up message that
 * reports it to the agent — the same shape a person would have typed. Scoped
 * to `choice`-kind gadgets only (a genuine open decision with a question and
 * options, e.g. "which direction should we take"), not `confirmation`/`form`,
 * which routinely pair with a `mutating`/`approval` action that already
 * reaches a real service through its own gated executor — piling an automatic
 * follow-up turn onto those would risk a second, uncoordinated way of telling
 * the agent something happened. Only fires for an `informational` action.
 */
function describeGadgetAnswer(
  envelope: AnyGadgetEnvelope | undefined,
  actionId: string,
  value: GadgetActionValue
): string | undefined {
  if (!envelope || envelope.kind !== 'choice') return undefined;
  const action = envelope.actions.find(candidate => candidate.actionId === actionId);
  if (action && action.effect !== 'informational') return undefined;

  switch (value.kind) {
    case 'choice': {
      const option = envelope.payload.options.find(candidate => candidate.value === value.selected);
      return `Gadget response — "${envelope.payload.question}": ${option?.label ?? value.selected}.`;
    }
    case 'selection': {
      const labels = value.selected.map(
        selectedValue => envelope.payload.options.find(candidate => candidate.value === selectedValue)?.label ?? selectedValue
      );
      return `Gadget response — "${envelope.payload.question}": ${labels.join(', ')}.`;
    }
    default:
      return undefined;
  }
}

export interface SessionsPageProps {
  /** All known agent sessions, most recent first. Live-updated by the App-level push subscription. */
  sessions: AgentSessionRecord[];
  selectedKey: string | undefined;
  onNewSession: () => void;
  onOpenAiSettings: () => void;
  initialBrowserOpen?: boolean;
  initialBrowserUrl?: string;
  onBrowserOpenChange?: (open: boolean) => void;
  onBrowserUrlChange?: (url: string) => void;
  browserSuspended?: boolean;
}

/** Per-session override of the profile-wide "Plain chat background" setting.
 *  A sparse map keyed by session (issue) key: only sessions the user has
 *  explicitly toggled appear; the rest inherit the global default. */
const PLAIN_SURFACE_KEY = 'tm-sessions-plain-surface';

function readPlainSurfaceOverrides(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAIN_SURFACE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writePlainSurfaceOverrides(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(PLAIN_SURFACE_KEY, JSON.stringify(value));
  } catch {
    // Private mode / storage disabled — the override just won't persist.
  }
}

/**
 * The oldest still-unresolved `permission_requested` event — i.e. the next
 * one `respondToPermission` will resolve (both hosts `.shift()` a FIFO
 * queue). Neither host persists pending-permission detail on the session
 * record itself, so this is derived from the event log instead of a
 * separate fetch: everything after the last `permission_completed` event
 * that hasn't been resolved yet.
 */
function pendingPermissionEvent(events: AgentEventSummary[]): AgentEventSummary | undefined {
  const lastCompletedIndex = events.map(e => e.type).lastIndexOf('permission_completed');
  return events.slice(lastCompletedIndex + 1).find(e => e.type === 'permission_requested');
}


function decodeContextText(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function parseTerminalContext(detail: string | undefined) {
  const match = detail?.match(/^<terminal_context cwd="([^"]*)" captured_at="([^"]*)">\n([\s\S]*?)\n<\/terminal_context>\n\n([\s\S]*)$/);
  return match ? {
    cwd: decodeContextText(match[1]),
    capturedAt: match[2],
    output: decodeContextText(match[3]),
    message: match[4]
  } : undefined;
}

/**
 * The Sessions feature's centre pane: the console for the selected session.
 *
 * The list of sessions is the shell's sidebar tree, and the session's context
 * and lifecycle actions are the shell's right pane (`SessionInspector`) — this
 * is the conversation and nothing else. Records are fed from the main process
 * (`ai:listSessions` + the `ai:sessionChanged` push channel subscribed in App),
 * so state transitions and streamed events render live.
 */
export function SessionsPage({
  sessions,
  selectedKey,
  onNewSession,
  onOpenAiSettings,
  initialBrowserOpen,
  initialBrowserUrl,
  onBrowserOpenChange,
  onBrowserUrlChange,
  browserSuspended
}: SessionsPageProps) {
  const { confirm } = useDialogs();
  const [status, setStatus] = useState<AiProviderStatus | undefined>();
  const [respondingTo, setRespondingTo] = useState<string | undefined>();
  const [followUp, setFollowUp] = useState('');
  const [followUpError, setFollowUpError] = useState<string | undefined>();
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [abortingSession, setAbortingSession] = useState(false);
  /** Key is `${eventTimestamp}|${path}` — the specific edit being undone. */
  const [switchingMode, setSwitchingMode] = useState(false);
  /** ACP's own Session Mode (e.g. "ask"/"architect"/"code") — see `setAcpMode` below. Unrelated to `switchingMode`/chat-analysis-review above. */
  const [settingAcpMode, setSettingAcpMode] = useState(false);
  // `bottom`, not `top` — these two open from the composer at the bottom of the
  // page, so they must grow upward, not downward off the viewport like
  // NewSession's model/provider menus.
  const [acpModeMenuPos, setAcpModeMenuPos] = useState<{ bottom: number; left: number } | undefined>();
  const [acpCommandMenuPos, setAcpCommandMenuPos] = useState<{ bottom: number; left: number } | undefined>();
  const acpModeChipRef = useRef<HTMLButtonElement | null>(null);
  const acpModeMenuRef = useRef<HTMLDivElement | null>(null);
  const acpCommandChipRef = useRef<HTMLButtonElement | null>(null);
  const acpCommandMenuRef = useRef<HTMLDivElement | null>(null);
  const [analysisState, setAnalysisState] = useState<AiAnalysisState | undefined>();
  const [confirmingAnalysis, setConfirmingAnalysis] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | undefined>(() => getActiveTerminalId());
  const [attachTerminalContext, setAttachTerminalContext] = useState(false);
  // Gadget blocks are keyed by the message that asked for them, so a response
  // renders its own surfaces inline rather than pooling them all at the bottom.
  const [gadgetBlocks, setGadgetBlocks] = useState<Record<string, ChatBlock[]>>({});
  const [gadgetResults, setGadgetResults] = useState<Record<string, GadgetActionResult>>({});
  const [busyGadgetId, setBusyGadgetId] = useState<string>();
  const [plainSurfaceOverrides, setPlainSurfaceOverrides] = useState<Record<string, boolean>>(readPlainSurfaceOverrides);
  const [transitionDialog, setTransitionDialog] = useState<'model' | 'handover' | undefined>();
  const [browserOpen, setBrowserOpen] = useState(initialBrowserOpen ?? false);
  const [browserMaximized, setBrowserMaximized] = useState(false);
  const browserDismissed = useRef(initialBrowserOpen === false);
  const { settings } = useSettings();
  const eventsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBrowserOpen(initialBrowserOpen ?? false);
    browserDismissed.current = initialBrowserOpen === false;
  }, [initialBrowserOpen, selectedKey]);

  useEffect(() => {
    writePlainSurfaceOverrides(plainSurfaceOverrides);
  }, [plainSurfaceOverrides]);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
      .getStatus()
      .then(next => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
    const unsubscribeAvailability = window.praxis.terminal.onContextAvailability(event => {
      setTerminalSessions(current => {
        if (current.some(session => session.id === event.sessionId)) {
          return current.map(session => session.id === event.sessionId
            ? { ...session, hasContext: event.terminalHasContext }
            : session);
        }
        void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
        return current;
      });
    });
    const unsubscribeExit = window.praxis.terminal.onExit(event => {
      setTerminalSessions(current => current.map(session => session.id === event.sessionId
        ? { ...session, exited: true }
        : session));
    });
    const unsubscribeActive = onActiveTerminalChanged(sessionId => {
      setActiveTerminalId(sessionId);
      void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
    });
    return () => { unsubscribeAvailability(); unsubscribeExit(); unsubscribeActive(); };
  }, []);

  const selected = sessions.find(session => session.issueKey === selectedKey) ?? sessions[0];
  const terminalForContext = terminalSessions.find(session => session.id === activeTerminalId && session.hasContext)
    ?? [...terminalSessions].reverse().find(session => session.hasContext && (
      !selected?.workingDirectory || session.cwd === selected.workingDirectory
    ));
  const selectedEventCount = selected?.events.length ?? 0;
  // Surface the browser as soon as the agent drives it, so the user sees the
  // page it is working against.
  const agentUsedBrowser = selected?.events.some(event => event.data?.toolName?.startsWith('browser_')) ?? false;
  useEffect(() => {
    if (agentUsedBrowser && !browserDismissed.current) {
      setBrowserOpen(true);
      onBrowserOpenChange?.(true);
    }
  }, [agentUsedBrowser, onBrowserOpenChange]);

  const setBrowserVisibility = (open: boolean) => {
    browserDismissed.current = !open;
    setBrowserOpen(open);
    if (!open) setBrowserMaximized(false);
    onBrowserOpenChange?.(open);
  };
  // `tool_start` feeds the live status line, not the transcript — only the
  // grouped completion gadget in Activity does, so the chat stays readable.
  const conversationEvents = selected?.events.filter(
    event =>
      (event.type === 'message' || event.type === 'user_input_completed') && Boolean(event.detail || event.summary)
  ) ?? [];
  const latestEventResponse = [...conversationEvents]
    .reverse()
    .find(event => event.type === 'message')?.detail;
  const lastConversationEvent = conversationEvents[conversationEvents.length - 1];
  // Completed sessions have their assistant replies in the event history. A
  // separate responseText fallback is only useful for an in-flight turn (or
  // an older record with no message event); otherwise a stale live buffer can
  // appear after a newer user follow-up when a session is reopened.
  const staleTerminalResponse = Boolean(
    selected
      && isTerminalAgentState(selected.state)
      && lastConversationEvent?.type === 'user_input_completed'
  );
  const shouldRenderResponseFallback = Boolean(
    selected?.responseText
      && selected.responseText !== latestEventResponse
      && (!isTerminalAgentState(selected.state) || conversationEvents.length === 0)
      && !staleTerminalResponse
  );

  const selectedSessionId = selected?.sessionId;


  /**
   * Publish whatever the transcript asked for, then read the session's blocks
   * back with their lifecycle state resolved by the host.
   *
   * Publishing is idempotent — the same message mints the same gadget IDs, and
   * the host replaces in place — so re-running this on every new event is safe
   * and is what lets a streaming progress gadget update rather than stack up.
   */
  useEffect(() => {
    if (!selectedSessionId) {
      setGadgetBlocks({});
      return;
    }
    let cancelled = false;

    const refresh = async () => {
      const blocks = await window.praxis.gadgets.getBlocks(selectedSessionId);
      if (!cancelled) setGadgetBlocks(groupBlocksByMessage(blocks));
    };

    void (async () => {
      for (const [index, event] of conversationEvents.entries()) {
        if (event.type !== 'message' || !mayContainGadget(event.detail)) continue;
        await window.praxis.gadgets.publishFromText(selectedSessionId, gadgetMessageKey(index), event.detail ?? '');
        if (cancelled) return;
      }
      await refresh();
    })();

    // The host broadcasts after every publish and every submission, so an
    // action answered elsewhere (or a gadget the host revoked) lands here too.
    const unsubscribe = window.praxis.gadgets.onChanged(changedSessionId => {
      if (changedSessionId === selectedSessionId) void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `conversationEvents` is rebuilt every render; its length is what actually
    // changes when the agent says something new.
  }, [selectedSessionId, conversationEvents.length]);

  const submitGadgetAction = async (gadgetId: string, actionId: string, value: GadgetActionValue) => {
    if (!selectedSessionId) return;
    setBusyGadgetId(gadgetId);
    try {
      const result = await window.praxis.gadgets.submit({
        sessionId: selectedSessionId,
        gadgetId,
        actionId,
        value,
        // Deterministic, so a double submission of the same decision replays
        // the recorded outcome instead of applying it twice. A refused
        // submission never consumes the key, so a corrected retry still works.
        idempotencyKey: `${selectedSessionId}:${gadgetId}:${actionId}`,
        correlationId: `${selectedSessionId}:${gadgetId}`
      });
      setGadgetResults(current => ({ ...current, [gadgetId]: result }));

      // An `informational` action only records a decision — the ledger and the
      // UI both know it happened, but the agent that asked never does, because
      // nothing here is on the conversation path. Reporting the answer back as
      // a follow-up turn (the same path `sendFollowUp` uses) is what closes the
      // loop: the choice actually reaches the agent's next turn instead of
      // silently sitting in `gadgets.json`. Only fires for a genuinely recorded
      // answer (not `rejected`/`failed`), only once per submission (a replay of
      // an already-answered gadget must not re-send the same follow-up), and
      // only while the session can accept one.
      if (
        (result.status === 'completed' || result.status === 'accepted') &&
        !result.replay &&
        selected &&
        isTerminalAgentState(selected.state)
      ) {
        const summary = describeGadgetAnswer(findGadgetEnvelope(gadgetBlocks, gadgetId), actionId, value);
        if (summary) {
          await window.praxis.ai.continueSession(selected.issueKey, summary);
        }
      }
    } finally {
      setBusyGadgetId(undefined);
    }
  };


  // One line describing what the agent is doing right now — shown only while a
  // turn is in flight, in place of streaming every tool block. Shared with the
  // inspector's copy of the same line; see `liveActivity` in sessionNav.ts.
  const liveActivityText = selected ? liveActivity(selected) : undefined;

  // The pending permission the agent is blocked on, if any — surfaced as a
  // slide-up dock directly above the chat input.
  const pendingPermission = selected?.state === 'awaiting_approval'
    ? pendingPermissionEvent(selected.events)
    : undefined;
  // How full the model's context is for the next turn — shown right above the
  // input, the way Claude and Copilot surface it, rather than in a side panel
  // the user has to go looking for. Hidden below two-thirds: a mostly-empty
  // window is not news, and a warning that is always on screen stops reading
  // as one.
  const context = selected ? contextPressure(selected) : undefined;
  // Spend against the user's own limit, totalled across every session that
  // reported a cost — the budget is theirs, not this session's. Same bands as
  // context, so the two warnings read as one family rather than two designs.
  const spend = spendPressure(sessions, settings?.ai.spendLimit ?? 0);
  const respondToPermission = (decision: PermissionDecision) => {
    if (!selected) return;
    setRespondingTo(selected.issueKey);
    void window.praxis.ai
      .respondToPermission(selected.issueKey, decision)
      .finally(() => setRespondingTo(undefined));
  };
  const permissionBusy = respondingTo === selected?.issueKey;

  // Follow the stream: whenever the selected session gains events, pin the
  // console to the latest one (the list replaces the record object on every
  // push, so the count is the reliable change signal).
  useEffect(() => {
    const node = eventsRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [selected?.issueKey, selectedEventCount, selected?.responseText, latestEventResponse]);

  useEffect(() => {
    setFollowUp('');
    setFollowUpError(undefined);
  }, [selected?.issueKey]);

  useEffect(() => {
    setAnalysisState(undefined);
    if (!selected || selected.taskDefinition.kind !== 'analysis') {
      return;
    }
    let cancelled = false;
    void window.praxis.ai.getAnalysis(selected.issueKey).then(next => {
      if (!cancelled) setAnalysisState(next);
    });
    const unsubscribe = window.praxis.ai.onAnalysisChanged(next => {
      if (next.issueKey === selected.issueKey) setAnalysisState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selected?.issueKey, selected?.taskDefinition.kind]);

  const sendFollowUp = async () => {
    if (!selected || !followUp.trim() || !isTerminalAgentState(selected.state)) return;
    setSendingFollowUp(true);
    setFollowUpError(undefined);
    try {
      let message = followUp.trim();
      if (attachTerminalContext) {
        if (!terminalForContext) throw new Error('The selected terminal has no recent output to attach.');
        const context = await window.praxis.terminal.getContext(terminalForContext.id);
        if (!context.output) throw new Error('The selected terminal has no recent output to attach.');
        const escapeContext = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        message = `<terminal_context cwd="${escapeContext(context.cwd)}" captured_at="${context.capturedAt}">\n${escapeContext(context.output)}\n</terminal_context>\n\n${message}`;
      }
      await window.praxis.ai.continueSession(selected.issueKey, message);
      setFollowUp('');
      setAttachTerminalContext(false);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingFollowUp(false);
    }
  };

  const abortSession = async () => {
    if (!selected || isTerminalAgentState(selected.state)) return;
    setAbortingSession(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.abort(selected.issueKey);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setAbortingSession(false);
    }
  };

  const switchMode = async (mode: SessionMode) => {
    if (!selected || mode === (selected.mode ?? 'chat') || !isTerminalAgentState(selected.state)) return;
    setSwitchingMode(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.switchSessionMode(selected.issueKey, mode);
      await window.praxis.ai.continueSession(selected.issueKey, MODE_TRANSITION[mode]);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingMode(false);
    }
  };

  const setAcpMode = async (modeId: string) => {
    if (!selected || modeId === selected.acpCurrentModeId) {
      setAcpModeMenuPos(undefined);
      return;
    }
    setSettingAcpMode(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.setAcpMode(selected.issueKey, modeId);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingAcpMode(false);
      setAcpModeMenuPos(undefined);
    }
  };

  /** Inserts `/name ` into the composer and focuses it — commands are plain prompt text, not a separate RPC (see `acpAgentHost.ts`). */
  const insertAcpCommand = (name: string) => {
    setFollowUp(current => (current.trim() ? `${current.trimEnd()} /${name} ` : `/${name} `));
    setAcpCommandMenuPos(undefined);
    document.querySelector<HTMLTextAreaElement>('[data-testid="session-follow-up-input"]')?.focus();
  };

  useEffect(() => {
    if (!acpModeMenuPos) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (acpModeMenuRef.current?.contains(target) || acpModeChipRef.current?.contains(target)) return;
      setAcpModeMenuPos(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [acpModeMenuPos]);

  useEffect(() => {
    if (!acpCommandMenuPos) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (acpCommandMenuRef.current?.contains(target) || acpCommandChipRef.current?.contains(target)) return;
      setAcpCommandMenuPos(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [acpCommandMenuPos]);

  useEffect(() => {
    setAttachTerminalContext(false);
    setAcpModeMenuPos(undefined);
    setAcpCommandMenuPos(undefined);
  }, [selected?.issueKey]);

  const confirmAndContinue = async () => {
    if (!selected || selected.taskDefinition.kind !== 'analysis' || selected.state !== 'completed') return;
    setConfirmingAnalysis(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.setAnalysisConfirmed(selected.issueKey, true);
      await window.praxis.ai.continueSession(
        selected.issueKey,
        'I confirm the analysis and implementation plan. Continue in this same session and implement the ticket now. Test the result and report back.'
      );
    } catch (error) {
      await window.praxis.ai.setAnalysisConfirmed(selected.issueKey, false).catch(() => undefined);
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirmingAnalysis(false);
    }
  };

  // Profile-wide "Plain chat background", overridable per session from the
  // console header. Undefined settings (still loading) fall back to themed.
  const globalPlainSurface = settings?.appearance.surface.plainChatSurface ?? false;
  const plainSurface = selected && selected.issueKey in plainSurfaceOverrides
    ? plainSurfaceOverrides[selected.issueKey]!
    : globalPlainSurface;
  const togglePlainSurface = () => {
    if (!selected) return;
    setPlainSurfaceOverrides(current => ({ ...current, [selected.issueKey]: !plainSurface }));
  };

  return (
    <div
      className={`sessions-layout${plainSurface ? ' plain-surface' : ''}`}
      data-testid="sessions-view"
    >
      <div
        className={`session-console${browserOpen && selected ? ' browser-open' : ''}${browserOpen && selected && browserMaximized ? ' browser-maximized' : ''}`}
        data-testid="session-console"
      >
        {!selected && (
          sessions.length === 0 ? (
            <div className="empty-state" style={{ flex: 1 }} data-testid="sessions-empty">
              <Icon name="robot" size={28} />
              <span>No AI sessions yet.</span>
              <button className="btn" onClick={onNewSession} data-testid="sessions-new-session">
                <Icon name="plus" size={13} />
                New session
              </button>
              {status && !status.configured && (
                <>
                  <span className="placeholder-text" style={{ textAlign: 'center' }}>
                    Set up the Vercel AI Gateway to delegate issues to an agent.
                  </span>
                  <button className="btn" onClick={onOpenAiSettings} data-testid="sessions-open-ai-settings">
                    Open AI Provider settings
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="empty-state" style={{ flex: 1 }}>
              <Icon name="terminal" size={28} />
              <span>Open a session from the sidebar to see its conversation.</span>
            </div>
          )
        )}
        {selected && (
          <>
            <div className="session-console-header">
              <Icon name="robot" size={14} />
              <span
                className="session-console-title"
                data-testid="session-console-title"
                title={sessionTitle(selected)}
              >
                {sessionLabel(selected)}
              </span>
              <button
                type="button"
                className={`icon-btn icon-btn-sm${plainSurface ? ' active' : ''}`}
                data-testid="session-plain-surface-toggle"
                aria-pressed={plainSurface}
                title={plainSurface
                  ? 'Plain background — click to show the theme surface behind this session'
                  : 'Theme surface — click for a plain background behind this session'}
                onClick={togglePlainSurface}
              >
                <Icon name="theme" size={13} />
              </button>
              <button
                type="button"
                className={`icon-btn icon-btn-sm${browserOpen ? ' active' : ''}`}
                data-testid="session-browser-toggle"
                aria-pressed={browserOpen}
                title={browserOpen ? 'Hide the in-app browser' : 'Show the in-app browser'}
                onClick={() => setBrowserVisibility(!browserOpen)}
              >
                <Icon name="globe" size={13} />
              </button>
            </div>

            {selected.taskDefinition.kind === 'analysis' && (
              <div className="session-analysis-banner" data-testid="session-analysis-banner">
                <Icon name={analysisState?.confirmed ? 'check-square' : 'search'} size={15} />
                <div>
                  <strong>{analysisState?.confirmed ? 'Analysis confirmed' : 'Ticket analysis'}</strong>
                  <span>
                    {analysisState?.confirmed
                      ? 'Implementation is continuing in this conversation.'
                      : selected.state === 'completed'
                        ? 'Review the analysis below, then confirm it to implement in this same session.'
                        : 'The agent is analysing the ticket in this conversation.'}
                  </span>
                </div>
                {!analysisState?.confirmed && selected.state === 'completed' && (
                  <button
                    className="btn btn-primary"
                    data-testid="session-analysis-confirm"
                    disabled={confirmingAnalysis}
                    onClick={() => void confirmAndContinue()}
                  >
                    <Icon name="check-square" size={13} />
                    {confirmingAnalysis ? 'Continuing…' : 'Confirm & implement'}
                  </button>
                )}
              </div>
            )}

            <div className="session-chat-scroll" ref={eventsRef} data-testid="session-chat-thread">
              <div className="session-chat-message is-user">
                <div className="session-chat-author">You</div>
                <div>{selected.taskDefinition.goal}</div>
              </div>
              {conversationEvents.map((event, index) => {
                const terminalContext = event.type === 'user_input_completed' ? parseTerminalContext(event.detail) : undefined;
                return (
                  <div
                    className={`session-chat-message ${event.type === 'message' ? 'is-assistant' : 'is-user'}`}
                    key={`${event.timestamp}-${index}`}
                    data-testid={event.type === 'message' ? 'session-chat-assistant' : 'session-chat-user'}
                  >
                    <div className="session-chat-author">{event.type === 'message' ? 'AI agent' : 'You'}</div>
                    {terminalContext && (
                      <details className="session-chat-terminal-context">
                        <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{terminalContext.cwd}</span></summary>
                        <pre>{terminalContext.output}</pre>
                      </details>
                    )}
                    <Markdown
                      text={stripGadgetFences(terminalContext?.message ?? event.detail ?? event.summary ?? '')}
                      testId="session-chat-markdown"
                    />
                    {/* Whatever this message asked for, rendered where it was
                        asked rather than pooled at the bottom of the thread. */}
                    <GadgetBlockList
                      blocks={gadgetBlocks[gadgetMessageKey(index)] ?? []}
                      busyGadgetId={busyGadgetId}
                      results={gadgetResults}
                      onSubmit={(gadgetId, actionId, value) => void submitGadgetAction(gadgetId, actionId, value)}
                    />
                  </div>
                );
              })}
              {shouldRenderResponseFallback && (
                <div className="session-chat-message is-assistant" data-testid="session-response">
                  <div className="session-chat-author">AI agent</div>
                  <Markdown text={selected?.responseText ?? ''} testId="session-chat-markdown" />
                </div>
              )}
              {liveActivityText ? (
                <div className="session-activity-status" data-testid="session-activity-status">
                  <span className="session-activity-dot" aria-hidden="true" />
                  <span>{liveActivityText}</span>
                </div>
              ) : (
                !selected.responseText && conversationEvents.length === 0 && (
                  <span className="placeholder-text">Waiting for the agent to respond…</span>
                )
              )}

            </div>

            {pendingPermission && (
              <div className="session-request-dock" data-testid="session-request-dock">
                <div className="session-permission-card" data-testid="session-permission-card">
                  <div className="session-permission-body">
                    <div className="session-permission-heading">
                      <Icon name="shield" size={14} />
                      <span data-testid="session-permission-summary">{pendingPermission.summary}</span>
                    </div>
                    {pendingPermission.detail && (
                      <div className="session-permission-detail">{pendingPermission.detail}</div>
                    )}
                  </div>
                  <div className="session-permission-actions">
                    <button
                      className="btn"
                      data-testid="session-permission-deny"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('deny')}
                    >
                      Deny
                    </button>
                    <button
                      className="btn"
                      data-testid="session-permission-allow-always"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('allow_always')}
                    >
                      Always allow
                    </button>
                    <button
                      className="btn btn-primary"
                      data-testid="session-permission-allow-once"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('allow_once')}
                    >
                      Allow
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="session-chat-composer">
              {followUpError && <div className="error-banner" data-testid="session-follow-up-error">{followUpError}</div>}
              {spend && spend.level !== 'ok' && (
                <div className={`composer-context-banner is-${spend.level}`} data-testid="session-spend">
                  <div className="composer-context-heading">
                    <Icon name={spend.level === 'critical' ? 'warning' : 'zap'} size={13} />
                    <span data-testid="session-spend-figure">
                      {formatCost({ amount: spend.spent, currency: spend.currency })} of{' '}
                      {formatCost({ amount: spend.limit, currency: spend.currency })} spend limit
                    </span>
                  </div>
                  <div
                    className={`session-context-bar is-${spend.level}`}
                    role="progressbar"
                    aria-valuenow={Math.min(spend.percent, 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Spend limit used"
                  >
                    <span style={{ width: `${Math.min(spend.percent, 100)}%` }} />
                  </div>
                  <p>
                    {spend.percent >= 100
                      ? 'Sessions have cost more than the limit you set in Settings → AI Provider. Nothing is blocked — Praxis cannot stop your agent spending, only tell you.'
                      : 'Approaching the spend limit you set in Settings → AI Provider.'}
                  </p>
                </div>
              )}
              {context && context.level !== 'ok' && (
                <div className={`composer-context-banner is-${context.level}`} data-testid="session-context">
                  <div className="composer-context-heading">
                    <Icon name={context.level === 'critical' ? 'warning' : 'zap'} size={13} />
                    <span data-testid="session-context-figure">{context.percent}% of {Math.round(context.limit / 1000)}k context used</span>
                  </div>
                  <div
                    className={`session-context-bar is-${context.level}`}
                    role="progressbar"
                    aria-valuenow={context.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Context window used"
                  >
                    <span style={{ width: `${context.percent}%` }} />
                  </div>
                  <p>
                    {context.level === 'critical'
                      ? 'The next turn may not fit. Start a fresh session to carry on with a clean context.'
                      : 'This conversation is filling the model’s window. Long tool output is the usual cause.'}
                  </p>
                </div>
              )}
              <div className="composer session-follow-up-composer">
                {attachTerminalContext && terminalForContext && (
                  <div className="terminal-context-attachment" data-testid="terminal-context-attachment">
                    <Icon name="terminal" size={14} />
                    <span>Recent terminal output</span>
                    <span className="terminal-context-cwd" title={terminalForContext.cwd}>{terminalForContext.cwd}</span>
                    <button className="icon-btn icon-btn-sm" aria-label="Remove terminal context" onClick={() => setAttachTerminalContext(false)}>
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                )}
                <textarea
                  className="composer-input"
                  rows={2}
                  data-testid="session-follow-up-input"
                  value={followUp}
                  disabled={!isTerminalAgentState(selected.state) || sendingFollowUp}
                  placeholder={
                    isTerminalAgentState(selected.state)
                      ? 'Ask the agent to clarify, change, or continue…'
                      : 'The agent is working…'
                  }
                  onChange={event => setFollowUp(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && followUp.trim()) {
                      event.preventDefault();
                      void sendFollowUp();
                    }
                  }}
                />
              <div className="composer-controls">
                  {/* A finished session can be re-run in a different mode; a live
                      one can only be stopped, so this only appears once it's
                      actually a choice. Mirrors where the New Session composer
                      puts the same control when a session starts. */}
                  {isTerminalAgentState(selected.state) && !isWorkflowStageSession(selected) && (
                    <div className="session-mode-toggle" role="group" aria-label="Switch session mode">
                      {(['chat', 'analysis', 'review'] as const).map(mode => (
                        <button
                          key={mode}
                          type="button"
                          className={selected.mode === mode || (!selected.mode && mode === 'chat') ? 'active' : ''}
                          disabled={switchingMode}
                          onClick={() => void switchMode(mode)}
                          data-testid={`session-switch-mode-${mode}`}
                        >
                          {mode[0].toUpperCase() + mode.slice(1)}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* ACP's own Session Mode — only meaningful while the agent's
                      connection is live (`AcpAgentHost.setAcpMode` requires an
                      active task), so this is the opposite condition from the
                      chat/analysis/review toggle above, which only appears once
                      terminal. Entirely distinct from that toggle. */}
                  {!isTerminalAgentState(selected.state) &&
                    selected.acpAvailableModes &&
                    selected.acpAvailableModes.length > 0 && (
                      <button
                        ref={acpModeChipRef}
                        className={`composer-chip${acpModeMenuPos ? ' active' : ''}`}
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={!!acpModeMenuPos}
                        disabled={settingAcpMode}
                        title="The agent's own operating mode"
                        data-testid="session-acp-mode"
                        onClick={() => {
                          if (acpModeMenuPos) {
                            setAcpModeMenuPos(undefined);
                            return;
                          }
                          const rect = acpModeChipRef.current?.getBoundingClientRect();
                          if (rect) setAcpModeMenuPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
                        }}
                      >
                        <Icon name="sliders" size={14} />
                        {selected.acpAvailableModes.find(mode => mode.id === selected.acpCurrentModeId)?.name ?? 'Mode'}
                        <Icon name="chevron-down" size={12} />
                      </button>
                    )}
                  {acpModeMenuPos &&
                    selected.acpAvailableModes &&
                    createPortal(
                      <div
                        ref={acpModeMenuRef}
                        className="composer-provider-menu"
                        role="listbox"
                        aria-label="Agent mode"
                        style={{ position: 'fixed', bottom: acpModeMenuPos.bottom, left: acpModeMenuPos.left }}
                      >
                        {selected.acpAvailableModes.map(mode => (
                          <button
                            key={mode.id}
                            type="button"
                            className={`composer-provider-option${mode.id === selected.acpCurrentModeId ? ' active' : ''}`}
                            role="option"
                            aria-selected={mode.id === selected.acpCurrentModeId}
                            title={mode.description}
                            data-testid={`session-acp-mode-option-${mode.id}`}
                            onClick={() => void setAcpMode(mode.id)}
                          >
                            {mode.name}
                          </button>
                        ))}
                      </div>,
                      document.body
                    )}
                  {/* The agent's own slash commands (ACP's `available_commands_update`).
                      Clicking one inserts `/name ` into the composer — commands are
                      plain prompt text over the same `session/prompt`, not a
                      separate RPC, so there is nothing to invoke here but text
                      insertion. Available regardless of run state: it edits the
                      draft, same as typing, so it works whenever the input does. */}
                  {selected.acpAvailableCommands && selected.acpAvailableCommands.length > 0 && (
                    <button
                      ref={acpCommandChipRef}
                      className={`composer-chip${acpCommandMenuPos ? ' active' : ''}`}
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={!!acpCommandMenuPos}
                      disabled={!isTerminalAgentState(selected.state) || sendingFollowUp}
                      title="The agent's own slash commands"
                      data-testid="session-acp-commands"
                      onClick={() => {
                        if (acpCommandMenuPos) {
                          setAcpCommandMenuPos(undefined);
                          return;
                        }
                        const rect = acpCommandChipRef.current?.getBoundingClientRect();
                        if (rect) setAcpCommandMenuPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
                      }}
                    >
                      <Icon name="terminal" size={14} />
                      Commands
                      <Icon name="chevron-down" size={12} />
                    </button>
                  )}
                  {acpCommandMenuPos &&
                    selected.acpAvailableCommands &&
                    createPortal(
                      <div
                        ref={acpCommandMenuRef}
                        className="composer-provider-menu"
                        role="listbox"
                        aria-label="Agent commands"
                        style={{ position: 'fixed', bottom: acpCommandMenuPos.bottom, left: acpCommandMenuPos.left }}
                      >
                        {selected.acpAvailableCommands.map(command => (
                          <button
                            key={command.name}
                            type="button"
                            className="composer-provider-option"
                            role="option"
                            title={command.inputHint ? `${command.description} (${command.inputHint})` : command.description}
                            data-testid={`session-acp-command-option-${command.name}`}
                            onClick={() => insertAcpCommand(command.name)}
                          >
                            /{command.name}
                          </button>
                        ))}
                      </div>,
                      document.body
                    )}
                  {terminalForContext && (
                    <button
                      className={`composer-chip terminal-context-button${attachTerminalContext ? ' active' : ''}`}
                      type="button"
                      aria-pressed={attachTerminalContext}
                      title={attachTerminalContext ? 'Remove terminal output from this message' : 'Attach recent terminal output'}
                      data-testid="attach-terminal-context"
                      onClick={() => setAttachTerminalContext(value => !value)}
                    >
                      <Icon name="terminal" size={14} />
                      Terminal
                      <span className="terminal-context-dot" aria-hidden="true" />
                    </button>
                  )}
                  {/* Fixed for the session's life — the same facts the New Session
                      composer asked for when it started, read back here rather
                      than tucked away in the inspector. */}
                  {selected.provider && (
                    <span className="composer-chip session-runtime-chip" data-testid="session-provider" title="This session's AI provider">
                      <Icon name={providerIconName(selected.provider)} size={14} />
                      {PROVIDER_LABELS[selected.provider]}
                    </span>
                  )}
                  {selected.model && (
                    <span className="composer-chip session-runtime-chip" data-testid="session-model" title="This session's AI model">
                      <Icon name="sparkles" size={14} />
                      {selected.model}
                    </span>
                  )}
                  <SessionRuntimeActions
                    session={selected}
                    onChangeModel={() => setTransitionDialog('model')}
                    onHandover={() => setTransitionDialog('handover')}
                  />
                  <span
                    className="composer-chip session-runtime-chip"
                    data-testid="session-tool-mode"
                    title="Tool access for this session — fixed when it started"
                  >
                    <Icon name={selected.toolMode === 'full' ? 'tools' : 'search'} size={14} />
                    {selected.toolMode === 'project-only'
                      ? 'Project only'
                      : selected.toolMode === 'read-only' ? 'Read only' : 'Full tools'}
                  </span>
                  {selected.workingDirectory && (
                    <span
                      className="composer-chip session-runtime-chip"
                      data-testid="session-working-directory"
                      title={selected.workingDirectory}
                    >
                      <Icon name="folder" size={14} />
                      {basename(selected.workingDirectory)}
                    </span>
                  )}
                  {selected.worktreeBranch && (
                    <span
                      className="composer-chip session-runtime-chip"
                      data-testid="session-worktree"
                      title={selected.worktreePath}
                    >
                      <Icon name="git-branch" size={14} />
                      {selected.worktreeBranch}
                      {selected.worktreeBaseBranch && (
                        <span className="session-worktree-base"> from {selected.worktreeBaseBranch}</span>
                      )}
                    </span>
                  )}
                  <span className="spacer" />
                  <button
                    className={`composer-send${!isTerminalAgentState(selected.state) ? ' composer-send-cancel' : ''}`}
                    aria-label={!isTerminalAgentState(selected.state) ? 'Cancel response' : sendingFollowUp ? 'Sending message' : 'Send message'}
                    title={!isTerminalAgentState(selected.state) ? (abortingSession ? 'Cancelling…' : 'Cancel response') : sendingFollowUp ? 'Sending…' : 'Send message'}
                    data-testid="session-follow-up-send"
                    disabled={abortingSession || (isTerminalAgentState(selected.state) && (sendingFollowUp || !followUp.trim()))}
                    onClick={() => {
                      if (!isTerminalAgentState(selected.state)) {
                        void abortSession();
                      } else {
                        void sendFollowUp();
                      }
                    }}
                  >
                    <Icon name={!isTerminalAgentState(selected.state) ? 'close' : 'arrow-up'} size={15} />
                  </button>
                </div>
              </div>
            </div>
            {browserOpen && (
              <div
                className={`session-browser-dock${settings?.ai.browserTools.enabled ? ' ai-controlled' : ''}`}
                title={settings?.ai.browserTools.enabled ? 'The AI can drive this browser' : undefined}
              >
                <BrowserPane
                  initialUrl={initialBrowserUrl}
                  onNavigate={onBrowserUrlChange}
                  suspended={browserSuspended}
                  maximized={browserMaximized}
                  onToggleMaximize={() => setBrowserMaximized(value => !value)}
                  onClose={() => setBrowserVisibility(false)}
                />
              </div>
            )}
          </>
        )}
      </div>
      {selected && (
        <SessionTransitionDialogs
          session={selected}
          open={transitionDialog}
          onClose={() => setTransitionDialog(undefined)}
        />
      )}
    </div>
  );
}
