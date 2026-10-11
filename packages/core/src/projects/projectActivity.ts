import type { KeyValueStore } from '../host/stateStore';

/** Who made a change: the person at the keyboard, an agent acting for them, or someone/something outside Praxis. */
export type ProjectActivityActor = 'you' | 'agent' | 'external';
export interface ProjectActivityEntry {
  id: string;
  projectId: string;
  /** `plan` targets a project-relative file path; `commit` targets a full hash. */
  kind: 'issue' | 'session' | 'plan' | 'commit';
  targetKey: string;
  connectionId?: string;
  summary: string;
  action: string;
  timestamp: string;
  /** Absent on entries recorded before attribution existed; read those as `you`. */
  actor?: ProjectActivityActor;
  /** A commit author or other named source, shown in place of the generic actor label. */
  actorName?: string;
}
export interface ProjectActivitySnapshot { startedAt: string; entries: ProjectActivityEntry[] }
const DAY = 86_400_000;
/** Local observations only: importing existing work never fabricates past changes. */
export class ProjectActivityStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly state: KeyValueStore, private readonly now: () => number = Date.now) {}
  list(projectId: string): ProjectActivitySnapshot {
    const snapshot = this.state.get<ProjectActivitySnapshot>(`activity:${projectId}`);
    return { startedAt: snapshot?.startedAt ?? new Date(this.now()).toISOString(), entries: (snapshot?.entries ?? []).filter(entry => entry.projectId === projectId && Date.parse(entry.timestamp) >= this.now() - 30 * DAY).slice(-1000).reverse() };
  }
  open(projectId: string): Promise<ProjectActivitySnapshot> {
    const write = this.queue.then(async () => {
      const current = this.list(projectId);
      await this.state.update(`activity:${projectId}`, { ...current, entries: [...current.entries].reverse() });
      return current;
    });
    this.queue = write.then(() => undefined, () => undefined);
    return write;
  }
  append(input: Omit<ProjectActivityEntry, 'id' | 'timestamp'>): Promise<void> {
    const write = this.queue.then(async () => {
      const current = this.list(input.projectId);
      const timestamp = new Date(this.now()).toISOString();
      const entries = [...current.entries.reverse(), { ...input, timestamp, id: `${timestamp}:${Math.random().toString(36).slice(2)}` }].slice(-1000);
      await this.state.update(`activity:${input.projectId}`, { startedAt: current.startedAt, entries });
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}

/** Commits co-written by, or authored by, a coding agent. Matched on name or address, never on message prose. */
const AGENT_AUTHOR = /\b(claude|copilot|codex|gemini|cursor(?:agent)?|devin|aider)\b|noreply@anthropic\.com|openai\.com/i;
export const GIT_ACTIVITY_LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x2C)%x1e';
/**
 * Git is the record of commits, so they are read on demand rather than stored: `stdout` is
 * `git log --format=GIT_ACTIVITY_LOG_FORMAT`. A commit is `you` when its author address is the
 * repository's configured `user.email`, `agent` when an agent wrote or co-wrote it, else `external`.
 */
export function parseGitActivity(stdout: string, projectId: string, selfEmail?: string): ProjectActivityEntry[] {
  const self = selfEmail?.trim().toLowerCase();
  return stdout.split('\x1e').map(record => record.replace(/^\n+/, '')).filter(Boolean).flatMap(record => {
    const [hash, name = '', email = '', date = '', subject = '', coAuthors = ''] = record.split('\x1f');
    if (!/^[0-9a-f]{7,64}$/i.test(hash ?? '') || !Number.isFinite(Date.parse(date))) return [];
    const actor: ProjectActivityActor = AGENT_AUTHOR.test(`${name} ${email}`) || AGENT_AUTHOR.test(coAuthors) ? 'agent'
      : self && email.trim().toLowerCase() === self ? 'you' : 'external';
    return [{ id: `commit:${hash}`, projectId, kind: 'commit' as const, targetKey: hash, summary: subject.trim() || hash.slice(0, 7), action: 'Committed', timestamp: new Date(Date.parse(date)).toISOString(), actor, ...(actor === 'external' && name.trim() ? { actorName: name.trim() } : {}) }];
  });
}

/** Newest first; a stored entry and a derived one never collide because their ids are namespaced. */
export function mergeActivity(snapshot: ProjectActivitySnapshot, extra: ProjectActivityEntry[]): ProjectActivitySnapshot {
  if (!extra.length) return snapshot;
  return { ...snapshot, entries: [...snapshot.entries, ...extra].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)) };
}
