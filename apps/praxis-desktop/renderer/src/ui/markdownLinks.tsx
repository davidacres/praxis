import { createContext, useContext } from 'react';

/**
 * Where a link clicked inside rendered Markdown goes. A surface that has an
 * in-app browser (the session console) provides one; everywhere else a link
 * falls back to the system browser. Either way the click is intercepted —
 * following an `href` inside the renderer would navigate the whole app window.
 */
export interface MarkdownLinkHandler {
  openLink(url: string): void;
}

export const MarkdownLinkContext = createContext<MarkdownLinkHandler | undefined>(undefined);

export function useMarkdownLinkHandler(): MarkdownLinkHandler | undefined {
  return useContext(MarkdownLinkContext);
}

/** The only links worth handing on: an absolute http(s) URL. Everything else (javascript:, file:, relative) is inert. */
export function followableUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
