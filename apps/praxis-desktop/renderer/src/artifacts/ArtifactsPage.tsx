import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, ArtifactGroup, ArtifactLibrary, ArtifactLibraryItem, ArtifactLibraryKind, ProjectRecord } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { useDialogs } from '../ui/dialogs';
import { relativeTime } from '../app/sessionRecency';
import { sessionTitle } from '../ai/sessionNav';
import { ArtifactPreview } from '../ai/artifactWorkspace/ArtifactPreview';
import { ArtifactCodeSurface } from '../ai/artifactWorkspace/ArtifactCodeSurface';
import type { ActiveArtifact } from '../ai/artifactWorkspace/artifactTypes';
import { ArtifactSendDialog } from './ArtifactSendDialog';
import type { ArtifactSendTarget } from './artifactReference';

type KindFilter = 'all' | ArtifactLibraryKind;

const KIND_ICONS: Record<ArtifactLibraryKind, IconName> = {
  image: 'eye',
  page: 'globe',
  document: 'file',
  data: 'columns',
  other: 'package'
};

/** Icon-only type filters: the label is the button's name (and so its tooltip); `noun` reads in "Showing …". */
const FILTERS: Array<{ id: KindFilter; label: string; noun: string; icon: IconName }> = [
  { id: 'all', label: 'All', noun: 'artifacts', icon: 'layers' },
  { id: 'page', label: 'Pages', noun: 'pages', icon: KIND_ICONS.page },
  { id: 'image', label: 'Images', noun: 'images', icon: KIND_ICONS.image },
  { id: 'document', label: 'Documents', noun: 'documents', icon: KIND_ICONS.document },
  { id: 'data', label: 'Data', noun: 'data files', icon: KIND_ICONS.data },
  { id: 'other', label: 'Other', noun: 'other files', icon: KIND_ICONS.other }
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(path: string): string {
  const extension = path.split('.').pop();
  return extension && extension !== path ? extension.toUpperCase() : 'FILE';
}

/** Strips Electron's "Error invoking remote method …" wrapper from an IPC failure. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/**
 * Every artifact saved for a project, in one place.
 *
 * Lists the project's artifacts folder in its main checkout — what "Save"
 * writes into — so anything saved from a chat, and anything added by hand,
 * shows here. Selecting one opens it beside the grid.
 */
export function ArtifactsPage({
  project,
  sessions,
  onOpenSession,
  onNewSession
}: {
  project: ProjectRecord;
  sessions: AgentSessionRecord[];
  onOpenSession: (sessionKey: string) => void;
  /** Opens the New Session composer for this project (an artifact may be waiting there as a chip). */
  onNewSession: (projectId: string) => void;
}) {
  const { confirm } = useDialogs();
  const [library, setLibrary] = useState<ArtifactLibrary>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [filter, setFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>();
  const [openGroupId, setOpenGroupId] = useState<string>();
  const [sending, setSending] = useState<ArtifactSendTarget>();
  const [dragPath, setDragPath] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setLibrary(await window.praxis.artifacts.list(project.id));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
    return window.praxis.artifacts.onChanged(projectId => {
      if (projectId === project.id) void reload();
    });
  }, [project.id, reload]);

  const byPath = useMemo(() => new Map((library?.items ?? []).map(item => [item.path, item])), [library]);
  const groups = library?.groups ?? [];
  const groupOf = useMemo(() => {
    const map = new Map<string, ArtifactGroup>();
    for (const group of groups) for (const path of group.paths) map.set(path, group);
    return map;
  }, [groups]);
  const openGroup = groups.find(group => group.id === openGroupId);
  const groupItems = (group: ArtifactGroup) => group.paths.map(path => byPath.get(path)).filter((item): item is ArtifactLibraryItem => Boolean(item));

  // A filter or search lists every match flat, so nothing is hidden inside a group.
  const searching = filter !== 'all' || query.trim() !== '';
  const matches = useCallback((item: ArtifactLibraryItem) => {
    const needle = query.trim().toLowerCase();
    return (filter === 'all' || item.kind === filter) &&
      (!needle || [item.title, item.name, item.path, item.description, item.sessionTitle].some(value => value?.toLowerCase().includes(needle)));
  }, [filter, query]);
  const items = useMemo(() => {
    const all = library?.items ?? [];
    if (openGroup) return groupItems(openGroup).filter(matches);
    if (searching) return all.filter(matches);
    return all.filter(item => !groupOf.has(item.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, openGroup, searching, matches, groupOf]);
  const visibleGroups = openGroup || searching ? [] : groups;

  const counts = useMemo(() => {
    const result: Partial<Record<KindFilter, number>> = { all: library?.items.length ?? 0 };
    for (const item of library?.items ?? []) result[item.kind] = (result[item.kind] ?? 0) + 1;
    return result;
  }, [library]);

  const selected = library?.items.find(item => item.path === selectedPath);
  const sessionKeys = useMemo(() => new Set(sessions.map(session => session.issueKey)), [sessions]);
  const sessionLabel = (item: ArtifactLibraryItem) => {
    const live = item.sessionKey ? sessions.find(session => session.issueKey === item.sessionKey) : undefined;
    return live ? sessionTitle(live) : item.sessionTitle;
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      setActionError(undefined);
      await action();
      await reload();
    } catch (error) {
      setActionError(messageOf(error));
    }
  };

  const deleteItem = async (item: ArtifactLibraryItem) => {
    const ok = await confirm({
      title: `Delete ${item.name}?`,
      message: 'The file is removed from the project\u2019s artifacts folder. If it is committed, git can still restore it.',
      details: [item.path],
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    if (selectedPath === item.path) setSelectedPath(undefined);
    await run(() => window.praxis.artifacts.delete(project.id, item.path));
  };

  /** Dropping one card on another makes a group of the two; dropping on a group adds to it. */
  const dropOn = async (target: { path?: string; groupId?: string }) => {
    const dragged = dragPath;
    setDragPath(undefined);
    setDropTarget(undefined);
    if (!dragged) return;
    if (target.groupId) {
      const group = groups.find(candidate => candidate.id === target.groupId);
      if (!group || group.paths.includes(dragged)) return;
      await run(() => window.praxis.artifacts.updateGroup(project.id, group.id, { paths: [...group.paths, dragged] }));
      return;
    }
    if (!target.path || target.path === dragged) return;
    const existing = groupOf.get(target.path);
    if (existing) {
      if (existing.paths.includes(dragged)) return;
      await run(() => window.praxis.artifacts.updateGroup(project.id, existing.id, { paths: [...existing.paths, dragged] }));
      return;
    }
    await run(() => window.praxis.artifacts.createGroup(project.id, nextGroupName(groups), [target.path!, dragged]));
  };

  const dropProps = (key: string, target: { path?: string; groupId?: string }) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragPath || target.path === dragPath) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTarget !== key) setDropTarget(key);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropTarget === key) setDropTarget(undefined);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      void dropOn(target);
    }
  });

  if (loadError && !library) {
    return (
      <div className="empty-state" data-testid="artifacts-error">
        <Icon name="warning" size={28} />
        <span>Artifacts could not be listed.</span>
        <p>{loadError}</p>
        <button className="btn" type="button" onClick={() => void reload()}>Try again</button>
      </div>
    );
  }
  if (!library) {
    return (
      <div className="empty-state" data-testid="artifacts-loading">
        <Icon name="layers" size={28} />
        <span>Loading artifacts…</span>
      </div>
    );
  }

  return (
    <div className={`artifacts-page${selected ? ' has-selection' : ''}`} data-testid="artifacts-page">
      <div className="artifacts-browser">
        <header className="artifacts-header">
          {openGroup ? (
            <GroupHeader
              key={openGroup.id}
              group={openGroup}
              onBack={() => setOpenGroupId(undefined)}
              onRename={name => run(() => window.praxis.artifacts.updateGroup(project.id, openGroup.id, { name }))}
              onAddToChat={() => setSending({ kind: 'group', groupId: openGroup.id, name: openGroup.name, items: groupItems(openGroup) })}
              onUngroup={() => {
                setOpenGroupId(undefined);
                void run(() => window.praxis.artifacts.deleteGroup(project.id, openGroup.id));
              }}
            />
          ) : (
            <div className="artifacts-heading">
              <h1>Artifacts</h1>
              <span className="artifacts-subtitle" data-testid="artifacts-folder">
                {project.name} · <code>{library.folder}</code>
              </span>
            </div>
          )}
          <label className="artifacts-search">
            <Icon name="search" size={13} />
            <input
              className="input"
              type="search"
              placeholder="Search artifacts"
              aria-label="Search artifacts"
              data-testid="artifacts-search"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        </header>

        <div className="artifacts-toolbar">
          <div className="artifacts-filters" role="tablist" aria-label="Artifact type">
            {FILTERS.filter(option => option.id === 'all' || counts[option.id]).map(option => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={filter === option.id}
                aria-label={`${option.label} (${counts[option.id] ?? 0})`}
                className={`artifacts-filter${filter === option.id ? ' active' : ''}`}
                data-testid={`artifacts-filter-${option.id}`}
                onClick={() => setFilter(option.id)}
              >
                <Icon name={option.icon} size={15} />
                <span className="artifacts-filter-count" aria-hidden="true">{counts[option.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <span className="artifacts-showing" data-testid="artifacts-showing">
            Showing <strong>{filter === 'all' ? `all ${counts.all ?? 0}` : counts[filter] ?? 0}</strong> {FILTERS.find(option => option.id === filter)?.noun}
          </span>
          {!openGroup && !searching && library.items.length > 1 && (
            <span className="artifacts-hint muted">Drag one artifact onto another to group them</span>
          )}
        </div>
        {actionError && <p className="artifacts-action-error" role="alert">{actionError}</p>}

        {!library.available ? (
          <div className="empty-state artifacts-empty" data-testid="artifacts-unavailable">
            <Icon name="folder" size={28} />
            <span>This project has no folder yet.</span>
            <p>Artifacts are saved into the project&rsquo;s repository. Attach a folder to the project to start collecting them.</p>
          </div>
        ) : library.items.length === 0 ? (
          <div className="empty-state artifacts-empty" data-testid="artifacts-empty">
            <Icon name="layers" size={28} />
            <span>No saved artifacts yet.</span>
            <p>Use <strong>Save</strong> on an artifact or screenshot in a chat and it will appear here.</p>
          </div>
        ) : items.length === 0 && visibleGroups.length === 0 ? (
          <div className="empty-state artifacts-empty" data-testid="artifacts-no-match">
            <Icon name="search" size={28} />
            <span>No artifacts match.</span>
          </div>
        ) : (
          <ul className="artifacts-grid" data-testid="artifacts-grid">
            {visibleGroups.map(group => {
              const members = groupItems(group);
              const key = `group:${group.id}`;
              return (
                <li
                  key={key}
                  className={`artifact-card-wrap${dropTarget === key ? ' is-drop-target' : ''}`}
                  data-testid="artifact-group-card"
                  {...dropProps(key, { groupId: group.id })}
                >
                  <button type="button" className="artifact-card artifact-group" onClick={() => setOpenGroupId(group.id)}>
                    <ArtifactThumbnail projectId={project.id} item={members[0]} stacked={Math.min(members.length - 1, 2)} />
                    <CardFooter
                      icon="folder"
                      title={group.name}
                      titleTestId="artifact-group-name"
                      meta={`${members.length} ${members.length === 1 ? 'artifact' : 'artifacts'}`}
                    />
                  </button>
                  <div className="artifact-card-actions">
                    <button type="button" className="artifact-card-action" aria-label={`Add ${group.name} to chat`} data-testid="artifact-group-add-to-chat"
                      onClick={() => setSending({ kind: 'group', groupId: group.id, name: group.name, items: members })}>
                      <Icon name="chats" size={13} />
                    </button>
                    <button type="button" className="artifact-card-action" aria-label={`Ungroup ${group.name}`} data-testid="artifact-group-ungroup"
                      onClick={() => void run(() => window.praxis.artifacts.deleteGroup(project.id, group.id))}>
                      <Icon name="columns" size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
            {items.map(item => {
              const key = `item:${item.path}`;
              return (
                <li
                  key={key}
                  className={`artifact-card-wrap${dropTarget === key ? ' is-drop-target' : ''}${dragPath === item.path ? ' is-dragging' : ''}`}
                  data-testid="artifact-card-item"
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.setData('application/x-praxis-artifact', item.path);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragPath(item.path);
                  }}
                  onDragEnd={() => {
                    setDragPath(undefined);
                    setDropTarget(undefined);
                  }}
                  {...dropProps(key, { path: item.path })}
                >
                  <button
                    type="button"
                    className={`artifact-card${item.path === selectedPath ? ' selected' : ''}`}
                    data-testid="artifact-card"
                    aria-pressed={item.path === selectedPath}
                    onClick={() => setSelectedPath(current => (current === item.path ? undefined : item.path))}
                  >
                    <ArtifactThumbnail projectId={project.id} item={item} />
                    <CardFooter
                      icon={KIND_ICONS[item.kind]}
                      title={item.title}
                      titleTestId="artifact-card-title"
                      meta={[ageLabel(item), sessionLabel(item)].filter(Boolean).join(' · ')}
                    />
                  </button>
                  <div className="artifact-card-actions">
                    <button type="button" className="artifact-card-action" aria-label={`Add ${item.title} to chat`} data-testid="artifact-card-add-to-chat"
                      onClick={() => setSending({ kind: 'artifact', item })}>
                      <Icon name="chats" size={13} />
                    </button>
                    <button type="button" className="artifact-card-action" aria-label={`Show ${item.title} in folder`} data-testid="artifact-card-reveal"
                      onClick={() => void window.praxis.artifacts.reveal(project.id, item.path).catch(error => setActionError(messageOf(error)))}>
                      <Icon name="folder-open" size={13} />
                    </button>
                    {openGroup && (
                      <button type="button" className="artifact-card-action" aria-label={`Remove ${item.title} from ${openGroup.name}`} data-testid="artifact-card-ungroup"
                        onClick={() => void run(() => window.praxis.artifacts.updateGroup(project.id, openGroup.id, { paths: openGroup.paths.filter(path => path !== item.path) }))}>
                        <Icon name="minus" size={13} />
                      </button>
                    )}
                    <button type="button" className="artifact-card-action is-danger" aria-label={`Delete ${item.title}`} data-testid="artifact-card-delete"
                      onClick={() => void deleteItem(item)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {library.truncated && (
          <p className="artifacts-truncated muted">Showing the first {library.items.length} files.</p>
        )}
      </div>

      {selected && (
        <ArtifactViewer
          key={selected.path}
          projectId={project.id}
          item={selected}
          sessionLabel={sessionLabel(selected)}
          sessionAvailable={Boolean(selected.sessionKey && sessionKeys.has(selected.sessionKey))}
          onOpenSession={onOpenSession}
          onAddToChat={() => setSending({ kind: 'artifact', item: selected })}
          onClose={() => setSelectedPath(undefined)}
          onDeleted={() => {
            setSelectedPath(undefined);
            void reload();
          }}
        />
      )}

      {sending && (
        <ArtifactSendDialog
          projectId={project.id}
          root={library.root}
          target={sending}
          sessions={sessions}
          onClose={() => setSending(undefined)}
          onOpenSession={onOpenSession}
          onNewSession={onNewSession}
        />
      )}
    </div>
  );
}

function nextGroupName(groups: readonly ArtifactGroup[]): string {
  const taken = new Set(groups.map(group => group.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'New group' : `New group ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** The open group's breadcrumb, with its name editable in place. */
function GroupHeader({
  group,
  onBack,
  onRename,
  onAddToChat,
  onUngroup
}: {
  group: ArtifactGroup;
  onBack: () => void;
  onRename: (name: string) => Promise<void>;
  onAddToChat: () => void;
  onUngroup: () => void;
}) {
  const [name, setName] = useState(group.name);
  const commit = () => {
    const next = name.replace(/\s+/g, ' ').trim();
    if (!next) { setName(group.name); return; }
    if (next !== group.name) void onRename(next);
  };
  return (
    <div className="artifacts-heading artifacts-group-heading" data-testid="artifacts-group-view">
      <button type="button" className="artifacts-back" data-testid="artifacts-group-back" onClick={onBack}>
        <Icon name="arrow-left" size={12} />
        <span>Artifacts</span>
      </button>
      <div className="artifacts-group-title">
        <input
          className="artifacts-group-name"
          aria-label="Group name"
          data-testid="artifacts-group-name"
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') { setName(group.name); event.currentTarget.blur(); }
          }}
        />
        <button type="button" className="btn btn-sm btn-quiet" data-testid="artifacts-group-add-to-chat" onClick={onAddToChat}>
          <Icon name="chats" size={12} />
          <span>Add group to chat</span>
        </button>
        <button type="button" className="btn btn-sm btn-quiet" data-testid="artifacts-group-ungroup" onClick={onUngroup}>
          <Icon name="columns" size={12} />
          <span>Ungroup</span>
        </button>
      </div>
    </div>
  );
}

/** "Saved 23m ago", "Saved just now", or "Modified …" for a file added by hand. */
function ageLabel(item: ArtifactLibraryItem): string {
  const age = relativeTime(item.savedAt ?? item.modifiedAt);
  if (!age) return item.savedAt ? 'Saved' : 'Modified';
  return `${item.savedAt ? 'Saved' : 'Modified'} ${age === 'now' ? 'just now' : age}`;
}

function CardFooter({ icon, title, titleTestId, meta }: { icon: IconName; title: string; titleTestId: string; meta: string }) {
  return (
    <span className="artifact-card-footer">
      <span className="artifact-card-icon" aria-hidden="true"><Icon name={icon} size={13} /></span>
      <span className="artifact-card-body">
        <span className="artifact-card-title" data-testid={titleTestId} title={title}>{title}</span>
        <span className="artifact-card-meta" title={meta}>{meta}</span>
      </span>
    </span>
  );
}

/** How much of a document the sheet shows — a screenful at thumbnail scale. */
const SHEET_TEXT_CHARS = 1600;

/**
 * The top of a card: the artifact drawn as a sheet of paper inset in a tinted
 * frame, running off the bottom edge. The sheet shows a picture's own image, a
 * rendered snapshot of a page, or a document's opening lines. A group draws
 * its first artifact with blank sheets stacked behind.
 *
 * Content is fetched once the card scrolls into view; a page's first snapshot
 * takes a moment to render and is cached after that.
 */
function ArtifactThumbnail({ projectId, item, stacked = 0 }: { projectId: string; item: ArtifactLibraryItem; stacked?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string>();
  const [text, setText] = useState<string>();
  const [rendering, setRendering] = useState(false);
  const raster = item.kind === 'image' && !/\.svg$/i.test(item.path);
  const page = item.kind === 'page';
  const readable = item.kind === 'document' || item.kind === 'data';

  useEffect(() => {
    if ((!raster && !page && !readable) || !ref.current) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      if (readable) {
        void window.praxis.artifacts.readText(projectId, item.path)
          .then(body => { if (!cancelled) setText(body.slice(0, SHEET_TEXT_CHARS)); })
          .catch(() => undefined);
        return;
      }
      setRendering(page);
      const load = raster
        ? window.praxis.artifacts.loadImage(projectId, item.path)
        : window.praxis.artifacts.pageThumbnail(projectId, item.path);
      void load
        .then(url => { if (!cancelled) setSrc(url); })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setRendering(false); });
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [projectId, item.path, raster, page, readable]);

  const markdown = /\.(?:md|markdown)$/i.test(item.path);
  return (
    <span
      ref={ref}
      className={`artifact-card-thumb kind-${item.kind}${stacked ? ' is-stack' : ''}${rendering ? ' is-rendering' : ''}`}
      data-testid="artifact-card-thumb"
    >
      {Array.from({ length: stacked }, (_, index) => (
        <span key={index} className={`artifact-sheet is-behind behind-${stacked - index}`} aria-hidden="true" />
      ))}
      <span className={`artifact-sheet${src ? ' has-image' : ''}${text !== undefined ? ' has-text' : ''}`} data-testid="artifact-sheet">
        {src ? (
          <img src={src} alt="" data-testid={page ? 'artifact-card-page-thumb' : undefined} />
        ) : text !== undefined ? (
          // Laid out at twice the size and scaled down, so it reads as a miniature page.
          // Inert: a link in the miniature must not be a second tab stop inside the card.
          <span className="artifact-sheet-text" data-testid="artifact-sheet-text" aria-hidden="true" {...{ inert: '' }}>
            {markdown ? <Markdown text={text} /> : <pre>{text}</pre>}
          </span>
        ) : (
          <span className="artifact-card-type">
            <Icon name={KIND_ICONS[item.kind]} size={18} />
            <span>{extensionOf(item.path)}</span>
          </span>
        )}
      </span>
    </span>
  );
}

function ArtifactViewer({
  projectId,
  item,
  sessionLabel,
  sessionAvailable,
  onOpenSession,
  onAddToChat,
  onClose,
  onDeleted
}: {
  projectId: string;
  item: ArtifactLibraryItem;
  sessionLabel?: string;
  sessionAvailable: boolean;
  onOpenSession: (sessionKey: string) => void;
  onAddToChat: () => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { confirm } = useDialogs();
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const isPicture = item.kind === 'image' && !/\.svg$/i.test(item.path);
  const readable = !isPicture && item.kind !== 'other';

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    setLoading(true);
    window.praxis.artifacts.readText(projectId, item.path)
      .then(text => { if (!cancelled) setContent(text); })
      .catch(reason => { if (!cancelled) setError(messageOf(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [projectId, item.path, readable]);

  const artifact: ActiveArtifact = useMemo(() => ({
    name: item.name,
    path: item.path,
    ...(item.mediaType ? { mediaType: item.mediaType } : {}),
    ...(item.description ? { description: item.description } : {}),
    sizeBytes: item.sizeBytes
  }), [item]);
  const loadImage = useCallback((path: string) => window.praxis.artifacts.loadImage(projectId, path), [projectId]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(undefined), 2500);
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${item.name}?`,
      message: 'The file is removed from the project’s artifacts folder. If it is committed, git can still restore it.',
      details: [item.path],
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await window.praxis.artifacts.delete(projectId, item.path);
      onDeleted();
    } catch (reason) {
      setError(messageOf(reason));
    }
  };

  return (
    <aside className="artifacts-viewer" data-testid="artifacts-viewer" aria-label={item.title}>
      <header className="artifacts-viewer-header">
        <div className="artifacts-viewer-identity">
          <strong data-testid="artifacts-viewer-title" title={item.title}>{item.title}</strong>
          <span className="artifacts-viewer-meta">
            {formatSize(item.sizeBytes)} · {item.savedAt ? `saved ${relativeTime(item.savedAt)}` : `modified ${relativeTime(item.modifiedAt)}`}
          </span>
        </div>
        {readable && (
          <div className="artifacts-viewer-modes" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={mode === 'preview'} className={`btn-tab${mode === 'preview' ? ' active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
            <button type="button" role="tab" aria-selected={mode === 'code'} className={`btn-tab${mode === 'code' ? ' active' : ''}`} onClick={() => setMode('code')}>Source</button>
          </div>
        )}
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close artifact" data-testid="artifacts-viewer-close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </header>

      {item.description && <p className="artifacts-viewer-description">{item.description}</p>}

      <div className="artifacts-viewer-actions">
        <button type="button" className="btn btn-sm btn-primary" data-testid="artifacts-add-to-chat" onClick={onAddToChat}>
          <Icon name="chats" size={12} />
          <span>Add to chat</span>
        </button>
        {item.sessionKey && (
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            data-testid="artifacts-open-session"
            disabled={!sessionAvailable}
            title={sessionAvailable ? 'Open the session that saved this' : 'That session no longer exists'}
            onClick={() => item.sessionKey && onOpenSession(item.sessionKey)}
          >
            <Icon name="chats" size={12} />
            <span>{sessionLabel ?? 'Open session'}</span>
          </button>
        )}
        <button type="button" className="btn btn-sm btn-quiet" data-testid="artifacts-reveal" onClick={() => void window.praxis.artifacts.reveal(projectId, item.path).catch(reason => setError(messageOf(reason)))}>
          <Icon name="folder-open" size={12} />
          <span>Show in folder</span>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          data-testid="artifacts-copy-path"
          onClick={() => void navigator.clipboard.writeText(item.path).then(() => flash('Path copied'), () => undefined)}
        >
          <Icon name="copy" size={12} />
          <span>Copy path</span>
        </button>
        <button type="button" className="btn btn-sm btn-quiet artifacts-delete" data-testid="artifacts-delete" onClick={() => void remove()}>
          <Icon name="trash" size={12} />
          <span>Delete</span>
        </button>
        {notice && <span className="artifacts-viewer-notice" role="status">{notice}</span>}
      </div>

      <div className="artifacts-viewer-surface" data-testid="artifacts-viewer-surface">
        {error ? (
          <div className="artifact-dock-empty artifact-dock-unavailable" role="alert" data-testid="artifacts-viewer-error">
            <Icon name="warning" size={24} />
            <strong>This artifact can&rsquo;t be shown</strong>
            <span>{error}</span>
          </div>
        ) : loading ? (
          <div className="artifact-dock-loading">
            <Icon name="refresh" size={18} />
            <span>Loading…</span>
          </div>
        ) : item.kind === 'other' ? (
          <div className="artifact-dock-empty" data-testid="artifacts-viewer-no-preview">
            <Icon name="package" size={24} />
            <span>No preview for this kind of file.</span>
          </div>
        ) : mode === 'code' && readable ? (
          <ArtifactCodeSurface artifact={artifact} content={content} mode="code" />
        ) : (
          <ArtifactPreview artifact={artifact} content={content} loadImage={loadImage} />
        )}
      </div>
    </aside>
  );
}
