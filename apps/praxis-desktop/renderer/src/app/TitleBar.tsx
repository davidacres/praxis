import { useEffect, useRef, useState } from 'react';
import type { WorkspaceRecord } from '@praxis/core';
import type { SidebarMode } from './Sidebar';
import { Icon } from '../ui/Icon';
import { PraxisWordmark } from './StartupSplash';
import {
  BoardFilterBar,
  countActiveBoardFilters,
  type BoardFilterPresentation,
  type BoardFilterValue
} from '../board/BoardFilterBar';

export interface TitleBarBoardFilter extends BoardFilterPresentation {
  value: BoardFilterValue;
  onChange: (next: BoardFilterValue) => void;
}

export interface TitleBarProps {
  appVersion?: string;
  contextLabel: string;
  contextDetail: string;
  workspaces?: WorkspaceRecord[];
  activeWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onSaveWorkspace?: () => void;
  onOpenWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  onNewSession?: () => void;
  /** Opens a session composer pre-set for a quick, workflow-driven session. */
  onQuickSession?: () => void;
  onNewProject?: () => void;
  onAddExistingProject?: () => void;
  onImportProjects?: () => void;
  mode?: SidebarMode;
  onToggleMode?: () => void;
  onModeChange?: (mode: SidebarMode) => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  auxVisible: boolean;
  onToggleAux: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  focusModeAvailable?: boolean;
  canGoBack: boolean;
  onBack: () => void;
  canGoForward: boolean;
  onForward: () => void;
  boardFilter?: TitleBarBoardFilter;
  onOpenWhatsNew: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}

/**
 * The app's only chrome. The native frame and menubar are disabled in the main
 * process, so this bar owns dragging (via `-webkit-app-region`) and the caption
 * buttons. Every interactive child opts back out of dragging through
 * `.icon-btn` / `.titlebar-group`.
 */
