import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentRuntimeSnapshot,
  AgentSessionRecord,
  AiProvider,
  Board,
  BoardDetails,
  Connection,
  ConnectionCheck,
  IssueFilters,
  IssueSummary,
  TaskDesignerCanvasNode,
  TaskDesignerTicketNode
  , ProjectRecord, ProjectDocument, WorkspaceRecord, WorkflowPlanInput, WorkflowRunSummary } from '@praxis/core';
import { IssueDetail } from '../issues/IssueDetail';
import { Connections } from '../connections/Connections';
import { SettingsPage, type SettingsCategory } from '../settings/SettingsPage';
import { TitleBar } from './TitleBar';
import { useAssistant } from '../assistant/AssistantProvider';
import { AssistantDock, AssistantFloating } from '../assistant/AssistantShell';
import { Sidebar, type FeatureId, type SidebarMode } from './Sidebar';
import { SessionRecoveryDialog } from '../ai/SessionRecoveryDialog';
import { NewSession, type SessionWorkflowOption } from '../ai/NewSession';
import { NewIssuePage } from '../issues/NewIssuePage';
import { ImportProjectsWizard } from '../projects/ImportProjectsWizard';
import { BoardView } from '../board/BoardView';
import { BoardDetailsPanel } from '../board/BoardDetailsPanel';
import { AiReviewPage } from '../ai/AiReviewPage';
import { LocalPeerReviewPage } from '../ai/LocalPeerReviewPage';
import { TaskDesignerPage } from '../taskDesigner/TaskDesignerPage';
import { TaskDesignerItemDetail } from '../taskDesigner/TaskDesignerItemDetail';
import { TaskDesignerSidebar } from '../taskDesigner/TaskDesignerSidebar';
import { EasyModeSidebar } from '../components/sidebar/EasyModeSidebar';
import { AgentDetailsPage } from '../components/agent-details/AgentDetailsPage';
import { BottomPanel } from './BottomPanel';
import { SessionInspector } from '../ai/SessionInspector';
import { SessionsPage } from '../ai/SessionsPage';
import { SessionFocusTabs } from '../ai/SessionFocusTabs';
import { Icon, type IconName } from '../ui/Icon';
import { backendModeMeta } from '../board/boardMeta';
import { useResizable } from './useResizable';
import { findTransitionToTargetStatus } from '../board/boardTransitionMatch';
import { isTerminalAgentState } from '../ai/aiSessionState';
import { extractSubagents, isConversationSession, isSessionForProject, sessionTitle } from '../ai/sessionNav';
import { WhatsNewDialog } from './WhatsNewDialog';
import { StartupSplash } from './StartupSplash';
import { CommandPalette, type CommandEntry } from './CommandPalette';
import { Walkthrough, type WalkthroughStop } from './Walkthrough';
import { NewProjectWizard } from '../projects/NewProjectWizard';
import { AddProjectDialog, type AddProjectChoice } from '../projects/AddProjectDialog';
import { ProjectHome } from '../projects/ProjectHome';
import { ProjectWorkspace } from '../projects/ProjectWorkspace';
import { EasyModeCanvas } from '../projects/EasyModeCanvas';
import { OverviewPage } from './OverviewPage';
import { WorkspaceDialog } from './WorkspaceDialog';
import { GettingStarted } from './GettingStarted';
import { AI_ONBOARDED_KEY, AiSetupWizard, hasUsableProvider } from './AiSetupWizard';
import { useSettings } from '../settings/useSettings';
import {
  EMPTY_BOARD_FILTER,
  type BoardFilterPresentation,
  type BoardFilterValue
} from '../board/BoardFilterBar';
import { GitGraphPage } from '../git/GitGraphPage';
import { GitChangesPage } from '../git/GitChangesPage';
import { WorkflowDesignerPage } from '../workflows/WorkflowDesignerPage';
import { WorkflowRunPage } from '../workflows/WorkflowRunPage';
import { StartRunDialog } from '../workflows/StartRunDialog';
import { assertRunBaseOrThrow, type UncommittedChoice } from '../workflows/UncommittedBaseNotice';
import { useDeleteRun } from '../workflows/useDeleteRun';
import { WorkflowPolicyPage } from '../workflows/WorkflowPolicyPage';
import { NewWorkflowDialog } from '../workflows/NewWorkflowDialog';
import { RunProfileEditor } from '../projects/RunProfileEditor';
import { DeploymentsPage } from '../deployments/DeploymentsPage';
import { AgentDetailPage } from '../agents/AgentDetailPage';
import { AgentRuntimePanel } from '../agents/AgentRuntimePanel';
import { CreateAgentDialog, CreateAgentProfileDialog, CreateSkillDialog, ImportDialog } from '../agents/AgentHubDialogs';
import { isHostShimProfile, skillTitle } from '../agents/agentCatalog';
import type { ActivationMap, CatalogSelection, LifecycleAction } from '../agents/agentSelection';
import { ProjectDocumentPreview } from '../projects/ProjectDocumentPreview';
import { useDialogs } from '../ui/dialogs';

const EMPTY_FILTERS = { projectKeys: [], types: [], searchText: '' };

function WindowCloseGuard() {
  const { confirm } = useDialogs();
  const handlingRequest = useRef(false);

  useEffect(() => window.praxis.window.onCloseRequested(request => {
    if (handlingRequest.current) return;
    handlingRequest.current = true;
    void (async () => {
      try {
        const sessionWord = request.runningSessionCount === 1 ? 'session' : 'sessions';
        const shouldClose = await confirm({
          title: 'AI sessions still running',
          message: `Closing Praxis will stop ${request.runningSessionCount} active AI ${sessionWord}. Keep Praxis open until they finish, or close now and stop them.`,
          confirmLabel: 'Close Praxis',
          cancelLabel: 'Keep Praxis open',
          danger: true
        });
        if (shouldClose) {
          await window.praxis.window.confirmClose();
        }
      } finally {
        handlingRequest.current = false;
      }
    })();
  }), [confirm]);

  return null;
}

/**
 * One navigable location. Everything the centre and right panes render is
 * derived from this, which is what makes the title bar's back/forward arrows a
 * plain index into a list of routes.
 */
interface Route {
  /** Durable selection of the empty New Session surface (never its draft text). */
  newSession?: boolean;
  /** Durable selection of the empty New Conversation composer (FX-BE-142). */
  newConversation?: boolean;
  /** Title-bar quick-session handoff: pre-selects the project's quick-change
   *  workflow and focuses the goal. Transient, not persisted. */
  quickSession?: boolean;
  projectId?: string;
  feature?: FeatureId;
  boardId?: string;
  issueKey?: string;
  /** Show the create-ticket form for `boardId` instead of the board. */
  newIssue?: boolean;
  /** Pre-selected type for the create form (e.g. 'Idea' from New idea). */
  newIssueType?: string;
  /** Selected agent session when `feature === 'sessions'`. */
  sessionKey?: string;
  /** Agent Hub → New Session handoff (FX-BF-011): the discovered agent and its
   *  active skills to attribute the new session to. Transient, not persisted. */
  newSessionAgent?: string;
  newSessionProfile?: string;
  newSessionSkills?: string[];
  /** Team assistant handoff: pre-fills the New Session goal. Transient. */
  newSessionGoal?: string;
  /** The catalog item selected in the Agents tree (`feature === 'agents'`). */
  agentId?: string;
  agentProfileId?: string;
  skillName?: string;
  /** Whether the in-app browser was visible in the selected AI session. */
  browserOpen?: boolean;
  /** Last navigated URL in the in-app browser. */
  browserUrl?: string;
  /** Centre-pane AI tooling view for `issueKey` (review / peer review / designer / agent-details). */
  view?: 'review' | 'lpr' | 'designer' | 'agent-details';
  /** Subagent call ID or agent ID when inspecting agent details. */
  subagentId?: string;
  /** Per-ticket runtime selected before opening an AI tool. */
  aiProvider?: AiProvider;
  aiModel?: string;
  gitView?: 'graph' | 'changes' | 'conflicts';
  /** The saved workflow open in the designer (`feature === 'workflows'`). */
  workflowId?: string;
  /** The Workflows feature is showing the run monitor or policy manager rather than a designer. */
  workflowView?: 'runs' | 'policies';
  /** Run selected in the monitor, typically opened from its controller session. */
  workflowRunId?: string;
}

const FEATURE_TITLES: Record<FeatureId, string> = {
  overview: 'Overview',
  conversations: 'Conversations',
  sessions: 'Sessions',
  connections: 'Connections',
  agents: 'Agent Hub',
  workflows: 'Workflows',
  git: 'Git Graph',
  run: 'Run',
  deployments: 'Deployments'
};

const FEATURE_ICONS: Record<FeatureId, IconName> = {
  overview: 'home',
  conversations: 'chats',
  sessions: 'robot',
  connections: 'plug',
  agents: 'zap',
  workflows: 'git-branch',
  git: 'git-branch',
  run: 'play',
  deployments: 'radio-tower'
};

/** Legacy single-slot key. Still read once per workspace as a fallback so an
 *  upgrade does not lose the place the user left off in. */
const LAST_WORKSPACE_ROUTE_KEY = 'praxis-last-workspace-route';
/** Routes are stored per workspace: switching between two workspaces has to
 *  return to where you were in each, and a route from one workspace names
 *  project and board ids that do not exist in the other. */
const lastRouteKey = (workspaceId: string) => `${LAST_WORKSPACE_ROUTE_KEY}:${workspaceId}`;
const ACTIVE_WORKSPACE_KEY = 'praxis-active-workspace';
const RECENT_WORKSPACES_KEY = 'praxis-recent-workspaces';

/** The built-in quick-change workflow's template id (instantiated per project as
 *  `${id}-${projectId}` — see `workflowTemplates` / `workflows:startRun`). */
const QUICK_CHANGE_TEMPLATE_ID = 'quick-change';

/** Project ownership is carried by the connection record, never inferred from its id. */
function projectIdForConnection(connectionId: string | undefined, connections: readonly Connection[]): string | undefined {
  if (!connectionId) return undefined;
  const projectId = connections.find(connection => connection.id === connectionId)?.settings.projectId;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
}

/** Persisted show/hide state for the shell panes — matches the `tm-pane-*`
 *  width keys `useResizable` writes. */
