import { useState } from 'react';
import type { ImageGadgetPayload, ImageGadgetItem } from '@praxis/core';
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

/**
 * Base64 for a UTF-8 string.
 *
 * `btoa` only accepts Latin-1, so the text is encoded to UTF-8 bytes first.
 * Without this, an SVG carrying any non-ASCII character would throw.
 */
function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The image markdown for one item.
 *
 * The path is workspace-relative and the host resolves it against the session's
 * folder, so the picture is fetched through the same bounded, sandboxed route
 * as any other image in a chat message.
 */
function markdownImageForItem(item: ImageGadgetItem): string {
  const alt = item.name.replace(/[\[\]]/g, ' ').trim() || 'Image preview';
  // Inline SVG travels in the payload rather than on disk, so it is shown
  // directly instead of being looked up in the session's folder.
  //
  // The source is base64-encoded rather than percent-encoded: a percent-encoded
  // data URI can contain `)`, and a `)` ends the Markdown image syntax, which
  // would leave the picture rendered as literal text.
  if (item.content !== undefined && item.content.trim()) {
    return `![${alt}](data:image/svg+xml;base64,${base64OfUtf8(item.content)})`;
  }
  return `![${alt}](<${item.path}>)`;
}

/**
 * Pictures a run produced.
 *
 * This surface is deliberately *not* the artifact surface. An artifact is a
 * file: it has a path, it can be opened in the workspace, and it is copied into
 * the project's artifacts folder. A picture is shown. So an image gadget draws
 * the picture, names it, and offers the one action that still makes sense for
 * it — publishing it into the project's artifacts folder.
 */
export function ImageGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'image'>(gadget) as ImageGadgetPayload;
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({});
  // Where each save landed (or why it failed), shown as the button's tooltip.
  const [saveDetail, setSaveDetail] = useState<Record<string, string>>({});
  const previewSessionId = gadget.scope.workId ?? gadget.scope.sessionId;

  const saveImage = async (image: ImageGadgetItem) => {
    try {
      const result = await window.praxis.ai.saveArtifactToWorkspace(previewSessionId, image.path, image.content, {
        title: image.name,
        description: image.description,
        mediaType: image.mediaType
      });
      setSaveStatus(prev => ({ ...prev, [image.path]: result.unchanged ? 'Already saved' : 'Saved' }));
      setSaveDetail(prev => ({ ...prev, [image.path]: `${result.unchanged ? 'Already in' : 'Saved to'} ${result.savedPath}` }));
      setTimeout(() => {
        setSaveStatus(prev => {
          const next = { ...prev };
          delete next[image.path];
          return next;
        });
      }, 3000);
    } catch (err) {
      setSaveStatus(prev => ({ ...prev, [image.path]: 'Error saving' }));
      setSaveDetail(prev => ({ ...prev, [image.path]: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <>
      <GadgetHeading title={payload.title} id={`${gadget.gadgetId}-title`} />
      <ul className="gadget-images">
        {payload.images.map(image => {
          const size = formatSize(image.sizeBytes);
          return (
            <li key={image.path} className="gadget-image-item" data-testid="gadget-image-item">
              <figure className="gadget-image-figure">
                <div className="gadget-image-frame" data-testid="gadget-image-preview">
                  <Markdown
                    text={markdownImageForItem(image)}
                    imageSessionId={previewSessionId}
                    testId="gadget-image-markdown"
                    allowInlineSvg
                  />
                </div>
                <figcaption className="gadget-image-caption">
                  <span className="gadget-image-name">{image.name}</span>
                  {size && <span className="gadget-image-size">{size}</span>}
                  {image.description && <span className="gadget-image-desc">{image.description}</span>}
                  <button
                    className="btn btn-sm btn-quiet gadget-image-save"
                    type="button"
                    data-testid="gadget-image-save"
                    disabled={!actionable || busy}
                    onClick={() => void saveImage(image)}
                    title={saveDetail[image.path] ?? "Copy into the project's artifacts folder"}
                  >
                    <Icon name="check" size={12} />
                    <span>{saveStatus[image.path] || 'Save'}</span>
                  </button>
                </figcaption>
              </figure>
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
