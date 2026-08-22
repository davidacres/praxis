import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, BoardDetails, Connection } from '@ticket-manager/core';
import { IssueDetail } from './IssueDetail';
import { Connections } from './Connections';
import { SettingsPage } from './SettingsPage';
import { TitleBar } from './TitleBar';
import { Sidebar, type FeatureId, type SidebarMode } from './Sidebar';
import { NewSession } from './NewSession';
import { NewIssuePage } from './NewIssuePage';
import { BoardView } from './BoardView';
import { BottomPanel } from './BottomPanel';
import { Icon } from './Icon';
import { backendModeMeta, boardTypeToken } from './boardMeta';
import { useResizable } from './useResizable';
import { findTransitionToTargetStatus } from './boardTransitionMatch';

const EMPTY_FILTERS = { projectKeys: [], types: [], searchText: '' };

/**
 * One navigable location. Everything the centre and right panes render is
 * derived from this, which is what makes the title bar's back/forward arrows a
 * plain index into a list of routes.
 */
interface Route {
  feature?: FeatureId;
  boardId?: string;
  issueKey?: string;
  /** Show the create-ticket form for `boardId` instead of the board. */
  newIssue?: boolean;
}

const FEATURE_TITLES: Record<FeatureId, string> = {
  overview: 'Overview',
  epics: 'Epics',
  sessions: 'Sessions',
  issues: 'Issues',
  connections: 'Connections',
  agents: 'Agents',
  settings: 'Settings'
};

export function App() {
  const [nav, setNav] = useState<{ entries: Route[]; index: number }>({
    entries: [{}],
    index: 0
  });
  const route = nav.entries[nav.index];

  const [boards, setBoards] = useState<Board[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [boardDetails, setBoardDetails] = useState<BoardDetails | undefined>();
  const [detailsByBoardId, setDetailsByBoardId] = useState<Record<string, BoardDetails | undefined>>({});
  const [mode, setMode] = useState<SidebarMode>(
    () => (localStorage.getItem('tm-sidebar-mode') as SidebarMode | null) ?? 'classic'
  );
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [auxVisible, setAuxVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(false);

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

  // Both refreshers swallow-and-log rather than leaving the promise unhandled:
  // an IPC rejection used to silently leave the app on its previous (often
  // empty) list with nothing in the console to explain it.
  const refreshBoards = useCallback(() => {
    void window.ticketManager.board
      .list(EMPTY_FILTERS)
      .then(setBoards)
      .catch(error => console.error('Failed to load boards:', error));
  }, []);

  const refreshConnections = useCallback(() => {
    void window.ticketManager.connection
      .list()
      .then(setConnections)
      .catch(error => console.error('Failed to load connections:', error));
  }, []);

  useEffect(() => {
    refreshBoards();
    refreshConnections();
  }, [refreshBoards, refreshConnections]);

  useEffect(() => {
    localStorage.setItem('tm-sidebar-mode', mode);
  }, [mode]);

  const selectedBoard = useMemo(
    () => boards.find(board => board.id === route.boardId),
    [boards, route.boardId]
  );

  const refreshBoardDetails = useCallback(() => {
    if (selectedBoard) {
      void window.ticketManager.board.get(selectedBoard).then(setBoardDetails);
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
      const issue = await window.ticketManager.issue.get(issueKey, moveConnectionId);
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
          return window.ticketManager.issue
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
    void window.ticketManager.board.get(selectedBoard).then(setBoardDetails);
  }, [selectedBoard]);

  /** Work mode needs every board's issues at once, not just the selected one. */
  useEffect(() => {
    if (mode !== 'work' || boards.length === 0) {
      return;
    }
    let cancelled = false;
    void Promise.all(
      boards.map(async board => [board.id, await window.ticketManager.board.get(board)] as const)
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
      issues: boardDetails?.issues.length,
      connections: connections.length
    }),
    [boards, boardDetails, connections]
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
    ? 'New issue'
    : route.feature
      ? FEATURE_TITLES[route.feature]
      : selectedBoard?.name ?? 'New session';
  const contextDetail = route.feature
    ? 'Ticket Manager'
    : connection?.name ?? backendModeMeta(selectedBoard?.connectionId ? undefined : 'demo').label;

  const centre = () => {
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
    if (route.feature === 'settings') {
      return (
        <div className="view-scroll">
          <SettingsPage
            connections={connections}
            onOpenConnections={() => navigate({ feature: 'connections' })}
          />
        </div>
      );
    }
    if (route.feature) {
      return (
        <div className="empty-state">
          <Icon name="tools" size={28} />
          <span>{FEATURE_TITLES[route.feature]} is not wired up yet.</span>
        </div>
      );
    }
    // Work mode renders the board cards in the sidebar; the centre pane just
    // shows whatever is currently routed (New Session when nothing's picked,
    // BoardView for the selected board).
    if (!selectedBoard) {
      return (
        <NewSession
          workspaceName="ticket-manager"
          agentName="Ticket Agent"
          branchName="main"
          onSubmit={() => navigate({ feature: 'sessions' })}
          connectionCount={connections.length}
          onOpenConnections={() => {
            refreshConnections();
            navigate({ feature: 'connections' });
          }}
        />
      );
    }
    if (route.newIssue) {
      return (
        <NewIssuePage
          board={selectedBoard}
          connection={connection}
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
    return (
      <BoardView
        details={boardDetails}
        selectedIssueKey={route.issueKey}
        connectionId={selectedBoard.connectionId}
        onOpenIssue={issueKey => navigate({ boardId: selectedBoard.id, issueKey })}
        onNewIssue={() => navigate({ boardId: selectedBoard.id, newIssue: true })}
        canCreateIssue={canCreateIssue}
        createIssueHint={createIssueHint}
        onIssueMove={onIssueMove}
      />
    );
  };

  // The secondary sidebar is a pane the title-bar button owns outright, like the
  // bottom panel — selecting an issue fills it, it does not summon it.
  const showAux = auxVisible;

  return (
    <div className="window-root">
      <TitleBar
        contextLabel={contextLabel}
        contextDetail={contextDetail}
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
              <Sidebar
                boards={boards}
                connections={connections}
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
                  navigate({ feature });
                }}
                featureCounts={featureCounts}
                onNewSession={() => navigate({})}
                onShowBoards={() => {
                  refreshBoards();
                  refreshConnections();
                  navigate({ boardId: route.boardId });
                }}
              />
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
          <div className="pane-row">
            <main className="pane-main">{centre()}</main>

            {showAux && (
              <>
                <div
                  className={`splitter${aux.dragging ? ' dragging' : ''}`}
                  aria-label="Resize issue panel"
                  {...aux.handleProps}
                />
                <aside className="pane-aux" style={{ width: aux.size }}>
                  {route.issueKey === undefined ? (
                    <div className="empty-state" data-testid="aux-empty">
                      <Icon name="ticket" size={28} />
                      <span>Select a work item to see its details.</span>
                    </div>
                  ) : (
                    <IssueDetail
                      issueKey={route.issueKey}
                      connectionId={selectedBoard?.connectionId}
                      onClose={() => navigate({ ...route, issueKey: undefined })}
                      onChanged={refreshBoardDetails}
                    />
                  )}
                </aside>
              </>
            )}
          </div>

          {panelVisible && (
            <>
              <div
                className={`splitter-h${panel.dragging ? ' dragging' : ''}`}
                aria-label="Resize panel"
                {...panel.handleProps}
              />
              <div className="panel-dock" style={{ height: panel.size }}>
                <BottomPanel onClose={() => setPanelVisible(false)} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
