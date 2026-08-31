import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSessionRecord,
  AiProvider,
  Board,
  BoardDetails,
  Connection,
  ConnectionCheck,
  IssueSummary,
  TaskDesignerCanvasNode,
  TaskDesignerTicketNode
  , ProjectRecord, ProjectDocument, WorkspaceRecord
} from '@praxis/core';
import { IssueDetail } from '../issues/IssueDetail';
import { Connections } from '../connections/Connections';
import { SettingsPage, type SettingsCategory } from '../settings/SettingsPage';
import { TitleBar } from './TitleBar';
import { Sidebar, type FeatureId, type SidebarMode } from './Sidebar';
import { NewSession } from '../ai/NewSession';
import { NewIssuePage } from '../issues/NewIssuePage';
import { BoardView } from '../board/BoardView';
import { AiReviewPage } from '../ai/AiReviewPage';
import { LocalPeerReviewPage } from '../ai/LocalPeerReviewPage';
import { TaskDesignerPage } from '../taskDesigner/TaskDesignerPage';
import { TaskDesignerItemDetail } from '../taskDesigner/TaskDesignerItemDetail';
import { TaskDesignerSidebar } from '../taskDesigner/TaskDesignerSidebar';
import { BottomPanel } from './BottomPanel';
import { SessionsPage } from '../ai/SessionsPage';
import { Icon } from '../ui/Icon';
import { backendModeMeta, boardTypeToken } from '../board/boardMeta';
import { useResizable } from './useResizable';
import { findTransitionToTargetStatus } from '../board/boardTransitionMatch';
import { isTerminalAgentState } from '../ai/aiSessionState';
import { WhatsNewDialog } from './WhatsNewDialog';
import { StartupSplash } from './StartupSplash';
import { NewProjectWizard } from '../projects/NewProjectWizard';
import { ProjectHome } from '../projects/ProjectHome';
import { ProjectWorkspace } from '../projects/ProjectWorkspace';
import { OverviewPage } from './OverviewPage';
import { WorkspaceDialog } from './WorkspaceDialog';
import { GettingStarted } from './GettingStarted';
import { useSettings } from '../settings/useSettings';
import {
  EMPTY_BOARD_FILTER,
  type BoardFilterPresentation,
  type BoardFilterValue
} from '../board/BoardFilterBar';
import { GitGraphPage } from '../git/GitGraphPage';
import { ProjectDocumentPreview } from '../projects/ProjectDocumentPreview';

const EMPTY_FILTERS = { projectKeys: [], types: [], searchText: '' };

/**
 * One navigable location. Everything the centre and right panes render is
 * derived from this, which is what makes the title bar's back/forward arrows a
 * plain index into a list of routes.
 */
interface Route {
  /** Durable selection of the empty New Session surface (never its draft text). */
  newSession?: boolean;
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
  /** Whether the in-app browser was visible in the selected AI session. */
  browserOpen?: boolean;
  /** Last navigated URL in the in-app browser. */
  browserUrl?: string;
  /** Centre-pane AI tooling view for `issueKey` (review / peer review / designer). */
  view?: 'review' | 'lpr' | 'designer';
  /** Per-ticket runtime selected before opening an AI tool. */
  aiProvider?: AiProvider;
  aiModel?: string;
  gitView?: 'graph' | 'changes' | 'conflicts';
}

const FEATURE_TITLES: Record<FeatureId, string> = {
  overview: 'Overview',
  epics: 'Epics',
  sessions: 'Sessions',
  issues: 'Issues',
  connections: 'Connections',
  agents: 'Agents',
  git: 'Git Graph'
};

const LAST_WORKSPACE_ROUTE_KEY = 'praxis-last-workspace-route';
const ACTIVE_WORKSPACE_KEY = 'praxis-active-workspace';
const RECENT_WORKSPACES_KEY = 'praxis-recent-workspaces';

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
function readLastWorkspaceRoute(): Route {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_WORKSPACE_ROUTE_KEY) ?? '{}') as Record<string, unknown>;
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
      ...(gitView ? { gitView } : {})
    };
  } catch {
    return {};
  }
}

