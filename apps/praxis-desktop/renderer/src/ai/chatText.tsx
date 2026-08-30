import { Fragment, useMemo } from 'react';

/**
 * Matches, in order: a markdown link (`[label](https://…)`), an autolink
 * (`<https://…>`), and a bare URL. Agents write all three, and chat messages
 * are rendered as plain text rather than markdown, so the linkifier has to
 * recognise them itself.
 */
const LINK_PATTERN = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>"'`]+)/gi;

/**
 * A bare URL run ends where the prose resumes, and the regex cannot tell a
 * URL's own trailing `)` from the one closing "(see https://example.com)".
 * Drop sentence punctuation, then drop closing brackets only while they are
 * unbalanced — which keeps links like `…/Foo_(bar)` intact.
 */
function trimBareUrl(url: string): string {
  let result = url.replace(/[.,;:!?'"]+$/, '');
  while (/[)\]}]$/.test(result)) {
    const closer = result[result.length - 1];
    const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{';
    const opens = result.split(opener).length - 1;
    const closes = result.split(closer).length - 1;
    if (closes <= opens) break;
    result = result.slice(0, -1);
  }
  return result;
}

interface LinkPart {
  label: string;
  url: string;
}

/** Splits chat text into plain runs and the links found between them. */
export function splitChatLinks(text: string): Array<string | LinkPart> {
  const parts: Array<string | LinkPart> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const [matched, markdownLabel, markdownUrl, autoUrl, bareUrl] = match;
    const start = match.index ?? 0;
    const url = markdownUrl ?? autoUrl ?? trimBareUrl(bareUrl ?? '');
    if (!url) continue;
    // A trimmed bare URL leaves its punctuation behind as ordinary text.
    const consumed = markdownUrl || autoUrl ? matched.length : url.length;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push({ label: markdownLabel ?? url, url });
    lastIndex = start + consumed;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export interface ChatTextProps {
  text: string;
  /**
   * Where a clicked link goes. Defaults to the system browser so a caller that
   * has not wired the embedded browser still opens the page somewhere.
   */
  onOpenLink?: (url: string) => void;
}

/**
 * Chat message body: plain text with any URL in it turned into a clickable
 * link. The default browser action is suppressed — following an `href` inside
 * the renderer would navigate the whole app window away from the app.
 */
export function ChatText({ text, onOpenLink }: ChatTextProps) {
  const parts = useMemo(() => splitChatLinks(text ?? ''), [text]);
  const open = onOpenLink ?? ((url: string) => void window.praxis.shell.openExternal(url));
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          <Fragment key={index}>{part}</Fragment>
        ) : (
          <a
            key={index}
            className="session-chat-link"
            data-testid="session-chat-link"
            href={part.url}
            title={part.url}
            onClick={event => {
              event.preventDefault();
              open(part.url);
            }}
            onAuxClick={event => event.preventDefault()}
          >
            {part.label}
          </a>
        )
      )}
    </>
  );
}
