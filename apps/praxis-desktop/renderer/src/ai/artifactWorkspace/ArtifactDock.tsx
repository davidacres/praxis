import { useEffect, useState, useMemo } from 'react';
import { Icon } from '../../ui/Icon';
import { highlightCode, languageFor } from '../../ui/codeHighlight';
import { ArtifactPreview, isImageArtifact } from './ArtifactPreview';
import { ArtifactCodeSurface } from './ArtifactCodeSurface';
import {
  type ActiveArtifact,
  type ArtifactViewMode,
  type ArtifactLayoutPrototype,
  ARTIFACT_LAYOUT_PROTOTYPES
} from './artifactTypes';

export interface ArtifactDockProps {
  artifact?: ActiveArtifact;
  sessionId?: string;
  onClose: () => void;
  maximized?: boolean;
  onToggleMaximize?: () => void;
  onPopOut?: (artifact: ActiveArtifact) => void;
}

function getIconForArtifact(artifact: ActiveArtifact) {
  const ext = artifact.path.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'globe';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext ?? '')) return 'eye';
  return 'file';
}

const MOCK_STUDIO_FILES = [
  { name: 'MetricsCard.tsx', path: 'src/components/MetricsCard.tsx', category: 'deliverable', size: '3.4 KB', lang: 'tsx', version: 2 },
  { name: 'metricsCard.css', path: 'src/styles/metricsCard.css', category: 'deliverable', size: '1.2 KB', lang: 'css', version: 1 },
  { name: 'mockMetrics.json', path: 'src/fixtures/mockMetrics.json', category: 'evidence', size: '820 B', lang: 'json', version: 1 },
  { name: 'README.md', path: 'docs/MetricsCard.md', category: 'report', size: '2.1 KB', lang: 'markdown', version: 2 }
];

