/**
 * Durable, append-only record of gadget action submissions (TASK-282).
 *
 * Two jobs, and they are related:
 *
 * - **Idempotency.** A submission is keyed by `idempotencyKey`. A retry — a
 *   double click, a reconnect that resends, a mobile client repeating after a
 *   dropped ack — returns the original result instead of applying the action
 *   twice. Reusing the same key with a *different* answer is a conflict, not a
 *   retry, and is refused.
 * - **Evidence.** Each record keeps what the gadget actually asked at the
 *   moment it was answered. An audit months later must not depend on the
 *   gadget still existing, or on a chat transcript being intact, so the prompt,
 *   the chosen action's label, its effect and its gate are copied in.
 */
import { createHash } from 'node:crypto';
import type { KeyValueStore } from '../../host/stateStore';
import type {
  AnyGadgetEnvelope,
  GadgetAction,
  GadgetActionEffect,
  GadgetActionResult,
  GadgetActionStatus,
  GadgetActionValue,
  GadgetError,
  GadgetKind,
  GadgetScope
} from './contracts';
import { GADGET_CONTRACT_VERSION } from './contracts';

export const GADGET_LEDGER_STORAGE_KEY = 'praxis.gadgetActionLedger';

/** Copied from the gadget at submission time so the record stands alone. */
export interface GadgetActionEvidence {
  kind: GadgetKind;
  /** The gadget's fallback text — what the user was actually asked. */
  prompt: string;
  actionLabel: string;
  effect: GadgetActionEffect;
  gate?: string;
  value: GadgetActionValue;
  issuedAt: string;
}

export interface GadgetActionRecord {
  idempotencyKey: string;
  correlationId: string;
  gadgetId: string;
  actionId: string;
  scope: GadgetScope;
  status: GadgetActionStatus;
  submittedAt: string;
  updatedAt: string;
  /** Detects a key reused with a different answer. */
  valueDigest: string;
  evidence: GadgetActionEvidence;
  outcome?: unknown;
  error?: GadgetError;
  message?: string;
}

export interface GadgetLedgerEvent {
  sequence: number;
  at: string;
  correlationId: string;
  idempotencyKey: string;
  gadgetId: string;
  status: GadgetActionStatus;
  scope: GadgetScope;
}

interface PersistedLedger {
  records: GadgetActionRecord[];
  events: GadgetLedgerEvent[];
  sequence: number;
}

/** Stable digest of a submitted value: key order must not change the result. */
export function digestActionValue(value: GadgetActionValue): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((out, key) => {
          out[key] = canonical((input as Record<string, unknown>)[key]);
          return out;
        }, {});
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 32);
}

export class GadgetActionLedger {
  private records = new Map<string, GadgetActionRecord>();
  private events: GadgetLedgerEvent[] = [];
  private sequence = 0;

  /**
   * `store` is optional so the ledger can be used in-memory by tests and by a
   * host that has not yet chosen a durable location.
   */
  public constructor(private readonly store?: KeyValueStore, private readonly storageKey = GADGET_LEDGER_STORAGE_KEY) {
    const persisted = store?.get<PersistedLedger>(storageKey);
    if (!persisted) return;
    for (const record of persisted.records ?? []) this.records.set(record.idempotencyKey, record);
    this.events = persisted.events ?? [];
    this.sequence = persisted.sequence ?? this.events.at(-1)?.sequence ?? 0;
  }

  public get(idempotencyKey: string): GadgetActionRecord | undefined {
    return this.records.get(idempotencyKey);
  }

  public findByCorrelation(correlationId: string): GadgetActionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.correlationId === correlationId) return record;
    }
    return undefined;
  }

  /** Every record for one gadget, oldest first — the gadget's decision history. */
  public forGadget(gadgetId: string, sessionId?: string): GadgetActionRecord[] {
    return [...this.records.values()]
      .filter(record => record.gadgetId === gadgetId && (sessionId === undefined || record.scope.sessionId === sessionId))
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  /**
   * The latest *effective* status for a gadget.
   *
   * A rejected or failed attempt leaves the gadget answerable, so it does not
   * count — otherwise a typo in a form would permanently disable the surface.
   */
  public effectiveStatus(gadgetId: string, sessionId?: string): GadgetActionStatus | undefined {
    const settled = this.forGadget(gadgetId, sessionId).filter(record => record.status === 'accepted' || record.status === 'completed');
    return settled.at(-1)?.status;
  }

  /** Events after a cursor, for a client that reconnected and must catch up. */
  public replay(afterSequence: number, limit = 200): readonly GadgetLedgerEvent[] {
    return this.events.filter(event => event.sequence > afterSequence).slice(0, limit);
  }

  public get lastSequence(): number {
    return this.sequence;
  }

  public put(record: GadgetActionRecord): GadgetActionRecord {
    this.records.set(record.idempotencyKey, record);
    this.sequence += 1;
    this.events.push({
      sequence: this.sequence,
      at: record.updatedAt,
      correlationId: record.correlationId,
      idempotencyKey: record.idempotencyKey,
      gadgetId: record.gadgetId,
      status: record.status,
      scope: record.scope
    });
    void this.persist();
    return record;
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    const snapshot: PersistedLedger = {
      records: [...this.records.values()],
      events: this.events,
      sequence: this.sequence
    };
    await this.store.update(this.storageKey, snapshot);
  }
}