function writeLastWorkspaceRoute(route: Route): void {
  const durableRoute: Route = {
    ...(!route.projectId && !route.feature && !route.boardId ? { newSession: true } : {}),
    ...(route.projectId ? { projectId: route.projectId } : {}),
    ...(route.feature ? { feature: route.feature } : {}),
    ...(route.boardId ? { boardId: route.boardId } : {}),
    ...(route.issueKey ? { issueKey: route.issueKey } : {}),
    ...(route.sessionKey ? { sessionKey: route.sessionKey } : {}),
    ...(route.feature === 'sessions' && route.browserOpen !== undefined ? { browserOpen: route.browserOpen } : {}),
    ...(route.feature === 'sessions' && route.browserUrl && restorableBrowserUrl(route.browserUrl) ? { browserUrl: route.browserUrl } : {}),
    ...(route.gitView ? { gitView: route.gitView } : {})
  };
  localStorage.setItem(LAST_WORKSPACE_ROUTE_KEY, JSON.stringify(durableRoute));
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
  boards: Board[]
): Route {
  const workspaceProjects = projects.filter(project => workspace.projectIds.includes(project.id));
  const project = stored.projectId && workspaceProjects.find(candidate => candidate.id === stored.projectId);
  const board = stored.boardId && boards.find(candidate => {
    if (candidate.id !== stored.boardId) return false;
    const directProjectId = candidate.connectionId?.startsWith('project:')
      ? candidate.connectionId.slice('project:'.length)
      : undefined;
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
      ...(stored.feature === 'git' && stored.gitView ? { gitView: stored.gitView } : {})
    };
  }
  return routeForOpenedWorkspace(workspace, projects);
}

