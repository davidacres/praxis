import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import MarkdownIt from 'markdown-it';
import { normalizeStructuredReviewMarkdown } from './structuredReviewMarkdown';

// Keep this list deliberately raster-only. A response can name an arbitrary
// path, but the host will only turn a bounded image file inside the session's
// working folder into a data URL.
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i;
const MIN_IMAGE_ZOOM = 0.5;
const MAX_IMAGE_ZOOM = 3;
const IMAGE_ZOOM_STEP = 0.25;

function stripReferenceDecorators(reference: string): string {
  return reference.trim().replace(/^<|>$/g, '');
}

function isImageReference(reference: string): boolean {
  return IMAGE_EXTENSIONS.test(stripReferenceDecorators(reference));
}

function isLocalImageReference(reference: string): boolean {
  const value = stripReferenceDecorators(reference);
  return isImageReference(value) && !/^(?:https?:|data:|blob:)/i.test(value);
}

/**
 * Models often put a screenshot on its own line as a filename rather than
 * using image Markdown. Turn those unambiguous references into the same image
 * token used by explicit `![alt](path)` syntax. Code fences are left alone.
 */
function normalizeImageReferences(text: string, detectImageReferences: boolean): string {
  if (!detectImageReferences) return text;

  const linked = text.replace(
    /(^|[^!])\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/g,
    (match, prefix: string, label: string, reference: string) =>
      isImageReference(reference) ? `${prefix}![${label}](${reference})` : match
  );

  let inFence = false;
  return linked.split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || /^\s*!\[/.test(line)) return line;

    const labelled = line.match(/^(\s*)(?:(?:[-*+]\s+)|(?:\d+\.\s+))?(?:screenshot|image|preview|created|generated|saved)\s*:\s*(.+?)\s*$/i);
    const bare = line.match(/^(\s*)(?:(?:[-*+]\s+))?([<]?[^<>\n]+\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#][^\s]*)?[>]?)\s*$/i);
    const candidate = labelled?.[2] ?? bare?.[2];
    if (!candidate || !isImageReference(candidate)) return line;

    const reference = stripReferenceDecorators(candidate);
    const alt = labelled ? 'Image preview' : reference.split(/[\\/]/).pop() || 'Image preview';
    const indentation = labelled?.[1] ?? bare?.[1] ?? '';
    return `${indentation}![${alt}](<${reference}>)`;
  }).join('\n');
}

function createMarkdownRenderer(imageSources: Record<string, string>, loadLocalImages: boolean) {
  // html:false keeps raw HTML inert — the renderer is sandboxed, but the
  // review and analysis text is model output, so never let markup through.
  const renderer = new MarkdownIt({ html: false, linkify: false, breaks: true });
  renderer.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    const source = String(token.attrGet('src') ?? '');
    const loadedSource = imageSources[source] ?? imageSources[stripReferenceDecorators(source)];
    const local = loadLocalImages && isLocalImageReference(source);
    const src = loadedSource ?? (local ? undefined : source);
    const alt = String(token.attrGet('alt') ?? 'Image preview');
    const escaped = renderer.utils.escapeHtml;
    const sourceAttribute = src ? ` src="${escaped(src)}"` : '';
    return `<img class="markdown-image-preview${local && !loadedSource ? ' is-loading' : ''}" data-image-source="${escaped(source)}"${sourceAttribute} alt="${escaped(alt)}" loading="lazy" />`;
  };
  return renderer;
}

/**
 * Renders a markdown string (AI review/analysis output) as sanitized HTML.
 * Styling lives in theme.css under `.markdown-body`.
 */
