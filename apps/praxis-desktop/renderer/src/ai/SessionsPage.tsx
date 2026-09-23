import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AiAnalysisState,
  AiProvider,
  AiProviderStatus,
  PermissionDecision,
  SessionMode,
  TerminalSessionInfo,
  UsageBucket,
  ProviderUsageSnapshot,
  WireImageAttachment,
  WorkflowRunSummary
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { isTerminalAgentState } from './aiSessionState';
import { useDialogs } from '../ui/dialogs';
import { useSettings } from '../settings/useSettings';
import { BrowserPane } from '../browser/BrowserPane';
import { getActiveTerminalId, onActiveTerminalChanged } from './terminalSelection';
import { PROVIDER_LABELS, providerIconName } from './modelProviders';
import { basename, contextPressure, formatCost, formatContextLength, formatErrorMessage, formatModelCost, getKnownContextLength, getModelPricing, isProviderLimitMessage, isWorkflowStageSession, liveActivity, sessionLabel, sessionLimitNotice, sessionTitle, spendPressure } from './sessionNav';
import { SessionConversationActions, SessionConversationDialog, SessionLimitSwitch, canChangeSessionRuntime, SessionTransitionDialogs, type ComposerPopoverPosition } from './SessionHandover';
import { SessionFocusTabs } from './SessionFocusTabs';
import { LiveTurnActivityIndicator, formatElapsedDuration } from './LiveTurnActivityIndicator';
import {
  MAX_ATTACHED_IMAGES,
  collectClipboardImages,
  collectImageFiles,
  encodeImageAttachment
} from './imageAttachments';
import { GadgetBlockList } from './gadgets';
import { useSessionGadgets } from './gadgets/useSessionGadgets';
import { gadgetMessageKey, stripGadgetFences, visibleMessageText } from './gadgets/messageText';
import type { SessionWorkflowOption } from './NewSession';

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

/** Image thumbnails for a user turn in the chat transcript; click enlarges. */
function TranscriptAttachments({ attachments }: { attachments: WireImageAttachment[] | undefined }) {
  const [enlarged, setEnlarged] = useState<{ image: WireImageAttachment; index: number }>();
  if (!attachments?.length) return null;
  return (
    <div className="session-chat-attachments" data-testid="session-chat-attachments">
      {attachments.map((image, index) => (
        <button
          key={`${index}-${image.dataBase64.length}`}
          type="button"
          className="session-chat-attachment"
          data-testid="session-chat-attachment"
          title="View full size"
          onClick={() => setEnlarged({ image, index })}
        >
          <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={`Attached image ${index + 1}`} />
        </button>
      ))}
      {enlarged && createPortal(
        <div
          className="session-image-lightbox"
          data-testid="session-image-lightbox"
          role="dialog"
          aria-label={`Attached image ${enlarged.index + 1}, full size`}
          onClick={() => setEnlarged(undefined)}
        >
          <img src={`data:${enlarged.image.mimeType};base64,${enlarged.image.dataBase64}`} alt={`Attached image ${enlarged.index + 1}`} />
        </div>,
        document.body
      )}
    </div>
  );
}

export interface SessionsPageProps {
  /** All known agent sessions, most recent first. Live-updated by the App-level push subscription. */
  sessions: AgentSessionRecord[];
  selectedKey: string | undefined;
  workflowOptions?: SessionWorkflowOption[];
  onStartWorkflow?: (session: AgentSessionRecord, workflowId: string) => Promise<void>;
  onSelectWorkflowRun?: (session: AgentSessionRecord, runId: string) => Promise<void>;
  onRemoveWorkflowRun?: (session: AgentSessionRecord, runId: string) => Promise<void>;
  onNewSession: () => void;
  onSelectSession: (issueKey: string) => void;
  onOpenAiSettings: () => void;
  focusMode?: boolean;
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

function formatMessageTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFullDateTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    return '';
  }
}

