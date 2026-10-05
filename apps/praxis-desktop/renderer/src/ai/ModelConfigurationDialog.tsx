import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AiProvider } from '@praxis/core';
import { useSettings } from '../settings/useSettings';
import { ModelManagerPanel } from './ModelManagerPanel';
import { providerLabel } from './modelProviders';

/** Provider-specific model curation without leaving the conversation composer. */
export function ModelConfigurationDialog({ providerId, onClose }: { providerId: AiProvider; onClose: () => void }) {
  const { settings, update } = useSettings();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return createPortal(
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className="modal-card model-configuration-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${providerLabel(providerId)} model configuration`}
        data-testid="model-configuration-dialog"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
          if (event.key !== 'Tab') return;
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        {settings && <ModelManagerPanel
          key={providerId}
          chipLayout
          providerId={providerId}
          providerLabel={providerLabel(providerId)}
          enabledModelIds={settings.ai.providers[providerId]?.enabledModelIds}
          providerConfig={settings.ai.providers[providerId] ?? {}}
          tiers={settings.ai.modelTiers?.[providerId] ?? {}}
          onTiersChange={tiers => void update({ ai: { modelTiers: { ...settings.ai.modelTiers, [providerId]: tiers } } })}
          onBack={onClose}
          update={update}
        />}
      </section>
    </div>,
    document.body
  );
}
