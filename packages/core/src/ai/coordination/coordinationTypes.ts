/**
 * Session coordination contract (FX-BF-048 / TASK-391; path claims for FX-BE-094 / TASK-263).
 *
 * Several AI sessions can run at once — chats, workflow stages, map items, across
 * worktrees and repositories — and some of what they touch is shared: a file, a
 * whole checkout, the live app, the in-app browser, the desktop's mouse and
 * keyboard, a build output directory, a port. A readable JSON file of who is doing
 * what cannot stop two of them observing "idle" and both starting; one broker that
 * grants ownership atomically, before a side effect, can.
 *
 * These are the shapes that broker speaks. Ownership is identified by the full
 * `(session, turn, execution, request)` tuple, never by a process id, and a claim
 * moves through reserved → executing → cleaning-up → released, or to
 * recovery-required when its owner can no longer prove it stopped.
 */

export const COORDINATION_SCHEMA_VERSION = 1;

/** Something a session can own. Paths are canonical and relative to their worktree. */
export type CoordinationResource =
  | { kind: 'file'; worktree: string; path: string }
  | { kind: 'directory'; worktree: string; path: string }
  /** Arbitrary edits whose files cannot be named (a shell command, a native agent). Shared mode = a stable read. */
  | { kind: 'worktree'; worktree: string }
  /** Branch checkout, reset or rebase: everything in the worktree. */
  | { kind: 'checkout'; worktree: string }
  /** Staging and committing in one worktree's index. */
  | { kind: 'git-index'; worktree: string }
  /** One live app instance, for a whole interaction sequence. */
  | { kind: 'app-ui'; instance: string }
  /** One in-app browser surface, for a whole navigate/inspect sequence. */
  | { kind: 'browser'; surface: string }
  /** The machine's global focus, mouse and keyboard. */
  | { kind: 'desktop' }
  /** A build output directory; shared mode = tests consuming it. */
  | { kind: 'build-output'; dir: string }
  | { kind: 'port'; port: number }
  | { kind: 'fixture'; id: string }
  /**
   * A process group a session started that outlived its tool call (a dev server, a watcher):
   * tracked so it is visible and its claim lasts as long as the processes do.
   */
  | { kind: 'process'; host: string; pgid: number };

export type CoordinationResourceKind = CoordinationResource['kind'];

export type ClaimMode = 'exclusive' | 'shared';

/**
 * How long a claim should last. `tool` ends with one tool call, `sequence` spans several
 * (a UI test's navigate/read/click), `turn` ends with the turn, `service` outlives it (a
 * dev server the session started) and is released only explicitly.
 */
export type ClaimLifetime = 'tool' | 'sequence' | 'turn' | 'service';

/**
 * `reserved`: granted, no side effect started — safe to drop. `executing`: work may be
 * under way. `cleaning-up`: the work ended, its processes are being reaped.
 * `recovery-required`: the owner went silent while executing; nothing can be granted on
 * this resource until a person or the host confirms the work stopped.
 */
export type ClaimState = 'reserved' | 'executing' | 'cleaning-up' | 'recovery-required';

/** Who owns a claim. `executionId` separates a native subagent from its parent. */
export interface CoordinationOwner {
  sessionKey: string;
  turnId?: string;
  executionId?: string;
}

/**
 * How well a runtime's side effects are covered: `enforced` — every route passes a gate
 * Praxis controls; `cooperative` — the agent asks through hooks or the coordination tool,
 * but a route exists that does not; `observed` — Praxis only sees telemetry afterwards.
 */
export type CoordinationCoverage = 'enforced' | 'cooperative' | 'observed';

export interface CoordinationSession {
  sessionKey: string;
  /** e.g. `gateway`, `acp:claude-code`, `acp:codex`, `workflow-check`. */
  runtime: string;
  coverage: CoordinationCoverage;
  parentSessionKey?: string;
  /** The project or repository the session belongs to — what scopes who sees what. */
  scope?: string;
  worktree?: string;
  branch?: string;
  head?: string;
  activity?: string;
  state: 'active' | 'idle' | 'stale' | 'ended';
  registeredAt: number;
  heartbeatAt: number;
}

export interface CoordinationClaim {
  claimId: string;
  requestId: string;
  owner: CoordinationOwner;
  resource: CoordinationResource;
  mode: ClaimMode;
  lifetime: ClaimLifetime;
  state: ClaimState;
  reason: string;
  grantedAt: number;
  /** Renewed by the owner's heartbeat; past it, an executing claim needs recovery. */
  leaseUntil: number;
  /** Bumped whenever ownership changes, so a stale capability cannot act. */
  generation: number;
}

export interface CoordinationRequestItem {
  resource: CoordinationResource;
  mode: ClaimMode;
}

export interface CoordinationRequest {
  requestId: string;
  owner: CoordinationOwner;
  items: CoordinationRequestItem[];
  reason: string;
  lifetime: ClaimLifetime;
  enqueuedAt: number;
  /** Give up waiting after this; absent means until cancelled. */
  waitUntil?: number;
}

export type CoordinationEventType =
  | 'registered'
  | 'activity'
  | 'resource-acquired'
  | 'resource-blocked'
  | 'resource-released'
  | 'resource-available'
  | 'recovery-required'
  | 'recovered'
  | 'delegated'
  /** A person took a live UI surface from an agent: the agent's view of it is out of date. */
  | 'taken-over'
  | 'message'
  | 'acknowledged'
  | 'done'
  | 'stale';

export interface CoordinationEvent {
  sequence: number;
  type: CoordinationEventType;
  at: number;
  sessionKey?: string;
  /** For a targeted message or wakeup. Absent = everyone in scope. */
  toSessionKey?: string;
  text: string;
  claimIds?: string[];
  /** Messages that asked for an acknowledgement. */
  needsAck?: boolean;
  ackedBy?: string[];
}

export interface CoordinationState {
  schemaVersion: number;
  /** Changes every time a broker starts: a capability from an earlier epoch is void. */
  epoch: string;
  revision: number;
  sequence: number;
  sessions: Record<string, CoordinationSession>;
  claims: CoordinationClaim[];
  waiters: CoordinationRequest[];
  events: CoordinationEvent[];
  /**
   * The broker's clock when a snapshot was taken (never persisted). Every time in the state is
   * on that clock, so durations are measured against this, not the reader's own clock.
   */
  now?: number;
}

/** Who holds what a request wanted, as the requester is allowed to see it. */
export interface CoordinationBlocker {
  resource: CoordinationResource;
  ownerSessionKey: string;
  reason: string;
  state: ClaimState;
  /** True when the owner is in another scope: only that the resource is busy is shown. */
  redacted?: boolean;
}

export type AcquireResult =
  | { status: 'granted'; claimIds: string[]; generation: number }
  | { status: 'queued'; position: number; blockers: CoordinationBlocker[] }
  | { status: 'blocked'; blockers: CoordinationBlocker[]; reason: string };
