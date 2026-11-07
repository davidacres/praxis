import * as fs from 'node:fs';
import type { ArtifactGroup, SavedArtifactRecord } from '@praxis/core';

interface SavedArtifactsDocument {
  version: 1;
  records: SavedArtifactRecord[];
  /** Added later; absent in older files. */
  groups: ArtifactGroup[];
}

/**
 * What "Save" remembers about each artifact it published: title, description
 * and the session it came from. App-local (`userData`), never in the
 * repository, so two branches saving artifacts can't conflict over an index.
 *
 * The folder stays the source of truth; a record only adds details to a file
 * that exists. Writes are atomic (temp file + rename) and run one at a time.
 * A file that cannot be parsed is left untouched rather than overwritten.
 *
 * No Electron imports, so it is unit-testable under plain Node.
 */
export class SavedArtifactStore {
  private document: SavedArtifactsDocument | undefined;
  private unreadable = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

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
      await fs.promises.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await fs.promises.rename(temp, this.filePath);
      this.document = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<SavedArtifactsDocument> {
    if (this.document) return this.document;
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.document = { version: 1, records: [], groups: [] };
      return this.document;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SavedArtifactsDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unknown shape');
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

/** Takes `paths` out of every group in the project except `keep`, dropping groups left empty. */
function withoutPaths(groups: ArtifactGroup[], projectId: string, paths: ReadonlySet<string>, keep: string | undefined): ArtifactGroup[] {
  return groups
    .map(group => group.projectId === projectId && group.id !== keep
      ? { ...group, paths: group.paths.filter(path => !paths.has(path)) }
      : group)
    .filter(group => group.paths.length > 0);
}
