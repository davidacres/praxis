import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import {
  BoardFilterBar,
  countActiveBoardFilters,
  type BoardFilterPresentation,
  type BoardFilterValue
} from './BoardFilterBar';

export interface TitleBarBoardFilter extends BoardFilterPresentation {
  value: BoardFilterValue;
  onChange: (next: BoardFilterValue) => void;
}

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
  boardFilter?: TitleBarBoardFilter;
  onOpenWhatsNew: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onOpenThemes: () => void;
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
  onForward,
  boardFilter,
  onOpenWhatsNew,
  settingsOpen,
  onOpenSettings,
  onOpenThemes
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const contextButtonRef = useRef<HTMLButtonElement | null>(null);
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
    if (!filterOpen) {
      return;
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFilterOpen(false);
        contextButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!boardFilter) {
      setFilterOpen(false);
    }
  }, [boardFilter]);

  useEffect(() => {
    if (filterOpen) {
      requestAnimationFrame(() => {
        filterRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      });
    }
  }, [filterOpen]);

  const activeFilterCount = boardFilter ? countActiveBoardFilters(boardFilter.value) : 0;

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

        {boardFilter ? (
          <div className="titlebar-context-wrap" ref={filterRef}>
            <button
              ref={contextButtonRef}
              type="button"
              className={`titlebar-context titlebar-context-button${filterOpen ? ' active' : ''}`}
              data-testid="titlebar-context"
              title={`Filter issues on ${contextLabel}`}
              aria-label={`Filter issues on ${contextLabel}`}
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen(open => !open)}
            >
              <Icon name="ticket" size={13} />
              <span className="titlebar-context-label">{contextLabel}</span>
              <span className="titlebar-context-sep">·</span>
              <span className="titlebar-context-detail">{contextDetail}</span>
              {activeFilterCount > 0 && (
                <span className="titlebar-filter-badge" data-testid="titlebar-filter-count">
                  {activeFilterCount}
                </span>
              )}
              <Icon name={filterOpen ? 'chevron-up' : 'chevron-down'} size={11} />
            </button>
            <div
              className="titlebar-filter-popover"
              data-testid="titlebar-filter-popover"
              role="dialog"
              aria-label={`Filter issues on ${contextLabel}`}
              hidden={!filterOpen}
            >
              <div className="titlebar-filter-heading">
                <span>Filter issues</span>
                <span>{contextLabel}</span>
              </div>
              <BoardFilterBar
                value={boardFilter.value}
                onChange={boardFilter.onChange}
                statusOptions={boardFilter.statusOptions}
                issueTypeOptions={boardFilter.issueTypeOptions}
                parentOptions={boardFilter.parentOptions}
                shown={boardFilter.shown}
                total={boardFilter.total}
                active={filterOpen}
              />
            </div>
          </div>
        ) : (
          <div
            className="titlebar-context"
            data-testid="titlebar-context"
            title={`${contextLabel} · ${contextDetail}`}
          >
            <Icon name="ticket" size={13} />
            <span className="titlebar-context-label">{contextLabel}</span>
            <span className="titlebar-context-sep">·</span>
            <span className="titlebar-context-detail">{contextDetail}</span>
          </div>
        )}

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
        <button
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          data-testid="titlebar-settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Icon name="gear" />
        </button>
        <button className="icon-btn" aria-label="What's new" title="What's new" onClick={onOpenWhatsNew}>
          <Icon name="sparkles" />
        </button>
        <button className="icon-btn" aria-label="Remote">
          <Icon name="radio-tower" />
        </button>

        <button
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          aria-label="Themes"
          aria-haspopup="dialog"
          data-testid="titlebar-themes"
          onClick={onOpenThemes}
        >
          <span className="theme-orb" />
        </button>
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
