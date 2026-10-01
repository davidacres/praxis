import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentSessionRecord,
  Board,
  BoardDetails,
  Connection,
  ConnectionCheck,
  ProjectDocument,
  ProjectRecord,
  WorkflowRunSummary,
  WorkspaceRecord
} from '@praxis/core';
import { agentStateLabel, agentStateLaneClass, isTerminalAgentState } from '../ai/aiSessionState';
import { formatElapsed, formatTokens, isConversationSession, isSynthesizedKey, isTicketReviewKey, isWorkflowStageSession, sessionTitle } from '../ai/sessionNav';
import { providerLabel } from '../ai/modelProviders';
import { boardTypeIcon, boardTypeLabel, resolveBackendMode, statusTone } from '../board/boardMeta';
import { BrandModeIcon } from '../ui/BrandModeIcon';
import { ConnectionStatusDot } from '../ui/ConnectionStatusDot';
import { Icon, type IconName } from '../ui/Icon';
import { IssuePeek } from '../issues/IssuePeek';
import { projectColorValue } from '../projects/projectColors';
import { useSettings } from '../settings/useSettings';
import { useDialogs } from '../ui/dialogs';
import { useResizable } from './useResizable';
import { WorkModeView } from '../projects/WorkModeView';

export type SidebarMode = 'classic' | 'work';

const RUN_STATUS_TONE: Record<WorkflowRunSummary['status'], string> = {
  running: 'lane--running',
  'awaiting-approval': 'lane--awaiting',
  succeeded: 'lane--done',
  failed: 'lane--failed',
  cancelled: 'lane--skipped'
};

export type FeatureId =
  | 'overview'
  | 'conversations'
  | 'sessions'
  | 'connections'
  | 'agents'
  | 'workflows'
  | 'git'
  | 'run'
  | 'deployments';

interface FeatureDef {
  id: FeatureId;
  label: string;
  icon: IconName;
}

/**
 * The bottom block, in the same idiom as the reference "Customizations" list:
 * glyph, label, right-aligned count. These are the Praxis surfaces that
 * are not boards.
 */
const FEATURES: FeatureDef[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'conversations', label: 'Conversations', icon: 'chats' },
  { id: 'connections', label: 'Connections', icon: 'plug' },
];

