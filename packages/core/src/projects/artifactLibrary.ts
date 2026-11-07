/**
 * The project's artifact library: what the Artifacts page lists.
 *
 * The artifacts folder on disk is the source of truth — anything in it is
 * listed, including files added by hand. A saved-artifact record only adds what
 * a bare file cannot say: its title, description and the session that made it.
 * A record whose file has gone is simply not shown.
 *
 * No Node imports, so the renderer can share these types.
 */

/** What "Save" remembers about a file it published. */
export interface SavedArtifactRecord {
  projectId: string;
  /** Repository-relative, POSIX — the same form as `savedPath`. */
  path: string;
  title?: string;
  description?: string;
  mediaType?: string;
  /** The session the artifact was saved from. */
  sessionKey?: string;
  sessionTitle?: string;
  /** ISO timestamp of the latest save. */
  savedAt: string;
}

/** One file in the artifacts folder, as found on disk. */
export interface ArtifactsFolderEntry {
  /** Repository-relative, POSIX. */
  path: string;
  name: string;
  sizeBytes: number;
  /** ISO timestamp. */
  modifiedAt: string;
  /** An HTML page's own `<title>`, when it has one. */
  documentTitle?: string;
}

/**
 * Artifacts the user dragged together. A file belongs to at most one group;
 * a group never owns its files — ungrouping or deleting a group leaves them.
 */
export interface ArtifactGroup {
  id: string;
  projectId: string;
  name: string;
  /** Repository-relative paths, in the order they were added. */
  paths: string[];
  createdAt: string;
}

export type ArtifactLibraryKind = 'image' | 'page' | 'document' | 'data' | 'other';

export interface ArtifactLibraryItem extends ArtifactsFolderEntry {
  kind: ArtifactLibraryKind;
  /** The record's title, else the file name. */
  title: string;
  description?: string;
  mediaType?: string;
  sessionKey?: string;
  sessionTitle?: string;
  /** When it was saved through Praxis; absent for files added by hand. */
  savedAt?: string;
}

export interface ArtifactLibrary {
  /** False when the project has no folder to publish into. */
  available: boolean;
  /** Repository-relative artifacts folder. */
  folder: string;
  /** Absolute repository root the folder resolves against. */
  root?: string;
  items: ArtifactLibraryItem[];
  /** Only groups with at least one file still present, holding only those files. */
  groups: ArtifactGroup[];
  /** More files existed than the listing returns. */
  truncated: boolean;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const PAGE_EXTENSIONS = new Set(['html', 'htm']);
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'log', 'patch', 'diff', 'pdf', 'rtf']);
const DATA_EXTENSIONS = new Set(['json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'toml']);

export function artifactKindOf(path: string, mediaType?: string): ArtifactLibraryKind {
  const extension = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase() ?? '';
  const type = mediaType?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(extension) || type.startsWith('image/')) return 'image';
  if (PAGE_EXTENSIONS.has(extension) || type === 'text/html') return 'page';
  if (DOCUMENT_EXTENSIONS.has(extension) || type === 'text/markdown' || type === 'text/plain') return 'document';
  if (DATA_EXTENSIONS.has(extension) || type === 'application/json') return 'data';
  return 'other';
}

/**
 * Joins the folder listing with what Save recorded, newest first. Files added
 * by hand sort by their modification time; saved files by when they were saved.
 */
export function buildArtifactLibraryItems(
  entries: readonly ArtifactsFolderEntry[],
  records: readonly SavedArtifactRecord[]
): ArtifactLibraryItem[] {
  const byPath = new Map(records.map(record => [record.path, record]));
  return entries
    .map(entry => {
      const record = byPath.get(entry.path);
      const kind = artifactKindOf(entry.path, record?.mediaType);
      // A page is named by its own <title>: that is what it calls itself.
      const pageTitle = kind === 'page' ? entry.documentTitle?.trim() : undefined;
      const item: ArtifactLibraryItem = {
        ...entry,
        kind,
        title: pageTitle || record?.title?.trim() || entry.name
      };
      if (record?.description) item.description = record.description;
      if (record?.mediaType) item.mediaType = record.mediaType;
      if (record?.sessionKey) item.sessionKey = record.sessionKey;
      if (record?.sessionTitle) item.sessionTitle = record.sessionTitle;
      if (record?.savedAt) item.savedAt = record.savedAt;
      return item;
    })
    .sort((a, b) => (b.savedAt ?? b.modifiedAt).localeCompare(a.savedAt ?? a.modifiedAt) || a.path.localeCompare(b.path));
}

/**
 * True when `path` names a file inside `folder` (both repository-relative).
 * Every library read and delete checks this before touching the disk, so the
 * page can never reach a file outside the artifacts folder.
 */
export function isInsideArtifactsFolder(folder: string, path: string): boolean {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  return path.startsWith(`${folder}/`);
}

/** Drops paths whose file is gone, then groups left empty. */
export function visibleArtifactGroups(groups: readonly ArtifactGroup[], existingPaths: ReadonlySet<string>): ArtifactGroup[] {
  return groups
    .map(group => ({ ...group, paths: group.paths.filter(path => existingPaths.has(path)) }))
    .filter(group => group.paths.length > 0);
}

/** The text inside an HTML document's first `<title>`, with entities decoded and space collapsed. */
export function htmlDocumentTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return undefined;
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const text = match[1]
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] === '#') {
        const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : entity;
      }
      return named[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 300) : undefined;
}
