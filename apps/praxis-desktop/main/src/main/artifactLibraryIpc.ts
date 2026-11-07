import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { app, shell } from 'electron';
import {
  buildArtifactLibraryItems,
  findRepositoryRoot,
  isInsideArtifactsFolder,
  listArtifactsFolder,
  normalizeArtifactsFolder,
  DEFAULT_ARTIFACTS_FOLDER,
  readSandboxedFile,
  resolveArtifactsFolder,
  resolveSandboxedPath,
  type ArtifactGroup,
  type ArtifactLibrary,
  visibleArtifactGroups,
  type ProjectRecord,
  type SavedArtifactRecord
} from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getProjectStore } from './projectStoreInstance';
import { broadcastToAllWindows } from './windowBroadcast';
import { SavedArtifactStore } from './savedArtifactStore';
import { captureRestrictedHtmlThumbnail } from './htmlArtifactPreview';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

/** Pages can embed screenshots as data URIs, so allow more than a text read. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

let store: SavedArtifactStore | undefined;
/** Renders run one at a time: each is a hidden browser window. */
let thumbnailQueue: Promise<unknown> = Promise.resolve();
/** Same file, same moment: callers share one render. */
const thumbnailsInFlight = new Map<string, Promise<string | undefined>>();
/** Pages that failed to render this run, so a broken page isn't re-rendered on every scroll. */
const failedThumbnails = new Set<string>();

/**
 * A page's thumbnail as a `data:` URL, rendered once and cached in
 * `userData/artifact-thumbnails` under the file's path, size and modification
 * time — so editing the page refreshes it, and nothing else does.
 */
