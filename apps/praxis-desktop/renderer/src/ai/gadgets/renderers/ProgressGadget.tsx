import type { ProgressGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

const STEP_ICON = {
  pending: 'dot',
  running: 'refresh',
  done: 'check',
  failed: 'warning'
} as const;

/**
 * Live work, streamed.
 *
 * The bar is a real `progressbar` with its value exposed; an indeterminate run
 * omits `aria-valuenow` rather than lying with a number, which is what lets a
 * screen reader say "busy" instead of "0 percent".
 */
export function ProgressGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'progress'>(gadget) as ProgressGadgetPayload;
  const determinate = typeof payload.percent === 'number';

  return (
    <>
      <div className="gadget-progress-head">
        <h3 className="gadget-title">{payload.title}</h3>
        <span className={`gadget-progress-status is-${payload.status}`} data-testid="gadget-progress-status">
          {payload.status}
        </span>
      </div>
      <div
        className={`gadget-progress-bar is-${payload.status}${determinate ? '' : ' is-indeterminate'}`}
        role="progressbar"
        aria-label={payload.title}
        aria-valuenow={determinate ? payload.percent : undefined}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
      >
        <span style={determinate ? { width: `${payload.percent}%` } : undefined} />
      </div>
      {payload.detail && <p className="gadget-detail">{payload.detail}</p>}
      {payload.steps && payload.steps.length > 0 && (
        <ol className="gadget-steps">
          {payload.steps.map((step, index) => (
            <li key={index} className={`is-${step.state}`}>
              <Icon name={STEP_ICON[step.state]} size={12} />
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={() => ({ kind: 'none' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
