import { useState } from 'react';
import type { ChoiceGadgetPayload, GadgetActionValue } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

/**
 * A decision Praxis owns, rendered beside the provider's prose.
 *
 * Single-select uses native radios and multi-select native checkboxes rather
 * than styled `div`s, so keyboard navigation, grouping and screen-reader
 * semantics come from the platform instead of being reimplemented.
 */
export function ChoiceGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'choice'>(gadget) as ChoiceGadgetPayload;
  const multiple = payload.multiple === true;
  const [selected, setSelected] = useState<string[]>(payload.defaultValue ? [payload.defaultValue] : []);
  const titleId = `${gadget.gadgetId}-title`;

  // Once answered, the decision is a fact, not a control: collapse to the
  // chosen option(s) so the transcript reads as what was picked, not as a
  // form that still looks askable.
  const answered = gadget.answer?.kind === 'choice' || gadget.answer?.kind === 'selection' ? gadget.answer : undefined;
  if (answered) {
    const picked = answered.kind === 'choice' ? [answered.selected] : answered.selected;
    const labels = picked.map(value => payload.options.find(option => option.value === value)?.label ?? value);
    return (
      <div className="gadget-answered" data-testid="gadget-answered">
        <span className="gadget-answered-question" id={titleId}>
          {payload.question}
        </span>
        <span className="gadget-answered-value">
          <Icon name="check" size={12} />
          {labels.join(', ')}
        </span>
      </div>
    );
  }

  const toggle = (value: string) => {
    setSelected(current => {
      if (!multiple) return [value];
      return current.includes(value) ? current.filter(entry => entry !== value) : [...current, value];
    });
  };

  const value = (): GadgetActionValue | undefined => {
    if (selected.length === 0) return undefined;
    return multiple ? { kind: 'selection', selected } : { kind: 'choice', selected: selected[0] };
  };

  return (
    <>
      <GadgetHeading title={payload.question} detail={payload.detail} id={titleId} />
      <div className="gadget-options" role={multiple ? 'group' : 'radiogroup'} aria-labelledby={titleId}>
        {payload.options.map(option => {
          const checked = selected.includes(option.value);
          const unavailable = Boolean(option.disabledReason);
          return (
            <label
              key={option.value}
              className={`gadget-option${checked ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}
            >
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={`${gadget.gadgetId}-choice`}
                value={option.value}
                checked={checked}
                disabled={!actionable || unavailable}
                onChange={() => toggle(option.value)}
              />
              <span className="gadget-option-body">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
                {/* An unavailable option stays visible with its reason — hiding
                    it would leave the user wondering what happened to it. */}
                {option.disabledReason && <em className="gadget-option-blocked">Unavailable: {option.disabledReason}</em>}
              </span>
            </label>
          );
        })}
      </div>
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={value}
        blockedReason={() => (selected.length === 0 ? 'Select an option first.' : undefined)}
        onSubmit={onSubmit}
      />
    </>
  );
}
