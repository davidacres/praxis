import type { KeyValueStore } from '../host/stateStore';
import type {
  ProjectBoardReference,
  ProjectRecord,
  StoredTemplateRecommendation,
  UpdateProjectInput
} from './projectTypes';
import { normalizeWorkflowStages, validateWorkflowStages } from './projectWorkflow';

const PROJECTS_KEY = 'praxis.projects.v1';

export class ProjectStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): ProjectRecord[] {
    const value = this.state.get<ProjectRecord[]>(PROJECTS_KEY);
    return Array.isArray(value) ? value.filter(isProjectRecord).map(cloneProject) : [];
  }

  public get(projectId: string): ProjectRecord | undefined {
    const project = this.list().find(candidate => candidate.id === projectId);
    return project ? cloneProject(project) : undefined;
  }

  public async create(project: ProjectRecord): Promise<ProjectRecord> {
    const projects = this.list();
    if (projects.some(candidate => candidate.id === project.id)) {
      throw new Error(`Project ${project.id} already exists.`);
    }
    if (projects.some(candidate => candidate.key.toLowerCase() === project.key.toLowerCase())) {
      throw new Error(`Project key ${project.key} is already in use.`);
    }
    projects.push(cloneProject(project));
    await this.state.update(PROJECTS_KEY, projects);
    return cloneProject(project);
  }

  public async replace(project: ProjectRecord): Promise<ProjectRecord> {
    const projects = this.list();
    const index = projects.findIndex(candidate => candidate.id === project.id);
    if (index < 0) throw new Error(`Project ${project.id} was not found.`);
    projects[index] = cloneProject(project);
    await this.state.update(PROJECTS_KEY, projects);
    return cloneProject(project);
  }

  public async remove(projectId: string): Promise<void> {
    const projects = this.list();
    const next = projects.filter(project => project.id !== projectId);
    if (next.length === projects.length) throw new Error(`Project ${projectId} was not found.`);
    await this.state.update(PROJECTS_KEY, next);
  }

  public async update(projectId: string, patch: UpdateProjectInput): Promise<ProjectRecord> {
    const project = this.require(projectId);
    let nextKey = project.key;
    if (patch.key !== undefined) {
      const normalized = patch.key.trim().toUpperCase();
      if (normalized !== project.key) {
        // Not blocked on existing tickets: `IssueSummary.projectKey` (what
        // filtering/search actually match against) is resolved from the
        // *current* `project.key` at read time — see `projectService.ts`'s
        // `issue()` — so a rename doesn't break any tracker association.
        // The only effect is cosmetic: each ticket's own `.key` string
        // (`${project.key}-${sequence}` at the time it was created) keeps
        // its old prefix, so old and new tickets read with different
        // prefixes. `UpdateProjectInput.key`'s doc names this tradeoff.
        if (this.list().some(candidate => candidate.id !== projectId && candidate.key.toLowerCase() === normalized.toLowerCase())) {
          throw new Error(`Project key ${normalized} is already in use.`);
        }
        nextKey = normalized;
      }
    }
    const next: ProjectRecord = {
      ...project,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      key: nextKey,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.purpose !== undefined ? { purpose: patch.purpose.trim() } : {}),
      ...(patch.brief !== undefined ? { brief: { ...patch.brief } } : {}),
      ...(patch.workflowStages !== undefined ? { workflowStages: patch.workflowStages.map(stage => ({ ...stage })) } : {}),
      ...(patch.defaultAiToolMode !== undefined ? { defaultAiToolMode: patch.defaultAiToolMode } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      updatedAt: new Date().toISOString()
    };
    validateProjectRecord(next);
    return this.replace(next);
  }

  public async linkBoard(projectId: string, board: ProjectBoardReference): Promise<ProjectRecord> {
    for (const project of this.list()) {
      const owner = project.linkedBoards.find(
        item => item.connectionId === board.connectionId && item.boardId === board.boardId
      );
      if (owner && project.id !== projectId) {
        throw new Error(`Board ${board.displayName} is already linked to ${project.name}.`);
      }
    }
    const project = this.require(projectId);
    if (!project.linkedBoards.some(item => item.connectionId === board.connectionId && item.boardId === board.boardId)) {
      project.linkedBoards.push({ ...board });
      project.updatedAt = new Date().toISOString();
      await this.replace(project);
    }
    return project;
  }

  public async unlinkBoard(projectId: string, connectionId: string, boardId: string): Promise<ProjectRecord> {
    const project = this.require(projectId);
    project.linkedBoards = project.linkedBoards.filter(
      item => item.connectionId !== connectionId || item.boardId !== boardId
    );
    project.updatedAt = new Date().toISOString();
    return this.replace(project);
  }

  /**
   * Persists the AI's workflow-template recommendation on the project record
   * itself — a dedicated write, not routed through `update`'s user-editable
   * `UpdateProjectInput`, since this is a computed cache value, not something
   * a person fills in on a settings form. `updatedAt` is deliberately left
   * untouched: recomputing a recommendation isn't a project edit.
   */
  public async setRecommendedWorkflowTemplate(
    projectId: string,
    value: StoredTemplateRecommendation
  ): Promise<ProjectRecord> {
    const project = this.require(projectId);
    project.recommendedWorkflowTemplate = { ...value };
    return this.replace(project);
  }

  private require(projectId: string): ProjectRecord {
    const project = this.get(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    return project;
  }
}

export function validateProjectRecord(project: ProjectRecord): void {
  if (!project.name.trim()) throw new Error('Project name is required.');
  if (!/^[A-Z][A-Z0-9_]{0,14}$/.test(project.key)) {
    throw new Error('Project key must start with a letter and contain 1-15 uppercase letters, numbers, or underscores.');
  }
  const workflowProblem = validateWorkflowStages(project.workflowStages);
  if (workflowProblem) throw new Error(workflowProblem);
  const stageNames = new Set(project.workflowStages.map(stage => stage.name.toLowerCase()));
  if (project.workItems.some(item => !stageNames.has(item.status.toLowerCase()))) {
    throw new Error('Every starter ticket must use one of the project workflow stages.');
  }
  if (!project.workspaceFolder && project.defaultAiToolMode !== 'project-only') {
    throw new Error('Folderless projects must use project-board tools only.');
  }
  if (!project.workspaceFolder && (project.type === 'software' || project.type === 'experiment')) {
    throw new Error('Software and Experiment projects require a workspace folder.');
  }
  // A folder-backed project reads its work items from the markdown plans tree,
  // so it cannot exist without a folder to read.
  if (project.storage === 'folder' && !project.workspaceFolder) {
    throw new Error('A folder-backed project requires a workspace folder.');
  }
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  const project = value as Partial<ProjectRecord> | undefined;
  return !!project && typeof project.id === 'string' && typeof project.name === 'string' &&
    typeof project.key === 'string' && Array.isArray(project.workflowStages) && Array.isArray(project.workItems);
}

function cloneProject(project: ProjectRecord): ProjectRecord {
  const copy = JSON.parse(JSON.stringify(project)) as ProjectRecord;
  // Records written before FX-BE-043 have category-less stages. Repairing on
  // read means no migration script and no half-typed record reaching a caller.
  copy.workflowStages = normalizeWorkflowStages(copy.workflowStages);
  return copy;
}
