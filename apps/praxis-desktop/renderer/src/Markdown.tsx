import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';

// html:false keeps raw HTML inert — the renderer is sandboxed, but the review
// and analysis text is model output, so never let markup through. Linkify is
// off too: links only render when written as explicit markdown.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

/**
 * Renders a markdown string (AI review/analysis output) as sanitized HTML.
 * Styling lives in theme.css under `.markdown-body`.
 */
export function Markdown({ text, testId }: { text: string; testId?: string }) {
  const html = useMemo(() => md.render(text || ''), [text]);
  return (
    <div
      className="markdown-body"
      data-testid={testId}
      // markdown-it with html:false escapes all raw markup, so this is safe.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
