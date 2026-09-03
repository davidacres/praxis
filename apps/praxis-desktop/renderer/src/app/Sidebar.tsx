import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRuntimeSnapshot,
  Board,
  BoardDetails,
  Connection,
  ConnectionCheck,
  ProjectDocument,
  ProjectRecord,
  WorkspaceRecord
} from '@praxis/core';
import { boardTypeIcon, boardTypeLabel, resolveBackendMode, statusTone } from '../board/boardMeta';
import { BrandModeIcon } from '../ui/BrandModeIcon';
import { ConnectionStatusDot } from '../ui/ConnectionStatusDot';
import { Icon, type IconName } from '../ui/Icon';
import { IssuePeek } from '../issues/IssuePeek';
import { useSettings } from '../settings/useSettings';
import { WorkModeView } from '../projects/WorkModeView';

export type SidebarMode = 'classic' | 'work';

export type FeatureId =
  | 'overview'
  | 'epics'
  | 'sessions'
  | 'issues'
  | 'connections'
  | 'agents'
  | 'workflows'
  | 'git';

interface FeatureDef {
  id: FeatureId;
  label: string;
  icon: IconName;
}

/**
 * The bottom block, in the same idiom as the reference "Customizations" list:
 * glyph, label, right-aligned count. These are the Praxis surfaces that
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
  activeGitView?: 'graph' | 'changes' | 'conflicts';
  onSelectFeature: (feature: FeatureId) => void;
  featureCounts: Partial<Record<FeatureId, number>>;
  onNewSession: () => void;
  onNewProject: () => void;
  onAddExistingProject: () => void;
  /** Opens the bulk "import plans folders as projects" wizard. */
  onImportProjects?: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  onOpenProjectDocument: (project: ProjectRecord, document: ProjectDocument) => void;
  onSelectGit: (project: ProjectRecord, view: 'graph' | 'changes' | 'conflicts') => void;
  /** The discovered agent/skill catalog, rendered as children of the Agents row. */
  agentCatalog?: AgentRuntimeSnapshot;
  activeAgentId?: string;
  activeSkillName?: string;
  onSelectAgent: (agentId: string) => void;
  onSelectSkill: (skillName: string) => void;
  onNewAgentItem: (kind: 'agent' | 'skill' | 'import' | 'rescan') => void;
  /** Saved workflows per project id, for the Workflows tree section. */
  projectWorkflows: Record<string, Array<{ id: string; name: string }>>;
  activeWorkflowId?: string;
  activeWorkflowRuns?: boolean;
  onSelectWorkflow: (project: ProjectRecord, workflowId: string) => void;
  onSelectWorkflowRuns: (project: ProjectRecord) => void;
  onNewWorkflow: (project: ProjectRecord) => void;
  onDeleteBoard: (board: Board) => void;
  onConfigureBoard: (board: Board) => void;
  selectedProjectId?: string;
  /** Selected issue for the peek card pinned above the footer (classic mode). */
  selectedIssueKey?: string;
  selectedIssueConnectionId?: string;
  /** Saved workspaces and the active-workspace switcher. */
  workspaces: WorkspaceRecord[];
  activeWorkspaceId?: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onSaveWorkspace: () => void;
  onOpenWorkspace: () => void;
  onCloseWorkspace: () => void;
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
  activeGitView,
  onSelectFeature,
  featureCounts,
  onNewSession,
  onNewProject,
  onAddExistingProject,
  onImportProjects,
  onSelectProject,
  onOpenProjectDocument,
  onSelectGit,
  agentCatalog,
  activeAgentId,
  activeSkillName,
  onSelectAgent,
  onSelectSkill,
  onNewAgentItem,
  projectWorkflows,
  activeWorkflowId,
  activeWorkflowRuns,
  onSelectWorkflow,
  onSelectWorkflowRuns,
  onNewWorkflow,
  onDeleteBoard,
  onConfigureBoard,
  selectedProjectId,
  selectedIssueKey,
  selectedIssueConnectionId,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onDeleteWorkspace,
  onCreateWorkspace,
  onSaveWorkspace,
  onOpenWorkspace,
  onCloseWorkspace
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const { settings } = useSettings();
  const newProjectEnabled = settings?.preview.enableNewProject ?? true;
  // Brand artwork vs generic board-type glyphs — Appearance setting, applied
  // live through the settings push channel.
  const showBrandArtwork = settings?.appearance.showBrandArtwork ?? true;
  // A board's mark comes from its real connection; built-in boards have no
  // connection and fall back to the demo mark.
  const boardMode = (board: Board) => resolveBackendMode(board.connectionId, connections);
  // The "Praxis" footer carries its own toggle, separate from the
  // connection-group collapse map above, because it isn't tied to a folder key.
  const [featuresCollapsed, setFeaturesCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [documentsByProjectId, setDocumentsByProjectId] = useState<Record<string, { exists: boolean; documents: ProjectDocument[] }>>({});

  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId);
  const projectNameForScope = projects.find(project => project.id === selectedProjectId)?.name;
  // The switcher scopes the Projects tree to the active workspace; with no
  // workspace selected every project shows.
  const visibleProjects = activeWorkspace
    ? projects.filter(project => activeWorkspace.projectIds.includes(project.id))
    : projects;

  useEffect(() => {
    let cancelled = false;
    void Promise.all(visibleProjects.map(async project => [project.id, await window.praxis.projects.listDocuments(project.id)] as const))
      .then(entries => { if (!cancelled) setDocumentsByProjectId(Object.fromEntries(entries)); })
      .catch(error => console.error('Failed to load project documents:', error));
    return () => { cancelled = true; };
  }, [projects, activeWorkspaceId]);

  // Live count of runs still in flight per project, so the Workflows row can
  // show a badge without opening the monitor. Refreshed whenever the
  // orchestrator advances any run.
  const [activeRunsByProjectId, setActiveRunsByProjectId] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all(
        visibleProjects.map(async project => {
          const runs = await window.praxis.workflows.listRuns(project.id).catch(() => []);
          const active = runs.filter(run => run.status === 'running' || run.status === 'awaiting-approval').length;
          return [project.id, active] as const;
        })
      )
        .then(entries => { if (!cancelled) setActiveRunsByProjectId(Object.fromEntries(entries)); })
        .catch(error => console.error('Failed to load workflow runs:', error));
    };
    load();
    const unsubscribe = window.praxis.workflows.onRunChanged(() => load());
    return () => { cancelled = true; unsubscribe(); };
  }, [projects, activeWorkspaceId]);

  const projectEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleProjects.map(project => {
      const projectConnection = connections.find(connection => connection.settings.projectId === project.id);
      const defaultBoard = boards.find(board => board.connectionId === projectConnection?.id);
      const linkedBoards = project.linkedBoards.flatMap(link => {
        const board = boards.find(candidate => candidate.id === link.boardId && candidate.connectionId === link.connectionId);
        return board ? [{ link, board }] : [];
      });
      // A folder connection can expose more than the one board that was
      // initially linked (one board per discovered plans root). They belong to
      // the same project and must not fall through into the global Boards node.
      const linkedConnectionIds = new Set(project.linkedBoards.map(link => link.connectionId));
      const discoveredLinkedBoards = boards
        .filter(board => board.connectionId && linkedConnectionIds.has(board.connectionId))
        .filter(board => !linkedBoards.some(({ link }) => link.connectionId === board.connectionId && link.boardId === board.id))
        .map(board => ({
          link: { connectionId: board.connectionId!, boardId: board.id, displayName: board.name },
          board
        }));
      const allLinkedBoards = [...linkedBoards, ...discoveredLinkedBoards];
      const matchesProject = !needle || `${project.name} ${project.key} ${project.type}`.toLowerCase().includes(needle);
      const matchesDefault = defaultBoard?.name.toLowerCase().includes(needle);
      const matchingLinkedBoards = needle && !matchesProject
        ? allLinkedBoards.filter(({ link, board }) => `${link.displayName} ${board.name}`.toLowerCase().includes(needle))
        : allLinkedBoards;
      return {
        project,
        defaultBoard: !needle || matchesProject || matchesDefault ? defaultBoard : undefined,
        linkedBoards: matchingLinkedBoards,
        visible: matchesProject || Boolean(matchesDefault) || matchingLinkedBoards.length > 0
      };
    }).filter(entry => entry.visible);
  }, [boards, connections, visibleProjects, query]);
  const projectBoardKeys = useMemo(() => new Set(projectEntries.flatMap(({ defaultBoard, linkedBoards }) => [
    ...(defaultBoard ? [`${defaultBoard.connectionId}:${defaultBoard.id}`] : []),
    ...linkedBoards.map(({ board }) => `${board.connectionId}:${board.id}`)
  ])), [projectEntries]);
  const projectConnectionIds = useMemo(
    () => new Set(projects.flatMap(project => project.linkedBoards.map(link => link.connectionId))),
    [projects]
  );
  const externalBoards = boards.filter(board =>
    !projectBoardKeys.has(`${board.connectionId ?? ''}:${board.id}`) &&
    !projectConnectionIds.has(board.connectionId ?? '')
  );

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-header">
        <div className="workspace-switcher">
          <button
            className="workspace-switcher-button"
            aria-expanded={workspaceMenuOpen}
            aria-label="Select workspace"
            onClick={() => setWorkspaceMenuOpen(open => !open)}
          >
            <span className="workspace-switcher-mark"><Icon name="organization" size={14} /></span>
            <span className="workspace-switcher-name">{activeWorkspace?.name ?? 'All projects'}</span>
            <Icon name="chevron-down" size={13} />
          </button>
          {workspaceMenuOpen && (
            <div className="workspace-menu" role="menu">
              {workspaces.map(workspace => (
                <div key={workspace.id} role="none" className="workspace-menu-row">
                  <button
                    role="menuitem"
                    className={`workspace-menu-select${workspace.id === activeWorkspaceId ? ' active' : ''}`}
                    onClick={() => { onSelectWorkspace(workspace.id); setWorkspaceMenuOpen(false); }}
                  >
                    <Icon name="organization" size={13} /><span>{workspace.name}</span>
                  </button>
                  <small className="workspace-menu-count">{workspace.projectIds.length}</small>
                  <button
                    type="button"
                    className="workspace-menu-delete"
                    aria-label={`Delete workspace ${workspace.name}`}
                    title="Delete workspace"
                    onClick={() => onDeleteWorkspace(workspace.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
              <div className="workspace-menu-divider" />
              <button role="menuitem" onClick={() => { onCreateWorkspace(); setWorkspaceMenuOpen(false); }}>
                <Icon name="plus" size={13} /><span>Create blank workspace</span>
              </button>
              <button role="menuitem" onClick={() => { onCloseWorkspace(); setWorkspaceMenuOpen(false); }}>
                <Icon name="organization" size={13} /><span>Create New Workspace</span>
              </button>
              {activeWorkspace && (
                <button role="menuitem" onClick={() => { onSaveWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="archive" size={13} /><span>Save to file</span>
                </button>
              )}
              <button role="menuitem" onClick={() => { onOpenWorkspace(); setWorkspaceMenuOpen(false); }}>
                <Icon name="folder-open" size={13} /><span>Open workspace file</span>
              </button>
              {activeWorkspace && (
                <button role="menuitem" className="workspace-menu-close" onClick={() => { onCloseWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="close" size={13} /><span>Close workspace</span>
                </button>
              )}
            </div>
          )}
        </div>
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
            {newProjectEnabled && <button role="menuitem" data-testid="add-existing-project" onClick={() => { setNewMenuOpen(false); onAddExistingProject(); }}><Icon name="folder-open" size={14} /><span><strong>Create from existing folder</strong><small>Scan plans and connect them to a project</small></span></button>}
            {newProjectEnabled && onImportProjects && <button role="menuitem" data-testid="import-projects" onClick={() => { setNewMenuOpen(false); onImportProjects(); }}><Icon name="markdown" size={14} /><span><strong>Import plans folders</strong><small>Turn several folders of markdown plans into projects</small></span></button>}
            <button role="menuitem" data-testid="new-session" onClick={() => { setNewMenuOpen(false); onNewSession(); }}><Icon name="robot" size={14} /><span><strong>New Session</strong><small>Start an AI session in this workspace</small></span></button>
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
                  <span className={`tree-section-icon${projectsCollapsed ? '' : ' open'}`}><Icon name={projectsCollapsed ? 'folder' : 'folder-open'} size={14} /></span>
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
                    const projectWorkflowsCollapsed = collapsed[`project:${project.id}:workflows`] ?? false;
                    const projectWorkflowList = projectWorkflows[project.id] ?? [];
                    const projectRunCount = activeRunsByProjectId[project.id] ?? 0;
                    const projectDocsCollapsed = collapsed[`project:${project.id}:docs`] ?? false;
                    const projectPlansCollapsed = collapsed[`project:${project.id}:plans`] ?? false;
                    const projectDocuments = documentsByProjectId[project.id];
                    return <div className="project-tree" key={project.id} data-testid="project-tree">
                      <div className={`project-tree-parent${selectedProjectId === project.id ? ' active' : ''}`}>
                        <button
                          className="project-tree-toggle"
                          aria-label={`${projectCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                          aria-expanded={!projectCollapsed}
                          onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}`]: !projectCollapsed }))}
                        ><span className="tree-section-icon"><Icon name={projectCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /></span></button>
                        <button className="project-tree-content" data-testid="project-nav-item" onClick={() => onSelectProject(project)}>
                          <span className="tree-icon project-icon"><Icon name="folder-open" size={15} /></span>
                          <span className="tree-stack"><span className="tree-label">{project.name}</span><span className="tree-sub">{project.key} · {project.type}</span></span>
                          <span className="tree-meta">{childCount}</span>
                        </button>
                      </div>
                      {!projectCollapsed && <div className="project-tree-children">
                        <button className="sidebar-subsection-toggle" aria-expanded={!projectBoardsCollapsed} onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:boards`]: !projectBoardsCollapsed }))}>
                          <span className={`tree-section-icon${projectBoardsCollapsed ? '' : ' open'}`}><Icon name="columns" size={13} /></span><span>Boards</span><span className="tree-meta">{childCount}</span>
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
                        {linkedBoards.map(({ link, board }) => {
                          const removeLabel = board.type === 'plan' ? 'Delete' : 'Remove';
                          return <div
                            key={`${link.connectionId}:${link.boardId}`}
                            className={`tree-row project-board-row board-tree-row${board.id === selectedBoardId ? ' active' : ''}`}
                            data-testid="project-linked-board-nav-item"
                          >
                            <button className="board-tree-main" onClick={() => onSelectBoard(board)}>
                              <span className="tree-icon linked-board-icon"><Icon name="link" size={14} /></span>
                              <span className="tree-label">{link.displayName}</span>
                              <span className="tree-badge">Linked</span>
                            </button>
                            <button
                              className="board-tree-configure"
                              data-testid="board-configure-btn"
                              aria-label={`Configure board ${board.name}`}
                              title="Configure board"
                              onClick={() => onConfigureBoard(board)}
                            ><Icon name="gear" size={12} /></button>
                            {board.connectionId && <button
                              className="board-tree-delete"
                              data-testid="board-delete-btn"
                              aria-label={`${removeLabel} board ${board.name}`}
                              title={board.type === 'plan' ? 'Delete this board' : 'Remove this board from Praxis'}
                              onClick={() => onDeleteBoard(board)}
                            ><Icon name="trash" size={12} /></button>}
                          </div>;
                        })}
                        </>}
                        <button className="sidebar-subsection-toggle" aria-expanded={!projectGitCollapsed} onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:git`]: !projectGitCollapsed }))}>
                          <span className={`tree-section-icon${projectGitCollapsed ? '' : ' open'}`}><Icon name="git-branch" size={13} /></span><span>Repository</span><span className="tree-meta">{project.workspaceFolder ? '1' : 'Setup'}</span>
                        </button>
                        {!projectGitCollapsed && <button
                          className={`tree-row project-git-row${activeFeature === 'git' && activeGitView !== 'changes' && selectedProjectId === project.id ? ' active' : ''}`}
                          data-testid="project-git-nav-item"
                          // Reachable without a workspace on purpose: Git Graph
                          // then shows the setup screen, which explains what is
                          // missing and offers Choose folder / Clone. A disabled
                          // control would leave the user with no way forward.
                          title={!project.workspaceFolder ? 'Set up a Git workspace for this project' : undefined}
                          onClick={() => onSelectGit(project, 'graph')}
                        ><span className="tree-icon"><Icon name="git-branch" size={14} /></span><span className="tree-label">Graph</span><span className="tree-badge">{project.workspaceFolder ? 'Git' : 'Setup'}</span></button>}
                        {!projectGitCollapsed && project.workspaceFolder && <button className={`tree-row project-git-child${activeFeature === 'git' && activeGitView === 'changes' && selectedProjectId === project.id ? ' active' : ''}`} data-testid="project-git-changes-nav-item" onClick={() => onSelectGit(project, 'changes')}><span className="tree-icon"><Icon name="file" size={14} /></span><span className="tree-label">Changes</span></button>}
                        <div className="tree-subsection-heading">
                          <button
                            className="sidebar-subsection-toggle"
                            aria-expanded={!projectWorkflowsCollapsed}
                            data-testid="project-workflows-nav-item"
                            onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:workflows`]: !projectWorkflowsCollapsed }))}
                          >
                            <span className={`tree-section-icon${projectWorkflowsCollapsed ? '' : ' open'}`}><Icon name="split-horizontal" size={13} /></span><span>Workflows</span><span className="tree-meta">{projectWorkflowList.length}</span>
                          </button>
                          <button className="sidebar-section-add" aria-label={`New workflow in ${project.name}`} data-testid="project-workflow-new" onClick={() => onNewWorkflow(project)}><Icon name="plus" size={13} /></button>
                        </div>
                        {!projectWorkflowsCollapsed && <>
                          {projectWorkflowList.map(workflow => (
                            <button
                              key={workflow.id}
                              className={`tree-row project-workflow-row${activeFeature === 'workflows' && !activeWorkflowRuns && activeWorkflowId === workflow.id && selectedProjectId === project.id ? ' active' : ''}`}
                              data-testid="project-workflow-nav-item"
                              onClick={() => onSelectWorkflow(project, workflow.id)}
                            ><span className="tree-icon"><Icon name="split-horizontal" size={14} /></span><span className="tree-label">{workflow.name}</span></button>
                          ))}
                          {projectWorkflowList.length === 0 && (
                            <button className="tree-row project-workflow-empty" data-testid="project-workflow-empty" onClick={() => onNewWorkflow(project)}>
                              <span className="tree-icon"><Icon name="plus" size={13} /></span><span className="tree-label">New workflow…</span>
                            </button>
                          )}
                          <button
                            className={`tree-row project-workflow-child${activeFeature === 'workflows' && activeWorkflowRuns && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-workflow-runs-nav-item"
                            onClick={() => onSelectWorkflowRuns(project)}
                          ><span className="tree-icon"><Icon name="play" size={14} /></span><span className="tree-label">Runs</span>{projectRunCount > 0 && <span className="tree-badge" title={`${projectRunCount} run${projectRunCount === 1 ? '' : 's'} in flight`}>{projectRunCount}</span>}</button>
                        </>}
                        {projectDocuments?.exists && <>
                          <button className="sidebar-subsection-toggle" aria-expanded={!projectDocsCollapsed} data-testid="project-docs-nav-item" onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:docs`]: !projectDocsCollapsed }))}>
                            <span className={`tree-section-icon${projectDocsCollapsed ? '' : ' open'}`}><Icon name="folder-open" size={13} /></span><span>docs</span>
                          </button>
                          {!projectDocsCollapsed && <div className="project-docs-tree">
                            <button className="sidebar-subsection-toggle project-plans-folder" aria-expanded={!projectPlansCollapsed} data-testid="project-plans-nav-item" onClick={() => setCollapsed(current => ({ ...current, [`project:${project.id}:plans`]: !projectPlansCollapsed }))}>
                              <span className={`tree-section-icon${projectPlansCollapsed ? '' : ' open'}`}><Icon name={projectPlansCollapsed ? 'folder' : 'folder-open'} size={12} /></span><span>plans</span><span className="tree-meta">{projectDocuments.documents.length}</span>
                            </button>
                            {!projectPlansCollapsed && groupDocumentsByType(projectDocuments.documents).map(group => {
                              const groupKey = `project:${project.id}:doc-type:${group.type}`;
                              const groupCollapsed = collapsed[groupKey] ?? false;
                              return <div className="project-document-group" key={group.type}>
                                <button className="project-document-group-toggle" aria-expanded={!groupCollapsed} data-testid="project-document-type-nav-item" onClick={() => setCollapsed(current => ({ ...current, [groupKey]: !groupCollapsed }))}>
                                  <span className="tree-section-icon"><Icon name={groupCollapsed ? 'chevron-right' : 'chevron-down'} size={10} /></span><span>{group.type}</span><span className="tree-meta">{group.documents.length}</span>
                                </button>
                                {!groupCollapsed && group.documents.map(document => <button className="tree-row project-document-row" key={document.relativePath} data-testid="project-document-nav-item" title={document.relativePath} onClick={() => onOpenProjectDocument(project, document)}><span className="tree-icon"><Icon name="markdown" size={13} /></span><span className="tree-label">{document.name}</span>{document.status && <span className="status-dot" data-testid="project-document-status" style={{ background: statusTone(undefined, document.status) }} aria-label={`Status: ${documentStatusLabel(document.status)}`} title={documentStatusLabel(document.status)} />}</button>)}
                              </div>;
                            })}
                          </div>}
                        </>}
                      </div>}
                    </div>;
                  }))}
            </>}
            <div className="sidebar-section-heading">
              <button className="sidebar-section-label sidebar-section-button sidebar-section-toggle" aria-expanded={!boardsCollapsed} data-testid="toggle-boards" onClick={() => setBoardsCollapsed(value => !value)}>
                <span className={`tree-section-icon${boardsCollapsed ? '' : ' open'}`}><Icon name="columns" size={14} /></span><span>Boards</span><span className="tree-meta">{externalBoards.length}</span>
              </button>
            </div>
            {!boardsCollapsed && <div className="external-board-tree">{externalBoards.length === 0 ? <span className="sidebar-empty-hint">No external boards</span> : externalBoards.map(board => {
              const missing = board.availability === 'missing';
              const canDelete = Boolean(board.connectionId);
              const removeLabel = board.type === 'plan' ? 'Delete' : 'Remove';
              return <div key={`${board.connectionId}:${board.id}`} className={`tree-row board-tree-row${board.id === selectedBoardId ? ' active' : ''}${missing ? ' missing' : ''}`} data-testid="board-nav-item" title={missing ? board.availabilityMessage ?? 'This board folder is missing.' : boardTypeLabel(board)}>
                <button className="board-tree-main" disabled={missing} onClick={() => onSelectBoard(board)}>
                  <span className="tree-icon">{showBrandArtwork ? <BrandModeIcon mode={boardMode(board)} size={14} /> : <Icon name={boardTypeIcon(board)} size={14} />}</span>
                  <span className="tree-label">{board.name}</span>
                  {missing && <span className="board-availability-warning" data-testid="board-missing-icon" title="Board folder is missing"><Icon name="warning" size={14} /></span>}
                  {board.connectionId && !missing && <ConnectionStatusDot check={connectionChecks[board.connectionId]} />}
                </button>
                <button className="board-tree-configure" data-testid="board-configure-btn" aria-label={`Configure board ${board.name}`} title="Configure board" onClick={() => onConfigureBoard(board)}><Icon name="gear" size={12} /></button>
                {canDelete && <button className="board-tree-delete" data-testid="board-delete-btn" aria-label={`${removeLabel} board ${board.name}`} title={board.type === 'plan' ? 'Delete this board' : 'Remove this board from Praxis'} onClick={() => onDeleteBoard(board)}><Icon name="trash" size={12} /></button>}
              </div>;
            })}</div>}
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
          <span className={`tree-section-icon${featuresCollapsed ? '' : ' open'}`}><Icon name="tools" size={14} /></span>
        </button>
        {!featuresCollapsed &&
          FEATURES.map(feature =>
            // Agents is the one destination that carries a catalog, so it
            // expands into it rather than opening a second navigator in the
            // centre pane (the Workflows idiom).
            feature.id === 'agents' ? (
              <AgentsNav
                key={feature.id}
                icon={feature.icon}
                label={feature.label}
                active={activeFeature === 'agents'}
                collapsed={collapsed['feature:agents'] ?? false}
                onToggleCollapsed={() =>
                  setCollapsed(current => ({ ...current, 'feature:agents': !(current['feature:agents'] ?? false) }))
                }
                catalog={agentCatalog}
                activeAgentId={activeAgentId}
                activeSkillName={activeSkillName}
                projectName={projectNameForScope}
                onSelectFeature={() => onSelectFeature('agents')}
                onSelectAgent={onSelectAgent}
                onSelectSkill={onSelectSkill}
                onNewAgentItem={onNewAgentItem}
              />
            ) : (
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
            )
          )}
      </div>
    </nav>
  );
}

/**
 * The Agents destination plus its catalog, grouped by scope. Rows carry the
 * same trust / running vocabulary as the runtime panel so the tree reads as a
 * status board, not just a list.
 */
function AgentsNav({
  icon,
  label,
  active,
  collapsed,
  onToggleCollapsed,
  catalog,
  activeAgentId,
  activeSkillName,
  projectName,
  onSelectFeature,
  onSelectAgent,
  onSelectSkill,
  onNewAgentItem
}: {
  icon: IconName;
  label: string;
  active: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  catalog?: AgentRuntimeSnapshot;
  activeAgentId?: string;
  activeSkillName?: string;
  projectName?: string;
  onSelectFeature: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectSkill: (skillName: string) => void;
  onNewAgentItem: (kind: 'agent' | 'skill' | 'import' | 'rescan') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scopes: Array<'global' | 'project'> = ['global', 'project'];
  const groups = scopes
    .map(scope => ({
      scope,
      label: scope === 'global' ? 'Global' : projectName ?? 'This project',
      agents: (catalog?.agents ?? []).filter(agent => agent.scope === scope),
      skills: (catalog?.skills ?? []).filter(skill => skill.scope === scope)
    }))
    .filter(group => group.agents.length > 0 || group.skills.length > 0);
  const total = (catalog?.agents.length ?? 0) + (catalog?.skills.length ?? 0);

  return (
    <>
      <div className="feature-row-heading">
        <button
          data-testid="nav-agents"
          className={`feature-row${active ? ' active' : ''}`}
          onClick={() => {
            onSelectFeature();
            if (collapsed) onToggleCollapsed();
          }}
        >
          <span className="tree-icon">
            <Icon name={icon} size={15} />
          </span>
          <span className="feature-label">{label}</span>
          {total > 0 && <span className="feature-count">{total}</span>}
        </button>
        <button
          className="feature-row-expand"
          aria-label={collapsed ? 'Expand agent catalog' : 'Collapse agent catalog'}
          aria-expanded={!collapsed}
          data-testid="nav-agents-toggle"
          onClick={onToggleCollapsed}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <div className="new-menu-anchor">
          <button
            className="sidebar-section-add"
            aria-label="New agent or skill"
            aria-expanded={menuOpen}
            data-testid="nav-agents-new"
            onClick={() => setMenuOpen(open => !open)}
          >
            <Icon name="plus" size={13} />
          </button>
          {menuOpen && (
            <div className="new-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
              <button role="menuitem" data-testid="new-agent" onClick={() => { setMenuOpen(false); onNewAgentItem('agent'); }}>
                <Icon name="robot" size={14} /><span><strong>New agent</strong><small>Manifest plus a starter implementation</small></span>
              </button>
              <button role="menuitem" data-testid="new-skill" onClick={() => { setMenuOpen(false); onNewAgentItem('skill'); }}>
                <Icon name="sparkles" size={14} /><span><strong>New skill</strong><small>A SKILL.md package</small></span>
              </button>
              <button role="menuitem" data-testid="import-agent-item" onClick={() => { setMenuOpen(false); onNewAgentItem('import'); }}>
                <Icon name="folder-open" size={14} /><span><strong>Import…</strong><small>Validate and copy an existing folder</small></span>
              </button>
              <button role="menuitem" data-testid="rescan-agents" onClick={() => { setMenuOpen(false); onNewAgentItem('rescan'); }}>
                <Icon name="refresh" size={14} /><span><strong>Rescan catalog</strong><small>Re-read the discovery paths</small></span>
              </button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && groups.length === 0 && catalog && (
        <span className="sidebar-empty-hint">No agents or skills yet</span>
      )}
      {!collapsed &&
        groups.map(group => (
          <div key={group.scope} className="agent-nav-group">
            <div className="agent-nav-scope">{group.label}</div>
            {group.agents.map(agent => {
              const state = catalog?.hosts[agent.manifest.id]?.state;
              return (
                <button
                  key={`a:${agent.manifest.id}`}
                  className={`tree-row agent-nav-row${active && activeAgentId === agent.manifest.id ? ' active' : ''}`}
                  data-testid="agent-nav-item"
                  onClick={() => onSelectAgent(agent.manifest.id)}
                >
                  <span className="tree-icon"><Icon name="robot" size={14} /></span>
                  <span className="tree-label">{agent.manifest.name}</span>
                  {state === 'running' ? (
                    <span className="lane lane--running" title="Host running">●</span>
                  ) : state === 'failed' ? (
                    <span className="lane lane--failed" title="Failed to start">●</span>
                  ) : agent.errors.length > 0 ? (
                    <span className="tree-badge" title="Invalid manifest">⚠</span>
                  ) : !agent.trusted ? (
                    <span className="tree-badge">approval</span>
                  ) : null}
                </button>
              );
            })}
            {group.skills.map(skill => (
              <button
                key={`s:${skill.metadata.name}`}
                className={`tree-row agent-nav-row${active && activeSkillName === skill.metadata.name ? ' active' : ''}`}
                data-testid="skill-nav-item"
                onClick={() => onSelectSkill(skill.metadata.name)}
              >
                <span className="tree-icon"><Icon name="sparkles" size={14} /></span>
                <span className="tree-label">{skill.metadata.name}</span>
                {skill.error ? (
                  <span className="tree-badge" title="Invalid skill">⚠</span>
                ) : !skill.trusted ? (
                  <span className="tree-badge">approval</span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
    </>
  );
}

function groupDocumentsByType(documents: ProjectDocument[]): Array<{ type: string; documents: ProjectDocument[] }> {
  const groups = new Map<string, ProjectDocument[]>();
  for (const document of documents) {
    const type = formatDocumentType(document.type);
    const group = groups.get(type) ?? [];
    group.push(document);
    groups.set(type, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, grouped]) => ({ type, documents: grouped }));
}

function formatDocumentType(type?: string): string {
  const value = type?.trim();
  if (!value) return 'Other';
  if (value.toLowerCase() === 'other') return 'Other';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() + (value.toLowerCase().endsWith('s') ? '' : 's');
}

function documentStatusLabel(status: string): string {
  return status.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, character => character.toUpperCase());
}
