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
 *   - a read-only summary for a project's own connection,
 *   - the board picker (for modes with discoverable remote boards),
 *   - an empty prompt when nothing is selected.
 *
 * Project connections are listed but not editable: each one is a projection of
 * its project record that the main process rewrites whenever the project
 * changes, so an edit here would be silently reverted. They appear so that a
 * project's board has a visible connection like every other board — and so the
 * user can see where its work items actually come from.
 */
export function Connections({ onChanged }: ConnectionsProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [pickingBoardsFor, setPickingBoardsFor] = useState<string | undefined>();
  const [trackedBoards, setTrackedBoards] = useState<TrackedBoard[]>([]);
  const [error, setError] = useState<string | undefined>();
  const reloadSequence = useRef(0);

  const reload = useCallback(() => {
    const sequence = ++reloadSequence.current;
    window.praxis.connection
      .list()
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

  const removeTracked = (board: TrackedBoard) => {
    void window.praxis.connection
      .removeTrackedBoard(board.connectionId, board.boardId)
      .then(() => {
        reloadTracked();
        onChanged?.();
      });
  };

  const storedConnections = connections.filter(connection => connection.mode !== 'project');
  const projectConnections = connections.filter(connection => connection.mode === 'project');

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
    if (selected?.mode === 'project') {
      return <ProjectConnectionSummary connection={selected} />;
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
            onRemoved={removedId => {
              setSelectedId(undefined);
              setCreating(false);
              if (removedId) {
                setConnections(current => current.filter(connection => connection.id !== removedId));
              }
              onChanged?.();
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
        <span>Select a connection, or add a new one.</span>
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
          {storedConnections.length === 0 && !error && (
            <p className="placeholder-text" style={{ padding: '0 var(--space-2)' }}>
              No connections yet.
            </p>
          )}
          {storedConnections.map(connection => renderRow(connection, 'connection-row'))}
          {projectConnections.length > 0 && (
            <>
              <div className="connections-list-group">Project boards</div>
              {projectConnections.map(connection => renderRow(connection, 'project-connection-row'))}
            </>
          )}
        </div>
      </aside>
      <section className="connections-detail">{detail()}</section>
    </div>
  );
}

/**
 * Read-only detail for a project's own connection. It exists so the project's
 * board resolves like every other board; the project itself owns the settings,
 * so this reports them rather than offering to edit them.
 */
function ProjectConnectionSummary({ connection }: { connection: Connection }) {
  const folderBacked = connection.settings.source === 'folder';
  const roots = Array.isArray(connection.settings.roots)
    ? (connection.settings.roots as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  return (
    <div className="conn-form" data-testid="project-connection-summary">
      <h3 className="conn-form-title">{connection.name}</h3>
      <p className="placeholder-text">
        This connection belongs to a project and is managed with it. Change it from the project
        instead.
      </p>
      <dl className="conn-summary">
        <dt>Work items</dt>
        <dd data-testid="project-connection-source">
          {folderBacked ? 'Markdown plans in the project folder' : 'A Praxis board in the app'}
        </dd>
        <dt>Project key</dt>
        <dd>{String(connection.settings.projectKey ?? '—')}</dd>
        {folderBacked && (
          <>
            <dt>Folder</dt>
            <dd data-testid="project-connection-folder">{roots[0] ?? '—'}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
