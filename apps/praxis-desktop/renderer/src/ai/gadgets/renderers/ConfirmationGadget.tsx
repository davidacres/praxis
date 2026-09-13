import type { ConfirmationGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

/**
 * A yes/no decision with its consequences spelled out.
 *
 * The consequence list is the point: a confirmation that only says "Are you
 * sure?" moves the risk onto the user without telling them what they are
 * accepting. The producer supplies the list; we always render it.
 */
export function ConfirmationGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'confirmation'>(gadget) as ConfirmationGadgetPayload;
  const titleId = `${gadget.gadgetId}-title`;

  return (
    <>
      <GadgetHeading title={payload.question} detail={payload.detail} id={titleId} />
      {payload.consequences && payload.consequences.length > 0 && (
        <div className="gadget-consequences">
          <p className="gadget-consequences-label">This will:</p>
          <ul>
            {payload.consequences.map((consequence, index) => (
              <li key={index}>
                <Icon name="arrow-right" size={11} />
                {consequence}
              </li>
            ))}
          </ul>
        </div>
      )}
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        // A confirmation's answer is carried by *which* action was pressed, so
        // every action is submittable as soon as the gadget is live. Declining
        // is derived from the effect rather than an action-ID convention:
        // an action that changes nothing (`informational`) is the decline, and
        // the one that mutates or approves is the confirm.
        valueFor={action => ({ kind: 'confirmation', confirmed: action.effect !== 'informational' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
