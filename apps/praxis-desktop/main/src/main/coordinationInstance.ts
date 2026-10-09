import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeResource, stopAllServices, type CoordinationBlocker, type CoordinationCoverage, type CoordinationGate, type CoordinationRequestItem, type CoordinationState, type GateDecision } from '@praxis/core';
import { ResilientCoordination, defaultCoordinationRoot } from './coordinationHost';

/**
 * This process's seat at the coordination broker (FX-BF-048 / TASK-393).
 *
 * Every agent session gets a gate; the gate registers the session on first use, asks the
 * broker before each write or shell command, and releases after. A turn that ends releases
 * whatever its tools still hold. Coverage is stated honestly: a gateway session's tools all
 * run through Praxis, so it is `enforced`; an ACP agent's own edit and shell tools do not,
 * so it is `cooperative` — Praxis gates only the writes the agent routes through it.
 *
 * Before each side effect the gate also checks the checkout has not moved under the session
 * (another branch, another HEAD) since it last acted: a move it did not make itself means
 * what it read may be stale, so the first write after one is refused with what changed.
 */

let coordination: ResilientCoordination | undefined;
const registered = new Map<string, CoordinationCoverage>();
const worktreeOf = new Map<string, string>();
const repositoryOf = new Map<string, string>();
let heartbeat: NodeJS.Timeout | undefined;
/** Bumped when a session's turn ends, so a wait from that turn stops instead of granting late. */
const turnEpoch = new Map<string, number>();
/** The checkout each session last acted on: branch and HEAD. */
const lastCheckout = new Map<string, CheckoutIdentity>();

/** This app instance's own live surfaces: another instance's browser is a different one. */
export const BROWSER_SURFACE = `in-app:${process.pid}`;
export const APP_INSTANCE = `praxis:${process.pid}`;
const PERSON_SESSION = `person:${process.pid}`;
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

export interface CheckoutIdentity {
  branch: string;
  head: string;
}

