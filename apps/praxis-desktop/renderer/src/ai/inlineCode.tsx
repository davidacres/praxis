import type { ReactNode } from 'react';

/** Renders the backticked `code` spans that feedback titles and evidence carry (paths, commands). */
export function renderInlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).filter(Boolean).map((part, index) =>
    part.startsWith('`') && part.endsWith('`')
      ? <code key={index} className="prompt-inline-code">{part.slice(1, -1)}</code>
      : <span key={index}>{part}</span>
  );
}
