---
**Status:** Backlog
**Created:** 2026-10-12T00:00:00.000Z
**Type:** Task
**Priority:** Medium
**Requested By:** Dave Acres
id: TASK-440
title: Open chat links in an isolated preview pane
status: Backlog
updated: 2026-10-12
---

# Open chat links in an isolated preview pane

## Description

A URL in an AI session chat cannot be followed in-app: the message body is not linkified, so the only way to see a linked page is to copy it into a system browser. Clicking a link should load the page in the right-hand pane, beside the conversation it came from.

This replaces the unmerged branch `claude/embedded-browser-chat-links-ipk4r0` (commit `7721316e`, 2026-08-30), which was dropped rather than merged. It used an Electron `<webview>` with `webviewTag` enabled, which conflicts with the current hardening: every window now sets `webviewTag: false`, embedded content uses an isolated `WebContentsView` (`aiBrowser.ts`, `previewBrowser.ts`), and FX-BF-107 added navigation guards, trusted-IPC enforcement and an SSRF classifier. It also edited `ai/chatText.tsx`, which no longer exists; chat text now renders through `ui/Markdown.tsx`.

## Approach

- Linkify in the current Markdown renderer (`renderer/src/ui/Markdown.tsx`), not a new chat-text component. Intercept the click; following an `href` inside the renderer would navigate the whole app window away.
- Load the page in a `WebContentsView` pane following the `PreviewPane.tsx` / `previewBrowser.ts` pattern: own `persist:` partition, no Node, http(s) only, popups denied (navigate in place), `file://` refused, navigation guarded centrally in main rather than by tag attributes.
- Apply the same URL policy as the AI browser (`blockedBrowserUrlReason` / `networkAddress.ts`) so a model-written link cannot reach private or loopback hosts; consider a confirm step for the first link from a given message.
- Pane chrome: back, forward, reload/stop, an editable address, and a hand-off to the system browser (`shell.openExternal`). Give each click a request token so clicking the same link twice re-navigates after the user has browsed on.
- Selecting a work item takes the right-hand pane back from the browser, so a ticket opened after following a link is not hidden behind a web page.

## Reusable logic from the dropped branch

Agents write markdown links, `<autolinks>` and bare URLs. A bare URL's trailing sentence punctuation stays prose, and a closing bracket is only dropped when unbalanced, so `…/Foo_(bar)` survives:

```ts
const LINK_PATTERN = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>"'`]+)/gi;

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
```

Fold this into `Markdown.tsx`'s link handling only where its existing parser does not already cover bare URLs and trailing punctuation.

## Acceptance criteria

- [ ] A markdown link, an autolink and a bare URL in a chat message are clickable; trailing punctuation and balanced brackets behave as above.
- [ ] Clicking loads the page in the right-hand pane; the app window never navigates away.
- [ ] The guest has no Node, no preload, an isolated session, http(s) only, popups denied, `file://` blocked, and `webviewTag` stays `false` everywhere.
- [ ] Private, loopback and non-http(s) URLs are refused with a visible reason.
- [ ] Back/forward/reload/stop, the address bar and "open in system browser" work; clicking the same link twice re-navigates.
- [ ] Selecting a work item restores the pane.
- [ ] An e2e spec serves a local page, clicks the linkified URL and asserts the guest's title (which only arrives from a real load), plus a refusal case for a blocked URL. Keyboard focus and tooltips follow the repo's focus and icon-button rules.

## Dependencies

- FX-BF-107 hardening (already on `main`).

## Comments
**2026-10-12:** Created while tidying branches: the old branch is deleted in favour of this ticket. Its linkification logic is preserved above; the full original diff is recoverable from commit `7721316e` until the remote objects are garbage-collected.
