import { useMemo, useState } from 'react';
import type { BackendMode, Board, BoardDetails, Connection, ConnectionCheck, ProjectRecord } from '@ticket-manager/core';
import { Icon, type IconName } from './Icon';
import { backendModeMeta, boardTypeIcon, boardTypeLabel } from './boardMeta';
import { BrandModeIcon } from './BrandModeIcon';
import { ConnectionStatusDot } from './ConnectionStatusDot';
import { IssuePeek } from './IssuePeek';
import { useSettings } from './useSettings';
import { WorkModeView } from './WorkModeView';

export type SidebarMode = 'classic' | 'work';

export type FeatureId =
  | 'overview'
  | 'epics'
  | 'sessions'
  | 'issues'
  | 'connections'
  | 'agents'
  | 'git';

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
  { id: 'git', label: 'Git Graph', icon: 'git-branch' }
];

export interface SidebarProps {
  boards: Board[];
  projects: ProjectRecord[];
  connections: Connection[];
  selectedBoardId: string | undefined;
  detailsByBoardId: Record<string, BoardDetails | undefined>;
  onSelectBoard: (board: Board) => void;
  onSelectIssue: (board: Board, issueKey: string) => void;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  activeFeature: FeatureId | undefined;
  onSelectFeature: (feature: FeatureId) => void;
  featureCounts: Partial<Record<FeatureId, number>>;
  onNewSession: () => void;
  onNewProject: () => void;
  onAddExistingProject: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  selectedProjectId?: string;
  /** Clicking the "Boards" heading returns to the board area and refreshes the list. */
  onShowBoards: () => void;
  /** Selected issue for the peek card pinned above the footer (classic mode). */
  selectedIssueKey?: string;
  selectedIssueConnectionId?: string;
  /** Latest health-check per connection id — drives the group-row status dots. */
  connectionChecks?: Record<string, ConnectionCheck | undefined>;
}

interface BoardGroup {
  key: string;
  label: string;
  icon: IconName;
  tone: string;
  /** Owning connection's backend mode ('demo' for the built-in boards) — drives the brand icon. */
  mode: BackendMode;
  boards: Board[];
}

export function Sidebar({
  boards,
  projects,
  connections,
  selectedBoardId,
  detailsByBoardId,
  onSelectBoard,
  onSelectIssue,
  mode,
  onModeChange,
  activeFeature,
  onSelectFeature,
  featureCounts,
  onNewSession,
  onNewProject,
  onAddExistingProject,
  onSelectProject,
  selectedProjectId,
  onShowBoards,
  selectedIssueKey,
  selectedIssueConnectionId,
  connectionChecks
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  // Brand artwork (extension parity) vs generic board-type glyphs — Appearance setting.
  const { settings } = useSettings();
  const showBrandArtwork = settings?.appearance.showBrandArtwork ?? true;
  const newProjectEnabled = settings?.preview.enableNewProject ?? true;
  // The "Ticket Manager" footer carries its own toggle, separate from the
  // connection-group collapse map above, because it isn't tied to a folder key.
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  /**
   * Boards are flat in the data model, so the folder level is synthesised from
   * the owning connection — boards with no connectionId come from the built-in
   * demo backend.
   */
  const groups = useMemo<BoardGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? boards.filter(board => board.name.toLowerCase().includes(needle) && !board.connectionId?.startsWith('project:'))
      : boards.filter(board => !board.connectionId?.startsWith('project:'));

    const byKey = new Map<string, BoardGroup>();
    for (const board of visible) {
      const connection = connections.find(candidate => candidate.id === board.connectionId);
      const key = board.connectionId ?? 'demo';
      const mode: BackendMode = connection?.mode ?? 'demo';
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
          mode,
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
        <div className="new-menu-anchor">
          <button className="new-pill" onClick={() => setNewMenuOpen(open => !open)} data-testid="new-menu">
            <Icon name="plus" size={13} />
            New
            <span className="kbd">Ctrl+N</span>
          </button>
          {newMenuOpen && <div className="new-menu" role="menu">
            {newProjectEnabled && <button role="menuitem" data-testid="new-project" onClick={() => { setNewMenuOpen(false); onNewProject(); }}><Icon name="plus" size={14} /><span><strong>Create New Project</strong><small>Start fresh with a brief and board</small></span></button>}
            {newProjectEnabled && <button role="menuitem" data-testid="add-existing-project" onClick={() => { setNewMenuOpen(false); onAddExistingProject(); }}><Icon name="folder-open" size={14} /><span><strong>Add Existing Project</strong><small>Bring an existing folder into Projects</small></span></button>}
            <button role="menuitem" data-testid="new-session" onClick={() => { setNewMenuOpen(false); onNewSession(); }}><Icon name="robot" size={14} /><span><strong>New Session</strong><small>Start AI on an existing ticket</small></span></button>
          </div>}
        </div>
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
        {mode === 'work' ? (
          <WorkModeView
            boards={boards}
            connections={connections}
            detailsByBoardId={detailsByBoardId}
            onOpenBoard={onSelectBoard}
            onOpenIssue={onSelectIssue}
          />
        ) : (
          <>
            {newProjectEnabled && <><button className="sidebar-section-label sidebar-section-button" onClick={onNewProject}>Projects <span className="tree-meta">{projects.length}</span></button>
            {projects.length === 0 ? <button className="sidebar-empty-project" onClick={onNewProject}>+ New Project</button> : projects.map(project => <button key={project.id} className={`tree-row tree-row-stacked${selectedProjectId === project.id ? ' active' : ''}`} data-testid="project-nav-item" onClick={() => onSelectProject(project)}><span className="tree-icon"><Icon name="folder-open" size={15} /></span><span className="tree-stack"><span className="tree-label">{project.name}</span><span className="tree-sub">{project.key} · {project.type}</span></span></button>)}</>}
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
                    {/* Health dot per real connection; the demo backend is
                        always local, so its group carries no dot. */}
                    {group.key !== 'demo' && (
                      <ConnectionStatusDot check={connectionChecks?.[group.key]} />
                    )}
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
                          {showBrandArtwork ? (
                            <BrandModeIcon mode={group.mode} size={15} />
                          ) : (
                            <Icon name={boardTypeIcon(board)} size={15} />
                          )}
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
          </>
        )}
      </div>

      {mode === 'classic' && selectedIssueKey && (
        <IssuePeek issueKey={selectedIssueKey} connectionId={selectedIssueConnectionId} />
      )}

      <div className="sidebar-footer">
        <button
          className="feature-section-toggle sidebar-section-button"
          aria-expanded={!featuresCollapsed}
          data-testid="toggle-features"
          onClick={() => setFeaturesCollapsed(collapsed => !collapsed)}
        >
          <span className="sidebar-section-label" style={{ margin: 0 }}>
            Ticket Manager
          </span>
          <span className={`tree-twisty${featuresCollapsed ? '' : ' open'}`}>
            <Icon name="chevron-right" size={13} />
          </span>
        </button>
        {!featuresCollapsed &&
          FEATURES.map(feature => (
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