/** The branch (or `HEAD` when detached) and commit a worktree is on; undefined outside git or before a first commit. */
export function checkoutIdentity(worktree: string): CheckoutIdentity | undefined {
  try {
    // `--abbrev-ref` applies to every revision after it, so the full commit comes first.
    const [head, branch] = execFileSync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    return branch && head ? { branch, head } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compares the checkout with what the session last acted on. A move is reported once — the
 * baseline is updated either way — so a session that moved it itself simply tries again.
 */
function checkoutMoved(sessionKey: string, worktree: string): string | undefined {
  const now = checkoutIdentity(worktree);
  const before = lastCheckout.get(sessionKey);
  if (now) lastCheckout.set(sessionKey, now);
  if (!now || !before || (before.branch === now.branch && before.head === now.head)) return undefined;
  const coverage = registered.get(sessionKey) ?? 'cooperative';
  // Others see which branch the session is on now.
  void getCoordination().send({ kind: 'register', session: { sessionKey, runtime: coverage === 'enforced' ? 'gateway' : 'acp', coverage, branch: now.branch, head: now.head } });
  const what = before.branch !== now.branch ? `the checkout switched from ${before.branch} to ${now.branch}` : `${now.branch} moved from ${before.head.slice(0, 8)} to ${now.head.slice(0, 8)}`;
  return `Not done: ${what} since this session last acted here. If you did that yourself, try again; otherwise re-read the files you are changing first — they may not be what you saw.`;
}

const ownerOf = (sessionKey: string) => ({ sessionKey });

function blockersText(blockers: CoordinationBlocker[]): string {
  return blockers.length ? blockers.map(blocker => `${describeResource(blocker.resource)} is held by ${blocker.ownerSessionKey} (${blocker.reason})`).join('; ') : 'an earlier request is waiting for the same thing';
}

/** Releases a request; with evidence the work stopped, also clears it if it had gone to recovery meanwhile. */
async function releaseRequest(sessionKey: string, requestId: string, evidence?: string): Promise<void> {
  const coordination = getCoordination();
  await coordination.send({ kind: 'release', owner: ownerOf(sessionKey), requestId });
  if (!evidence) return;
  const state = (await coordination.snapshot()) as CoordinationState;
  for (const claim of state.claims.filter(candidate => candidate.requestId === requestId && candidate.state === 'recovery-required')) {
    await coordination.send({ kind: 'recover', claimId: claim.claimId, actor: 'Praxis', note: evidence });
  }
}

/**
 * Waits, bounded, for resources: queued at the broker in turn order, then polled by request id
 * (idempotent) until it is granted, refused, timed out, cancelled — or the turn it belongs to
 * ends. A grant arrives as a reservation and is started at once; a wait that ends any other
 * way is cancelled at the broker, so nothing is left queued.
 */
export async function waitForResources(
  sessionKey: string,
  coverage: CoordinationCoverage,
  worktree: string | undefined,
  input: { items: CoordinationRequestItem[]; reason: string; timeoutMs: number; signal?: AbortSignal; pollMs?: number }
): Promise<GateDecision> {
  if (worktree) await ensureRegistered(sessionKey, coverage, worktree);
  const coordination = getCoordination();
  const owner = ownerOf(sessionKey);
  const requestId = randomUUID();
  const epoch = turnEpoch.get(sessionKey) ?? 0;
  const started = Date.now();
  const granted = (): GateDecision => ({ ok: true, release: evidence => releaseRequest(sessionKey, requestId, evidence) });
  let result = await coordination.send({ kind: 'acquire', requestId, owner, items: input.items, reason: input.reason, lifetime: 'sequence', wait: { forMs: input.timeoutMs } });
  let blockers: CoordinationBlocker[] = [];
  for (;;) {
    if (!result.ok) return { ok: false, reason: result.error };
    const acquire = result.acquire;
    // The turn this wait belongs to ended: a grant now would outlive it, so it is given back.
    if ((turnEpoch.get(sessionKey) ?? 0) !== epoch) {
      if (acquire?.status === 'granted') await releaseRequest(sessionKey, requestId);
      else await coordination.send({ kind: 'cancel', owner, requestId });
      return { ok: false, reason: 'The turn ended while waiting.' };
    }
    if (acquire?.status === 'granted') {
      const start = await coordination.send({ kind: 'start', owner, claimIds: acquire.claimIds, generation: acquire.generation });
      return start.ok ? granted() : { ok: false, reason: start.error };
    }
    if (acquire?.status === 'blocked') return { ok: false, reason: acquire.reason };
    blockers = acquire?.blockers ?? blockers;
    const waited = Math.round((Date.now() - started) / 1000);
    const stop = input.signal?.aborted
      ? `The wait was cancelled after ${waited} s.`
      : Date.now() - started >= input.timeoutMs
        ? `Still busy after ${waited} s: ${blockersText(blockers)}.`
        : undefined;
    if (stop) {
      await coordination.send({ kind: 'cancel', owner, requestId });
      return { ok: false, reason: stop };
    }
    await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 250));
    // Asking again by the same id is idempotent: it reports the queue position, or the grant.
    result = await coordination.send({ kind: 'acquire', requestId, owner, items: input.items, reason: input.reason, lifetime: 'sequence', wait: false });
  }
}

