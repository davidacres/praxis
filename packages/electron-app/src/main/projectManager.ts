import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ProjectStore,
  validateProjectRecord,
  type AttachProjectFolderInput,
  type AttachProjectFolderResult,
  type CreateProjectInput,
  type FolderInspection,
  type ProjectRecord
} from '@ticket-manager/core';

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.cs': 'C#', '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP'
};

export class ProjectManager {
  public constructor(private readonly store: ProjectStore) {}
  public list(): ProjectRecord[] { return this.store.list(); }
  public get(projectId: string): ProjectRecord | undefined { return this.store.get(projectId); }

  public inspectFolder(folderPath: string): FolderInspection {
    const resolved = path.resolve(folderPath.trim());
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(resolved); } catch { /* absent is reported, not thrown */ }
    if (!stat?.isDirectory()) {
      return { path: resolved, exists: !!stat, isDirectory: false, hasGit: false, projectFileExists: false, manifests: [], languages: [], frameworks: [] };
    }
    const files = walkFiles(resolved, 3, 3000);
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
    return {
      path: resolved, exists: true, isDirectory: true,
      hasGit: fs.existsSync(path.join(resolved, '.git')),
      readme, projectFileExists: fs.existsSync(path.join(resolved, 'PROJECT.md')),
      manifests, languages, frameworks: [...new Set(frameworks)].sort()
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
    const project: ProjectRecord = {
      id, name: input.name.trim(), key: input.key.trim().toUpperCase(), type: input.type,
      purpose: input.purpose.trim(), brief: cleanBrief(input.brief), workspaceFolder: folder,
      workflowStages: input.workflowStages.map(stage => ({ id: stage.id, name: stage.name.trim() })),
      defaultBoardId: `${id}-board`, linkedBoards: [],
      defaultAiToolMode: folder ? input.defaultAiToolMode : 'project-only',
      workItems: input.starterTickets.map((ticket, index) => ({
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
        project.folderInspection = this.inspectFolder(folder);
        const snapshot = await writeProjectSnapshot(folder, project);
        project.projectFileStatus = snapshot; createdProjectFile = snapshot === 'created';
        project.folderInspection = this.inspectFolder(folder);
      }
      return await this.store.create(project);
    } catch (error) {
      if (createdFolder && folder) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
      else if (createdProjectFile && folder) await fs.promises.unlink(path.join(folder, 'PROJECT.md')).catch(() => undefined);
      throw error;
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
      next.projectFileStatus = status; next.folderInspection = this.inspectFolder(folder);
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
}

function validateCreateInput(input: CreateProjectInput, projects: ProjectRecord[]): void {
  if (!input.name.trim()) throw new Error('Project name is required.');
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,14}$/.test(key)) throw new Error('Project key must start with a letter and contain 1-15 letters, numbers, or underscores.');
  if (projects.some(project => project.key.toLowerCase() === key.toLowerCase())) throw new Error(`Project key ${key} is already in use.`);
  if ((input.type === 'software' || input.type === 'experiment') && input.startingPoint === 'app-storage') throw new Error('Software and Experiment projects require a new or existing folder.');
  if (input.startingPoint === 'app-storage' && input.type !== 'product' && input.type !== 'research') throw new Error('Only Product and Research projects can use app storage without a folder.');
  if (input.workflowStages.length < 2) throw new Error('At least two workflow stages are required.');
  if (!input.starterTickets.length) throw new Error('At least one starter ticket is required.');
}

function requireExistingDirectory(value: string): void { if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) throw new Error(`${value} is not an existing folder.`); }
function cleanBrief(brief: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(brief).map(([key, value]) => [key, value.trim()])); }
function isManifest(name: string): boolean { return /^(package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|gemfile|[^/]+\.csproj)$/i.test(name); }
function walkFiles(root: string, maxDepth: number, maxFiles: number): string[] { const result: string[] = []; const visit = (dir: string, depth: number) => { if (depth > maxDepth || result.length >= maxFiles) return; let entries: fs.Dirent[] = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (result.length >= maxFiles || ['node_modules', '.git', 'dist', 'out'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full, depth + 1); else if (entry.isFile()) result.push(full); } }; visit(root, 0); return result; }
async function writeProjectSnapshot(folder: string, project: ProjectRecord): Promise<'created' | 'retained'> { const target = path.join(folder, 'PROJECT.md'); try { const handle = await fs.promises.open(target, 'wx'); await handle.writeFile(renderSnapshot(project), 'utf8'); await handle.close(); return 'created'; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'retained'; throw error; } }
function renderSnapshot(project: ProjectRecord): string { const fields = Object.entries(project.brief).map(([key, value]) => `## ${key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}\n\n${value || '_Not specified_'}\n`).join('\n'); return `# ${project.name}\n\n- Key: ${project.key}\n- Type: ${project.type}\n- Created: ${project.createdAt}\n\n## Purpose\n\n${project.purpose || '_Not specified_'}\n\n${fields}\n## Workflow\n\n${project.workflowStages.map(stage => `- ${stage.name}`).join('\n')}\n`; }