function useSessionWorkflowRuns(session: AgentSessionRecord | undefined): WorkflowRunSummary[] {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const runKey = [...new Set([
    ...(session?.workflowRunIds ?? []),
    ...(session?.workflowRunId ? [session.workflowRunId] : [])
  ])].join('|');

  useEffect(() => {
    let active = true;
    const runIds = runKey ? runKey.split('|') : [];
    const refresh = () => {
      if (runIds.length === 0) {
        if (active) setRuns([]);
        return;
      }
      void Promise.all(runIds.map(runId => window.praxis.workflows.getRun(runId)))
        .then(found => {
          if (active) setRuns(found.filter((run): run is WorkflowRunSummary => !!run));
        })
        .catch(() => {
          if (active) setRuns([]);
        });
    };
    refresh();
    const unsubscribe = window.praxis.workflows.onRunChanged(runId => {
      if (runIds.includes(runId)) refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runKey, session?.issueKey]);

  return runs;
}

function WorkflowManagedRuntimeChip({
  run,
  stage,
  stageSession
}: {
  run: WorkflowRunSummary;
  stage?: WorkflowRunSummary['stages'][number];
  stageSession?: AgentSessionRecord;
}) {
  const [position, setPosition] = useState<ComposerPopoverPosition>();
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!position) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPosition(undefined);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [position]);

  const runtime = stageSession?.provider
    ? `${PROVIDER_LABELS[stageSession.provider]}${stageSession.model ? ` · ${stageSession.model}` : ''}`
    : stage?.type === 'agent-task'
      ? 'Resolved when the stage starts'
      : stage
        ? 'Automated workflow step'
        : 'Waiting for the next stage';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-chip session-runtime-chip${position ? ' active' : ''}`}
        data-testid="session-workflow-runtime"
        title="Provider and model are controlled by this workflow while it is active"
        aria-haspopup="dialog"
        aria-expanded={Boolean(position)}
        onClick={() => {
          if (position) {
            setPosition(undefined);
            return;
          }
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setPosition({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
        }}
      >
        <Icon name="sparkles" size={14} />
        <span className="session-runtime-chip-label">Workflow managed</span>
      </button>
      {position && createPortal(
        <div
          className="composer-provider-menu session-runtime-popover session-workflow-runtime-popover"
          role="dialog"
          aria-label="Workflow-managed runtime"
          data-testid="session-workflow-runtime-popover"
          style={{ position: 'fixed', bottom: position.bottom, left: position.left }}
        >
          <div className="popover-label">Workflow-managed runtime</div>
          <dl className="session-workflow-runtime-details">
            <div><dt>Workflow</dt><dd>{run.workflowName}</dd></div>
            <div><dt>Active stage</dt><dd>{stage?.name ?? 'Preparing'}</dd></div>
            <div><dt>Runtime</dt><dd>{runtime}</dd></div>
          </dl>
          <p className="session-workflow-runtime-note">
            Provider and model are fixed by the workflow stage. Open its stage session for full runtime provenance.
          </p>
        </div>,
        document.body
      )}
    </>
  );
}

/** The everyday workflow control for an existing chat. */
function SessionWorkflowControl({
  session,
  runs,
  options,
  onStartWorkflow,
  onSelectWorkflowRun,
  onRemoveWorkflowRun,
  onError
}: {
  session: AgentSessionRecord;
  runs: WorkflowRunSummary[];
  options: SessionWorkflowOption[];
  onStartWorkflow?: (session: AgentSessionRecord, workflowId: string) => Promise<void>;
  onSelectWorkflowRun?: (session: AgentSessionRecord, runId: string) => Promise<void>;
  onRemoveWorkflowRun?: (session: AgentSessionRecord, runId: string) => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<ComposerPopoverPosition>();
  const [busy, setBusy] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const select = async (runId: string) => {
    if (!onSelectWorkflowRun || runId === session.workflowRunId) return;
    setBusy(runId);
    onError(undefined);
    try {
      await onSelectWorkflowRun(session, runId);
      setMenuOpen(false);
      setMenuPosition(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const start = async (workflowId: string) => {
    if (!onStartWorkflow) return;
    setBusy(workflowId);
    onError(undefined);
    try {
      await onStartWorkflow(session, workflowId);
      setMenuOpen(false);
      setMenuPosition(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (event: MouseEvent, runId: string) => {
    event.stopPropagation();
    if (!onRemoveWorkflowRun) return;
    setBusy(runId);
    onError(undefined);
    try {
      await onRemoveWorkflowRun(session, runId);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  if (!onStartWorkflow && runs.length === 0) return null;

  const activeRun = runs.find(run => run.runId === session.workflowRunId);
  const hasSelectableWorkflow = runs.length > 0 || options.length > 0;

  return (
    <div className="session-workflow-control" data-testid="session-workflow-chips">
      <button
        type="button"
        className={`composer-chip session-runtime-chip${menuOpen ? ' active' : ''}`}
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        disabled={!!busy || !hasSelectableWorkflow}
        title={hasSelectableWorkflow ? 'Choose a workflow for this session' : 'No project workflows are available for this session.'}
        data-testid="session-workflow-add"
        ref={triggerRef}
        onClick={() => {
          if (menuOpen) {
            setMenuOpen(false);
            setMenuPosition(undefined);
            return;
          }
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) {
            const menuWidth = 260;
            const left = Math.max(8, rect.right - menuWidth);
            setMenuPosition({ bottom: window.innerHeight - rect.top + 6, left });
          }
          setMenuOpen(true);
        }}
      >
        <Icon name="play" size={14} />
        <span className="session-runtime-chip-label">{activeRun ? activeRun.workflowName : 'Workflow'}</span>
      </button>
      {menuOpen && menuPosition && createPortal(
        <div
          className="composer-provider-menu session-runtime-popover"
          role="dialog"
          aria-label="Select workflow"
          data-testid="session-workflow-menu"
          style={{ position: 'fixed', bottom: menuPosition.bottom, left: menuPosition.left }}
        >
          {runs.length > 0 && (
            <section aria-label="Current workflows">
              <div className="popover-label">Current workflows</div>
              {runs.map(run => (
                <div
                  key={run.runId}
                  className={`composer-provider-option${run.runId === session.workflowRunId ? ' active' : ''}`}
                  role="option"
                  aria-selected={run.runId === session.workflowRunId}
                  aria-disabled={!!busy}
                  tabIndex={busy ? -1 : 0}
                  title={`${run.workflowName} · ${run.status}`}
                  data-testid={`session-workflow-chip-${run.runId}`}
                  onClick={busy ? undefined : () => void select(run.runId)}
                  onKeyDown={busy ? undefined : event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void select(run.runId);
                    }
                  }}
                >
                  <Icon name={run.runId === session.workflowRunId ? 'check' : 'arrow-right'} size={14} />
                  <span>{run.workflowName}</span>
                  <small>{run.status === 'awaiting-approval' ? 'Awaiting approval' : run.status}</small>
                  {onRemoveWorkflowRun && (
                    <button
                      type="button"
                      className="composer-provider-remove"
                      aria-label={`Remove ${run.workflowName} from this session`}
                      title="Remove this workflow from the session"
                      data-testid={`session-workflow-remove-${run.runId}`}
                      disabled={!!busy}
                      onClick={event => void remove(event, run.runId)}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
          {runs.length > 0 && options.length > 0 && <div className="session-workflow-menu-divider" />}
          {onStartWorkflow && options.length > 0 && (
            <section aria-label="Start workflow">
              <div className="popover-label">{runs.length > 0 ? 'Start another workflow' : 'Start a workflow'}</div>
              {options.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className="composer-provider-option"
                  disabled={!option.ready || !!busy}
                  title={option.ready ? option.description : option.blockers?.join(' ')}
                  onClick={() => void start(option.id)}
                >
                  <Icon name="plus" size={14} />
                  <span>{option.name}</span>
                  {!option.ready && <small className="is-danger">{option.blockers?.[0] ?? 'Not ready'}</small>}
                </button>
              ))}
            </section>
          )}
        </div>
      , document.body)}
    </div>
  );
}

function SessionUsageSummary({
  session,
  sessions,
  spendLimit,
  onHide
}: {
  session: AgentSessionRecord;
  sessions: AgentSessionRecord[];
  spendLimit: number;
  onHide?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailsClosing, setDetailsClosing] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [windows, setWindows] = useState<Record<string, UsageBucket | undefined>>({});
  const [provider, setProvider] = useState<ProviderUsageSnapshot | undefined>();

  const closeDetails = useCallback(() => {
    if (!open || detailsClosing) return;
    setDetailsClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setDetailsClosing(false);
    }, 240);
  }, [open, detailsClosing]);

  useEffect(() => {
    if (!open || detailsClosing) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || !detailsRef.current) return;
      if (!detailsRef.current.contains(target)) {
        closeDetails();
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDetails();
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [open, detailsClosing, closeDetails]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.praxis.aiUsage.series('hour', 1),
      window.praxis.aiUsage.series('day', 1),
      window.praxis.aiUsage.series('week', 1),
      window.praxis.aiUsage.series('month', 1),
      session.provider ? window.praxis.aiUsage.providerSnapshot(session.provider) : Promise.resolve(undefined)
    ]).then(([hour, day, week, month, snapshot]) => {
      if (cancelled) return;
      setWindows({ hour: hour[0], day: day[0], week: week[0], month: month[0] });
      setProvider(snapshot);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [session.provider, session.sessionId, session.tokenUsage?.totalTokens, session.cost?.amount]);

  const modelTotals = new Map<string, { tokens: number; costs: Array<{ amount: number; currency: string }> }>();
  for (const item of sessions) {
    const key = item.model || 'Unknown model';
    const row = modelTotals.get(key) ?? { tokens: 0, costs: [] };
    row.tokens += item.tokenUsage?.totalTokens ?? 0;
    if (item.cost) row.costs.push(item.cost);
    modelTotals.set(key, row);
  }
  const localCost = sessions.reduce((total, item) => total + (item.cost?.amount ?? 0), 0);
  const localCurrency = sessions.find(item => item.cost?.currency)?.cost?.currency;
  const sessionTokens = session.tokenUsage?.totalTokens;
  const isLimit = Boolean(session.providerLimitReached || sessionLimitNotice(session));
  const providerWarning = provider?.windows.find(window => {
    if (typeof window.usedPercent === 'number') return window.usedPercent >= 80;
    const used = window.usedTokens ?? window.usedCost;
    const limit = window.tokenLimit ?? window.costLimit;
    return typeof used === 'number' && typeof limit === 'number' && limit > 0 && used / limit >= 0.8;
  }) || (isLimit ? { period: 'hour' as const, label: 'Limit reached', usedPercent: 100 } : undefined);
  const formatWindow = (bucket: UsageBucket | undefined) => bucket ? `${Math.round(bucket.totalTokens).toLocaleString()} tokens` : '—';
  const spendRatio = spendLimit > 0 ? localCost / spendLimit : undefined;

  return (
    <details
      ref={detailsRef}
      className="session-usage-summary"
      open={open || detailsClosing}
      onToggle={event => {
        if (!detailsClosing) {
          setOpen(event.currentTarget.open);
        }
      }}
      data-testid="session-usage-summary"
    >
      <summary
        onClick={event => {
          if (open && !detailsClosing) {
            event.preventDefault();
            closeDetails();
          }
        }}
      >
        <Icon name="graph" size={14} />
        <span>Usage</span>
        <span className="session-usage-summary-meta">
          {session.model ? `${session.model} · ` : ''}
          {sessionTokens ? `${Math.round(sessionTokens).toLocaleString()} tokens` : 'No token data'}
          {session.cost ? ` · ${formatCost(session.cost)}` : ''}
        </span>
        {providerWarning && (
          <span className={`session-usage-warning${isLimit || providerWarning.usedPercent === 100 ? ' is-limit' : ''}`}>
            {isLimit || providerWarning.usedPercent === 100 ? (providerWarning.label && providerWarning.label !== 'Limit reached' ? providerWarning.label : 'Provider limit reached') : 'Approaching provider limit'}
          </span>
        )}
        {onHide && (
          <button
            type="button"
            className="icon-btn icon-btn-sm session-usage-hide-btn"
            aria-label="Hide usage bar"
            title="Hide usage bar"
            data-testid="session-usage-hide-btn"
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              onHide();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </summary>
      {(open || detailsClosing) && (
        <div className={`session-usage-details-content${detailsClosing ? ' is-closing' : ''}`}>
          <div className="session-usage-grid">
            <div className="session-usage-card">
              <span className="session-usage-label">This session</span>
              <strong>
                {session.model ? `${session.model} · ` : ''}
                {sessionTokens ? `${Math.round(sessionTokens).toLocaleString()} tokens` : isLimit ? 'Limit reached' : 'Not reported'}
              </strong>
              <small>{isLimit ? (session.lastError ?? 'Provider limit reached') : session.cost ? formatCost(session.cost) : 'Cost not reported by provider'}</small>
            </div>
            {(['hour', 'day', 'week', 'month'] as const).map(period => (
              <div className="session-usage-card" key={period}>
                <span className="session-usage-label">Last {period}</span>
                <strong>{formatWindow(windows[period])}</strong>
                <small>{windows[period]?.costByCurrency.map(cost => `${cost.amount.toFixed(2)} ${cost.currency}`).join(', ') || 'Cost unavailable'}</small>
              </div>
            ))}
          </div>
          {spendRatio !== undefined && spendRatio >= 0.8 && (
            <div className={`session-usage-warning-banner${spendRatio >= 1 ? ' is-critical' : ''}`}>
              <Icon name={spendRatio >= 1 ? 'warning' : 'zap'} size={13} />
              {spendRatio >= 1 ? 'Your Praxis spend limit has been exceeded.' : 'You are approaching your Praxis spend limit.'}
            </div>
          )}
          <div className="session-usage-models">
            <span className="session-usage-label">By model</span>
            {[...modelTotals.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6).map(([model, row]) => (
              <div className="session-usage-model-row" key={model}>
                <span>{model}</span>
                <span>{row.tokens ? `${Math.round(row.tokens).toLocaleString()} tokens` : '—'}{row.costs.length > 0 ? ` · ${row.costs.map(cost => formatCost(cost)).join(', ')}` : ''}</span>
              </div>
            ))}
          </div>
          <div className="session-usage-provider">
            <span className="session-usage-label">{session.provider ? `${PROVIDER_LABELS[session.provider]} account` : 'Provider account'}</span>
            {provider?.totalTokens ? <span>{Math.round(provider.totalTokens).toLocaleString()} cumulative tokens</span> : provider?.credits ? <span>{provider.credits.remaining.toFixed(2)} {provider.credits.currency} remaining</span> : <span>{provider?.unavailableReason ?? 'Credits and account limits are not exposed by this provider.'}</span>}
          </div>
          {provider && provider.windows.length > 0 && (
            <div className="session-usage-provider-windows">
              {provider.windows.map(window => (
                <div className="session-usage-card" key={`${window.period}-${window.label ?? ''}`}>
                  <span className="session-usage-label">{window.label ?? `Provider ${window.period}`}</span>
                  <strong>{typeof window.usedPercent === 'number' ? `${window.usedPercent}% used` : 'Usage reported'}</strong>
                  <small>{window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : 'Reset time unavailable'}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </details>
  );
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
  workflowOptions = [],
  onStartWorkflow,
  onSelectWorkflowRun,
  onRemoveWorkflowRun,
  onNewSession,
  onSelectSession,
  onOpenAiSettings,
  focusMode = false,
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
  /** Images pasted/dropped into the composer, carried with the next follow-up. */
  const [followUpImages, setFollowUpImages] = useState<WireImageAttachment[]>([]);
  const [followUpError, setFollowUpError] = useState<string | undefined>();
  const [dismissedError, setDismissedError] = useState<string | undefined>();
  // "Stop" on the out-of-budget notice, for this session until the user sends it another message.
  const [limitStoppedFor, setLimitStoppedFor] = useState<string>();
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  /** True while an image drag hovers the composer, for the drop highlight. */
  const [composerDragOver, setComposerDragOver] = useState(false);
  const [submittedTurn, setSubmittedTurn] = useState<{
    issueKey: string;
    message: string;
    eventCount: number;
    previousResponseText: string;
    suppressPreviousResponse: boolean;
    images?: WireImageAttachment[];
    submittedAt?: number;
  }>();
  /** When true, expands the in-flight composer so the user can queue a follow-up. */
  const [inflightComposerExpanded, setInflightComposerExpanded] = useState(false);
  /** Queued follow-up messages per session, automatically dispatched when the session's active turn finishes. */
  const [queuedFollowUpsBySession, setQueuedFollowUpsBySession] = useState<Record<string, { message: string; images?: WireImageAttachment[] }>>({});
  const hadTypedInInflightComposerRef = useRef(false);
  const [abortingSession, setAbortingSession] = useState(false);
  const [usageHidden, setUsageHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem('praxis:session-usage-hidden') === 'true';
    } catch {
      return false;
    }
  });
  const [usageClosing, setUsageClosing] = useState(false);
  const toggleUsageHidden = (hidden: boolean) => {
    setUsageHidden(hidden);
    try {
      localStorage.setItem('praxis:session-usage-hidden', hidden ? 'true' : 'false');
    } catch {
      // ignore storage failure
    }
  };
  const handleHideUsage = () => {
    if (usageClosing) return;
    setUsageClosing(true);
    window.setTimeout(() => {
      toggleUsageHidden(true);
      setUsageClosing(false);
    }, 260);
  };
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
  const followUpTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [analysisState, setAnalysisState] = useState<AiAnalysisState | undefined>();
  const [confirmingAnalysis, setConfirmingAnalysis] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | undefined>(() => getActiveTerminalId());
  const [attachTerminalContext, setAttachTerminalContext] = useState(false);
  const [plainSurfaceOverrides, setPlainSurfaceOverrides] = useState<Record<string, boolean>>(readPlainSurfaceOverrides);
  const [transitionPopover, setTransitionPopover] = useState<{ open: 'model' | 'handover'; position: ComposerPopoverPosition }>();
  const [conversationPopoverPosition, setConversationPopoverPosition] = useState<ComposerPopoverPosition>();
  const [conversationInitialProvider, setConversationInitialProvider] = useState<AiProvider>();
  const [conversationTargetId, setConversationTargetId] = useState<string>();
  const [contextPopoverPosition, setContextPopoverPosition] = useState<ComposerPopoverPosition>();
  const contextChipRef = useRef<HTMLButtonElement | null>(null);
  const contextPopoverRef = useRef<HTMLDivElement | null>(null);
  const [browserOpen, setBrowserOpen] = useState(initialBrowserOpen ?? false);
  const [browserMaximized, setBrowserMaximized] = useState(false);
  const browserDismissed = useRef(initialBrowserOpen === false);
  const { settings } = useSettings();
  const eventsRef = useRef<HTMLDivElement>(null);
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | undefined>();

  const copyMessageText = (key: string, text: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedMessageKey(key);
      setTimeout(() => {
        setCopiedMessageKey(prev => prev === key ? undefined : prev);
      }, 2000);
    }).catch(() => undefined);
  };

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
  const selectedWorkflowRuns = useSessionWorkflowRuns(selected);
  const activeWorkflowRun = selectedWorkflowRuns.find(run => run.runId === selected?.workflowRunId);
  const workflowOwnsRuntime = selected?.workflowRole === 'controller'
    && (activeWorkflowRun?.status === 'running' || activeWorkflowRun?.status === 'awaiting-approval');
  const activeWorkflowStage = activeWorkflowRun?.stages.find(stage => stage.lane === 'running')
    ?? activeWorkflowRun?.stages.find(stage => stage.lane === 'paused')
    ?? activeWorkflowRun?.stages.find(stage => stage.lane === 'awaiting')
    ?? activeWorkflowRun?.stages.find(stage => stage.lane === 'ready');
  const activeWorkflowStageSession = activeWorkflowStage?.sessionKey
    ? sessions.find(session => session.issueKey === activeWorkflowStage.sessionKey)
    : undefined;
  const conversationRunning = selected?.conversation?.state === 'running';
  const contextCompactionCommand = selected?.acpAvailableCommands?.find(command =>
    command.name.replace(/^\/+/, '').trim().toLowerCase() === 'compact'
  );
  const canCompactContext = Boolean(contextCompactionCommand && selected && isTerminalAgentState(selected.state));
  useEffect(() => {
    setTransitionPopover(undefined);
    setConversationPopoverPosition(undefined);
    setConversationTargetId(undefined);
    setContextPopoverPosition(undefined);
  }, [selected?.issueKey]);
  useEffect(() => {
    if (selected?.conversation?.state === 'running') {
      setConversationTargetId(current => current && selected.conversation?.participants.some(participant => participant.id === current)
        ? current
        : selected.conversation!.currentSpeakerId);
    }
  }, [selected?.conversation?.currentSpeakerId, selected?.conversation?.state]);
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
  // A human can send a directed message while one of the AIs is still
  // speaking. The host keeps those messages in the conversation queue until
  // the current turn settles, so render that queue as part of the live thread
  // instead of making the message appear one turn late.
  const pendingConversationMessages = selected?.conversation?.state === 'running'
    ? selected.conversation.pendingUserMessages ?? []
    : [];
  const activeSubmittedTurn = submittedTurn?.issueKey === selected?.issueKey ? submittedTurn : undefined;
  const submittedTurnEvents = activeSubmittedTurn
    ? selected?.events.slice(activeSubmittedTurn.eventCount) ?? []
    : [];
  const submittedTurnRecorded = Boolean(activeSubmittedTurn && submittedTurnEvents.some(event =>
    event.type === 'user_input_completed' && event.detail?.trim() === activeSubmittedTurn.message.trim()
  ));
  const submittedTurnQueued = Boolean(activeSubmittedTurn && pendingConversationMessages.some(pending =>
    pending.message === activeSubmittedTurn.message
  ));
  const submittedTurnAnswered = submittedTurnEvents.some(event => event.type === 'message');
  const isTurnActive = Boolean(
    selected && (
      (!isTerminalAgentState(selected.state) && selected.state !== 'awaiting_approval' && selected.state !== 'awaiting_input')
      || sendingFollowUp
      || (activeSubmittedTurn && !submittedTurnAnswered)
    )
  );
  const activeTurnStartedAt = useMemo(() => {
    if (activeSubmittedTurn?.submittedAt) {
      return activeSubmittedTurn.submittedAt;
    }
    if (selected) {
      for (let i = selected.events.length - 1; i >= 0; i--) {
        const ev = selected.events[i];
        if (ev.type === 'user_input_completed') {
          const t = Date.parse(ev.timestamp);
          if (!Number.isNaN(t)) return t;
        }
      }
      const started = Date.parse(selected.startedAt);
      if (!Number.isNaN(started)) return started;
    }
    return undefined;
  }, [activeSubmittedTurn?.submittedAt, selected?.events, selected?.startedAt]);
  const optimisticFollowUp = activeSubmittedTurn && !submittedTurnRecorded && !submittedTurnQueued
    ? activeSubmittedTurn
    : undefined;
  const optimisticTerminalContext = optimisticFollowUp
    ? parseTerminalContext(optimisticFollowUp.message)
    : undefined;
  const livePendingConversationMessages = optimisticFollowUp && !optimisticFollowUp.suppressPreviousResponse
    ? [{ participantId: 'optimistic', message: optimisticFollowUp.message }]
    : pendingConversationMessages;
  const latestEventResponse = [...conversationEvents]
    .reverse()
    .find(event => event.type === 'message')?.detail;
  const visibleResponseText = selected?.responseText ? visibleMessageText(selected.responseText) : '';
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
    visibleResponseText
      && selected?.responseText !== latestEventResponse
      && (!isTerminalAgentState(selected.state) || conversationEvents.length === 0)
      && !staleTerminalResponse
      && !(
        activeSubmittedTurn?.suppressPreviousResponse
        && !submittedTurnAnswered
        && selected?.responseText === activeSubmittedTurn.previousResponseText
      )
  );


  const isSelectedFailed = selected?.state === 'failed';
  const lastEvent = selected?.events[selected.events.length - 1];
  const lastErrorFromEvent = lastEvent?.type === 'error' ? (lastEvent.detail || lastEvent.summary) : undefined;
  const sessionError = isSelectedFailed
    ? (selected?.lastError || lastErrorFromEvent || 'The agent session encountered an error and could not complete.')
    : undefined;
  const rawActiveError = followUpError || sessionError;
  const limitNotice = sessionLimitNotice(selected);
  const isLimit = Boolean(
    selected?.providerLimitReached
      || limitNotice
      || (rawActiveError && isProviderLimitMessage(rawActiveError))
  );
  const isDismissed = Boolean(dismissedError && rawActiveError === dismissedError);
  const activeErrorMessage = !isDismissed
    ? ((isLimit && limitNotice) ? limitNotice : (rawActiveError ? formatErrorMessage(rawActiveError) : undefined))
    : undefined;


  const { gadgetBlocks, gadgetResults, busyGadgetId, submitGadgetAction } = useSessionGadgets(selected, conversationEvents);

  // One line describing what the agent is doing right now — shown only while a
  // turn is in flight, in place of streaming every tool block. Shared with the
  // inspector's copy of the same line; see `liveActivity` in sessionNav.ts.
  const liveActivityText = selected ? liveActivity(selected) : undefined;
  // Same conversation-aware speaker lookup as the response-fallback header
  // below, so the "thinking" indicator's icon matches whichever AI actually
  // holds the turn, not just whoever last set `record.provider`.
  const activitySpeaker = selected?.conversation?.state === 'running'
    ? selected.conversation.participants.find(participant => participant.id === selected.conversation?.currentSpeakerId)
    : undefined;
  const activityProvider = activitySpeaker?.provider ?? selected?.provider;

  // A single-agent turn is in flight (not in a multi-AI conversation).
  const isSingleAgentRunning = !!selected && !isTerminalAgentState(selected.state) && !conversationRunning;
  // Kept minimized by default while running unless the user explicitly expanded it via "Ask".
  const followUpCollapsed = isSingleAgentRunning && !inflightComposerExpanded;
  const activeQueuedMessage = selected ? queuedFollowUpsBySession[selected.issueKey] : undefined;

  useEffect(() => {
    setInflightComposerExpanded(false);
    hadTypedInInflightComposerRef.current = false;
  }, [selected?.issueKey]);

  // Auto-dispatch queued follow-up as soon as the session finishes its active turn.
  useEffect(() => {
    if (!selected || !isTerminalAgentState(selected.state) || sendingFollowUp) return;
    const queued = queuedFollowUpsBySession[selected.issueKey];
    if (!queued) return;

    setQueuedFollowUpsBySession(prev => {
      const next = { ...prev };
      delete next[selected.issueKey];
      return next;
    });

    void (async () => {
      setSendingFollowUp(true);
      setFollowUpError(undefined);
      setDismissedError(undefined);
      try {
        setSubmittedTurn({
          issueKey: selected.issueKey,
          message: queued.message,
          eventCount: selected.events.length,
          previousResponseText: selected.responseText ?? '',
          suppressPreviousResponse: true,
          images: queued.images?.length ? [...queued.images] : undefined,
          submittedAt: Date.now()
        });
        await window.praxis.ai.continueSession(selected.issueKey, queued.message, queued.images);
      } catch (error) {
        setSubmittedTurn(undefined);
        setFollowUp(current => current || queued.message);
        if (queued.images?.length) setFollowUpImages(queued.images);
        setFollowUpError(error instanceof Error ? error.message : String(error));
      } finally {
        setSendingFollowUp(false);
      }
    })();
  }, [selected?.issueKey, selected?.state, sendingFollowUp, queuedFollowUpsBySession]);

  // The follow-up box starts at one line and grows with content, instead of
  // reserving two rows' worth of empty space for the common case of a short
  // reply. Reset to 'auto' first so a deletion shrinks the box back down —
  // `scrollHeight` only ever reports the content's current natural height,
  // never shrinks a box that's already taller than it needs to be. While a
  // turn is running and minimized it collapses to 0 instead (the `.is-collapsed`
  // CSS class zeroes its padding/min-height too, so this is the actual rendered
  // height, not just clamped back up by the min-height floor); `theme.css` puts a
  // `transition: height` on `.session-follow-up-input` so both directions
  // animate rather than snapping.
  useEffect(() => {
    const node = followUpTextareaRef.current;
    if (!node) return;
    if (followUpCollapsed) {
      node.style.height = '0px';
      return;
    }
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [followUp, followUpCollapsed]);

  // The pending permission the agent is blocked on, if any — surfaced as a
  // slide-up dock directly above the chat input.
  const pendingPermission = selected?.state === 'awaiting_approval'
    ? pendingPermissionEvent(selected.events)
    : undefined;
  // How full the model's context is for the next turn. A compact progress ring
  // beside Send keeps it visible at every reported level; its popover carries
  // the fuller warning and guidance without permanently occupying composer
  // space.
  const context = selected
    ? (contextPressure(selected) ?? {
        fraction: 0,
        percent: 0,
        used: selected.contextTokens ?? selected.tokenUsage?.inputTokens ?? 0,
        limit: selected.contextLimit ?? 128000,
        level: 'ok' as const
      })
    : undefined;
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

  useEffect(() => {
    if (!contextPopoverPosition) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (contextPopoverRef.current?.contains(target) || contextChipRef.current?.contains(target)) return;
      setContextPopoverPosition(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextPopoverPosition(undefined);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextPopoverPosition]);

  // Follow the stream: whenever the selected session gains events, pin the
  // console to the latest one (the list replaces the record object on every
  // push, so the count is the reliable change signal).
  useEffect(() => {
    const node = eventsRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [selected?.issueKey, selectedEventCount, selected?.responseText, latestEventResponse, pendingConversationMessages.length, optimisticFollowUp?.message]);

  useEffect(() => {
    setFollowUp('');
    setFollowUpImages([]);
    setFollowUpError(undefined);
    setDismissedError(undefined);
    setSubmittedTurn(undefined);
  }, [selected?.issueKey]);

  useEffect(() => {
    setFollowUpError(undefined);
    setDismissedError(undefined);
  }, [selected?.model, selected?.provider]);

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
    if (!selected) return;
    if (!followUp.trim() && followUpImages.length === 0) return;
    setLimitStoppedFor(undefined);
    if (selected.conversation?.state === 'running') {
      const message = followUp.trim();
      setSendingFollowUp(true);
      setFollowUpError(undefined);
      setDismissedError(undefined);
      setSubmittedTurn({
        issueKey: selected.issueKey,
        message,
        eventCount: selected.events.length,
        previousResponseText: selected.responseText ?? '',
        suppressPreviousResponse: false,
        images: followUpImages.length ? [...followUpImages] : undefined,
        submittedAt: Date.now()
      });
      setFollowUp('');
      const stagedImages = followUpImages;
      setFollowUpImages([]);
      try {
        await window.praxis.ai.sendConversationMessage(selected.issueKey, {
          participantId: conversationTargetId ?? selected.conversation.currentSpeakerId,
          message,
          ...(stagedImages.length ? { images: stagedImages } : {})
        });
      } catch (error) {
        setSubmittedTurn(undefined);
        setFollowUp(current => current || message);
        setFollowUpImages(stagedImages);
        setFollowUpError(error instanceof Error ? error.message : String(error));
      } finally {
        setSendingFollowUp(false);
      }
      return;
    }
    if (isSingleAgentRunning) {
      let message = followUp.trim();
      if (attachTerminalContext && terminalForContext) {
        try {
          const context = await window.praxis.terminal.getContext(terminalForContext.id);
          if (context.output) {
            const escapeContext = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            message = `<terminal_context cwd="${escapeContext(context.cwd)}" captured_at="${context.capturedAt}">\n${escapeContext(context.output)}\n</terminal_context>\n\n${message}`;
          }
        } catch {
          // ignore terminal context error and proceed to queue
        }
      }
      const stagedImages = followUpImages;
      setQueuedFollowUpsBySession(prev => ({
        ...prev,
        [selected.issueKey]: {
          message,
          images: stagedImages.length ? [...stagedImages] : undefined
        }
      }));
      setFollowUp('');
      setFollowUpImages([]);
      setAttachTerminalContext(false);
      setInflightComposerExpanded(false);
      hadTypedInInflightComposerRef.current = false;
      return;
    }
    if (!isTerminalAgentState(selected.state)) return;
    setSendingFollowUp(true);
    setFollowUpError(undefined);
    setDismissedError(undefined);
    try {
      let message = followUp.trim();
      if (attachTerminalContext) {
        if (!terminalForContext) throw new Error('The selected terminal has no recent output to attach.');
        const context = await window.praxis.terminal.getContext(terminalForContext.id);
        if (!context.output) throw new Error('The selected terminal has no recent output to attach.');
        const escapeContext = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        message = `<terminal_context cwd="${escapeContext(context.cwd)}" captured_at="${context.capturedAt}">\n${escapeContext(context.output)}\n</terminal_context>\n\n${message}`;
      }
      setSubmittedTurn({
        issueKey: selected.issueKey,
        message,
        eventCount: selected.events.length,
        previousResponseText: selected.responseText ?? '',
        suppressPreviousResponse: true,
        images: followUpImages.length ? [...followUpImages] : undefined,
        submittedAt: Date.now()
      });
      setFollowUp('');
      const stagedImages = followUpImages;
      setFollowUpImages([]);
      await window.praxis.ai.continueSession(selected.issueKey, message, stagedImages);
      setAttachTerminalContext(false);
    } catch (error) {
      setSubmittedTurn(undefined);
      setFollowUp(current => current || followUp.trim());
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingFollowUp(false);
    }
  };

  /** Encodes pasted/dropped files into wire attachments, replacing anything already staged beyond the cap. */
  const stageImageFiles = async (files: FileList | File[]) => {
    if (!selected) return;
    const sources = await collectImageFiles(files);
    if (sources.length === 0) return;
    setFollowUpError(undefined);
    try {
      const encoded = await Promise.all(sources.slice(0, MAX_ATTACHED_IMAGES).map(encodeImageAttachment));
      setFollowUpImages(current => [...current, ...encoded].slice(0, MAX_ATTACHED_IMAGES));
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    if (!files.every(file => file.type.toLowerCase().startsWith('image/'))) return;
    event.preventDefault();
    void stageImageFiles(files);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setComposerDragOver(false);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    if (!Array.from(files).every(file => file.type.toLowerCase().startsWith('image/'))) return;
    void stageImageFiles(files);
  };

  const removeFollowUpImage = (index: number) => {
    setFollowUpImages(current => current.filter((_, candidate) => candidate !== index));
  };

  const clearFollowUpImages = () => setFollowUpImages([]);

  const compactContext = async () => {
    if (!selected || !contextCompactionCommand || !isTerminalAgentState(selected.state)) return;
    setSendingFollowUp(true);
    setFollowUpError(undefined);
    setContextPopoverPosition(undefined);
    try {
      const commandName = contextCompactionCommand.name.replace(/^\/+/, '').trim();
      await window.praxis.ai.continueSession(selected.issueKey, `/${commandName}`);
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

  const stopConversation = async () => {
    if (!selected || !conversationRunning) return;
    setAbortingSession(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.stopConversation(selected.issueKey);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setAbortingSession(false);
    }
  };

  const setConversationToolOwner = async (participantId: string) => {
    if (!selected) return;
    try {
      await window.praxis.ai.setConversationToolOwner(selected.issueKey, participantId);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
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
            <div className={`session-console-header${focusMode ? ' session-focus-header' : ''}`}>
              {focusMode ? (
                <SessionFocusTabs
                  sessions={sessions}
                  selectedKey={selected.issueKey}
                  onSelectSession={onSelectSession}
                  onNewSession={onNewSession}
                />
              ) : (
                <>
                  <Icon name="robot" size={14} />
                  <span
                    className="session-console-title"
                    data-testid="session-console-title"
                    title={sessionTitle(selected)}
                  >
                    {sessionLabel(selected)}
                  </span>
                  {selected.state === 'failed' && (
                    <span className="badge badge-blocked" data-testid="session-header-failed-badge" style={{ marginLeft: 6 }}>
                      Failed
                    </span>
                  )}
                </>
              )}
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

            {activeErrorMessage && (
              <div className="session-error-banner" data-testid="session-error-banner">
                <Icon name="warning" size={15} />
                <div className="session-error-banner-content">
                  <div className="session-error-banner-header">
                    <strong className="session-error-banner-title">
                      {isLimit
                        ? (activeErrorMessage.toLowerCase().includes('budget') || activeErrorMessage.toLowerCase().includes('spending')
                            ? 'Provider Limit / Budget Exceeded'
                            : 'Provider Limit / Quota Exceeded')
                        : (isSelectedFailed ? 'Session Failed' : 'Error')}
                    </strong>
                    {isLimit && <span className="badge badge-blocked" style={{ fontSize: '10px' }}>Limit reached</span>}
                  </div>
                  <span className="session-error-banner-message">
                    {activeErrorMessage}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label="Dismiss error"
                  title="Dismiss"
                  data-testid="session-error-banner-dismiss"
                  onClick={() => {
                    setFollowUpError(undefined);
                    if (rawActiveError) {
                      setDismissedError(rawActiveError);
                    }
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}

            <div className="session-chat-scroll" ref={eventsRef} data-testid="session-chat-thread">
              <div className="session-chat-message is-user">
                <div className="session-chat-header">
                  <div className="session-chat-author">You</div>
                  <div className="session-chat-header-actions">
                    {selected.startedAt && (
                      <span
                        className="session-chat-timestamp"
                        title={formatFullDateTime(selected.startedAt)}
                      >
                        {formatMessageTime(selected.startedAt)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm session-chat-copy-btn"
                      aria-label="Copy message text"
                      title={copiedMessageKey === 'user-goal' ? 'Copied!' : 'Copy message text'}
                      onClick={() => copyMessageText('user-goal', selected.taskDefinition.goal)}
                    >
                      <Icon name={copiedMessageKey === 'user-goal' ? 'check' : 'copy'} size={12} />
                    </button>
                  </div>
                </div>
                <div>{selected.taskDefinition.goal}</div>
              </div>
              {conversationEvents.map((event, index) => {
                const terminalContext = event.type === 'user_input_completed' ? parseTerminalContext(event.detail) : undefined;
                const messageKey = `event-${event.timestamp}-${index}`;
                const rawText = event.type === 'message'
                  ? visibleMessageText(event.detail ?? event.summary ?? '')
                  : stripGadgetFences(terminalContext?.message ?? event.detail ?? event.summary ?? '');
                const hasTelemetry = event.type === 'message' && (
                  event.durationMs !== undefined ||
                  event.tokenUsage !== undefined ||
                  event.cost !== undefined ||
                  event.modelId !== undefined ||
                  (event.toolNames && event.toolNames.length > 0)
                );

                return (
                  <div
                    className={`session-chat-message ${event.type === 'message' ? `is-assistant session-chat-participant-${event.speaker?.participantId ?? 'legacy'}${event.speaker ? ` session-chat-provider-${event.speaker.provider}` : ''}` : 'is-user'}`}
                    key={`${event.timestamp}-${index}`}
                    data-testid={event.type === 'message' ? 'session-chat-assistant' : 'session-chat-user'}
                  >
                    <div className="session-chat-header">
                      <div className="session-chat-author">{event.type === 'message'
                        ? event.speaker
                          ? <><Icon name={providerIconName(event.speaker.provider)} size={13} />{`${PROVIDER_LABELS[event.speaker.provider]}${event.speaker.model ? ` · ${event.speaker.model}` : ''}`}</>
                          : 'AI agent'
                        : 'You'}</div>
                      <div className="session-chat-header-actions">
                        {event.timestamp && (
                          <span
                            className="session-chat-timestamp"
                            title={formatFullDateTime(event.timestamp)}
                          >
                            {formatMessageTime(event.timestamp)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm session-chat-copy-btn"
                          aria-label="Copy message text"
                          title={copiedMessageKey === messageKey ? 'Copied!' : 'Copy message text'}
                          onClick={() => copyMessageText(messageKey, rawText)}
                        >
                          <Icon name={copiedMessageKey === messageKey ? 'check' : 'copy'} size={12} />
                        </button>
                      </div>
                    </div>
                    {terminalContext && (
                      <details className="session-chat-terminal-context">
                        <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{terminalContext.cwd}</span></summary>
                        <pre>{terminalContext.output}</pre>
                      </details>
                    )}
                    {event.type === 'message' && event.reasoning && (
                      <details className="session-chat-thought-disclosure" data-testid="session-thought-disclosure">
                        <summary>
                          <Icon name="sparkles" size={12} />
                          <span>Thought process</span>
                        </summary>
                        <div className="session-chat-thought-content">
                          <Markdown text={event.reasoning} testId="session-thought-markdown" imageSessionId={selected?.issueKey} />
                        </div>
                      </details>
                    )}
                    <Markdown
                      text={rawText}
                      testId="session-chat-markdown"
                      imageSessionId={selected?.issueKey}
                    />
                    {event.type === 'user_input_completed' && <TranscriptAttachments attachments={event.attachments} />}
                    {/* Whatever this message asked for, rendered where it was
                        asked rather than pooled at the bottom of the thread. */}
                    <GadgetBlockList
                      blocks={gadgetBlocks[gadgetMessageKey(index)] ?? []}
                      busyGadgetId={busyGadgetId}
                      results={gadgetResults}
                      onSubmit={(gadgetId, actionId, value) => void submitGadgetAction(gadgetId, actionId, value)}
                    />
                    {hasTelemetry && (
                      <div className="session-chat-telemetry-bar" data-testid="session-chat-telemetry">
                        {event.durationMs !== undefined && (
                          <span className="session-telemetry-chip" title={`Turn duration: ${(event.durationMs / 1000).toFixed(1)}s`}>
                            <Icon name="zap" size={11} />
                            <span>{formatElapsedDuration(event.durationMs)}</span>
                          </span>
                        )}
                        {event.tokenUsage && (
                          <span
                            className="session-telemetry-chip"
                            title={`Input: ${(event.tokenUsage.inputTokens ?? 0).toLocaleString()} tokens${event.tokenUsage.cachedInputTokens ? ` (${event.tokenUsage.cachedInputTokens.toLocaleString()} cached)` : ''} · Output: ${(event.tokenUsage.outputTokens ?? 0).toLocaleString()} tokens${event.tokenUsage.reasoningTokens ? ` (${event.tokenUsage.reasoningTokens.toLocaleString()} reasoning)` : ''}`}
                          >
                            <Icon name="sparkles" size={11} />
                            <span>{(event.tokenUsage.totalTokens ?? ((event.tokenUsage.inputTokens ?? 0) + (event.tokenUsage.outputTokens ?? 0))).toLocaleString()} tok</span>
                          </span>
                        )}
                        {event.cost && event.cost.amount > 0 && (
                          <span className="session-telemetry-chip" title="Estimated turn cost">
                            <span>{formatCost(event.cost) ?? `${event.cost.amount.toFixed(4)} ${event.cost.currency}`}</span>
                          </span>
                        )}
                        {event.modelId && (
                          <span className="session-telemetry-chip" title={`Model: ${event.modelId}`}>
                            <Icon name="robot" size={11} />
                            <span>{event.modelId}</span>
                          </span>
                        )}
                        {event.toolNames && event.toolNames.length > 0 && (
                          <button
                            type="button"
                            className="session-telemetry-chip is-clickable"
                            title="View tool execution details in Activity tab"
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent('praxis:session-tab', { detail: { tab: 'activity' } }));
                            }}
                          >
                            <Icon name="tools" size={11} />
                            <span>{event.toolNames.length} tool {event.toolNames.length === 1 ? 'call' : 'calls'}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {optimisticFollowUp?.suppressPreviousResponse && (
                <div
                  className="session-chat-message is-user"
                  data-testid="session-chat-user"
                  data-pending="true"
                >
                  <div className="session-chat-header">
                    <div className="session-chat-author">You</div>
                    <div className="session-chat-header-actions">
                      <span className="session-chat-timestamp">Just now</span>
                    </div>
                  </div>
                  {optimisticTerminalContext && (
                    <details className="session-chat-terminal-context">
                      <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{optimisticTerminalContext.cwd}</span></summary>
                      <pre>{optimisticTerminalContext.output}</pre>
                    </details>
                  )}
                  <Markdown
                    text={stripGadgetFences(optimisticTerminalContext?.message ?? optimisticFollowUp.message)}
                    testId="session-chat-markdown"
                    imageSessionId={selected?.issueKey}
                  />
                  {optimisticFollowUp.images?.length
                    ? <TranscriptAttachments attachments={optimisticFollowUp.images} />
                    : null}
                </div>
              )}
              {shouldRenderResponseFallback && (
                <div className="session-chat-message is-assistant session-chat-participant-legacy" data-testid="session-response">
                  <div className="session-chat-header">
                    <div className="session-chat-author">{selected?.conversation?.state === 'running'
                      ? (() => { const speaker = selected.conversation.participants.find(participant => participant.id === selected.conversation?.currentSpeakerId); return speaker ? <><Icon name={providerIconName(speaker.provider)} size={13} />{`${PROVIDER_LABELS[speaker.provider]}${speaker.model ? ` · ${speaker.model}` : ''}`}</> : 'AI agent'; })()
                      : 'AI agent'}</div>
                    <div className="session-chat-header-actions">
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-chat-copy-btn"
                        aria-label="Copy message text"
                        title={copiedMessageKey === 'fallback-response' ? 'Copied!' : 'Copy message text'}
                        onClick={() => copyMessageText('fallback-response', visibleResponseText)}
                      >
                        <Icon name={copiedMessageKey === 'fallback-response' ? 'check' : 'copy'} size={12} />
                      </button>
                    </div>
                  </div>
                  <Markdown text={visibleResponseText} testId="session-chat-markdown" imageSessionId={selected?.issueKey} />
                </div>
              )}
              {livePendingConversationMessages.map((pending, index) => (
                <div
                  className="session-chat-message is-user"
                  key={`pending-${pending.participantId}-${index}-${pending.message}`}
                  data-testid="session-chat-user"
                  data-pending="true"
                >
                  <div className="session-chat-author">You</div>
                  <Markdown text={stripGadgetFences(pending.message)} testId="session-chat-markdown" imageSessionId={selected?.issueKey} />
                </div>
              ))}
              {isTurnActive && !visibleResponseText ? (
                <LiveTurnActivityIndicator
                  startedAt={activeTurnStartedAt}
                  statusText={liveActivityText ?? 'Thinking…'}
                  provider={activityProvider}
                />
              ) : (
                !visibleResponseText && conversationEvents.length === 0 && !isSelectedFailed && (
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
                      {pendingPermission.data?.toolName && (
                        <span
                          className="session-permission-tool"
                          role="img"
                          tabIndex={0}
                          aria-label={`Tool: ${pendingPermission.data.toolName}`}
                          data-tooltip={`Tool: ${pendingPermission.data.toolName}`}
                          data-testid="session-permission-tool"
                        >
                          <Icon name="info" size={13} />
                        </span>
                      )}
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
              {(!usageHidden || usageClosing) && (
                <div
                  className={`session-usage-wrapper${usageClosing ? ' is-closing' : ''}`}
                  data-testid="session-usage-wrapper"
                >
                  <SessionUsageSummary
                    session={selected}
                    sessions={sessions}
                    spendLimit={settings?.ai.spendLimit ?? 0}
                    onHide={handleHideUsage}
                  />
                </div>
              )}
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
              <div
                className={`composer session-follow-up-composer${composerDragOver ? ' is-drag-over' : ''}`}
                onPaste={handleComposerPaste}
                onDragOver={event => {
                  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
                  event.preventDefault();
                  setComposerDragOver(true);
                }}
                onDragLeave={event => {
                  if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                  setComposerDragOver(false);
                }}
                onDrop={handleComposerDrop}
              >
                {/* The session's AI ran out: carry on with another AI, or stop. A workflow stage's run offers this itself. */}
                {isLimit && !isDismissed && !selected.conversation && !isWorkflowStageSession(selected) &&
                  limitStoppedFor !== selected.issueKey && (
                  <SessionLimitSwitch
                    session={selected}
                    onStop={() => {
                      setFollowUpError(undefined);
                      if (rawActiveError) setDismissedError(rawActiveError);
                      setLimitStoppedFor(selected.issueKey);
                    }}
                  />
                )}
                {followUpImages.length > 0 && (
                  <div className="session-image-attachments" data-testid="session-image-attachments">
                    {followUpImages.map((image, index) => (
                      <span className="session-image-chip" key={`${index}-${image.dataBase64.length}`} data-testid="session-image-chip">
                        <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt="" />
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label={`Remove image ${index + 1}`}
                          onClick={() => removeFollowUpImage(index)}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    ))}
                    <span className="session-image-hint">{followUpImages.length}/{MAX_ATTACHED_IMAGES}</span>
                  </div>
                )}
                {isTerminalAgentState(selected.state) && !conversationRunning && !isWorkflowStageSession(selected) && (
                  <div className="session-mode-panel" data-testid="session-mode-panel">
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
                    <div className="session-mode-panel-meta">
                      {usageHidden && (
                        <button
                          type="button"
                          className="composer-chip session-runtime-chip session-restore-usage-btn"
                          data-testid="session-restore-usage-btn"
                          title="Show usage bar"
                          onClick={() => toggleUsageHidden(false)}
                        >
                          <Icon name="graph" size={14} />
                          <span className="session-runtime-chip-label">Usage</span>
                        </button>
                      )}
                      <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-tool-mode" title="Tool access for this session — fixed when it started">
                        <Icon name={selected.toolMode === 'full' ? 'tools' : 'search'} size={14} />
                        <span className="session-runtime-chip-label">
                          {selected.toolMode === 'project-only' ? 'Project only' : selected.toolMode === 'read-only' ? 'Read only' : 'Full tools'}
                        </span>
                      </span>
                      {selected.workingDirectory && (
                        <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-working-directory" title={selected.workingDirectory}>
                          <Icon name="folder" size={14} />
                          <span className="session-runtime-chip-label">{basename(selected.workingDirectory)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                )}
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
                  ref={followUpTextareaRef}
                  className={`composer-input session-follow-up-input${followUpCollapsed ? ' is-collapsed' : ''}`}
                  rows={1}
                  data-testid="session-follow-up-input"
                  value={followUp}
                  disabled={followUpCollapsed || sendingFollowUp}
                  placeholder={
                    conversationRunning
                      ? 'Message the selected AI…'
                      : isSingleAgentRunning
                        ? 'Queue follow-up (sends automatically when done)…'
                        : isTerminalAgentState(selected.state)
                          ? 'Ask the agent to clarify, change, or continue…'
                          : 'The agent is working…'
                  }
                  onChange={event => {
                    const val = event.target.value;
                    setFollowUp(val);
                    if (followUpError) setFollowUpError(undefined);
                    if (isSingleAgentRunning && inflightComposerExpanded) {
                      if (!val.trim() && followUpImages.length === 0 && hadTypedInInflightComposerRef.current) {
                        setInflightComposerExpanded(false);
                        hadTypedInInflightComposerRef.current = false;
                      } else if (val.trim()) {
                        hadTypedInInflightComposerRef.current = true;
                      }
                    }
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape' && isSingleAgentRunning && inflightComposerExpanded) {
                      event.preventDefault();
                      setInflightComposerExpanded(false);
                      hadTypedInInflightComposerRef.current = false;
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey && (followUp.trim() || followUpImages.length > 0)) {
                      event.preventDefault();
                      void sendFollowUp();
                    }
                  }}
                />
              <div className="composer-controls">
                {isSingleAgentRunning ? (
                  followUpCollapsed ? (
                    <>
                      {liveActivityText && (
                        <span className="composer-chip session-runtime-chip is-readonly session-activity-chip" data-testid="session-composer-activity-chip">
                          {activityProvider ? (
                            <Icon
                              name={providerIconName(activityProvider)}
                              size={13}
                              className={`session-activity-icon session-activity-icon-${activityProvider}`}
                            />
                          ) : (
                            <span className="session-activity-dot" aria-hidden="true" />
                          )}
                          {liveActivityText}
                        </span>
                      )}
                      <span className="spacer" />
                      {activeQueuedMessage ? (
                        <span
                          className="composer-chip session-runtime-chip is-queued"
                          data-testid="session-queued-pill"
                          title="Click to edit or cancel queued message"
                        >
                          <Icon name="sparkles" size={13} />
                          <span
                            className="session-runtime-chip-label"
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              setFollowUp(activeQueuedMessage.message);
                              if (activeQueuedMessage.images?.length) {
                                setFollowUpImages(activeQueuedMessage.images);
                              }
                              setQueuedFollowUpsBySession(prev => {
                                const next = { ...prev };
                                delete next[selected.issueKey];
                                return next;
                              });
                              setInflightComposerExpanded(true);
                              hadTypedInInflightComposerRef.current = true;
                              setTimeout(() => followUpTextareaRef.current?.focus(), 50);
                            }}
                          >
                            Queued: {activeQueuedMessage.message.length > 32 ? `${activeQueuedMessage.message.slice(0, 32)}…` : activeQueuedMessage.message}
                          </span>
                          <button
                            type="button"
                            className="icon-btn icon-btn-sm"
                            style={{ marginLeft: 3 }}
                            aria-label="Cancel queued message"
                            title="Cancel queued message"
                            onClick={e => {
                              e.stopPropagation();
                              setQueuedFollowUpsBySession(prev => {
                                const next = { ...prev };
                                delete next[selected.issueKey];
                                return next;
                              });
                            }}
                          >
                            <Icon name="close" size={11} />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="composer-chip session-ask-button"
                          data-testid="session-composer-ask-btn"
                          title="Queue a follow-up message while the agent is working"
                          onClick={() => {
                            setInflightComposerExpanded(true);
                            hadTypedInInflightComposerRef.current = false;
                            setTimeout(() => followUpTextareaRef.current?.focus(), 50);
                          }}
                        >
                          <Icon name="chats" size={13} />
                          <span>Ask</span>
                        </button>
                      )}
                      <button
                        className="composer-send composer-send-cancel"
                        aria-label="Cancel response"
                        title={abortingSession ? 'Cancelling…' : 'Cancel response'}
                        data-testid="session-follow-up-send"
                        disabled={abortingSession}
                        onClick={() => void abortSession()}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      {liveActivityText && (
                        <span className="composer-chip session-runtime-chip is-readonly session-activity-chip" data-testid="session-composer-activity-chip">
                          {activityProvider ? (
                            <Icon
                              name={providerIconName(activityProvider)}
                              size={13}
                              className={`session-activity-icon session-activity-icon-${activityProvider}`}
                            />
                          ) : (
                            <span className="session-activity-dot" aria-hidden="true" />
                          )}
                          {liveActivityText}
                        </span>
                      )}
                      {selected.acpAvailableModes && selected.acpAvailableModes.length > 0 && (
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
                      <span className="spacer" />
                      <button
                        className="composer-send composer-send-cancel"
                        aria-label="Cancel response"
                        title={abortingSession ? 'Cancelling…' : 'Cancel response'}
                        data-testid="session-follow-up-cancel"
                        disabled={abortingSession}
                        onClick={() => void abortSession()}
                      >
                        <Icon name="close" size={15} />
                      </button>
                      <button
                        className="composer-send"
                        aria-label="Queue follow-up"
                        title="Queue next message (sends automatically when done)"
                        data-testid="session-follow-up-send"
                        disabled={abortingSession || sendingFollowUp || (!followUp.trim() && followUpImages.length === 0)}
                        onClick={() => void sendFollowUp()}
                      >
                        <Icon name="arrow-up" size={15} />
                      </button>
                    </>
                  )
                ) : (
                  <>
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
                    {workflowOwnsRuntime && activeWorkflowRun && (
                      <WorkflowManagedRuntimeChip
                        run={activeWorkflowRun}
                        stage={activeWorkflowStage}
                        stageSession={activeWorkflowStageSession}
                      />
                    )}
                    {!workflowOwnsRuntime && selected.provider && (selected.workflowRole === 'stage' ? (
                      <span
                        className="composer-chip session-runtime-chip is-readonly"
                        data-testid="session-provider"
                        title="This workflow stage's AI provider is fixed"
                      >
                        <Icon name={providerIconName(selected.provider)} size={14} />
                        {PROVIDER_LABELS[selected.provider]}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`composer-chip session-runtime-chip${transitionPopover?.open === 'handover' ? ' active' : ''}`}
                        data-testid="session-provider"
                        title={!conversationRunning && canChangeSessionRuntime(selected) ? 'Choose an AI provider' : "This session's AI provider"}
                        aria-haspopup="listbox"
                        aria-expanded={transitionPopover?.open === 'handover'}
                        disabled={!conversationRunning && !canChangeSessionRuntime(selected)}
                        onClick={event => {
                          if (transitionPopover?.open === 'handover') {
                            setTransitionPopover(undefined);
                            return;
                          }
                          const rect = event.currentTarget.getBoundingClientRect();
                          setConversationPopoverPosition(undefined);
                          setTransitionPopover({ open: 'handover', position: { bottom: window.innerHeight - rect.top + 6, left: rect.left } });
                        }}
                      >
                        <Icon name={providerIconName(selected.provider)} size={14} />
                        {PROVIDER_LABELS[selected.provider]}
                      </button>
                    ))}
                    {!workflowOwnsRuntime && selected.provider && (() => {
                      const contextLimit = selected.model
                        ? selected.contextLimit ?? getKnownContextLength(selected.model, selected.provider)
                        : undefined;
                      const contextSize = formatContextLength(contextLimit);
                      const pricing = getModelPricing(selected.provider, selected.model);
                      const cost = formatModelCost(pricing);
                      return selected.workflowRole === 'stage' ? (
                        <span
                          className="composer-chip session-runtime-chip is-readonly"
                          data-testid="session-model"
                          title="This workflow stage's AI model is fixed"
                        >
                          <Icon name="sparkles" size={14} />
                          <span>{selected.model ?? 'Provider default'}</span>
                          {contextSize && <span className="composer-chip-meta">{contextSize}</span>}
                          {cost && <span className="composer-chip-meta">{cost}</span>}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`composer-chip session-runtime-chip${transitionPopover?.open === 'model' ? ' active' : ''}`}
                          data-testid="session-model"
                          title={!conversationRunning && canChangeSessionRuntime(selected) ? 'Change the model for the next turn' : "This session's AI model"}
                          aria-haspopup="listbox"
                          aria-expanded={transitionPopover?.open === 'model'}
                          disabled={conversationRunning || !canChangeSessionRuntime(selected)}
                          onClick={event => {
                            if (transitionPopover?.open === 'model') {
                              setTransitionPopover(undefined);
                              return;
                            }
                            const rect = event.currentTarget.getBoundingClientRect();
                            setConversationPopoverPosition(undefined);
                            setTransitionPopover({ open: 'model', position: { bottom: window.innerHeight - rect.top + 6, left: rect.left } });
                          }}
                        >
                          <Icon name="sparkles" size={14} />
                          <span>{selected.model ?? 'Model'}</span>
                          {contextSize && <span className="composer-chip-meta">{contextSize}</span>}
                          {cost && <span className="composer-chip-meta">{cost}</span>}
                        </button>
                      );
                    })()}
                    <SessionConversationActions
                      session={selected}
                      onStop={() => void stopConversation()}
                      onToolOwner={participantId => void setConversationToolOwner(participantId)}
                      targetId={conversationTargetId}
                      onTargetChange={setConversationTargetId}
                    />
                    {selected.worktreeBranch && (
                      <span
                        className="composer-chip session-runtime-chip is-readonly"
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
                    <SessionWorkflowControl
                      session={selected}
                      runs={selectedWorkflowRuns}
                      options={workflowOptions}
                      onStartWorkflow={onStartWorkflow}
                      onSelectWorkflowRun={onSelectWorkflowRun}
                      onRemoveWorkflowRun={onRemoveWorkflowRun}
                      onError={setFollowUpError}
                    />
                    {context && (
                      <button
                        ref={contextChipRef}
                        type="button"
                        className={`session-context-chip is-${context.level}${contextPopoverPosition ? ' active' : ''}`}
                        aria-label={`Context usage: ${context.percent}% used`}
                        aria-haspopup="dialog"
                        aria-expanded={Boolean(contextPopoverPosition)}
                        aria-controls="session-context-popover"
                        title={`${context.percent}% of context used`}
                        data-testid="session-context-chip"
                        onClick={() => {
                          if (contextPopoverPosition) {
                            setContextPopoverPosition(undefined);
                            return;
                          }
                          const rect = contextChipRef.current?.getBoundingClientRect();
                          if (rect) {
                            setTransitionPopover(undefined);
                            setConversationPopoverPosition(undefined);
                            setContextPopoverPosition({
                              bottom: window.innerHeight - rect.top + 6,
                              left: rect.right - 300
                            });
                          }
                        }}
                      >
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <circle className="session-context-ring-track" cx="10" cy="10" r="7.5" />
                          <circle
                            className="session-context-ring-value"
                            cx="10"
                            cy="10"
                            r="7.5"
                            pathLength="100"
                            strokeDasharray={`${context.percent} ${100 - context.percent}`}
                          />
                        </svg>
                      </button>
                    )}
                    <button
                      className={`composer-send${!isTerminalAgentState(selected.state) ? ' composer-send-cancel' : ''}`}
                      aria-label={conversationRunning ? 'Stop conversation' : !isTerminalAgentState(selected.state) ? 'Cancel response' : sendingFollowUp ? 'Sending message' : 'Send message'}
                      title={conversationRunning ? (abortingSession ? 'Stopping…' : 'Stop conversation') : !isTerminalAgentState(selected.state) ? (abortingSession ? 'Cancelling…' : 'Cancel response') : sendingFollowUp ? 'Sending…' : 'Send message'}
                      data-testid="session-follow-up-send"
                      disabled={abortingSession || (!conversationRunning && isTerminalAgentState(selected.state) && (sendingFollowUp || (!followUp.trim() && followUpImages.length === 0)))}
                      onClick={() => {
                        if (conversationRunning) {
                          void stopConversation();
                        } else if (!isTerminalAgentState(selected.state)) {
                          void abortSession();
                        } else {
                          void sendFollowUp();
                        }
                      }}
                    >
                      <Icon name={conversationRunning || !isTerminalAgentState(selected.state) ? 'close' : 'arrow-up'} size={15} />
                    </button>
                    {conversationRunning && (
                      <button
                        type="button"
                        className="composer-send composer-send-directed"
                        aria-label="Send message to selected AI"
                        title="Send this message to the selected AI"
                        data-testid="session-conversation-send"
                        disabled={abortingSession || sendingFollowUp || (!followUp.trim() && followUpImages.length === 0)}
                        onClick={() => void sendFollowUp()}
                      >
                        <Icon name="arrow-up" size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
              </div>
              {context && contextPopoverPosition && createPortal(
                <div
                  ref={contextPopoverRef}
                  id="session-context-popover"
                  className={`composer-provider-menu session-context-popover is-${context.level}`}
                  role="dialog"
                  aria-label="Context usage details"
                  data-testid="session-context"
                  style={{
                    position: 'fixed',
                    bottom: contextPopoverPosition.bottom,
                    left: Math.max(12, Math.min(contextPopoverPosition.left, window.innerWidth - 312))
                  }}
                >
                  <div className="session-context-header">
                    <div className="composer-context-heading">
                      <Icon name={context.level === 'critical' ? 'warning' : context.level === 'warn' ? 'zap' : 'info'} size={13} />
                      <span data-testid="session-context-figure">{context.percent}% of {Math.round(context.limit / 1000)}k context used</span>
                    </div>
                    {canCompactContext && (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm session-context-compact"
                        aria-label="Compact context"
                        title="Compact context"
                        data-testid="session-context-compact"
                        onClick={() => void compactContext()}
                      >
                        <Icon name="compress" size={13} />
                      </button>
                    )}
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
                      : context.level === 'warn'
                        ? 'This conversation is filling the model’s window. Long tool output is the usual cause.'
                        : 'There is plenty of room for the next turn in this model’s context window.'}
                  </p>
                </div>,
                document.body
              )}
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
          open={transitionPopover?.open}
          position={transitionPopover?.position}
          onClose={() => setTransitionPopover(undefined)}
          onAddProvider={provider => {
            const position = transitionPopover?.position;
            setTransitionPopover(undefined);
            setConversationPopoverPosition(position);
            setConversationTargetId(undefined);
            setConversationInitialProvider(provider);
          }}
        />
      )}
      {selected && <SessionConversationDialog session={selected} open={Boolean(conversationPopoverPosition)} position={conversationPopoverPosition} initialProvider={conversationInitialProvider} onClose={() => { setConversationPopoverPosition(undefined); setConversationInitialProvider(undefined); }} />}
    </div>
  );
}
