import { useEffect, useState, useMemo } from 'react';
import { Icon } from '../../ui/Icon';
import { highlightCode, languageFor } from '../../ui/codeHighlight';
import { ArtifactPreview } from './ArtifactPreview';
import type { ActiveArtifact, ArtifactViewMode } from './artifactTypes';

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
  const [notice, setNotice] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const effectiveSessionId = artifact?.sessionId ?? sessionId;

  useEffect(() => {
    if (!artifact) return;
    if (artifact.content !== undefined) {
      setContent(artifact.content);
      setError(undefined);
      return;
    }

    if (effectiveSessionId && artifact.path) {
      setLoading(true);
      setError(undefined);
      window.praxis.ai.readArtifactText(effectiveSessionId, artifact.path)
        .then(text => {
          setContent(text);
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : 'Could not read artifact file.');
        })
        .finally(() => {
          setLoading(false);
        });
    }
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
      const res = await window.praxis.ai.saveArtifactToWorkspace(
        effectiveSessionId,
        artifact.path,
        content
      );
      setNotice(`Saved to ${res.savedPath}`);
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

  const lines = useMemo(() => {
    return content.split('\n');
  }, [content]);

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
    <div className="artifact-dock-container" data-testid="artifact-dock-container">
      {/* Top Header Bar */}
      <div className="artifact-dock-header" data-testid="artifact-dock-header">
        <div className="artifact-dock-identity">
          <Icon name={iconName} size={15} />
          <strong className="artifact-dock-title" title={artifact.name} data-testid="artifact-dock-title">
            {artifact.name}
          </strong>
          {artifact.version !== undefined && (
            <span className="badge badge-version" data-testid="artifact-version-badge">
              v{artifact.version}
            </span>
          )}
          <span className="badge badge-quiet">{langLabel}</span>
          {artifact.category && (
            <span className={`gadget-artifact-category-badge category-${artifact.category}`}>
              {artifact.category}
            </span>
          )}
        </div>

        {/* View Mode Switcher */}
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
      {error && (
        <div className="error-banner artifact-dock-error" role="alert" data-testid="artifact-dock-error">
          <Icon name="warning" size={13} />
          <span>{error}</span>
        </div>
      )}

      {/* Main Dock Surface */}
      <div className="artifact-dock-surface" data-testid="artifact-dock-surface">
        {loading ? (
          <div className="artifact-dock-loading">
            <Icon name="refresh" size={18} />
            <span>Loading artifact contents…</span>
          </div>
        ) : mode === 'preview' ? (
          <ArtifactPreview
            artifact={artifact}
            content={content}
            sessionId={effectiveSessionId}
          />
        ) : mode === 'code' ? (
          <div className="artifact-code-view" data-testid="artifact-code-view">
            <div className="artifact-code-lines">
              {lines.map((line, idx) => (
                <div key={idx} className="artifact-code-line">
                  <span className="artifact-code-lineno">{idx + 1}</span>
                  <code className="artifact-code-text">{highlightCode(line) || ' '}</code>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="artifact-diff-view" data-testid="artifact-diff-view">
            <div className="artifact-diff-lines">
              {lines.map((line, idx) => (
                <div key={idx} className="artifact-diff-line diff-added">
                  <span className="artifact-diff-indicator">+</span>
                  <span className="artifact-code-lineno">{idx + 1}</span>
                  <code className="artifact-code-text">{highlightCode(line) || ' '}</code>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Footer Bar */}
      <div className="artifact-dock-footer" data-testid="artifact-dock-footer">
        <code className="artifact-dock-path" title={artifact.path}>
          {artifact.path}
        </code>
        <div className="artifact-dock-footer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="artifact-save-workspace-btn"
            disabled={saving}
            onClick={handleSaveToWorkspace}
          >
            <Icon name="check" size={12} />
            <span>{saving ? 'Saving…' : 'Save to Workspace'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
