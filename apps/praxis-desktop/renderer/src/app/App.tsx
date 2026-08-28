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
  , ProjectRecord, WorkspaceRecord
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
import { useSettings } from '../settings/useSettings';
import {
  EMPTY_BOARD_FILTER,
  type BoardFilterPresentation,
  type BoardFilterValue
} from '../board/BoardFilterBar';
import { GitGraphPage } from '../git/GitGraphPage';

const EMPTY_FILTERS = { projectKeys: [], types: [], searchText: '' };

/**
 * One navigable location. Everything the centre and right panes render is
 * derived from this, which is what makes the title bar's back/forward arrows a
 * plain index into a list of routes.
 */
interface Route {
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
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | undefined>(
    () => localStorage.getItem('praxis-active-workspace') ?? undefined
  );
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const workspaceBootstrap = useRef(false);
  const [composerBoardId, setComposerBoardId] = useState<string>();
  const [connections, setConnections] = useState<Connection[]>([]);
  /** Agent sessions, most recent first — feeds the Sessions view and the sidebar badge. */
  const [agentSessions, setAgentSessions] = useState<AgentSessionRecord[]>([]);
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
  const [projectWizardMode, setProjectWizardMode] = useState<'create' | 'existing'>();
  const [selectedDesignerNode, setSelectedDesignerNode] = useState<TaskDesignerCanvasNode>();
  const [boardFilterState, setBoardFilterState] = useState<{
    boardId: string;
    value: BoardFilterValue;
  }>();
  const [boardFilterPresentation, setBoardFilterPresentation] = useState<{
    boardId: string;
    value: BoardFilterPresentation;
  }>();

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

