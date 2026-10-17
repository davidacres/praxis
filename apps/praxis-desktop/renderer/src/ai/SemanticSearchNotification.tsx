import { useEffect, useState } from 'react';
import type { SemanticModelProgressEvent } from '@praxis/core';
import { Icon } from '../ui/Icon';
import './semanticSearchNotification.css';

export const SEMANTIC_SEARCH_DISMISS_KEY = 'praxis:semantic-search-prompt-dismissed';
/** Separate from the enable prompt: dismissing "enable" once must not hide a model update. */
export const SEMANTIC_SEARCH_UPDATE_DISMISS_KEY = 'praxis:semantic-search-update-dismissed';

export interface SemanticSearchNotificationProps {
  onOpenSettings?: () => void;
}

export function SemanticSearchNotification({ onOpenSettings }: SemanticSearchNotificationProps) {
  const [visible, setVisible] = useState(false);
  const [update, setUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<SemanticModelProgressEvent>();
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const checkStatus = async () => {
      try {
        if (window.praxis?.ai?.getSemanticModelStatus) {
          const status = await window.praxis.ai.getSemanticModelStatus();
          if (cancelled || status.installed) return;
          const isUpdate = status.updateAvailable === true;
          if (localStorage.getItem(isUpdate ? SEMANTIC_SEARCH_UPDATE_DISMISS_KEY : SEMANTIC_SEARCH_DISMISS_KEY)) return;
          setUpdate(isUpdate);
          setVisible(true);
        }
      } catch {
        // Soft fail
      }
    };

    void checkStatus();

    if (window.praxis?.ai?.onSemanticModelProgress) {
      // Progress only: a finished download is not yet an installed, active model —
      // handleEnable declares success once the whole install has resolved.
      const unsubscribe = window.praxis.ai.onSemanticModelProgress(ev => {
        if (!cancelled) setProgress(ev);
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const handleDismiss = () => {
    localStorage.setItem(update ? SEMANTIC_SEARCH_UPDATE_DISMISS_KEY : SEMANTIC_SEARCH_DISMISS_KEY, 'true');
    setVisible(false);
  };

  const handleEnable = async () => {
    if (!window.praxis?.ai?.downloadSemanticModel) return;
    setDownloading(true);
    setError('');
    try {
      await window.praxis.ai.downloadSemanticModel();
      setDownloading(false);
      setSuccess(true);
      setTimeout(() => setVisible(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
      setDownloading(false);
    }
  };

  const handleConfigure = () => {
    setVisible(false);
    onOpenSettings?.();
  };

  return (
    <aside
      className="semantic-search-notification"
      role="region"
      aria-label="Semantic search recommendation"
      data-testid="semantic-search-notification"
    >
      <div className="semantic-search-notification-header">
        <div className="semantic-search-notification-title-wrap">
          <span className="semantic-search-notification-icon" aria-hidden="true">
            <Icon name="sparkles" size={16} />
          </span>
          <h4 className="semantic-search-notification-title" data-testid="semantic-search-notification-title">
            {update ? 'Semantic Search Update' : 'Semantic Code Search'}
          </h4>
          <span className="semantic-search-notification-badge">Recommended</span>
        </div>
        {!downloading && !success && (
          <button
            type="button"
            className="semantic-search-notification-close"
            aria-label="Dismiss notification"
            onClick={handleDismiss}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {!success && (
        <p className="semantic-search-notification-body">
          {update
            ? 'A more accurate search model is available. Until it is installed, code search uses keyword matching only. Runs 100% locally on your machine.'
            : 'Enable natural language semantic search across functions, symbols, and codebase repositories. Runs 100% locally on your machine with zero external network traffic.'}
        </p>
      )}

      {downloading && (
        <div className="semantic-search-notification-progress" data-testid="semantic-notification-progress">
          <div className="semantic-search-notification-bar">
            <div
              className="semantic-search-notification-fill"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
          <div className="semantic-search-notification-meta">
            {progress
              ? `Downloading… ${progress.percent}% (${(progress.bytesDownloaded / 1024 / 1024).toFixed(1)} MB / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB)`
              : 'Preparing download…'}
          </div>
        </div>
      )}

      {success && (
        <div className="semantic-search-notification-success" data-testid="semantic-notification-success">
          <Icon name="check" size={16} />
          <span>{update ? 'Semantic search model updated!' : 'Semantic search is now enabled and active!'}</span>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert" style={{ fontSize: 'var(--text-xs, 11px)', padding: '6px 10px' }}>
          {error}
        </div>
      )}

      {!downloading && !success && (
        <div className="semantic-search-notification-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleConfigure}
            data-testid="semantic-notification-settings-btn"
          >
            Configure
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleDismiss}
            data-testid="semantic-notification-dismiss-btn"
          >
            Not now
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleEnable}
            data-testid="semantic-notification-enable-btn"
          >
            {update ? 'Update (~130 MB)' : 'Enable (~130 MB)'}
          </button>
        </div>
      )}
    </aside>
  );
}
