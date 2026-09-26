import type { AgentToolMode } from '../ai/agentTypes';

/**
 * The Praxis project descriptor written into a project's own folder.
 *
 * Named under the rule every Praxis file follows (FX-BE-048): a file *tooling*
 * reads keeps its real extension last and carries `.praxis` as a middle
 * segment, matching `board.praxis.json` — same folder, same job. A file the
 * user *opens with Praxis* uses `.praxis` as the extension itself
 * (`<name>.workspace.praxis.json`).
 *
 * The generic `PROJECT.md` it replaced was a real collision: since FX-BE-047
 * Praxis only rewrites a file carrying its own markers, so a repository with
 * its own `PROJECT.md` silently got no Praxis project file at all.
 */
export const PROJECT_FILE_NAME = 'project.praxis.md';

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
  /**
   * The same two-tier hierarchy every other backend uses (see
   * `issues/issueHierarchy.ts`'s `getParentRule`): a Story/Task/Bug's parent
   * is a Feature, a Subtask's parent is a Story/Task/Bug, and a Feature
   * itself has none. Absent on every item created before this field existed.
   */
  parentKey?: string;
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

/**
 * The AI's answer to "which workflow template fits this project", cached on
 * the project record itself (see `ProjectStore.setRecommendedWorkflowTemplate`)
 * so opening the New Workflow dialog never re-asks on its own — only an
 * explicit refresh in that dialog computes a new one.
 */
export interface StoredTemplateRecommendation {
  templateId: string;
  rationale: string;
  model: string;
  /** ISO 8601 — when this recommendation was computed. */
  computedAt: string;
}

/**
 * The icons a project may pick as its identity glyph — a fixed subset of the
 * renderer's full `IconName` union (`ui/Icon.tsx`), curated to ones that read
 * as "a kind of project" rather than a UI-chrome glyph like `chevron-down`.
 * Core stays renderer-agnostic (it cannot import `IconName` itself — see
 * AGENTS.md's "A value import from `@praxis/core` anywhere under
 * `renderer/src`" note for the reverse direction of that same rule), so this
 * list is the source of truth and the renderer's icon picker reads it
 * directly; keeping it a subset of `IconName` is a hand-maintained
 * invariant, same as `settingsDefaults.ts`'s mirror of core's own defaults —
 * add a name here only once it also exists in `IconName`.
 */
export const PROJECT_ICON_NAMES = [
  'rocket',
  'target',
  'milestone',
  'star',
  'folder',
  'book',
  'lightbulb',
  'zap',
  'shield',
  'globe',
  'tools',
  'terminal',
  'server',
  'organization',
  'graph',
  'columns',
  'bug',
  'ticket',
  'sparkles',
  'robot'
] as const;

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

/**
 * The accent colors a project may pick alongside its icon, so two projects
 * sharing an icon still read apart in the sidebar at a glance. Names only —
 * core stays presentation-agnostic (it doesn't own icon SVGs either, just
 * `PROJECT_ICON_NAMES`); the actual hex per name is owned once, in the
 * renderer's `theme.css`, as `--project-color-<name>` custom properties,
 * matching how `--tone-green`/`--tone-amber`/`--tone-red` already work
 * (constant across marketplace themes — a project's own accent shouldn't
 * shift when the theme changes). The set and order come from the dataviz
 * skill's validated categorical palette: CVD-safe adjacent pairs, never
 * cycled, a fixed identity order.
 */
export const PROJECT_COLOR_NAMES = [
  'blue',
  'orange',
  'aqua',
  'yellow',
  'magenta',
  'green',
  'violet',
  'red'
] as const;

export type ProjectColorName = (typeof PROJECT_COLOR_NAMES)[number];

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
  recommendedWorkflowTemplate?: StoredTemplateRecommendation;
  /** One of `PROJECT_ICON_NAMES`; undefined falls back to the sidebar/home's plain default glyph. */
  icon?: ProjectIconName;
  /** One of `PROJECT_COLOR_NAMES`; undefined falls back to the sidebar/home's plain default ink. */
  color?: ProjectColorName;
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
  /**
   * Renaming after tickets exist is allowed — tracker association resolves
   * through the *current* key at read time, not a stored copy, so nothing
   * breaks — but it's cosmetic-only going forward: each existing ticket's
   * own `key` string (`${project.key}-${sequence}`, set once at creation)
   * keeps its old prefix, so old and new tickets read with different ones.
   */
  key?: string;
  type?: ProjectType;
  purpose?: string;
  brief?: Record<string, string>;
  workflowStages?: ProjectWorkflowStage[];
  defaultAiToolMode?: AgentToolMode;
  icon?: ProjectIconName;
  color?: ProjectColorName;
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
