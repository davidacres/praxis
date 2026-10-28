import { useEffect, useState } from 'react';
import type { AppSettings, AppSettingsPatch } from '@praxis/core';
import { allThemes, applyAccentColor } from './themes';

const isHexColor = (value: string): boolean => value.length === 7 && /^#[0-9a-f]{6}$/i.test(value);

export function AccentColorControl({ settings, update }: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const savedColor = settings.appearance.accentColor;
  const [draft, setDraft] = useState(savedColor);
  useEffect(() => setDraft(savedColor), [savedColor]);
  const defaultColor = allThemes().find(theme => theme.id === document.documentElement.dataset.theme)?.preview.accent ?? '#7c5cff';
  const invalid = draft !== '' && !isHexColor(draft);

  const chooseColor = async (color: string) => {
    const next = color.toLowerCase();
    setDraft(next);
    applyAccentColor(next);
    try {
      await update({ appearance: { accentColor: next } });
    } catch {
      // The settings page displays the write error; restore the saved palette.
      setDraft(savedColor);
      applyAccentColor(savedColor);
    }
  };

  return <div className="theme-accent-control">
    <div className="theme-accent-description">
      <strong>Accent colour</strong>
      <span>Use one colour across all themes and Looks.</span>
    </div>
    <div className="theme-accent-inputs">
      <input type="color" aria-label="Accent colour" data-testid="theme-accent-color"
        value={isHexColor(draft) ? draft : defaultColor} onChange={event => void chooseColor(event.target.value)} />
      <input type="text" aria-label="Accent hex colour" data-testid="theme-accent-hex" placeholder={defaultColor}
        value={draft} maxLength={7} spellCheck={false} aria-invalid={invalid}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (!invalid && draft !== savedColor) void chooseColor(draft); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      <button type="button" className="btn btn-sm" disabled={!savedColor && !draft}
        onClick={() => void chooseColor('')}>Use theme default</button>
    </div>
    {invalid && <span className="theme-accent-error" role="alert">Enter a colour as #RRGGBB.</span>}
  </div>;
}
