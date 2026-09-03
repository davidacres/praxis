import { useCallback, useEffect, useRef, useState } from 'react';
import type { Connection, TrackedBoard } from '@praxis/core';
import { backendModeMeta } from '../board/boardMeta';
import { Icon } from '../ui/Icon';
import { BoardPicker } from './BoardPicker';
import { ConnectionForm } from './ConnectionForm';
import { supportsManualBoardSelection } from './connectionPolicy';

export interface ConnectionsProps {
  /** Notified after any mutation so the app shell can refresh boards/counts. */
  onChanged?: () => void;
}

/**
 * Two-pane connections manager: connection list left, detail right (the same
 * idiom as the settings page). The detail pane is one of:
 *   - the add/edit form for the selected connection,
 *   - the board picker (for modes with discoverable remote boards),
 *   - an empty prompt when nothing is selected.
 *
 * Project boards use normal `app` or `folder` connection modes. The project
 * records only own their association and identity metadata.
 */
export function Connections({ onChanged }: ConnectionsProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [pickingBoardsFor, setPickingBoardsFor] = useState<string | undefined>();
  const [trackedBoards, setTrackedBoards] = useState<TrackedBoard[]>([]);
  const [boardCounts, setBoardCounts] = useState<Record<string, number>>({});
  const [pendingRemoval, setPendingRemoval] = useState<Connection | undefined>();
  const [error, setError] = useState<string | undefined>();
  const reloadSequence = useRef(0);

  const reload = useCallback(() => {
    const sequence = ++reloadSequence.current;
    window.praxis.connection.list()
      .then(list => {
        if (sequence !== reloadSequence.current) return;
        setConnections(list);
        // A removed connection must not stay selected.
        setSelectedId(current => (current && !list.some(c => c.id === current) ? undefined : current));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(reload, [reload]);

  // Connection settings can also be changed by the VS Code companion (or by
  // another window) while this view is open. A lightweight refresh keeps the
  // list truthful even when the originating form has been unmounted before
  // its async remove callback completes.
  useEffect(() => {
    const timer = window.setInterval(reload, 500);
    return () => window.clearInterval(timer);
  }, [reload]);

  const selected = creating ? undefined : connections.find(c => c.id === selectedId);
  const pickerConnection = pickingBoardsFor
    ? connections.find(c => c.id === pickingBoardsFor)
    : undefined;
  const reloadTracked = useCallback(() => {
    if (!selected) {
      setTrackedBoards([]);
      return;
    }
    window.praxis.connection
      .getTrackedBoards(selected.id)
      .then(setTrackedBoards)
      .catch(() => setTrackedBoards([]));
  }, [selected]);

  useEffect(reloadTracked, [reloadTracked]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      connections.map(async connection => [connection.id, (await window.praxis.connection.getTrackedBoards(connection.id)).length] as const)
    ).then(entries => {
      if (!cancelled) setBoardCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const removeConnection = async (connection: Connection) => {
    const boardCount = boardCounts[connection.id] ?? 0;
    if (boardCount > 0) return;
    try {
      const projectId = typeof connection.settings.projectId === 'string'
        ? connection.settings.projectId
        : undefined;
      if (projectId) {
        try {
          await window.praxis.projects.remove(projectId);
        } catch (error) {
          // A project connection can outlive its project record after a
          // workspace file is removed. In that case there is no project to
          // delete, so purge the stale projection directly.
          if (!(error instanceof Error) || !error.message.includes('was not found')) throw error;
          await window.praxis.connection.remove(connection.id);
        }
      } else {
        await window.praxis.connection.remove(connection.id);
      }
      setSelectedId(current => (current === connection.id ? undefined : current));
      setConnections(current => current.filter(candidate => candidate.id !== connection.id));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingRemoval(undefined);
    }
  };

  const removeTracked = (board: TrackedBoard) => {
    void window.praxis.connection
      .removeTrackedBoard(board.connectionId, board.boardId)
      .then(() => {
        reloadTracked();
        onChanged?.();
      });
  };

  // Legacy project-mode rows are intentionally hidden until startup migrates
  // them into persisted app or folder connections.
  const visibleConnections = connections.filter(connection => connection.mode !== 'project');

  const renderRow = (connection: Connection, testId: string) => {
    const meta = backendModeMeta(connection.mode);
    const select = () => {
      setCreating(false);
      setSelectedId(connection.id);
      setPickingBoardsFor(undefined);
    };
    return (
      <div
        key={connection.id}
        data-testid={testId}
        className={`list-row${!creating && connection.id === selectedId ? ' active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={select}
        onKeyDown={event => {
          if (event.key === 'Enter') select();
        }}
      >
        <span className="conn-mode-dot" style={{ background: meta.tone }} />
        <div className="conn-row-text">
          <div className="list-row-title">{connection.name}</div>
          <div className="list-row-meta">{meta.label}</div>
        </div>
        <button
          type="button"
          className="btn btn-icon conn-remove-row"
          aria-label={`Remove ${connection.name}`}
          title={
            (boardCounts[connection.id] ?? 0) > 0
              ? 'Remove all tracked boards first'
              : typeof connection.settings.projectId === 'string'
                ? 'Remove project and its board'
                : 'Remove connection'
          }
          disabled={(boardCounts[connection.id] ?? 0) > 0}
          onClick={event => {
            event.stopPropagation();
            setPendingRemoval(connection);
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    );
  };

  const detail = () => {
    if (pickerConnection) {
      return (
        <BoardPicker
          connection={pickerConnection}
          onDone={() => {
            setPickingBoardsFor(undefined);
            reloadTracked();
            onChanged?.();
          }}
        />
      );
    }
    if (creating || selected) {
      return (
        <>
          <ConnectionForm
            key={creating ? 'new' : selected!.id}
            existing={selected}
            onPersisted={() => {
              reload();
              onChanged?.();
            }}
            onSaved={(connection, followUp) => {
              setCreating(false);
              setSelectedId(connection.id);
              reload();
              onChanged?.();
              if (followUp === 'boards') {
                setPickingBoardsFor(connection.id);
              }
            }}
            onCancel={() => {
              // Cancelling an edit deselects; cancelling a create just closes the form.
              setCreating(false);
              setSelectedId(undefined);
            }}
          />
          {selected && (
            <section className="conn-boards" data-testid="conn-boards">
              <div className="conn-boards-header">
                <span className="conn-boards-title">Tracked boards</span>
                {supportsManualBoardSelection(selected.mode) && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="conn-pick-boards-btn"
                    onClick={() => setPickingBoardsFor(selected.id)}
                  >
                    <Icon name="plus" size={13} />
                    Pick boards…
                  </button>
                )}
              </div>
              {trackedBoards.length === 0 ? (
                <p className="placeholder-text">No tracked boards yet.</p>
              ) : (
                trackedBoards.map(board => (
                  <div key={board.boardId} className="list-row" data-testid="tracked-board-row">
                    <div>
                      <div className="list-row-title">{board.displayName ?? board.boardId}</div>
                      <div className="list-row-meta">{board.boardId}</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`Stop tracking ${board.displayName ?? board.boardId}`}
                      title="Stop tracking this board"
                      onClick={() => removeTracked(board)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))
              )}
            </section>
          )}
        </>
      );
    }
    return (
      <div className="empty-state" data-testid="conn-empty">
        <Icon name="plug" size={28} />
        <span>A connection&rsquo;s settings appear here. Select one, or add a new one.</span>
      </div>
    );
  };

  return (
    <div className="connections-page" data-testid="connections-page">
      <aside className="connections-list">
        <div className="connections-list-header">
          <span className="view-title">Connections</span>
          <button
            type="button"
            className="btn"
            data-testid="add-connection-btn"
            onClick={() => {
              setCreating(true);
              setSelectedId(undefined);
              setPickingBoardsFor(undefined);
            }}
          >
            <Icon name="plus" size={13} />
            Add
          </button>
        </div>
        <div className="connections-list-scroll">
          {error && <div className="error-banner">{error}</div>}
          {visibleConnections.length === 0 && !error && (
            <p className="placeholder-text" style={{ padding: '0 var(--space-2)' }}>
              No connections yet.
            </p>
          )}
          {visibleConnections.map(connection => renderRow(connection, 'connection-row'))}
        </div>
      </aside>
      <section className="connections-detail">{detail()}</section>
      {pendingRemoval && (
        <div className="modal-overlay" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setPendingRemoval(undefined);
        }}>
          <section className="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="connection-remove-title">
            <header className="modal-header">
              <Icon name="trash" size={15} />
              <h3 id="connection-remove-title">Remove {typeof pendingRemoval.settings.projectId === 'string' ? 'project' : 'connection'}?</h3>
            </header>
            <div className="modal-body">
              <p>
                {typeof pendingRemoval.settings.projectId === 'string'
                  ? `This removes “${pendingRemoval.name}” and its project board. The project folder will be kept.`
                  : `This removes the “${pendingRemoval.name}” connection and its saved credentials.`}
              </p>
            </div>
            <footer className="modal-footer">
              <button type="button" className="btn" onClick={() => setPendingRemoval(undefined)}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={() => void removeConnection(pendingRemoval)}>Remove</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
