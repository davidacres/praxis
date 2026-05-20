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
