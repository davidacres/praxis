import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { ArtifactGroup, SavedArtifactRecord } from '@praxis/core';

interface SavedArtifactsDocument {
  version: 1;
  records: SavedArtifactRecord[];
  /** Added later; absent in older files. */
  groups: ArtifactGroup[];
}

/** The details file kept in a project's artifacts folder, beside the files it describes. */
export const ARTIFACT_DETAILS_FILE = '.praxis-artifacts.json';

const REPOSITORY_NOTE = 'Praxis artifact details: titles, descriptions, groups and the session each file was saved from. Paths are repository-relative. Safe to edit or delete.';

/**
 * What "Save" remembers about each artifact it published: title, description,
 * the session it came from, and the groups the files are arranged in.
 *
 * Two homes. Given a `projectId`, the file is that project's
 * `.praxis-artifacts.json` inside its artifacts folder — committed with the
 * artifacts, so the details travel with the repository. Project ids are local
 * to one install, so that file stores none; they are filled in on read.
 * Without one, it is the old app-local `userData/saved-artifacts.json`, kept
 * only as the source a project's details are first imported from.
 *
 * The folder stays the source of truth; a record only adds details to a file
 * that exists. Writes are atomic (temp file + rename) and run one at a time.
 * A file that cannot be parsed — say, one left with merge-conflict markers —
 * is read as empty and never overwritten.
 *
 * No Electron imports, so it is unit-testable under plain Node.
 */
export class SavedArtifactStore {
  private document: SavedArtifactsDocument | undefined;
  private unreadable = false;
  private missing = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filePath: string, private readonly options: { projectId?: string } = {}) {}

  /**
   * A repository details file that does not exist yet starts from what this
   * install already knew about the project. Does nothing once the file exists.
   */
  public async seedIfMissing(records: SavedArtifactRecord[], groups: ArtifactGroup[]): Promise<void> {
    await this.load();
    if (!this.missing || (records.length === 0 && groups.length === 0)) return;
    await this.mutate(document => ({ ...document, records: [...records], groups: groups.map(group => ({ ...group, paths: [...group.paths] })) }));
  }

  public async list(projectId: string): Promise<SavedArtifactRecord[]> {
    const document = await this.load();
    return document.records.filter(record => record.projectId === projectId).map(record => ({ ...record }));
  }

  public async listGroups(projectId: string): Promise<ArtifactGroup[]> {
    const document = await this.load();
    return document.groups.filter(group => group.projectId === projectId).map(group => ({ ...group, paths: [...group.paths] }));
  }

  /** Adds or replaces the record for this project and path. */
  public upsert(record: SavedArtifactRecord): Promise<void> {
    return this.mutate(document => ({
      ...document,
      records: [
        ...document.records.filter(existing => !(existing.projectId === record.projectId && existing.path === record.path)),
        { ...record }
      ]
    }));
  }

  /** Forgets a deleted file: its record, and its place in any group. */
  public remove(projectId: string, path: string): Promise<void> {
    return this.mutate(document => ({
      ...document,
      records: document.records.filter(record => !(record.projectId === projectId && record.path === path)),
      groups: withoutPaths(document.groups, projectId, new Set([path]), undefined)
    }));
  }

  /**
   * Creates or rewrites a group. Its paths leave any other group they were in
   * (a file is in at most one), and a group left empty disappears.
   */
  public async saveGroup(group: ArtifactGroup): Promise<ArtifactGroup | undefined> {
    const paths = [...new Set(group.paths)];
    await this.mutate(document => {
      const others = withoutPaths(document.groups, group.projectId, new Set(paths), group.id)
        .filter(existing => !(existing.projectId === group.projectId && existing.id === group.id));
      return { ...document, groups: paths.length > 0 ? [...others, { ...group, paths }] : others };
    });
    return paths.length > 0 ? { ...group, paths } : undefined;
  }

  public async getGroup(projectId: string, groupId: string): Promise<ArtifactGroup | undefined> {
    return (await this.listGroups(projectId)).find(group => group.id === groupId);
  }

  /** Ungroups: the group goes, its files stay. */
  public deleteGroup(projectId: string, groupId: string): Promise<void> {
    return this.mutate(document => ({
      ...document,
      groups: document.groups.filter(group => !(group.projectId === projectId && group.id === groupId))
    }));
  }

  private mutate(change: (document: SavedArtifactsDocument) => SavedArtifactsDocument): Promise<void> {
    const run = this.queue.then(async () => {
      const document = await this.load();
      if (this.unreadable) throw new Error('Saved artifact details could not be read, so they were not changed.');
      const next: SavedArtifactsDocument = { ...change(document), version: 1 };
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.mkdir(nodePath.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(temp, `${JSON.stringify(this.options.projectId ? forRepository(next) : next, null, 2)}\n`, 'utf8');
      await fs.promises.rename(temp, this.filePath);
      this.document = next;
      this.missing = false;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<SavedArtifactsDocument> {
    // A repository file can change underneath us — a pull, a branch switch, a
    // hand edit — so it is re-read every time. It is small.
    const repository = this.options.projectId;
    if (this.document && !repository) return this.document;
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.missing = true;
      this.unreadable = false;
      this.document = { version: 1, records: [], groups: [] };
      return this.document;
    }
    this.missing = false;
    this.unreadable = false;
    try {
      const parsed = JSON.parse(raw) as Partial<SavedArtifactsDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unknown shape');
      if (repository) {
        parsed.records = parsed.records.map(record => ({ ...record, projectId: repository }));
        parsed.groups = (Array.isArray(parsed.groups) ? parsed.groups : []).map(group => ({ ...group, projectId: repository }));
      }
      this.document = {
        version: 1,
        records: parsed.records.filter(
          (record): record is SavedArtifactRecord =>
            typeof record?.projectId === 'string' && typeof record.path === 'string' && typeof record.savedAt === 'string'
        ),
        groups: (Array.isArray(parsed.groups) ? parsed.groups : []).filter(
          (group): group is ArtifactGroup =>
            typeof group?.id === 'string' && typeof group.projectId === 'string' && typeof group.name === 'string' &&
            Array.isArray(group.paths) && group.paths.every(path => typeof path === 'string')
        )
      };
    } catch {
      // Keep reading as empty, but refuse to write over a file we don't understand.
      this.unreadable = true;
      this.document = { version: 1, records: [], groups: [] };
    }
    return this.document;
  }
}

/**
 * The committed form: no install-local project ids, and a stable order so a
 * save changes only the lines it needs to and two saves rarely conflict.
 */
function forRepository(document: SavedArtifactsDocument): object {
  const strip = <T extends { projectId: string }>({ projectId: _projectId, ...rest }: T) => rest;
  return {
    $comment: REPOSITORY_NOTE,
    version: 1,
    records: [...document.records].sort((a, b) => a.path.localeCompare(b.path)).map(strip),
    groups: [...document.groups].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(strip)
  };
}

/** Takes `paths` out of every group in the project except `keep`, dropping groups left empty. */
function withoutPaths(groups: ArtifactGroup[], projectId: string, paths: ReadonlySet<string>, keep: string | undefined): ArtifactGroup[] {
  return groups
    .map(group => group.projectId === projectId && group.id !== keep
      ? { ...group, paths: group.paths.filter(path => !paths.has(path)) }
      : group)
    .filter(group => group.paths.length > 0);
}
