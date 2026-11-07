import { useEffect, useRef, useState } from 'react';
import type { ArtifactGadgetPayload, ArtifactItem } from '@praxis/core';
import { Icon, type IconName } from '../../../ui/Icon';
import { Markdown } from '../../../ui/Markdown';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

function formatSize(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PREVIEWABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

function isPreviewableImage(mediaType: string | undefined, path: string): boolean {
  return Boolean(
    mediaType &&
    PREVIEWABLE_IMAGE_TYPES.has(mediaType.toLowerCase()) &&
    /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(path.split(/[?#]/, 1)[0] ?? '')
  );
}

function isPreviewableHtml(mediaType: string | undefined, path: string): boolean {
  return /\.html?$/i.test(path.split(/[?#]/, 1)[0] ?? '') &&
    (!mediaType || ['text/html', 'application/xhtml+xml'].includes(mediaType.toLowerCase()));
}

function markdownImageForArtifact(name: string, path: string): string {
  const alt = name.replace(/[\[\]]/g, ' ').trim() || 'Artifact preview';
  return `![${alt}](<${path}>)`;
}

function getIconForArtifactItem(artifact: ArtifactItem): IconName {
  const ext = artifact.path.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'globe';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext ?? '')) return 'eye';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'cs', 'sh'].includes(ext ?? '')) return 'terminal';
  return 'file';
}

/**
 * The card's picture: an HTML page file is rendered to a cached snapshot by the
 * host (lazily, once the card scrolls near view); anything else, or a page that
 * can't be drawn, keeps its kind icon.
 */
function ArtifactCardThumb({ artifact, sessionId, iconName }: { artifact: ArtifactItem; sessionId?: string; iconName: IconName }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string>();
  const page = Boolean(sessionId) && artifact.content === undefined && isPreviewableHtml(artifact.mediaType, artifact.path);

  useEffect(() => {
    if (!page || !sessionId || !ref.current) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void window.praxis.ai.artifactPageThumbnail(sessionId, artifact.path)
        .then(url => { if (!cancelled) setSrc(url); })
        .catch(() => undefined);
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [page, sessionId, artifact.path]);

  if (src) {
    return (
      <div ref={ref} className="gadget-artifact-thumb" data-testid="gadget-artifact-thumb">
        <img src={src} alt="" />
      </div>
    );
  }
  return (
    <div ref={ref} className={`gadget-artifact-icon-tile icon-${iconName}${page ? ' is-page' : ''}`}>
      <Icon name={iconName} size={16} />
    </div>
  );
}

/**
 * Files a run produced.
 *
 * Paths are workspace-relative and validation has already refused any that
 * traverse out, so this only has to present them — opening one is an action
 * the host performs, never a link the renderer resolves itself.
 */
export function ArtifactGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'artifact'>(gadget) as ArtifactGadgetPayload;
  const [previewingPath, setPreviewingPath] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({});
  // Where each save landed (or why it failed), shown as the button's tooltip.
  const [saveDetail, setSaveDetail] = useState<Record<string, string>>({});
  const previewSessionId = gadget.scope.workId ?? gadget.scope.sessionId;

  const openInWorkspace = (artifact: ArtifactItem) => {
    window.dispatchEvent(
      new CustomEvent('praxis:open-artifact', {
        detail: {
          artifact: {
            ...artifact,
            sessionId: previewSessionId
          }
        }
      })
    );
  };

  const saveArtifact = async (artifact: ArtifactItem) => {
    try {
      const result = await window.praxis.ai.saveArtifactToWorkspace(
        previewSessionId,
        artifact.path,
        artifact.content,
        { title: artifact.name, description: artifact.description, mediaType: artifact.mediaType }
      );
      setSaveStatus(prev => ({ ...prev, [artifact.path]: result.unchanged ? 'Already saved' : 'Saved' }));
      setSaveDetail(prev => ({ ...prev, [artifact.path]: `${result.unchanged ? 'Already in' : 'Saved to'} ${result.savedPath}` }));
      setTimeout(() => {
        setSaveStatus(prev => {
          const next = { ...prev };
          delete next[artifact.path];
          return next;
        });
      }, 3000);
    } catch (err) {
      setSaveStatus(prev => ({ ...prev, [artifact.path]: 'Error saving' }));
      setSaveDetail(prev => ({ ...prev, [artifact.path]: err instanceof Error ? err.message : String(err) }));
    }
  };

  const previewHtml = async (path: string, title: string) => {
    setPreviewingPath(path);
    setPreviewError(undefined);
    try {
      await window.praxis.ai.openHtmlArtifactPreview(previewSessionId, path, title);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Could not open HTML preview.');
    } finally {
      setPreviewingPath(undefined);
    }
  };

  const handover = payload.handover;

  return (
    <>
      <GadgetHeading title={payload.title} id={`${gadget.gadgetId}-title`} />
      {handover && (
        <div className="gadget-artifact-handover" data-testid="gadget-artifact-handover">
          <div className="gadget-artifact-handover__header">
            {handover.verdict && (
              <span
                className={`gadget-artifact-verdict-pill verdict-${handover.verdict}`}
                data-testid="gadget-artifact-handover-verdict"
              >
                <Icon
                  name={
                    handover.verdict === 'passed'
                      ? 'check-square'
                      : handover.verdict === 'failed'
                        ? 'warning'
                        : 'info'
                  }
                  size={12}
                />
                {handover.verdict === 'passed'
                  ? 'Verified · Passed'
                  : handover.verdict === 'failed'
                    ? 'Verification Failed'
                    : 'Needs Review'}
              </span>
            )}
            {handover.testSummary && (
              <span className="gadget-artifact-chip" data-testid="gadget-artifact-handover-tests">
                <Icon name="check-square" size={12} />
                {handover.testSummary.passed}/{handover.testSummary.total} tests passed
                {handover.testSummary.failed > 0 && ` (${handover.testSummary.failed} failed)`}
              </span>
            )}
            {handover.gitRef && (
              <span className="gadget-artifact-chip" data-testid="gadget-artifact-handover-gitref">
                <Icon name="git-branch" size={12} />
                <code>{handover.gitRef}</code>
              </span>
            )}
            {handover.requiresSignoff && (
              <span className="gadget-artifact-chip is-signoff" data-testid="gadget-artifact-handover-signoff">
                <Icon name="shield" size={12} />
                Sign-off required
              </span>
            )}
          </div>
          {handover.nextSteps && (
            <div className="gadget-artifact-handover__next-steps" data-testid="gadget-artifact-handover-next-steps">
              <span className="gadget-artifact-handover__next-label">Next steps:</span> {handover.nextSteps}
            </div>
          )}
        </div>
      )}
      <ul className="gadget-artifacts">
        {payload.artifacts.map(artifact => {
          const size = formatSize(artifact.sizeBytes);
          const previewableImage = isPreviewableImage(artifact.mediaType, artifact.path);
          const previewableHtml = isPreviewableHtml(artifact.mediaType, artifact.path);
          const iconName = getIconForArtifactItem(artifact);
          return (
            <li key={artifact.path} className={`gadget-artifact-item${previewableImage ? ' gadget-artifact-image-item' : ''}`}>
              <div
                className="gadget-artifact-card"
                data-testid="gadget-artifact-card"
                role="button"
                tabIndex={0}
                onClick={() => openInWorkspace(artifact)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openInWorkspace(artifact);
                  }
                }}
              >
                <div className="gadget-artifact-card-lead" title={artifact.path}>
                  <ArtifactCardThumb artifact={artifact} sessionId={previewSessionId} iconName={iconName} />
                  <div className="gadget-artifact-info">
                    <div className="gadget-artifact-title-row">
                      <strong className="gadget-artifact-title">{artifact.name}</strong>
                      {artifact.version !== undefined && (
                        <span className="badge badge-version" data-testid="gadget-artifact-version">
                          v{artifact.version}
                        </span>
                      )}
                      {artifact.category && (
                        <span
                          className={`gadget-artifact-category-badge category-${artifact.category}`}
                          data-testid="gadget-artifact-item-category"
                        >
                          {artifact.category}
                        </span>
                      )}
                      {artifact.verdict && (
                        <span
                          className={`gadget-artifact-item-verdict verdict-${artifact.verdict}`}
                          data-testid="gadget-artifact-item-verdict"
                        >
                          {artifact.verdict}
                        </span>
                      )}
                    </div>
                    {artifact.description && (
                      <div className="gadget-artifact-subrow">
                        <span className="gadget-artifact-desc">{artifact.description}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="gadget-artifact-card-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className="icon-btn gadget-artifact-action is-primary"
                    type="button"
                    data-testid="gadget-artifact-open-dock"
                    onClick={() => openInWorkspace(artifact)}
                    aria-label="Open in Artifact Workspace"
                  >
                    <Icon name="eye" size={14} />
                  </button>
                  {previewableHtml && (
                    <button
                      className="icon-btn gadget-artifact-action"
                      type="button"
                      data-testid="gadget-artifact-html-preview"
                      disabled={Boolean(previewingPath)}
                      onClick={() => void previewHtml(artifact.path, artifact.name)}
                      aria-label={previewingPath === artifact.path ? 'Opening…' : 'Pop out in a separate window'}
                    >
                      <Icon name="external-link" size={14} />
                    </button>
                  )}
                  <button
                    className={`icon-btn gadget-artifact-action${saveStatus[artifact.path] === 'Error saving' ? ' is-error' : saveStatus[artifact.path] ? ' is-done' : ''}`}
                    type="button"
                    data-testid="gadget-artifact-save"
                    onClick={() => void saveArtifact(artifact)}
                    aria-label={saveStatus[artifact.path] || "Save to the project's artifacts folder"}
                    title={saveDetail[artifact.path] ?? "Save to the project's artifacts folder"}
                  >
                    <Icon name={saveStatus[artifact.path] === 'Error saving' ? 'warning' : saveStatus[artifact.path] ? 'check' : 'download'} size={14} />
                  </button>
                </div>
              </div>
              {previewError && <small role="alert">{previewError}</small>}
              {previewableImage && (
                <div className="gadget-artifact-preview" data-testid="gadget-artifact-image-preview">
                  <Markdown
                    text={markdownImageForArtifact(artifact.name, artifact.path)}
                    imageSessionId={gadget.scope.workId ?? gadget.scope.sessionId}
                    testId="gadget-artifact-image-markdown"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={() => ({ kind: 'none' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
