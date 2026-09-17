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

  return (
    <>
      <GadgetHeading title={payload.title} id={`${gadget.gadgetId}-title`} />
      <ul className="gadget-artifacts">
        {payload.artifacts.map(artifact => {
          const size = formatSize(artifact.sizeBytes);
          const previewableImage = isPreviewableImage(artifact.mediaType, artifact.path);
          return (
            <li key={artifact.path} className={previewableImage ? 'gadget-artifact-image-item' : undefined}>
              <Icon name="file" size={13} />
              <span className="gadget-artifact-body">
                <strong>{artifact.name}</strong>
                <code className="gadget-artifact-path">{artifact.path}</code>
                {artifact.description && <small>{artifact.description}</small>}
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
