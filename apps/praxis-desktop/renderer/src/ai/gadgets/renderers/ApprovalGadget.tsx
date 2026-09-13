import type { ApprovalGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

/**
 * A workflow gate, answered in chat.
 *
 * The gate name is shown, not hidden: approving here is exactly the same
 * decision as approving in the run monitor, against the same gate, and the
 * user should be able to see which one they are opening. The host still
 * enforces it — this surface cannot approve anything the gate would refuse.
 */
export function ApprovalGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'approval'>(gadget) as ApprovalGadgetPayload;

  return (
    <>
      <GadgetHeading title={payload.title} detail={payload.summary} id={`${gadget.gadgetId}-title`} />
      <p className="gadget-approval-gate">
        <Icon name="shield" size={12} />
        <span>Gate</span>
        <code>{payload.gate}</code>
        {payload.requestedBy && <span className="gadget-approval-requester">requested by {payload.requestedBy}</span>}
      </p>
      {payload.effect && (
        <p className="gadget-approval-effect">
          <Icon name="zap" size={12} />
          Approving will {payload.effect}
        </p>
      )}
      {payload.evidence && payload.evidence.length > 0 && (
        <dl className="gadget-approval-evidence">
          {payload.evidence.map((entry, index) => (
            <div key={index}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={action => ({ kind: 'confirmation', confirmed: action.effect !== 'informational' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
