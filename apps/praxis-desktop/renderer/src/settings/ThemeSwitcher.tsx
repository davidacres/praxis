import { useState } from 'react';

type Mode = 'light' | 'dark';
type Accent = 'violet' | 'blue';

const ACCENT_COLORS: Record<Accent, string> = {
  violet: '#7c5cff',
  blue: '#007acc'
};

function applyMode(mode: Mode): void {
  document.documentElement.setAttribute('data-mode', mode);
  localStorage.setItem('tm-theme-mode', mode);
}

function applyAccent(accent: Accent): void {
  document.documentElement.setAttribute('data-accent', accent);
  localStorage.setItem('tm-theme-accent', accent);
}

export function ThemeSwitcher() {
  const [mode, setMode] = useState<Mode>(
    (document.documentElement.getAttribute('data-mode') as Mode) ?? 'light'
  );
  const [accent, setAccent] = useState<Accent>(
    (document.documentElement.getAttribute('data-accent') as Accent) ?? 'violet'
  );

  const chooseMode = (next: Mode) => {
    applyMode(next);
    setMode(next);
  };

  const chooseAccent = (next: Accent) => {
    applyAccent(next);
    setAccent(next);
  };

  return (
    <div className="theme-switcher">
      <div className="theme-switcher-group">
        <button
          aria-label="Light mode"
          className={`theme-mode-btn ${mode === 'light' ? 'active' : ''}`}
          onClick={() => chooseMode('light')}
        >
          ☀
        </button>
        <button
          aria-label="Dark mode"
          className={`theme-mode-btn ${mode === 'dark' ? 'active' : ''}`}
          onClick={() => chooseMode('dark')}
        >
          ☾
        </button>
      </div>
      <div className="theme-switcher-group">
        {(Object.keys(ACCENT_COLORS) as Accent[]).map(key => (
          <button
            key={key}
            aria-label={`${key} accent`}
            className={`theme-accent-dot ${accent === key ? 'active' : ''}`}
            style={{ background: ACCENT_COLORS[key] }}
            onClick={() => chooseAccent(key)}
          />
        ))}
      </div>
    </div>
  );
}
