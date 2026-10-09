import { useState } from 'react';
import type { ArtifactGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
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
  const previewSessionId = gadget.scope.workId ?? gadget.scope.sessionId;

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
          return (
            <li key={artifact.path} className={previewableImage ? 'gadget-artifact-image-item' : undefined}>
              <Icon name="file" size={13} />
              <span className="gadget-artifact-body">
                <div className="gadget-artifact-title-row">
                  <strong>{artifact.name}</strong>
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
                <code className="gadget-artifact-path">{artifact.path}</code>
                {artifact.description && <small>{artifact.description}</small>}
                {previewableHtml && (
                  <div className="gadget-artifact-html-actions">
                    <button
                      className="btn btn-quiet"
                      type="button"
                      data-testid="gadget-artifact-html-preview"
                      disabled={Boolean(previewingPath)}
                      onClick={() => void previewHtml(artifact.path, artifact.name)}
                    >
                      <Icon name="file" size={13} />
                      {previewingPath === artifact.path ? 'Opening…' : 'Preview'}
                    </button>
                    {previewError && <small role="alert">{previewError}</small>}
                  </div>
                )}
                {previewableImage && (
                  <div className="gadget-artifact-preview" data-testid="gadget-artifact-image-preview">
                    <Markdown
                      text={markdownImageForArtifact(artifact.name, artifact.path)}
                      imageSessionId={gadget.scope.workId ?? gadget.scope.sessionId}
                      testId="gadget-artifact-image-markdown"
                    />
                  </div>
                )}
              </span>
              <span className="gadget-artifact-meta">
                {artifact.mediaType && <span>{artifact.mediaType}</span>}
                {size && <span>{size}</span>}
              </span>
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
