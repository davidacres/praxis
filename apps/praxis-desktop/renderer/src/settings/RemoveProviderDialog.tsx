import { useEffect, useRef, useState } from 'react';
import type { AiProvider } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';

export function RemoveProviderDialog({ provider, isDefault, remaining, busy, error, onClose, onRemove }: {
  provider: { id: AiProvider; label: string };
  isDefault: boolean;
  remaining: Array<{ id: AiProvider; label: string }>;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onRemove: (replacement?: AiProvider) => void;
}) {
  const [replacement, setReplacement] = useState<AiProvider>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div className="modal-overlay" onMouseDown={event => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <div className="modal-card app-dialog" role="dialog" aria-modal="true" aria-label={`Remove ${provider.label}?`}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
        }}>
        <div className="modal-header"><h3>Remove {provider.label}?</h3></div>
        <div className="modal-body app-dialog-body">
          <p className="app-dialog-message">{provider.id.startsWith('custom:')
            ? 'This endpoint and its saved API key will be deleted.'
            : 'This provider will be removed from your list and turned off. Its saved credentials and connection settings are kept so you can add it again.'}</p>
          <p className="settings-hint">Session history is kept. Running sessions continue; future sessions and automations explicitly using this provider will need another provider.</p>
          {isDefault && <label>Replacement default
            <ChipSelect block ariaLabel="Replacement default" data-testid="ai-provider-removal-replacement"
              value={replacement ?? ''} placeholder="Choose a provider"
              options={remaining.map(meta => ({ value: meta.id, label: meta.label }))}
              onChange={value => setReplacement(value as AiProvider)} />
          </label>}
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="modal-footer app-dialog-actions">
          <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger" data-testid="ai-provider-removal-confirm"
            disabled={busy || (isDefault && !replacement)} onClick={() => onRemove(replacement)}>
            <Icon name="trash" size={13} />{busy ? 'Removing…' : 'Remove provider'}
          </button>
        </div>
      </div>
    </div>
  );
}
