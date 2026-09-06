import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ProjectStore,
  WorkspaceStore,
  validateProjectRecord,
  normalizeWorkflowStages,
  discoverPlanFolders,
  type AttachProjectFolderInput,
  type AttachProjectFolderResult,
  type CreateProjectInput,
  type FolderInspection,
  type ProjectDocument,
  type ProjectDocumentsResult,
  type ProjectRecord
} from '@praxis/core';

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.cs': 'C#', '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP'
};

export class ProjectManager {
  public constructor(private readonly store: ProjectStore) {}
  public list(): ProjectRecord[] { return this.store.list(); }
  public get(projectId: string): ProjectRecord | undefined { return this.store.get(projectId); }

  public listDocuments(projectId: string): ProjectDocumentsResult {
    const project = this.requireProject(projectId);
    const plansRoot = this.plansRoot(project.workspaceFolder);
    if (!plansRoot || !fs.existsSync(plansRoot)) return { exists: false, documents: [] };
    return { exists: true, documents: walkMarkdownFiles(plansRoot).map(file => {
      const content = fs.readFileSync(file, 'utf8');
      return { relativePath: path.relative(plansRoot, file).replaceAll(path.sep, '/'), name: documentName(content, path.basename(file)), type: documentType(content), status: documentStatus(content) };
    }) };
  }

  public readDocument(projectId: string, relativePath: string): ProjectDocument {
    const project = this.requireProject(projectId);
    const plansRoot = this.plansRoot(project.workspaceFolder);
    if (!plansRoot) throw new Error('This project has no workspace folder.');
    const resolved = path.resolve(plansRoot, relativePath);
    if (path.relative(plansRoot, resolved).startsWith('..') || path.extname(resolved).toLowerCase() !== '.md') {
      throw new Error('That project document is outside docs/plans.');
    }
    const content = fs.readFileSync(resolved, 'utf8');
    return { relativePath: path.relative(plansRoot, resolved).replaceAll(path.sep, '/'), name: documentName(content, path.basename(resolved)), type: documentType(content), status: documentStatus(content), content };
  }

  private requireProject(projectId: string): ProjectRecord { const project = this.store.get(projectId); if (!project) throw new Error(`Project ${projectId} was not found.`); return project; }
  private plansRoot(folder?: string): string | undefined { return folder ? path.resolve(folder, 'docs', 'plans') : undefined; }

