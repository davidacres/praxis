import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../../ui/Markdown';
import { Icon } from '../../ui/Icon';
import type { ActiveArtifact } from './artifactTypes';

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const SVG_EXTENSIONS = /\.svg$/i;
const HTML_EXTENSIONS = /\.html?$/i;
const MD_EXTENSIONS = /\.(?:md|markdown)$/i;

function isHtmlArtifact(artifact: ActiveArtifact): boolean {
  if (HTML_EXTENSIONS.test(artifact.path.split(/[?#]/, 1)[0] ?? '')) return true;
  if (artifact.mediaType && ['text/html', 'application/xhtml+xml'].includes(artifact.mediaType.toLowerCase())) return true;
  if (artifact.language && ['html', 'htm'].includes(artifact.language.toLowerCase())) return true;
  if (artifact.content && /^\s*<!doctype\s+html|^\s*<html\b/i.test(artifact.content)) return true;
  return false;
}

function isSvgArtifact(artifact: ActiveArtifact): boolean {
  if (SVG_EXTENSIONS.test(artifact.path.split(/[?#]/, 1)[0] ?? '')) return true;
  if (artifact.mediaType && artifact.mediaType.toLowerCase() === 'image/svg+xml') return true;
  if (artifact.language && artifact.language.toLowerCase() === 'svg') return true;
  if (artifact.content && /^\s*<svg\b/i.test(artifact.content)) return true;
  return false;
}

function isMarkdownArtifact(artifact: ActiveArtifact): boolean {
  if (MD_EXTENSIONS.test(artifact.path.split(/[?#]/, 1)[0] ?? '')) return true;
  if (artifact.mediaType && ['text/markdown', 'text/x-markdown'].includes(artifact.mediaType.toLowerCase())) return true;
  if (artifact.language && ['md', 'markdown'].includes(artifact.language.toLowerCase())) return true;
  return false;
}

function isImageArtifact(artifact: ActiveArtifact): boolean {
  if (IMAGE_EXTENSIONS.test(artifact.path.split(/[?#]/, 1)[0] ?? '')) return true;
  if (artifact.mediaType && artifact.mediaType.toLowerCase().startsWith('image/') && artifact.mediaType.toLowerCase() !== 'image/svg+xml') return true;
  return false;
}

export function ArtifactPreview({
  artifact,
  content,
  sessionId
}: {
  artifact: ActiveArtifact;
  content: string;
  sessionId?: string;
}) {
  const [imageSrc, setImageSrc] = useState<string | undefined>();
  const [loadingImage, setLoadingImage] = useState(false);

  const effectiveSessionId = artifact.sessionId ?? sessionId;

  useEffect(() => {
    if (isImageArtifact(artifact) && effectiveSessionId && artifact.path) {
      setLoadingImage(true);
      window.praxis.ai.loadImagePreview(effectiveSessionId, artifact.path)
        .then(src => {
          setImageSrc(src);
        })
        .catch(() => setImageSrc(undefined))
        .finally(() => setLoadingImage(false));
    }
  }, [artifact.path, effectiveSessionId, artifact]);

  const htmlDoc = useMemo(() => {
    if (!isHtmlArtifact(artifact) && !isSvgArtifact(artifact)) return '';

    // Collect inherited theme variables from Praxis document root
    const rootStyle = getComputedStyle(document.documentElement);
    const bgCanvas = rootStyle.getPropertyValue('--bg-canvas').trim() || '#141416';
    const bgSurface = rootStyle.getPropertyValue('--bg-surface').trim() || '#1c1c20';
    const textPrimary = rootStyle.getPropertyValue('--text-primary').trim() || '#f0f0f2';
    const textSecondary = rootStyle.getPropertyValue('--text-secondary').trim() || '#a0a0a8';
    const borderStrong = rootStyle.getPropertyValue('--border-strong').trim() || '#2e2e34';
    const accent = rootStyle.getPropertyValue('--accent').trim() || '#4d88ff';
    const fontSans = rootStyle.getPropertyValue('--font-sans').trim() || 'system-ui, -apple-system, sans-serif';

    const themeStyles = `
      :root {
        --bg-canvas: ${bgCanvas};
        --bg-surface: ${bgSurface};
        --text-primary: ${textPrimary};
        --text-secondary: ${textSecondary};
        --border-strong: ${borderStrong};
        --accent: ${accent};
        --font-sans: ${fontSans};
      }
      body {
        font-family: var(--font-sans);
        background: var(--bg-canvas);
        color: var(--text-primary);
        margin: 0;
        padding: 20px;
        box-sizing: border-box;
      }
    `;

    const securityBootstrap = `
      <script>
        document.addEventListener('click', function(e) {
          var target = e.target;
          var link = target instanceof Element ? target.closest('a') : null;
          if (link && !link.getAttribute('href')?.startsWith('#')) {
            e.preventDefault();
          }
        }, true);
        document.addEventListener('submit', function(e) {
          e.preventDefault();
        }, true);
        window.onerror = function(msg, url, line) {
          var errDiv = document.getElementById('praxis-artifact-error');
          if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.id = 'praxis-artifact-error';
            errDiv.style.background = 'color-mix(in srgb, #ff4d4f 15%, #1c1c20)';
            errDiv.style.border = '1px solid #ff4d4f';
            errDiv.style.color = '#ff7875';
            errDiv.style.padding = '12px';
            errDiv.style.borderRadius = '6px';
            errDiv.style.margin = '16px 0';
            errDiv.style.fontFamily = 'monospace';
            errDiv.style.fontSize = '12px';
            document.body.prepend(errDiv);
          }
          errDiv.textContent = 'Runtime error: ' + msg + (line ? ' (line ' + line + ')' : '');
        };
      </script>
    `;

    if (isSvgArtifact(artifact)) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${themeStyles} html, body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; } svg { max-width: 100%; height: auto; }</style></head><body>${content}</body></html>`;
    }

    if (/<head\b[^>]*>/i.test(content)) {
      return content.replace(/<head\b[^>]*>/i, match => `${match}<style>${themeStyles}</style>${securityBootstrap}`);
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${themeStyles}</style>${securityBootstrap}</head><body>${content}</body></html>`;
  }, [artifact, content]);

  if (isMarkdownArtifact(artifact)) {
    return (
      <div className="artifact-preview-markdown" data-testid="artifact-preview-markdown">
        <Markdown text={content} imageSessionId={effectiveSessionId} testId="artifact-markdown" />
      </div>
    );
  }

  if (isImageArtifact(artifact)) {
    return (
      <div className="artifact-preview-image" data-testid="artifact-preview-image">
        {loadingImage && <div className="artifact-preview-loading"><Icon name="refresh" size={16} /> Loading preview…</div>}
        {imageSrc ? (
          <img src={imageSrc} alt={artifact.name} />
        ) : !loadingImage ? (
          <div className="artifact-preview-empty">
            <Icon name="file" size={24} />
            <span>Image could not be rendered</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (isHtmlArtifact(artifact) || isSvgArtifact(artifact)) {
    return (
      <div className="artifact-preview-iframe-wrapper" data-testid="artifact-preview-html">
        <iframe
          className="artifact-preview-iframe"
          sandbox="allow-scripts"
          srcDoc={htmlDoc}
          title={artifact.name}
        />
      </div>
    );
  }

  // Fallback for code or other formats
  return (
    <div className="artifact-preview-fallback" data-testid="artifact-preview-fallback">
      <div className="artifact-preview-card">
        <Icon name="sparkles" size={24} />
        <h4>{artifact.name}</h4>
        <p>{artifact.description || 'This file does not have a live interactive preview.'}</p>
        <span className="badge">{artifact.language || artifact.mediaType || 'Source code'}</span>
        <p className="artifact-hint">Switch to the <strong>Code</strong> tab to inspect the source.</p>
      </div>
    </div>
  );
}
