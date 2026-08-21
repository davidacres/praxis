import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, BoardDetails, Connection } from '@ticket-manager/core';
import { IssueDetail } from './IssueDetail';
import { Connections } from './Connections';
import { TitleBar } from './TitleBar';
import { Sidebar, type FeatureId, type SidebarMode } from './Sidebar';
import { NewSession } from './NewSession';
import { BoardView } from './BoardView';
import { WorkModeView } from './WorkModeView';
import { BottomPanel } from './BottomPanel';
import { Icon } from './Icon';
import { backendModeMeta, boardTypeToken } from './boardMeta';
import { useResizable } from './useResizable';

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

  const refreshBoards = useCallback(() => {
    void window.ticketManager.board.list(EMPTY_FILTERS).then(setBoards);
  }, []);

  const refreshConnections = useCallback(() => {
    void window.ticketManager.connection.list().then(setConnections);
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
  const contextLabel = route.feature
    ? FEATURE_TITLES[route.feature]
    : selectedBoard?.name ?? 'New session';
  const contextDetail = route.feature
    ? 'Ticket Manager'
    : connection?.name ?? backendModeMeta(selectedBoard?.connectionId ? undefined : 'demo').label;

  const centre = () => {
    if (route.feature === 'connections') {
      return (
        <div className="view-scroll">
          <Connections />
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
    if (mode === 'work') {
      return (
        <div className="view-scroll">
          <WorkModeView
            boards={boards}
            connections={connections}
            detailsByBoardId={detailsByBoardId}
            onOpenBoard={board => navigate({ boardId: board.id })}
            onOpenIssue={(board, issueKey) => navigate({ boardId: board.id, issueKey })}
          />
        </div>
      );
    }
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
    if (!boardDetails) {
      return <div className="empty-state">Loading board…</div>;
    }
    // No scroll wrapper: the board's columns own the pane height themselves.
    return (
      <BoardView
        details={boardDetails}
        selectedIssueKey={route.issueKey}
        onOpenIssue={issueKey => navigate({ boardId: selectedBoard.id, issueKey })}
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
                onSelectBoard={board => navigate({ boardId: board.id })}
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
