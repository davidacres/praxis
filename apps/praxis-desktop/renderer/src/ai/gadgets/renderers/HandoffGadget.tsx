import type { HandoffGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

/**
 * Review what one provider is about to tell another.
 *
 * The excluded list matters as much as the included one. A handoff the user
 * approves without seeing what was dropped is how context silently disappears
 * between providers, and the resulting confusion looks like a model failure
 * rather than a missing paragraph.
 */
export function HandoffGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'handoff'>(gadget) as HandoffGadgetPayload;

  return (
    <>
      <GadgetHeading title={payload.title} id={`${gadget.gadgetId}-title`} />
      <p className="gadget-handoff-route">
        <span className="gadget-handoff-provider">{payload.fromProvider}</span>
        <Icon name="arrow-right" size={13} />
        <span className="gadget-handoff-provider">{payload.toProvider}</span>
      </p>
      <div className="gadget-handoff-context">
        <p className="gadget-handoff-label">Context being passed on</p>
        <pre>{payload.contextSummary}</pre>
      </div>
      {payload.includedItems && payload.includedItems.length > 0 && (
        <div className="gadget-handoff-list">
          <p className="gadget-handoff-label">Included</p>
          <ul>
            {payload.includedItems.map((item, index) => (
              <li key={index}>
                <Icon name="check" size={11} />
                <span>
                  {item.label}
                  {item.detail && <small> — {item.detail}</small>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {payload.excludedItems && payload.excludedItems.length > 0 && (
        <div className="gadget-handoff-list is-excluded">
          <p className="gadget-handoff-label">Not included</p>
          <ul>
            {payload.excludedItems.map((item, index) => (
              <li key={index}>
                <Icon name="close" size={11} />
                <span>
                  {item.label}
                  {item.reason && <small> — {item.reason}</small>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {payload.warning && (
        <p className="gadget-warning" role="note">
          <Icon name="warning" size={12} />
          {payload.warning}
        </p>
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
