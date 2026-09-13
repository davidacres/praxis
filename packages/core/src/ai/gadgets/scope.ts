/**
 * Scope and policy authorization for gadget actions (TASK-283).
 *
 * Two separate things are checked here and it is worth keeping them distinct:
 *
 * - **Scope** — is this action aimed at the place it was issued for? A gadget
 *   answered on a second device, or after the user switched project, must not
 *   apply to whatever is open now. This is the check that makes "Approve" safe.
 * - **Policy** — is the caller allowed to do this *at all*? An informational
 *   gadget never mutates; a mutating or approval action has to clear the
 *   workflow gate it declared. A gadget cannot grant itself authority.
 */
import type { AnyGadgetEnvelope, GadgetAction, GadgetError, GadgetScope } from './contracts';

export interface GadgetScopeContext {
  hostId: string;
  sessionId: string;
  projectId?: string;
  workId?: string;
  /**
   * Current revision of the scope. A gadget issued against an older revision is
   * stale — the session moved on underneath it — and is refused rather than
   * applied to state it was not shown against.
   */
  revision?: number;
}

export interface GadgetPolicyContext {
  /**
   * Whether the named workflow gate is currently open for this scope.
   *
   * Praxis already owns gates; this deliberately delegates rather than
   * re-deciding, so a gadget can never be a second, weaker approval path.
   */
  isGateOpen(gate: string, scope: GadgetScope): boolean;
}

function scopesMatch(a: GadgetScope, b: GadgetScope): boolean {
  return a.hostId === b.hostId && a.sessionId === b.sessionId && a.projectId === b.projectId && a.workId === b.workId;
}

/**
 * Check an action against the gadget that issued it and the live scope.
 *
 * Returns `undefined` when the action may proceed.
 */
export function authorizeGadgetAction(
  envelope: AnyGadgetEnvelope,
  action: GadgetAction,
  scopeContext: GadgetScopeContext,
  policy: GadgetPolicyContext
): GadgetError | undefined {
  if (action.gadgetId !== envelope.gadgetId) {
    return { code: 'scope-mismatch', message: 'This action does not belong to this gadget.', retryable: false };
  }

  // The client sends the scope back; it must be the one we issued, byte for
  // byte. Accepting a client-supplied scope that differs from the envelope's
  // would let a caller retarget an approval at another project.
  if (!scopesMatch(action.scope, envelope.scope)) {
    return { code: 'scope-mismatch', message: 'This action was submitted against a different scope than it was issued for.', retryable: false };
  }

  if (envelope.scope.hostId !== scopeContext.hostId) {
    return { code: 'scope-mismatch', message: 'This was issued by a different host.', retryable: false };
  }
  if (envelope.scope.sessionId !== scopeContext.sessionId) {
    return { code: 'scope-mismatch', message: 'This belongs to a different session.', retryable: false };
  }
  if (envelope.scope.projectId !== scopeContext.projectId) {
    return { code: 'scope-mismatch', message: 'The project changed since this was asked.', retryable: false };
  }
  if (envelope.scope.workId !== scopeContext.workId) {
    return { code: 'scope-mismatch', message: 'The work item changed since this was asked.', retryable: false };
  }
  if (
    envelope.scope.revision !== undefined &&
    scopeContext.revision !== undefined &&
    envelope.scope.revision !== scopeContext.revision
  ) {
    return {
      code: 'scope-mismatch',
      message: 'The session has moved on since this was asked. Ask again to act on the current state.',
      retryable: false
    };
  }

  const descriptor = envelope.actions.find(candidate => candidate.actionId === action.actionId);
  if (!descriptor) {
    return { code: 'unknown-action', message: `This gadget does not offer an action called "${action.actionId}".`, retryable: false };
  }

  if (descriptor.effect === 'informational') return undefined;

  // Validation already refuses an ungated mutating action, so reaching here
  // without a gate means the envelope bypassed validation — refuse loudly
  // rather than treat a missing gate as "no gate required".
  if (!descriptor.gate) {
    return { code: 'gate-required', message: 'This action changes state but declares no workflow gate.', retryable: false };
  }
  if (!policy.isGateOpen(descriptor.gate, envelope.scope)) {
    return {
      code: 'gate-required',
      message: `The "${descriptor.gate}" gate is not open, so this cannot be applied from here.`,
      retryable: false
    };
  }
  return undefined;
}

/** A policy that opens every gate — for local-first flows with no gating configured. */
export const PERMISSIVE_GADGET_POLICY: GadgetPolicyContext = { isGateOpen: () => true };

/** A policy that opens nothing; the safe default when gate state is unknown. */
export const DENY_ALL_GADGET_POLICY: GadgetPolicyContext = { isGateOpen: () => false };

/** Build a policy from an explicit allow-list of open gates. */
export function gatePolicyFromOpenGates(openGates: Iterable<string>): GadgetPolicyContext {
  const gates = new Set(openGates);
  return { isGateOpen: gate => gates.has(gate) };
}