export async function pageThumbnail(root: string, absolute: string): Promise<string | undefined> {
  const stat = await fsp.stat(absolute);
  if (!stat.isFile() || stat.size > MAX_PAGE_BYTES) return undefined;
  const key = createHash('sha256').update(`${absolute}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 40);
  if (failedThumbnails.has(key)) return undefined;
  const cacheDir = nodePath.join(app.getPath('userData'), 'artifact-thumbnails');
  const cacheFile = nodePath.join(cacheDir, `${key}.jpg`);
  const cached = await fsp.readFile(cacheFile).catch(() => undefined);
  if (cached) return `data:image/jpeg;base64,${cached.toString('base64')}`;

  const pending = thumbnailsInFlight.get(key);
  if (pending) return pending;
  const render = thumbnailQueue.then(async () => {
    try {
      const html = (await readSandboxedFile(root, absolute, MAX_PAGE_BYTES)).toString('utf8');
      const jpeg = await captureRestrictedHtmlThumbnail(html);
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cacheFile, jpeg);
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch {
      failedThumbnails.add(key);
      return undefined;
    } finally {
      thumbnailsInFlight.delete(key);
    }
  });
  thumbnailQueue = render.catch(() => undefined);
  thumbnailsInFlight.set(key, render);
  return render;
}

/** `userData/saved-artifacts.json`; `--user-data-dir` isolates the e2e profile. */
export function getSavedArtifactStore(): SavedArtifactStore {
  store ??= new SavedArtifactStore(nodePath.join(app.getPath('userData'), 'saved-artifacts.json'));
  return store;
}

/**
 * The repository and folder a project's artifacts live in — always its main
 * checkout, so a worktree session's saves land where the page can see them and
 * survive the worktree being removed.
 */
export async function projectArtifactsLocation(project: ProjectRecord): Promise<{ root: string; folder: string } | undefined> {
  const workspaceFolder = project.workspaceFolder?.trim();
  if (!workspaceFolder) return undefined;
  return resolveArtifactsFolder(workspaceFolder, project.artifactsFolder);
}

/**
 * The project a save belongs to: the session's own project, else the one whose
 * repository the session works in (a free-form conversation opened on a
 * project's folder still belongs on that project's page).
 */
export async function projectForSave(projectId: string | undefined, sessionFolder: string): Promise<ProjectRecord | undefined> {
  const projects = getProjectStore();
  const own = projectId ? projects.get(projectId) : undefined;
  if (own) return own;
  const sessionRoot = await findRepositoryRoot(sessionFolder);
  if (!sessionRoot) return undefined;
  for (const project of projects.list()) {
    const folder = project.workspaceFolder?.trim();
    if (folder && (await findRepositoryRoot(folder)) === sessionRoot) return project;
  }
  return undefined;
}

export async function rememberSavedArtifact(record: SavedArtifactRecord): Promise<void> {
  await getSavedArtifactStore().upsert(record);
  broadcastToAllWindows('artifacts:changed', record.projectId);
}

async function locateProject(projectId: unknown): Promise<{ projectId: string; root: string; folder: string }> {
  const project = typeof projectId === 'string' ? getProjectStore().get(projectId) : undefined;
  if (!project) throw new Error('Project not found.');
  const location = await projectArtifactsLocation(project);
  if (!location) throw new Error('This project has no folder for artifacts.');
  return { projectId: project.id, ...location };
}

function groupName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return name || 'Untitled group';
}

function groupPaths(folder: string, raw: unknown): ArtifactGroup['paths'] {
  if (!Array.isArray(raw) || raw.length > 500) throw new Error('A group holds up to 500 artifacts.');
  if (!raw.every(path => typeof path === 'string' && isInsideArtifactsFolder(folder, path))) {
    throw new Error('Artifact is outside the project\u2019s artifacts folder.');
  }
  return raw as string[];
}

async function locate(projectId: unknown, path: unknown): Promise<{ root: string; folder: string; path: string; absolute: string }> {
  const project = typeof projectId === 'string' ? getProjectStore().get(projectId) : undefined;
  if (!project) throw new Error('Project not found.');
  const location = await projectArtifactsLocation(project);
  if (!location) throw new Error('This project has no folder for artifacts.');
  if (typeof path !== 'string' || !isInsideArtifactsFolder(location.folder, path)) {
    throw new Error('Artifact is outside the project’s artifacts folder.');
  }
  const absolute = await resolveSandboxedPath(location.root, path);
  return { ...location, path, absolute };
}

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function registerArtifactLibraryIpc(): void {
  ipcMain.handle('artifacts:list', async (_event, projectId: unknown): Promise<ArtifactLibrary> => {
    const project = typeof projectId === 'string' ? getProjectStore().get(projectId) : undefined;
    if (!project) throw new Error('Project not found.');
    const location = await projectArtifactsLocation(project);
    if (!location) {
      const folder = normalizeArtifactsFolder(project.artifactsFolder ?? '') ?? DEFAULT_ARTIFACTS_FOLDER;
      return { available: false, folder, items: [], groups: [], truncated: false };
    }
    const [{ entries, truncated }, records, groups] = await Promise.all([
      listArtifactsFolder(location.root, location.folder),
      getSavedArtifactStore().list(project.id),
      getSavedArtifactStore().listGroups(project.id)
    ]);
    return {
      available: true,
      folder: location.folder,
      root: location.root,
      items: buildArtifactLibraryItems(entries, records),
      groups: visibleArtifactGroups(groups, new Set(entries.map(entry => entry.path))),
      truncated
    };
  });

  ipcMain.handle('artifacts:readText', async (_event, projectId: unknown, path: unknown) => {
    const { root, absolute, path: relative } = await locate(projectId, path);
    try {
      const stat = await fsp.stat(absolute);
      if (stat.size > MAX_TEXT_BYTES) throw new Error('Artifact is larger than 2 MB, too large to preview.');
      return (await readSandboxedFile(root, absolute, MAX_TEXT_BYTES)).toString('utf8');
    } catch (error) {
      if (notFound(error)) throw new Error(`Artifact file was not found: ${relative}`);
      throw error;
    }
  });

  ipcMain.handle('artifacts:loadImage', async (_event, projectId: unknown, path: unknown) => {
    const { root, absolute } = await locate(projectId, path);
    const mediaType = IMAGE_TYPES[nodePath.extname(absolute).toLowerCase()];
    if (!mediaType) return undefined;
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return undefined;
      const bytes = await readSandboxedFile(root, absolute, MAX_IMAGE_BYTES);
      return `data:${mediaType};base64,${bytes.toString('base64')}`;
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  });

  ipcMain.handle('artifacts:pageThumbnail', async (_event, projectId: unknown, path: unknown) => {
    const { root, absolute } = await locate(projectId, path);
    if (!/\.html?$/i.test(absolute)) return undefined;
    try {
      return await pageThumbnail(root, absolute);
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  });

  ipcMain.handle('artifacts:createGroup', async (_event, projectId: unknown, name: unknown, paths: unknown) => {
    const { folder, projectId: id } = await locateProject(projectId);
    const group = await getSavedArtifactStore().saveGroup({
      id: randomUUID(),
      projectId: id,
      name: groupName(name),
      paths: groupPaths(folder, paths),
      createdAt: new Date().toISOString()
    });
    if (!group) throw new Error('A group needs at least one artifact.');
    broadcastToAllWindows('artifacts:changed', id);
    return group;
  });

  ipcMain.handle('artifacts:updateGroup', async (_event, projectId: unknown, groupId: unknown, change: unknown) => {
    const { folder, projectId: id } = await locateProject(projectId);
    const store = getSavedArtifactStore();
    const existing = typeof groupId === 'string' ? await store.getGroup(id, groupId) : undefined;
    if (!existing) throw new Error('That group no longer exists.');
    const update = (change ?? {}) as { name?: unknown; paths?: unknown };
    const saved = await store.saveGroup({
      ...existing,
      ...(update.name !== undefined ? { name: groupName(update.name) } : {}),
      ...(update.paths !== undefined ? { paths: groupPaths(folder, update.paths) } : {})
    });
    broadcastToAllWindows('artifacts:changed', id);
    return saved;
  });

  ipcMain.handle('artifacts:deleteGroup', async (_event, projectId: unknown, groupId: unknown) => {
    const { projectId: id } = await locateProject(projectId);
    if (typeof groupId !== 'string') throw new Error('That group no longer exists.');
    await getSavedArtifactStore().deleteGroup(id, groupId);
    broadcastToAllWindows('artifacts:changed', id);
  });

  ipcMain.handle('artifacts:delete', async (_event, projectId: unknown, path: unknown) => {
    const { absolute, path: relative } = await locate(projectId, path);
    const stat = await fsp.lstat(absolute).catch(error => (notFound(error) ? undefined : Promise.reject(error)));
    if (stat && !stat.isFile()) throw new Error('Only files can be deleted from the artifacts folder.');
    if (stat) await fsp.unlink(absolute);
    await getSavedArtifactStore().remove(projectId as string, relative);
    broadcastToAllWindows('artifacts:changed', projectId);
  });

  ipcMain.handle('artifacts:reveal', async (_event, projectId: unknown, path: unknown) => {
    const { absolute } = await locate(projectId, path);
    shell.showItemInFolder(absolute);
  });
}