  public async inspectFolder(folderPath: string): Promise<FolderInspection> {
    const resolved = path.resolve(folderPath.trim());
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(resolved); } catch { /* absent is reported, not thrown */ }
    if (!stat?.isDirectory()) {
      return { path: resolved, exists: !!stat, isDirectory: false, hasGit: false, projectFileExists: false, manifests: [], languages: [], frameworks: [], planFiles: [] };
    }
    // Inspect the selected project tree deeply enough to reach conventional
    // plans roots (for example docs/plans/features/.../tasks), while keeping
    // the existing file-count cap and skipping dependency/build directories.
    // Plans roots are discovered with the same scanner the import planner and
    // FolderService use, so "does this folder have plans?" has one answer.
    let planRoots: string[] = [];
    try {
      planRoots = (await discoverPlanFolders(resolved)).map(match => match.plansRootPath);
    } catch { /* an unreadable tree simply reports no plans */ }
    const files = walkFiles(resolved, 16, 5000);
    const relative = files.map(file => path.relative(resolved, file));
    const lowerNames = new Set(relative.map(file => file.toLowerCase()));
    const manifests = relative.filter(file => isManifest(path.basename(file))).sort();
    const languages = [...new Set(files.map(file => LANGUAGE_EXTENSIONS[path.extname(file).toLowerCase()]).filter((value): value is string => !!value))].sort();
    const frameworks: string[] = [];
    if (lowerNames.has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react) frameworks.push('React');
        if (deps.vue) frameworks.push('Vue');
        if (deps['@angular/core']) frameworks.push('Angular');
        if (deps.next) frameworks.push('Next.js');
        if (deps.electron) frameworks.push('Electron');
      } catch { /* malformed manifests remain visible in manifests */ }
    }
    if (relative.some(file => /\.csproj$/i.test(file))) frameworks.push('.NET');
    if (lowerNames.has('manage.py')) frameworks.push('Django');
    const readme = relative.find(file => /^readme(?:\.[^/]+)?$/i.test(file));
    // Any markdown under a plans root counts, wherever that root sits. This
    // used to match only `plans/`, `plan/` or `docs/plans/` — the same
    // hardcoded-path guess that made the import planner point boards at empty
    // directories. `discoverPlanFolders` is the one authority on what a plans
    // root looks like, so ask it instead of re-guessing the layout here.
    const planRootPrefixes = planRoots.map(root => {
      const rel = path.relative(resolved, root).replaceAll('\\', '/');
      return rel.length > 0 ? `${rel}/` : '';
    });
    const planFiles = relative.filter(file => {
      if (!/\.md$/i.test(file)) {
        return false;
      }
      const normalized = file.replaceAll('\\', '/');
      return planRootPrefixes.some(prefix => normalized.startsWith(prefix));
    }).sort();
    return {
      path: resolved, exists: true, isDirectory: true,
      hasGit: fs.existsSync(path.join(resolved, '.git')),
      readme, projectFileExists: fs.existsSync(path.join(resolved, 'PROJECT.md')),
      manifests, languages, frameworks: [...new Set(frameworks)].sort(), planFiles
    };
  }

  public async create(input: CreateProjectInput): Promise<ProjectRecord> {
    validateCreateInput(input, this.store.list());
    const folder = this.resolveFolder(input.startingPoint, input.folderPath, input.folderName);
    if (folder && input.startingPoint === 'new-folder' && fs.existsSync(folder)) {
      throw new Error(`The folder ${folder} already exists. Choose Existing Folder instead.`);
    }
    if (folder && input.startingPoint === 'existing-folder') requireExistingDirectory(folder);
    const now = new Date().toISOString();
    const id = `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // A folder-backed project reads its work items from the markdown plans on
    // disk, so starter tickets would be written nowhere — drop them rather than
    // storing items its board will never show.
    const storage = folder && input.storage === 'folder' ? 'folder' : 'app';
    const project: ProjectRecord = {
      id, name: input.name.trim(), key: input.key.trim().toUpperCase(), type: input.type,
      purpose: input.purpose.trim(), brief: cleanBrief(input.brief), workspaceFolder: folder,
      storage,
      workflowStages: input.workflowStages.map(stage => ({ id: stage.id, name: stage.name.trim(), ...(stage.category ? { category: stage.category } : {}) })),
      defaultBoardId: `${id}-board`, linkedBoards: [],
      defaultAiToolMode: folder ? input.defaultAiToolMode : 'project-only',
      workItems: storage === 'folder' ? [] : input.starterTickets.map((ticket, index) => ({
        id: `${id}-item-${index + 1}`, key: `${input.key.trim().toUpperCase()}-${index + 1}`,
        summary: ticket.summary.trim(), description: ticket.description.trim(),
        issueType: ticket.issueType.trim() || 'Task', status: ticket.status,
        createdAt: now, updatedAt: now
      })),
      createdAt: now, updatedAt: now, projectFileStatus: folder ? 'created' : 'not-requested'
    };
    validateProjectRecord(project);
    let createdFolder = false;
    let createdProjectFile = false;
    try {
      if (folder && input.startingPoint === 'new-folder') { await fs.promises.mkdir(folder); createdFolder = true; }
      if (folder) {
        project.folderInspection = await this.inspectFolder(folder);
        const snapshot = await writeProjectSnapshot(folder, project);
        project.projectFileStatus = snapshot; createdProjectFile = snapshot === 'created';
        project.folderInspection = await this.inspectFolder(folder);
      }
      return await this.store.create(project);
    } catch (error) {
      if (createdFolder && folder) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      else if (createdProjectFile && folder) await fs.promises.unlink(path.join(folder, 'PROJECT.md')).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The desktop creation boundary. Validate the target before touching disk,
   * then coordinate project and workspace persistence. Existing projects can
   * still be referenced by more than one workspace; only creation is strict.
   */
  public async createInWorkspace(
    input: CreateProjectInput,
    workspaceId: string,
    workspaces: WorkspaceStore,
    appVersion: string
  ): Promise<ProjectRecord> {
    if (!workspaceId?.trim() || !workspaces.get(workspaceId)) {
      throw new Error('Open a valid workspace before creating a project.');
    }
    const project = await this.create(input);
    try {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
      await workspaces.update(workspaceId, {
        projectIds: [...workspace.projectIds, project.id],
        defaultProjectId: workspace.defaultProjectId ?? project.id
      }, appVersion);
      return project;
    } catch (error) {
      await this.store.remove(project.id).catch(() => undefined);
      await this.removeCreatedArtifacts(input, project);
      throw error;
    }
  }

  public async useInWorkspace(
    projectId: string,
    workspaceId: string,
    workspaces: WorkspaceStore,
    appVersion: string
  ): Promise<ProjectRecord> {
    const project = this.store.get(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error('Open a valid workspace before using an existing project.');
    if (!workspace.projectIds.includes(project.id)) {
      await workspaces.update(workspaceId, {
        projectIds: [...workspace.projectIds, project.id],
        defaultProjectId: workspace.defaultProjectId ?? project.id
      }, appVersion);
    }
    return project;
  }

  private async removeCreatedArtifacts(input: CreateProjectInput, project: ProjectRecord): Promise<void> {
    const folder = project.workspaceFolder;
    if (!folder) return;
    if (input.startingPoint === 'new-folder') {
      await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    } else if (project.projectFileStatus === 'created') {
      await fs.promises.unlink(path.join(folder, 'PROJECT.md')).catch(() => undefined);
    }
  }

  public async attachFolder(projectId: string, input: AttachProjectFolderInput): Promise<AttachProjectFolderResult> {
    const project = this.store.get(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    if (project.workspaceFolder) throw new Error('This project already has a workspace folder.');
    const folder = this.resolveFolder(input.startingPoint, input.folderPath, input.folderName)!;
    if (input.startingPoint === 'new-folder' && fs.existsSync(folder)) throw new Error(`The folder ${folder} already exists. Choose Existing Folder instead.`);
    if (input.startingPoint === 'existing-folder') requireExistingDirectory(folder);
    let createdFolder = false; let createdProjectFile = false;
    try {
      if (input.startingPoint === 'new-folder') { await fs.promises.mkdir(folder); createdFolder = true; }
      let status: AttachProjectFolderResult['projectFileStatus'] = 'not-requested';
      const next = { ...project, workspaceFolder: folder, defaultAiToolMode: project.type === 'software' || project.type === 'experiment' ? 'full' as const : 'read-only' as const, updatedAt: new Date().toISOString() };
      if (input.createProjectFile !== false) { status = await writeProjectSnapshot(folder, next); createdProjectFile = status === 'created'; }
      next.projectFileStatus = status; next.folderInspection = await this.inspectFolder(folder);
      const saved = await this.store.replace(next);
      return { project: saved, projectFileStatus: status };
    } catch (error) {
      if (createdFolder) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      else if (createdProjectFile) await fs.promises.unlink(path.join(folder, 'PROJECT.md')).catch(() => undefined);
      throw error;
    }
  }

  private resolveFolder(startingPoint: CreateProjectInput['startingPoint'], folderPath?: string, folderName?: string): string | undefined {
    if (startingPoint === 'app-storage') return undefined;
    if (!folderPath?.trim()) throw new Error(startingPoint === 'new-folder' ? 'A parent folder is required.' : 'An existing folder is required.');
    if (startingPoint === 'new-folder') {
      if (!folderName?.trim() || /[\\/]/.test(folderName)) throw new Error('A valid project folder name is required.');
      requireExistingDirectory(path.resolve(folderPath));
      return path.resolve(folderPath, folderName.trim());
    }
    return path.resolve(folderPath);
  }

  /**
   * Regenerates a project's `PROJECT.md` after something it renders changed.
   * Safe on a hand-edited file — see `writeProjectSnapshot`.
   */
  public async refreshProjectFile(project: ProjectRecord): Promise<void> {
    if (!project.workspaceFolder) return;
    await writeProjectSnapshot(project.workspaceFolder, project);
  }
}

function validateCreateInput(input: CreateProjectInput, projects: ProjectRecord[]): void {
  if (!input.name.trim()) throw new Error('Project name is required.');
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,14}$/.test(key)) throw new Error('Project key must start with a letter and contain 1-15 letters, numbers, or underscores.');
  if (projects.some(project => project.key.toLowerCase() === key.toLowerCase())) throw new Error(`Project key ${key} is already in use.`);
  if ((input.type === 'software' || input.type === 'experiment') && input.startingPoint === 'app-storage') throw new Error('Software and Experiment projects require a new or existing folder.');
  if (input.startingPoint === 'app-storage' && input.type !== 'product' && input.type !== 'research') throw new Error('Only Product and Research projects can use app storage without a folder.');
  if (input.workflowStages.length < 2) throw new Error('At least two workflow stages are required.');
  // Existing folders may already contain their own plans/tickets; importing
  // the project should not force Praxis to invent a starter ticket.
  if (input.startingPoint !== 'existing-folder' && !input.starterTickets.length) throw new Error('At least one starter ticket is required.');
}

function requireExistingDirectory(value: string): void { if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) throw new Error(`${value} is not an existing folder.`); }
function cleanBrief(brief: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(brief).map(([key, value]) => [key, value.trim()])); }
function isManifest(name: string): boolean { return /^(package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|gemfile|[^/]+\.csproj)$/i.test(name); }
function walkFiles(root: string, maxDepth: number, maxFiles: number): string[] { const result: string[] = []; const visit = (dir: string, depth: number) => { if (depth > maxDepth || result.length >= maxFiles) return; let entries: fs.Dirent[] = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (result.length >= maxFiles || ['node_modules', '.git', 'dist', 'out'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full, depth + 1); else if (entry.isFile()) result.push(full); } }; visit(root, 0); return result; }
function walkMarkdownFiles(root: string): string[] { return walkFiles(root, 12, 2000).filter(file => path.extname(file).toLowerCase() === '.md').sort((a, b) => a.localeCompare(b)); }
function documentName(content: string, filename: string): string {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content)?.[1];
  const frontmatterName = frontmatter?.match(/^(?:name|title):\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return frontmatterName || heading || filename.replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
}
function documentType(content: string): string {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content)?.[1];
  return frontmatter?.match(/^type:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
    || /^\*\*Type:\*\*\s*(.+)$/m.exec(content)?.[1]?.trim()
    || 'Other';
}
function documentStatus(content: string): string | undefined {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content)?.[1];
  const raw = frontmatter?.match(/^status:\s*["']?(.+?)["']?\s*$/m)?.[1]
    || /^\*\*Status:\*\*\s*(.+)$/m.exec(content)?.[1];
  const normalized = raw?.replace(/^[^A-Za-z0-9]+/, '').trim().replace(/[-_]+/g, ' ');
  return normalized || undefined;
}
const SNAPSHOT_BEGIN = '<!-- praxis:begin — generated from the project. Edit in Praxis; text outside this block is yours. -->';
const SNAPSHOT_END = '<!-- praxis:end -->';

/**
 * Writes `PROJECT.md` (FX-BE-047).
 *
 * The file used to be written once with the `wx` flag and never reconciled,
 * which is how a project could advertise a workflow its board did not have.
 * It is now regenerated, without clobbering anything a human added:
 *
 * - **No file** — write the generated block wrapped in markers.
 * - **Markers present** — replace only what is between them.
 * - **Markers absent** (every file written before this story) — adopt it by
 *   rewriting only the sections Praxis recognises, leaving all other prose
 *   exactly where it is.
 */
async function writeProjectSnapshot(folder: string, project: ProjectRecord): Promise<'created' | 'retained'> {
  const target = path.join(folder, 'PROJECT.md');
  const generated = renderSnapshot(project);
  let existing: string;
  try {
    existing = await fs.promises.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.promises.writeFile(target, `${SNAPSHOT_BEGIN}\n${generated}${SNAPSHOT_END}\n`, 'utf8');
    return 'created';
  }

  const begin = existing.indexOf(SNAPSHOT_BEGIN);
  const end = existing.indexOf(SNAPSHOT_END);
  const next = begin >= 0 && end > begin
    ? `${existing.slice(0, begin)}${SNAPSHOT_BEGIN}\n${generated}${existing.slice(end)}`
    : adoptLegacySnapshot(existing, project);
  if (next !== existing) await fs.promises.writeFile(target, next, 'utf8');
  return 'retained';
}

/**
 * Brings a marker-less `PROJECT.md` up to date by replacing the body of the
 * sections Praxis generates — `## Purpose` and `## Workflow` — and leaving
 * every other line untouched. Adding markers is deliberately not done here: it
 * would rewrite a file the user may have restructured.
 */
function adoptLegacySnapshot(existing: string, project: ProjectRecord): string {
  let next = replaceSection(existing, 'Purpose', `${project.purpose || '_Not specified_'}\n`);
  next = replaceSection(
    next,
    'Workflow',
    `${effectiveWorkflow(project).map(stage => `- ${stage.name}`).join('\n')}\n`
  );
  return next;
}

/** Replaces the body of one `## <heading>` section, leaving the rest of the document alone. */
function replaceSection(content: string, heading: string, body: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return content;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) { end = index; break; }
  }
  return [...lines.slice(0, start + 1), '', ...body.split('\n'), ...lines.slice(end)].join('\n');
}

/**
 * The workflow the board actually renders. The project record is the source
 * for both backends — a folder-backed project's stages are written through to
 * `board.praxis.json` — so this can never advertise a column that does not
 * exist.
 */
function effectiveWorkflow(project: ProjectRecord) {
  return normalizeWorkflowStages(project.workflowStages);
}
function renderSnapshot(project: ProjectRecord): string { const fields = Object.entries(project.brief).map(([key, value]) => `## ${key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}\n\n${value || '_Not specified_'}\n`).join('\n'); return `# ${project.name}\n\n- Key: ${project.key}\n- Type: ${project.type}\n- Created: ${project.createdAt}\n\n## Purpose\n\n${project.purpose || '_Not specified_'}\n\n${fields}\n## Workflow\n\n${effectiveWorkflow(project).map(stage => `- ${stage.name}`).join('\n')}\n`; }