export function TitleBar({
  appVersion,
  contextLabel,
  contextDetail,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onDeleteWorkspace,
  onCreateWorkspace,
  onSaveWorkspace,
  onOpenWorkspace,
  onCloseWorkspace,
  onNewSession,
  onQuickSession,
  onNewProject,
  onAddExistingProject,
  onImportProjects,
  mode = 'classic',
  onToggleMode,
  onModeChange,
  sidebarVisible,
  onToggleSidebar,
  auxVisible,
  onToggleAux,
  panelVisible,
  onTogglePanel,
  focusMode: explicitFocusMode,
  onToggleFocusMode,
  focusModeAvailable = false,
  canGoBack,
  onBack,
  canGoForward,
  onForward,
  boardFilter,
  onOpenWhatsNew,
  settingsOpen,
  onOpenSettings
}: TitleBarProps) {
  const isFocusMode = explicitFocusMode ?? (!sidebarVisible && !auxVisible && !panelVisible);
  const [maximized, setMaximized] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const contextButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const newMenuRef = useRef<HTMLDivElement | null>(null);
  // macOS renders the native traffic lights on top of the page (see
  // `trafficLightPosition` in the main process) rather than in the DOM, so
  // nothing here reserves space for them by default, so the title bar keeps a
  // leading inset even though all layout toggles now live together at right.
  const isMac = navigator.platform.toLowerCase().includes('mac');

  const activeWorkspace = workspaces?.find(w => w.id === activeWorkspaceId);
  const newProjectEnabled = Boolean(activeWorkspaceId);

  useEffect(() => {
    if (!workspaceMenuOpen && !newMenuOpen) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (workspaceMenuOpen && !workspaceMenuRef.current?.contains(target)) {
        setWorkspaceMenuOpen(false);
      }
      if (newMenuOpen && !newMenuRef.current?.contains(target)) {
        setNewMenuOpen(false);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false);
        setNewMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [workspaceMenuOpen, newMenuOpen]);

  useEffect(() => {
    void window.praxis.window.isMaximized().then(setMaximized);
    return window.praxis.window.onMaximizeChange(setMaximized);
  }, []);

  useEffect(() => {
    void window.praxis.window.getZoomFactor().then(setZoomFactor);
    return window.praxis.window.onZoomChange(setZoomFactor);
  }, []);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void window.praxis.window.reload();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === '0') {
        event.preventDefault();
        resetZoom();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        changeZoom(0.1);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        changeZoom(-0.1);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [zoomFactor]);

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
  const changeZoom = (amount: number) => {
    void window.praxis.window.setZoomFactor(zoomFactor + amount).then(setZoomFactor);
  };
  const resetZoom = () => {
    void window.praxis.window.setZoomFactor(1).then(setZoomFactor);
  };

  return (
    <header className={`titlebar${isMac ? ' titlebar-mac' : ''}`}>
      <div className="titlebar-group titlebar-header-group">
        <div className="workspace-switcher" ref={workspaceMenuRef}>
          <button
            className="workspace-switcher-button"
            aria-expanded={workspaceMenuOpen}
            aria-label="Select workspace"
            onClick={() => setWorkspaceMenuOpen(open => !open)}
          >
            <span className="workspace-switcher-mark"><Icon name="organization" size={14} /></span>
            <span className="workspace-switcher-name">{activeWorkspace?.name ?? 'All projects'}</span>
            <Icon name="chevron-down" size={13} />
          </button>
          {workspaceMenuOpen && (
            <div className="workspace-menu" role="menu">
              {workspaces?.map(workspace => (
                <div key={workspace.id} role="none" className="workspace-menu-row">
                  <button
                    role="menuitem"
                    className={`workspace-menu-select${workspace.id === activeWorkspaceId ? ' active' : ''}`}
                    onClick={() => { onSelectWorkspace?.(workspace.id); setWorkspaceMenuOpen(false); }}
                  >
                    <Icon name="organization" size={13} /><span>{workspace.name}</span>
                  </button>
                  <small className="workspace-menu-count">{workspace.projectIds.length}</small>
                  {onDeleteWorkspace && (
                    <button
                      type="button"
                      className="workspace-menu-delete"
                      aria-label={`Delete workspace ${workspace.name}`}
                      title="Delete workspace"
                      onClick={() => onDeleteWorkspace(workspace.id)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
              ))}
              <div className="workspace-menu-divider" />
              {onCreateWorkspace && (
                <button role="menuitem" onClick={() => { onCreateWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="plus" size={13} /><span>Create blank workspace</span>
                </button>
              )}
              {onCloseWorkspace && (
                <button role="menuitem" onClick={() => { onCloseWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="organization" size={13} /><span>Create New Workspace</span>
                </button>
              )}
              {activeWorkspace && onSaveWorkspace && (
                <button role="menuitem" onClick={() => { onSaveWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="archive" size={13} /><span>Save to file</span>
                </button>
              )}
              {onOpenWorkspace && (
                <button role="menuitem" onClick={() => { onOpenWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="folder-open" size={13} /><span>Open workspace file</span>
                </button>
              )}
              {activeWorkspace && onCloseWorkspace && (
                <button role="menuitem" className="workspace-menu-close" onClick={() => { onCloseWorkspace(); setWorkspaceMenuOpen(false); }}>
                  <Icon name="close" size={13} /><span>Close workspace</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="new-menu-anchor" ref={newMenuRef}>
          <button
            className="new-pill new-pill-icon"
            aria-label="New"
            title="New (Ctrl+N)"
            onClick={() => setNewMenuOpen(open => !open)}
            data-testid="new-menu"
          >
            <Icon name="plus" size={13} />
          </button>
          {newMenuOpen && (
            <div className="new-menu" role="menu">
              {newProjectEnabled && onNewProject && (
                <button role="menuitem" data-testid="new-project" onClick={() => { setNewMenuOpen(false); onNewProject(); }}>
                  <Icon name="plus" size={14} />
                  <span><strong>Create New Project</strong><small>Start fresh with a brief and board</small></span>
                </button>
              )}
              {newProjectEnabled && onAddExistingProject && (
                <button role="menuitem" data-testid="add-existing-project" onClick={() => { setNewMenuOpen(false); onAddExistingProject(); }}>
                  <Icon name="folder-open" size={14} />
                  <span><strong>Create from existing folder</strong><small>Scan plans and connect them to a project</small></span>
                </button>
              )}
              {newProjectEnabled && onImportProjects && (
                <button role="menuitem" data-testid="import-projects" onClick={() => { setNewMenuOpen(false); onImportProjects(); }}>
                  <Icon name="markdown" size={14} />
                  <span><strong>Import plans folders</strong><small>Turn several folders of markdown plans into projects</small></span>
                </button>
              )}
              {onNewSession && (
                <button role="menuitem" data-testid="new-session" onClick={() => { setNewMenuOpen(false); onNewSession(); }}>
                  <Icon name="robot" size={14} />
                  <span><strong>New Session</strong><small>Start an AI session in this workspace</small></span>
                </button>
              )}
            </div>
          )}
        </div>

        {onQuickSession && (
          <button
            className="new-pill new-pill-icon"
            aria-label="Quick session"
            title="Quick session (Ctrl+Shift+N)"
            data-testid="quick-session"
            onClick={onQuickSession}
          >
            <Icon name="zap" size={13} />
          </button>
        )}

        <button
          className="icon-btn icon-btn-sm"
          aria-label={mode === 'classic' ? 'Switch to Work mode' : 'Switch to Classic mode'}
          title={mode === 'classic' ? 'Classic mode (click to switch to Work mode)' : 'Work mode (click to switch to Classic mode)'}
          onClick={() => {
            if (onToggleMode) {
              onToggleMode();
            } else if (onModeChange) {
              onModeChange(mode === 'classic' ? 'work' : 'classic');
            }
          }}
          data-testid={mode === 'classic' ? 'mode-work' : 'mode-classic'}
        >
          <Icon name={mode === 'classic' ? 'columns' : 'robot'} size={14} />
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
        <span className="titlebar-logo">
          <PraxisWordmark className="praxis-wordmark" />
        </span>
        {appVersion && <span className="titlebar-version">v{appVersion}</span>}
      </div>

      <div className="titlebar-spacer" />

      <div className="titlebar-group titlebar-layout-toggles">
        <button
          className={`icon-btn${sidebarVisible ? ' active' : ''}`}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarVisible}
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar-left" />
        </button>
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
        {focusModeAvailable && (
          <button
            className={`icon-btn${isFocusMode ? ' active' : ''}`}
            aria-label="Toggle focus mode"
            title="Toggle focus mode"
            aria-pressed={isFocusMode}
            onClick={onToggleFocusMode}
            data-testid="toggle-focus-mode"
          >
            <Icon name="layout-focus" />
          </button>
        )}
        <div className="titlebar-zoom-controls" data-testid="titlebar-zoom-controls" aria-label="Application zoom">
          <button
            className="icon-btn icon-btn-sm"
            data-testid="titlebar-zoom-out"
            aria-label="Zoom out application"
            title="Zoom out (⌘− / Ctrl−)"
            onClick={() => changeZoom(-0.1)}
          >
            <Icon name="zoom-out" size={13} />
          </button>
          <button
            className="titlebar-zoom-value"
            data-testid="titlebar-zoom-reset"
            aria-label={`Reset application zoom, currently ${Math.round(zoomFactor * 100)} percent`}
            title="Reset application zoom (⌘0 / Ctrl+0)"
            onClick={resetZoom}
          >
            {Math.round(zoomFactor * 100)}%
          </button>
          <button
            className="icon-btn icon-btn-sm"
            data-testid="titlebar-zoom-in"
            aria-label="Zoom in application"
            title="Zoom in (⌘+ / Ctrl+)"
            onClick={() => changeZoom(0.1)}
          >
            <Icon name="zoom-in" size={13} />
          </button>
        </div>
        <button
          className="icon-btn"
          aria-label="Reload window"
          title="Reload window (⌘R / Ctrl+R)"
          data-testid="titlebar-reload"
          onClick={() => void window.praxis.window.reload()}
        >
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" aria-label="What's new" title="What's new" onClick={onOpenWhatsNew}>
          <Icon name="sparkles" />
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
      </div>

      {/* macOS already has the native traffic lights (see `titleBarStyle`/
          `trafficLightPosition` in the main process) — these Windows-style
          caption buttons would just duplicate them. */}
      {!isMac && (
        <div className="caption-controls">
          <button
            className="caption-btn"
            aria-label="Minimize"
            onClick={() => void window.praxis.window.minimize()}
          >
            <Icon name="window-minimize" size={12} strokeWidth={1} />
          </button>
          <button
            className="caption-btn"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.praxis.window.toggleMaximize()}
          >
            <Icon name={maximized ? 'window-restore' : 'window-maximize'} size={12} strokeWidth={1} />
          </button>
          <button
            className="caption-btn caption-close"
            aria-label="Close window"
            onClick={() => void window.praxis.window.close()}
          >
            <Icon name="window-close" size={12} strokeWidth={1} />
          </button>
        </div>
      )}
    </header>
  );
}
