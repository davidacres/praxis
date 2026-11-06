import { highlightCode, languageFor } from '../../ui/codeHighlight';
import type { ActiveArtifact } from './artifactTypes';

export interface ArtifactCodeSurfaceProps {
  artifact: ActiveArtifact;
  content: string;
  mode?: 'code' | 'diff';
  title?: string;
  hideBanner?: boolean;
}

export function ArtifactCodeSurface({
  artifact,
  content,
  mode = 'code',
  title,
  hideBanner = false
}: ArtifactCodeSurfaceProps) {
  const lines = content.split('\n');
  const langLabel = artifact.language || languageFor(artifact.path);

  if (mode === 'diff') {
    return (
      <div className="artifact-diff-view" data-testid="artifact-diff-view">
        {!hideBanner && (
          <div className="artifact-diff-banner">
            <span className="artifact-diff-banner-tag">Changes (+{lines.length})</span>
            <span className="artifact-diff-banner-path">{title || artifact.path}</span>
          </div>
        )}
        <div className="artifact-diff-scroll">
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
      </div>
    );
  }

  return (
    <div className="artifact-code-view" data-testid="artifact-code-view">
      {!hideBanner && (
        <div className="artifact-code-banner">
          <div className="artifact-code-banner-left">
            <span className="artifact-code-banner-lang">{langLabel}</span>
            {artifact.category && (
              <span className={`gadget-artifact-category-badge category-${artifact.category}`}>
                {artifact.category}
              </span>
            )}
            {title && <span className="artifact-code-banner-path">{title}</span>}
          </div>
          <span className="artifact-code-banner-count">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
        </div>
      )}
      <div className="artifact-code-scroll">
        <div className="artifact-code-lines">
          {lines.map((line, idx) => (
            <div key={idx} className="artifact-code-line">
              <span className="artifact-code-lineno">{idx + 1}</span>
              <code className="artifact-code-text">{highlightCode(line) || ' '}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
