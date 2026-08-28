import { useMemo, useState } from 'react';
import type { Board, BoardDetails, Connection, ConnectionCheck, ProjectRecord } from '@praxis/core';
import { boardTypeIcon, boardTypeLabel } from './boardMeta';
import { BrandModeIcon } from './BrandModeIcon';
import { ConnectionStatusDot } from './ConnectionStatusDot';
import { Icon, type IconName } from './Icon';
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
];

export interface SidebarProps {
  boards: Board[];
  projects: ProjectRecord[];
  connections: Connection[];
  /** Latest health check per connection id; undefined entries are still checking. */
  connectionChecks: Record<string, ConnectionCheck | undefined>;
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
  onSelectGit: (project: ProjectRecord, view: 'graph' | 'changes' | 'conflicts') => void;
  selectedProjectId?: string;
  /** Selected issue for the peek card pinned above the footer (classic mode). */
  selectedIssueKey?: string;
  selectedIssueConnectionId?: string;
}

export function Sidebar({
  boards,
  projects,
  connections,
  connectionChecks,
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
  onSelectGit,
  selectedProjectId,
  selectedIssueKey,
  selectedIssueConnectionId
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const { settings } = useSettings();
  const newProjectEnabled = settings?.preview.enableNewProject ?? true;
  // Brand artwork (extension parity) vs generic board-type glyphs — Appearance
  // setting, applied live through the settings push channel.
  const showBrandArtwork = settings?.appearance.showBrandArtwork ?? true;
  // A board's mark comes from its connection's backend. The built-in boards
  // have no connection, so they fall back to the demo mark.
  const boardMode = (board: Board) =>
    connections.find(connection => connection.id === board.connectionId)?.mode ?? 'demo';
  // The "Ticket Manager" footer carries its own toggle, separate from the
  // connection-group collapse map above, because it isn't tied to a folder key.
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const projectEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.map(project => {
      const defaultBoard = boards.find(board => board.id === project.defaultBoardId && board.connectionId === `project:${project.id}`);
      const linkedBoards = project.linkedBoards.flatMap(link => {
        const board = boards.find(candidate => candidate.id === link.boardId && candidate.connectionId === link.connectionId);
        return board ? [{ link, board }] : [];
      });
      const matchesProject = !needle || `${project.name} ${project.key} ${project.type}`.toLowerCase().includes(needle);
      const matchesDefault = defaultBoard?.name.toLowerCase().includes(needle);
      const matchingLinkedBoards = needle && !matchesProject
        ? linkedBoards.filter(({ link, board }) => `${link.displayName} ${board.name}`.toLowerCase().includes(needle))
        : linkedBoards;
      return {
        project,
        defaultBoard: !needle || matchesProject || matchesDefault ? defaultBoard : undefined,
        linkedBoards: matchingLinkedBoards,
        visible: matchesProject || Boolean(matchesDefault) || matchingLinkedBoards.length > 0
      };
    }).filter(entry => entry.visible);
  }, [boards, projects, query]);
  const projectBoardKeys = useMemo(() => new Set(projectEntries.flatMap(({ project, defaultBoard, linkedBoards }) => [
    ...(defaultBoard ? [`${defaultBoard.connectionId}:${defaultBoard.id}`] : []),
    ...linkedBoards.map(({ board }) => `${board.connectionId}:${board.id}`)
  ])), [projectEntries]);
  const externalBoards = boards.filter(board => !projectBoardKeys.has(`${board.connectionId ?? ''}:${board.id}`));

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Workspace</h2>
        <div className="new-menu-anchor">
          <button
            className="new-pill new-pill-icon"
            aria-label="New"
            title="New (Ctrl+N)"
            onClick={() => setNewMenuOpen(open => !open)}
            data-testid="new-menu"
          >
            <Icon name="plus" size={13} />
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
            projects={projectEntries}
            connections={connections}
            detailsByBoardId={detailsByBoardId}
            onOpenBoard={onSelectBoard}
            onOpenIssue={onSelectIssue}
          />
        ) : (
          <>
            {newProjectEnabled && <>
              <div className="sidebar-section-heading">
                <button
                  className="sidebar-section-label sidebar-section-button sidebar-section-toggle"
                  aria-expanded={!projectsCollapsed}
                  data-testid="toggle-projects"
                  onClick={() => setProjectsCollapsed(value => !value)}
                >
                  <span className={`tree-twisty${projectsCollapsed ? '' : ' open'}`}><Icon name="chevron-right" size={13} /></span>
                  <span>Projects</span>
                  <span className="tree-meta">{projects.length}</span>
                </button>
                <button className="sidebar-section-add" aria-label="Add project" onClick={onNewProject}><Icon name="plus" size={13} /></button>
              </div>
              {!projectsCollapsed && (projects.length === 0
                ? <button className="sidebar-empty-project" onClick={onNewProject}>+ New Project</button>
                : projectEntries.map(({ project, defaultBoard, linkedBoards }) => {
                    const projectCollapsed = collapsed[`project:${project.id}`] ?? false;
                    const childCount = (defaultBoard ? 1 : 0) + linkedBoards.length;
                    const projectBoardsCollapsed = collapsed[`project:${project.id}:boards`] ?? false;
                    const projectGitCollapsed = collapsed[`project:${project.id}:git`] ?? false;
                    return <div className="project-tree" key={project.id} data-testid="project-tree">
                      <div className={`project-tree-parent${selectedProjectId === project.id ? ' active' : ''}`}>
                        <button
                          className="project-tree-toggle"
                          aria-label={`${projectCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                          aria-expanded={!projectCollapsed}
                          onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}`]: !projectCollapsed }))}
                        ><span className={`tree-twisty${projectCollapsed ? '' : ' open'}`}><Icon name="chevron-right" size={13} /></span></button>
                        <button className="project-tree-content" data-testid="project-nav-item" onClick={() => onSelectProject(project)}>
                          <span className="tree-icon project-icon"><Icon name="folder-open" size={15} /></span>
                          <span className="tree-stack"><span className="tree-label">{project.name}</span><span className="tree-sub">{project.key} · {project.type}</span></span>
                          <span className="tree-meta">{childCount}</span>
                        </button>
                      </div>
                      {!projectCollapsed && <div className="project-tree-children">
                        <button className="sidebar-subsection-toggle" aria-expanded={!projectBoardsCollapsed} onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:boards`]: !projectBoardsCollapsed }))}>
                          <span className={`tree-twisty${projectBoardsCollapsed ? '' : ' open'}`}><Icon name="chevron-right" size={11} /></span><span>Boards</span><span className="tree-meta">{childCount}</span>
                        </button>
                        {!projectBoardsCollapsed && <>
                        {defaultBoard && <button
                          className={`tree-row project-board-row${defaultBoard.id === selectedBoardId ? ' active' : ''}`}
                          data-testid="project-default-board-nav-item"
                          onClick={() => onSelectBoard(defaultBoard)}
                        >
                          <span className="tree-icon project-board-icon"><Icon name="columns" size={14} /></span>
                          <span className="tree-label">{defaultBoard.name}</span>
                          <span className="tree-badge">Default</span>
                        </button>}
                        {linkedBoards.map(({ link, board }) => <button
                          key={`${link.connectionId}:${link.boardId}`}
                          className={`tree-row project-board-row${board.id === selectedBoardId ? ' active' : ''}`}
                          data-testid="project-linked-board-nav-item"
                          onClick={() => onSelectBoard(board)}
                        >
                          <span className="tree-icon linked-board-icon"><Icon name="link" size={14} /></span>
                          <span className="tree-label">{link.displayName}</span>
                          <span className="tree-badge">Linked</span>
                        </button>)}
                        </>}
                        <button className="sidebar-subsection-toggle" aria-expanded={!projectGitCollapsed} onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:git`]: !projectGitCollapsed }))}>
                          <span className={`tree-twisty${projectGitCollapsed ? '' : ' open'}`}><Icon name="chevron-right" size={11} /></span><span>Git</span><span className="tree-meta">{project.workspaceFolder ? '1' : 'Setup'}</span>
                        </button>
                        {!projectGitCollapsed && <button
                          className={`tree-row project-git-row${activeFeature === 'git' && selectedProjectId === project.id ? ' active' : ''}`}
                          data-testid="project-git-nav-item"
                          // Reachable without a workspace on purpose: Git Graph
                          // then shows the setup screen, which explains what is
                          // missing and offers Choose folder / Clone. A disabled
                          // control would leave the user with no way forward.
                          title={!project.workspaceFolder ? 'Set up a Git workspace for this project' : undefined}
                          onClick={() => onSelectGit(project, 'graph')}
                        ><span className="tree-icon"><Icon name="git-branch" size={14} /></span><span className="tree-label">Graph</span><span className="tree-badge">{project.workspaceFolder ? 'Git' : 'Setup'}</span></button>}
                        {!projectGitCollapsed && project.workspaceFolder && <button className="tree-row project-git-child" data-testid="project-git-changes-nav-item" onClick={() => onSelectGit(project, 'changes')}><span className="tree-icon"><Icon name="file" size={14} /></span><span className="tree-label">Changes</span></button>}
                      </div>}
                    </div>;
                  }))}
            </>}
            <div className="sidebar-section-heading">
              <button className="sidebar-section-label sidebar-section-button sidebar-section-toggle" aria-expanded={!boardsCollapsed} data-testid="toggle-boards" onClick={() => setBoardsCollapsed(value => !value)}>
                <span className={`tree-twisty${boardsCollapsed ? '' : ' open'}`}><Icon name="chevron-right" size={13} /></span><span>Boards</span><span className="tree-meta">{externalBoards.length}</span>
              </button>
            </div>
            {!boardsCollapsed && <div className="external-board-tree">{externalBoards.length === 0 ? <span className="sidebar-empty-hint">No external boards</span> : externalBoards.map(board => <button key={`${board.connectionId}:${board.id}`} className={`tree-row${board.id === selectedBoardId ? ' active' : ''}`} data-testid="board-nav-item" title={boardTypeLabel(board)} onClick={() => onSelectBoard(board)}><span className="tree-icon">{showBrandArtwork ? <BrandModeIcon mode={boardMode(board)} size={14} /> : <Icon name={boardTypeIcon(board)} size={14} />}</span><span className="tree-label">{board.name}</span>{board.connectionId && <ConnectionStatusDot check={connectionChecks[board.connectionId]} />}</button>)}</div>}
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
            Praxis
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