export function Markdown({
  text,
  testId,
  imageSessionId
}: {
  text: string;
  testId?: string;
  /** Enables safe loading of relative/local images from this AI session. */
  imageSessionId?: string;
}) {
  const normalizedText = useMemo(
    () => normalizeImageReferences(normalizeStructuredReviewMarkdown(text || ''), Boolean(imageSessionId)),
    [imageSessionId, text]
  );
  const localImageReferences = useMemo(() => {
    const references = new Set<string>();
    const imagePattern = /!\[[^\]]*\]\((<[^>\n]+>|[^)\s]+)\)/g;
    for (const match of normalizedText.matchAll(imagePattern)) {
      const reference = stripReferenceDecorators(match[1]);
      if (isLocalImageReference(reference)) references.add(reference);
    }
    return [...references];
  }, [normalizedText]);
  const [imageSources, setImageSources] = useState<Record<string, string>>({});
  const [expandedImage, setExpandedImage] = useState<{ src: string; alt: string }>();
  const [imageZoom, setImageZoom] = useState(1);

  useEffect(() => {
    setImageSources({});
    if (!imageSessionId || localImageReferences.length === 0) return;

    let cancelled = false;
    void Promise.all(localImageReferences.map(async reference => {
      try {
        const dataUrl = await window.praxis.ai.loadImagePreview(imageSessionId, reference);
        return dataUrl ? [reference, dataUrl] as const : undefined;
      } catch {
        return undefined;
      }
    })).then(results => {
      if (cancelled) return;
      const loaded = Object.fromEntries(results.filter((entry): entry is readonly [string, string] => Boolean(entry)));
      setImageSources(loaded);
    });
    return () => { cancelled = true; };
  }, [imageSessionId, localImageReferences.join('\u0000')]);

  const html = useMemo(
    () => createMarkdownRenderer(imageSources, Boolean(imageSessionId)).render(normalizedText),
    [imageSessionId, imageSources, normalizedText]
  );

  useEffect(() => {
    if (!expandedImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedImage(undefined);
      if (event.key === '+' || event.key === '=') setImageZoom(current => Math.min(MAX_IMAGE_ZOOM, current + IMAGE_ZOOM_STEP));
      if (event.key === '-') setImageZoom(current => Math.max(MIN_IMAGE_ZOOM, current - IMAGE_ZOOM_STEP));
      if (event.key === '0') setImageZoom(1);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [expandedImage]);

  const openImage = (event: MouseEvent<HTMLDivElement>) => {
    const image = (event.target as Element).closest('img.markdown-image-preview') as HTMLImageElement | null;
    if (!image || !image.naturalWidth) return;
    setImageZoom(1);
    setExpandedImage({ src: image.currentSrc || image.src, alt: image.alt || 'Expanded image preview' });
  };

  const changeImageZoom = (amount: number) => {
    setImageZoom(current => Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, current + amount)));
  };

  return (
    <>
      <div
        className="markdown-body"
        data-testid={testId}
        onClick={openImage}
        // markdown-it with html:false escapes all raw markup, so this is safe.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {expandedImage && createPortal(
        <div
          className="markdown-image-lightbox"
          data-testid="markdown-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
          data-zoom={imageZoom}
          onClick={event => { if (event.target === event.currentTarget) setExpandedImage(undefined); }}
        >
          <button
            type="button"
            className="markdown-image-lightbox-close"
            data-testid="markdown-image-lightbox-close"
            aria-label="Close image preview"
            onClick={event => {
              event.stopPropagation();
              setExpandedImage(undefined);
            }}
          >
            ×
          </button>
          <div
            className="markdown-image-lightbox-viewport"
            onWheel={event => {
              event.preventDefault();
              changeImageZoom(event.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP);
            }}
          >
            <img
              className="markdown-image-lightbox-image"
              data-testid="markdown-image-lightbox-image"
              src={expandedImage.src}
              alt={expandedImage.alt}
              style={{ transform: `scale(${imageZoom})` }}
            />
          </div>
          <div className="markdown-image-lightbox-controls" aria-label="Image zoom controls">
            <button type="button" data-testid="markdown-image-lightbox-zoom-out" aria-label="Zoom out" onClick={() => changeImageZoom(-IMAGE_ZOOM_STEP)}>−</button>
            <button type="button" data-testid="markdown-image-lightbox-zoom-reset" aria-label={`Reset zoom, currently ${Math.round(imageZoom * 100)} percent`} onClick={() => setImageZoom(1)}>{Math.round(imageZoom * 100)}%</button>
            <button type="button" data-testid="markdown-image-lightbox-zoom-in" aria-label="Zoom in" onClick={() => changeImageZoom(IMAGE_ZOOM_STEP)}>+</button>
          </div>
          <span className="markdown-image-lightbox-caption">Scroll to zoom · 0 to reset · Escape to close</span>
        </div>,
        document.body
      )}
    </>
  );
}
