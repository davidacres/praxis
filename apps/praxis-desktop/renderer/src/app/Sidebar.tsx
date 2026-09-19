import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRuntimeSnapshot,
  AgentSessionRecord,
  Board,
  BoardDetails,
  Connection,
  ConnectionCheck,
  ProjectDocument,
  ProjectRecord,
  WorkspaceRecord
} from '@praxis/core';
import { agentStateLabel, agentStateLaneClass } from '../ai/aiSessionState';
import { isHostShimProfile } from '../agents/agentCatalog';
import { isSynthesizedKey, sessionTitle } from '../ai/sessionNav';
import { boardTypeIcon, boardTypeLabel, resolveBackendMode, statusTone } from '../board/boardMeta';
import { BrandModeIcon } from '../ui/BrandModeIcon';
import { ConnectionStatusDot } from '../ui/ConnectionStatusDot';
import { Icon, type IconName } from '../ui/Icon';
import { IssuePeek } from '../issues/IssuePeek';
import { projectColorValue } from '../projects/projectColors';
import { useSettings } from '../settings/useSettings';
import { useResizable } from './useResizable';
import { WorkModeView } from '../projects/WorkModeView';

export type SidebarMode = 'classic' | 'work';

export type FeatureId =
  | 'overview'
  | 'sessions'
  | 'connections'
  | 'agents'
  | 'workflows'
  | 'git'
  | 'run'
  | 'deployments';

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
  { id: 'sessions', label: 'Sessions', icon: 'robot' },
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
  onModeChange?: (mode: SidebarMode) => void;
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
  /** Agent sessions, rendered as children of the Sessions row. */
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  onSelectSession: (issueKey: string) => void;
  onRenameSession: (issueKey: string, title: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
  /** The discovered agent/skill catalog, rendered as children of the Agents row. */
  agentCatalog?: AgentRuntimeSnapshot;
  activeAgentId?: string;
  activeAgentProfileId?: string;
  activeSkillName?: string;
  onSelectAgent: (agentId: string) => void;
  onSelectAgentProfile: (profileId: string) => void;
  onSelectSkill: (skillName: string) => void;
  onNewAgentItem: (kind: 'agent' | 'profile' | 'skill' | 'import' | 'rescan') => void;
  /** Saved workflows per project id, for the Workflows tree section. */
  projectWorkflows: Record<string, Array<{ id: string; name: string }>>;
  activeWorkflowId?: string;
  activeWorkflowRuns?: boolean;
  activeWorkflowPolicies?: boolean;
  onSelectWorkflow: (project: ProjectRecord, workflowId: string) => void;
  onSelectWorkflowRuns: (project: ProjectRecord) => void;
  onSelectWorkflowPolicies: (project: ProjectRecord) => void;
  /** Opens the project's Run profile editor (FX-BE-054). */
  onSelectRun: (project: ProjectRecord) => void;
  /** Opens the project's deployment profiles (FX-BE-059 / FX-BE-060). */
  onSelectDeployments: (project: ProjectRecord) => void;
  onNewWorkflow: (project: ProjectRecord) => void;
  onDeleteBoard: (board: Board) => void;
  /**
   * Removes a board from a project's own `linkedBoards` — distinct from
   * `onDeleteBoard`, which deletes/untracks a board's underlying connection
   * (and refuses when that connection belongs to *some* project, since
   * deleting it would delete that project's own board). A linked board
   * routinely belongs to another project's connection by design, so it must
   * go through `unlinkBoard` instead or that guard silently no-ops it.
   */
  onUnlinkBoard: (project: ProjectRecord, connectionId: string, boardId: string) => void;
  onConfigureBoard: (board: Board) => void;
  selectedProjectId?: string;
  /** Selected issue for the peek card pinned above the footer (classic mode). */
  selectedIssueKey?: string;
  selectedIssueConnectionId?: string;
  /** Saved workspaces and the active-workspace switcher. */
  workspaces?: WorkspaceRecord[];
  activeWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onSaveWorkspace?: () => void;
  onOpenWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  searching?: boolean;
  query?: string;
  onQueryChange?: (query: string) => void;
  onToggleSearch?: () => void;
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
  sessions,
  activeSessionKey,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
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
  activeAgentProfileId,
  activeSkillName,
  onSelectAgent,
  onSelectAgentProfile,
  onSelectSkill,
  onNewAgentItem,
  projectWorkflows,
  activeWorkflowId,
  activeWorkflowRuns,
  activeWorkflowPolicies,
  onSelectWorkflow,
  onSelectWorkflowRuns,
  onSelectWorkflowPolicies,
  onSelectRun,
  onSelectDeployments,
  onNewWorkflow,
  onDeleteBoard,
  onUnlinkBoard,
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
  onCloseWorkspace,
  searching,
  query,
  onQueryChange,
  onToggleSearch
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [localQuery, setLocalQuery] = useState('');
  const [localSearching, setLocalSearching] = useState(false);
  const effectiveSearching = searching ?? localSearching;
  const effectiveQuery = query !== undefined ? query : localQuery;
  const setEffectiveQuery = onQueryChange ?? setLocalQuery;
  const toggleEffectiveSearch = onToggleSearch ?? (() => { setLocalSearching(s => !s); setLocalQuery(''); });
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
  const [featuresMaximized, setFeaturesMaximized] = useState(false);
  // Lets the "Praxis" footer grow taller than its natural content height
  // (e.g. a long Sessions list) at the cost of the boards/projects area above it.
  const praxisPanel = useResizable({
    storageKey: 'tm-pane-sidebar-praxis',
    initial: 240,
    min: 120,
    max: 640,
    side: 'bottom'
  });
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [documentsByProjectId, setDocumentsByProjectId] = useState<Record<string, { exists: boolean; documents: ProjectDocument[] }>>({});

  const activeWorkspace = workspaces?.find(workspace => workspace.id === activeWorkspaceId);
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
    const needle = effectiveQuery.trim().toLowerCase();
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
  }, [boards, connections, visibleProjects, effectiveQuery]);
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
      {effectiveSearching && (
        <div style={{ padding: '4px 12px 8px' }}>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            placeholder="Filter boards…"
            value={effectiveQuery}
            onChange={event => setEffectiveQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                toggleEffectiveSearch();
              }
            }}
          />
        </div>
      )}

      <div className="sidebar-scroll" style={featuresMaximized ? { display: 'none' } : undefined}>
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
                          <span className="tree-icon project-icon" style={{ color: projectColorValue(project.color) }}><Icon name={project.icon ?? 'folder-open'} size={15} /></span>
                          <span className="tree-stack"><span className="tree-label">{project.name}</span><span className="tree-sub">{project.type}</span></span>
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
                            <button
                              className="board-tree-delete"
                              data-testid="board-unlink-btn"
                              aria-label={`Unlink board ${board.name} from ${project.name}`}
                              title="Unlink this board from the project"
                              onClick={() => onUnlinkBoard(project, link.connectionId, link.boardId)}
                            ><Icon name="trash" size={12} /></button>
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
                        <button
                          className={`tree-row project-run-row${activeFeature === 'run' && selectedProjectId === project.id ? ' active' : ''}`}
                          data-testid="project-run-nav-item"
                          onClick={() => onSelectRun(project)}
                        ><span className="tree-icon"><Icon name="server" size={14} /></span><span className="tree-label">Run</span></button>
                        <button
                          className={`tree-row project-deployments-row${activeFeature === 'deployments' && selectedProjectId === project.id ? ' active' : ''}`}
                          data-testid="project-deployments-nav-item"
                          onClick={() => onSelectDeployments(project)}
                        ><span className="tree-icon"><Icon name="rocket" size={14} /></span><span className="tree-label">Deployments</span></button>
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
                          <button
                            className={`tree-row project-workflow-child${activeFeature === 'workflows' && activeWorkflowPolicies && selectedProjectId === project.id ? ' active' : ''}`}
                            data-testid="project-workflow-policies-nav-item"
                            onClick={() => onSelectWorkflowPolicies(project)}
                          ><span className="tree-icon"><Icon name="shield" size={14} /></span><span className="tree-label">Policies</span></button>
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
                                {!groupCollapsed && group.documents.map(document => <button className="tree-row project-document-row" key={document.relativePath} data-testid="project-document-nav-item" title={document.relativePath} onClick={() => onOpenProjectDocument(project, document)}><span className="tree-icon"><Icon name="markdown" size={14} /></span><span className="tree-label">{document.name}</span>{document.status && <span className="status-dot" data-testid="project-document-status" style={{ background: statusTone(undefined, document.status) }} aria-label={`Status: ${documentStatusLabel(document.status)}`} title={documentStatusLabel(document.status)} />}</button>)}
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

      {mode === 'classic' && selectedIssueKey && !featuresMaximized && (
        <IssuePeek issueKey={selectedIssueKey} connectionId={selectedIssueConnectionId} />
      )}

      {!featuresCollapsed && !featuresMaximized && (
        <div
          className={`splitter-h${praxisPanel.dragging ? ' dragging' : ''}`}
          aria-label="Resize Praxis section"
          {...praxisPanel.handleProps}
        />
      )}
      <div
        className={`sidebar-footer${featuresMaximized ? ' sidebar-footer-maximized' : ''}`}
        style={featuresCollapsed ? undefined : featuresMaximized ? { flex: '1 1 auto', height: '100%' } : { height: praxisPanel.size }}
      >
        <div className="feature-section-header feature-section-toggle">
          <button
            type="button"
            className="feature-section-title"
            aria-expanded={!featuresCollapsed}
            onClick={() => {
              if (featuresMaximized) {
                setFeaturesMaximized(false);
                setFeaturesCollapsed(true);
              } else {
                setFeaturesCollapsed(collapsed => !collapsed);
              }
            }}
          >
            <span className="sidebar-section-label" style={{ margin: 0 }}>
              Praxis
            </span>
          </button>
          <div className="feature-section-actions">
            <button
              type="button"
              className="feature-section-action"
              aria-label={featuresMaximized ? 'Restore sidebar' : 'Use full sidebar'}
              title={featuresMaximized ? 'Restore sidebar' : 'Use full sidebar'}
              data-testid="toggle-features-maximize"
              onClick={() => {
                if (featuresMaximized) {
                  setFeaturesMaximized(false);
                } else {
                  setFeaturesCollapsed(false);
                  setFeaturesMaximized(true);
                }
              }}
            >
              <Icon name={featuresMaximized ? 'window-restore' : 'window-maximize'} size={13} />
            </button>
            <button
              type="button"
              className="feature-section-action"
              aria-label={featuresCollapsed ? 'Expand Praxis section' : 'Collapse Praxis section'}
              title={featuresCollapsed ? 'Expand Praxis section' : 'Collapse Praxis section'}
              data-testid="toggle-features"
              onClick={() => {
                if (featuresMaximized) {
                  setFeaturesMaximized(false);
                  setFeaturesCollapsed(true);
                } else {
                  setFeaturesCollapsed(collapsed => !collapsed);
                }
              }}
            >
              <span className={`tree-section-icon${featuresCollapsed ? '' : ' open'}`}>
                <Icon name={featuresCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
              </span>
            </button>
          </div>
        </div>
        {!featuresCollapsed &&
          FEATURES.map(feature =>
            // Agents is the one destination that carries a catalog, so it
            // expands into it rather than opening a second navigator in the
            // centre pane (the Workflows idiom).
            feature.id === 'sessions' ? (
              <SessionsNav
                key={feature.id}
                icon={feature.icon}
                label={feature.label}
                active={activeFeature === 'sessions'}
                collapsed={collapsed['feature:sessions'] ?? false}
                onToggleCollapsed={() =>
                  setCollapsed(current => ({ ...current, 'feature:sessions': !(current['feature:sessions'] ?? false) }))
                }
                sessions={sessions}
                activeSessionKey={activeSessionKey}
                runningCount={featureCounts.sessions ?? 0}
                onSelectFeature={() => onSelectFeature('sessions')}
                onSelectSession={onSelectSession}
                onNewSession={onNewSession}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
              />
            ) : feature.id === 'agents' ? (
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
                activeAgentProfileId={activeAgentProfileId}
                activeSkillName={activeSkillName}
                projectName={projectNameForScope}
                onSelectFeature={() => onSelectFeature('agents')}
                onSelectAgent={onSelectAgent}
                onSelectAgentProfile={onSelectAgentProfile}
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
 * The Sessions destination plus its sessions, newest first. Rows carry the same
 * mode and state vocabulary as the console header, so the tree reads as a status
 * board — and rename / delete live on the row, where the list used to keep them.
 */
function SessionsNav({
  icon,
  label,
  active,
  collapsed,
  onToggleCollapsed,
  sessions,
  activeSessionKey,
  runningCount,
  onSelectFeature,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession
}: {
  icon: IconName;
  label: string;
  active: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sessions: AgentSessionRecord[];
  activeSessionKey?: string;
  runningCount: number;
  onSelectFeature: () => void;
  onSelectSession: (issueKey: string) => void;
  onNewSession: () => void;
  onRenameSession: (issueKey: string, title: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
}) {
  const [editingKey, setEditingKey] = useState<string>();
  const [draft, setDraft] = useState('');
  const [mutatingKey, setMutatingKey] = useState<string>();
  const [error, setError] = useState<string>();

  const beginRename = (session: AgentSessionRecord) => {
    setEditingKey(session.issueKey);
    setDraft(sessionTitle(session));
  };

  const commitRename = async (session: AgentSessionRecord) => {
    const next = draft.trim();
    setEditingKey(undefined);
    if (!next || next === sessionTitle(session)) return;
    setMutatingKey(session.issueKey);
    setError(undefined);
    try {
      await onRenameSession(session.issueKey, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  const remove = async (session: AgentSessionRecord) => {
    setMutatingKey(session.issueKey);
    setError(undefined);
    try {
      await onDeleteSession(session.issueKey);
      setEditingKey(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingKey(undefined);
    }
  };

  return (
    <>
      <div className="feature-row-heading">
        <button
          data-testid="nav-sessions"
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
          {runningCount > 0 && <span className="feature-count">{runningCount}</span>}
        </button>
        <button
          className="feature-row-expand"
          aria-label={collapsed ? 'Expand session list' : 'Collapse session list'}
          aria-expanded={!collapsed}
          data-testid="nav-sessions-toggle"
          onClick={onToggleCollapsed}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <button
          className="sidebar-section-add"
          aria-label="New session"
          data-testid="sessions-new-btn"
          onClick={onNewSession}
        >
          <Icon name="plus" size={13} />
        </button>
      </div>
      {!collapsed && error && (
        <div className="error-banner session-list-error" data-testid="session-list-error">{error}</div>
      )}
      {!collapsed && sessions.length === 0 && (
        <span className="sidebar-empty-hint" data-testid="sessions-nav-empty">No AI sessions yet</span>
      )}
      {!collapsed &&
        sessions.map(session => {
          const editing = editingKey === session.issueKey;
          const mutating = mutatingKey === session.issueKey;
          const title = sessionTitle(session);
          return (
            <div
              key={session.issueKey}
              className={`tree-row session-nav-row${active && activeSessionKey === session.issueKey ? ' active' : ''}`}
              data-testid="session-list-row"
              role="button"
              tabIndex={0}
              onClick={() => !editing && onSelectSession(session.issueKey)}
              onKeyDown={event => {
                if (!editing && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSelectSession(session.issueKey);
                }
              }}
            >
              <span className="tree-icon">
                <Icon name="robot" size={14} />
              </span>
              {!editing && !isSynthesizedKey(session.issueKey) && (
                <span className="session-item-key">{session.issueKey}</span>
              )}
              {editing ? (
                <input
                  className="session-title-input"
                  data-testid="session-title-input"
                  aria-label={`Session title for ${title}`}
                  value={draft}
                  disabled={mutating}
                  autoFocus
                  onClick={event => event.stopPropagation()}
                  onChange={event => setDraft(event.target.value)}
                  onBlur={() => void commitRename(session)}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingKey(undefined);
                    }
                  }}
                />
              ) : (
                <span className="tree-label" title={title} data-testid="session-title">
                  {title}
                </span>
              )}
              {!editing && (
                <>
                  <span
                    className={agentStateLaneClass(session.state)}
                    title={agentStateLabel(session.state)}
                    data-testid="session-nav-state"
                  >
                    ●
                  </span>
                  <span className="session-nav-actions">
                    <button
                      className="icon-btn icon-btn-sm"
                      aria-label={`Rename session ${title}`}
                      title="Rename session"
                      data-testid="session-rename-btn"
                      disabled={mutating}
                      onClick={event => {
                        event.stopPropagation();
                        beginRename(session);
                      }}
                    >
                      <Icon name="pencil" size={12} />
                    </button>
                    <button
                      className="icon-btn icon-btn-sm"
                      aria-label={`Delete session ${title}`}
                      title="Delete session"
                      data-testid="session-delete-btn"
                      disabled={mutating}
                      onClick={event => {
                        event.stopPropagation();
                        void remove(session);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </>
              )}
            </div>
          );
        })}
    </>
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
  activeAgentProfileId,
  activeSkillName,
  projectName,
  onSelectFeature,
  onSelectAgent,
  onSelectAgentProfile,
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
  activeAgentProfileId?: string;
  activeSkillName?: string;
  projectName?: string;
  onSelectFeature: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectAgentProfile: (profileId: string) => void;
  onSelectSkill: (skillName: string) => void;
  onNewAgentItem: (kind: 'agent' | 'profile' | 'skill' | 'import' | 'rescan') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scopes: Array<'global' | 'project'> = ['global', 'project'];
  const groups = scopes
    .map(scope => ({
      scope,
      label: scope === 'global' ? 'Global' : projectName ?? 'This project',
      // Agents are their profile — the primary-nav identity is AGENT.md, not
      // the launch binding that runs it. A binding with no AGENT.md gets an
      // auto-synthesized placeholder profile so it still has *a* profile
      // record; that placeholder is advanced/diagnostic-only and lives in
      // Settings -> Agent Runtime instead of cluttering this tree with raw,
      // uncurated entries. (profile.legacy alone isn't enough here — it's
      // also true for a genuine old brief.md profile, which does belong.)
      profiles: (catalog?.profiles ?? []).filter(profile => profile.scope === scope && !isHostShimProfile(profile)),
      skills: (catalog?.skills ?? []).filter(skill => skill.scope === scope)
    }))
    .filter(group => group.profiles.length > 0 || group.skills.length > 0);
  const total = groups.reduce((count, group) => count + group.profiles.length + group.skills.length, 0);

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
              <button role="menuitem" data-testid="new-profile" onClick={() => { setMenuOpen(false); onNewAgentItem('profile'); }}>
                <Icon name="robot" size={14} /><span><strong>New agent profile</strong><small>A provider-neutral AGENT.md role</small></span>
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
            {group.profiles.map(profile => (
              <button
                key={`p:${profile.profile.id}`}
                className={`tree-row agent-nav-row${active && activeAgentProfileId === profile.profile.id ? ' active' : ''}`}
                data-testid="profile-nav-item"
                onClick={() => onSelectAgentProfile(profile.profile.id)}
              >
                <span className="tree-icon"><Icon name="robot" size={14} /></span>
                <span className="tree-label">{profile.profile.name}</span>
                {profile.error ? <span className="tree-badge" title="Invalid profile">⚠</span> : profile.legacy ? <span className="tree-badge">legacy</span> : null}
              </button>
            ))}
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