export function ArtifactDock({
  artifact,
  sessionId,
  onClose,
  maximized = false,
  onToggleMaximize,
  onPopOut
}: ArtifactDockProps) {
  const [mode, setMode] = useState<ArtifactViewMode>('preview');
  const [content, setContent] = useState<string>(artifact?.content ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Why the artifact's file could not be read; replaces the whole surface.
  const [loadError, setLoadError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  // Layout Prototype selection
  const [layoutVariant, setLayoutVariant] = useState<ArtifactLayoutPrototype>(() => {
    const saved = localStorage.getItem('praxis.artifact.layoutPrototype');
    if (saved && ARTIFACT_LAYOUT_PROTOTYPES.some(p => p.id === saved)) {
      return saved as ArtifactLayoutPrototype;
    }
    return 'classic-split';
  });
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);

  // Dual-Pane prototype state
  const [dualOrientation, setDualOrientation] = useState<'horizontal' | 'vertical'>('horizontal');

  // Device-Canvas prototype state
  const [deviceMode, setDeviceMode] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [deviceRotated, setDeviceRotated] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState<'100%' | '75%' | 'fit'>('100%');
  const [consoleDrawerOpen, setConsoleDrawerOpen] = useState(true);
  const [consoleTab, setConsoleTab] = useState<'console' | 'elements' | 'transpile'>('console');

  // Tabbed-Studio prototype state
  const [studioActiveFile, setStudioActiveFile] = useState('MetricsCard.tsx');
  const [studioDrawerOpen, setStudioDrawerOpen] = useState(true);

  // Iterative-Companion prototype state
  const [companionPrompt, setCompanionPrompt] = useState('');
  const [companionNotice, setCompanionNotice] = useState<string | undefined>();
  const [selectedVersion, setSelectedVersion] = useState(2);

  const effectiveSessionId = artifact?.sessionId ?? sessionId;

  useEffect(() => {
    if (!artifact) return;
    // Start every artifact from a clean slate, so a file that fails to load
    // never leaves the previous artifact's text on screen under its name.
    setError(undefined);
    setLoadError(undefined);
    setLoading(false);
    if (artifact.content !== undefined) {
      setContent(artifact.content);
      return;
    }
    setContent('');
    // A picture is fetched by the preview itself; reading it as text would
    // only produce garbage for the Code tab.
    if (isImageArtifact(artifact) || !effectiveSessionId || !artifact.path) return;

    let cancelled = false;
    setLoading(true);
    window.praxis.ai.readArtifactText(effectiveSessionId, artifact.path)
      .then(text => {
        if (!cancelled) setContent(text);
      })
      .catch(err => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not read artifact file.';
        setLoadError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact, effectiveSessionId]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleSaveToWorkspace = async () => {
    if (!artifact || !effectiveSessionId) return;
    setSaving(true);
    setNotice(undefined);
    try {
      // Only inline artifacts send their text; a file-backed one is copied
      // byte for byte by main, so a picture is never saved as decoded text.
      const res = await window.praxis.ai.saveArtifactToWorkspace(
        effectiveSessionId,
        artifact.path,
        artifact.content,
        { title: artifact.name, description: artifact.description, mediaType: artifact.mediaType }
      );
      setNotice(res.unchanged ? `Already in ${res.savedPath}` : `Saved to ${res.savedPath}`);
      setTimeout(() => setNotice(undefined), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save to workspace.');
    } finally {
      setSaving(false);
    }
  };

  const handlePopOut = () => {
    if (!artifact) return;
    if (onPopOut) {
      onPopOut(artifact);
    } else if (effectiveSessionId && /\.html?$/i.test(artifact.path)) {
      void window.praxis.ai.openHtmlArtifactPreview(effectiveSessionId, artifact.path, artifact.name);
    }
  };

  const handleApplyIteration = () => {
    if (!companionPrompt.trim()) return;
    setCompanionNotice(`Iteration request sent: "${companionPrompt.trim()}"`);
    setCompanionPrompt('');
    setTimeout(() => setCompanionNotice(undefined), 3000);
  };

  const lines = useMemo(() => {
    return content.split('\n');
  }, [content]);

  const activeLayoutMeta = useMemo(() => {
    return ARTIFACT_LAYOUT_PROTOTYPES.find(p => p.id === layoutVariant) || ARTIFACT_LAYOUT_PROTOTYPES[0];
  }, [layoutVariant]);

  if (!artifact) {
    return (
      <div className="artifact-dock-empty" data-testid="artifact-dock-empty">
        <Icon name="sparkles" size={28} />
        <span>No artifact selected.</span>
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
    );
  }

  const iconName = getIconForArtifact(artifact);
  const langLabel = artifact.language || languageFor(artifact.path);

  return (
    <div
      className={`artifact-dock-container layout-${layoutVariant}`}
      data-testid="artifact-dock-container"
      data-layout-prototype={layoutVariant}
    >
      {/* Top Header Bar */}
      <div className="artifact-dock-header" data-testid="artifact-dock-header">
        <div className="artifact-dock-identity">
          <div className="artifact-dock-icon-tile">
            <Icon name={iconName} size={15} />
          </div>
          <strong className="artifact-dock-title" title={artifact.name} data-testid="artifact-dock-title">
            {artifact.name}
          </strong>
          {artifact.version !== undefined && (
            <span className="badge badge-version" data-testid="artifact-version-badge">
              v{artifact.version}
            </span>
          )}
        </div>

        {/* Prototype Layout Switcher Dropdown */}
        <div className="artifact-dock-layout-switcher">
          <button
            type="button"
            className="btn-tab btn-layout-prototype"
            data-testid="artifact-layout-selector"
            title="Switch Prototype Layout (5 variations)"
            aria-expanded={layoutMenuOpen}
            onClick={() => setLayoutMenuOpen(v => !v)}
          >
            <Icon name={activeLayoutMeta.icon as any} size={12} />
            <span className="layout-name-text">{activeLayoutMeta.name}</span>
            <Icon name="chevron-down" size={10} />
          </button>

          {layoutMenuOpen && (
            <div className="artifact-layout-menu-dropdown" data-testid="artifact-layout-dropdown">
              <div className="artifact-layout-menu-header">
                <span>LAYOUT PROTOTYPES</span>
              </div>
              {ARTIFACT_LAYOUT_PROTOTYPES.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`artifact-layout-menu-item${layoutVariant === opt.id ? ' active' : ''}`}
                  data-testid={`artifact-layout-option-${opt.id}`}
                  onClick={() => {
                    setLayoutVariant(opt.id);
                    localStorage.setItem('praxis.artifact.layoutPrototype', opt.id);
                    setLayoutMenuOpen(false);
                  }}
                >
                  <div className="artifact-layout-menu-item-icon">
                    <Icon name={opt.icon as any} size={13} />
                  </div>
                  <div className="artifact-layout-menu-item-info">
                    <div className="artifact-layout-menu-item-name">
                      <span>{opt.name}</span>
                      {opt.badge && <span className="layout-badge">{opt.badge}</span>}
                    </div>
                    <span className="artifact-layout-menu-item-desc">{opt.shortDesc}</span>
                  </div>
                  {layoutVariant === opt.id && <Icon name="check" size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* View Mode Switcher (Always mounted for testing / baseline mode switching) */}
        <div className="artifact-dock-mode-switch" role="tablist" aria-label="Artifact View Mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            className={`btn-tab${mode === 'preview' ? ' active' : ''}`}
            data-testid="artifact-tab-preview"
            onClick={() => setMode('preview')}
          >
            <Icon name="eye" size={12} />
            <span>Preview</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'code'}
            className={`btn-tab${mode === 'code' ? ' active' : ''}`}
            data-testid="artifact-tab-code"
            onClick={() => setMode('code')}
          >
            <Icon name="terminal" size={12} />
            <span>Code</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'diff'}
            className={`btn-tab${mode === 'diff' ? ' active' : ''}`}
            data-testid="artifact-tab-diff"
            onClick={() => setMode('diff')}
          >
            <Icon name="split-horizontal" size={12} />
            <span>Diff</span>
          </button>
        </div>

        {/* Window Chrome / Actions */}
        <div className="artifact-dock-chrome">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title={copied ? 'Copied!' : 'Copy source code'}
            aria-label="Copy source code"
            data-testid="artifact-copy-btn"
            onClick={handleCopy}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="Pop out in separate preview"
            aria-label="Pop out in separate preview"
            data-testid="artifact-popout-btn"
            onClick={handlePopOut}
          >
            <Icon name="external-link" size={13} />
          </button>
          {onToggleMaximize && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              title={maximized ? 'Restore dock width' : 'Maximize dock'}
              aria-label={maximized ? 'Restore dock width' : 'Maximize dock'}
              data-testid="artifact-maximize-btn"
              onClick={onToggleMaximize}
            >
              <Icon name={maximized ? 'window-restore' : 'window-maximize'} size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="Close Artifact Workspace"
            aria-label="Close Artifact Workspace"
            data-testid="artifact-close-btn"
            onClick={onClose}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>

      {/* Notifications / Error Banner */}
      {notice && (
        <div className="artifact-dock-notice" role="status" data-testid="artifact-dock-notice">
          <Icon name="check" size={13} />
          <span>{notice}</span>
        </div>
      )}
      {companionNotice && (
        <div className="artifact-dock-notice companion-notice" role="status">
          <Icon name="sparkles" size={13} />
          <span>{companionNotice}</span>
        </div>
      )}
      {error && (
        <div className="error-banner artifact-dock-error" role="alert" data-testid="artifact-dock-error">
          <Icon name="warning" size={13} />
          <span>{error}</span>
        </div>
      )}

      {/* Main Dock Surface: Renders specific prototype layout */}
      <div className="artifact-dock-surface" data-testid="artifact-dock-surface">
        {loading ? (
          <div className="artifact-dock-loading">
            <Icon name="refresh" size={18} />
            <span>Loading artifact contents…</span>
          </div>
        ) : loadError ? (
          <div className="artifact-dock-empty artifact-dock-unavailable" role="alert" data-testid="artifact-dock-unavailable">
            <Icon name="warning" size={24} />
            <strong>This artifact can’t be shown</strong>
            <span>{loadError}</span>
            <code className="artifact-dock-unavailable-path">{artifact.path}</code>
          </div>
        ) : layoutVariant === 'classic-split' ? (
          /* ── PROTOTYPE 1: Classic Split ────────────────────────── */
          mode === 'preview' ? (
            <ArtifactPreview
              artifact={artifact}
              content={content}
              sessionId={effectiveSessionId}
            />
          ) : mode === 'code' ? (
            <ArtifactCodeSurface
              artifact={artifact}
              content={content}
              mode="code"
            />
          ) : (
            <ArtifactCodeSurface
              artifact={artifact}
              content={content}
              mode="diff"
            />
          )
        ) : layoutVariant === 'dual-pane' ? (
          /* ── PROTOTYPE 2: Dual-Pane Live Workbench ─────────────── */
          <div
            className={`artifact-dual-pane-container orientation-${dualOrientation}`}
            data-testid="artifact-prototype-dual-pane"
          >
            <div className="artifact-dual-pane-subtoolbar">
              <div className="dual-pane-orientation-switch">
                <button
                  type="button"
                  className={`btn-subtab${dualOrientation === 'horizontal' ? ' active' : ''}`}
                  onClick={() => setDualOrientation('horizontal')}
                  title="Side-by-side layout"
                >
                  <Icon name="columns" size={12} />
                  <span>Side-by-Side</span>
                </button>
                <button
                  type="button"
                  className={`btn-subtab${dualOrientation === 'vertical' ? ' active' : ''}`}
                  onClick={() => setDualOrientation('vertical')}
                  title="Stacked layout"
                >
                  <Icon name="rows" size={12} />
                  <span>Stacked</span>
                </button>
              </div>
              <div className="dual-pane-status">
                <span className="live-sync-indicator">
                  <span className="pulse-dot" />
                  Live Sync (React 18 Hot Transpile)
                </span>
              </div>
            </div>

            <div className="artifact-dual-pane-body">
              <div className="artifact-dual-pane-half pane-preview">
                <div className="pane-header-title">
                  <Icon name="eye" size={12} />
                  <span>Live Render Surface</span>
                </div>
                <div className="pane-content-wrapper">
                  <ArtifactPreview
                    artifact={artifact}
                    content={content}
                    sessionId={effectiveSessionId}
                  />
                </div>
              </div>

              <div className="artifact-dual-pane-divider" />

              <div className="artifact-dual-pane-half pane-code">
                <div className="pane-header-title">
                  <Icon name="terminal" size={12} />
                  <span>Syntax Highlighted Source ({langLabel})</span>
                </div>
                <div className="pane-content-wrapper">
                  <ArtifactCodeSurface
                    artifact={artifact}
                    content={content}
                    mode={mode === 'diff' ? 'diff' : 'code'}
                    hideBanner
                  />
                </div>
              </div>
            </div>
          </div>
        ) : layoutVariant === 'tabbed-studio' ? (
          /* ── PROTOTYPE 3: Multi-Tab Studio ─────────────────────── */
          <div className="artifact-studio-container" data-testid="artifact-prototype-tabbed-studio">
            {/* Top file tab bar */}
            <div className="artifact-studio-tab-strip">
              <button
                type="button"
                className={`studio-drawer-toggle${studioDrawerOpen ? ' active' : ''}`}
                title={studioDrawerOpen ? 'Hide Asset Drawer' : 'Show Asset Drawer'}
                onClick={() => setStudioDrawerOpen(v => !v)}
              >
                <Icon name="folder-open" size={13} />
                <span>Files ({MOCK_STUDIO_FILES.length})</span>
              </button>

              <div className="studio-tabs-scroll">
                {MOCK_STUDIO_FILES.map(file => (
                  <button
                    key={file.name}
                    type="button"
                    className={`studio-tab-item${studioActiveFile === file.name ? ' active' : ''}`}
                    onClick={() => setStudioActiveFile(file.name)}
                  >
                    <Icon name={file.lang === 'tsx' ? 'sparkles' : file.lang === 'css' ? 'sliders' : file.lang === 'json' ? 'package' : 'markdown'} size={12} />
                    <span>{file.name}</span>
                    <span className="studio-tab-pill">v{file.version}</span>
                  </button>
                ))}
              </div>

              <div className="studio-batch-actions">
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  title="Save all files to project directory"
                  onClick={handleSaveToWorkspace}
                >
                  <Icon name="check" size={11} />
                  <span>Save All</span>
                </button>
              </div>
            </div>

            <div className="artifact-studio-workspace">
              {studioDrawerOpen && (
                <div className="artifact-studio-drawer">
                  <div className="studio-drawer-header">
                    <span>SESSION DELIVERABLES</span>
                  </div>
                  <div className="studio-drawer-list">
                    {MOCK_STUDIO_FILES.map(file => (
                      <div
                        key={file.name}
                        className={`studio-file-row${studioActiveFile === file.name ? ' active' : ''}`}
                        onClick={() => setStudioActiveFile(file.name)}
                      >
                        <div className="studio-file-info">
                          <Icon name={file.lang === 'tsx' ? 'file' : file.lang === 'css' ? 'sliders' : file.lang === 'json' ? 'package' : 'markdown'} size={13} />
                          <div className="studio-file-meta">
                            <span className="studio-file-title">{file.name}</span>
                            <span className="studio-file-path">{file.path}</span>
                          </div>
                        </div>
                        <span className="studio-file-size">{file.size}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="artifact-studio-canvas">
                {mode === 'preview' && studioActiveFile === 'MetricsCard.tsx' ? (
                  <ArtifactPreview
                    artifact={artifact}
                    content={content}
                    sessionId={effectiveSessionId}
                  />
                ) : (
                  <ArtifactCodeSurface
                    artifact={{
                      ...artifact,
                      name: studioActiveFile,
                      path: MOCK_STUDIO_FILES.find(f => f.name === studioActiveFile)?.path || artifact.path
                    }}
                    content={studioActiveFile === 'MetricsCard.tsx' ? content : `// ${studioActiveFile} source preview\n/* Auto-generated companion deliverable */`}
                    mode={mode === 'diff' ? 'diff' : 'code'}
                  />
                )}
              </div>
            </div>
          </div>
        ) : layoutVariant === 'device-canvas' ? (
          /* ── PROTOTYPE 4: Device Viewport Stage ────────────────── */
          <div className="artifact-device-stage-container" data-testid="artifact-prototype-device-canvas">
            {/* Device Control Sub-bar */}
            <div className="artifact-device-toolbar">
              <div className="device-presets">
                <button
                  type="button"
                  className={`btn-subtab${deviceMode === 'desktop' ? ' active' : ''}`}
                  onClick={() => setDeviceMode('desktop')}
                >
                  <Icon name="window-maximize" size={12} />
                  <span>Desktop (100%)</span>
                </button>
                <button
                  type="button"
                  className={`btn-subtab${deviceMode === 'tablet' ? ' active' : ''}`}
                  onClick={() => setDeviceMode('tablet')}
                >
                  <Icon name="columns" size={12} />
                  <span>Tablet (768px)</span>
                </button>
                <button
                  type="button"
                  className={`btn-subtab${deviceMode === 'mobile' ? ' active' : ''}`}
                  onClick={() => setDeviceMode('mobile')}
                >
                  <Icon name="sidebar-right" size={12} />
                  <span>Mobile (375px)</span>
                </button>
              </div>

              <div className="device-actions">
                <button
                  type="button"
                  className={`btn-subtab${deviceRotated ? ' active' : ''}`}
                  onClick={() => setDeviceRotated(v => !v)}
                  title="Rotate orientation"
                >
                  <Icon name="refresh" size={11} />
                  <span>{deviceRotated ? 'Landscape' : 'Portrait'}</span>
                </button>
                <div className="zoom-pills">
                  <button
                    type="button"
                    className={`btn-subtab${canvasZoom === '100%' ? ' active' : ''}`}
                    onClick={() => setCanvasZoom('100%')}
                  >
                    100%
                  </button>
                  <button
                    type="button"
                    className={`btn-subtab${canvasZoom === '75%' ? ' active' : ''}`}
                    onClick={() => setCanvasZoom('75%')}
                  >
                    75%
                  </button>
                </div>
              </div>
            </div>

            {/* Dotted Canvas with Device Frame */}
            <div className={`artifact-device-canvas zoom-${canvasZoom}`}>
              <div
                className={`artifact-device-frame mode-${deviceMode}${deviceRotated ? ' rotated' : ''}`}
                data-testid="artifact-device-frame"
              >
                {deviceMode !== 'desktop' && (
                  <div className="device-hardware-bar">
                    <span className="device-status-time">9:41</span>
                    <div className="device-notch" />
                    <span className="device-status-icons">📶 🔋</span>
                  </div>
                )}
                <div className="device-inner-screen">
                  {mode === 'preview' ? (
                    <ArtifactPreview
                      artifact={artifact}
                      content={content}
                      sessionId={effectiveSessionId}
                    />
                  ) : (
                    <ArtifactCodeSurface
                      artifact={artifact}
                      content={content}
                      mode={mode === 'diff' ? 'diff' : 'code'}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Collapsible DevTools / Console Drawer */}
            <div className={`artifact-device-console-drawer${consoleDrawerOpen ? ' open' : ' collapsed'}`}>
              <div className="console-drawer-header">
                <div className="console-tabs">
                  <button
                    type="button"
                    className={`console-tab-btn${consoleTab === 'console' ? ' active' : ''}`}
                    onClick={() => setConsoleTab('console')}
                  >
                    <Icon name="terminal" size={11} />
                    <span>Console (2 logs)</span>
                  </button>
                  <button
                    type="button"
                    className={`console-tab-btn${consoleTab === 'elements' ? ' active' : ''}`}
                    onClick={() => setConsoleTab('elements')}
                  >
                    <Icon name="eye" size={11} />
                    <span>DOM Inspector</span>
                  </button>
                  <button
                    type="button"
                    className={`console-tab-btn${consoleTab === 'transpile' ? ' active' : ''}`}
                    onClick={() => setConsoleTab('transpile')}
                  >
                    <Icon name="zap" size={11} />
                    <span>Transpile (12ms)</span>
                  </button>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-xs"
                  onClick={() => setConsoleDrawerOpen(v => !v)}
                  title={consoleDrawerOpen ? 'Collapse console' : 'Expand console'}
                >
                  <Icon name={consoleDrawerOpen ? 'chevron-down' : 'chevron-up'} size={11} />
                </button>
              </div>

              {consoleDrawerOpen && (
                <div className="console-drawer-body">
                  {consoleTab === 'console' ? (
                    <div className="console-log-list">
                      <div className="console-row log-info">
                        <span className="console-time">10:14:02.120</span>
                        <span className="console-tag">[React18]</span>
                        <span className="console-msg">Mounted component &lt;MetricsCard /&gt; into #root container</span>
                      </div>
                      <div className="console-row log-debug">
                        <span className="console-time">10:14:02.134</span>
                        <span className="console-tag">[MetricsCard]</span>
                        <span className="console-msg">3 metrics cards initialized: Latency (42ms), Throughput (1.2k req/s), Error Rate (0.01%)</span>
                      </div>
                    </div>
                  ) : consoleTab === 'elements' ? (
                    <div className="console-elements-view">
                      <code>&lt;div class="metrics-grid" style="display: flex; gap: 12px"&gt;</code>
                      <code style={{ paddingLeft: '16px' }}>&lt;div class="metric-card"&gt;...&lt;/div&gt;</code>
                      <code>&lt;/div&gt;</code>
                    </div>
                  ) : (
                    <div className="console-transpile-view">
                      <div className="transpile-metric"><span>JSX Transform:</span> <strong>8ms (Sucrase fast-path)</strong></div>
                      <div className="transpile-metric"><span>Tailwind CSS:</span> <strong>Injected (34 utility rules)</strong></div>
                      <div className="transpile-metric"><span>Lucide Icons:</span> <strong>Proxied (Activity, ShieldCheck)</strong></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── PROTOTYPE 5: Iterative Companion ──────────────────── */
          <div className="artifact-companion-container" data-testid="artifact-prototype-iterative-companion">
            <div className="companion-main-surface">
              <div className="companion-surface-header">
                <span className="companion-surface-tag">Active Version: v{selectedVersion}</span>
                <span className="companion-surface-status">● Live Preview Ready</span>
              </div>
              <div className="companion-surface-body">
                {mode === 'preview' ? (
                  <ArtifactPreview
                    artifact={artifact}
                    content={content}
                    sessionId={effectiveSessionId}
                  />
                ) : (
                  <ArtifactCodeSurface
                    artifact={artifact}
                    content={content}
                    mode={mode === 'diff' ? 'diff' : 'code'}
                  />
                )}
              </div>
            </div>

            <div className="companion-sidebar">
              <div className="companion-sidebar-header">
                <div className="companion-header-title">
                  <Icon name="sparkles" size={13} />
                  <span>Iterate on Artifact</span>
                </div>
                <span className="companion-header-badge">v{selectedVersion} of 2</span>
              </div>

              {/* Quick refinement prompt chips */}
              <div className="companion-chips-section">
                <span className="companion-section-label">QUICK REFINEMENTS</span>
                <div className="companion-chips-list">
                  <button
                    type="button"
                    className="companion-chip"
                    onClick={() => setCompanionPrompt('Add dark mode color tokens and toggle switch')}
                  >
                    + Dark Mode
                  </button>
                  <button
                    type="button"
                    className="companion-chip"
                    onClick={() => setCompanionPrompt('Add interactive latency filter and time range slider')}
                  >
                    + Filter Controls
                  </button>
                  <button
                    type="button"
                    className="companion-chip"
                    onClick={() => setCompanionPrompt('Add animated loading skeleton state')}
                  >
                    + Loading Skeleton
                  </button>
                  <button
                    type="button"
                    className="companion-chip"
                    onClick={() => setCompanionPrompt('Export TypeScript interface with strict types')}
                  >
                    + TypeScript Types
                  </button>
                </div>
              </div>

              {/* Inline revision prompt composer */}
              <div className="companion-composer-section">
                <span className="companion-section-label">REQUEST REVISION</span>
                <textarea
                  className="companion-textarea"
                  placeholder="Describe how to adjust this component..."
                  value={companionPrompt}
                  onChange={e => setCompanionPrompt(e.target.value)}
                  rows={3}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary companion-apply-btn"
                  disabled={!companionPrompt.trim()}
                  onClick={handleApplyIteration}
                >
                  <Icon name="sparkles" size={12} />
                  <span>Apply Iteration (v3)</span>
                </button>
              </div>

              {/* Version History Stepper */}
              <div className="companion-history-section">
                <span className="companion-section-label">REVISION TIMELINE</span>
                <div className="companion-history-list">
                  <div
                    className={`companion-history-item${selectedVersion === 2 ? ' current' : ''}`}
                    onClick={() => setSelectedVersion(2)}
                  >
                    <div className="history-item-dot" />
                    <div className="history-item-content">
                      <div className="history-item-top">
                        <strong>v2 (Current)</strong>
                        <span>10:15 AM</span>
                      </div>
                      <p>Added latency bar chart, Tailwind styling, and reactive cards</p>
                    </div>
                  </div>
                  <div
                    className={`companion-history-item${selectedVersion === 1 ? ' current' : ''}`}
                    onClick={() => setSelectedVersion(1)}
                  >
                    <div className="history-item-dot" />
                    <div className="history-item-content">
                      <div className="history-item-top">
                        <strong>v1 (Initial)</strong>
                        <span>10:14 AM</span>
                      </div>
                      <p>Initial React skeleton and props definition</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Footer Bar */}
      <div className="artifact-dock-footer" data-testid="artifact-dock-footer">
        <div className="artifact-dock-footer-info">
          <Icon name="file" size={13} />
          <code className="artifact-dock-path" title={artifact.path}>
            {artifact.path}
          </code>
        </div>
        <div className="artifact-dock-footer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="artifact-save-workspace-btn"
            title="Copy into the project's artifacts folder"
            disabled={saving}
            onClick={handleSaveToWorkspace}
          >
            <Icon name={saving ? 'refresh' : 'check'} size={12} />
            <span>{saving ? 'Saving…' : 'Save to Workspace'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
