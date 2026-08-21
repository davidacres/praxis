import { useMemo, useState } from 'react';
import type { Board, Connection } from '@ticket-manager/core';
import { Icon, type IconName } from './Icon';
import { backendModeMeta, boardTypeIcon, boardTypeLabel } from './boardMeta';

export type SidebarMode = 'classic' | 'work';

export type FeatureId =
  | 'overview'
  | 'epics'
  | 'sessions'
  | 'issues'
  | 'connections'
  | 'agents'
  | 'settings';

interface FeatureDef {
  id: FeatureId;
  label: string;
  icon: IconName;
}

/**
 * The bottom block, in the same idiom as the reference "Customizations" list:
 * glyph, label, right-aligned count. These are the Ticket Manager surfaces that
 * are not boards.
 */
const FEATURES: FeatureDef[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'epics', label: 'Epics', icon: 'rocket' },
  { id: 'sessions', label: 'Sessions', icon: 'robot' },
  { id: 'issues', label: 'Issues', icon: 'ticket' },
  { id: 'connections', label: 'Connections', icon: 'plug' },
  { id: 'agents', label: 'Agents', icon: 'zap' },
  { id: 'settings', label: 'Settings', icon: 'gear' }
];

export interface SidebarProps {
  boards: Board[];
  connections: Connection[];
  selectedBoardId: string | undefined;
  onSelectBoard: (board: Board) => void;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  activeFeature: FeatureId | undefined;
  onSelectFeature: (feature: FeatureId) => void;
  featureCounts: Partial<Record<FeatureId, number>>;
  onNewSession: () => void;
  /** Clicking the "Boards" heading returns to the board area and refreshes the list. */
  onShowBoards: () => void;
}

interface BoardGroup {
  key: string;
  label: string;
  icon: IconName;
  tone: string;
  boards: Board[];
}

export function Sidebar({
  boards,
  connections,
  selectedBoardId,
  onSelectBoard,
  mode,
  onModeChange,
  activeFeature,
  onSelectFeature,
  featureCounts,
  onNewSession,
  onShowBoards
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  /**
   * Boards are flat in the data model, so the folder level is synthesised from
   * the owning connection — boards with no connectionId come from the built-in
   * demo backend.
   */
  const groups = useMemo<BoardGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? boards.filter(board => board.name.toLowerCase().includes(needle))
      : boards;

    const byKey = new Map<string, BoardGroup>();
    for (const board of visible) {
      const connection = connections.find(candidate => candidate.id === board.connectionId);
      const key = board.connectionId ?? 'demo';
      const meta = backendModeMeta(connection?.mode ?? (board.connectionId ? undefined : 'demo'));
      const existing = byKey.get(key);
      if (existing) {
        existing.boards.push(board);
      } else {
        byKey.set(key, {
          key,
          label: connection?.name ?? meta.label,
          icon: meta.icon,
          tone: meta.tone,
          boards: [board]
        });
      }
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [boards, connections, query]);

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Workspace</h2>
        <button className="new-pill" onClick={onNewSession} data-testid="new-session">
          <Icon name="plus" size={13} />
          New
          <span className="kbd">Ctrl+N</span>
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Filter">
          <Icon name="sliders" size={14} />
        </button>
        <button
          className={`icon-btn icon-btn-sm${searching ? ' active' : ''}`}
          aria-label="Search boards"
          onClick={() => {
            setSearching(open => !open);
            setQuery('');
          }}
        >
          <Icon name="search" size={14} />
        </button>
      </div>

      <div className="segmented" role="tablist" aria-label="Sidebar mode">
        <button
          role="tab"
          aria-selected={mode === 'classic'}
          className={`segmented-btn${mode === 'classic' ? ' active' : ''}`}
          onClick={() => onModeChange('classic')}
          data-testid="mode-classic"
        >
          <Icon name="columns" size={13} />
          Classic
        </button>
        <button
          role="tab"
          aria-selected={mode === 'work'}
          className={`segmented-btn${mode === 'work' ? ' active' : ''}`}
          onClick={() => onModeChange('work')}
          data-testid="mode-work"
        >
          <Icon name="robot" size={13} />
          Work
        </button>
      </div>

      {searching && (
        <div style={{ padding: '4px 12px 8px' }}>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            placeholder="Filter boards…"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
      )}

      <div className="sidebar-scroll">
        <button
          className="sidebar-section-label sidebar-section-button"
          data-testid="nav-board"
          onClick={onShowBoards}
        >
          Boards
        </button>

        {groups.length === 0 && (
          <div style={{ padding: '4px 12px' }} className="placeholder-text">
            No boards.
          </div>
        )}

        {groups.map(group => {
          const isCollapsed = collapsed[group.key] ?? false;
          return (
            <div key={group.key}>
              <button
                className="tree-row"
                style={{ paddingLeft: 4 }}
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed(current => ({ ...current, [group.key]: !isCollapsed }))
                }
              >
                <span className={`tree-twisty${isCollapsed ? '' : ' open'}`}>
                  <Icon name="chevron-right" size={13} />
                </span>
                <span className="tree-icon folder" style={{ color: group.tone }}>
                  <Icon name={isCollapsed ? 'folder' : 'folder-open'} size={15} />
                </span>
                <span className="tree-label">{group.label}</span>
                <span className="tree-meta">{group.boards.length}</span>
              </button>

              {!isCollapsed &&
                group.boards.map(board => (
                  <button
                    key={`${group.key}:${board.id}`}
                    data-testid="board-nav-item"
                    className={`tree-row tree-row-stacked${
                      board.id === selectedBoardId ? ' active' : ''
                    }`}
                    style={{ paddingLeft: 26 }}
                    title={`${boardTypeLabel(board)} · ${board.projectKey ?? board.name}`}
                    onClick={() => onSelectBoard(board)}
                  >
                    <span className="tree-icon" style={{ color: group.tone }}>
                      <Icon name={boardTypeIcon(board)} size={15} />
                    </span>
                    <span className="tree-stack">
                      <span className="tree-label">{board.name}</span>
                      <span className="tree-sub">
                        <Icon name="folder" size={12} />
                        {boardTypeLabel(board)}
                        {board.projectKey ? ` · ${board.projectKey}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-section-label" style={{ marginTop: 0 }}>
          Ticket Manager
        </div>
        {FEATURES.map(feature => (
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
        ))}
      </div>
    </nav>
  );
}
