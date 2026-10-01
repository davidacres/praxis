import type { ReasoningEffort } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { REASONING_EFFORT_LEVELS } from './modelProviders';

const formatReasoningEffort = (value: ReasoningEffort) => value[0].toUpperCase() + value.slice(1);

export function ReasoningEffortSlider({
  value,
  onChange,
  disabled = false,
  testId
}: {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  disabled?: boolean;
  testId: string;
}) {
  const label = formatReasoningEffort(value);
  return (
    <label
      className="composer-reasoning-slider"
      data-testid={testId}
      data-value={value}
      title={`Reasoning effort: ${label}`}
    >
      <Icon name="lightbulb" size={14} />
      <input
        type="range"
        min="0"
        max={REASONING_EFFORT_LEVELS.length - 1}
        step="1"
        value={REASONING_EFFORT_LEVELS.indexOf(value)}
        aria-label={`Reasoning effort: ${label}`}
        disabled={disabled}
        onChange={event => onChange(REASONING_EFFORT_LEVELS[Number(event.target.value)] ?? 'medium')}
      />
      <span className="composer-reasoning-dots" aria-hidden="true">
        {REASONING_EFFORT_LEVELS.map(level => <i key={level} className={level === value ? 'active' : undefined} />)}
      </span>
    </label>
  );
}
