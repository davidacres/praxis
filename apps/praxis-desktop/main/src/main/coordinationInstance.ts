import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoordinationCoverage, CoordinationGate, CoordinationState } from '@praxis/core';
import { ResilientCoordination, defaultCoordinationRoot } from './coordinationHost';

/**
 * This process's seat at the coordination broker (FX-BF-048 / TASK-393).
 *
 * Every agent session gets a gate; the gate registers the session on first use, asks the
 * broker before each write or shell command, and releases after. A turn that ends releases
 * whatever its tools still hold. Coverage is stated honestly: a gateway session's tools all
 * run through Praxis, so it is `enforced`; an ACP agent's own edit and shell tools do not,
 * so it is `cooperative` — Praxis gates only the writes the agent routes through it.
 */

let coordination: ResilientCoordination | undefined;
const registered = new Map<string, CoordinationCoverage>();
const worktreeOf = new Map<string, string>();
const repositoryOf = new Map<string, string>();
let heartbeat: NodeJS.Timeout | undefined;
const listeners = new Set<(state: CoordinationState) => void>();

export function getCoordination(): ResilientCoordination {
  if (!coordination) {
    coordination = new ResilientCoordination(defaultCoordinationRoot(), {
      onChange: state => {
        for (const listener of listeners) listener(state);
      }
    });
  }
  return coordination;
}

/** Called with the broker's state after each change this process applied (leader only). */
export function onCoordinationChanged(listener: (state: CoordinationState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The checkout a folder belongs to: its git top level, or the folder itself outside git. */
export function worktreeRoot(folder: string): string {
  const cached = worktreeOf.get(folder);
  if (cached) return cached;
  let root = folder;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || folder;
  } catch {
    /* not a repository */
  }
  try {
    root = fs.realpathSync(root);
  } catch {
    /* keep it as given */
  }
  worktreeOf.set(folder, root);
  return root;
}

/** The repository a checkout belongs to — its canonical git common directory — which scopes who sees what. */
export function repositoryScope(worktree: string): string {
  const cached = repositoryOf.get(worktree);
  if (cached) return cached;
  let scope = worktree;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) scope = fs.realpathSync(common);
  } catch {
    /* not a repository: the folder is its own scope */
  }
  repositoryOf.set(worktree, scope);
  return scope;
}

export async function ensureRegistered(sessionKey: string, coverage: CoordinationCoverage, worktree: string): Promise<void> {
  if (registered.get(sessionKey) === coverage) return;
  const result = await getCoordination().send({
    kind: 'register',
    session: { sessionKey, runtime: coverage === 'enforced' ? 'gateway' : 'acp', coverage, worktree, scope: repositoryScope(worktree) }
  });
  if (result.ok) registered.set(sessionKey, coverage);
  ensureHeartbeat();
}

function ensureHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const sessionKey of registered.keys()) void getCoordination().send({ kind: 'heartbeat', sessionKey });
  }, 15_000);
  heartbeat.unref?.();
}

/** The gate for one agent session's side effects. */
export function coordinationGateFor(sessionKey: string, workingDirectory: string, coverage: CoordinationCoverage): CoordinationGate | undefined {
  if (process.env.PRAXIS_COORDINATION === 'off' || !workingDirectory) return undefined;
  const worktree = worktreeRoot(path.resolve(workingDirectory));
  return {
    worktree,
    acquire: async input => {
      await ensureRegistered(sessionKey, coverage, worktree);
      const requestId = input.requestId ?? randomUUID();
      const owner = { sessionKey };
      const result = await getCoordination().send({
        kind: 'acquire',
        requestId,
        owner,
        items: input.items,
        reason: input.reason,
        lifetime: input.lifetime ?? 'tool',
        // A tool call answers at once rather than sleeping inside the agent's turn.
        wait: false
      });
      if (!result.ok) return { ok: false, reason: result.error };
      const acquire = result.acquire;
      if (acquire?.status !== 'granted') return { ok: false, reason: acquire?.status === 'blocked' ? acquire.reason : 'The resource is busy.' };
      return { ok: true, release: async () => void (await getCoordination().send({ kind: 'release', owner, requestId })) };
    }
  };
}

/**
 * Holds the in-app browser for a session's whole sequence of browser calls. The claim is a
 * `sequence` claim keyed to the session, so repeated calls reuse it and the turn ending
 * releases it. Registered as cooperative: the browser is Praxis's, but the agent is not.
 */
export async function holdBrowserForSequence(sessionKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (process.env.PRAXIS_COORDINATION === 'off') return { ok: true };
  if (!registered.has(sessionKey)) {
    const result = await getCoordination().send({ kind: 'register', session: { sessionKey, runtime: 'acp', coverage: 'cooperative' } });
    if (result.ok) registered.set(sessionKey, 'cooperative');
    ensureHeartbeat();
  }
  const result = await getCoordination().send({
    kind: 'acquire',
    requestId: `${sessionKey}:browser`,
    owner: { sessionKey },
    items: [{ resource: { kind: 'browser', surface: 'in-app' }, mode: 'exclusive' }],
    reason: 'driving the in-app browser',
    lifetime: 'sequence',
    wait: false
  });
  if (!result.ok) return { ok: false, reason: result.error };
  if (result.acquire?.status === 'granted') return { ok: true };
  return { ok: false, reason: `Not done: ${result.acquire?.status === 'blocked' ? result.acquire.reason : 'the in-app browser is busy.'} Do something else, or try again after the other session finishes; do not retry in a loop.` };
}

/** A session's turn ended: release what its tools still hold and mark it idle. */
export function endCoordinatedTurn(sessionKey: string): void {
  if (!registered.has(sessionKey)) return;
  void getCoordination().send({ kind: 'end-turn', owner: { sessionKey } });
}

/** A session was deleted: it leaves the broker (an executing claim waits for recovery). */
export function endCoordinatedSession(sessionKey: string): void {
  if (!registered.has(sessionKey)) return;
  registered.delete(sessionKey);
  void getCoordination().send({ kind: 'end-session', sessionKey });
}

export async function disposeCoordination(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  for (const sessionKey of registered.keys()) await getCoordination().send({ kind: 'end-turn', owner: { sessionKey } }).catch(() => undefined);
  await coordination?.close();
  coordination = undefined;
  registered.clear();
}
