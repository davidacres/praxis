import { useState } from 'react';
import type { ConflictGadgetPayload, GadgetActionValue } from '@praxis/core';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

type Side = 'ours' | 'theirs';

/**
 * Pick a side, per conflict.
 *
 * Praxis never preselects. Defaulting to "ours" would let a user approve the
 * whole set without reading it and silently discard the other side — so the
 * submit button stays disabled until every conflict has been answered
 * deliberately, and the count says how many are left.
 */
export function ConflictGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'conflict'>(gadget) as ConflictGadgetPayload;
  const [choices, setChoices] = useState<Record<string, Side>>({});
  const unresolved = payload.conflicts.filter(conflict => !choices[conflict.id]);

  const value = (): GadgetActionValue | undefined =>
    unresolved.length > 0 ? undefined : { kind: 'form', fields: { ...choices } };

  return (
    <>
      <GadgetHeading title={payload.title} detail={payload.description} id={`${gadget.gadgetId}-title`} />
      <ul className="gadget-conflicts">
        {payload.conflicts.map(conflict => {
          const groupId = `${gadget.gadgetId}-${conflict.id}`;
          return (
            <li key={conflict.id}>
              <p className="gadget-conflict-label" id={`${groupId}-label`}>
                {conflict.label}
                {conflict.path && <code className="gadget-conflict-path">{conflict.path}</code>}
              </p>
              <div className="gadget-conflict-sides" role="radiogroup" aria-labelledby={`${groupId}-label`}>
                {(['ours', 'theirs'] as const).map(side => (
                  <label
                    key={side}
                    className={`gadget-conflict-side${choices[conflict.id] === side ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={groupId}
                      value={side}
                      checked={choices[conflict.id] === side}
                      disabled={!actionable}
                      onChange={() => setChoices(current => ({ ...current, [conflict.id]: side }))}
                    />
                    <span className="gadget-conflict-side-head">{side === 'ours' ? 'Ours' : 'Theirs'}</span>
                    <pre>{side === 'ours' ? conflict.ours : conflict.theirs}</pre>
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={value}
        blockedReason={() =>
          unresolved.length > 0
            ? `${unresolved.length} conflict${unresolved.length === 1 ? '' : 's'} still to resolve.`
            : undefined
        }
        onSubmit={onSubmit}
      />
    </>
  );
}
