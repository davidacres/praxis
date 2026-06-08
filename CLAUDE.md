# CLAUDE.md

## Project Overview

VS Code extension for ticket/issue management with AI agent integration.

## Webview Panel Rules

**CRITICAL: VS Code Insiders webview rendering requirement**

When creating webview panels (`createWebviewPanel`), `panel.webview.html` MUST be set
synchronously — in the same execution block — immediately after panel creation. Any `await`
between `createWebviewPanel()` and the `webview.html` assignment will cause the webview to
render blank in VS Code Insiders.

Wrong:
```typescript
const panel = vscode.window.createWebviewPanel(...);
await fetchData();              // async gap breaks rendering in Insiders
panel.webview.html = getHtml(); // too late — blank forever
```

Right:
```typescript
await fetchData();              // fetch data first
const panel = vscode.window.createWebviewPanel(...);
panel.webview.html = getHtml(); // set immediately — works
```

If a panel needs to be refreshed with new data, dispose the old panel and create a new one
rather than setting `webview.html` on an existing panel after an async operation. See
`IssueDetailPanelManager.createPanelWithHtml()` and `refreshIfShowing()` for the pattern.

**CSP pattern**: All webview panels should use:
```
default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';
```
Use `<style>` without a nonce attribute, and `<script nonce="${nonce}">` for scripts.

**IMPORTANT: Script runtime scope**

Code inside `<script nonce="...">` runs in the webview browser context and cannot call
TypeScript helper functions declared in the extension host file scope.

If script code needs helper logic (for example color/format utilities used by `renderNodes`),
define that logic inside the webview script block (or serialize required values) rather than
calling host-scope functions directly.

Regression note:
- Calling host-only helpers from webview script previously caused runtime errors that broke node
	rendering and ticket add flows in Task Designer.

## Webview Layout Rules

**CRITICAL: Remove VS Code's default body padding to avoid the black left/right gutter**

VS Code injects a default `body { padding: 0 20px }` into every webview. Any panel whose CSS
does not override it shows a black gutter (the editor background) down the left and right edges,
pushing all content inward. This was reported as "extra margin" / "black area on the left and
right" of the board and other custom panes.

**Rule:** Every webview's `body` rule MUST explicitly set `padding: 0`. Do not rely on
`margin: 0` — that does not remove the injected padding. Control all spacing yourself from an
inner container, never from the default body padding.

Wrong (inherits the ~20px gutter):
```css
body { margin: 0; display: flex; }
```

Right (no gutter; spacing owned by inner containers):
```css
body { margin: 0; padding: 0; display: flex; }
```

**Canonical full-pane layout (rounded panel)**

The board (`boardPanelManager`), Issue Detail (`issueDetailPanelManager`) and Local Peer Review
(`localPeerReviewPanel`) panes share one layout. Reuse it for any new full-pane screen so they
stay visually consistent:

```css
body { margin: 0; padding: 0; /* removes the injected gutter */ }

.page {                 /* outer frame: thin even margin around the panel */
  box-sizing: border-box;
  display: flex;
  flex: 1;
  width: 100%;
  min-height: 100vh;
  padding: 8px;
}

.panel-shell {          /* the rounded-corner panel */
  box-sizing: border-box;
  display: flex;
  flex: 1;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}

.header, .content { padding: 16px; }   /* inner spacing lives here, not on body */
```

Notes:
- For an edge-to-edge canvas (e.g. Task Designer) still set `body { padding: 0 }`, but use a
  full-bleed root (`.shell { width: 100%; height: 100% }`) instead of the `.page` frame.
- The visible spacing of a pane is `body(0) + .page padding + .panel-shell border + inner
  padding`. To bring content closer to the edge, reduce `.page` padding — do NOT reintroduce
  body padding.
- Card/column styling inside the panel is independent of this frame; changing the frame must not
  alter card colors.