export type GadgetAdmission =
  | { ok: true; record: GadgetActionRecord; replay: boolean }
  | { ok: false; error: GadgetError; record?: GadgetActionRecord };

/**
 * Admit a submission, deduplicating by idempotency key.
 *
 * Admission is the only place a record is created, so every action in the
 * ledger necessarily carries its evidence.
 */
export function admitGadgetAction(
  ledger: GadgetActionLedger,
  envelope: AnyGadgetEnvelope,
  action: GadgetAction,
  now: string
): GadgetAdmission {
  const digest = digestActionValue(action.value);
  const existing = ledger.get(action.idempotencyKey);
  if (existing) {
    if (existing.valueDigest !== digest) {
      return {
        ok: false,
        error: {
          code: 'duplicate-action',
          message: 'That submission ID was already used with a different answer.',
          retryable: false
        },
        record: existing
      };
    }
    // Same key, same answer: a retry. Serve the original outcome.
    return { ok: true, record: existing, replay: true };
  }

  const descriptor = envelope.actions.find(candidate => candidate.actionId === action.actionId);
  if (!descriptor) {
    return {
      ok: false,
      error: { code: 'unknown-action', message: `This gadget does not offer an action called "${action.actionId}".`, retryable: false }
    };
  }

  const record: GadgetActionRecord = {
    idempotencyKey: action.idempotencyKey,
    correlationId: action.correlationId,
    gadgetId: action.gadgetId,
    actionId: action.actionId,
    scope: envelope.scope,
    status: 'accepted',
    submittedAt: action.submittedAt,
    updatedAt: now,
    valueDigest: digest,
    evidence: {
      kind: envelope.kind,
      prompt: envelope.fallbackText,
      actionLabel: descriptor.label,
      effect: descriptor.effect,
      gate: descriptor.gate,
      value: action.value,
      issuedAt: envelope.issuedAt
    }
  };
  return { ok: true, record: ledger.put(record), replay: false };
}

function settle(
  ledger: GadgetActionLedger,
  idempotencyKey: string,
  status: GadgetActionStatus,
  now: string,
  extra: Partial<Pick<GadgetActionRecord, 'outcome' | 'error' | 'message'>>
): GadgetActionRecord | undefined {
  const current = ledger.get(idempotencyKey);
  if (!current) return undefined;
  return ledger.put({ ...current, ...extra, status, updatedAt: now });
}

/** The host finished the work the action asked for. */
export function completeGadgetAction(
  ledger: GadgetActionLedger,
  idempotencyKey: string,
  outcome: unknown,
  now: string,
  message?: string
): GadgetActionRecord | undefined {
  return settle(ledger, idempotencyKey, 'completed', now, { outcome, message });
}

/** The host tried and could not — the gadget stays answerable. */
export function failGadgetAction(
  ledger: GadgetActionLedger,
  idempotencyKey: string,
  error: GadgetError,
  now: string
): GadgetActionRecord | undefined {
  return settle(ledger, idempotencyKey, 'failed', now, { error });
}

/** Refused before any work happened — policy, scope or a stale gadget. */
export function rejectGadgetAction(
  ledger: GadgetActionLedger,
  idempotencyKey: string,
  error: GadgetError,
  now: string
): GadgetActionRecord | undefined {
  return settle(ledger, idempotencyKey, 'rejected', now, { error });
}

/** Project a record into the result shape the renderer consumes. */
export function toActionResult(record: GadgetActionRecord, replay = false): GadgetActionResult {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: record.gadgetId,
    actionId: record.actionId,
    correlationId: record.correlationId,
    idempotencyKey: record.idempotencyKey,
    status: record.status,
    at: record.updatedAt,
    replay,
    error: record.error,
    outcome: record.outcome,
    message: record.message
  };
}

/** A result for a submission that never reached the ledger. */
export function rejectedResult(action: GadgetAction, error: GadgetError, now: string): GadgetActionResult {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: action.gadgetId,
    actionId: action.actionId,
    correlationId: action.correlationId,
    idempotencyKey: action.idempotencyKey,
    status: 'rejected',
    at: now,
    error,
    message: error.message
  };
}
