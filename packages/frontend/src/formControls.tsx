/**
 * Shared form primitives in the SettingsPage idiom (label column + control
 * column rows, iOS-style switch). SettingsPage and NewIssuePage still carry
 * local copies of these — new forms should import from here instead; folding
 * the older copies over is deliberate follow-up, not part of this change.
 */

export function FieldRow({
  label,
  description,
  children
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field-row">
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control">{children}</div>
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
