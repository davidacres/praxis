import type { AppSettings, AppSettingsPatch } from '@praxis/core';
import { AmbientComposerHorizon } from '../ai/AmbientComposerHorizon';

const STYLES = [
  { id: 'hairline', name: 'Hairline', description: 'A single illuminated horizon, an open writing surface and quiet text controls.' },
  { id: 'classic', name: 'Classic', description: 'The original composer. A familiar framed input with all your session tools.' },
  { id: 'ambient-canvas', name: 'Ambient Canvas', description: 'Concept 5. An open canvas with a glowing horizon that follows the agent’s state.' }
] as const;

export function ComposerGallery({ settings, update }: {
  settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  return <section>
    <p className="muted">Choose a composer for every session. Applies immediately and stays independent of your colour theme.</p>
    <div className="theme-gallery-grid composer-gallery">
      {STYLES.map(style => <button type="button" key={style.id}
        data-testid={`composer-style-${style.id}`}
        className={`theme-gallery-card${(settings.appearance.composerStyle ?? 'classic') === style.id ? ' active' : ''}`}
        aria-pressed={(settings.appearance.composerStyle ?? 'classic') === style.id}
        onClick={() => void update({ appearance: { composerStyle: style.id } }).catch(() => undefined)}>
        <span className={`composer-style-preview preview-${style.id}`} aria-hidden="true">
          {style.id === 'ambient-canvas' && <AmbientComposerHorizon preview />}
          <span className="composer-preview-input">What do you want to explore?</span>
          <span className="composer-preview-tools">＋ &nbsp; Attach &nbsp; · &nbsp; Model <span>↑</span></span>
        </span>
        <span className="composer-style-copy"><strong>{style.name}</strong><span>{style.description}</span></span>
      </button>)}
    </div>
  </section>;
}