/** The gate for one agent session's side effects. */
export function coordinationGateFor(sessionKey: string, workingDirectory: string, coverage: CoordinationCoverage): CoordinationGate | undefined {
  if (process.env.PRAXIS_COORDINATION === 'off' || !workingDirectory) return undefined;
  const worktree = worktreeRoot(path.resolve(workingDirectory));
  return {
    worktree,
    acquire: async input => {
      await ensureRegistered(sessionKey, coverage, worktree);
      const moved = checkoutMoved(sessionKey, worktree);
      if (moved) return { ok: false, reason: moved };
      const requestId = input.requestId ?? randomUUID();
      const result = await getCoordination().send({
        kind: 'acquire',
        requestId,
        owner: ownerOf(sessionKey),
        items: input.items,
        reason: input.reason,
        lifetime: input.lifetime ?? 'tool',
        // A tool call answers at once rather than sleeping inside the agent's turn; waiting is a separate, bounded call.
        wait: false
      });
      if (!result.ok) return { ok: false, reason: result.error };
      const acquire = result.acquire;
      if (acquire?.status !== 'granted') return { ok: false, reason: acquire?.status === 'blocked' ? acquire.reason : 'The resource is busy.' };
      return {
        ok: true,
        release: async evidence => {
          await releaseRequest(sessionKey, requestId, evidence);
          // What the session itself just did (a commit, a checkout) is the new baseline.
          const now = checkoutIdentity(worktree);
          if (now) lastCheckout.set(sessionKey, now);
        }
      };
    },
    wait: input => waitForResources(sessionKey, coverage, worktree, input)
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
    items: [{ resource: { kind: 'browser', surface: BROWSER_SURFACE }, mode: 'exclusive' }],
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
  turnEpoch.set(sessionKey, (turnEpoch.get(sessionKey) ?? 0) + 1);
  lastCheckout.delete(sessionKey);
  if (!registered.has(sessionKey)) return;
  void getCoordination().send({ kind: 'end-turn', owner: { sessionKey } });
}

/** How long a person's hands-off pause must last before the in-app browser is handed back. */
export const PERSON_IDLE_MS = Number(process.env.PRAXIS_PERSON_IDLE_MS) || 30_000;
let personHold: { requestId: string; timer: NodeJS.Timeout } | undefined;
let personHoldSeq = 0;

/**
 * A person used the in-app browser (a click, a key, a scroll). They outrank any agent driving
 * it: the browser is taken over at the broker — the agent's claim moves to the person and the
 * agent is told what it saw is out of date — and agents are refused it until the person has
 * left it alone for {@link PERSON_IDLE_MS}.
 */
export async function personUsedBrowser(): Promise<void> {
  if (process.env.PRAXIS_COORDINATION === 'off') return;
  if (personHold) {
    personHold.timer.refresh();
    return;
  }
  const requestId = `${PERSON_SESSION}:browser:${(personHoldSeq += 1)}`;
  const timer = setTimeout(() => void handBrowserBack(requestId), PERSON_IDLE_MS);
  timer.unref?.();
  personHold = { requestId, timer };
  const coordination = getCoordination();
  await coordination.send({ kind: 'register', session: { sessionKey: PERSON_SESSION, runtime: 'person', coverage: 'enforced' } });
  registered.set(PERSON_SESSION, 'enforced');
  ensureHeartbeat();
  await coordination.send({
    kind: 'takeover',
    requestId,
    sessionKey: PERSON_SESSION,
    items: [{ resource: { kind: 'browser', surface: BROWSER_SURFACE }, mode: 'exclusive' }],
    reason: 'a person is using the in-app browser; anything an agent saw there before may have changed'
  });
}

async function handBrowserBack(requestId: string): Promise<void> {
  if (personHold?.requestId === requestId) personHold = undefined;
  await getCoordination().send({ kind: 'release', owner: { sessionKey: PERSON_SESSION }, requestId });
}

/** A session was deleted: it leaves the broker (an executing claim waits for recovery). */
export function endCoordinatedSession(sessionKey: string): void {
  if (!registered.has(sessionKey)) return;
  registered.delete(sessionKey);
  void getCoordination().send({ kind: 'end-session', sessionKey });
}

export async function disposeCoordination(): Promise<void> {
  if (personHold) clearTimeout(personHold.timer);
  personHold = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  // Nothing would watch a service an agent started once the app is gone: stop it, which releases its claim.
  await stopAllServices().catch(() => undefined);
  for (const sessionKey of registered.keys()) await getCoordination().send({ kind: 'end-turn', owner: { sessionKey } }).catch(() => undefined);
  await coordination?.close();
  coordination = undefined;
  registered.clear();
}
