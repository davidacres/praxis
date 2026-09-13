/**
 * Controls shared by the gadget renderers.
 *
 * These exist so the *semantics* are written once — which button is primary,
 * what a destructive action looks like, how a disabled control explains itself.
 * A renderer that hand-rolls its own footer drifts on all three.
 */
import type { GadgetActionDescriptor, GadgetActionValue } from '@praxis/core';
import { Icon } from '../../ui/Icon';

export interface GadgetActionBarProps {
  actions: readonly GadgetActionDescriptor[];
  actionable: boolean;
  busy: boolean;
  /** The value to submit for a given action, or `undefined` if it is not ready. */
  valueFor: (action: GadgetActionDescriptor) => GadgetActionValue | undefined;
  /** Why an otherwise-enabled action cannot be submitted yet. */
  blockedReason?: (action: GadgetActionDescriptor) => string | undefined;
  onSubmit: (actionId: string, value: GadgetActionValue) => void;
}

export function GadgetActionBar({ actions, actionable, busy, valueFor, blockedReason, onSubmit }: GadgetActionBarProps) {
  if (actions.length === 0) return null;
  // The first non-destructive action is the primary one. A destructive action
  // is never styled as the default, however the producer ordered them.
  const primaryId = actions.find(action => !action.danger)?.actionId;

  return (
    <div className="gadget-actions">
      {actions.map(action => {
        const value = valueFor(action);
        const blocked = blockedReason?.(action);
        const disabled = !actionable || busy || value === undefined || Boolean(blocked);
        return (
          <button
            key={action.actionId}
            type="button"
            className={`btn${action.danger ? ' btn-danger' : action.actionId === primaryId ? ' btn-primary' : ''}`}
            data-testid={`gadget-action-${action.actionId}`}
            disabled={disabled}
            // The reason lives on the control itself, so it is reachable by
            // pointer and by a screen reader rather than only implied by a
            // greyed-out button.
            title={blocked ?? action.description ?? undefined}
            aria-describedby={blocked ? `${action.actionId}-blocked` : undefined}
            onClick={() => value !== undefined && onSubmit(action.actionId, value)}
          >
            {action.danger && <Icon name="warning" size={12} />}
            {busy ? 'Working…' : action.label}
          </button>
        );
      })}
      {actions.map(action => {
        const blocked = blockedReason?.(action);
        return blocked ? (
          <span key={`${action.actionId}-blocked`} id={`${action.actionId}-blocked`} className="gadget-action-blocked">
            {blocked}
          </span>
        ) : null;
      })}
    </div>
  );
}

export function GadgetHeading({ title, detail, id }: { title: string; detail?: string; id?: string }) {
  return (
    <>
      <h3 className="gadget-title" id={id}>
        {title}
      </h3>
      {detail && <p className="gadget-detail">{detail}</p>}
    </>
  );
}

/** A short "n of m" style note, used for truncation and counts. */
export function GadgetNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="gadget-note" data-testid={testId}>
      <Icon name="info" size={11} />
      {children}
    </p>
  );
}
