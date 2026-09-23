import { useState } from 'react';
import type { FormGadgetPayload, GadgetActionValue } from '@praxis/core';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';
import { ChipSelect } from '../../../ui/ChipSelect';

type FieldValue = string | number | boolean;

/**
 * Structured input, when a decision needs more than a button.
 *
 * Required-field checking is duplicated here and in core on purpose: this copy
 * keeps the submit button honest before a round trip, and core's copy is the
 * one that actually decides — a renderer is never the authority on validity.
 */
export function FormGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'form'>(gadget) as FormGadgetPayload;
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {};
    for (const field of payload.fields) {
      if (field.defaultValue !== undefined) initial[field.name] = field.defaultValue;
      else if (field.type === 'boolean') initial[field.name] = false;
    }
    return initial;
  });

  const set = (name: string, value: FieldValue) => setValues(current => ({ ...current, [name]: value }));

  const missing = payload.fields.filter(field => {
    if (!field.required) return false;
    const value = values[field.name];
    return value === undefined || value === '';
  });

  const value = (): GadgetActionValue | undefined => (missing.length > 0 ? undefined : { kind: 'form', fields: values });

  return (
    <>
      <GadgetHeading title={payload.title} detail={payload.description} id={`${gadget.gadgetId}-title`} />
      <div className="gadget-form">
        {payload.fields.map(field => {
          const id = `${gadget.gadgetId}-${field.name}`;
          const describedBy = field.help ? `${id}-help` : undefined;
          const current = values[field.name];
          return (
            <div className="gadget-field" key={field.name}>
              {field.type === 'boolean' ? (
                <label className="gadget-field-check" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={current === true}
                    disabled={!actionable}
                    aria-describedby={describedBy}
                    onChange={event => set(field.name, event.target.checked)}
                  />
                  <span>{field.label}</span>
                </label>
              ) : (
                <>
                  <label className="gadget-field-label" htmlFor={id}>
                    {field.label}
                    {field.required && <span className="gadget-field-required" aria-hidden="true"> *</span>}
                  </label>
                  {field.type === 'select' ? (
                    <ChipSelect
                      block
                      id={id}
                      ariaLabel={field.label}
                      value={typeof current === 'string' ? current : ''}
                      disabled={!actionable}
                      aria-describedby={describedBy}
                      onChange={value => set(field.name, value)}
                      options={[
                        { value: '', label: 'Choose…' },
                        ...(field.options ?? []).map(option => ({
                          value: option.value,
                          label: option.label,
                          disabled: Boolean(option.disabledReason),
                          description: option.disabledReason
                        }))
                      ]}
                    />
                  ) : field.type === 'textarea' ? (
                    <textarea
                      id={id}
                      className="textarea"
                      // A whole ticket description is not a three-line note: size the box to what it holds.
                      rows={Math.min(18, Math.max(3, (typeof current === 'string' ? current.split('\n').length : 1) + 1))}
                      value={typeof current === 'string' ? current : ''}
                      placeholder={field.placeholder}
                      maxLength={field.maxLength}
                      disabled={!actionable}
                      required={field.required}
                      aria-describedby={describedBy}
                      onChange={event => set(field.name, event.target.value)}
                    />
                  ) : (
                    <input
                      id={id}
                      className="input"
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={current === undefined ? '' : String(current)}
                      placeholder={field.placeholder}
                      maxLength={field.type === 'text' ? field.maxLength : undefined}
                      min={field.min}
                      max={field.max}
                      disabled={!actionable}
                      required={field.required}
                      aria-describedby={describedBy}
                      onChange={event =>
                        set(field.name, field.type === 'number' ? event.target.valueAsNumber : event.target.value)
                      }
                    />
                  )}
                </>
              )}
              {field.help && (
                <p className="gadget-field-help" id={`${id}-help`}>
                  {field.help}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={value}
        blockedReason={() =>
          missing.length > 0 ? `Still needed: ${missing.map(field => field.label).join(', ')}.` : undefined
        }
        onSubmit={onSubmit}
      />
    </>
  );
}
