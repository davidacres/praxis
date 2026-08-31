import type { ProjectDocument } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';

export function ProjectDocumentPreview({
  document,
  width,
  onClose
}: {
  document: ProjectDocument;
  /** Pane width in px, driven by the App-level splitter. */
  width?: number;
  onClose: () => void;
}) {
  return <aside
    className="project-document-preview"
    data-testid="project-document-preview"
    style={width ? { width } : undefined}
  >
    <header>
      <div><strong>{document.name}</strong><small>{document.relativePath}</small></div>
      <button className="icon-btn icon-btn-sm" aria-label="Close document preview" title="Close" onClick={onClose}><Icon name="close" size={14} /></button>
    </header>
    <div className="project-document-preview-body"><Markdown text={document.content ?? ''} /></div>
  </aside>;
}
