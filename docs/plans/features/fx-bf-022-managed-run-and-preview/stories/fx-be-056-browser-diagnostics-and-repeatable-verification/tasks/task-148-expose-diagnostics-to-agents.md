---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-148
title: "Expose diagnostics to agents"
status: in-progress
story: FX-BE-056
updated: 2026-09-09
dependencies: [TASK-147]
---

# TASK-148: Expose diagnostics to agents

**Priority:** High
**Created:** 2026-09-07

## Goal

Extend BrowserBridge and its gateway/MCP wrappers with diagnostic reads and capture; capability-detect hosts and preserve existing browser tools.

## Implementation entry points

main/src/main/aiBrowser.ts; packages/core/src/ai/tools/browserTools.ts; packages/core/src/ai/browserMcpServer.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-147
## Acceptance criteria

- Gateway and scripted ACP fixtures receive equivalent diagnostic records; unsupported capture is reported rather than invented.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: `BrowserBridge` extended with capability-detected diagnostic methods, two new gateway/MCP
tools fully tested against both dispatch paths, and `aiBrowser.ts` wired with real capture — the same
pattern TASK-147 used for the Run preview surface, applied here to the AI-driven browser. Electron
wiring is unverified for the usual reason (sandbox blocks Electron entirely). Left `in-progress`.**

**Implemented — core (fully tested, no Electron involved):**

- `packages/core/src/ai/tools/browserTools.ts` — `BrowserBridge` gained two **optional** methods:
  `getDiagnostics?(): Promise<BrowserDiagnosticsSummary>` and
  `captureScreenshot?(): Promise<BrowserScreenshotResult>`. Optional by design, not oversight — this
  *is* "capability-detect hosts" as the acceptance criteria name it: `executeBrowserTool` checks
  `typeof ctx.bridge.getDiagnostics === 'function'` and reports "not supported by this browser host"
  when it's absent, rather than returning an empty-but-plausible result that would read as "nothing
  happened" instead of "this host can't tell you." Making them required would have broken every
  existing `BrowserBridge` fake in the test suite for no benefit — optionality is the capability
  signal itself.
- Two new tool definitions added to `BROWSER_TOOL_DEFINITIONS` (the single array both
  `createBrowserToolExtension` (gateway) and `BrowserMcpServer` (ACP) build their tool list from —
  this is what makes "Gateway and scripted ACP fixtures receive equivalent diagnostic records" true
  structurally, not just by parallel testing): `browser_diagnostics` (console/network evidence since
  the last navigation) and `browser_screenshot` (captures for the **user** to review — its description
  is explicit that the image itself is never returned to the model, only a confirmation). Dispatch
  added to `executeBrowserTool`: `browser_diagnostics` renders console lines and failed requests as
  text (`renderDiagnostics`, distinguishing an HTTP status outcome from a connection-level error, and
  noting when the capture was truncated) via the bridge's `getDiagnostics()`; `browser_screenshot`
  returns the bridge's own `note` as the tool content, with `ok` following `captured` — a failed
  capture is `ok: false` with a real reason, never a thrown error the model has to guess at.
- `packages/core/src/ai/tools/index.ts` — exported the two new types.
- Tests: 8 new in `browserTools.test.ts` (unsupported-capability reporting for both tools against a
  bridge that doesn't implement them; formatted console/network output with both outcome kinds;
  the truncated-capture note; an empty-but-genuinely-empty capture reported plainly, not as an error;
  a successful screenshot's note passed through verbatim; a failed screenshot surfaced as `ok:false`
  with its reason). `browserMcpServer.test.ts`'s two exact-tool-list/exact-count assertions updated
  to include `browser_diagnostics`/`browser_screenshot` (5→7 tools) — these were pre-existing tests
  whose literal expected lists needed updating for the new tools, not new coverage, and they still
  pass through the *same* `BrowserMcpServer`, proving the ACP path picks up the new tools automatically
  from the same `BROWSER_TOOL_DEFINITIONS` array the gateway path uses.
  - **Caught while running the full suite:** the first attempt at a full `test:core` run showed 2
    failures — turned out to be resource contention from several overlapping `npm run test:core`
    invocations left running concurrently from earlier background-task bookkeeping, not real bugs (a
    clean single run after killing the strays reproduced the *actual* failures: the two
    `browserMcpServer.test.ts` exact-list/exact-count assertions, expected and fixed as above). Worth
    recording because it's a reminder to run one test invocation at a time and actually verify the
    process count, not just trust the first return code.

**Implemented — main process (compiles, Electron-unverified):**

- `apps/praxis-desktop/main/src/main/aiBrowser.ts` — `AiBrowserManager` gained a
  `BrowserDiagnosticsRecorder` under a fixed sentinel key (`ai-browser/session/default` — this browser
  is one shared app-wide instance with no project/run/service identity of its own, unlike the Run
  preview's per-grant identity). Wired the same real Electron hooks TASK-147 used in
  `previewBrowser.ts`: `console-message`, `did-fail-load` (main-frame only), and
  `session.webRequest.onCompleted`/`onErrorOccurred` on the AI browser's own
  `persist:praxis-ai-browser` partition. A genuine cross-document `did-navigate` starts a fresh
  recorder (evidence belongs to the page that just left, not the one arriving); an in-page (SPA route)
  transition keeps accumulating into the same one. `getDiagnostics()` and `captureScreenshot()` on
  `AiBrowserManager`, delegated straight through by `AiBrowserBridge` (the class the gateway/MCP tools
  actually call), reusing TASK-147's `writeScreenshot`/`browserDiagnosticsStorageRoot()` rather than a
  second storage path.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), run once
cleanly after clearing stray concurrent processes — **648/648 passing** (8 new `browserTools.test.ts`
diagnostics/screenshot tests; the `browserMcpServer.test.ts` assertions updated as described; nothing
else changed behavior). `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` — clean.
`npm run check-types` in `apps/praxis-desktop/renderer` — clean (no renderer changes in this task;
confirmed the workspace still builds against the extended core contract regardless).

**Remaining limitations:** Nobody has actually called `browser_diagnostics`/`browser_screenshot`
through a real agent session — Electron cannot launch in this sandbox, so the `console-message`/
`did-fail-load`/`webRequest` wiring in `aiBrowser.ts` is unverified the same way `previewBrowser.ts`'s
was in TASK-147. No renderer surface shows the AI browser's own diagnostics to a person (unlike
`PreviewPane.tsx`'s "Capture diagnostics" button) — this task's scope was the agent-facing tool
surface specifically, per its own goal ("Extend BrowserBridge and its gateway/MCP wrappers"), and a
person watching the AI browser pane doesn't currently see what the agent captured. The
`browser_screenshot` tool's description tells the model the image is never returned to it, but nothing
enforces that at the protocol level beyond the tool simply never including image content in its
result — a future gateway/ACP change that started attaching images to tool results generically would
need to specifically exclude this one, which is worth flagging rather than assuming is permanent.

## Description


## Comments


