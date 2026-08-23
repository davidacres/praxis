import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ThemeSwitcher } from './ThemeSwitcher';

export interface TitleBarProps {
  contextLabel: string;
  contextDetail: string;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  auxVisible: boolean;
  onToggleAux: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
  canGoBack: boolean;
  onBack: () => void;
  canGoForward: boolean;
  onForward: () => void;
}

/**
 * The app's only chrome. The native frame and menubar are disabled in the main
 * process, so this bar owns dragging (via `-webkit-app-region`) and the caption
 * buttons. Every interactive child opts back out of dragging through
 * `.icon-btn` / `.titlebar-group`.
 */
export function TitleBar({
  contextLabel,
  contextDetail,
  sidebarVisible,
  onToggleSidebar,
  auxVisible,
  onToggleAux,
  panelVisible,
  onTogglePanel,
  canGoBack,
  onBack,
  canGoForward,
  onForward
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement | null>(null);
  // macOS renders the native traffic lights on top of the page (see
  // `trafficLightPosition` in the main process) rather than in the DOM, so
  // nothing here reserves space for them by default — the leading button
  // group needs an explicit inset to sit beside them instead of under them.
  const isMac = navigator.platform.toLowerCase().includes('mac');

  useEffect(() => {
    void window.ticketManager.window.isMaximized().then(setMaximized);
    return window.ticketManager.window.onMaximizeChange(setMaximized);
  }, []);

  useEffect(() => {
    if (!themeOpen) {
      return;
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!themeRef.current?.contains(event.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [themeOpen]);

  return (
    <header className={`titlebar${isMac ? ' titlebar-mac' : ''}`}>
      <div className="titlebar-group">
        <button
          className={`icon-btn${sidebarVisible ? ' active' : ''}`}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarVisible}
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar-left" />
        </button>
      </div>

      <div className="titlebar-spacer" />

      {/* Back / forward sit against the context pill, and the whole block is
          centred on the window rather than between the two side groups. */}
      <div className="titlebar-group titlebar-center">
        <button className="icon-btn" aria-label="Back" disabled={!canGoBack} onClick={onBack}>
          <Icon name="arrow-left" />
        </button>
        <button
          className="icon-btn"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <Icon name="arrow-right" />
        </button>

        <div
          className="titlebar-context"
          data-testid="titlebar-context"
          title={`${contextLabel} · ${contextDetail}`}
        >
          <Icon name="ticket" size={13} />
          <span>{contextLabel}</span>
          <span className="titlebar-context-sep">·</span>
          <span>{contextDetail}</span>
        </div>

        <button className="icon-btn" aria-label="Run">
          <Icon name="play" size={13} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Run options">
          <Icon name="chevron-down" size={13} />
        </button>
        <span className="titlebar-logo" aria-hidden="true">
          <Icon name="ticket" size={15} />
        </span>
      </div>

      <div className="titlebar-spacer" />

      <div className="titlebar-group">
        <button
          className={`icon-btn${panelVisible ? ' active' : ''}`}
          aria-label="Toggle panel"
          aria-pressed={panelVisible}
          onClick={onTogglePanel}
        >
          <Icon name="panel-bottom" />
        </button>
        <button
          className={`icon-btn${auxVisible ? ' active' : ''}`}
          aria-label="Toggle secondary sidebar"
          aria-pressed={auxVisible}
          onClick={onToggleAux}
        >
          <Icon name="sidebar-right" />
        </button>
        <button className="icon-btn" aria-label="Remote">
          <Icon name="radio-tower" />
        </button>

        <div ref={themeRef}>
          <button
            className={`icon-btn${themeOpen ? ' active' : ''}`}
            aria-label="Theme"
            aria-expanded={themeOpen}
            onClick={() => setThemeOpen(open => !open)}
          >
            <span className="theme-orb" />
          </button>
          {themeOpen && (
            <div className="popover" role="dialog" aria-label="Theme">
              <div className="popover-label">Appearance</div>
              <ThemeSwitcher />
            </div>
          )}
        </div>
      </div>

      {/* macOS already has the native traffic lights (see `titleBarStyle`/
          `trafficLightPosition` in the main process) — these Windows-style
          caption buttons would just duplicate them. */}
      {!isMac && (
        <div className="caption-controls">
          <button
            className="caption-btn"
            aria-label="Minimize"
            onClick={() => void window.ticketManager.window.minimize()}
          >
            <Icon name="window-minimize" size={12} strokeWidth={1} />
          </button>
          <button
            className="caption-btn"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.ticketManager.window.toggleMaximize()}
          >
            <Icon name={maximized ? 'window-restore' : 'window-maximize'} size={12} strokeWidth={1} />
          </button>
          <button
            className="caption-btn caption-close"
            aria-label="Close window"
            onClick={() => void window.ticketManager.window.close()}
          >
            <Icon name="window-close" size={12} strokeWidth={1} />
          </button>
        </div>
      )}
    </header>
  );
}