export function App() {
  const { settings } = useSettings();
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

  const [boards, setBoards] = useState<Board[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
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
  const [boardDetails, setBoardDetails] = useState<BoardDetails | undefined>();
  const [detailsByBoardId, setDetailsByBoardId] = useState<Record<string, BoardDetails | undefined>>({});
  /** Latest health-check per connection id — feeds the sidebar status dots. */
  const [connectionChecks, setConnectionChecks] = useState<
    Record<string, ConnectionCheck | undefined>
  >({});
  const [mode, setMode] = useState<SidebarMode>(
    () => (localStorage.getItem('tm-sidebar-mode') as SidebarMode | null) ?? 'classic'
  );
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [auxVisible, setAuxVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashReplayKey, setSplashReplayKey] = useState(0);
  const [settingsDialogCategory, setSettingsDialogCategory] = useState<SettingsCategory>();
  const [projectDocument, setProjectDocument] = useState<ProjectDocument>();
  const [projectWizardMode, setProjectWizardMode] = useState<'create' | 'existing'>();
  const [projectWizardPresentation, setProjectWizardPresentation] = useState<'dialog' | 'onboarding'>('dialog');
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
      const storedRoute = readLastWorkspaceRoute();
      let restored = restoredRouteForWorkspace(storedRoute, savedWorkspace, projects, boards);
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
    if (startupResolved && activeWorkspaceId && !gettingStarted) writeLastWorkspaceRoute(route);
  }, [activeWorkspaceId, gettingStarted, route, startupResolved]);

  // The sessions view selects its newest session when no explicit selection was
  // routed to it. Make that implicit selection durable too, so a restart opens
  // the same conversation rather than merely the sessions list.
  useEffect(() => {
    if (!startupResolved || route.feature !== 'sessions' || route.sessionKey || !agentSessions[0]) return;
    setNav(current => {
      const currentRoute = current.entries[current.index];
      if (currentRoute.feature !== 'sessions' || currentRoute.sessionKey) return current;
      const entries = [...current.entries];
      entries[current.index] = { ...currentRoute, sessionKey: agentSessions[0].issueKey };
      return { ...current, entries };
    });
  }, [agentSessions, route.feature, route.sessionKey, startupResolved]);

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
    max: 460,
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

  const updateSessionBrowserRoute = useCallback((patch: Pick<Route, 'browserOpen' | 'browserUrl'>) => {
    setNav(current => {
      const currentRoute = current.entries[current.index];
      if (currentRoute.feature !== 'sessions') return current;
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
    setNav({ entries: [routeForOpenedWorkspace(workspace, projects)], index: 0 });
  }, [projects, touchWorkspace, workspaces]);

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

  const saveNewWorkspace = useCallback((name: string, description: string) => {
    void window.praxis.workspaces.create({ name, description, projectIds: [] }).then(workspace => {
      setWorkspaces(current => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
      touchWorkspace(workspace.id);
      setNav({ entries: [{ feature: 'overview' }], index: 0 });
      setWorkspaceDialogOpen(false);
    }).catch(error => console.error('Failed to create workspace:', error));
  }, [touchWorkspace]);

  const createWorkspaceFromGettingStarted = useCallback(async (name: string, description: string) => {
    const workspace = await window.praxis.workspaces.create({ name, description, projectIds: [] });
    setWorkspaces(current => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    touchWorkspace(workspace.id);
    setCreatedWorkspaceId(workspace.id);
    setNav({ entries: [{ feature: 'overview' }], index: 0 });
  }, [touchWorkspace]);

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

  const requestProjectWizard = useCallback((wizardMode: 'create' | 'existing', presentation: 'dialog' | 'onboarding' = 'dialog') => {
    if (!activeWorkspaceId || !workspaces.some(workspace => workspace.id === activeWorkspaceId)) {
      setProjectWizardMode(undefined);
      setGettingStarted(true);
      return;
    }
    setGettingStarted(false);
    setProjectWizardPresentation(presentation);
    setProjectWizardMode(wizardMode);
  }, [activeWorkspaceId, workspaces]);

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
  // The project a workspace-level "New session" belongs to: the one on screen,
  // else the workspace's default project, else its only project. When one is
  // resolved the composer scopes to it (its folder, no board/ticket picker).
  const composerProject = selectedProject
    ?? workspaceProjects.find(project => project.id === activeWorkspace?.defaultProjectId)
    ?? (workspaceProjects.length === 1 ? workspaceProjects[0] : undefined);
  const workspaceBoards = activeWorkspace
    ? boards.filter(board => {
        const directProjectId = board.connectionId?.startsWith('project:')
          ? board.connectionId.slice('project:'.length)
          : undefined;
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
    (issueKey: string, targetStatus: string, moveConnectionId: string | undefined) => {
      getMoveTransition(issueKey, moveConnectionId, targetStatus)
        .then(transition => {
          if (!transition) {
            console.warn(
              `[board] no workflow transition matches target status "${targetStatus}" for ${issueKey}`
            );
            return;
          }
          return window.praxis.issue
            .transition(issueKey, transition.id, moveConnectionId)
            .then(() => refreshBoardDetails());
        })
        .catch(error => {
          console.error(`[board] failed to move ${issueKey} to "${targetStatus}"`, error);
        });
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        navigate({});
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const featureCounts = useMemo<Partial<Record<FeatureId, number>>>(
    () => ({
      epics: boards.filter(board => boardTypeToken(board) === 'epic').length,
      sessions: agentSessions.filter(session => !isTerminalAgentState(session.state)).length,
      issues: boardDetails?.issues.length,
      connections: connections.length
    }),
    [boards, boardDetails, connections, agentSessions]
  );

  const connection = connections.find(candidate => candidate.id === selectedBoard?.connectionId);

  /**
   * Whether the selected board's backend accepts new tickets. Demo always can;
   * live folder connections need their `allowIssueCreation` setting; the
   * not-yet-ported modes (jiracloud/gitlab/github/userworkspace) resolve to a
   * stub backend that throws, so the form would only error — the button is
   * disabled up front instead, with the hint saying why.
   */
  const canCreateIssue = !connection
    ? true
    : connection.mode === 'demo'
      ? true
      : connection.mode === 'livefolder' || connection.mode === 'userworkspace'
        ? connection.settings.allowIssueCreation === true
        : false;
  const createIssueHint =
    !connection || connection.mode === 'demo'
      ? undefined
      : connection.mode === 'livefolder' || connection.mode === 'userworkspace'
        ? 'Issue creation is disabled for this connection. Enable "Allow issue creation" in its settings.'
        : `Ticket creation is not available for ${backendModeMeta(connection.mode).label} connections yet.`;

  const onboardingProjectWizard = Boolean(projectWizardMode && projectWizardPresentation === 'onboarding');
  // WebContentsView is a native sibling of the renderer and always paints
  // above DOM z-index layers. Suspend it whenever an App-owned modal is above
  // the current surface, otherwise the page can bleed through the dialog.
  const nativeOverlayOpen = Boolean(
    settingsDialogCategory
      || workspaceDialogOpen
      || whatsNewOpen
      || (projectWizardMode && projectWizardPresentation === 'dialog')
  );
  const contextLabel = onboardingProjectWizard
    ? projectWizardMode === 'existing' ? 'Create from folder' : 'Create project'
    : gettingStarted
    ? 'Getting Started'
    : route.newIssue
    ? route.newIssueType === 'Idea'
      ? 'New idea'
      : 'New issue'
    : selectedProject ? selectedProject.name
    : route.feature
      ? FEATURE_TITLES[route.feature]
      : selectedBoard?.name ?? 'New session';
  const contextDetail = onboardingProjectWizard
    ? activeWorkspace?.name ?? 'Praxis'
    : gettingStarted
    ? 'Praxis'
    : route.feature
    ? 'Praxis'
    : connection?.name ?? backendModeMeta(selectedBoard?.connectionId ? undefined : 'demo').label;
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
      boards={workspaceBoards}
      onSubmit={async ({ board, issueKey, title, goal, provider, model, toolMode, mode, workingDirectory, runInWorktree }) => {
        const project = board?.connectionId?.startsWith('project:')
          ? workspaceProjects.find(item => item.id === board.connectionId?.slice('project:'.length))
          : composerProject;
        const record = await window.praxis.ai.delegate({
          ...(issueKey ? { issueKey } : {}),
          mode,
          ...(board?.connectionId ? { connectionId: board.connectionId } : {}),
          task: { goal },
          provider,
          model,
          toolMode: project?.defaultAiToolMode ?? toolMode,
          workingDirectory: project?.workspaceFolder ?? workingDirectory,
          ...(runInWorktree ? { runInWorktree: true } : {})
        });
        await window.praxis.ai.renameSession(record.issueKey, title);
        navigate({ feature: 'sessions', sessionKey: record.issueKey });
      }}
      defaultWorkingDirectory={composerProject?.workspaceFolder ?? boardProject?.workspaceFolder}
      {...(composerProject
        ? { scopeLabel: composerProject.name, defaultToolMode: composerProject.defaultAiToolMode }
        : {})}
      connectionCount={connections.length}
      onOpenConnections={() => {
        refreshConnections();
        navigate({ feature: 'connections' });
      }}
      projectCount={workspaceProjects.length}
      onNewProject={newProjectEnabled ? () => requestProjectWizard('create') : undefined}
      toolModeForBoard={board => board.connectionId?.startsWith('project:')
        ? projects.find(item => item.id === board.connectionId?.slice('project:'.length))?.defaultAiToolMode
        : undefined}
      onSelectedBoardChange={board => setComposerBoardId(current => current === board?.id ? current : board?.id)}
    />
  );

  const centre = () => {
    // A workspace-level session ("Sessions → New session"): the composer, not a
    // board or the project dashboard, even when a project is on the route.
    if (route.newSession) {
      return renderNewSession();
    }
    if (selectedProject && route.feature !== 'git') {
      return <ProjectWorkspace project={selectedProject} sessions={agentSessions} />;
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
          onNewProject={() => requestProjectWizard('create')}
          onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
          onOpenProjects={() => navigate({})}
          onOpenSessions={() => navigate({ feature: 'sessions' })}
          onOpenConnections={() => { refreshConnections(); navigate({ feature: 'connections' }); }}
          onOpenBoard={board => navigate({ boardId: board.id })}
          onOpenProject={project => navigate({ projectId: project.id })}
        />
      );
    }
    if (route.feature === 'sessions') {
      // No view-scroll wrapper: the sessions list and console own their scrolling.
      return (
        <SessionsPage
          sessions={agentSessions}
          selectedKey={route.sessionKey}
          onSelect={issueKey => navigate({ feature: 'sessions', sessionKey: issueKey })}
          onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
          onOpenAiSettings={() => setSettingsDialogCategory('ai')}
          initialBrowserOpen={route.browserOpen}
          initialBrowserUrl={route.browserUrl}
          onBrowserOpenChange={handleBrowserOpenChange}
          onBrowserUrlChange={handleBrowserUrlChange}
          browserSuspended={nativeOverlayOpen}
        />
      );
    }
    if (route.feature === 'git') {
      return <GitGraphPage repositoryPath={selectedProject?.workspaceFolder} initialView={route.gitView} />;
    }
    if (route.feature) {
      return (
        <div className="empty-state">
          <Icon name="tools" size={28} />
          <span>{FEATURE_TITLES[route.feature]} is not wired up yet.</span>
        </div>
      );
    }
    // AI tooling views take over the centre pane for the routed issue.
    if (route.issueKey && route.view === 'review') {
      return (
        <AiReviewPage
          issueKey={route.issueKey}
          connectionId={selectedBoard?.connectionId}
          provider={route.aiProvider}
          model={route.aiModel}
          onClose={() => navigate({ ...route, view: undefined })}
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
          <p>Connect a board source or add one from a plans folder to start tracking work.</p>
          <button
            className="btn btn-primary"
            data-testid="no-boards-create-btn"
            onClick={() => { refreshConnections(); navigate({ feature: 'connections' }); }}
          >
            Create board
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
      />
    );
  };

  // The secondary sidebar is a pane the title-bar button owns outright, like the
  // bottom panel — selecting an issue fills it, it does not summon it.
  // Project workspaces use the secondary pane for editable project details.
  // Git Graph owns its own inspector column, so the global issue pane remains
  // hidden there to preserve topology and diff width.
  const showAux = auxVisible
    && route.feature !== 'overview'
    && route.feature !== 'git';
  const detailIsExpanded = detailExpanded && showAux && route.issueKey !== undefined;
  const selectedAgentSession = route.feature === 'sessions'
    ? agentSessions.find(session => session.issueKey === route.sessionKey) ?? agentSessions[0]
    : undefined;
  const terminalBoard = selectedBoard ?? (!route.feature && !route.projectId
    ? boards.find(board => board.id === composerBoardId)
    : undefined);
  const boardProject = terminalBoard?.connectionId?.startsWith('project:')
    ? projects.find(project => project.id === terminalBoard.connectionId?.slice('project:'.length))
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
      <TitleBar
        appVersion={appVersion}
        contextLabel={contextLabel}
        contextDetail={contextDetail}
        onOpenWhatsNew={() => setWhatsNewOpen(true)}
        settingsOpen={settingsDialogCategory !== undefined}
        onOpenSettings={() => setSettingsDialogCategory(current => current ? undefined : 'overview')}
        onOpenThemes={() => setSettingsDialogCategory('appearance-themes')}
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

      {projectWizardMode && projectWizardPresentation === 'onboarding' && activeWorkspaceId ? (
        <div className="project-onboarding-frame" data-testid="project-wizard-onboarding">
          <NewProjectWizard
            workspaceId={activeWorkspaceId}
            workspaceName={activeWorkspace?.name}
            presentation="onboarding"
            mode={projectWizardMode}
            onCancel={() => setProjectWizardMode(undefined)}
            onCreated={project => {
              setProjectWizardMode(undefined);
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
      ) : gettingStarted ? (
        <GettingStarted
          workspaces={workspaces}
          recentWorkspaceIds={recentWorkspaceIds}
          createdWorkspace={workspaces.find(workspace => workspace.id === createdWorkspaceId)}
          onOpenWorkspace={openWorkspace}
          onOpenWorkspaceFile={openWorkspaceFromFile}
          onCreateWorkspace={createWorkspaceFromGettingStarted}
          onCreateProject={() => requestProjectWizard('create', 'onboarding')}
          onAddExistingProject={() => requestProjectWizard('existing', 'onboarding')}
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
              ) : (
                <Sidebar
                  boards={workspaceBoards}
                  projects={workspaceProjects}
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  onSelectWorkspace={openWorkspace}
                  onDeleteWorkspace={deleteWorkspace}
                  onCreateWorkspace={createWorkspace}
                  onSaveWorkspace={saveWorkspaceToFile}
                  onOpenWorkspace={openWorkspaceFromFile}
                  onCloseWorkspace={closeWorkspace}
                  connections={connections}
                  connectionChecks={connectionChecks}
                  selectedBoardId={route.boardId}
                  detailsByBoardId={detailsByBoardId}
                  onSelectBoard={board => navigate({ boardId: board.id })}
                  onSelectIssue={(board, issueKey) => navigate({ boardId: board.id, issueKey })}
                  mode={mode}
                  onModeChange={setMode}
                  activeFeature={route.feature}
                  onSelectFeature={feature => {
                    if (feature === 'connections') {
                      refreshConnections();
                    }
                    navigate(feature === 'git' && selectedProject ? { projectId: selectedProject.id, feature } : { feature });
                  }}
                  featureCounts={featureCounts}
                  onNewSession={() => navigate({ newSession: true, ...(composerProject ? { projectId: composerProject.id } : {}) })}
                  onNewProject={() => requestProjectWizard('create')}
                  onAddExistingProject={() => requestProjectWizard('existing')}
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
                  onDeleteBoard={board => {
                    if (!board.connectionId) return;
                    const connectionId = board.connectionId;
                    // "Delete" means different things per backend: a user-workspace
                    // connection owns many boards (drop just this one); a live-folder
                    // connection *is* its single board (drop the connection); a
                    // Jira/GitLab board is only tracked from a shared remote
                    // connection (untrack it, delete nothing remote).
                    const mode = connections.find(item => item.id === connectionId)?.mode;
                    const removed = mode === 'userworkspace'
                      ? window.praxis.userWorkspace.deleteBoard(connectionId, board.id)
                      : mode === 'livefolder'
                        ? window.praxis.connection.remove(connectionId)
                        : window.praxis.connection.removeTrackedBoard(connectionId, board.id);
                    void removed.then(() => {
                      if (route.boardId === board.id) navigate({});
                      refreshBoards();
                      refreshConnections();
                    });
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
                  {route.view === 'designer' ? (
                    selectedDesignerNode ? (
                      <TaskDesignerItemDetail
                        node={selectedDesignerNode}
                        onClose={() => setAuxVisible(false)}
                      />
                    ) : (
                      <div className="empty-state" data-testid="designer-item-empty">
                        <Icon name="cursor" size={28} />
                        <span>Select a designer item to see its details.</span>
                      </div>
                    )
                  ) : selectedProject && route.issueKey === undefined ? (
                    <ProjectHome project={selectedProject} boards={boards} onChanged={project => {
                      setProjects(current => current.map(item => item.id === project.id ? project : item));
                      refreshBoards();
                    }} onOpenBoard={boardId => navigate({ boardId })} onOpenGit={() => navigate({ projectId: selectedProject.id, feature: 'git' })} />
                  ) : route.issueKey === undefined ? (
                    <div className="empty-state" data-testid="aux-empty">
                      <Icon name="ticket" size={28} />
                      <span>Select a work item to see its details.</span>
                    </div>
                  ) : (
                    <IssueDetail
                      issueKey={route.issueKey}
                      connectionId={selectedBoard?.connectionId}
                      expanded={detailIsExpanded}
                      onToggleExpanded={() => setDetailExpanded(expanded => !expanded)}
                      onClose={() => {
                        setDetailExpanded(false);
                        navigate({ ...route, issueKey: undefined });
                      }}
                      onChanged={refreshBoardDetails}
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
              onCancel={() => setProjectWizardMode(undefined)}
              onCreated={project => {
                setProjectWizardMode(undefined);
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
              />
            </div>
            <footer className="settings-dialog-footer">
              <span>Changes are saved automatically.</span>
              <button className="btn btn-primary" type="button" onClick={() => setSettingsDialogCategory(undefined)}>Done</button>
            </footer>
          </section>
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
      {showSplash && <StartupSplash key={splashReplayKey} version={appVersion} onDone={() => setShowSplash(false)} />}
    </div>
  );
}