  const navigate = useCallback((next: Route) => {
    setNav(current => {
      const entries = [...current.entries.slice(0, current.index + 1), next];
      return { entries, index: entries.length - 1 };
    });
  }, []);

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
      .then(setBoards)
      .catch(error => console.error('Failed to load boards:', error));
  }, []);

  const refreshConnections = useCallback(() => {
    void window.praxis.connection
      .list()
      .then(setConnections)
      .catch(error => console.error('Failed to load connections:', error));
  }, []);

  const refreshProjects = useCallback(() => {
    void window.praxis.projects.list().then(setProjects).catch(error => console.error('Failed to load projects:', error));
  }, []);

  const refreshWorkspaces = useCallback(() => {
    void window.praxis.workspaces.list().then(items => {
      setWorkspaces(items);
      if (items.length && !items.some(item => item.id === activeWorkspaceId)) {
        setActiveWorkspaceId(items[0].id);
        localStorage.setItem('praxis-active-workspace', items[0].id);
      }
    }).catch(error => console.error('Failed to load workspaces:', error));
  }, [activeWorkspaceId]);

  useEffect(() => {
    refreshBoards();
    refreshConnections();
    refreshProjects();
    refreshWorkspaces();
  }, [refreshBoards, refreshConnections, refreshProjects, refreshWorkspaces]);

  // First run with projects but no saved workspaces: seed one so the switcher
  // always has a current context.
  useEffect(() => {
    if (workspaceBootstrap.current || !projects.length || workspaces.length) return;
    workspaceBootstrap.current = true;
    void window.praxis.workspaces
      .create({ name: 'My Workspace', description: 'Your Praxis projects', projectIds: projects.map(project => project.id) })
      .then(workspace => {
        setWorkspaces([workspace]);
        setActiveWorkspaceId(workspace.id);
        localStorage.setItem('praxis-active-workspace', workspace.id);
      })
      .catch(error => console.error('Failed to create default workspace:', error));
  }, [projects, workspaces.length]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    localStorage.setItem('praxis-active-workspace', workspaceId);
  }, []);

  const createWorkspace = useCallback(() => setWorkspaceDialogOpen(true), []);

  const saveNewWorkspace = useCallback((name: string, description: string) => {
    void window.praxis.workspaces.create({ name, description, projectIds: [] }).then(workspace => {
      setWorkspaces(current => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      localStorage.setItem('praxis-active-workspace', workspace.id);
      setWorkspaceDialogOpen(false);
    }).catch(error => console.error('Failed to create workspace:', error));
  }, []);

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
      localStorage.setItem('praxis-active-workspace', workspace.id);
    }).catch(error => console.error('Failed to open workspace:', error));
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
        }
      })
      .catch(error => console.error('Failed to load AI sessions:', error));
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
  const selectedProject = projects.find(project => project.id === route.projectId);

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

  const contextLabel = route.newIssue
    ? route.newIssueType === 'Idea'
      ? 'New idea'
      : 'New issue'
    : selectedProject ? selectedProject.name
    : route.feature
      ? FEATURE_TITLES[route.feature]
      : selectedBoard?.name ?? 'New session';
  const contextDetail = route.feature
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

  const centre = () => {
    if (selectedProject && route.feature !== 'git') {
      return <ProjectWorkspace project={selectedProject} boards={boards} onOpenBoard={boardId => navigate({ boardId })} onOpenGit={() => navigate({ projectId: selectedProject.id, feature: 'git' })} />;
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
          projects={projects}
          boards={boards}
          connections={connections}
          sessions={agentSessions}
          connectionChecks={connectionChecks}
          onNewProject={() => setProjectWizardMode('create')}
          onNewSession={() => navigate({})}
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
          onNewSession={() => navigate({})}
          onOpenAiSettings={() => setSettingsDialogCategory('ai')}
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
    // Work mode renders the board cards in the sidebar; the centre pane just
    // shows whatever is currently routed (New Session when nothing's picked,
    // BoardView for the selected board).
    if (!selectedBoard) {
      return (
        <NewSession
          boards={boards}
          onSubmit={async ({ board, issueKey, title, goal, provider, model, toolMode, mode }) => {
            const project = board?.connectionId?.startsWith('project:')
              ? projects.find(item => item.id === board.connectionId?.slice('project:'.length))
              : undefined;
            const record = await window.praxis.ai.delegate({
              ...(issueKey ? { issueKey } : {}),
              mode,
              ...(board?.connectionId ? { connectionId: board.connectionId } : {}),
              task: { goal },
              provider,
              model,
              toolMode: project?.defaultAiToolMode ?? toolMode,
              workingDirectory: project?.workspaceFolder
            });
            await window.praxis.ai.renameSession(record.issueKey, title);
            navigate({ feature: 'sessions', sessionKey: record.issueKey });
          }}
          connectionCount={connections.length}
          onOpenConnections={() => {
            refreshConnections();
            navigate({ feature: 'connections' });
          }}
          projectCount={projects.length}
          onNewProject={newProjectEnabled ? () => setProjectWizardMode('create') : undefined}
          toolModeForBoard={board => board.connectionId?.startsWith('project:')
            ? projects.find(item => item.id === board.connectionId?.slice('project:'.length))?.defaultAiToolMode
            : undefined}
          onSelectedBoardChange={board => setComposerBoardId(current => current === board?.id ? current : board?.id)}
        />
      );
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
        onOpenThemes={() => setSettingsDialogCategory('themes')}
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
                  boards={boards}
                  projects={projects}
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  onSelectWorkspace={selectWorkspace}
                  onCreateWorkspace={createWorkspace}
                  onSaveWorkspace={saveWorkspaceToFile}
                  onOpenWorkspace={openWorkspaceFromFile}
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
                  onNewSession={() => navigate({})}
                  onNewProject={() => setProjectWizardMode('create')}
                  onAddExistingProject={() => setProjectWizardMode('existing')}
                  onSelectProject={project => navigate({ projectId: project.id })}
                  selectedProjectId={route.projectId}
                  selectedIssueKey={route.issueKey}
                  selectedIssueConnectionId={selectedBoard?.connectionId}
                  onSelectGit={(project, view) => navigate({ projectId: project.id, feature: 'git', gitView: view })}
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

      {projectWizardMode && newProjectEnabled && (
        <div className="project-dialog-backdrop" data-testid="project-dialog-backdrop">
          <div
            className="project-dialog-shell"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-dialog-title"
          >
            <NewProjectWizard
              mode={projectWizardMode}
              onCancel={() => setProjectWizardMode(undefined)}
              onCreated={project => {
                setProjectWizardMode(undefined);
                setProjects(current => [...current.filter(item => item.id !== project.id), project]);
                refreshBoards();
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
