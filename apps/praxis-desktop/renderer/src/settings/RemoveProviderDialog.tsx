import { useEffect, useRef, useState } from 'react';
import type { AiProvider } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';

export interface RemovalReplacement {
  id: AiProvider;
  label: string;
  kind: 'api' | 'cli-agent';
  /** What new sessions would start on, or why it can't take them. */
  detail: string;
  /** Set up, on, and able to run sessions — only these can become the default. */
  usable: boolean;
}

/**
 * Remove a provider from the list. The default can only go once another
 * provider takes new sessions, so that case asks which one — pre-selecting the
 * first that can — and the button says exactly what will happen.
 */
export function RemoveProviderDialog({ provider, isDefault, remaining, busy, error, onClose, onRemove }: {
  provider: { id: AiProvider; label: string };
  isDefault: boolean;
  remaining: RemovalReplacement[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onRemove: (replacement?: AiProvider) => void;
}) {
  const [replacement, setReplacement] = useState<AiProvider | undefined>(() => remaining.find(entry => entry.usable)?.id);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const custom = provider.id.startsWith('custom:');
  const name = provider.label.replace(/\s*\(local\)$/, '');
  const chosen = remaining.find(entry => entry.id === replacement);

  return (
    <div className="modal-overlay" onMouseDown={event => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <div className="modal-card app-dialog aip-remove-dialog" role="dialog" aria-modal="true" aria-label={`Remove ${provider.label}?`}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
        }}>
        <div className="modal-header aip-remove-head">
          <span className="aip-remove-icon" aria-hidden><Icon name="warning" size={14} /></span>
          <div>
            <h3>Remove {name}?</h3>
            {isDefault && <p className="aip-muted">It’s your default, so new sessions need somewhere else to go.</p>}
          </div>
        </div>
        <div className="modal-body app-dialog-body aip-remove-body">
          {isDefault && (
            <div className="aip-remove-choice">
              <span className="aip-field-label" id="removal-replacement-label">New sessions will use</span>
              <div className="aip-radio-list" role="radiogroup" aria-labelledby="removal-replacement-label" data-testid="ai-provider-removal-replacement" data-value={replacement ?? ''}>
                {remaining.map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={replacement === entry.id}
                    disabled={!entry.usable || busy}
                    className={`aip-radio-row${replacement === entry.id ? ' is-on' : ''}`}
                    data-testid={`ai-provider-removal-replacement-${entry.id}`}
                    onClick={() => setReplacement(entry.id)}
                  >
                    <span className="aip-radio" aria-hidden />
                    <span className="aip-mark">
                      <ProviderBrandLogo provider={entry.id} size={20} decorative />
                      {entry.kind === 'cli-agent' && <span className="aip-mark-badge" aria-hidden>›_</span>}
                    </span>
                    <span className="aip-radio-text"><strong>{entry.label}</strong><span className="aip-muted">{entry.detail}</span></span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <ul className="aip-consequences">
            {custom
              ? <li><strong>Deleted:</strong> this endpoint and its saved API key.</li>
              : <li><strong>Kept:</strong> its saved credentials, model choices and tiers — add it back any time.</li>}
            <li><strong>Unaffected:</strong> session history and sessions running right now.</li>
            <li><strong>Will ask for another provider:</strong> future sessions and automations set to use {name} explicitly.</li>
          </ul>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="modal-footer app-dialog-actions">
          <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger aip-danger-solid" data-testid="ai-provider-removal-confirm"
            disabled={busy || (isDefault && !chosen?.usable)} onClick={() => onRemove(isDefault ? replacement : undefined)}>
            <Icon name="trash" size={13} />
            {busy ? 'Removing…' : isDefault && chosen ? `Remove and switch to ${chosen.label}` : 'Remove provider'}
          </button>
        </div>
      </div>
    </div>
  );
}
