import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

/** Renders user markdown to HTML. Raw HTML in source is escaped (no `html: true`). */
export function markdownToHtmlSafe(markdown: string): string {
  const t = markdown.trim();
  if (!t) {
    return '';
  }
  return md.render(markdown);
}

/** Shared styles for rendered markdown in webviews (issue description preview, parent preview). */
export const MARKDOWN_BODY_CSS = `
.markdown-body { font-size: 13px; line-height: 1.5; color: var(--vscode-editor-foreground); }
.markdown-body.is-empty { display: none; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body p { margin: 0 0 8px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
  margin: 10px 0 6px;
  font-size: 1.05em;
  font-weight: 600;
  line-height: 1.35;
}
.markdown-body ul, .markdown-body ol { margin: 0 0 8px; padding-left: 1.35em; }
.markdown-body li { margin: 2px 0; }
.markdown-body code {
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15));
}
.markdown-body pre {
  margin: 0 0 8px;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
}
.markdown-body pre code { padding: 0; background: transparent; font-size: 0.9em; }
.markdown-body blockquote {
  margin: 0 0 8px;
  padding: 4px 0 4px 10px;
  border-left: 3px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}
.markdown-body a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.markdown-body a:hover { text-decoration: underline; }
.markdown-body hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
.markdown-body table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-size: 12px; }
.markdown-body th, .markdown-body td {
  border: 1px solid var(--vscode-panel-border);
  padding: 4px 8px;
}
.parent-preview-description.markdown-body { font-size: 11px; }
`;
