import { useState } from 'react';

export interface PraxisChoiceGadgetProps {
  onSubmit: (value: string) => void;
  submittedValue?: string;
}

const OPTIONS = [
  { value: 'local', label: 'Keep local', description: 'Continue with the current Praxis host.' },
  { value: 'handoff', label: 'Handoff', description: 'Prepare this work for another AI provider.' },
  { value: 'cancel', label: 'Cancel', description: 'Leave the current work unchanged.' }
] as const;

/** Renderer-only proof that Praxis-owned choices can sit beside any provider. */
export function PraxisChoiceGadget({ onSubmit, submittedValue }: PraxisChoiceGadgetProps) {
  const [value, setValue] = useState(submittedValue ?? '');
  return (
    <section className="praxis-choice-gadget" data-testid="praxis-choice-gadget" aria-labelledby="praxis-choice-title">
      <div className="praxis-choice-gadget-kicker">Praxis gadget · proof of concept</div>
      <h3 id="praxis-choice-title">What should happen next?</h3>
      <p className="praxis-choice-gadget-question">This decision belongs to Praxis, not the AI provider.</p>
      <div className="praxis-choice-gadget-options" role="radiogroup" aria-label="Next action">
        {OPTIONS.map(option => (
          <label className={`praxis-choice-option${value === option.value ? ' is-selected' : ''}`} key={option.value}>
            <input type="radio" name="praxis-choice-proof" value={option.value} checked={value === option.value} onChange={() => setValue(option.value)} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </div>
      <button className="primary-btn praxis-choice-submit" type="button" disabled={!value || Boolean(submittedValue)} onClick={() => onSubmit(value)}>
        {submittedValue ? 'Choice recorded' : 'Continue'}
      </button>
      {submittedValue && <div className="praxis-choice-result" role="status" data-testid="praxis-choice-result">Selected: <strong>{OPTIONS.find(option => option.value === submittedValue)?.label ?? submittedValue}</strong></div>}
    </section>
  );
}