function readPaneVisible(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writePaneVisible(key: string, visible: boolean): void {
  try {
    localStorage.setItem(key, visible ? '1' : '0');
  } catch {
    // Private mode / storage disabled — the preference just won't persist.
  }
}

function restorableBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Restores only durable navigation context. Transient forms and AI tool modes
 * deliberately fall away so a relaunch cannot reopen an unfinished action.
 */
function readLastWorkspaceRoute(workspaceId: string): Route {
  try {
    // Fall back to the legacy single-slot key so the first launch after an
    // upgrade still lands where the user left off — but only for the workspace
    // that value was written against, or one workspace would inherit another's
    // place the first time it is opened.
    const legacy = localStorage.getItem(ACTIVE_WORKSPACE_KEY) === workspaceId
      ? localStorage.getItem(LAST_WORKSPACE_ROUTE_KEY)
      : null;
    const raw = localStorage.getItem(lastRouteKey(workspaceId)) ?? legacy;
    const stored = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const feature = typeof stored.feature === 'string' && stored.feature in FEATURE_TITLES
      ? stored.feature as FeatureId
      : undefined;
    const gitView = stored.gitView === 'changes' || stored.gitView === 'conflicts' || stored.gitView === 'graph'
      ? stored.gitView
      : undefined;
    return {
      ...(stored.newSession === true ? { newSession: true } : {}),
      ...(typeof stored.projectId === 'string' ? { projectId: stored.projectId } : {}),
      ...(feature ? { feature } : {}),
      ...(typeof stored.boardId === 'string' ? { boardId: stored.boardId } : {}),
      ...(typeof stored.issueKey === 'string' ? { issueKey: stored.issueKey } : {}),
      ...(typeof stored.sessionKey === 'string' ? { sessionKey: stored.sessionKey } : {}),
      ...(stored.browserOpen === true ? { browserOpen: true } : stored.browserOpen === false ? { browserOpen: false } : {}),
      ...(restorableBrowserUrl(stored.browserUrl) ? { browserUrl: stored.browserUrl } : {}),
      ...(gitView ? { gitView } : {}),
      ...(typeof stored.workflowId === 'string' ? { workflowId: stored.workflowId } : {}),
      ...(stored.workflowView === 'runs' || stored.workflowView === 'policies' ? { workflowView: stored.workflowView } : {}),
      ...(typeof stored.workflowRunId === 'string' ? { workflowRunId: stored.workflowRunId } : {}),
      ...(typeof stored.agentId === 'string' ? { agentId: stored.agentId } : {}),
      ...(typeof stored.agentProfileId === 'string' ? { agentProfileId: stored.agentProfileId } : {}),
      ...(typeof stored.skillName === 'string' ? { skillName: stored.skillName } : {})
    };
  } catch {
    return {};
  }
}

function writeLastWorkspaceRoute(workspaceId: string, route: Route): void {
  const durableRoute: Route = {
    ...(!route.projectId && !route.feature && !route.boardId ? { newSession: true } : {}),
    ...(route.projectId ? { projectId: route.projectId } : {}),
    ...(route.feature ? { feature: route.feature } : {}),
    ...(route.boardId ? { boardId: route.boardId } : {}),
    ...(route.issueKey ? { issueKey: route.issueKey } : {}),
    ...(route.sessionKey ? { sessionKey: route.sessionKey } : {}),
    ...((route.feature === 'sessions' || route.feature === 'conversations') && route.browserOpen !== undefined ? { browserOpen: route.browserOpen } : {}),
    ...((route.feature === 'sessions' || route.feature === 'conversations') && route.browserUrl && restorableBrowserUrl(route.browserUrl) ? { browserUrl: route.browserUrl } : {}),
    ...(route.gitView ? { gitView: route.gitView } : {}),
    ...(route.feature === 'workflows' && route.workflowView ? { workflowView: route.workflowView } : {}),
    ...(route.feature === 'workflows' && route.workflowId ? { workflowId: route.workflowId } : {}),
    ...(route.feature === 'workflows' && route.workflowRunId ? { workflowRunId: route.workflowRunId } : {}),
    ...(route.feature === 'agents' && route.agentId ? { agentId: route.agentId } : {}),
    ...(route.feature === 'agents' && route.agentProfileId ? { agentProfileId: route.agentProfileId } : {}),
    ...(route.feature === 'agents' && route.skillName ? { skillName: route.skillName } : {})
  };
  try {
    localStorage.setItem(lastRouteKey(workspaceId), JSON.stringify(durableRoute));
  } catch {
    // Private mode / storage disabled — the place just won't be restored.
  }
}

function readRecentWorkspaceIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function routeForOpenedWorkspace(workspace: WorkspaceRecord, projects: ProjectRecord[]): Route {
  return workspace.defaultProjectId && projects.some(project => project.id === workspace.defaultProjectId)
    ? { projectId: workspace.defaultProjectId }
    : { feature: 'overview' };
}

function restoredRouteForWorkspace(
  stored: Route,
  workspace: WorkspaceRecord,
  projects: ProjectRecord[],
  boards: Board[],
  connections: Connection[]
): Route {
  const workspaceProjects = projects.filter(project => workspace.projectIds.includes(project.id));
  const project = stored.projectId && workspaceProjects.find(candidate => candidate.id === stored.projectId);
  const board = stored.boardId && boards.find(candidate => {
    if (candidate.id !== stored.boardId) return false;
    const directProjectId = projectIdForConnection(candidate.connectionId, connections);
    return directProjectId
      ? workspace.projectIds.includes(directProjectId)
      : workspaceProjects.some(candidateProject => candidateProject.linkedBoards.some(link =>
          link.boardId === candidate.id && link.connectionId === candidate.connectionId));
  });
  if (stored.projectId && !project) return routeForOpenedWorkspace(workspace, projects);
  if (stored.boardId && !board) return routeForOpenedWorkspace(workspace, projects);
  if (stored.feature === 'git' && !project) return routeForOpenedWorkspace(workspace, projects);
  if (stored.newSession) return { newSession: true };
  if (project || board || stored.feature) {
    return {
      ...(project ? { projectId: project.id } : {}),
      ...(stored.feature ? { feature: stored.feature } : {}),
      ...(board ? { boardId: board.id } : {}),
      ...(board && stored.issueKey ? { issueKey: stored.issueKey } : {}),
      ...(stored.feature === 'sessions' && stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
      ...(stored.feature === 'sessions' && stored.browserOpen !== undefined ? { browserOpen: stored.browserOpen } : {}),
      ...(stored.feature === 'sessions' && stored.browserUrl ? { browserUrl: stored.browserUrl } : {}),
      ...(stored.feature === 'git' && stored.gitView ? { gitView: stored.gitView } : {}),
      ...(stored.feature === 'workflows' && stored.workflowId ? { workflowId: stored.workflowId } : {}),
      ...(stored.feature === 'workflows' && (stored.workflowView === 'runs' || stored.workflowView === 'policies')
        ? { workflowView: stored.workflowView }
        : {}),
      ...(stored.feature === 'workflows' && stored.workflowRunId ? { workflowRunId: stored.workflowRunId } : {}),
      ...(stored.feature === 'agents' && stored.agentId ? { agentId: stored.agentId } : {}),
      ...(stored.feature === 'agents' && stored.skillName ? { skillName: stored.skillName } : {})
    };
  }
  return routeForOpenedWorkspace(workspace, projects);
}

export function App() {
  const { settings, update: updateSettings } = useSettings();
  const { confirm } = useDialogs();
  const deleteRunFlow = useDeleteRun();
  const [appVersion, setAppVersion] = useState<string>();
  const newProjectEnabled = settings?.preview.enableNewProject ?? true;
  useEffect(() => {
    void window.praxis.app.getVersion().then(setAppVersion).catch(() => setAppVersion(undefined));
  }, []);
  const [nav, setNav] = useState<{ entries: Route[]; index: number }>({
    entries: [{}],
    index: 0
  });
  const route = nav.entries[nav.index];
  const inSession = route.feature === 'sessions' || route.feature === 'conversations';

  const [boards, setBoards] = useState<Board[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
  useEffect(() => { void window.praxis.workspaces.setActive(activeWorkspaceId); }, [activeWorkspaceId]);
  const [recentWorkspaceIds, setRecentWorkspaceIds] = useState(readRecentWorkspaceIds);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  // Whether `workspaces.list()` has returned at least once. The seed-on-first-run
  // effect must wait for this: on relaunch `projects.list()` resolves before
  // `workspaces.list()`, and gating on the still-empty `workspaces` array alone
  // re-seeds "My Workspace" every launch.
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [composerBoardId, setComposerBoardId] = useState<string>();
  const [connections, setConnections] = useState<Connection[]>([]);
  /** Agent sessions, most recent first — feeds the Sessions view and the sidebar badge. */
  const [agentSessions, setAgentSessions] = useState<AgentSessionRecord[]>([]);
  const [agentSessionsLoaded, setAgentSessionsLoaded] = useState(false);
  /** Conversations currently floating in their own window (FX-BE-143) — never
   *  rendered live in the main window's console at the same time. */
  const [detachedConversationKeys, setDetachedConversationKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void window.praxis.detachedChat.list().then(keys => { if (!cancelled) setDetachedConversationKeys(new Set(keys)); });
    const off = window.praxis.detachedChat.onChanged(keys => setDetachedConversationKeys(new Set(keys)));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const [boardDetails, setBoardDetails] = useState<BoardDetails | undefined>();
  const [detailsByBoardId, setDetailsByBoardId] = useState<Record<string, BoardDetails | undefined>>({});
  /** Latest health-check per connection id — feeds the sidebar status dots. */
  const [connectionChecks, setConnectionChecks] = useState<
    Record<string, ConnectionCheck | undefined>
  >({});
  const [mode, setMode] = useState<SidebarMode>(
    () => (localStorage.getItem('tm-sidebar-mode') as SidebarMode | null) ?? 'classic'
  );
  const [sidebarVisible, setSidebarVisible] = useState(() => readPaneVisible('tm-pane-sidebar-visible', true));
  const [auxVisible, setAuxVisible] = useState(() => readPaneVisible('tm-pane-aux-visible', true));
  const [panelVisible, setPanelVisible] = useState(() => readPaneVisible('tm-pane-panel-visible', false));
  const prevPanelsRef = useRef<{ sidebar: boolean; aux: boolean; panel: boolean } | null>(null);

  const toggleFocusMode = useCallback(() => {
    const isCurrentlyFocus = !sidebarVisible && !auxVisible && !panelVisible;
    if (isCurrentlyFocus) {
      const prev = prevPanelsRef.current;
      if (prev && (prev.sidebar || prev.aux || prev.panel)) {
        setSidebarVisible(prev.sidebar);
        setAuxVisible(prev.aux);
        setPanelVisible(prev.panel);
      } else {
        setSidebarVisible(true);
        setAuxVisible(true);
        setPanelVisible(false);
      }
    } else {
      prevPanelsRef.current = {
        sidebar: sidebarVisible,
        aux: auxVisible,
        panel: panelVisible
      };
      setSidebarVisible(false);
      setAuxVisible(false);
      setPanelVisible(false);
    }
  }, [sidebarVisible, auxVisible, panelVisible]);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [sidebarSearching, setSidebarSearching] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  /** The right-pane element a feature portals its inspector into (Workflows, Git Graph). */
  const [auxSlotEl, setAuxSlotEl] = useState<HTMLElement | null>(null);
  const requireAux = useCallback(() => setAuxVisible(true), []);
  /** Saved workflows per project, for the sidebar tree. */
  const [workflowsByProject, setWorkflowsByProject] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  /** Governed workflow choices for the New Session composer, including live readiness. */
  const [sessionWorkflowsByProject, setSessionWorkflowsByProject] = useState<Record<string, SessionWorkflowOption[]>>({});
  const [workflowsNonce, setWorkflowsNonce] = useState(0);
  const [pendingWorkflowPlan, setPendingWorkflowPlan] = useState<WorkflowPlanInput>();
  /** The start-run dialog, optionally preselecting a workflow. */
  const [startRunDialog, setStartRunDialog] = useState<{ projectId: string; workflowId?: string }>();
  const bumpWorkflows = useCallback(() => setWorkflowsNonce(n => n + 1), []);
  const [newWorkflowForProject, setNewWorkflowForProject] = useState<string>();
  /** The Agent Hub catalog. App owns it so the sidebar tree, the centre record,
   *  and the right-pane runtime all read one snapshot. */
  const [agentSnapshot, setAgentSnapshot] = useState<AgentRuntimeSnapshot>();
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentError, setAgentError] = useState<string>();
  const [activations, setActivations] = useState<ActivationMap>({});
  const [agentDialog, setAgentDialog] = useState<'agent' | 'profile' | 'skill' | 'import' | 'import-binding'>();

  const loadAgents = useCallback(async (hard: boolean) => {
    setAgentsBusy(true);
    setAgentError(undefined);
    try {
      setAgentSnapshot(hard ? await window.praxis.agentRuntime.refresh() : await window.praxis.agentRuntime.list());
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAgentsBusy(false);
    }
  }, []);
  useEffect(() => {
    void loadAgents(false);
  }, [loadAgents]);

  const runAgentAction = useCallback(async (run: () => Promise<AgentRuntimeSnapshot>) => {
    setAgentsBusy(true);
    setAgentError(undefined);
    try {
      setAgentSnapshot(await run());
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAgentsBusy(false);
    }
  }, []);

  useEffect(() => writePaneVisible('tm-pane-sidebar-visible', sidebarVisible), [sidebarVisible]);
  useEffect(() => writePaneVisible('tm-pane-aux-visible', auxVisible), [auxVisible]);
  useEffect(() => writePaneVisible('tm-pane-panel-visible', panelVisible), [panelVisible]);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [importProjectsOpen, setImportProjectsOpen] = useState(false);
  const ONBOARDED_KEY = 'praxis-onboarded';
  const WALKTHROUGH_KEY = 'praxis-walkthrough-seen';
  const [showSplash, setShowSplash] = useState(true);
  const [splashReplayKey, setSplashReplayKey] = useState(0);
  // A returning user — past Getting Started at least once — gets the short
  // brand mark rather than the full 6.5s crawl.
  const [splashBrief] = useState(() => { try { return localStorage.getItem(ONBOARDED_KEY) === '1'; } catch { return false; } });
  const [settingsDialogCategory, setSettingsDialogCategory] = useState<SettingsCategory>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [boardSettingsOpenFor, setBoardSettingsOpenFor] = useState<string>();
  const [projectDocument, setProjectDocument] = useState<ProjectDocument>();
  const [projectWizardMode, setProjectWizardMode] = useState<'create' | 'existing'>();
  const [projectWizardStartingPoint, setProjectWizardStartingPoint] = useState<AddProjectChoice['startingPoint']>();
  const [projectWizardPresentation, setProjectWizardPresentation] = useState<'dialog' | 'onboarding'>('dialog');
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [startupResolved, setStartupResolved] = useState(false);
  const [gettingStarted, setGettingStarted] = useState(true);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string>();
  const [selectedDesignerNode, setSelectedDesignerNode] = useState<TaskDesignerCanvasNode>();
  const [boardFilterState, setBoardFilterState] = useState<{
    boardId: string;
    value: BoardFilterValue;
  }>();
  const [boardFilterPresentation, setBoardFilterPresentation] = useState<{
    boardId: string;
    value: BoardFilterPresentation;
  }>();
  const validatedTicketRef = useRef<string>();
  const restoredTicketKeyRef = useRef<string>();

  useEffect(() => {
    if (!settings || startupResolved || !workspacesLoaded || !projectsLoaded || !boardsLoaded || !agentSessionsLoaded) return;
    const savedWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? undefined;
    const savedWorkspace = workspaces.find(workspace => workspace.id === savedWorkspaceId);
    if (settings.startup.reopenLastWorkspace && savedWorkspace) {
      setActiveWorkspaceId(savedWorkspace.id);
      const storedRoute = readLastWorkspaceRoute(savedWorkspace.id);
      let restored = restoredRouteForWorkspace(storedRoute, savedWorkspace, projects, boards, connections);
      restoredTicketKeyRef.current = restored.issueKey;
      if (restored.feature === 'sessions' && restored.sessionKey && !agentSessions.some(session => session.issueKey === restored.sessionKey)) {
        restored = { ...restored, sessionKey: undefined, browserOpen: undefined, browserUrl: undefined };
      }
      setNav({ entries: [restored], index: 0 });
      setGettingStarted(false);
    } else {
      setActiveWorkspaceId(undefined);
      setGettingStarted(true);
      if (savedWorkspaceId && !savedWorkspace) localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    }
    const validIds = new Set(workspaces.map(workspace => workspace.id));
    const cleanedRecentIds = recentWorkspaceIds.filter(id => validIds.has(id));
    setRecentWorkspaceIds(cleanedRecentIds);
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(cleanedRecentIds));
    setStartupResolved(true);
  }, [agentSessions, agentSessionsLoaded, boards, boardsLoaded, projects, projectsLoaded, recentWorkspaceIds, settings, startupResolved, workspaces, workspacesLoaded]);

  useEffect(() => {
    if (startupResolved && activeWorkspaceId && !gettingStarted) writeLastWorkspaceRoute(activeWorkspaceId, route);
  }, [activeWorkspaceId, gettingStarted, route, startupResolved]);

  // Praxis is of no use without AI, so a profile that has never had a usable
  // provider is stopped at the AI setup wizard before Getting Started. Anyone
  // who already has one (an existing install) is marked done silently, and the
  // flag means a later key removal never traps them behind the wizard again —
  // Settings → AI Provider is where that gets fixed.
  const [aiSetupNeeded, setAiSetupNeeded] = useState(false);
  useEffect(() => {
    let flagged = false;
    try { flagged = localStorage.getItem(AI_ONBOARDED_KEY) === '1'; } catch { /* private mode */ }
    if (flagged) return;
    let cancelled = false;
    void window.praxis.ai.listProviderStatuses().then(statuses => {
      if (cancelled) return;
      if (hasUsableProvider(statuses)) {
        try { localStorage.setItem(AI_ONBOARDED_KEY, '1'); } catch { /* private mode */ }
      } else {
        setAiSetupNeeded(true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (startupResolved && !gettingStarted) { try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* private mode */ } }
  }, [startupResolved, gettingStarted]);

  // Active (non-archived) sessions — the sidebar tree, focus tabs, and
  // implicit selection all speak this list; archived sessions stay reachable
  // only through the inspector's Sessions browser tab.
  const activeSessions = agentSessions.filter(session => !session.archived);


  useEffect(() => {
    if (!settingsDialogCategory) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsDialogCategory(undefined);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [settingsDialogCategory]);

  const sidebar = useResizable({
    storageKey: 'tm-pane-sidebar',
    initial: 260,
    min: 180,
    max: 800,
    side: 'left'
  });
  const aux = useResizable({
    storageKey: 'tm-pane-aux',
    initial: 380,
    min: 280,
    max: 640,
    side: 'right'
  });
  const panel = useResizable({
    storageKey: 'tm-pane-panel',
    initial: 220,
    min: 120,
    max: 560,
    side: 'bottom'
  });
  const projectDoc = useResizable({
    storageKey: 'tm-pane-project-doc',
    initial: 420,
    min: 280,
    max: 860,
    side: 'left'
  });

  const navigate = useCallback((next: Route) => {
    setNav(current => {
      const entries = [...current.entries.slice(0, current.index + 1), next];
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const openBoard = useCallback((boardId: string) => {
    setAuxVisible(true);
    navigate({ boardId });
  }, [navigate]);

  const updateSessionBrowserRoute = useCallback((patch: Pick<Route, 'browserOpen' | 'browserUrl'>) => {
    setNav(current => {
      const currentRoute = current.entries[current.index];
      if (currentRoute.feature !== 'sessions' && currentRoute.feature !== 'conversations') return current;
      const nextOpen = patch.browserOpen ?? currentRoute.browserOpen;
      const nextUrl = patch.browserUrl ?? currentRoute.browserUrl;
      // No-op when nothing actually changed — otherwise the BrowserPane's
      // onDidNavigate → route update → re-render can loop.
      if (nextOpen === currentRoute.browserOpen && nextUrl === currentRoute.browserUrl) {
        return current;
      }
      const entries = [...current.entries];
      entries[current.index] = { ...currentRoute, browserOpen: nextOpen, browserUrl: nextUrl };
      return { ...current, entries };
    });
  }, []);

  const handleBrowserOpenChange = useCallback(
    (browserOpen: boolean) => updateSessionBrowserRoute({ browserOpen }),
    [updateSessionBrowserRoute]
  );
  const handleBrowserUrlChange = useCallback(
    (browserUrl: string) => {
      if (restorableBrowserUrl(browserUrl)) updateSessionBrowserRoute({ browserUrl });
    },
    [updateSessionBrowserRoute]
  );

  const handleFilterPresentationChange = useCallback(
    (boardId: string, value: BoardFilterPresentation) => {
      setBoardFilterPresentation({ boardId, value });
    },
    []
  );

  const handleDesignerSelectionChange = useCallback((node: TaskDesignerCanvasNode | undefined) => {
    setSelectedDesignerNode(node);
    if (node) {
      setAuxVisible(true);
    }
  }, []);

  const handleDesignerBoardTicketSelect = useCallback((issue: IssueSummary) => {
    const node: TaskDesignerTicketNode = {
      type: 'ticket',
      id: `board-ticket:${issue.key}`,
      issueKey: issue.key,
      summary: issue.summary,
      issueType: issue.issueType,
      status: issue.status,
      assignee: issue.assignee,
      priority: issue.priority,
      projectKey: issue.projectKey,
      x: 0,
      y: 0
    };
    setSelectedDesignerNode(node);
    setAuxVisible(true);
  }, []);

  // Both refreshers swallow-and-log rather than leaving the promise unhandled:
  // an IPC rejection used to silently leave the app on its previous (often
  // empty) list with nothing in the console to explain it.
  const refreshBoards = useCallback(() => {
    void window.praxis.board
      .list(EMPTY_FILTERS)
      .then(items => { setBoards(items); setBoardsLoaded(true); })
      .catch(error => { setBoardsLoaded(true); console.error('Failed to load boards:', error); });
  }, []);

  const refreshConnections = useCallback(() => {
    void window.praxis.connection
      .list()
      .then(setConnections)
      .catch(error => console.error('Failed to load connections:', error));
  }, []);

  const refreshProjects = useCallback(() => {
    void window.praxis.projects.list()
      .then(items => { setProjects(items); setProjectsLoaded(true); })
      .catch(error => { setProjectsLoaded(true); console.error('Failed to load projects:', error); });
  }, []);

  const refreshWorkspaces = useCallback(() => {
    void window.praxis.workspaces.list().then(items => {
      setWorkspaces(items);
      setWorkspacesLoaded(true);
    }).catch(error => { setWorkspacesLoaded(true); console.error('Failed to load workspaces:', error); });
  }, []);

  useEffect(() => {
    refreshBoards();
    refreshConnections();
    refreshProjects();
    refreshWorkspaces();
  }, [refreshBoards, refreshConnections, refreshProjects, refreshWorkspaces]);

  const touchWorkspace = useCallback((workspaceId: string) => {
    setRecentWorkspaceIds(current => {
      const next = [workspaceId, ...current.filter(id => id !== workspaceId)];
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const openWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find(candidate => candidate.id === workspaceId);
    if (!workspace) {
      setGettingStarted(true);
      return;
    }
    setActiveWorkspaceId(workspaceId);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    touchWorkspace(workspaceId);
    setCreatedWorkspaceId(undefined);
    setGettingStarted(false);
    // Opening a workspace by hand resumes where you were in *that* workspace.
    // A bare `newSession` route is what gets stored when nothing was open, and
    // it names no place — choosing a workspace from a list is a request to go
    // into it, so its own landing route (the default project) wins there. At
    // launch the stored route is honoured as-is: that is "carry on exactly
    // where I left off", which is a different question.
    const stored = readLastWorkspaceRoute(workspaceId);
    const locates = Boolean(stored.projectId || stored.boardId || stored.feature);
    setNav({
      entries: [locates
        ? restoredRouteForWorkspace(stored, workspace, projects, boards, connections)
        : routeForOpenedWorkspace(workspace, projects)],
      index: 0
    });
  }, [boards, connections, projects, touchWorkspace, workspaces]);

  const closeWorkspace = useCallback(() => {
    setActiveWorkspaceId(undefined);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    setCreatedWorkspaceId(undefined);
    setProjectWizardMode(undefined);
    setGettingStarted(true);
    setNav({ entries: [{ feature: 'overview' }], index: 0 });
  }, []);

  // Remove a saved workspace. The projects it grouped are untouched — only the
  // named context goes. If it was the active one, fall back to the first that
  // remains (or "All projects" when none do).
  const deleteWorkspace = useCallback((workspaceId: string) => {
    void window.praxis.workspaces.remove(workspaceId).then(() => {
      setWorkspaces(current => current.filter(item => item.id !== workspaceId));
      if (workspaceId === activeWorkspaceId) {
        setActiveWorkspaceId(undefined);
        localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
        setGettingStarted(true);
      }
      setRecentWorkspaceIds(current => {
        const next = current.filter(id => id !== workspaceId);
        localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
        return next;
      });
    }).catch(error => console.error('Failed to delete workspace:', error));
  }, [activeWorkspaceId, workspaces]);

  const createWorkspace = useCallback(() => setWorkspaceDialogOpen(true), []);

  const saveNewWorkspace = useCallback((name: string, description: string, storageFolder?: string) => {
    void window.praxis.workspaces.create({ name, description, projectIds: [], storageFolder }).then(workspace => {
      setWorkspaces(current => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
      touchWorkspace(workspace.id);
      setNav({ entries: [{ feature: 'overview' }], index: 0 });
      setWorkspaceDialogOpen(false);
    }).catch(error => console.error('Failed to create workspace:', error));
  }, [touchWorkspace]);

  const createWorkspaceFromGettingStarted = useCallback(async (name: string) => {
    const workspace = await window.praxis.workspaces.create({ name, projectIds: [] });
    setWorkspaces(current => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    touchWorkspace(workspace.id);
    setCreatedWorkspaceId(workspace.id);
    setNav({ entries: [{ feature: 'overview' }], index: 0 });
  }, [touchWorkspace]);

  const createFileOnlyProjectInWorkspace = useCallback(async (workspaceId: string, folder: string) => {
    const inspection = await window.praxis.projects.inspectFolder(folder);
    if (!inspection.exists || !inspection.isDirectory) throw new Error('Choose an existing project folder.');
    const folderName = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';
    const compactKey = folderName.replace(/[^A-Za-z0-9]+/g, '').slice(0, 8).toUpperCase();
    const key = (/^[A-Z]/.test(compactKey) ? compactKey : `P${compactKey}`).slice(0, 15) || 'PROJECT';
    const project = await window.praxis.projects.create({
      name: folderName,
      key,
      type: 'software',
      purpose: '',
      brief: {},
      startingPoint: 'existing-folder',
      folderPath: folder,
      workflowStages: [
        { id: 'stage-1', name: 'Backlog', category: 'todo' },
        { id: 'stage-2', name: 'Done', category: 'done' }
      ],
      starterTickets: [],
      defaultAiToolMode: 'full',
      storage: 'app',
      planningMode: 'files'
    }, workspaceId);
    return project;
  }, []);

  const openExistingFolder = useCallback(async (preselectedFolder?: string) => {
    const folder = preselectedFolder ?? await window.praxis.dialog.pickFolder('Open existing project folder');
    if (!folder) return false;
    const workspace = await window.praxis.workspaces.openFolder(folder);
    if (!workspace) throw new Error('Praxis could not open that folder.');
    await window.praxis.workspaces.setActive(workspace.id);
    setWorkspaces(current => [...current.filter(item => item.id !== workspace.id), workspace]);
    setActiveWorkspaceId(workspace.id);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    touchWorkspace(workspace.id);
    const normalizedFolder = folder.replace(/[\\/]+$/, '').toLowerCase();
    const existing = (await window.praxis.projects.list()).find(project =>
      workspace.projectIds.includes(project.id) &&
      project.workspaceFolder?.replace(/[\\/]+$/, '').toLowerCase() === normalizedFolder
    );
    const project = existing ?? await createFileOnlyProjectInWorkspace(workspace.id, folder);
    setProjects(current => [...current.filter(item => item.id !== project.id), project]);
    setWorkspaces(current => current.map(item => item.id === workspace.id
      ? { ...item, projectIds: [...new Set([...item.projectIds, project.id])], defaultProjectId: item.defaultProjectId ?? project.id }
      : item));
    setCreatedWorkspaceId(undefined);
    setGettingStarted(false);
    refreshBoards();
    refreshConnections();
    navigate({ projectId: project.id });
    void updateSettings({ preview: { enableEasyMode: true } });
    return true;
  }, [createFileOnlyProjectInWorkspace, navigate, refreshBoards, refreshConnections, touchWorkspace, updateSettings]);

  // "Skip for now" means "get out of my way", not "leave me stranded". Without
  // an active workspace the shell cannot create or import a project at all —
  // Add Project bounces straight back here and the New menu's import
  // entry is disabled — so skipping still lands on a usable workspace: the most
  // recent one if any exist, otherwise the same implicit one a first project
  // would have created.
  const skipWorkspaceSetup = useCallback(async () => {
    setCreatedWorkspaceId(undefined);
    if (activeWorkspaceId && workspaces.some(workspace => workspace.id === activeWorkspaceId)) {
      setGettingStarted(false);
      setNav({ entries: [{ feature: 'overview' }], index: 0 });
      return;
    }
    const existing = workspaces.find(workspace => workspace.id === recentWorkspaceIds[0]) ?? workspaces[0];
    const workspace = existing ?? await window.praxis.workspaces.create({ name: 'My workspace', projectIds: [] });
    if (!existing) setWorkspaces(current => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id); } catch { /* private mode */ }
    touchWorkspace(workspace.id);
    setGettingStarted(false);
    setNav({ entries: [{ feature: 'overview' }], index: 0 });
  }, [activeWorkspaceId, recentWorkspaceIds, touchWorkspace, workspaces]);

  const saveWorkspaceToFile = useCallback(() => {
    if (activeWorkspaceId) {
      void window.praxis.workspaces.saveToFile(activeWorkspaceId).catch(error => console.error('Failed to save workspace:', error));
    }
  }, [activeWorkspaceId]);

  const openWorkspaceFromFile = useCallback(() => {
    void window.praxis.workspaces.openFromFile().then(workspace => {
      if (!workspace) return;
      setWorkspaces(current => [...current.filter(item => item.id !== workspace.id), workspace]);
      setActiveWorkspaceId(workspace.id);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
      touchWorkspace(workspace.id);
      setCreatedWorkspaceId(undefined);
      setGettingStarted(false);
      setNav({ entries: [routeForOpenedWorkspace(workspace, projects)], index: 0 });
    }).catch(error => console.error('Failed to open workspace:', error));
  }, [projects, touchWorkspace]);

  const requestAddProject = useCallback((presentation: 'dialog' | 'onboarding' = 'dialog') => {
    if (!activeWorkspaceId || !workspaces.some(workspace => workspace.id === activeWorkspaceId)) {
      setGettingStarted(true);
      return;
    }
    setGettingStarted(false);
    setProjectWizardPresentation(presentation);
    setAddProjectOpen(true);
  }, [activeWorkspaceId, workspaces]);

  const chooseAddProject = useCallback((choice: AddProjectChoice) => {
    setAddProjectOpen(false);
    setProjectWizardStartingPoint(choice.startingPoint);
    setProjectWizardMode(choice.mode);
  }, []);

  // Connection health dots: run `connection.check` lazily per non-demo
  // connection, fire-and-forget. A dead or slow backend must never block (or
  // blank) the board list — results land as they resolve.
  useEffect(() => {
    let cancelled = false;
    setConnectionChecks(current => {
      const ids = new Set(connections.map(connection => connection.id));
      const kept: Record<string, ConnectionCheck | undefined> = {};
      for (const id of Object.keys(current)) {
        if (ids.has(id)) {
          kept[id] = current[id];
        }
      }
      return kept;
    });
    for (const connection of connections) {
      if (connection.mode === 'demo') {
        continue;
      }
      void window.praxis.connection
        .check(connection.id)
        .then(result => {
          if (!cancelled) {
            setConnectionChecks(current => ({ ...current, [connection.id]: result }));
          }
        })
        .catch(error => {
          if (!cancelled) {
            setConnectionChecks(current => ({
              ...current,
              [connection.id]: {
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
                toolCount: 0
              }
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [connections]);

  // Agent sessions: initial pull, then live-merge every pushed record (keyed by
  // issueKey, kept most-recent-first to match `ai:listSessions` ordering).
  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
      .listSessions()
      .then(sessions => {
        if (!cancelled) {
          setAgentSessions(sessions);
          setAgentSessionsLoaded(true);
        }
      })
      .catch(error => {
        setAgentSessionsLoaded(true);
        console.error('Failed to load AI sessions:', error);
      });
    const unsubscribeChanged = window.praxis.ai.onSessionChanged(record => {
      setAgentSessions(current => {
        const rest = current.filter(session => session.issueKey !== record.issueKey);
        return [record, ...rest].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      });
    });
    const unsubscribeDeleted = window.praxis.ai.onSessionDeleted(issueKey => {
      setAgentSessions(current => current.filter(session => session.issueKey !== issueKey));
    });
    return () => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeDeleted();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('tm-sidebar-mode', mode);
  }, [mode]);

  useEffect(() => {
    if (!route.issueKey) {
      setDetailExpanded(false);
    }
  }, [route.issueKey]);

  const selectedBoard = useMemo(
    () => boards.find(board => board.id === route.boardId),
    [boards, route.boardId]
  );

  useEffect(() => {
    if (!startupResolved || !activeWorkspaceId || !route.issueKey || route.issueKey !== restoredTicketKeyRef.current || !selectedBoard) return;
    const validationKey = `${selectedBoard.id}:${route.issueKey}`;
    if (validatedTicketRef.current === validationKey) return;
    validatedTicketRef.current = validationKey;
    let cancelled = false;
    void window.praxis.issue.get(route.issueKey, selectedBoard.connectionId).catch(() => {
      if (cancelled) return;
      setNav(current => {
        const currentRoute = current.entries[current.index];
        if (currentRoute.issueKey !== route.issueKey) return current;
        const entries = [...current.entries];
        entries[current.index] = { ...currentRoute, issueKey: undefined, view: undefined, newIssue: undefined, newIssueType: undefined };
        return { ...current, entries };
      });
    });
    return () => { cancelled = true; };
  }, [activeWorkspaceId, route.issueKey, selectedBoard, startupResolved]);
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId);
  const workspaceProjects = activeWorkspace
    ? projects.filter(project => activeWorkspace.projectIds.includes(project.id))
    : [];
  const selectedProject = workspaceProjects.find(project => project.id === route.projectId);

  const agentSelection: CatalogSelection | undefined =
    route.feature !== 'agents'
      ? undefined
      : route.agentProfileId
        ? { kind: 'profile', id: route.agentProfileId }
        : route.agentId
          ? { kind: 'agent', id: route.agentId }
          : route.skillName
            ? { kind: 'skill', name: route.skillName }
            : undefined;

  const activateSkill = useCallback(
    (agentId: string, skillName: string) =>
      void runAgentAction(async () => {
        const result = await window.praxis.agentRuntime.activateSkill(agentId, skillName);
        setActivations(current => ({
          ...current,
          [agentId]: [...(current[agentId] ?? []).filter(a => a.skill !== skillName), { skill: skillName, mode: result.mode }]
        }));
        return window.praxis.agentRuntime.list();
      }),
    [runAgentAction]
  );

  const agentLifecycle = useCallback(
    (agentId: string, action: LifecycleAction) =>
      void runAgentAction(() =>
        action === 'stop'
          ? window.praxis.agentRuntime.stop(agentId)
          : action === 'restart'
            ? window.praxis.agentRuntime.restart(agentId)
            : window.praxis.agentRuntime.start(agentId)
      ),
    [runAgentAction]
  );

  // The saved workflows shown as child nodes under each project's Workflows row.
  const workspaceProjectIds = workspaceProjects.map(project => project.id).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = workspaceProjectIds ? workspaceProjectIds.split(',') : [];
    void Promise.all(
      ids.map(async id => {
        const templates = await window.praxis.workflows.listTemplates(id).catch(() => []);
        const readiness = await window.praxis.workflows.templateReadiness(id).catch(() => []);
        const readinessById = new Map(readiness.map(item => [item.templateId, item]));
        const projectTemplates = templates.filter(t => t.source === 'project');
        const instantiatedTemplateIds = new Set(
          templates
            .filter(t => t.source !== 'project')
            .filter(t => projectTemplates.some(project => project.definition.id === `${t.definition.id}-${id}`))
            .map(t => t.definition.id)
        );
        const seenIds = new Set<string>();
        const availableTemplates = [
          ...projectTemplates,
          ...templates.filter(t => t.source !== 'project' && !instantiatedTemplateIds.has(t.definition.id))
        ].filter(t => {
          if (seenIds.has(t.definition.id)) return false;
          seenIds.add(t.definition.id);
          return true;
        });
        const sessionOptions: SessionWorkflowOption[] = availableTemplates.map(template => {
          const status = readinessById.get(template.definition.id);
          const blockers = status
            ? Object.values(status.blockingByNode)
            : ['Live workflow readiness could not be checked.'];
          return {
            id: template.definition.id,
            name: template.definition.name,
            ...(template.definition.description ? { description: template.definition.description } : {}),
            version: template.definition.version,
            ready: !!status?.structureOk && !!status?.agentsOk,
            ...(blockers.length > 0 ? { blockers } : {})
          };
        });
        return [id, {
          names: projectTemplates.map(t => ({ id: t.definition.id, name: t.definition.name })),
          options: sessionOptions
        }] as const;
      })
    ).then(entries => {
      if (!cancelled) {
        setWorkflowsByProject(Object.fromEntries(entries.map(([id, value]) => [id, value.names])));
        setSessionWorkflowsByProject(Object.fromEntries(entries.map(([id, value]) => [id, value.options])));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceProjectIds, workflowsNonce]);
  // The project a workspace-level "New session" belongs to: the one on screen,
  // else the workspace's default project, else its only project. When one is
  // resolved the composer scopes to it (its folder, no board/ticket picker).
  const composerProject = selectedProject
    ?? workspaceProjects.find(project => project.id === activeWorkspace?.defaultProjectId)
    ?? (workspaceProjects.length === 1 ? workspaceProjects[0] : undefined);
  const easyModeProject = selectedProject
    ?? workspaceProjects.find(project => project.id === activeWorkspace?.defaultProjectId)
    ?? (workspaceProjects.length > 0 ? workspaceProjects[0] : undefined);

  // In EasyMode, scope sessions and automations to the active folder/project.
  // Exclude internal automation stage sessions so SESSIONS only lists user-initiated sessions.
  const easyModeSessions = useMemo(() => {
    const standalone = activeSessions.filter(session => !session.workflowRunId);
    if (!easyModeProject) return standalone;
    return standalone.filter(session => isSessionForProject(session, easyModeProject, agentSessions));
  }, [easyModeProject, activeSessions, agentSessions]);

  // The sessions view selects its newest session when no explicit selection was
  // routed to it. Make that implicit selection durable too, so a restart opens
  // the same conversation rather than merely the sessions list. In EasyMode,
  // scope this auto-selection to the active folder/project's sessions so an
  // unrelated conversation does not pop open on folder open or sessions navigation.
  useEffect(() => {
    const list = settings?.preview.enableEasyMode ? easyModeSessions : activeSessions;
    if (!startupResolved || route.feature !== 'sessions' || route.sessionKey || !list[0]) return;
    setNav(current => {
      const currentRoute = current.entries[current.index];
      if (currentRoute.feature !== 'sessions' || currentRoute.sessionKey) return current;
      const entries = [...current.entries];
      entries[current.index] = { ...currentRoute, sessionKey: list[0].issueKey };
      return { ...current, entries };
    });
  }, [agentSessions, easyModeSessions, route.feature, route.sessionKey, settings?.preview.enableEasyMode, startupResolved]);
  /** The workflow a quick session starts under: the project's quick-change
   *  template (already instantiated or not), only when it is actually ready. */
  const quickSessionWorkflowId = composerProject
    ? (sessionWorkflowsByProject[composerProject.id] ?? []).find(option => option.ready && (
        option.id === QUICK_CHANGE_TEMPLATE_ID
        || option.id === `${QUICK_CHANGE_TEMPLATE_ID}-${composerProject.id}`
      ))?.id
    : undefined;
  const openQuickSession = useCallback(() => {
    navigate({ newSession: true, quickSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) });
  }, [composerProject, navigate]);
  const activeProjectId = selectedProject?.id
    ?? (selectedBoard?.connectionId ? projectIdForConnection(selectedBoard.connectionId, connections) : undefined)
    ?? composerProject?.id;
  const workspaceBoards = activeWorkspace
    ? boards.filter(board => {
        const directProjectId = projectIdForConnection(board.connectionId, connections);
        return directProjectId ? activeWorkspace.projectIds.includes(directProjectId) : true;
      })
    : [];

  // Match BoardView's previous keyed-local-state behaviour: selecting another
  // board starts with a clean query instead of reviving criteria from the last
  // board visited.
  useEffect(() => {
    setBoardFilterState(undefined);
    setBoardFilterPresentation(undefined);
  }, [selectedBoard?.id]);

  useEffect(() => {
    if (route.view !== 'designer') {
      setSelectedDesignerNode(undefined);
    } else {
      setSidebarVisible(true);
    }
  }, [route.view, route.boardId]);

  /** Bumped when something outside the detail pane (an applied AI review) edits the open ticket. */
  const [issueRefreshToken, setIssueRefreshToken] = useState(0);

  const refreshBoardDetails = useCallback(() => {
    if (selectedBoard) {
      void window.praxis.board.get(selectedBoard).then(setBoardDetails);
    }
  }, [selectedBoard]);

  /**
   * Resolves the workflow transition whose `toStatus` matches the column's
   * display name. Returned as a hook so the move handler can `await` it.
   * Returns undefined when the backend has no matching transition (the view's
   * optimistic update never happens — the card stays put).
   */
  const getMoveTransition = useCallback(
    async (issueKey: string, moveConnectionId: string | undefined, targetStatus: string) => {
      const issue = await window.praxis.issue.get(issueKey, moveConnectionId);
      const transitions = issue?.transitions ?? [];
      return findTransitionToTargetStatus(transitions, targetStatus);
    },
    []
  );

  /**
   * Moves a card to a different column by resolving a workflow transition and
   * applying it through the same IPC the "Change Status" command uses.
   */
  const onIssueMove = useCallback(
    async (issueKey: string, targetStatus: string, moveConnectionId: string | undefined): Promise<boolean> => {
      try {
        const transition = await getMoveTransition(issueKey, moveConnectionId, targetStatus);
        if (!transition) {
          console.warn(
            `[board] no workflow transition matches target status "${targetStatus}" for ${issueKey}`
          );
          return false;
        }
        await window.praxis.issue.transition(issueKey, transition.id, moveConnectionId);
        await refreshBoardDetails();
        return true;
      } catch (error) {
        console.error(`[board] failed to move ${issueKey} to "${targetStatus}"`, error);
        return false;
      }
    },
    [getMoveTransition, refreshBoardDetails]
  );

  useEffect(() => {
    if (!selectedBoard) {
      setBoardDetails(undefined);
      return;
    }
    void window.praxis.board.get(selectedBoard).then(setBoardDetails);
  }, [selectedBoard]);

  /** Work mode needs every board's issues at once, not just the selected one. */
  useEffect(() => {
    if (mode !== 'work' || boards.length === 0) {
      return;
    }
    let cancelled = false;
    void Promise.all(
      boards.map(async board => [board.id, await window.praxis.board.get(board)] as const)
    ).then(pairs => {
      if (!cancelled) {
        setDetailsByBoardId(Object.fromEntries(pairs));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode, boards]);

  const assistant = useAssistant();
  const { setProjectId: setAssistantProject, setSessionDelegate: setAssistantDelegate, toggle: toggleAssistant } = assistant;
  useEffect(() => setAssistantProject(activeProjectId), [activeProjectId, setAssistantProject]);
  useEffect(() => {
    setAssistantDelegate(prompt => navigate({ newSession: true, newSessionGoal: prompt, ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
    return () => setAssistantDelegate(undefined);
  }, [activeProjectId, navigate, setAssistantDelegate]);

  useEffect(() => {
    // Until AI is set up, none of the app's global shortcuts may start a
    // session, open the palette or navigate: the shell they act on isn't there.
    if (aiSetupNeeded) { setPaletteOpen(false); return; }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openQuickSession();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        navigate({});
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        toggleAssistant();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void updateSettings({ preview: { enableEasyMode: !settings?.preview?.enableEasyMode } });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aiSetupNeeded, navigate, openQuickSession, toggleAssistant, settings?.preview?.enableEasyMode, updateSettings]);

  const featureCounts = useMemo<Partial<Record<FeatureId, number>>>(
    () => ({
      sessions: agentSessions.filter(session => !isTerminalAgentState(session.state) && !isConversationSession(session)).length,
      conversations: agentSessions.filter(session => !isTerminalAgentState(session.state) && isConversationSession(session)).length,
      connections: connections.length
    }),
    [connections, agentSessions]
  );

  /**
   * ⌘K issue search. Issues aren't held in App state (each board pages its own
   * from `issue:list`), so unlike every other palette entry this can't be a
   * static index — it queries each board's connection directly, scoped by that
   * board's `boardId`/`projectKey` the same way `BoardView.scopedFilters` does.
   * Boards are queried in parallel and a failure on one connection (e.g. an
   * unreachable Jira site) never blocks the others.
   */
  const searchIssues = useCallback(
    async (query: string): Promise<CommandEntry[]> => {
      const perBoardLimit = 6;
      const results = await Promise.allSettled(
        workspaceBoards.map(async board => {
          const filters: IssueFilters = {
            projectKeys: board.projectKey ? [board.projectKey] : [],
            statuses: [],
            issueTypes: [],
            searchText: query,
            assigneeMode: 'all',
            boardId: board.id,
            grouping: 'none'
          };
          const page = await window.praxis.issue.list(filters, 0, perBoardLimit, board.connectionId);
          return { board, issues: page.issues };
        })
      );
      const entries: CommandEntry[] = [];
      results.forEach(result => {
        if (result.status !== 'fulfilled') return;
        const { board, issues } = result.value;
        issues.forEach(issue => {
          entries.push({
            id: `issue:${board.id}:${issue.key}`,
            label: issue.key,
            hint: issue.summary,
            group: 'Issues',
            icon: 'ticket',
            keywords: `${issue.summary} ${issue.status} ${issue.issueType}`,
            run: () => navigate({ boardId: board.id, issueKey: issue.key })
          });
        });
      });
      return entries.slice(0, 25);
    },
    [workspaceBoards, navigate]
  );

  /** One flat index for ⌘K — see CommandPalette. Rebuilt when the underlying
   *  collections change; the run callbacks reuse the same navigation the
   *  sidebar and dialogs already use. */
  // Every project's runs, newest first. They are the children of a project's
  // Runs node in the sidebar and entries in the command palette; refreshed
  // whenever the orchestrator advances (or deletes) any run.
  const [runsByProjectId, setRunsByProjectId] = useState<Record<string, WorkflowRunSummary[]>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all(
        workspaceProjects.map(async project => [project.id, await window.praxis.workflows.listRuns(project.id).catch(() => [])] as const)
      )
        .then(entries => { if (!cancelled) setRunsByProjectId(Object.fromEntries(entries)); })
        .catch(error => console.error('Failed to load workflow runs:', error));
    };
    load();
    const unsubscribe = window.praxis.workflows.onRunChanged(() => load());
    return () => { cancelled = true; unsubscribe(); };
  }, [projects, activeWorkspaceId]);

  const paletteEntries = useMemo<CommandEntry[]>(() => {
    const entries: CommandEntry[] = [];
    entries.push({ id: 'assistant:toggle', label: 'Ask the virtual team', hint: '⌘J', group: 'Go to', icon: 'sparkles', keywords: 'assistant ai chat tech lead qa security', run: toggleAssistant });
    (Object.keys(FEATURE_TITLES) as FeatureId[]).forEach(feature => {
      if (feature === 'deployments' && !settings?.preview?.enableDeployments) return;
      entries.push({
        id: `feature:${feature}`,
        label: FEATURE_TITLES[feature],
        group: 'Go to',
        icon: feature === 'git' ? 'git-branch' : feature === 'run' ? 'server' : feature === 'deployments' ? 'rocket' : feature === 'agents' ? 'zap' : feature === 'sessions' ? 'robot' : feature === 'conversations' ? 'chats' : 'home',
        run: () => navigate((feature === 'git' || feature === 'run' || feature === 'deployments') && selectedProject ? { projectId: selectedProject.id, feature } : { feature })
      });
    });
    entries.push({ id: 'action:new-session', label: 'New session', group: 'Go to', icon: 'plus', keywords: 'start agent', run: () => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) }) });
    entries.push({ id: 'action:new-conversation', label: 'New conversation', group: 'Go to', icon: 'chats', keywords: 'chat talk brainstorm ask', run: () => navigate({ newConversation: true }) });
    entries.push({ id: 'action:quick-session', label: 'Quick session', group: 'Go to', icon: 'zap', keywords: 'quick change workflow fast immediate', run: openQuickSession });
    entries.push({ id: 'action:add-project', label: 'Add project', group: 'Go to', icon: 'plus', keywords: 'new existing folder import', run: () => requestAddProject() });
    entries.push({ id: 'action:open-folder', label: 'Open folder', group: 'Go to', icon: 'folder', keywords: 'open folder directory existing project easy mode', run: () => void openExistingFolder() });
    entries.push({ id: 'action:toggle-easymode', label: 'Toggle EasyMode', hint: '⌘⇧E', group: 'Go to', icon: 'feather', keywords: 'toggle easy mode advance mode simple sidebar shortcut', run: () => void updateSettings({ preview: { enableEasyMode: !settings?.preview?.enableEasyMode } }) });
    entries.push({ id: 'action:toggle-work-mode', label: 'Toggle work mode', group: 'Go to', icon: 'columns', keywords: 'work mode boards classic', run: () => setMode(m => m === 'classic' ? 'work' : 'classic') });
    if (inSession) {
      entries.push({ id: 'action:toggle-focus-mode', label: 'Toggle focus mode', group: 'Go to', icon: 'layout-focus', keywords: 'zen hide panels sidebars focus', run: toggleFocusMode });
    }
    workspaceProjects.forEach(project => {
      entries.push({ id: `project:${project.id}`, label: project.name, hint: `${project.key} · ${project.type}`, group: 'Projects', icon: 'folder-open', run: () => navigate({ projectId: project.id }) });
      entries.push({ id: `project-git:${project.id}`, label: `${project.name}: Git graph`, hint: project.key, group: 'Projects', icon: 'git-branch', keywords: 'repository history commits', run: () => navigate({ projectId: project.id, feature: 'git' }) });
      entries.push({ id: `project-run:${project.id}`, label: `${project.name}: Run`, hint: project.key, group: 'Projects', icon: 'server', keywords: 'run profile services launch', run: () => navigate({ projectId: project.id, feature: 'run' }) });
      if (settings?.preview?.enableDeployments) {
        entries.push({ id: `project-deployments:${project.id}`, label: `${project.name}: Deployments`, hint: project.key, group: 'Projects', icon: 'rocket', keywords: 'deploy deployment profile target executor', run: () => navigate({ projectId: project.id, feature: 'deployments' }) });
      }
      entries.push({ id: `runs:${project.id}`, label: `${project.name} · Workflow runs`, hint: 'Browse runs and history', group: 'Workflows', icon: 'play', keywords: 'runs history list workflow archive', run: () => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: undefined }) });
      (runsByProjectId[project.id] ?? []).filter(run => !run.archived).forEach(run => {
        entries.push({ id: `run:${run.runId}`, label: run.workflowName, hint: `${project.name} · run · ${run.status}`, group: 'Workflows', icon: 'play', keywords: 'workflow run pipeline', run: () => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: run.runId }) });
      });
      (workflowsByProject[project.id] ?? []).forEach(workflow => {
        entries.push({ id: `workflow:${workflow.id}`, label: workflow.name, hint: `${project.name} · workflow`, group: 'Workflows', icon: 'graph', run: () => navigate({ projectId: project.id, feature: 'workflows', workflowId: workflow.id }) });
      });
    });
    workspaceBoards.forEach(board => {
      entries.push({ id: `board:${board.connectionId ?? 'demo'}:${board.id}`, label: board.name, hint: 'Board', group: 'Boards', icon: 'columns', run: () => openBoard(board.id) });
    });
    agentSessions.filter(session => !isConversationSession(session)).forEach(session => {
      entries.push({ id: `session:${session.issueKey}`, label: sessionTitle(session), keywords: session.issueKey, hint: session.issueKey, group: 'Sessions', icon: 'robot', run: () => navigate({ feature: 'sessions', sessionKey: session.issueKey }) });
    });
    agentSessions.filter(isConversationSession).forEach(session => {
      entries.push({ id: `conversation:${session.issueKey}`, label: sessionTitle(session), keywords: session.issueKey, hint: 'Conversation', group: 'Conversations', icon: 'chats', run: () => navigate({ feature: 'conversations', sessionKey: session.issueKey }) });
    });
    (agentSnapshot?.profiles ?? []).filter(profile => !isHostShimProfile(profile)).forEach(profile => {
      entries.push({ id: `profile:${profile.profile.id}`, label: profile.profile.name, hint: 'Agent profile', group: 'Agent Hub', icon: 'robot', run: () => navigate({ feature: 'agents', agentProfileId: profile.profile.id }) });
    });
    // Bindings with no curated AGENT.md profile only — one that already has a
    // real profile shows up as that profile's entry above, and is managed
    // from there.
    (agentSnapshot?.runtimeHosts ?? agentSnapshot?.agents ?? [])
      .filter(host => {
        const profile = (agentSnapshot?.profiles ?? []).find(candidate => candidate.profile.id === host.manifest.id);
        return !profile || isHostShimProfile(profile);
      })
      .forEach(host => {
        entries.push({ id: `host:${host.manifest.id}`, label: host.manifest.name, hint: 'Launch binding (advanced)', group: 'Agent Hub', icon: 'zap', run: () => navigate({ feature: 'agents', agentId: host.manifest.id }) });
      });
    (agentSnapshot?.skills ?? []).forEach(skill => {
      entries.push({ id: `skill:${skill.metadata.name}`, label: skillTitle(skill.metadata), hint: 'Skill', group: 'Agent Hub', icon: 'sparkles', run: () => navigate({ feature: 'agents', skillName: skill.metadata.name }) });
    });
    const settingsPages: Array<[SettingsCategory, string]> = [
      ['overview', 'Settings'], ['startup', 'Startup'], ['appearance', 'Appearance'],
      ['appearance-themes', 'Themes'], ['appearance-surfaces', 'Surfaces'], ['appearance-looks', 'Looks'],
      ['ai', 'AI Provider'], ['ai-usage', 'AI Usage & Spend'], ['agent-runtime', 'Agent Runtime'], ['mcp', 'MCP Server'], ['delivery', 'Delivery'],
      ['connections', 'Connections'], ['jira', 'Jira'], ['terminal', 'Terminal'], ['performance', 'Performance'], ['preview', 'Preview']
    ];
    settingsPages.forEach(([id, label]) => {
      entries.push({ id: `settings:${id}`, label, hint: 'Settings', group: 'Settings', icon: 'gear', run: () => setSettingsDialogCategory(id) });
    });
    return entries;
  }, [workspaceProjects, workspaceBoards, workflowsByProject, runsByProjectId, agentSessions, agentSnapshot, selectedProject, composerProject, navigate, openBoard, requestAddProject, openExistingFolder, updateSettings, settings?.preview?.enableEasyMode, toggleFocusMode, inSession, toggleAssistant]);

  /** Four stops over controls the shell already renders — see Walkthrough. */
  const walkthroughStops = useMemo<WalkthroughStop[]>(() => [
    {
      id: 'project',
      selector: '[data-testid="project-nav-item"]',
      title: 'Your project lives here',
      body: 'Its board, repository, workflows and documents all hang off this row in the sidebar.'
    },
    {
      id: 'board',
      selector: '[data-testid="board-nav-item"]',
      title: 'Work sits on the board',
      body: 'Your starter tickets are here. Open one to see its detail, comments, and AI actions.'
    },
    {
      id: 'session',
      selector: '[data-testid="project-getstarted-start"]',
      title: 'Hand a ticket to an agent',
      body: 'A session turns a ticket into visible progress: the agent plans, asks before it uses a tool, and reports what it changed.'
    },
    {
      id: 'connections',
      selector: '[data-testid="nav-connections"]',
      title: 'Bring in your real tickets',
      body: 'Connect Jira, GitLab, GitHub, or a folder of markdown plans, and its boards appear alongside this project.'
    }
  ], []);

  const startWalkthrough = useCallback(() => setWalkthroughOpen(true), []);
  const finishWalkthrough = useCallback(() => {
    setWalkthroughOpen(false);
    try { localStorage.setItem(WALKTHROUGH_KEY, '1'); } catch { /* private mode */ }
  }, []);

  const connection = connections.find(candidate => candidate.id === selectedBoard?.connectionId);

  /**
   * Whether the selected board's backend accepts new tickets. Demo always can;
   * folder and project connections carry an `allowIssueCreation` setting (a
   * project's own board always sets it, a folder connection stays read-only
   * until the user opts in); the not-yet-ported modes (gitlab/github) resolve
   * to a stub backend that throws, so the form would only error — the button is
   * disabled up front instead, with the hint saying why.
   *
   * The `!connection` arm is a fallback for a board whose connection row has
   * not been written yet (a project from before projects owned one, on the
   * first launch after the startup heal). It permits rather than blocks, which
   * is what that board did before it had a row at all.
   */
  const canCreateIssue = !connection
    ? true
    : connection.mode === 'demo'
      ? true
      : connection.mode === 'app' || connection.mode === 'folder' || connection.mode === 'project' || connection.mode === 'github'
        ? connection.settings.allowIssueCreation === true
        : false;
  const createIssueHint =
    !connection || connection.mode === 'demo' || canCreateIssue
      ? undefined
      : connection.mode === 'app' || connection.mode === 'folder' || connection.mode === 'project' || connection.mode === 'github'
        ? 'Issue creation is disabled for this connection. Enable "Allow issue creation" in its settings.'
        : `Ticket creation is not available for ${backendModeMeta(connection.mode).label} connections yet.`;

  const onboardingProjectWizard = Boolean(projectWizardMode && projectWizardPresentation === 'onboarding');
  // WebContentsView is a native sibling of the renderer and always paints
  // above DOM z-index layers. Suspend it whenever an App-owned modal — or the
  // startup splash — is above the current surface, otherwise the page bleeds
  // through it.
  const nativeOverlayOpen = Boolean(
    showSplash
      || settingsDialogCategory
      || workspaceDialogOpen
      || whatsNewOpen
      || addProjectOpen
      || projectWizardMode
  );
  const routedProject = route.projectId ? projects.find(p => p.id === route.projectId) : undefined;
  const contextLabel = aiSetupNeeded
    ? 'Set up AI'
    : onboardingProjectWizard
    ? projectWizardMode === 'existing' ? 'Create from folder' : 'Create project'
    : gettingStarted
    ? 'Getting Started'
    : route.newIssue
    ? route.newIssueType === 'Idea'
      ? 'New idea'
      : 'New issue'
    : route.feature
    ? FEATURE_TITLES[route.feature]
    : route.boardId && selectedBoard
    ? selectedBoard.name
    : routedProject
    ? routedProject.name
    : selectedBoard?.name ?? selectedProject?.name ?? 'New session';
  const contextIcon: IconName = aiSetupNeeded
    ? 'sparkles'
    : onboardingProjectWizard
    ? 'folder-open'
    : gettingStarted
    ? 'home'
    : route.newIssue
    ? route.newIssueType === 'Idea'
      ? 'lightbulb'
      : 'plus'
    : route.feature
    ? FEATURE_ICONS[route.feature]
    : route.boardId && selectedBoard
    ? 'columns'
    : routedProject
    ? ((routedProject.icon as IconName) ?? 'folder-open')
    : selectedBoard
    ? 'columns'
    : selectedProject
    ? ((selectedProject.icon as IconName) ?? 'folder-open')
    : 'robot';
  const selectedBoardFilters =
    boardFilterState && boardFilterState.boardId === selectedBoard?.id
      ? boardFilterState.value
      : EMPTY_BOARD_FILTER;
  const selectedBoardFilterPresentation =
    boardFilterPresentation && boardFilterPresentation.boardId === selectedBoard?.id
      ? boardFilterPresentation.value
      : {
          statusOptions: [],
          issueTypeOptions: [],
          parentOptions: [],
          shown: 0,
          total: undefined
        };

  const renderNewSession = () => (
    <NewSession
      sessions={agentSessions}
      boards={workspaceBoards}
      workflowOptions={composerProject ? sessionWorkflowsByProject[composerProject.id] ?? [] : []}
      initialWorkflowId={route.quickSession ? quickSessionWorkflowId : undefined}
      autoFocusGoal={route.quickSession}
      initialGoal={route.newSessionGoal}
      onSubmit={async ({ board, issueKey, title, goal, provider, model, reasoningEffort, permissionMode, toolMode, mode, workingDirectory, runInWorktree, agentId, profileId, hostId, skillNames, workflowId, uncommittedChanges }) => {
        const projectId = projectIdForConnection(board?.connectionId, connections);
        const project = projectId
          ? workspaceProjects.find(item => item.id === projectId)
          : composerProject;
        // Before any session exists, so a dirty checkout costs nothing to back out of.
        if (workflowId && project) await assertRunBaseOrThrow(project.id, uncommittedChanges);
        const effectiveWorkingDir = project?.workspaceFolder ?? workingDirectory;
        const effectiveToolMode = project?.defaultAiToolMode ?? (effectiveWorkingDir ? toolMode : 'project-only');
        const record = await window.praxis.ai.delegate({
          ...(issueKey ? { issueKey } : {}),
          mode,
          ...(board?.connectionId ? { connectionId: board.connectionId } : {}),
          ...(project ? { projectId: project.id } : {}),
          task: { goal },
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          permissionMode,
          toolMode: effectiveToolMode,
          workingDirectory: effectiveWorkingDir,
          ...(runInWorktree ? { runInWorktree: true } : {}),
          ...(agentId ? { agentId } : {}),
          ...(profileId ? { profileId } : {}),
          ...(hostId ? { hostId } : {}),
          ...(skillNames?.length ? { skillNames } : {})
        });
        await window.praxis.ai.renameSession(record.issueKey, title);
        if (workflowId) {
          if (!project) {
            await window.praxis.ai.deleteSession(record.issueKey);
            throw new Error('Select a project before starting a governed workflow.');
          }
          try {
            await window.praxis.workflows.startRun(
              project.id,
              workflowId,
              title || goal,
              issueKey ? { issueKey, connectionId: board?.connectionId } : undefined,
              { sessionKey: record.issueKey, sessionId: record.sessionId },
              undefined,
              {
                aiProvider: provider,
                aiModel: model,
                ...(uncommittedChanges ? { uncommittedChanges } : {})
              }
            );
          } catch (error) {
            await window.praxis.ai.deleteSession(record.issueKey).catch(() => undefined);
            throw error;
          }
        }
        navigate({ feature: isConversationSession(record) ? 'conversations' : 'sessions', sessionKey: record.issueKey });
      }}
      {...(route.newSessionAgent
        ? { agentContext: {
            agentId: route.newSessionAgent,
            profileId: route.newSessionProfile ?? route.newSessionAgent,
            hostId: route.newSessionAgent,
            skillNames: route.newSessionSkills ?? []
          } }
        : {})}
      defaultWorkingDirectory={composerProject?.workspaceFolder ?? boardProject?.workspaceFolder}
      {...(composerProject
        ? { scopeLabel: composerProject.name, defaultToolMode: composerProject.defaultAiToolMode }
        : {})}
      projectCount={workspaceProjects.length}
      {...(composerProject
        ? { onNewWorkflow: () => setNewWorkflowForProject(composerProject.id) }
        : { onNewProject: newProjectEnabled ? () => requestAddProject() : undefined })}
      toolModeForBoard={board => projectIdForConnection(board.connectionId, connections)
        ? projects.find(item => item.id === projectIdForConnection(board.connectionId, connections))?.defaultAiToolMode
        : undefined}
      onSelectedBoardChange={board => setComposerBoardId(current => current === board?.id ? current : board?.id)}
    />
  );

  /** The lightweight "New conversation" composer (FX-BE-142) — no board or ticket
   *  chrome, since a conversation belongs to neither. */
  const renderNewConversation = () => (
    <NewSession
      sessions={agentSessions}
      boards={[]}
      conversational
      defaultToolMode="project-only"
      autoFocusGoal
      onSubmit={async ({ title, goal, provider, model, reasoningEffort, permissionMode, toolMode, mode, workingDirectory, agentId, profileId, hostId, skillNames }) => {
        const record = await window.praxis.ai.delegate({
          mode,
          task: { goal },
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          permissionMode,
          toolMode: workingDirectory ? toolMode : 'project-only',
          workingDirectory,
          ...(agentId ? { agentId } : {}),
          ...(profileId ? { profileId } : {}),
          ...(hostId ? { hostId } : {}),
          ...(skillNames?.length ? { skillNames } : {})
        });
        await window.praxis.ai.renameSession(record.issueKey, title);
        navigate({ feature: 'conversations', sessionKey: record.issueKey });
      }}
    />
  );

  /** The session console for one session key — shared by the Sessions route and a workflow run's centre pane. */
  const renderSessionsPage = (sessionKey: string | undefined) => {
    const targetSession = agentSessions.find(session => session.issueKey === sessionKey) ?? agentSessions[0];
    return (
      <SessionsPage
        // An explicit ticket route can refer to a legacy session without a project.
        // Keep that selected record visible even when it falls outside this list's scope.
        sessions={activeSessions.filter(session => session.issueKey === sessionKey || !isConversationSession(session))}
        selectedKey={sessionKey}
        workflowOptions={targetSession
          ? sessionWorkflowsByProject[
            targetSession.projectId
              ?? projectIdForConnection(targetSession.connectionId, connections)
              ?? composerProject?.id
              ?? ''
          ] ?? []
          : []}
        onStartWorkflow={async (session, workflowId, uncommittedChanges?: UncommittedChoice) => {
          const projectId = session.projectId ?? projectIdForConnection(session.connectionId, connections) ?? composerProject?.id;
          if (!projectId) {
            throw new Error('This session is not associated with a project. Open it from a project workspace before adding a workflow.');
          }
          await assertRunBaseOrThrow(projectId, uncommittedChanges);
          await window.praxis.workflows.startRun(
            projectId,
            workflowId,
            session.title ?? session.taskDefinition.goal,
            session.connectionId ? { issueKey: session.issueKey, connectionId: session.connectionId } : undefined,
            { sessionKey: session.issueKey, sessionId: session.sessionId },
            undefined,
            {
              ...(session.provider ? { aiProvider: session.provider } : {}),
              ...(session.model ? { aiModel: session.model } : {}),
              ...(uncommittedChanges ? { uncommittedChanges } : {})
            }
          );
        }}
        onSelectWorkflowRun={async (session, runId) => {
          await window.praxis.workflows.selectControllerRun(session.issueKey, runId);
        }}
        onRemoveWorkflowRun={async (session, runId) => {
          await window.praxis.workflows.removeControllerRun(session.issueKey, runId);
        }}
        onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
        onSelectSession={sessionKey => navigate({ feature: 'sessions', sessionKey })}
        onOpenAiSettings={() => setSettingsDialogCategory('ai')}
        focusMode={!sidebarVisible && !auxVisible}
        initialBrowserOpen={route.browserOpen}
        initialBrowserUrl={route.browserUrl}
        onBrowserOpenChange={handleBrowserOpenChange}
        onBrowserUrlChange={handleBrowserUrlChange}
        browserSuspended={nativeOverlayOpen}
      />
    );
  };

  /** The conversation console (FX-BE-142) — the same session console/composer as
   *  Sessions, scoped to sessions that belong to no project and no ticket. */
  const renderConversationsPage = (sessionKey: string | undefined) => {
    const conversations = activeSessions.filter(isConversationSession);
    const target = conversations.find(session => session.issueKey === sessionKey) ?? conversations[0];
    if (target && detachedConversationKeys.has(target.issueKey)) {
      return (
        <div className="empty-state" data-testid="conversation-detached-placeholder">
          <Icon name="external-link" size={28} />
          <span>This conversation is open in its floating window.</span>
          <button
            type="button"
            className="btn"
            onClick={() => void window.praxis.detachedChat.close(target.issueKey)}
          >
            <Icon name="window-restore" size={13} />
            Bring back to this window
          </button>
        </div>
      );
    }
    return (
      <SessionsPage
        sessions={conversations}
        selectedKey={sessionKey}
        onNewSession={() => navigate({ newConversation: true })}
        onSelectSession={sessionKey => navigate({ feature: 'conversations', sessionKey })}
        onOpenAiSettings={() => setSettingsDialogCategory('ai')}
        focusMode={!sidebarVisible && !auxVisible}
        initialBrowserOpen={route.browserOpen}
        initialBrowserUrl={route.browserUrl}
        onBrowserOpenChange={handleBrowserOpenChange}
        onBrowserUrlChange={handleBrowserUrlChange}
        browserSuspended={nativeOverlayOpen}
        onPopOut={session => void window.praxis.detachedChat.open(session.issueKey)}
      />
    );
  };

  /** The right-pane inspector for one session — shared by the Sessions route and a workflow run's session details. */
  const renderSessionInspector = (inspectedSession: AgentSessionRecord | undefined) => (
    <SessionInspector
      session={inspectedSession}
      sessions={agentSessions}
      onSelectSession={issueKey => {
        const session = agentSessions.find(candidate => candidate.issueKey === issueKey);
        navigate(session && isConversationSession(session)
          ? { feature: 'conversations', sessionKey: issueKey }
          : { feature: 'sessions', sessionKey: issueKey });
      }}
      onArchiveSession={async (issueKey, archived) => {
        await window.praxis.ai.archiveSession(issueKey, archived);
        // Archiving the open conversation would leave the
        // console showing a session the tree no longer lists;
        // fall back to the newest remaining active session.
        if (archived && route.sessionKey === issueKey && (route.feature === 'sessions' || route.feature === 'conversations')) {
          navigate({ feature: route.feature });
        }
      }}
      onOpenWorkflowRun={runId => {
        // Sessions intentionally do not duplicate project identity: the
        // durable run is the authority. Resolve it across this workspace
        // before navigating so this works from the global Sessions view.
        void Promise.all(
          workspaceProjects.map(async project => ({
            projectId: project.id,
            runs: await window.praxis.workflows.listRuns(project.id)
          }))
        ).then(projectRuns => {
          const owner = projectRuns.find(item => item.runs.some(run => run.runId === runId));
          if (owner) navigate({ projectId: owner.projectId, feature: 'workflows', workflowView: 'runs', workflowRunId: runId });
        });
      }}
    />
  );

  const centre = () => {
    // A workspace-level session ("Sessions → New session"): the composer, not a
    // board or the project dashboard, even when a project is on the route.
    if (route.newSession) {
      if (!sidebarVisible && !auxVisible) {
        return (
          <div className="sessions-focus-new-layout">
            <div className="session-console-header session-focus-header session-focus-new-header">
              <SessionFocusTabs
                sessions={activeSessions}
                newSessionActive
                onSelectSession={sessionKey => navigate({ feature: 'sessions', sessionKey })}
              />
            </div>
            {renderNewSession()}
          </div>
        );
      }
      return renderNewSession();
    }
    if (route.newConversation) {
      if (!sidebarVisible && !auxVisible) {
        return (
          <div className="sessions-focus-new-layout">
            <div className="session-console-header session-focus-header session-focus-new-header">
              <SessionFocusTabs
                sessions={activeSessions.filter(isConversationSession)}
                newSessionActive
                onSelectSession={sessionKey => navigate({ feature: 'conversations', sessionKey })}
              />
            </div>
            {renderNewConversation()}
          </div>
        );
      }
      return renderNewConversation();
    }
    if (selectedProject && route.feature === 'workflows') {
      if (route.workflowView === 'policies') {
        return <WorkflowPolicyPage project={selectedProject} />;
      }
      if (route.workflowView === 'runs') {
        return (
          <WorkflowRunPage
            key={route.workflowRunId ?? 'none'}
            runId={route.workflowRunId}
            runs={runsByProjectId[selectedProject.id] ?? []}
            auxSlot={auxSlotEl}
            onRequireAux={requireAux}
            onOpenSession={sessionKey => navigate({ feature: 'sessions', sessionKey })}
            onOpenBoardItem={issueKey => {
              const board = workspaceBoards.find(candidate => candidate.connectionId === `project:${selectedProject.id}`);
              if (board) navigate({ boardId: board.id, issueKey });
            }}
            onOpenPolicies={() => navigate({ projectId: selectedProject.id, feature: 'workflows', workflowView: 'policies' })}
            onRunGone={() => navigate({ projectId: selectedProject.id, feature: 'workflows' })}
            onSelectRun={runId => navigate({ projectId: selectedProject.id, feature: 'workflows', workflowView: 'runs', workflowRunId: runId || undefined })}
            onArchiveRun={async (runId, archived) => {
              try {
                await window.praxis.workflows.archiveRun(runId, archived);
              } catch (cause) {
                console.error('Failed to archive workflow run:', cause);
              }
            }}
            onCancelRun={async runId => {
              try {
                await window.praxis.workflows.cancelRun(runId, 'cancelled from runs browser');
              } catch (cause) {
                console.error('Failed to cancel workflow run:', cause);
              }
            }}
            onDeleteRun={async run => {
              const result = await deleteRunFlow(run);
              if (result.error) {
                await confirm({ title: 'Could not delete the run', message: result.error, confirmLabel: 'OK' });
              } else if (result.deleted && route.feature === 'workflows' && route.workflowRunId === run.runId) {
                navigate({ projectId: selectedProject.id, feature: 'workflows', workflowView: 'runs', workflowRunId: undefined });
              }
            }}
            renderSession={renderSessionsPage}
            renderSessionInspector={sessionKey => renderSessionInspector(agentSessions.find(session => session.issueKey === sessionKey))}
          />
        );
      }
      if (route.workflowId) {
        return (
          <WorkflowDesignerPage
            key={route.workflowId}
            project={selectedProject}
            workflowId={route.workflowId}
            auxSlot={auxSlotEl}
            onRequireAux={requireAux}
            onSaved={bumpWorkflows}
            onDeleted={() => navigate({ projectId: selectedProject.id, feature: 'workflows' })}
          />
        );
      }
      return (
        <div className="view-scroll wf-page">
          <div className="empty-state">
            <Icon name="split-horizontal" size={28} />
            <span>Pick a workflow from the sidebar, or start a new one.</span>
            <button type="button" className="btn btn-primary" onClick={() => setNewWorkflowForProject(selectedProject.id)}>
              New workflow
            </button>
          </div>
        </div>
      );
    }
    if (route.feature === 'agents') {
      return (
        <AgentDetailPage
          snapshot={agentSnapshot}
          selection={agentSelection}
          project={selectedProject ?? undefined}
          error={agentError}
          onNew={setAgentDialog}
          onOpenSettings={() => setSettingsDialogCategory('agent-runtime')}
        />
      );
    }
    const activeProject = easyModeProject;
    if (settings?.preview.enableEasyMode && route.feature !== 'git' && route.feature !== 'run' && route.feature !== 'deployments' && (!route.feature || route.feature === 'overview')) {
      return (
        <EasyModeCanvas
          project={activeProject}
          sessions={agentSessions}
          settings={settings}
          updateSettings={updateSettings}
          onStartSession={goal => navigate({ newSession: true, ...(activeProject ? { projectId: activeProject.id } : {}), ...(goal ? { newSessionGoal: goal } : {}) })}
          onSelectSession={sessionKey => {
            const session = agentSessions.find(candidate => candidate.issueKey === sessionKey);
            const sessionProjectId = session?.projectId ?? activeProject?.id;
            navigate(session && isConversationSession(session)
              ? { feature: 'conversations', sessionKey, ...(sessionProjectId ? { projectId: sessionProjectId } : {}) }
              : { feature: 'sessions', sessionKey, ...(sessionProjectId ? { projectId: sessionProjectId } : {}) });
          }}
          onOpenFolder={openExistingFolder}
          onOpenGit={activeProject?.workspaceFolder ? () => navigate({ projectId: activeProject.id, feature: 'git' }) : undefined}
          onOpenAutomations={activeProject ? () => navigate({ projectId: activeProject.id, feature: 'workflows' }) : undefined}
          onOpenSessions={() => navigate({ feature: 'sessions', ...(activeProject ? { projectId: activeProject.id } : {}) })}
        />
      );
    }
    if (selectedProject && route.feature !== 'git' && route.feature !== 'run' && route.feature !== 'deployments') {
      return <ProjectWorkspace project={selectedProject} sessions={agentSessions} onStartSession={() => navigate({ newSession: true, projectId: selectedProject.id })} onStartTour={startWalkthrough} />;
    }
    if (route.feature === 'connections') {
      // No view-scroll wrapper: the manager's two panes own their own scrolling.
      return (
        <Connections
          onChanged={() => {
            refreshConnections();
            refreshBoards();
          }}
        />
      );
    }
    if (route.feature === 'overview') {
      return (
        <OverviewPage
          projects={workspaceProjects}
          boards={workspaceBoards}
          connections={connections}
          sessions={agentSessions}
          connectionChecks={connectionChecks}
          onNewProject={() => requestAddProject()}
          onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
          onNewConversation={() => navigate({ newConversation: true })}
          onOpenProjects={() => navigate({})}
          onOpenSessions={() => navigate({ feature: 'sessions' })}
          onOpenConversations={sessionKey => navigate({ feature: 'conversations', ...(sessionKey ? { sessionKey } : {}) })}
          onOpenConnections={() => { refreshConnections(); navigate({ feature: 'connections' }); }}
          onOpenAiUsage={() => setSettingsDialogCategory('ai-usage')}
          onOpenBoard={board => openBoard(board.id)}
          onOpenProject={project => navigate({ projectId: project.id })}
        />
      );
    }
    if (route.view === 'agent-details') {
      return (
        <AgentDetailsPage
          sessionKey={route.sessionKey}
          agentId={route.subagentId}
          sessions={agentSessions}
          onClose={() => navigate({ ...route, view: undefined, subagentId: undefined })}
          onSelectSession={sessionKey => navigate({ feature: 'sessions', sessionKey })}
          onSelectAgent={(sessionKey, subId) => navigate({ feature: 'sessions', sessionKey, view: 'agent-details', subagentId: subId })}
        />
      );
    }
    if (route.feature === 'sessions') {
      // No view-scroll wrapper: the sessions list and console own their scrolling.
      return renderSessionsPage(route.sessionKey);
    }
    if (route.feature === 'conversations') {
      return renderConversationsPage(route.sessionKey);
    }
    if (route.feature === 'git') {
      if (route.gitView === 'changes') {
        return <GitChangesPage
          repositoryPath={selectedProject?.workspaceFolder}
          onOpenGraph={() => navigate({ projectId: selectedProject?.id, feature: 'git', gitView: 'graph' })}
        />;
      }
      return <GitGraphPage
        repositoryPath={selectedProject?.workspaceFolder}
        onOpenChanges={() => navigate({ projectId: selectedProject?.id, feature: 'git', gitView: 'changes' })}
        auxSlot={auxSlotEl}
        onRequireAux={requireAux}
      />;
    }
    if (route.feature === 'run') {
      if (!selectedProject) {
        return (
          <div className="empty-state" data-testid="run-no-project">
            <Icon name="server" size={28} />
            <span>Pick a project to edit its Run profile.</span>
          </div>
        );
      }
      return <RunProfileEditor project={selectedProject} />;
    }
    if (route.feature === 'deployments') {
      if (!settings?.preview?.enableDeployments) {
        return (
          <div className="empty-state" data-testid="deployments-disabled">
            <Icon name="rocket" size={28} />
            <span>Deployments preview is disabled.</span>
            <p>Enable Deployments under Settings &gt; Preview to manage deployment profiles and delivery runs.</p>
          </div>
        );
      }
      if (!selectedProject) {
        return (
          <div className="empty-state" data-testid="deployments-no-project">
            <Icon name="rocket" size={28} />
            <span>Pick a project to manage its deployment profiles.</span>
          </div>
        );
      }
      return <DeploymentsPage project={selectedProject} />;
    }
    if (route.feature) {
      return (
        <div className="empty-state" data-testid="feature-not-ready">
          <Icon name="tools" size={28} />
          <span>{FEATURE_TITLES[route.feature]} isn&rsquo;t available yet.</span>
          <p>Feature- and ticket-level work lives on your boards for now.</p>
          <button className="btn" type="button" onClick={() => navigate({})}>Go to Overview</button>
        </div>
      );
    }
    // AI tooling views take over the centre pane for the routed issue.
    if (route.issueKey && route.view === 'review') {
      return (
        <AiReviewPage
          sessions={agentSessions}
          issueKey={route.issueKey}
          connectionId={selectedBoard?.connectionId}
          provider={route.aiProvider}
          model={route.aiModel}
          onClose={() => navigate({ ...route, view: undefined })}
          onOpenSession={sessionKey => navigate({ feature: 'sessions', sessionKey })}
          onTicketChanged={() => {
            refreshBoards();
            refreshBoardDetails();
            setIssueRefreshToken(token => token + 1);
          }}
        />
      );
    }
    if (route.issueKey && route.view === 'lpr') {
      return (
        <LocalPeerReviewPage
          issueKey={route.issueKey}
          connectionId={selectedBoard?.connectionId}
          provider={route.aiProvider}
          model={route.aiModel}
          onClose={() => navigate({ ...route, view: undefined })}
        />
      );
    }
    // Board-scoped AI tooling: the Task Designer takes over the centre pane.
    if (route.boardId && route.view === 'designer' && selectedBoard) {
      return (
        <TaskDesignerPage
          key={selectedBoard.id}
          board={selectedBoard}
          onClose={() => navigate({ ...route, view: undefined })}
          onSelectionChange={handleDesignerSelectionChange}
          onUseMasterPlan={result => {
            const projectId = projectIdForConnection(selectedBoard.connectionId, connections);
            if (!projectId) return;
            setPendingWorkflowPlan({
              source: 'task-designer',
              boardId: selectedBoard.id,
              outputPath: result.outputPath,
              generatedFeaturesPath: result.generatedFeaturesPath,
              fingerprint: result.fingerprint,
              generatedFeatureCount: result.generatedFeatureCount,
              generatedStoryCount: result.generatedStoryCount
            });
            setStartRunDialog({ projectId });
          }}
          externalSelectionId={
            selectedDesignerNode?.id.startsWith('board-ticket:')
              ? selectedDesignerNode.id
              : undefined
          }
        />
      );
    }
    // Nothing to work with yet: no board is selected and the workspace has none.
    // Point the user straight at where boards get created rather than showing an
    // AI composer that can't do anything without a board.
    if (!selectedBoard && workspaceBoards.length === 0) {
      return (
        <div className="empty-state board-empty-state" data-testid="no-boards-empty">
          <Icon name="columns" size={30} />
          <strong>No boards</strong>
          <p>Connect a board source, or import folders of markdown plans as projects.</p>
          <button
            className="btn btn-primary"
            data-testid="no-boards-create-btn"
            onClick={() => { refreshConnections(); navigate({ feature: 'connections' }); }}
          >
            Add connection
          </button>
          <button
            className="btn"
            data-testid="no-boards-import-btn"
            disabled={!activeWorkspaceId}
            onClick={() => setImportProjectsOpen(true)}
          >
            Import plans folders
          </button>
        </div>
      );
    }
    // Work mode renders the board cards in the sidebar; the centre pane just
    // shows whatever is currently routed (New Session when nothing's picked,
    // BoardView for the selected board).
    if (!selectedBoard) {
      return renderNewSession();
    }
    if (route.newIssue) {
      return (
        <NewIssuePage
          board={selectedBoard}
          connection={connection}
          initialIssueType={route.newIssueType}
          onCancel={() => navigate({ boardId: selectedBoard.id })}
          onCreated={issueKey => {
            refreshBoards();
            refreshBoardDetails();
            navigate({ boardId: selectedBoard.id, issueKey });
          }}
        />
      );
    }
    if (!boardDetails) {
      return <div className="empty-state">Loading board…</div>;
    }
    // No scroll wrapper: the board's columns own the pane height themselves.
    // Keyed by board id so the filter bar and paging state reset on a board
    // switch instead of leaking the previous board's query into the new one.
    return (
      <BoardView
        key={selectedBoard.id}
        details={boardDetails}
        selectedIssueKey={route.issueKey}
        connectionId={selectedBoard.connectionId}
        filters={selectedBoardFilters}
        onFilterPresentationChange={handleFilterPresentationChange}
        onOpenIssue={issueKey => navigate({ boardId: selectedBoard.id, issueKey })}
        onNewIssue={() => navigate({ boardId: selectedBoard.id, newIssue: true })}
        onNewIdea={() => navigate({ boardId: selectedBoard.id, newIssue: true, newIssueType: 'Idea' })}
        canCreateIssue={canCreateIssue}
        createIssueHint={createIssueHint}
        onIssueMove={onIssueMove}
        onOpenDesigner={() => navigate({ boardId: selectedBoard.id, view: 'designer' })}
        openSettings={boardSettingsOpenFor === selectedBoard.id}
        onSettingsOpened={() => setBoardSettingsOpenFor(undefined)}
      />
    );
  };

  // The secondary sidebar is a pane the title-bar button owns outright, like the
  // bottom panel — selecting an issue fills it, it does not summon it.
  // Project workspaces use the secondary pane for editable project details.
  // Git Graph owns its own inspector column, so the global issue pane remains
  // hidden there to preserve topology and diff width. Workflows does the same
  // (stage/edge inspector, run-stage evidence) — see FX-BF-014.
  const showAux = auxVisible
    && route.feature !== 'overview'
    // Git Graph portals its commit inspector into the aux pane; the diff
    // workspace keeps the full centre width and has its own file list.
    && !(route.feature === 'git' && route.gitView === 'changes');
  const detailIsExpanded = detailExpanded && showAux && route.issueKey !== undefined;
  const selectedAgentSession = route.feature === 'sessions'
    ? agentSessions.find(session => session.issueKey === route.sessionKey)
      ?? agentSessions.find(session => !isConversationSession(session))
    : route.feature === 'conversations'
    ? agentSessions.find(session => session.issueKey === route.sessionKey && isConversationSession(session))
      ?? agentSessions.find(isConversationSession)
    : undefined;
  const terminalBoard = selectedBoard ?? (!route.feature && !route.projectId
    ? boards.find(board => board.id === composerBoardId)
    : undefined);
  const terminalProjectId = projectIdForConnection(terminalBoard?.connectionId, connections);
  const boardProject = terminalProjectId
    ? projects.find(project => project.id === terminalProjectId)
    : undefined;
  const terminalProject = selectedProject ?? boardProject;
  const terminalWorkingDirectory = selectedAgentSession?.workingDirectory
    ?? terminalProject?.workspaceFolder
    ?? settings?.ai.workingDirectory
    ?? undefined;
  const terminalDisabledReason = terminalProject && !terminalProject.workspaceFolder
    ? 'Attach a workspace folder to this project to use file and terminal tools.'
    : selectedAgentSession?.toolMode === 'project-only' && !selectedAgentSession.workingDirectory
      ? 'This folderless project session does not allow terminal tools.'
      : undefined;

  return (
    <div className="window-root">
      <WindowCloseGuard />
      <TitleBar
        appVersion={appVersion}
        contextLabel={contextLabel}
        contextIcon={contextIcon}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={openWorkspace}
        onDeleteWorkspace={deleteWorkspace}
        onCreateWorkspace={createWorkspace}
        onSaveWorkspace={saveWorkspaceToFile}
        onOpenWorkspace={openWorkspaceFromFile}
        onCloseWorkspace={closeWorkspace}
        onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
        onQuickSession={openQuickSession}
        onNewProject={() => requestAddProject()}
        onImportProjects={activeWorkspaceId ? () => setImportProjectsOpen(true) : undefined}
        mode={mode}
        onToggleMode={() => setMode(m => m === 'classic' ? 'work' : 'classic')}
        onModeChange={setMode}
        easyMode={Boolean(settings?.preview?.enableEasyMode)}
        onToggleEasyMode={() => void updateSettings({ preview: { enableEasyMode: !settings?.preview?.enableEasyMode } })}
        projects={settings?.preview?.enableEasyMode ? workspaceProjects : undefined}
        activeProjectId={easyModeProject?.id}
        onSelectProject={projectId => navigate({ projectId })}
        onOpenFolder={openExistingFolder}
        onOpenWhatsNew={() => setWhatsNewOpen(true)}
        settingsOpen={settingsDialogCategory !== undefined}
        onOpenSettings={() => setSettingsDialogCategory(current => current ? undefined : 'overview')}
        onOpenAiSettings={() => setSettingsDialogCategory('ai')}
        locked={aiSetupNeeded}
        boardFilter={
          selectedBoard && boardDetails && !route.feature && !route.newIssue && !route.view
            ? {
                value: selectedBoardFilters,
                ...selectedBoardFilterPresentation,
                onChange: value => setBoardFilterState({ boardId: selectedBoard.id, value })
              }
            : undefined
        }
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible(visible => !visible)}
        auxVisible={auxVisible}
        onToggleAux={() => setAuxVisible(visible => !visible)}
        panelVisible={panelVisible}
        onTogglePanel={() => setPanelVisible(visible => !visible)}
        assistantOpen={assistant.open}
        onToggleAssistant={toggleAssistant}
        focusMode={!sidebarVisible && !auxVisible && !panelVisible}
        onToggleFocusMode={toggleFocusMode}
        focusModeAvailable={inSession}
        canGoBack={nav.index > 0}
        onBack={() => setNav(current => ({ ...current, index: Math.max(0, current.index - 1) }))}
        canGoForward={nav.index < nav.entries.length - 1}
        onForward={() =>
          setNav(current => ({
            ...current,
            index: Math.min(current.entries.length - 1, current.index + 1)
          }))
        }
      />

      {aiSetupNeeded ? (
        <AiSetupWizard
          activeProvider={settings?.ai.activeProvider ?? 'claude-code-cli'}
          onSetDefault={provider => updateSettings({ ai: { activeProvider: provider } })}
          onDone={() => setAiSetupNeeded(false)}
        />
      ) : projectWizardMode && projectWizardPresentation === 'onboarding' && activeWorkspaceId ? (
        <div className="project-onboarding-frame" data-testid="project-wizard-onboarding">
          <NewProjectWizard
            workspaceId={activeWorkspaceId}
            workspaceName={activeWorkspace?.name}
            presentation="onboarding"
            mode={projectWizardMode}
            initialStartingPoint={projectWizardStartingPoint}
            onCancel={() => { setProjectWizardMode(undefined); setProjectWizardStartingPoint(undefined); }}
            onCreated={(project, options) => {
              setProjectWizardMode(undefined);
              setProjectWizardStartingPoint(undefined);
              setProjects(current => [...current.filter(item => item.id !== project.id), project]);
              setWorkspaces(current => current.map(workspace => workspace.id === activeWorkspaceId
                ? {
                    ...workspace,
                    projectIds: [...new Set([...workspace.projectIds, project.id])],
                    defaultProjectId: workspace.defaultProjectId ?? project.id
                  }
                : workspace));
              refreshBoards();
              refreshConnections();
              navigate({ projectId: project.id });
              try {
                // Ticking "Advanced setup" is someone saying they already know
                // the model. Offering them a tour reads as not listening — the
                // project home still carries "Take a tour" if they want it.
                if (localStorage.getItem(WALKTHROUGH_KEY) !== '1' && !options?.advanced) {
                  // After the shell has painted the new project's dashboard.
                  window.setTimeout(() => setWalkthroughOpen(true), 400);
                }
              } catch { /* private mode — just skip the offer */ }
            }}
          />
        </div>
      ) : gettingStarted ? (
        <GettingStarted
          workspaces={workspaces}
          recentWorkspaceIds={recentWorkspaceIds}
          createdWorkspace={workspaces.find(workspace => workspace.id === createdWorkspaceId)}
          onOpenWorkspace={openWorkspace}
          onOpenWorkspaceFile={openWorkspaceFromFile}
          onOpenExistingFolder={openExistingFolder}
          onCreateWorkspace={createWorkspaceFromGettingStarted}
          onSkipSetup={() => void skipWorkspaceSetup()}
          onCreateProject={() => requestAddProject('onboarding')}
          onContinueEmpty={() => {
            setCreatedWorkspaceId(undefined);
            setGettingStarted(false);
            setNav({ entries: [{ feature: 'overview' }], index: 0 });
          }}
        />
      ) : (
      <div className="shell">
        {sidebarVisible && (
          <>
            <div className="pane-sidebar" style={{ width: sidebar.size }}>
              {route.view === 'designer' && selectedBoard && boardDetails ? (
                <TaskDesignerSidebar
                  board={selectedBoard}
                  issues={boardDetails.issues}
                  selectedIssueKey={
                    selectedDesignerNode?.type === 'ticket'
                      ? selectedDesignerNode.issueKey
                      : undefined
                  }
                  onSelectIssue={handleDesignerBoardTicketSelect}
                />
              ) : settings?.preview.enableEasyMode ? (
                <EasyModeSidebar
                  sessions={easyModeSessions}
                  allSessions={agentSessions}
                  activeSessionKey={(route.feature === 'sessions' || route.feature === 'conversations') ? route.sessionKey : undefined}
                  activeAgentId={route.view === 'agent-details' ? (route.subagentId || route.sessionKey) : undefined}
                  onSelectSession={issueKey => {
                    const session = agentSessions.find(candidate => candidate.issueKey === issueKey);
                    const sessionProjectId = session?.projectId ?? easyModeProject?.id;
                    navigate(session && isConversationSession(session)
                      ? { feature: 'conversations', sessionKey: issueKey, ...(sessionProjectId ? { projectId: sessionProjectId } : {}) }
                      : { feature: 'sessions', sessionKey: issueKey, ...(sessionProjectId ? { projectId: sessionProjectId } : {}) });
                  }}
                  onSelectAgent={(sessionKey, agentId) => {
                    const session = agentSessions.find(candidate => candidate.issueKey === sessionKey);
                    const sessionProjectId = session?.projectId ?? easyModeProject?.id;
                    navigate({ feature: 'sessions', sessionKey, view: 'agent-details', subagentId: agentId, ...(sessionProjectId ? { projectId: sessionProjectId } : {}) });
                  }}
                  onNewSession={() => navigate({ newSession: true, ...(easyModeProject ? { projectId: easyModeProject.id } : {}) })}
                  projects={easyModeProject ? [easyModeProject] : workspaceProjects}
                  runsByProjectId={runsByProjectId}
                  activeWorkflowRunId={route.feature === 'workflows' && route.workflowView === 'runs' ? route.workflowRunId : undefined}
                  onSelectWorkflowRun={(project, runId) => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: runId })}
                  onNewWorkflowRun={() => {
                    const project = easyModeProject ?? selectedProject ?? workspaceProjects[0];
                    if (project) {
                      setStartRunDialog({ projectId: project.id });
                    }
                  }}
                  onAbortSession={async issueKey => {
                    await window.praxis.ai.abort(issueKey).catch(() => undefined);
                  }}
                  onDeleteSession={async issueKey => {
                    await window.praxis.ai.deleteSession(issueKey).catch(() => undefined);
                    if ((route.feature === 'sessions' || route.feature === 'conversations') && route.sessionKey === issueKey) {
                      navigate({ feature: route.feature });
                    }
                  }}
                />
              ) : (
                <Sidebar
                  boards={workspaceBoards}
                  projects={workspaceProjects}
                  assignableProjects={workspaceProjects}
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  searching={sidebarSearching}
                  query={sidebarSearchQuery}
                  onQueryChange={setSidebarSearchQuery}
                  onToggleSearch={() => {
                    setSidebarSearching(open => !open);
                    setSidebarSearchQuery('');
                  }}
                  connections={connections}
                  connectionChecks={connectionChecks}
                  selectedBoardId={route.boardId}
                  detailsByBoardId={detailsByBoardId}
                  onSelectBoard={board => openBoard(board.id)}
                  onSelectIssue={(board, issueKey) => navigate({ boardId: board.id, issueKey })}
                  mode={mode}
                  onModeChange={setMode}
                  activeFeature={route.feature}
                  sessions={activeSessions}
                  {...((route.feature === 'sessions' || route.feature === 'conversations') && route.sessionKey
                    ? { activeSessionKey: route.sessionKey }
                    : {})}
                  onSelectSession={issueKey => {
                    const session = agentSessions.find(candidate => candidate.issueKey === issueKey);
                    navigate(session && isConversationSession(session)
                      ? { feature: 'conversations', sessionKey: issueKey }
                      : { feature: 'sessions', sessionKey: issueKey });
                  }}
                  onRenameSession={async (issueKey, title) => {
                    await window.praxis.ai.renameSession(issueKey, title);
                  }}
                  onArchiveSession={async (issueKey, archived) => {
                    await window.praxis.ai.archiveSession(issueKey, archived);
                    if (archived && (route.feature === 'sessions' || route.feature === 'conversations') && route.sessionKey === issueKey) {
                      navigate({ feature: route.feature });
                    }
                  }}
                  onAssignConversation={async (issueKey, projectId, ticketKey) => {
                    const project = workspaceProjects.find(candidate => candidate.id === projectId);
                    if (!project) throw new Error('That project is no longer available in this workspace.');
                    await window.praxis.ai.assignSessionToProject(issueKey, projectId, ticketKey, project.workspaceFolder);
                  }}
                  onDeleteSession={async issueKey => {
                    await window.praxis.ai.deleteSession(issueKey);
                    if ((route.feature === 'sessions' || route.feature === 'conversations') && route.sessionKey === issueKey) {
                      navigate({ feature: route.feature });
                    }
                  }}
                  onSelectFeature={feature => {
                    if (feature === 'connections') {
                      refreshConnections();
                    }
                    navigate(feature === 'git' && selectedProject ? { projectId: selectedProject.id, feature } : { feature });
                  }}
                  featureCounts={featureCounts}
                  onNewSession={project => navigate({
                    newSession: true,
                    ...((project ?? composerProject) ? { projectId: (project ?? composerProject)!.id } : {})
                  })}
                  onNewConversation={() => navigate({ newConversation: true })}
                  onNewProject={() => requestAddProject()}
                  onImportProjects={activeWorkspaceId ? () => setImportProjectsOpen(true) : undefined}
                  onSelectProject={project => navigate({ projectId: project.id })}
                  onOpenProjectDocument={(project, document) => {
                    void window.praxis.projects.readDocument(project.id, document.relativePath)
                      .then(setProjectDocument)
                      .catch(error => console.error('Failed to open project document:', error));
                  }}
                  selectedProjectId={route.projectId}
                  selectedIssueKey={route.issueKey}
                  selectedIssueConnectionId={selectedBoard?.connectionId}
                  onSelectGit={(project, view) => navigate({ projectId: project.id, feature: 'git', gitView: view })}
                  projectWorkflows={workflowsByProject}
                  activeWorkflowId={route.feature === 'workflows' && !route.workflowView ? route.workflowId : undefined}
                  runsByProjectId={runsByProjectId}
                  activeWorkflowRunId={route.feature === 'workflows' && route.workflowView === 'runs' ? route.workflowRunId : undefined}
                  activeWorkflowPolicies={route.feature === 'workflows' && route.workflowView === 'policies'}
                  onSelectWorkflow={(project, workflowId) => navigate({ projectId: project.id, feature: 'workflows', workflowId })}
                  onSelectWorkflowRuns={project => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: undefined })}
                  onSelectWorkflowRun={(project, runId) => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: runId })}
                  onStartWorkflowRun={(project, workflowId) => setStartRunDialog({ projectId: project.id, workflowId })}
                  onArchiveWorkflowRun={async (runId, archived) => {
                    try {
                      await window.praxis.workflows.archiveRun(runId, archived);
                    } catch (cause) {
                      console.error('Failed to archive workflow run:', cause);
                    }
                  }}
                  onCancelWorkflowRun={async runId => {
                    try {
                      await window.praxis.workflows.cancelRun(runId, 'cancelled from the sidebar');
                    } catch (cause) {
                      console.error('Failed to cancel workflow run:', cause);
                    }
                  }}
                  onDeleteWorkflowRun={async (project, run) => {
                    const result = await deleteRunFlow(run);
                    if (result.error) {
                      await confirm({ title: 'Could not delete the run', message: result.error, confirmLabel: 'OK' });
                    } else if (result.deleted && route.feature === 'workflows' && route.workflowRunId === run.runId) {
                      navigate({ projectId: project.id, feature: 'workflows' });
                    }
                  }}
                  onSelectWorkflowPolicies={project => navigate({ projectId: project.id, feature: 'workflows', workflowView: 'policies' })}
                  onSelectRun={project => navigate({ projectId: project.id, feature: 'run' })}
                  enableDeployments={settings?.preview?.enableDeployments ?? false}
                  onSelectDeployments={project => navigate({ projectId: project.id, feature: 'deployments' })}
                  onNewWorkflow={project => setNewWorkflowForProject(project.id)}
                  onDeleteWorkflow={async (project, workflowId) => {
                    if (
                      !(await confirm({
                        title: 'Delete this workflow?',
                        message: 'Runs already started are kept.',
                        confirmLabel: 'Delete workflow',
                        danger: true
                      }))
                    ) {
                      return;
                    }
                    await window.praxis.workflows.remove(project.id, workflowId);
                    setWorkflowsNonce(n => n + 1);
                    if (route.feature === 'workflows' && route.workflowId === workflowId) {
                      navigate({ projectId: project.id, feature: 'workflows' });
                    }
                  }}
                  onDeleteBoard={board => {
                    if (!board.connectionId) return;
                    const connectionId = board.connectionId;
                    // A project's board is intrinsic to the project — there is
                    // nothing to untrack, and deleting it would mean deleting
                    // the project. Delete the project itself instead.
                    if (projectIdForConnection(connectionId, connections)) return;
                    // "Delete" means different things per backend: a folder
                    // connection *is* its board, so removing the board removes
                    // the connection; a Jira/GitLab board is only tracked from a
                    // shared remote connection (untrack it, delete nothing remote).
                    const mode = connections.find(item => item.id === connectionId)?.mode;
                    const removed = mode === 'folder'
                      ? window.praxis.connection.remove(connectionId)
                      : window.praxis.connection.removeTrackedBoard(connectionId, board.id);
                    void removed.then(() => {
                      if (route.boardId === board.id) navigate({});
                      refreshBoards();
                      refreshConnections();
                    });
                  }}
                  onUnlinkBoard={(project, connectionId, boardId) => {
                    void window.praxis.projects.unlinkBoard(project.id, connectionId, boardId).then(updated => {
                      setProjects(current => current.map(item => item.id === updated.id ? updated : item));
                      if (route.boardId === boardId) navigate({});
                    });
                  }}
                  onConfigureBoard={board => {
                    setBoardSettingsOpenFor(board.id);
                    openBoard(board.id);
                  }}
                />
              )}
            </div>
            <div
              className={`splitter${sidebar.dragging ? ' dragging' : ''}`}
              aria-label="Resize sidebar"
              {...sidebar.handleProps}
            />
          </>
        )}

        {projectDocument && (
          <>
            <ProjectDocumentPreview
              document={projectDocument}
              width={projectDoc.size}
              onClose={() => setProjectDocument(undefined)}
            />
            <div
              className={`splitter${projectDoc.dragging ? ' dragging' : ''}`}
              aria-label="Resize document preview"
              {...projectDoc.handleProps}
            />
          </>
        )}

        {/* The panel docks under the editor and issue pane but stays right of
            the sidebar, so those three share a column inside the shell. */}
        <div className="editor-stack">
          <div className={`pane-row${detailIsExpanded ? ' detail-expanded' : ''}`}>
            {!detailIsExpanded && <main className="pane-main" data-testid="main-content-pane">{centre()}</main>}

            {showAux && (
              <>
                {!detailIsExpanded && (
                  <div
                    className={`splitter${aux.dragging ? ' dragging' : ''}`}
                    aria-label="Resize issue panel"
                    {...aux.handleProps}
                  />
                )}
                <aside
                  className={`pane-aux${detailIsExpanded ? ' is-expanded' : ''}`}
                  data-testid="issue-details-pane"
                  style={detailIsExpanded ? undefined : { width: aux.size }}
                >
                  {route.feature === 'sessions' || route.feature === 'conversations' ? (
                    renderSessionInspector(selectedAgentSession)
                  ) : route.feature === 'git' ? (
                    <div ref={setAuxSlotEl} className="aux-slot" data-testid="git-aux-slot" />
                  ) : route.feature === 'agents' ? (
                    <AgentRuntimePanel
                      snapshot={agentSnapshot}
                      selection={agentSelection}
                      busy={agentsBusy}
                      activations={activations}
                      sessions={agentSessions.map(session => ({
                        issueKey: session.issueKey,
                        title: session.title ?? session.taskDefinition.goal.slice(0, 60),
                        state: session.state,
                        model: session.model ?? session.provider,
                        tokenUsage: session.tokenUsage,
                        cost: session.cost,
                        subagents: extractSubagents(session, agentSessions),
                        ...(session.agentId ? { agentId: session.agentId } : {}),
                        ...(session.profileId ? { profileId: session.profileId } : {}),
                        ...(session.hostId ? { hostId: session.hostId } : {})
                      }))}
                      onLifecycle={agentLifecycle}
                      onActivate={activateSkill}
                      onOpenSession={issueKey => navigate({ feature: 'sessions', sessionKey: issueKey })}
                      onStartSession={(agentId, skillNames, profileId) =>
                        navigate({
                          newSession: true,
                          newSessionAgent: agentId,
                          ...(profileId ? { newSessionProfile: profileId } : {}),
                          ...(skillNames.length ? { newSessionSkills: skillNames } : {}),
                          ...(composerProject ? { projectId: composerProject.id } : {})
                        })
                      }
                    />
                  ) : route.feature === 'workflows' ? (
                    // The Workflows feature portals its stage/connection inspector
                    // (or run-stage detail) into this element from the centre pane.
                    <div ref={setAuxSlotEl} className="aux-slot" data-testid="workflow-aux-slot" />
                  ) : route.view === 'designer' ? (
                    selectedDesignerNode ? (
                      <TaskDesignerItemDetail
                        node={selectedDesignerNode}
                        onClose={() => setAuxVisible(false)}
                      />
                    ) : (
                      <div className="empty-state" data-testid="designer-item-empty">
                        <Icon name="cursor" size={28} />
                        <span>Pick an item on the canvas to edit it here.</span>
                      </div>
                    )
                  ) : selectedProject && route.issueKey === undefined ? (
                    <ProjectHome project={selectedProject} boards={boards} connections={connections} onChanged={project => {
                      setProjects(current => current.map(item => item.id === project.id ? project : item));
                      refreshBoards();
                      refreshConnections();
                    }} onOpenBoard={openBoard} onOpenGit={() => navigate({ projectId: selectedProject.id, feature: 'git' })} />
                  ) : selectedBoard && boardDetails && route.issueKey === undefined ? (
                    <BoardDetailsPanel
                      board={selectedBoard}
                      details={boardDetails}
                      connection={connection}
                    />
                  ) : route.issueKey === undefined ? (
                    <div className="empty-state" data-testid="aux-empty">
                      <Icon name="ticket" size={28} />
                      <span>Ticket details appear here when you open one.</span>
                    </div>
                  ) : (
                    <IssueDetail
                      issueKey={route.issueKey}
                      connectionId={selectedBoard?.connectionId}
                      projectId={activeProjectId}
                      workflowOptions={activeProjectId ? sessionWorkflowsByProject[activeProjectId] : undefined}
                      expanded={detailIsExpanded}
                      onToggleExpanded={() => setDetailExpanded(expanded => !expanded)}
                      onClose={() => {
                        setDetailExpanded(false);
                        navigate({ ...route, issueKey: undefined });
                      }}
                      onChanged={refreshBoardDetails}
                      refreshToken={issueRefreshToken}
                      onOpenIssue={key => navigate({ ...route, issueKey: key, view: undefined })}
                      onOpenSession={key => navigate({ feature: 'sessions', sessionKey: key })}
                      onOpenAiView={(key, view, runtime) => {
                        setDetailExpanded(false);
                        navigate({
                          ...route,
                          issueKey: key,
                          view,
                          aiProvider: runtime?.provider,
                          aiModel: runtime?.model
                        });
                      }}
                      onOpenAiSettings={() => {
                        setDetailExpanded(false);
                        setSettingsDialogCategory('ai');
                      }}
                    />
                  )}
                </aside>
              </>
            )}
            {!detailIsExpanded && <AssistantDock />}
          </div>

          {panelVisible && !detailIsExpanded && (
            <>
              <div
                className={`splitter-h${panel.dragging ? ' dragging' : ''}`}
                aria-label="Resize panel"
                {...panel.handleProps}
              />
              <div className="panel-dock" style={{ height: panel.size }}>
                <BottomPanel
                  onClose={() => setPanelVisible(false)}
                  workingDirectory={terminalWorkingDirectory}
                  terminalDisabledReason={terminalDisabledReason}
                  onTerminalAi={async (prompt, sessionId) => {
                    const context = await window.praxis.terminal.getContext(sessionId);
                    const commands = await window.praxis.terminal.listCommands(sessionId);
                    const lastCommand = commands[commands.length - 1];
                    const goal = [
                      prompt,
                      '',
                      'Terminal context:',
                      `Working directory: ${context.cwd}`,
                      lastCommand
                        ? `Last command: ${lastCommand.command || '(shell command not detected)'}\nExit code: ${lastCommand.exitCode ?? 'running'}`
                        : 'Last command: unavailable',
                      context.output || '(no recent output captured)'
                    ].join('\n');
                    return window.praxis.ai.delegate({
                      goal,
                      workingDirectory: context.cwd,
                      toolMode: 'read-only'
                    });
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {projectWizardMode && projectWizardPresentation === 'dialog' && activeWorkspaceId && (
        <div className="project-dialog-backdrop" data-testid="project-dialog-backdrop">
          <div
            className="project-dialog-shell"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-dialog-title"
          >
            <NewProjectWizard
              workspaceId={activeWorkspaceId}
              workspaceName={activeWorkspace?.name}
              mode={projectWizardMode}
              initialStartingPoint={projectWizardStartingPoint}
              onCancel={() => { setProjectWizardMode(undefined); setProjectWizardStartingPoint(undefined); }}
              onCreated={project => {
                setProjectWizardMode(undefined);
                setProjectWizardStartingPoint(undefined);
                setProjects(current => [...current.filter(item => item.id !== project.id), project]);
                setWorkspaces(current => current.map(workspace => workspace.id === activeWorkspaceId
                  ? {
                      ...workspace,
                      projectIds: [...new Set([...workspace.projectIds, project.id])],
                      defaultProjectId: workspace.defaultProjectId ?? project.id
                    }
                  : workspace));
                refreshBoards();
                refreshConnections();
                navigate({ projectId: project.id });
              }}
            />
          </div>
        </div>
      )}
      {addProjectOpen && (
        <AddProjectDialog onCancel={() => setAddProjectOpen(false)} onSelect={chooseAddProject} />
      )}
      {settingsDialogCategory && (
        <div
          className="settings-dialog-backdrop"
          data-testid="settings-dialog-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) {
              setSettingsDialogCategory(undefined);
            }
          }}
        >
          <section
            className="settings-dialog-shell"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            data-testid="settings-dialog"
          >
            <header className="settings-dialog-header">
              <div className="settings-dialog-heading">
                <span className="settings-dialog-mark"><Icon name="gear" size={18} /></span>
                <div>
                  <h1 id="settings-dialog-title">Settings</h1>
                  <p>Configure Praxis for this device.</p>
                </div>
              </div>
              <button
                className="project-dialog-close"
                type="button"
                aria-label="Close settings"
                onClick={() => setSettingsDialogCategory(undefined)}
              >
                ×
              </button>
            </header>
            <div className="settings-dialog-body">
              <SettingsPage
                key={settingsDialogCategory}
                connections={connections}
                initialCategory={settingsDialogCategory}
                onOpenConnections={() => {
                  setSettingsDialogCategory(undefined);
                  refreshConnections();
                  navigate({ feature: 'connections' });
                }}
                onNewAgentItem={kind => {
                  setSettingsDialogCategory(undefined);
                  setAgentDialog(kind);
                }}
                onOpenAgent={agentId => {
                  setSettingsDialogCategory(undefined);
                  navigate({ ...route, feature: 'agents', agentId, agentProfileId: undefined, skillName: undefined });
                }}
                onOpenAgentProfile={agentProfileId => {
                  setSettingsDialogCategory(undefined);
                  navigate({ ...route, feature: 'agents', agentProfileId, agentId: undefined, skillName: undefined });
                }}
                onOpenSkill={skillName => {
                  setSettingsDialogCategory(undefined);
                  navigate({ ...route, feature: 'agents', skillName, agentId: undefined, agentProfileId: undefined });
                }}
              />
            </div>
            <footer className="settings-dialog-footer">
              <span>Changes are saved automatically.</span>
              <button className="btn btn-primary" type="button" onClick={() => setSettingsDialogCategory(undefined)}>Done</button>
            </footer>
          </section>
        </div>
      )}
      {importProjectsOpen && activeWorkspaceId && (
        <div className="modal-overlay" data-testid="import-projects-overlay">
          <div className="modal-card import-projects-card">
            <ImportProjectsWizard
              workspaceId={activeWorkspaceId}
              onDone={() => {
                setImportProjectsOpen(false);
                refreshProjects();
                refreshBoards();
                // The import adds its projects to the open workspace, and the
                // sidebar scopes its tree to that record — without this the
                // projects exist but stay filtered out of view.
                refreshWorkspaces();
              }}
            />
          </div>
        </div>
      )}
      {whatsNewOpen && (
        <WhatsNewDialog
          onClose={() => setWhatsNewOpen(false)}
          onReplaySplash={() => {
            setSplashReplayKey(key => key + 1);
            setShowSplash(true);
          }}
        />
      )}
      {workspaceDialogOpen && (
        <WorkspaceDialog onCancel={() => setWorkspaceDialogOpen(false)} onCreate={saveNewWorkspace} />
      )}
      {startRunDialog && (() => {
        const project = projects.find(candidate => candidate.id === startRunDialog.projectId);
        if (!project) return null;
        return (
          <StartRunDialog
            project={project}
            connections={connections}
            runnableWorkflows={workflowsByProject[project.id] ?? []}
            initialWorkflowId={startRunDialog.workflowId}
            planInput={pendingWorkflowPlan}
            onClose={() => {
              setStartRunDialog(undefined);
              setPendingWorkflowPlan(undefined);
            }}
            onStarted={run => {
              setStartRunDialog(undefined);
              setPendingWorkflowPlan(undefined);
              navigate({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: run.runId });
            }}
          />
        );
      })()}
      {newWorkflowForProject && (
        <NewWorkflowDialog
          projectId={newWorkflowForProject}
          onClose={() => setNewWorkflowForProject(undefined)}
          onCreated={definition => {
            const projectId = newWorkflowForProject;
            setNewWorkflowForProject(undefined);
            bumpWorkflows();
            navigate({ projectId, feature: 'workflows', workflowId: definition.id });
          }}
        />
      )}
      {agentDialog === 'profile' && (
        <CreateAgentProfileDialog
          defaultScope="global"
          existingIds={(agentSnapshot?.profiles ?? []).map(profile => profile.profile.id)}
          onClose={() => setAgentDialog(undefined)}
          onCreated={snap => { setAgentSnapshot(snap); setAgentDialog(undefined); }}
        />
      )}
      {agentDialog === 'agent' && (
        <CreateAgentDialog
          defaultScope="global"
          existingIds={(agentSnapshot?.runtimeHosts ?? agentSnapshot?.agents ?? []).map(agent => agent.manifest.id)}
          onClose={() => setAgentDialog(undefined)}
          onCreated={snap => { setAgentSnapshot(snap); setAgentDialog(undefined); }}
        />
      )}
      {agentDialog === 'skill' && (
        <CreateSkillDialog
          defaultScope="global"
          existingNames={(agentSnapshot?.skills ?? []).map(skill => skill.metadata.name)}
          onClose={() => setAgentDialog(undefined)}
          onCreated={snap => { setAgentSnapshot(snap); setAgentDialog(undefined); }}
        />
      )}
      {agentDialog === 'import' && (
        <ImportDialog
          defaultScope="global"
          allowedKinds={['profile', 'skill']}
          onClose={() => setAgentDialog(undefined)}
          onImported={snap => { setAgentSnapshot(snap); setAgentDialog(undefined); }}
        />
      )}
      {agentDialog === 'import-binding' && (
        <ImportDialog
          defaultScope="global"
          allowedKinds={['agent']}
          onClose={() => setAgentDialog(undefined)}
          onImported={snap => { setAgentSnapshot(snap); setAgentDialog(undefined); }}
        />
      )}
      {startupResolved && !showSplash && !aiSetupNeeded && <SessionRecoveryDialog />}
      {showSplash && <StartupSplash key={splashReplayKey} version={appVersion} brief={splashBrief && splashReplayKey === 0} onDone={() => setShowSplash(false)} />}
      {paletteOpen && !aiSetupNeeded && (
        <CommandPalette entries={paletteEntries} onSearch={searchIssues} onClose={() => setPaletteOpen(false)} />
      )}
      {walkthroughOpen && <Walkthrough stops={walkthroughStops} onDone={finishWalkthrough} />}
      {!aiSetupNeeded && <AssistantFloating />}
    </div>
  );
}
