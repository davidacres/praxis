/**
 * The host-side pipeline a gadget action travels through.
 *
 * Agent/workflow response → validation → renderer → user action →
 * scope + policy → ledger → executor → structured result.
 *
 * Everything the modules in this folder do separately is sequenced here, in one
 * place, so there is exactly one path a submission can take. The executor is
 * injected rather than imported: applying a diff, opening a gate or starting a
 * run belongs to the services that already own those things, and a gadget must
 * never become a second way to reach them.
 */
import type { KeyValueStore } from '../../host/stateStore';
import type {
  AnyGadgetEnvelope,
  ChatBlock,
  GadgetAction,
  GadgetActionResult,
  GadgetCapability,
  GadgetError
} from './contracts';
import {
  GadgetActionLedger,
  admitGadgetAction,
  completeGadgetAction,
  failGadgetAction,
  rejectGadgetAction,
  rejectedResult,
  toActionResult,
  type GadgetActionRecord
} from './actionLedger';
import { collectSupersededIds, inertStateError, resolveGadgetState } from './lifecycle';
import { PERMISSIVE_GADGET_POLICY, authorizeGadgetAction, type GadgetPolicyContext, type GadgetScopeContext } from './scope';
import { coerceGadgetBlock, validateGadgetActionValue } from './validation';

export const GADGET_BLOCKS_STORAGE_KEY = 'praxis.gadgetBlocks';

export type RawChatBlockInput =
  | { type: 'markdown'; markdown: string; blockId?: string }
  | { type: 'gadget'; gadget: unknown; blockId?: string };

export interface GadgetExecutionContext {
  record: GadgetActionRecord;
  envelope: AnyGadgetEnvelope;
  action: GadgetAction;
}

/** What the host does once an action is authorised. */
export type GadgetActionExecutor = (context: GadgetExecutionContext) => Promise<{ outcome?: unknown; message?: string } | void>;

export interface GadgetServiceOptions {
  hostId: string;
  store?: KeyValueStore;
  /** Defaults to permissive: local-first Praxis with no gating configured. */
  policy?: GadgetPolicyContext;
  /** Injected for deterministic tests. */
  now?: () => string;
  capability?: GadgetCapability;
}

type BlocksBySession = Record<string, ChatBlock[]>;

export class GadgetService {
  private readonly ledger: GadgetActionLedger;
  private blocks: BlocksBySession;
  private readonly now: () => string;

