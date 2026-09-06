import type { AgentToolMode } from '../ai/agentTypes';

export type ProjectType = 'software' | 'product' | 'research' | 'experiment';
export type ProjectStartingPoint = 'new-folder' | 'existing-folder' | 'app-storage';

/**
 * Where a stage sits on the universal todo → in-progress → done spine.
 *
 * Jira's vocabulary, already used by `folderService`'s status table and by
 * `jiraShape.statusCategoryRank`. It is what lets a freeform status string
 * ("✅ Complete", "🚧 In progress") resolve onto an *arbitrary* workflow: an
 * exact stage-name match is tried first, and the category is the fallback that
 * works whatever the stages happen to be called.
 */
export type ProjectWorkflowCategory = 'todo' | 'indeterminate' | 'done';

export interface ProjectWorkflowStage {
  id: string;
  name: string;
  /**
   * Optional on the wire so records written before FX-BE-043 still load.
   * `normalizeWorkflowStages` fills it in on read, so anything that has been
   * through the store carries one.
   */
  category?: ProjectWorkflowCategory;
}

export interface ProjectWorkItem {
  id: string;
  key: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBoardReference {
  connectionId: string;
  boardId: string;
  displayName: string;
}

export interface FolderInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasGit: boolean;
  readme?: string;
  projectFileExists: boolean;
  manifests: string[];
  languages: string[];
  frameworks: string[];
  /** Markdown planning files found under a conventional plans folder. */
  planFiles?: string[];
}

export interface ProjectDocument {
  relativePath: string;
  name: string;
  type?: string;
  /** Normalized planning status parsed from front matter or legacy headings. */
  status?: string;
  content?: string;
}

export interface ProjectDocumentsResult {
  exists: boolean;
  documents: ProjectDocument[];
}

/**
 * Where a project's work items live.
 *
 * `app` keeps them in this record's `workItems` array (the app's own JSON).
 * `folder` makes the markdown plans tree under `workspaceFolder` the source of
 * truth — `workItems` is then unused and the board is served by `FolderService`.
 */
export type ProjectStorage = 'app' | 'folder';

export interface ProjectRecord {
  id: string;
  name: string;
  key: string;
  type: ProjectType;
  purpose: string;
  brief: Record<string, string>;
  /** Defaults to `app` when absent, which is what every project written before this field was. */
  storage?: ProjectStorage;
  workspaceFolder?: string;
  workflowStages: ProjectWorkflowStage[];
  defaultBoardId: string;
  workItems: ProjectWorkItem[];
  linkedBoards: ProjectBoardReference[];
  defaultAiToolMode: AgentToolMode;
  folderInspection?: FolderInspection;
  projectFileStatus?: 'created' | 'retained' | 'not-requested';
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  key: string;
  type: ProjectType;
  purpose: string;
  brief: Record<string, string>;
  startingPoint: ProjectStartingPoint;
  /** Defaults to `app`. `folder` requires a resolved `workspaceFolder`. */
  storage?: ProjectStorage;
  /** Existing folder, or the parent folder when startingPoint is new-folder. */
  folderPath?: string;
  folderName?: string;
  workflowStages: ProjectWorkflowStage[];
  starterTickets: Array<Pick<ProjectWorkItem, 'summary' | 'description' | 'issueType' | 'status'>>;
  defaultAiToolMode: AgentToolMode;
}

export interface UpdateProjectInput {
  name?: string;
  type?: ProjectType;
  purpose?: string;
  brief?: Record<string, string>;
  workflowStages?: ProjectWorkflowStage[];
  defaultAiToolMode?: AgentToolMode;
}

export interface AttachProjectFolderInput {
  startingPoint: Exclude<ProjectStartingPoint, 'app-storage'>;
  folderPath: string;
  folderName?: string;
  createProjectFile?: boolean;
}

export interface AttachProjectFolderResult {
  project: ProjectRecord;
  projectFileStatus: 'created' | 'retained' | 'not-requested';
}
