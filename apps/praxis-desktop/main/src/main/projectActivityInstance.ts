import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { GIT_ACTIVITY_LOG_FORMAT, mergeActivity, parseGitActivity, ProjectActivityStore } from '@praxis/core';
import type { AgentSessionRecord, IssueTrackerService, ProjectActivityActor, ProjectActivityEntry, ProjectRecord } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getProjectStore } from './projectStoreInstance';

let store: ProjectActivityStore | undefined;
function getStore(): ProjectActivityStore {
  return store ??= new ProjectActivityStore(new JsonKeyValueStore(path.join(app.getPath('userData'), 'project-activity.json')));
}
function record(input: Omit<ProjectActivityEntry, 'id' | 'timestamp'>): void {
  try {
    void getStore().append(input).catch(error => console.error('Could not save project activity:', error));
  } catch (error) {
    console.error('Could not initialize project activity:', error);
  }
}
/** Writes made inside `runAsAgent` are attributed to the agent; everything else reaching the service is the user's. */
const actorContext = new AsyncLocalStorage<ProjectActivityActor>();
export function runAsAgent<T>(work: () => Promise<T>): Promise<T> {
  return actorContext.run('agent', work);
}
const execFileAsync = promisify(execFile);
/** Commits are read from git on demand — git is their record — never copied into the store. */
async function commitActivity(project: ProjectRecord): Promise<ProjectActivityEntry[]> {
  const cwd = project.workspaceFolder;
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return [];
  try {
    const git = (...args: string[]) => execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout);
    const [log, email] = await Promise.all([
      git('log', '--since=30.days', '--max-count=500', `--format=${GIT_ACTIVITY_LOG_FORMAT}`),
      git('config', 'user.email').catch(() => '')
    ]);
    return parseGitActivity(log, project.id, email);
  } catch {
    return []; // An empty or unborn repository has no log; that is not an error for this view.
  }
}
export function registerProjectActivityIpc(): void {
  ipcMain.handle('activity:list', async (_event, projectId: string) => {
    const project = typeof projectId === 'string' ? getProjectStore().get(projectId) : undefined;
    if (!project) throw new Error('Project was not found.');
    const [snapshot, commits] = await Promise.all([getStore().open(projectId), commitActivity(project)]);
    return mergeActivity(snapshot, commits);
  });
}
const projectsFor = (connectionId: string) => getProjectStore().list().filter(candidate => connectionId === `project:${candidate.id}` || candidate.linkedBoards.some(board => board.connectionId === connectionId));
const lastPlanEvent = new Map<string, number>();
/** An edit to a plan file made outside Praxis (an editor, an agent CLI, a pull). The folder service has already filtered out its own writes. */
export function recordPlanActivity(connectionId: string, filePath: string): void {
  // Editors save in bursts; one entry per file per minute is what a person would call "an edit".
  const previous = lastPlanEvent.get(filePath) ?? 0;
  if (Date.now() - previous < 60_000) return;
  lastPlanEvent.set(filePath, Date.now());
  try {
    const exists = fs.existsSync(filePath);
    const heading = exists ? /^#\s+(.+)$/m.exec(fs.readFileSync(filePath, 'utf8').slice(0, 4096))?.[1]?.trim() : undefined;
    for (const project of projectsFor(connectionId)) {
      // Relative to docs/plans, the root the renderer's document reader resolves against.
      const relative = project.workspaceFolder ? path.relative(path.join(project.workspaceFolder, 'docs', 'plans'), filePath) : '';
      const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      record({ projectId: project.id, kind: 'plan', targetKey: inside ? relative.split(path.sep).join('/') : filePath, summary: heading || path.basename(filePath), action: exists ? 'Plan file edited' : 'Plan file removed', connectionId, actor: 'external' });
    }
  } catch (error) {
    console.error('Could not observe plan file change:', error);
  }
}
const sessions = new Map<string, string>();
export function recordSessionActivity(session: AgentSessionRecord): void {
  if (!session.projectId || !getProjectStore().get(session.projectId)) return;
  const previous = sessions.get(session.sessionId);
  sessions.set(session.sessionId, session.state);
  if (previous === session.state) return;
  record({ projectId: session.projectId, kind: 'session', targetKey: session.issueKey, summary: session.title || session.issueKey, action: `Session ${session.state.replaceAll('_', ' ')}`, actor: 'agent' });
}
const wrappers = new WeakMap<IssueTrackerService, Map<string, IssueTrackerService>>();
/** Wrap the service boundary so board, agent, mobile and workflow writes are observed alike. */
export function observeIssueService(service: IssueTrackerService, connectionId: string): IssueTrackerService {
  let connections = wrappers.get(service);
  if (!connections) { connections = new Map(); wrappers.set(service, connections); }
  const cached = connections.get(connectionId);
  if (cached) return cached;
  const actions: Record<string, string> = { createIssue: 'Created', updateIssue: 'Updated', deleteIssue: 'Deleted', transitionIssue: 'Status changed', addComment: 'Comment added' };
  const wrapped = new Proxy(service, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== 'function') return value;
    const action = actions[String(property)];
    if (!action) return value.bind(target);
    return async (...args: unknown[]) => {
      const existing = typeof args[0] === 'string' ? await target.getIssue(args[0]).catch(() => undefined) : undefined;
      const result = await value.apply(target, args);
      const issue = String(property) === 'createIssue' ? result : existing;
      try {
        if (issue) {
          const actor = actorContext.getStore() ?? 'you';
          for (const project of projectsFor(connectionId)) {
            record({ projectId: project.id, kind: 'issue', targetKey: issue.key, summary: issue.summary, action, connectionId, actor });
          }
        }
      } catch (error) {
        console.error('Could not observe successful issue mutation:', error);
      }
      return result;
    };
  } });
  connections.set(connectionId, wrapped);
  return wrapped;
}