  public constructor(private readonly options: GadgetServiceOptions) {
    this.ledger = new GadgetActionLedger(options.store);
    this.blocks = options.store?.get<BlocksBySession>(GADGET_BLOCKS_STORAGE_KEY) ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public get actionLedger(): GadgetActionLedger {
    return this.ledger;
  }

  /**
   * Validate and store a response's blocks for a session.
   *
   * Returns exactly what a renderer should draw — a refused gadget comes back
   * as a `fallback` block, never as nothing.
   */
  public publish(sessionId: string, inputs: readonly RawChatBlockInput[]): ChatBlock[] {
    const existing = this.blocks[sessionId] ?? [];
    const published = inputs.map((input, index) => {
      const blockId = input.blockId ?? `${sessionId}-block-${existing.length + index + 1}`;
      if (input.type === 'markdown') return { type: 'markdown', blockId, markdown: input.markdown } satisfies ChatBlock;
      return coerceGadgetBlock(input.gadget, blockId, { capability: this.options.capability });
    });

    // A gadget that re-publishes the same `gadgetId` replaces its block in
    // place, so a streaming progress update does not append a new surface on
    // every tick.
    // A block that re-uses a `blockId` replaces it too — a refused gadget comes back as a
    // `fallback` block under the same id, and re-parsing its message (which the desktop and the
    // phone's host projection both do) must not stack a second copy.
    const merged = [...existing];
    for (const block of published) {
      const index =
        block.type === 'gadget'
          ? merged.findIndex(candidate => (candidate.type === 'gadget' && candidate.gadget.gadgetId === block.gadget.gadgetId) || candidate.blockId === block.blockId)
          : merged.findIndex(candidate => candidate.blockId === block.blockId);
      if (index === -1) merged.push(block);
      else merged[index] = block;
    }
    this.blocks[sessionId] = merged;
    void this.persistBlocks();
    return this.decorate(merged, true);
  }

  /** Every block for a session, with lifecycle state resolved against now. */
  public getBlocks(sessionId: string, options: { connected?: boolean } = {}): ChatBlock[] {
    return this.decorate(this.blocks[sessionId] ?? [], options.connected ?? true);
  }

  public findGadget(sessionId: string, gadgetId: string): AnyGadgetEnvelope | undefined {
    const block = (this.blocks[sessionId] ?? []).find(
      candidate => candidate.type === 'gadget' && candidate.gadget.gadgetId === gadgetId
    );
    return block?.type === 'gadget' ? block.gadget : undefined;
  }

  /** Withdraw a gadget — the host decided it should no longer be answerable. */
  public revoke(sessionId: string, gadgetId: string): void {
    const blocks = this.blocks[sessionId];
    if (!blocks) return;
    const index = blocks.findIndex(block => block.type === 'gadget' && block.gadget.gadgetId === gadgetId);
    if (index === -1) return;
    const block = blocks[index];
    if (block.type !== 'gadget') return;
    blocks[index] = { ...block, gadget: { ...block.gadget, state: 'revoked' } };
    void this.persistBlocks();
  }

  public clearSession(sessionId: string): void {
    delete this.blocks[sessionId];
    void this.persistBlocks();
  }

  /** Ledger events after a cursor, for a client that reconnected. */
  public replay(afterSequence: number, limit?: number) {
    return this.ledger.replay(afterSequence, limit);
  }

  /**
   * Run one submission end to end.
   *
   * The order of checks is load-bearing. Scope and lifecycle are settled
   * *before* the ledger is touched, so a refused submission never consumes an
   * idempotency key — otherwise a user who was denied once because a gate was
   * shut could not retry after it opened.
   */
  public async submit(
    action: GadgetAction,
    scopeContext: GadgetScopeContext,
    executor?: GadgetActionExecutor
  ): Promise<GadgetActionResult> {
    const now = this.now();
    const envelope = this.findGadget(scopeContext.sessionId, action.gadgetId);
    if (!envelope) {
      return rejectedResult(action, { code: 'gadget-not-found', message: 'This gadget is no longer available.', retryable: false }, now);
    }

    // A retry of an already-recorded submission is served before the lifecycle
    // check: the gadget is legitimately `submitted` by then, and refusing the
    // retry as "already answered" would turn a dropped ack into a dead end.
    const priorAttempt = this.ledger.get(action.idempotencyKey);
    if (priorAttempt && priorAttempt.status !== 'rejected') {
      const admission = admitGadgetAction(this.ledger, envelope, action, now);
      if (!admission.ok) return rejectedResult(action, admission.error, now);
      if (admission.replay) return toActionResult(admission.record, true);
    }

    const state = resolveGadgetState(envelope, {
      now,
      supersededIds: collectSupersededIds(this.blocks[scopeContext.sessionId] ?? []),
      submissionStatus: this.ledger.effectiveStatus(envelope.gadgetId, envelope.scope.sessionId)
    });
    const inert = inertStateError(state);
    if (inert) return rejectedResult(action, inert, now);

    const denial =
      authorizeGadgetAction(envelope, action, scopeContext, this.options.policy ?? PERMISSIVE_GADGET_POLICY) ??
      validateGadgetActionValue(envelope, action);
    if (denial) return rejectedResult(action, denial, now);

    const admission = admitGadgetAction(this.ledger, envelope, action, now);
    if (!admission.ok) return rejectedResult(action, admission.error, now);
    if (admission.replay) return toActionResult(admission.record, true);

    if (!executor) return toActionResult(admission.record);

    try {
      const outcome = await executor({ record: admission.record, envelope, action });
      const completed = completeGadgetAction(
        this.ledger,
        action.idempotencyKey,
        outcome?.outcome,
        this.now(),
        outcome?.message
      );
      return toActionResult(completed ?? admission.record);
    } catch (error) {
      // The action was authorised and recorded, then the work failed. That is a
      // `failed` record, not a rejection — the decision was legitimate and the
      // audit trail must show it was attempted.
      const failure: GadgetError = {
        code: 'value-invalid',
        message: error instanceof Error ? error.message : 'The action could not be completed.',
        retryable: true
      };
      const failed = failGadgetAction(this.ledger, action.idempotencyKey, failure, this.now());
      return toActionResult(failed ?? admission.record);
    }
  }

  /** Record a refusal decided outside `submit` (for example by a caller's own policy). */
  public reject(action: GadgetAction, error: GadgetError): GadgetActionResult {
    const now = this.now();
    const rejected = rejectGadgetAction(this.ledger, action.idempotencyKey, error, now);
    return rejected ? toActionResult(rejected) : rejectedResult(action, error, now);
  }

  private decorate(blocks: readonly ChatBlock[], connected: boolean): ChatBlock[] {
    const now = this.now();
    const supersededIds = collectSupersededIds(blocks);
    return blocks.map(block => {
      if (block.type !== 'gadget') return block;
      const state = resolveGadgetState(block.gadget, {
        now,
        supersededIds,
        submissionStatus: this.ledger.effectiveStatus(block.gadget.gadgetId, block.gadget.scope.sessionId),
        connected
      });
      return { ...block, gadget: { ...block.gadget, state } };
    });
  }

  private async persistBlocks(): Promise<void> {
    await this.options.store?.update(GADGET_BLOCKS_STORAGE_KEY, this.blocks);
  }
}