export interface SidebarProps {
  boards: Board[];
  projects: ProjectRecord[];
  connections: Connection[];
  /** Latest health check per connection id; undefined entries are still checking. */
  connectionChecks: Record<string, ConnectionCheck | undefined>;
  selectedBoardId: string | undefined;
  detailsByBoardId: Record<string, BoardDetails | undefined>;
  onSelectBoard: (board: Board) => void;
  onSelectIssue: (board: Board, issueKey: string) => void;
  mode: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  activeFeature: FeatureId | undefined;
  activeGitView?: 'graph' | 'changes' | 'conflicts';
  onSelectFeature: (feature: FeatureId) => void;
  featureCounts: Partial<Record<FeatureId, number>>;
  onNewSession: (project?: ProjectRecord) => void;
  /** Opens the lightweight "New conversation" composer (FX-BE-142). */
  onNewConversation: () => void;
  onNewProject: () => void;
  /** Opens the bulk "import plans folders as projects" wizard. */
  onImportProjects?: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  onOpenProjectDocument: (project: ProjectRecord, document: ProjectDocument) => void;
  onSelectGit: (project: ProjectRecord, view: 'graph' | 'changes' | 'conflicts') => void;
  /** Agent sessions, rendered as children of the Sessions row. */
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  onSelectSession: (issueKey: string) => void;
  onRenameSession: (issueKey: string, title: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
  /** Archives or restores a session; archived sessions leave the active tree. */
  onArchiveSession: (issueKey: string, archived: boolean) => Promise<void>;
  /** Saved workflows per project id, for the Workflows tree section. */
  projectWorkflows: Record<string, Array<{ id: string; name: string }>>;
  activeWorkflowId?: string;
  /** Each project's runs, newest first — the children of its Runs node. */
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  /** The run open in the run workspace, highlighted in the tree. */
  activeWorkflowRunId?: string;
  activeWorkflowPolicies?: boolean;
  onSelectWorkflow: (project: ProjectRecord, workflowId: string) => void;
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onSelectWorkflowRuns?: (project: ProjectRecord) => void;
  /** Opens the start-run dialog for the selected workflow. */
  onStartWorkflowRun: (project: ProjectRecord, workflowId?: string) => void;
  onCancelWorkflowRun: (runId: string) => void | Promise<void>;
  onDeleteWorkflowRun: (project: ProjectRecord, run: WorkflowRunSummary) => void;
  onArchiveWorkflowRun?: (runId: string, archived: boolean) => Promise<void>;
  onSelectWorkflowPolicies: (project: ProjectRecord) => void;
  /** Opens the project's Run profile editor (FX-BE-054). */
  onSelectRun: (project: ProjectRecord) => void;
  /** Opens the project's deployment profiles (FX-BE-059 / FX-BE-060). */
  onSelectDeployments: (project: ProjectRecord) => void;
  /** Whether the experimental Deployments feature is enabled in preview settings. */
  enableDeployments?: boolean;
  onNewWorkflow: (project: ProjectRecord) => void;
  onDeleteWorkflow?: (project: ProjectRecord, workflowId: string) => void;
  onDeleteBoard: (board: Board) => void;
  /**
   * Removes a board from a project's own `linkedBoards` — distinct from
   * `onDeleteBoard`, which deletes/untracks a board's underlying connection
   * (and refuses when that connection belongs to *some* project, since
   * deleting it would delete that project's own board). A linked board
   * routinely belongs to another project's connection by design, so it must
   * go through `unlinkBoard` instead or that guard silently no-ops it.
   */
  onUnlinkBoard: (project: ProjectRecord, connectionId: string, boardId: string) => void;
  onConfigureBoard: (board: Board) => void;
  selectedProjectId?: string;
  /** Selected issue for the peek card pinned above the footer (classic mode). */
  selectedIssueKey?: string;
  selectedIssueConnectionId?: string;
  /** Saved workspaces and the active-workspace switcher. */
  workspaces?: WorkspaceRecord[];
  activeWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onSaveWorkspace?: () => void;
  onOpenWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  searching?: boolean;
  query?: string;
  onQueryChange?: (query: string) => void;
  onToggleSearch?: () => void;
}

function ProjectSessionRow({
  session,
  active,
  kind,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onArchiveSession
}: {
  session: AgentSessionRecord;
  active: boolean;
  kind: 'general' | 'ticket';
  onSelectSession: (issueKey: string) => void;
  onRenameSession: (issueKey: string, title: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
  onArchiveSession: (issueKey: string, archived: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => sessionTitle(session));
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const { confirmChoice } = useDialogs();
  const title = sessionTitle(session);
  const agentName = session.agentId || (session.provider ? providerLabel(session.provider) : undefined) || 'AI agent';
  const agentNames = Array.from(new Set([
    agentName,
    ...(session.conversation?.participants.map(participant => participant.displayLabel) ?? []),
    ...(session.runtimeEpochs?.map(epoch => epoch.provider ? providerLabel(epoch.provider) : undefined).filter(Boolean) ?? [])
  ]));
  const agentDisplay = agentNames.join(' + ');
  const modelName = session.model || session.runtimeEpochs?.[session.runtimeEpochs.length - 1]?.model;
  const elapsed = formatElapsed(session.startedAt, session.completedAt);
  const tokens = formatTokens(session.tokenUsage);

  const commitRename = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) return;
    setMutating(true);
    setError(undefined);
    try {
      await onRenameSession(session.issueKey, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const archive = async () => {
    setMutating(true);
    setError(undefined);
    try {
      await onArchiveSession(session.issueKey, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const remove = async () => {
    const choice = await confirmChoice({
      title: 'Delete this session?',
      message: 'This can’t be undone.',
      confirmLabel: 'Delete session',
      tertiaryLabel: 'Archive instead',
      danger: true
    });
    if (choice === 'cancel') return;
    if (choice === 'tertiary') {
      await archive();
      return;
    }
    setMutating(true);
    setError(undefined);
    try {
      await onDeleteSession(session.issueKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="project-session-entry">
      <div
        className={`tree-row session-nav-row${active ? ' active' : ''}`}
        data-testid="project-session-nav-item"
        title={title}
        role="button"
        tabIndex={0}
        onClick={() => !editing && onSelectSession(session.issueKey)}
        onKeyDown={event => {
          if (!editing && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onSelectSession(session.issueKey);
          }
        }}
      >
        <span className="tree-icon" title={kind === 'ticket' ? 'Ticket session' : 'General chat session'}><Icon name={kind === 'ticket' ? 'ticket' : 'chats'} size={13} /></span>
        {!editing && <span className={`session-state-mark ${agentStateLaneClass(session.state)}`} aria-label={agentStateLabel(session.state)} title={agentStateLabel(session.state)} />}
        {editing ? (
          <input
            className="session-title-input"
            data-testid="session-title-input"
            aria-label={`Session title for ${title}`}
            value={draft}
            disabled={mutating}
            autoFocus
            onClick={event => event.stopPropagation()}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="tree-label" data-testid="session-title">{title}</span>
        )}
        {!editing && (
          <>
            <span
              className="session-inline-telemetry"
              data-testid="project-session-agent-summary"
              title={`${agentDisplay}${modelName ? ` · ${modelName}` : ''} · ${agentStateLabel(session.state)} · ${elapsed ?? 'Time not available'} · ${tokens ?? 'Tokens not reported'}`}
            >{agentDisplay}{modelName ? ` · ${modelName}` : ''} · {agentStateLabel(session.state)} · {elapsed ?? '—'} · {tokens ?? '—'}</span>
            <span className="session-nav-actions">
              <button
                className="icon-btn icon-btn-sm"
                aria-label={`Rename session ${title}`}
                title="Rename session"
                data-testid="session-rename-btn"
                disabled={mutating}
                onClick={event => {
                  event.stopPropagation();
                  setEditing(true);
                  setDraft(title);
                }}
              ><Icon name="pencil" size={12} /></button>
              <button
                className="icon-btn icon-btn-sm"
                aria-label={`Archive session ${title}`}
                title="Archive session"
                data-testid="session-archive-btn"
                disabled={mutating}
                onClick={event => {
                  event.stopPropagation();
                  void archive();
                }}
              ><Icon name="archive" size={12} /></button>
              <button
                className="icon-btn icon-btn-sm"
                aria-label={`Delete session ${title}`}
                title="Delete session"
                data-testid="session-delete-btn"
                disabled={mutating}
                onClick={event => {
                  event.stopPropagation();
                  void remove();
                }}
              ><Icon name="trash" size={12} /></button>
            </span>
          </>
        )}
      </div>
      {error && <div className="error-banner session-list-error" data-testid="project-session-row-error">{error}</div>}
    </div>
  );
}

const RUN_STATUS_LABEL: Record<WorkflowRunSummary['status'], string> = {
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

function stageLaneLabel(lane: WorkflowRunSummary['stages'][number]['lane']): string {
  return lane === 'done'
    ? 'Complete'
    : lane === 'running'
      ? 'Running'
      : lane === 'awaiting'
        ? 'Awaiting approval'
        : lane === 'failed'
          ? 'Failed'
          : lane === 'paused'
            ? 'Paused'
            : lane === 'skipped'
              ? 'Skipped'
              : lane === 'ready'
                ? 'Ready'
                : 'Pending';
}

function stageLaneIcon(lane: WorkflowRunSummary['stages'][number]['lane']): IconName {
  return lane === 'done'
    ? 'check-square'
    : lane === 'failed'
      ? 'warning'
      : lane === 'running'
        ? 'play'
        : lane === 'awaiting' || lane === 'paused'
          ? 'clock'
          : lane === 'skipped'
            ? 'close'
          : 'dot';
}

type AutomationRailItem =
  | { kind: 'stage'; stage: WorkflowRunSummary['stages'][number] }
  | { kind: 'overflow'; count: number; key: string };

function activeAutomationStageIndex(run: WorkflowRunSummary): number {
  const active = run.stages.findIndex(stage => ['running', 'awaiting', 'paused', 'failed', 'ready'].includes(stage.lane));
  if (active >= 0) return active;
  const completed = run.stages.reduce((latest, stage, index) => stage.lane === 'done' ? index : latest, -1);
  return Math.max(0, completed);
}

/** At sidebar width, preserve the beginning, end and current neighbourhood instead of shrinking or scrolling. */
function automationRailItems(run: WorkflowRunSummary): AutomationRailItem[] {
  if (run.stages.length <= 12) return run.stages.map(stage => ({ kind: 'stage', stage }));
  const current = activeAutomationStageIndex(run);
  const indices = new Set<number>([0, run.stages.length - 1]);
  for (let index = current - 3; index <= current + 4; index += 1) {
    if (index >= 0 && index < run.stages.length) indices.add(index);
  }
  const sorted = [...indices].sort((a, b) => a - b);
  const items: AutomationRailItem[] = [];
  sorted.forEach((index, position) => {
    const previous = sorted[position - 1];
    if (previous !== undefined && index - previous > 1) {
      items.push({ kind: 'overflow', count: index - previous - 1, key: `${previous}-${index}` });
    }
    items.push({ kind: 'stage', stage: run.stages[index] });
  });
  return items;
}

function automationStageSession(stage: WorkflowRunSummary['stages'][number], sessions: AgentSessionRecord[]): AgentSessionRecord | undefined {
  return stage.sessionKey ? sessions.find(session => session.issueKey === stage.sessionKey) : undefined;
}

function automationStageMeta(stage: WorkflowRunSummary['stages'][number], sessions: AgentSessionRecord[]): string {
  const session = automationStageSession(stage, sessions);
  const agent = session?.agentId || (session?.provider ? providerLabel(session.provider) : undefined) || (stage.provider ? providerLabel(stage.provider) : undefined) || 'AI agent';
  const model = session?.model || stage.chosenModel;
  const duration = session ? formatElapsed(session.startedAt, session.completedAt) : (stage.durationMs !== undefined ? `${Math.round(stage.durationMs / 1000)}s` : undefined);
  const tokens = session ? formatTokens(session.tokenUsage) : undefined;
  return [agent, model, duration, tokens].filter(Boolean).join(' · ') || 'No telemetry reported';
}

function AutomationRunSheet({
  project,
  run,
  sessions,
  initialStageId,
  onClose,
  onOpenRun,
  onCancel,
  onArchive,
  onDelete
}: {
  project: ProjectRecord;
  run: WorkflowRunSummary;
  sessions: AgentSessionRecord[];
  initialStageId?: string;
  onClose: () => void;
  onOpenRun: () => void;
  onCancel: () => void | Promise<void>;
  onArchive?: () => void | Promise<void>;
  onDelete: () => void;
}) {
  const fallbackStage = run.stages[activeAutomationStageIndex(run)];
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(initialStageId ?? fallbackStage?.nodeId);
  const sheetRef = useRef<HTMLElement>(null);
  const completed = run.stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;
  const progress = run.stages.length > 0 ? Math.round((completed / run.stages.length) * 100) : 0;
  const live = run.status === 'running' || run.status === 'awaiting-approval';
  const statusLabel = run.paused ? 'Paused' : RUN_STATUS_LABEL[run.status];
  const statusTone = run.paused ? 'lane--awaiting' : RUN_STATUS_TONE[run.status];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && sheetRef.current) {
        const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          .filter(element => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="automation-sheet-backdrop" data-testid="automation-sheet-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={sheetRef} className="automation-sheet" role="dialog" aria-modal="true" aria-labelledby={`automation-sheet-title-${run.runId}`} data-testid="automation-sheet">
        <header className="automation-sheet-header">
          <div className="automation-sheet-heading">
            <span className={`automation-state-mark ${statusTone}`} aria-label={statusLabel} title={statusLabel} />
            <div>
              <h2 id={`automation-sheet-title-${run.runId}`}>{run.workflowName}</h2>
              <p>{project.name} · {formatElapsed(run.startedAt, run.endedAt) ?? 'Just started'}</p>
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close automation details" autoFocus onClick={onClose}><Icon name="close" size={13} /></button>
        </header>
        <div className="automation-sheet-summary">
          <div><strong>{completed} of {run.stages.length}</strong><span> steps complete</span></div>
          <span>{statusLabel}</span>
          <div className="automation-sheet-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.stages.length} aria-valuenow={completed} aria-label={`${completed} of ${run.stages.length} steps complete`}>
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="automation-sheet-stages" data-testid="automation-sheet-stages">
          {run.stages.map(stage => {
            const selected = selectedStageId === stage.nodeId;
            return <div className={`automation-sheet-stage${selected ? ' is-selected' : ''}`} key={stage.nodeId} data-lane={stage.lane}>
              <button type="button" className="automation-sheet-stage-main" aria-expanded={selected} onClick={() => setSelectedStageId(selected ? undefined : stage.nodeId)}>
                <span className={`automation-step-mark automation-step-mark--${stage.lane}`} aria-hidden><Icon name={stageLaneIcon(stage.lane)} size={11} /></span>
                <span className="automation-sheet-stage-copy">
                  <strong>{stage.name}</strong>
                  <small>{stageLaneLabel(stage.lane)}{stage.durationMs !== undefined ? ` · ${Math.round(stage.durationMs / 1000)}s` : ''}</small>
                </span>
                <Icon name={selected ? 'chevron-up' : 'chevron-down'} size={11} />
              </button>
              {selected && <div className="automation-sheet-stage-details" data-testid={`automation-sheet-stage-${stage.nodeId}`}>
                <span>{automationStageMeta(stage, sessions)}</span>
                {stage.attempts > 0 && <span>{stage.attempts} attempt{stage.attempts === 1 ? '' : 's'}</span>}
                {stage.lastError && <p>{stage.lastError}</p>}
              </div>}
            </div>;
          })}
        </div>
        <footer className="automation-sheet-footer">
          <button type="button" className="btn" data-testid="automation-sheet-open-run" onClick={onOpenRun}>Open full run</button>
          <span className="automation-sheet-footer-spacer" />
          {live && <button type="button" className="btn" onClick={() => void onCancel()}>Cancel run</button>}
          {!live && onArchive && <button type="button" className="btn" onClick={() => void onArchive()}>Archive</button>}
          <button type="button" className="btn automation-sheet-delete" onClick={onDelete}>Delete</button>
        </footer>
      </aside>
    </div>,
    document.body
  );
}

function AutomationRunRow({
  project,
  run,
  sessions,
  active,
  onSelectWorkflowRun,
  onCancelWorkflowRun,
  onDeleteWorkflowRun,
  onArchiveWorkflowRun
}: {
  project: ProjectRecord;
  run: WorkflowRunSummary;
  sessions: AgentSessionRecord[];
  active: boolean;
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onCancelWorkflowRun: (runId: string) => void | Promise<void>;
  onDeleteWorkflowRun: (project: ProjectRecord, run: WorkflowRunSummary) => void;
  onArchiveWorkflowRun?: (runId: string, archived: boolean) => Promise<void>;
}) {
  const [sheetStageId, setSheetStageId] = useState<string | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState(active);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const live = run.status === 'running' || run.status === 'awaiting-approval';
  const runState = run.paused ? 'paused' : run.status;
  const statusLabel = run.paused ? 'Paused' : RUN_STATUS_LABEL[run.status];
  const statusTone = run.paused ? 'lane--awaiting' : RUN_STATUS_TONE[run.status];
  const railItems = automationRailItems(run);
  const completed = run.stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;
  const fallbackStage = run.stages[activeAutomationStageIndex(run)];
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(fallbackStage?.nodeId);
  const selectedStage = run.stages.find(stage => stage.nodeId === selectedStageId) ?? fallbackStage;
  const selectedStageMeta = selectedStage ? automationStageMeta(selectedStage, sessions) : 'No stage telemetry reported';

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const openSheet = (stageId?: string) => {
    setSheetStageId(stageId ?? run.stages[activeAutomationStageIndex(run)]?.nodeId);
    setSheetOpen(true);
  };

  return (
    <>
      <div className={`automation-run-item${active ? ' active' : ''}${expanded ? ' is-expanded' : ''}`} data-testid="project-workflow-run-row" data-run-status={runState}>
        <div className="automation-run-title-row">
          <button type="button" className="automation-run-main" aria-label={`${run.workflowName}, ${statusLabel}, ${completed} of ${run.stages.length} steps complete`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            <span className={`automation-state-mark ${statusTone}`} data-testid="automation-run-status" aria-label={statusLabel} title={statusLabel} />
            <span className="automation-run-title" title={run.explanation}>{run.workflowName}</span>
            <span className="automation-run-inline-meta" title={selectedStageMeta}>{selectedStageMeta}</span>
          </button>
          <span className="automation-run-progress-count" aria-label={`${completed} of ${run.stages.length} steps complete`}>{completed}/{run.stages.length}</span>
          <div className="automation-run-menu-wrap" ref={menuRef}>
            <button type="button" className="icon-btn icon-btn-sm automation-run-menu-trigger" aria-label={`Actions for ${run.workflowName}`} aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Icon name="ellipsis" size={13} /></button>
            {menuOpen && <div className="automation-run-menu" role="menu">
              {live && <button type="button" role="menuitem" data-testid={`project-run-cancel-${run.runId}`} onClick={() => { setMenuOpen(false); void onCancelWorkflowRun(run.runId); }}><Icon name="close" size={12} />Cancel run</button>}
              {!live && onArchiveWorkflowRun && <button type="button" role="menuitem" data-testid={`project-run-archive-${run.runId}`} onClick={() => { setMenuOpen(false); void onArchiveWorkflowRun(run.runId, true); }}><Icon name="archive" size={12} />Archive</button>}
              <button type="button" role="menuitem" className="is-danger" data-testid={`project-run-delete-${run.runId}`} onClick={() => { setMenuOpen(false); onDeleteWorkflowRun(project, run); }}><Icon name="trash" size={12} />Delete</button>
            </div>}
          </div>
        </div>
        <div className={`automation-run-expansion${expanded ? ' is-open' : ''}`}>
          <div className="automation-run-expansion-inner">
            <div className="automation-progress-rail" data-testid="automation-timeline" aria-label={`${run.workflowName} workflow steps`}>
              {railItems.map(item => item.kind === 'overflow' ? (
                <button type="button" className="automation-rail-overflow" key={item.key} aria-label={`${item.count} hidden workflow steps. Open workflow details`} title={`${item.count} hidden steps`} onClick={() => openSheet()}>…</button>
              ) : (
                <button
                  type="button"
                  className={`automation-rail-step automation-rail-step--${item.stage.lane}${selectedStageId === item.stage.nodeId ? ' is-selected' : ''}`}
                  key={item.stage.nodeId}
                  title={`${item.stage.name}: ${stageLaneLabel(item.stage.lane)}`}
                  aria-label={`${item.stage.name}: ${stageLaneLabel(item.stage.lane)}`}
                  data-testid={`automation-stage-${item.stage.nodeId}`}
                  onClick={() => setSelectedStageId(item.stage.nodeId)}
                ><span aria-hidden /></button>
              ))}
            </div>
            <div className="automation-run-stage-summary" data-testid="automation-run-stage-summary">
              <div>
                <strong>{selectedStage?.name ?? 'Workflow details'}</strong>
                <span>{selectedStage ? stageLaneLabel(selectedStage.lane) : statusLabel}</span>
              </div>
              <p>{selectedStageMeta}</p>
              <div className="automation-run-detail-actions">
                <button type="button" data-testid="automation-inline-view-workflow" onClick={() => openSheet(selectedStage?.nodeId)}>View workflow</button>
                <button type="button" data-testid="automation-inline-open-run" onClick={() => onSelectWorkflowRun(project, run.runId)}>Open full run</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {sheetOpen && <AutomationRunSheet
        project={project}
        run={run}
        sessions={sessions}
        initialStageId={sheetStageId}
        onClose={() => setSheetOpen(false)}
        onOpenRun={() => { setSheetOpen(false); onSelectWorkflowRun(project, run.runId); }}
        onCancel={() => onCancelWorkflowRun(run.runId)}
        onArchive={onArchiveWorkflowRun ? () => onArchiveWorkflowRun(run.runId, true) : undefined}
        onDelete={() => { setSheetOpen(false); onDeleteWorkflowRun(project, run); }}
      />}
    </>
  );
}

export function Sidebar({
  boards,
  projects,
  connections,
  connectionChecks,
  selectedBoardId,
  detailsByBoardId,
  onSelectBoard,
  onSelectIssue,
  mode,
  onModeChange,
  activeFeature,
  activeGitView,
  onSelectFeature,
  sessions,
  activeSessionKey,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onArchiveSession,
  featureCounts,
  onNewSession,
  onNewConversation,
  onNewProject,
  onImportProjects,
  onSelectProject,
  onOpenProjectDocument,
  onSelectGit,
  projectWorkflows,
  activeWorkflowId,
  runsByProjectId,
  activeWorkflowRunId,
  activeWorkflowPolicies,
  onSelectWorkflow,
  onSelectWorkflowRun,
  onSelectWorkflowRuns,
  onStartWorkflowRun,
  onCancelWorkflowRun,
  onDeleteWorkflowRun,
  onArchiveWorkflowRun,
  onSelectWorkflowPolicies,
  onSelectRun,
  onSelectDeployments,
  enableDeployments,
  onNewWorkflow,
  onDeleteWorkflow,
  onDeleteBoard,
  onUnlinkBoard,
  onConfigureBoard,
  selectedProjectId,
  selectedIssueKey,
  selectedIssueConnectionId,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onDeleteWorkspace,
  onCreateWorkspace,
  onSaveWorkspace,
  onOpenWorkspace,
  onCloseWorkspace,
  searching,
  query,
  onQueryChange,
  onToggleSearch
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [localQuery, setLocalQuery] = useState('');
  const [localSearching, setLocalSearching] = useState(false);
  const effectiveSearching = searching ?? localSearching;
  const effectiveQuery = query !== undefined ? query : localQuery;
  const setEffectiveQuery = onQueryChange ?? setLocalQuery;
  const toggleEffectiveSearch = onToggleSearch ?? (() => { setLocalSearching(s => !s); setLocalQuery(''); });
  const { settings } = useSettings();
  const newProjectEnabled = settings?.preview.enableNewProject ?? true;
  // Brand artwork vs generic board-type glyphs — Appearance setting, applied
  // live through the settings push channel.
  const showBrandArtwork = settings?.appearance.showBrandArtwork ?? true;
  // A board's mark comes from its real connection; built-in boards have no
  // connection and fall back to the demo mark.
  const boardMode = (board: Board) => resolveBackendMode(board.connectionId, connections);
  // The "Praxis" footer carries its own toggle, separate from the
  // connection-group collapse map above, because it isn't tied to a folder key.
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false);
  const [featuresMaximized, setFeaturesMaximized] = useState(false);
  // Lets the "Praxis" footer grow taller than its natural content height
  // (e.g. a long Sessions list) at the cost of the boards/projects area above it.
  const praxisPanel = useResizable({
    storageKey: 'tm-pane-sidebar-praxis',
    initial: 240,
    min: 120,
    max: 640,
    side: 'bottom'
  });
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [documentsByProjectId, setDocumentsByProjectId] = useState<Record<string, { exists: boolean; documents: ProjectDocument[] }>>({});

  const activeWorkspace = workspaces?.find(workspace => workspace.id === activeWorkspaceId);
  // The switcher scopes the Projects tree to the active workspace; with no
  // workspace selected every project shows.
  const visibleProjects = activeWorkspace
    ? projects.filter(project => activeWorkspace.projectIds.includes(project.id))
    : projects;
  const activeProject = projects.find(project => project.id === selectedProjectId);
  const hideBoardsForActiveProject = activeProject?.planningMode === 'files' && activeProject.linkedBoards.length === 0;

  useEffect(() => {
    let cancelled = false;
    void Promise.all(visibleProjects.map(async project => [project.id, await window.praxis.projects.listDocuments(project.id)] as const))
      .then(entries => { if (!cancelled) setDocumentsByProjectId(Object.fromEntries(entries)); })
      .catch(error => console.error('Failed to load project documents:', error));
    return () => { cancelled = true; };
  }, [projects, activeWorkspaceId]);

  const projectEntries = useMemo(() => {
    const needle = effectiveQuery.trim().toLowerCase();
    return visibleProjects.map(project => {
      const projectConnection = connections.find(connection => connection.settings.projectId === project.id);
      const defaultBoard = projectConnection
        ? boards.find(board => board.connectionId === projectConnection.id)
        : undefined;
      const linkedBoards = project.linkedBoards.flatMap(link => {
        const board = boards.find(candidate => candidate.id === link.boardId && candidate.connectionId === link.connectionId);
        return board ? [{ link, board }] : [];
      });
      // A folder connection can expose more than the one board that was
      // initially linked (one board per discovered plans root). They belong to
      // the same project and must not fall through into the global Boards node.
      const linkedConnectionIds = new Set(project.linkedBoards.map(link => link.connectionId));
      const discoveredLinkedBoards = boards
        .filter(board => board.connectionId && linkedConnectionIds.has(board.connectionId))
        .filter(board => !linkedBoards.some(({ link }) => link.connectionId === board.connectionId && link.boardId === board.id))
        .map(board => ({
          link: { connectionId: board.connectionId!, boardId: board.id, displayName: board.name },
          board
        }));
      const allLinkedBoards = [...linkedBoards, ...discoveredLinkedBoards];
      const matchesProject = !needle || `${project.name} ${project.key} ${project.type}`.toLowerCase().includes(needle);
      const matchesDefault = defaultBoard?.name.toLowerCase().includes(needle);
      const matchingLinkedBoards = needle && !matchesProject
        ? allLinkedBoards.filter(({ link, board }) => `${link.displayName} ${board.name}`.toLowerCase().includes(needle))
        : allLinkedBoards;
      return {
        project,
        defaultBoard: !needle || matchesProject || matchesDefault ? defaultBoard : undefined,
        linkedBoards: matchingLinkedBoards,
        visible: matchesProject || Boolean(matchesDefault) || matchingLinkedBoards.length > 0
      };
    }).filter(entry => entry.visible);
  }, [boards, connections, visibleProjects, effectiveQuery]);
  const projectBoardKeys = useMemo(() => new Set(projectEntries.flatMap(({ defaultBoard, linkedBoards }) => [
    ...(defaultBoard ? [`${defaultBoard.connectionId}:${defaultBoard.id}`] : []),
    ...linkedBoards.map(({ board }) => `${board.connectionId}:${board.id}`)
  ])), [projectEntries]);
  const projectConnectionIds = useMemo(
    () => new Set(projects.flatMap(project => project.linkedBoards.map(link => link.connectionId))),
    [projects]
  );
  const externalBoards = boards.filter(board =>
    !projectBoardKeys.has(`${board.connectionId ?? ''}:${board.id}`) &&
    !projectConnectionIds.has(board.connectionId ?? '')
  );

  return (
    <nav className="sidebar" aria-label="Workspace">
      {effectiveSearching && (
        <div style={{ padding: '4px 12px 8px' }}>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            placeholder="Filter boards…"
            value={effectiveQuery}
            onChange={event => setEffectiveQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                toggleEffectiveSearch();
              }
            }}
          />
        </div>
      )}

      <div className="sidebar-scroll" style={featuresMaximized ? { display: 'none' } : undefined}>
        {mode === 'work' ? (
          <WorkModeView
            projects={projectEntries}
            connections={connections}
            detailsByBoardId={detailsByBoardId}
            onOpenBoard={onSelectBoard}
            onOpenIssue={onSelectIssue}
          />
        ) : (
          <>
            {newProjectEnabled && <>
              <div className="feature-section-header feature-section-toggle projects-section-header">
                <button
                  type="button"
                  className="feature-section-title"
                  aria-expanded={!projectsCollapsed}
                  data-testid="toggle-projects"
                  onClick={() => setProjectsCollapsed(value => !value)}
                >
                  <span className="sidebar-section-label" style={{ margin: 0 }}>Projects{projects.length > 0 && <span className="tree-meta" style={{ marginLeft: 6 }}>{projects.length}</span>}</span>
                </button>
                <div className="feature-section-actions">
                  <button
                    type="button"
                    className="feature-section-action"
                    aria-label="Add project"
                    title="Add project"
                    onClick={onNewProject}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    type="button"
                    className="feature-section-action"
                    aria-label={projectsCollapsed ? 'Expand Projects' : 'Collapse Projects'}
                    title={projectsCollapsed ? 'Expand Projects' : 'Collapse Projects'}
                    onClick={() => setProjectsCollapsed(value => !value)}
                  >
                    <span className={`tree-section-icon${projectsCollapsed ? '' : ' open'}`}>
                      <Icon name={projectsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                    </span>
                  </button>
                </div>
              </div>
              {!projectsCollapsed && (projects.length === 0
                ? <button className="sidebar-empty-project" onClick={onNewProject}>+ New Project</button>
                : projectEntries.map(({ project, defaultBoard, linkedBoards }) => {
                    const projectCollapsed = collapsed[`project:${project.id}`] ?? false;
                    const childCount = (defaultBoard ? 1 : 0) + linkedBoards.length;
                    const projectBoardsCollapsed = collapsed[`project:${project.id}:boards`] ?? false;
                    const projectWorkflowsCollapsed = collapsed[`project:${project.id}:workflows`] ?? false;
                    const projectWorkflowList = projectWorkflows[project.id] ?? [];
                    const projectRuns = runsByProjectId[project.id] ?? [];
                    const activeProjectRuns = projectRuns.filter(run => !run.archived);
                    const projectDocsVisible = collapsed[`project:${project.id}:docs-visible`] ?? false;
                    const projectDocsCollapsed = collapsed[`project:${project.id}:docs`] ?? false;
                    const projectPlansCollapsed = collapsed[`project:${project.id}:plans`] ?? false;
                    const projectDocuments = documentsByProjectId[project.id];
                    const projectSessionsCollapsed = collapsed[`project:${project.id}:sessions`] ?? false;
                    const projectRunsCollapsed = collapsed[`project:${project.id}:runs`] ?? false;
                    const projectItemKeys = new Set(project.workItems?.map(item => item.key) ?? []);
                    const projectSessions = sessions.filter(
                      session =>
                        !isConversationSession(session) &&
                        !isWorkflowStageSession(session) &&
                        (session.projectId === project.id ||
                          projectItemKeys.has(session.issueKey) ||
                          Boolean(project.workspaceFolder && session.workingDirectory === project.workspaceFolder))
                    );
                    const generalSessions = projectSessions.filter(session => isSynthesizedKey(session.issueKey) && !isTicketReviewKey(session.issueKey));
                    const ticketSessions = projectSessions.filter(session => !isSynthesizedKey(session.issueKey) || isTicketReviewKey(session.issueKey));
                    const generalSessionsCollapsed = collapsed[`project:${project.id}:general-sessions`] ?? false;
                    const ticketSessionsCollapsed = collapsed[`project:${project.id}:ticket-sessions`] ?? false;
                    const renderProjectSessions = (items: AgentSessionRecord[], kind: 'general' | 'ticket') => items.map(session => (
                      <ProjectSessionRow
                        key={session.issueKey}
                        session={session}
                        active={activeSessionKey === session.issueKey}
                        kind={kind}
                        onSelectSession={onSelectSession}
                        onRenameSession={onRenameSession}
                        onDeleteSession={onDeleteSession}
                        onArchiveSession={onArchiveSession}
                      />
                    ));
                    return <div className="project-tree" key={project.id} data-testid="project-tree">
                      <div className={`project-tree-parent${selectedProjectId === project.id ? ' active' : ''}`}>
                        <button
                          className="project-tree-toggle"
                          aria-label={`${projectCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                          aria-expanded={!projectCollapsed}
                          onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}`]: !projectCollapsed }))}
                        ><span className="tree-section-icon"><Icon name={projectCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></span></button>
                        <button className="project-tree-content" data-testid="project-nav-item" onClick={() => onSelectProject(project)}>
                          <span className="tree-icon project-icon" style={{ color: projectColorValue(project.color) }}><Icon name={project.icon ?? 'folder-open'} size={15} /></span>
                          <span className="tree-stack"><span className="tree-label">{project.name}</span><span className="tree-sub">{project.type}</span></span>
                          <span className="tree-meta">{childCount}</span>
                        </button>
                        <div className="project-tree-actions">
                          <button
                            type="button"
                            className={`project-header-action${activeFeature === 'git' && activeGitView !== 'changes' && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-git-nav-item"
                            title={!project.workspaceFolder ? 'Set up a Git workspace for this project' : `Git graph · ${project.name}`}
                            aria-label={`Git graph for ${project.name}`}
                            onClick={e => {
                              e.stopPropagation();
                              onSelectGit(project, 'graph');
                            }}
                          >
                            <Icon name="git-branch" size={13} />
                          </button>
                          <button
                            type="button"
                            className={`project-header-action${activeFeature === 'git' && activeGitView === 'changes' && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-git-changes-nav-item"
                            title={!project.workspaceFolder ? 'Set up a Git workspace for this project' : `Git changes · ${project.name}`}
                            aria-label={`Git changes for ${project.name}`}
                            onClick={e => {
                              e.stopPropagation();
                              onSelectGit(project, 'changes');
                            }}
                          >
                            <Icon name="file" size={13} />
                          </button>
                          <button
                            type="button"
                            className={`project-header-action${activeFeature === 'run' && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-run-nav-item"
                            title={`Run services · ${project.name}`}
                            aria-label={`Run services for ${project.name}`}
                            onClick={e => {
                              e.stopPropagation();
                              onSelectRun(project);
                            }}
                          >
                            <Icon name="server" size={13} />
                          </button>
                          <button
                            type="button"
                            className="project-header-action"
                            data-testid="project-docs-toggle"
                            title={`${projectDocsVisible ? 'Hide' : 'Show'} docs · ${project.name}`}
                            aria-label={`${projectDocsVisible ? 'Hide' : 'Show'} docs for ${project.name}`}
                            aria-pressed={projectDocsVisible}
                            onClick={e => {
                              e.stopPropagation();
                              setCollapsed(current => ({ ...current, [`project:${project.id}:docs-visible`]: !projectDocsVisible }));
                            }}
                          >
                            <Icon name={projectDocsVisible ? 'folder-open' : 'folder'} size={13} />
                          </button>
                          <button
                            type="button"
                            className="project-header-action"
                            data-testid="project-workflow-new"
                            title={`New workflow · ${project.name}`}
                            aria-label={`New workflow in ${project.name}`}
                            onClick={e => {
                              e.stopPropagation();
                              onNewWorkflow(project);
                            }}
                          >
                            <Icon name="plus" size={13} />
                          </button>
                        </div>
                      </div>
                      {!projectCollapsed && <div className="project-tree-children">
                        {childCount > 0 && <>
                        <button className="sidebar-subsection-toggle" aria-expanded={!projectBoardsCollapsed} onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:boards`]: !projectBoardsCollapsed }))}>
                          <span className={`tree-section-icon${projectBoardsCollapsed ? '' : ' open'}`}><Icon name="columns" size={13} /></span><span>Boards</span><span className="tree-meta">{childCount}</span>
                        </button>
                        {!projectBoardsCollapsed && <>
                        {defaultBoard && <button
                          className={`tree-row project-board-row${defaultBoard.id === selectedBoardId ? ' active' : ''}`}
                          data-testid="project-default-board-nav-item"
                          onClick={() => onSelectBoard(defaultBoard)}
                        >
                          <span className="tree-icon project-board-icon"><Icon name="columns" size={14} /></span>
                          <span className="tree-label">{defaultBoard.name}</span>
                          <span className="tree-badge">Default</span>
                        </button>}
                        {linkedBoards.map(({ link, board }) => {
                          return <div
                            key={`${link.connectionId}:${link.boardId}`}
                            className={`tree-row project-board-row board-tree-row${board.id === selectedBoardId ? ' active' : ''}`}
                            data-testid="project-linked-board-nav-item"
                          >
                            <button className="board-tree-main" onClick={() => onSelectBoard(board)}>
                              <span className="tree-icon linked-board-icon"><Icon name="link" size={14} /></span>
                              <span className="tree-label">{link.displayName}</span>
                              <span className="tree-badge">Linked</span>
                            </button>
                            <button
                              className="board-tree-configure"
                              data-testid="board-configure-btn"
                              aria-label={`Configure board ${board.name}`}
                              title="Configure board"
                              onClick={() => onConfigureBoard(board)}
                            ><Icon name="gear" size={12} /></button>
                            <button
                              className="board-tree-delete"
                              data-testid="board-unlink-btn"
                              aria-label={`Unlink board ${board.name} from ${project.name}`}
                              title="Unlink this board from the project"
                              onClick={() => onUnlinkBoard(project, link.connectionId, link.boardId)}
                            ><Icon name="trash" size={12} /></button>
                          </div>;
                        })}
                        </>}
                        </>}
                        {enableDeployments && (
                          <button
                            className={`tree-row project-deployments-row${activeFeature === 'deployments' && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-deployments-nav-item"
                            onClick={() => onSelectDeployments(project)}
                          ><span className="tree-icon"><Icon name="rocket" size={14} /></span><span className="tree-label">Deployments</span></button>
                        )}
                        {projectDocsVisible && projectDocuments?.exists && <>
                          <button className="sidebar-subsection-toggle" aria-expanded={!projectDocsCollapsed} data-testid="project-docs-nav-item" onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:docs`]: !projectDocsCollapsed }))}>
                            <span className={`tree-section-icon${projectDocsCollapsed ? '' : ' open'}`}><Icon name="folder-open" size={13} /></span><span>docs</span>
                          </button>
                          {!projectDocsCollapsed && <div className="project-docs-tree">
                            <button className="sidebar-subsection-toggle project-plans-folder" aria-expanded={!projectPlansCollapsed} data-testid="project-plans-nav-item" onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:plans`]: !projectPlansCollapsed }))}>
                              <span className={`tree-section-icon${projectPlansCollapsed ? '' : ' open'}`}><Icon name={projectPlansCollapsed ? 'folder' : 'folder-open'} size={12} /></span><span>plans</span><span className="tree-meta">{projectDocuments.documents.length}</span>
                            </button>
                            {!projectPlansCollapsed && groupDocumentsByType(projectDocuments.documents).map(group => {
                              const groupKey = `project:${project.id}:doc-type:${group.type}`;
                              const groupCollapsed = collapsed[groupKey] ?? false;
                              return <div className="project-document-group" key={group.type}>
                                <button className="project-document-group-toggle" aria-expanded={!groupCollapsed} data-testid="project-document-type-nav-item" onClick={() => setCollapsed(current => ({ ...current, [groupKey]: !groupCollapsed }))}>
                                  <span className="tree-section-icon"><Icon name={groupCollapsed ? 'chevron-right' : 'chevron-down'} size={10} /></span><span>{group.type}</span><span className="tree-meta">{group.documents.length}</span>
                                </button>
                                {!groupCollapsed && group.documents.map(document => <button className="tree-row project-document-row" key={document.relativePath} data-testid="project-document-nav-item" title={document.relativePath} onClick={() => onOpenProjectDocument(project, document)}><span className="tree-icon"><Icon name="markdown" size={14} /></span><span className="tree-label">{document.name}</span>{document.status && <span className="status-dot" data-testid="project-document-status" style={{ background: statusTone(undefined, document.status) }} aria-label={`Status: ${documentStatusLabel(document.status)}`} title={documentStatusLabel(document.status)} />}</button>)}
                              </div>;
                            })}
                          </div>}
                        </>}
                        <div className="feature-section-header feature-section-toggle project-sessions-header">
                          <button
                            type="button"
                            className="feature-section-title"
                            aria-expanded={!projectSessionsCollapsed}
                            data-testid="project-sessions-nav-item"
                            onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:sessions`]: !projectSessionsCollapsed }))}
                          >
                              <span className="sidebar-section-label" style={{ margin: 0 }}>Sessions</span>
                          </button>
                          <div className="feature-section-actions">
                            <button
                              type="button"
                              className="feature-section-action"
                              data-testid="project-session-new"
                              aria-label={`New session in ${project.name}`}
                              title={`New session · ${project.name}`}
                              onClick={e => {
                                e.stopPropagation();
                                onNewSession(project);
                              }}
                            >
                              <Icon name="plus" size={13} />
                            </button>
                            <button
                              type="button"
                              className="feature-section-action"
                              aria-label={projectSessionsCollapsed ? 'Expand sessions' : 'Collapse sessions'}
                              title={projectSessionsCollapsed ? 'Expand sessions' : 'Collapse sessions'}
                              onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:sessions`]: !projectSessionsCollapsed }))}
                            >
                              <span className={`tree-section-icon${projectSessionsCollapsed ? '' : ' open'}`}>
                                <Icon name={projectSessionsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                              </span>
                            </button>
                          </div>
                        </div>
                        {!projectSessionsCollapsed && <>
                          <div className="feature-section-header feature-section-toggle project-session-category-header">
                            <button
                              type="button"
                              className="feature-section-title"
                              aria-expanded={!generalSessionsCollapsed}
                              data-testid="project-general-sessions-nav-item"
                              onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:general-sessions`]: !generalSessionsCollapsed }))}
                            >
                              <span className="tree-icon"><Icon name="chats" size={14} /></span>
                              <span className="sidebar-section-label tree-label" style={{ margin: 0 }}>General{generalSessions.length > 0 && <span className="session-category-count">{generalSessions.length}</span>}</span>
                            </button>
                            <button
                              type="button"
                              className="feature-section-action"
                              aria-label={generalSessionsCollapsed ? 'Expand general sessions' : 'Collapse general sessions'}
                              title={generalSessionsCollapsed ? 'Expand general sessions' : 'Collapse general sessions'}
                              onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:general-sessions`]: !generalSessionsCollapsed }))}
                            ><span className={`tree-section-icon${generalSessionsCollapsed ? '' : ' open'}`}><Icon name={generalSessionsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} /></span></button>
                          </div>
                          {!generalSessionsCollapsed && (generalSessions.length > 0 ? renderProjectSessions(generalSessions, 'general') : (
                            <div className="project-session-empty">
                              <span>No general sessions yet</span>
                              <button type="button" className="project-session-empty-action" aria-label={`New general session in ${project.name}`} title="New general session" onClick={() => onNewSession(project)}><Icon name="plus" size={12} /></button>
                            </div>
                          ))}
                          <div className="feature-section-header feature-section-toggle project-session-category-header">
                            <button
                              type="button"
                              className="feature-section-title"
                              aria-expanded={!ticketSessionsCollapsed}
                              data-testid="project-ticket-sessions-nav-item"
                              onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:ticket-sessions`]: !ticketSessionsCollapsed }))}
                            >
                              <span className="tree-icon"><Icon name="ticket" size={14} /></span>
                              <span className="sidebar-section-label tree-label" style={{ margin: 0 }}>Ticket{ticketSessions.length > 0 && <span className="session-category-count">{ticketSessions.length}</span>}</span>
                            </button>
                            <button
                              type="button"
                              className="feature-section-action"
                              aria-label={ticketSessionsCollapsed ? 'Expand ticket sessions' : 'Collapse ticket sessions'}
                              title={ticketSessionsCollapsed ? 'Expand ticket sessions' : 'Collapse ticket sessions'}
                              onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:ticket-sessions`]: !ticketSessionsCollapsed }))}
                            ><span className={`tree-section-icon${ticketSessionsCollapsed ? '' : ' open'}`}><Icon name={ticketSessionsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} /></span></button>
                          </div>
                          {!ticketSessionsCollapsed && (ticketSessions.length > 0 ? renderProjectSessions(ticketSessions, 'ticket') : (
                            <div className="project-session-empty">
                              <span>No ticket sessions yet</span>
                              <button type="button" className="project-session-empty-action" aria-label={`New ticket session in ${project.name}`} title="New ticket session" onClick={() => onNewSession(project)}><Icon name="plus" size={12} /></button>
                            </div>
                          ))}
                        </>}
                        <div className="feature-section-header feature-section-toggle project-workflows-header">
                          <button
                            type="button"
                            className="feature-section-title"
                            aria-expanded={!projectWorkflowsCollapsed}
                            data-testid="project-workflows-nav-item"
                            onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:workflows`]: !projectWorkflowsCollapsed }))}
                          >
                            <span className="sidebar-section-label" style={{ margin: 0 }}>Workflows</span><span className="tree-meta">{projectWorkflowList.length}</span>
                          </button>
                          <button
                            type="button"
                            className="feature-section-action"
                            aria-label={projectWorkflowsCollapsed ? 'Expand workflows' : 'Collapse workflows'}
                            title={projectWorkflowsCollapsed ? 'Expand workflows' : 'Collapse workflows'}
                            onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:workflows`]: !projectWorkflowsCollapsed }))}
                          >
                            <span className={`tree-section-icon${projectWorkflowsCollapsed ? '' : ' open'}`}>
                              <Icon name={projectWorkflowsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                            </span>
                          </button>
                        </div>
                        {!projectWorkflowsCollapsed && <>
                          {projectWorkflowList.map(workflow => (
                            <div
                              key={workflow.id}
                              className={`tree-row project-workflow-row${activeFeature === 'workflows' && activeWorkflowId === workflow.id && selectedProjectId === project.id ? ' active' : ''}`}
                            >
                              <button
                                type="button"
                                className="board-tree-main"
                                data-testid="project-workflow-nav-item"
                                onClick={() => onSelectWorkflow(project, workflow.id)}
                              >
                                <span className="tree-icon"><Icon name="split-horizontal" size={14} /></span>
                                <span className="tree-label">{workflow.name}</span>
                              </button>
                              <button
                                type="button"
                                className="board-tree-configure project-workflow-run"
                                data-testid={`project-workflow-run-${workflow.id}`}
                                aria-label={`Start a run of ${workflow.name}`}
                                title="Start a run of this workflow"
                                onClick={e => {
                                  e.stopPropagation();
                                  onStartWorkflowRun(project, workflow.id);
                                }}
                              >
                                <Icon name="play" size={12} />
                              </button>
                              {onDeleteWorkflow && (
                                <button
                                  type="button"
                                  className="board-tree-delete project-workflow-delete"
                                  data-testid={`project-workflow-delete-${workflow.id}`}
                                  aria-label={`Delete workflow ${workflow.name}`}
                                  title="Delete this workflow"
                                  onClick={e => {
                                    e.stopPropagation();
                                    onDeleteWorkflow(project, workflow.id);
                                  }}
                                >
                                  <Icon name="trash" size={12} />
                                </button>
                              )}
                            </div>
                          ))}
                          {projectWorkflowList.length === 0 && (
                            <button className="tree-row project-workflow-empty" data-testid="project-workflow-empty" onClick={() => onNewWorkflow(project)}>
                              <span className="tree-icon"><Icon name="plus" size={13} /></span><span className="tree-label">New workflow…</span>
                            </button>
                          )}
                          <button
                            className={`tree-row project-workflow-child${activeFeature === 'workflows' && activeWorkflowPolicies && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-workflow-policies-nav-item"
                            onClick={() => onSelectWorkflowPolicies(project)}
                          ><span className="tree-icon"><Icon name="shield" size={14} /></span><span className="tree-label">Policies</span></button>
                        </>}
                        <div className="feature-section-header feature-section-toggle project-automations-header">
                          <button
                            type="button"
                            className="feature-section-title"
                            aria-expanded={!projectRunsCollapsed}
                            data-testid="project-workflow-runs-nav-item"
                            onClick={() => {
                              if (onSelectWorkflowRuns) onSelectWorkflowRuns(project);
                              else setCollapsed(current => ({ ...current, [`project:${project.id}:runs`]: !projectRunsCollapsed }));
                            }}
                          >
                            <span className="sidebar-section-label" style={{ margin: 0 }}>Automations{activeProjectRuns.length > 0 && <span className="session-category-count">{activeProjectRuns.length}</span>}</span>
                          </button>
                          <button
                            type="button"
                            className="feature-section-action"
                            aria-label="New automation"
                            title="Start a new automation"
                            data-testid="project-workflow-run-new"
                            onClick={event => {
                              event.stopPropagation();
                              onStartWorkflowRun(project);
                            }}
                          ><Icon name="plus" size={13} /></button>
                          <button
                            type="button"
                            className="feature-section-action"
                            aria-label={projectRunsCollapsed ? 'Expand automations' : 'Collapse automations'}
                            title={projectRunsCollapsed ? 'Expand automations' : 'Collapse automations'}
                            onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:runs`]: !projectRunsCollapsed }))}
                          >
                            <span className={`tree-section-icon${projectRunsCollapsed ? '' : ' open'}`}>
                              <Icon name={projectRunsCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                            </span>
                          </button>
                        </div>
                        {(!projectRunsCollapsed && activeProjectRuns.length > 0) && activeProjectRuns.map(run => (
                          <AutomationRunRow
                            key={`workflow-run:${run.runId}`}
                            project={project}
                            run={run}
                            sessions={sessions}
                            active={activeFeature === 'workflows' && activeWorkflowRunId === run.runId}
                            onSelectWorkflowRun={onSelectWorkflowRun}
                            onCancelWorkflowRun={onCancelWorkflowRun}
                            onDeleteWorkflowRun={onDeleteWorkflowRun}
                            onArchiveWorkflowRun={onArchiveWorkflowRun}
                          />
                        ))}
                        {!projectRunsCollapsed && activeProjectRuns.length === 0 && (
                          <span className="sidebar-empty-hint project-runs-empty">No automations yet</span>
                        )}
                      </div>}
                    </div>;
                  }))}
            </>}
            {!hideBoardsForActiveProject && <><div className="sidebar-section-heading">
              <button className="sidebar-section-label sidebar-section-button sidebar-section-toggle" aria-expanded={!boardsCollapsed} data-testid="toggle-boards" onClick={() => setBoardsCollapsed(value => !value)}>
                <span className={`tree-section-icon${boardsCollapsed ? '' : ' open'}`}><Icon name="columns" size={14} /></span><span>Boards</span><span className="tree-meta">{externalBoards.length}</span>
              </button>
            </div>
            {!boardsCollapsed && <div className="external-board-tree">{externalBoards.length === 0 ? <span className="sidebar-empty-hint">No external boards</span> : externalBoards.map(board => {
              const missing = board.availability === 'missing';
              const canDelete = Boolean(board.connectionId);
              const removeLabel = board.type === 'plan' ? 'Delete' : 'Remove';
              return <div key={`${board.connectionId}:${board.id}`} className={`tree-row board-tree-row${board.id === selectedBoardId ? ' active' : ''}${missing ? ' missing' : ''}`} data-testid="board-nav-item" title={missing ? board.availabilityMessage ?? 'This board folder is missing.' : boardTypeLabel(board)}>
                <button className="board-tree-main" disabled={missing} onClick={() => onSelectBoard(board)}>
                  <span className="tree-icon">{showBrandArtwork ? <BrandModeIcon mode={boardMode(board)} size={14} /> : <Icon name={boardTypeIcon(board)} size={14} />}</span>
                  <span className="tree-label">{board.name}</span>
                  {missing && <span className="board-availability-warning" data-testid="board-missing-icon" title="Board folder is missing"><Icon name="warning" size={14} /></span>}
                  {board.connectionId && !missing && <ConnectionStatusDot check={connectionChecks[board.connectionId]} />}
                </button>
                <button className="board-tree-configure" data-testid="board-configure-btn" aria-label={`Configure board ${board.name}`} title="Configure board" onClick={() => onConfigureBoard(board)}><Icon name="gear" size={12} /></button>
                {canDelete && <button className="board-tree-delete" data-testid="board-delete-btn" aria-label={`${removeLabel} board ${board.name}`} title={board.type === 'plan' ? 'Delete this board' : 'Remove this board from Praxis'} onClick={() => onDeleteBoard(board)}><Icon name="trash" size={12} /></button>}
              </div>;
            })}</div>}</>}
          </>
        )}
      </div>

      {mode === 'classic' && selectedIssueKey && !featuresMaximized && (
        <IssuePeek issueKey={selectedIssueKey} connectionId={selectedIssueConnectionId} />
      )}

      {!featuresCollapsed && !featuresMaximized && (
        <div
          className={`splitter-h${praxisPanel.dragging ? ' dragging' : ''}`}
          aria-label="Resize Praxis section"
          {...praxisPanel.handleProps}
        />
      )}
      <div
        className={`sidebar-footer${featuresMaximized ? ' sidebar-footer-maximized' : ''}`}
        style={featuresCollapsed ? undefined : featuresMaximized ? { flex: '1 1 auto', height: '100%' } : { height: praxisPanel.size }}
      >
        <div className="feature-section-header feature-section-toggle">
          <button
            type="button"
            className="feature-section-title"
            aria-expanded={!featuresCollapsed}
            onClick={() => {
              if (featuresMaximized) {
                setFeaturesMaximized(false);
                setFeaturesCollapsed(true);
              } else {
                setFeaturesCollapsed(collapsed => !collapsed);
              }
            }}
          >
            <span className="sidebar-section-label" style={{ margin: 0 }}>
              Praxis
            </span>
          </button>
          <div className="feature-section-actions">
            <button
              type="button"
              className="feature-section-action"
              aria-label={featuresMaximized ? 'Restore sidebar' : 'Use full sidebar'}
              title={featuresMaximized ? 'Restore sidebar' : 'Use full sidebar'}
              data-testid="toggle-features-maximize"
              onClick={() => {
                if (featuresMaximized) {
                  setFeaturesMaximized(false);
                } else {
                  setFeaturesCollapsed(false);
                  setFeaturesMaximized(true);
                }
              }}
            >
              <Icon name={featuresMaximized ? 'window-restore' : 'window-maximize'} size={13} />
            </button>
            <button
              type="button"
              className="feature-section-action"
              aria-label={featuresCollapsed ? 'Expand Praxis section' : 'Collapse Praxis section'}
              title={featuresCollapsed ? 'Expand Praxis section' : 'Collapse Praxis section'}
              data-testid="toggle-features"
              onClick={() => {
                if (featuresMaximized) {
                  setFeaturesMaximized(false);
                  setFeaturesCollapsed(true);
                } else {
                  setFeaturesCollapsed(collapsed => !collapsed);
                }
              }}
            >
              <span className={`tree-section-icon${featuresCollapsed ? '' : ' open'}`}>
                <Icon name={featuresCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
              </span>
            </button>
          </div>
        </div>
        {!featuresCollapsed &&
          FEATURES.map(feature =>
            feature.id === 'conversations' ? (
              <SessionsNav
                key={feature.id}
                testId="nav-conversations"
                icon={feature.icon}
                label={feature.label}
                active={activeFeature === 'conversations'}
                collapsed={collapsed['feature:conversations'] ?? false}
                onToggleCollapsed={() =>
                  setCollapsed(current => ({ ...current, 'feature:conversations': !(current['feature:conversations'] ?? false) }))
                }
                sessions={sessions.filter(isConversationSession)}
                runNames={{}}
                activeSessionKey={activeSessionKey}
                runningCount={featureCounts.conversations ?? 0}
                onSelectFeature={() => onSelectFeature('conversations')}
                onSelectSession={onSelectSession}
                onNewSession={onNewConversation}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
                onArchiveSession={onArchiveSession}
              />
            ) : (
              <button
                key={feature.id}
                data-testid={`nav-${feature.id}`}
                className={`feature-row${activeFeature === feature.id ? ' active' : ''}`}
                onClick={() => onSelectFeature(feature.id)}
              >
                <span className="tree-icon">
                  <Icon name={feature.icon} size={15} />
                </span>
                <span className="feature-label">{feature.label}</span>
                {/* The reference shows a count only where there is something to count. */}
                {!!featureCounts[feature.id] && (
                  <span className="feature-count">{featureCounts[feature.id]}</span>
                )}
              </button>
            )
          )}
      </div>
    </nav>
  );
}

/**
 * The Sessions destination plus its sessions, newest first. Rows carry the same
 * mode and state vocabulary as the console header, so the tree reads as a status
 * board — and rename / delete live on the row, where the list used to keep them.
 */
function SessionsNav({
  icon,
  label,
  testId = 'nav-sessions',
  active,
  collapsed,
  onToggleCollapsed,
  sessions,
  runNames,
  activeSessionKey,
  runningCount,
  onSelectFeature,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onArchiveSession
}: {
  testId?: string;
  /** Workflow run id → its workflow's name, for the header over a run's stage sessions. */
  runNames: Record<string, string>;
  icon: IconName;
  label: string;
  active: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  runningCount: number;
  onSelectFeature: () => void;
  onSelectSession: (issueKey: string) => void;
  onNewSession: (project?: ProjectRecord) => void;
  onRenameSession: (issueKey: string, title: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
  onArchiveSession: (issueKey: string, archived: boolean) => Promise<void>;
}) {
  const [editingKey, setEditingKey] = useState<string>();
  const [draft, setDraft] = useState('');
  const [mutatingKey, setMutatingKey] = useState<string>();
  const [error, setError] = useState<string>();
  const { confirmChoice } = useDialogs();

  /** Every session nested beneath `session`, deepest last. */
  const descendantsOf = (session: AgentSessionRecord): AgentSessionRecord[] => {
    const out: AgentSessionRecord[] = [];
    const walk = (parent: AgentSessionRecord) => {
      for (const child of childrenOf.get(parent.issueKey) ?? []) {
        out.push(child);
        walk(child);
      }
    };
    walk(session);
    return out;
  };

  const beginRename = (session: AgentSessionRecord) => {
    setEditingKey(session.issueKey);
    setDraft(sessionTitle(session));
  };

  const commitRename = async (session: AgentSessionRecord) => {
    const next = draft.trim();
    setEditingKey(undefined);
    if (!next || next === sessionTitle(session)) return;
    setMutatingKey(session.issueKey);
    setError(undefined);
    try {
      await onRenameSession(session.issueKey, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  const archive = async (session: AgentSessionRecord, archived: boolean) => {
    setMutatingKey(session.issueKey);
    setError(undefined);
    try {
      // Archiving a parent takes the sessions it spawned with it; otherwise
      // they would pop out to the top level, orphaned.
      for (const child of descendantsOf(session)) await onArchiveSession(child.issueKey, archived);
      await onArchiveSession(session.issueKey, archived);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  const remove = async (session: AgentSessionRecord) => {
    const descendants = descendantsOf(session);
    const choice = await confirmChoice({
      title: 'Delete this session?',
      message:
        descendants.length > 0
          ? `It also deletes the ${descendants.length} session${descendants.length === 1 ? '' : 's'} nested beneath it. This can’t be undone.`
          : 'This can’t be undone.',
      confirmLabel: descendants.length > 0 ? 'Delete sessions' : 'Delete session',
      tertiaryLabel: 'Archive instead',
      danger: true
    });
    if (choice === 'cancel') return;
    if (choice === 'tertiary') {
      await archive(session, true);
      return;
    }
    setMutatingKey(session.issueKey);
    setError(undefined);
    try {
      for (const child of [...descendants].reverse()) await onDeleteSession(child.issueKey);
      await onDeleteSession(session.issueKey);
      setEditingKey(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  // A run header stands for all of its stage sessions, so archiving or deleting it does exactly what
  // doing the same to a parent session does: it takes every session under it along (a stage's own
  // children first, then the stage). The run itself is not touched — it stays under Workflows → Runs.
  const runSessions = (members: AgentSessionRecord[]): AgentSessionRecord[] =>
    members.flatMap(member => [...descendantsOf(member)].reverse().concat(member));

  const archiveRun = async (runId: string, members: AgentSessionRecord[]) => {
    setMutatingKey(`run:${runId}`);
    setError(undefined);
    try {
      for (const session of runSessions(members)) await onArchiveSession(session.issueKey, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  const removeRun = async (runId: string, label: string, members: AgentSessionRecord[]) => {
    const all = runSessions(members);
    const live = all.filter(session => !isTerminalAgentState(session.state)).length;
    const choice = await confirmChoice({
      title: 'Delete this run\u2019s sessions?',
      message: `It deletes all ${all.length} session${all.length === 1 ? '' : 's'} of \u201c${label}\u201d${live > 0 ? `, ${live} of them still working` : ''}. The run itself stays under Workflows \u2192 Runs.`,
      confirmLabel: 'Delete sessions',
      tertiaryLabel: 'Archive instead',
      danger: true
    });
    if (choice === 'cancel') return;
    if (choice === 'tertiary') {
      await archiveRun(runId, members);
      return;
    }
    setMutatingKey(`run:${runId}`);
    setError(undefined);
    try {
      for (const session of all) await onDeleteSession(session.issueKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  // A session that spawned others (a workflow controller's stage sessions)
  // nests them beneath it. A child whose parent is not in the list — archived,
  // or in another workspace — stays a top-level row rather than vanishing.
  const { childrenOf, roots } = useMemo(() => {
    const known = new Set(sessions.map(session => session.issueKey));
    const children = new Map<string, AgentSessionRecord[]>();
    const top: AgentSessionRecord[] = [];
    for (const session of sessions) {
      const parent = session.parentSessionKey;
      if (parent && parent !== session.issueKey && known.has(parent)) {
        children.set(parent, [...(children.get(parent) ?? []), session]);
      } else {
        top.push(session);
      }
    }
    return { childrenOf: children, roots: top };
  }, [sessions]);
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});
  const [collapsedRuns, setCollapsedRuns] = useState<Record<string, boolean>>({});

  // Stage sessions of one run that no controller adopted would otherwise be a screenful of sibling
  // rows. Two or more from the same run gather under one run header; a lone one stays a plain row.
  const rootItems = useMemo(() => {
    const byRun = new Map<string, AgentSessionRecord[]>();
    for (const session of roots) {
      if (isWorkflowStageSession(session) && session.workflowRunId) {
        byRun.set(session.workflowRunId, [...(byRun.get(session.workflowRunId) ?? []), session]);
      }
    }
    const items: Array<{ kind: 'session'; session: AgentSessionRecord } | { kind: 'run'; runId: string; members: AgentSessionRecord[] }> = [];
    const emitted = new Set<string>();
    for (const session of roots) {
      const runId = isWorkflowStageSession(session) ? session.workflowRunId : undefined;
      const members = runId ? byRun.get(runId) : undefined;
      if (runId && members && members.length > 1) {
        if (!emitted.has(runId)) {
          emitted.add(runId);
          items.push({ kind: 'run', runId, members });
        }
      } else {
        items.push({ kind: 'session', session });
      }
    }
    return items;
  }, [roots]);

  const renderNode = (session: AgentSessionRecord, depth: number): ReactNode => {
      const editing = editingKey === session.issueKey;
      const kids = childrenOf.get(session.issueKey) ?? [];
      const childrenCollapsed = collapsedParents[session.issueKey] ?? false;
      const liveChildCount = kids.filter(child => !isTerminalAgentState(child.state)).length;
      const mutating = mutatingKey === session.issueKey;
      const title = sessionTitle(session);
      return (
        <Fragment key={session.issueKey}>
        <div
          className={`tree-row session-nav-row${depth > 0 ? ' session-nav-row--child' : ''}${active && activeSessionKey === session.issueKey ? ' active' : ''}`}
          data-parent-session={session.parentSessionKey || undefined}
          data-testid="session-list-row"
          role="button"
          tabIndex={0}
          onClick={() => !editing && onSelectSession(session.issueKey)}
          onKeyDown={event => {
            if (!editing && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onSelectSession(session.issueKey);
            }
          }}
        >
          <span className="tree-icon">
            <Icon name="robot" size={14} />
          </span>
          {!editing && !isSynthesizedKey(session.issueKey) && !isWorkflowStageSession(session) && (
            <span className="session-item-key">{session.issueKey}</span>
          )}
          {editing ? (
            <input
              className="session-title-input"
              data-testid="session-title-input"
              aria-label={`Session title for ${title}`}
              value={draft}
              disabled={mutating}
              autoFocus
              onClick={event => event.stopPropagation()}
              onChange={event => setDraft(event.target.value)}
              onBlur={() => void commitRename(session)}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingKey(undefined);
                }
              }}
            />
          ) : (
            <span className="tree-label" title={title} data-testid="session-title">
              {title}
            </span>
          )}
          {kids.length > 0 && (
            <button
              className="icon-btn icon-btn-sm session-nav-toggle"
              aria-label={`${childrenCollapsed ? 'Expand' : 'Collapse'} ${title}'s child sessions`}
              aria-expanded={!childrenCollapsed}
              data-testid="session-children-toggle"
              onClick={event => {
                event.stopPropagation();
                setCollapsedParents(current => ({ ...current, [session.issueKey]: !childrenCollapsed }));
              }}
            >
              <Icon name={childrenCollapsed ? 'chevron-right' : 'chevron-down'} size={11} />
            </button>
          )}
          {!editing && (
            <>
              <span
                className={agentStateLaneClass(session.state)}
                title={agentStateLabel(session.state)}
                data-testid="session-nav-state"
              >
                ●
              </span>
              {childrenCollapsed && liveChildCount > 0 && (
                <span className="session-nav-childcount" title={`${liveChildCount} child session${liveChildCount === 1 ? '' : 's'} still working`} data-testid="session-children-live">
                  {liveChildCount}
                </span>
              )}
              <span className="session-nav-actions">
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Rename session ${title}`}
                  title="Rename session"
                  data-testid="session-rename-btn"
                  disabled={mutating}
                  onClick={event => {
                    event.stopPropagation();
                    beginRename(session);
                  }}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Archive session ${title}`}
                  title="Archive session"
                  data-testid="session-archive-btn"
                  disabled={mutating}
                  onClick={event => {
                    event.stopPropagation();
                    void archive(session, true);
                  }}
                >
                  <Icon name="archive" size={12} />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={`Delete session ${title}`}
                  title="Delete session"
                  data-testid="session-delete-btn"
                  disabled={mutating}
                  onClick={event => {
                    event.stopPropagation();
                    void remove(session);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </>
          )}
        </div>
        {!childrenCollapsed && kids.map(child => renderNode(child, depth + 1))}
        </Fragment>
      );
  };

  return (
    <>
      <div className="feature-row-heading">
        <button
          data-testid={testId}
          className={`feature-row${active ? ' active' : ''}`}
          onClick={() => {
            onSelectFeature();
            if (collapsed) onToggleCollapsed();
          }}
        >
          <span className="tree-icon">
            <Icon name={icon} size={15} />
          </span>
          <span className="feature-label">{label}</span>
          {runningCount > 0 && <span className="feature-count">{runningCount}</span>}
        </button>
        <button
          className="feature-row-expand"
          aria-label={collapsed ? 'Expand session list' : 'Collapse session list'}
          aria-expanded={!collapsed}
          data-testid={`${testId}-toggle`}
          onClick={onToggleCollapsed}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <button
          className="sidebar-section-add"
          aria-label={`New ${label.toLowerCase().slice(0, -1)}`}
          data-testid={testId === 'nav-conversations' ? 'conversations-new-btn' : 'sessions-new-btn'}
          onClick={() => onNewSession()}
        >
          <Icon name="plus" size={13} />
        </button>
      </div>
      {!collapsed && error && (
        <div className="error-banner session-list-error" data-testid="session-list-error">{error}</div>
      )}
      {!collapsed && sessions.length === 0 && (
        <span className="sidebar-empty-hint" data-testid="sessions-nav-empty">No AI sessions yet</span>
      )}
      {!collapsed &&
        rootItems.map(item => {
          if (item.kind === 'session') return renderNode(item.session, 0);
          const runCollapsed = collapsedRuns[item.runId] ?? false;
          const live = item.members.filter(member => !isTerminalAgentState(member.state)).length;
          const label = runNames[item.runId] || 'Workflow run';
          const runMutating = mutatingKey === `run:${item.runId}`;
          return (
            <Fragment key={`run:${item.runId}`}>
              <div className="tree-row session-nav-row session-nav-run" data-testid="session-run-group" data-run-id={item.runId}>
                <span className="tree-icon">
                  <Icon name="graph" size={14} />
                </span>
                <span className="tree-label" title={label}>
                  {label}
                </span>
                <span className="session-nav-childcount" title={`${item.members.length} stage sessions${live ? `, ${live} still working` : ''}`}>
                  {live > 0 ? `${live}/${item.members.length}` : item.members.length}
                </span>
                <button
                  className="icon-btn icon-btn-sm session-nav-toggle"
                  aria-label={`${runCollapsed ? 'Expand' : 'Collapse'} ${label} stage sessions`}
                  aria-expanded={!runCollapsed}
                  data-testid="session-run-toggle"
                  onClick={() => setCollapsedRuns(current => ({ ...current, [item.runId]: !runCollapsed }))}
                >
                  <Icon name={runCollapsed ? 'chevron-right' : 'chevron-down'} size={11} />
                </button>
                <span className="session-nav-actions">
                  <button
                    className="icon-btn icon-btn-sm"
                    aria-label={`Archive all sessions of ${label}`}
                    title="Archive these sessions"
                    data-testid="session-run-archive-btn"
                    disabled={runMutating}
                    onClick={() => void archiveRun(item.runId, item.members)}
                  >
                    <Icon name="archive" size={12} />
                  </button>
                  <button
                    className="icon-btn icon-btn-sm"
                    aria-label={`Delete all sessions of ${label}`}
                    title="Delete these sessions"
                    data-testid="session-run-delete-btn"
                    disabled={runMutating}
                    onClick={() => void removeRun(item.runId, label, item.members)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </div>
              {!runCollapsed && item.members.map(member => renderNode(member, 1))}
            </Fragment>
          );
        })}
    </>
  );
}

function groupDocumentsByType(documents: ProjectDocument[]): Array<{ type: string; documents: ProjectDocument[] }> {
  const groups = new Map<string, ProjectDocument[]>();
  for (const document of documents) {
    const type = formatDocumentType(document.type);
    const group = groups.get(type) ?? [];
    group.push(document);
    groups.set(type, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, grouped]) => ({ type, documents: grouped }));
}

function formatDocumentType(type?: string): string {
  const value = type?.trim();
  if (!value) return 'Other';
  if (value.toLowerCase() === 'other') return 'Other';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() + (value.toLowerCase().endsWith('s') ? '' : 's');
}

function documentStatusLabel(status: string): string {
  return status.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, character => character.toUpperCase());
}
