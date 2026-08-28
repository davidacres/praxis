import { useCallback, useEffect, useState } from 'react';
import type { Board, Connection, TrackedBoard } from '@praxis/core';

const EMPTY_BOARD_FILTERS = { projectKeys: [], types: [], searchText: '' };

export interface BoardPickerProps {
  connection: Connection;
  /** Called after a successful save, or when the user backs out without saving. */
  onDone: () => void;
}

/**
 * Checkbox list of the boards a connection's backend reports, preselected from
 * the tracked-boards store. Saving writes the add/remove diff. Used for modes
 * with genuinely discoverable remote boards (jiracloud/gitlab); demo and
 * livefolder synthesize their single board instead (see connectionPolicy).
 */
export function BoardPicker({ connection, onDone }: BoardPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [boards, setBoards] = useState<Board[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(undefined);
    Promise.all([
      window.ticketManager.board.list(EMPTY_BOARD_FILTERS, connection.id),
      window.ticketManager.connection.getTrackedBoards(connection.id)
    ])
      .then(([available, tracked]) => {
        setBoards(available);
        setSelected(new Set(tracked.map(board => board.boardId)));
        setLoading(false);
      })
      .catch((err: unknown) => {
        setBoards([]);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [connection.id]);

  useEffect(reload, [reload]);

  const toggle = (boardId: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(boardId)) {
        next.delete(boardId);
      } else {
        next.add(boardId);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const tracked = await window.ticketManager.connection.getTrackedBoards(connection.id);
      const trackedById = new Map(tracked.map(board => [board.boardId, board]));

      const toAdd: TrackedBoard[] = [];
      for (const boardId of selected) {
        if (!trackedById.has(boardId)) {
          const board = boards.find(candidate => candidate.id === boardId);
          toAdd.push({ connectionId: connection.id, boardId, displayName: board?.name ?? boardId });
        }
      }
      if (toAdd.length > 0) {
        await window.ticketManager.connection.addTrackedBoards(toAdd);
      }
      for (const board of tracked) {
        if (!selected.has(board.boardId)) {
          await window.ticketManager.connection.removeTrackedBoard(connection.id, board.boardId);
        }
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? boards.filter(board => `${board.name} ${board.id}`.toLowerCase().includes(needle))
    : boards;

  let content: React.ReactNode;
  if (loading) {
    content = <p className="placeholder-text">Loading boards…</p>;
  } else if (error && boards.length === 0) {
    content = (
      <>
        <div className="error-banner" data-testid="board-picker-error">
          {error}
        </div>
        <button type="button" className="btn" onClick={reload}>
          Retry
        </button>
      </>
    );
  } else if (boards.length === 0) {
    content = (
      <p className="placeholder-text" data-testid="board-picker-empty">
        No boards reported by this backend.
      </p>
    );
  } else {
    content = (
      <>
        <input
          className="input"
          type="search"
          data-testid="board-picker-search"
          placeholder="Filter boards…"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <div className="board-picker-list">
          {visible.map(board => (
            <label key={board.id} className="board-picker-row" data-testid="board-picker-row">
              <input
                type="checkbox"
                checked={selected.has(board.id)}
                onChange={() => toggle(board.id)}
              />
              <span className="board-picker-name">{board.name}</span>
              <span className="board-picker-id">{board.id}</span>
            </label>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="conn-form" data-testid="board-picker">
      <header className="view-header">
        <span className="view-title">Boards — {connection.name}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="board-picker-save"
          disabled={loading || saving || boards.length === 0}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save selection'}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="board-picker-cancel"
          disabled={saving}
          onClick={onDone}
        >
          Back
        </button>
      </header>
      <div className="conn-form-body">
        {error && boards.length > 0 && <div className="error-banner">{error}</div>}
        {content}
      </div>
    </div>
  );
}
