import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Small form building blocks shared by the Settings pages: a labelled field row,
 * an on/off toggle row, and text inputs that commit after typing pauses.
 */

export function FieldRow({
  label,
  description,
  children,
  stacked
}: {
  label: string;
  description?: string;
  children: ReactNode;
  /** Label and help above, control below at full width — for a control that needs room (several inputs). */
  stacked?: boolean;
}) {
  return (
    <div className={`settings-field-row${stacked ? ' settings-field-row--stacked' : ''}`}>
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control settings-field-control--field">{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  testId
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className={`settings-toggle-row${disabled ? ' disabled' : ''}`}>
      <div className="settings-toggle-text">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        disabled={disabled}
        data-testid={testId}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export interface DebouncedTextFieldProps {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  delayMs?: number;
}

/** Multi-line variant of DebouncedTextField (e.g. the analysis system prompt). */
export function DebouncedTextArea({ ariaLabel, value, placeholder, onCommit, delayMs = 600 }: DebouncedTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const schedule = (next: string) => {
    setDraft(next);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => onCommit(next), delayMs);
  };
  return (
    <textarea
      className="textarea"
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      rows={4}
      onChange={event => schedule(event.target.value)}
      style={{ width: '100%' }}
    />
  );
}

export function DebouncedTextField({ ariaLabel, value, placeholder, onCommit, delayMs = 400 }: DebouncedTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const schedule = (next: string) => {
    setDraft(next);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => onCommit(next), delayMs);
  };
  return (
    <input
      type="text"
      className="input"
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={event => schedule(event.target.value)}
      style={{ width: '100%' }}
    />
  );
}
