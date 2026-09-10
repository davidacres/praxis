---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-147
title: "Capture scoped browser evidence"
status: In Progress
story: FX-BE-056
updated: 2026-09-09
dependencies: [FX-BE-055]
---

# TASK-147: Capture scoped browser evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Add bounded console/network buffers and screenshot capture with run IDs, timestamps, redaction and capture-failure metadata; isolate sessions between projects.

## Implementation entry points

main/src/main/aiBrowser.ts; packages/core/src/ai/tools/browserTools.ts; packages/core/src/ai/browserMcpServer.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-055
## Acceptance criteria

- Seeded console error and failed API request appear in the correct run bundle; credentials and unrelated browser sessions do not enter attachments.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: capture, redaction, bounded buffers, and per-(project, run, service) isolated storage are
implemented and fully tested; the Electron wiring that feeds real console/network/screenshot events
into it is written and compiles, but — like every Electron-touching piece this session — has not
been run. Left `in-progress`.**

**Implemented — core (fully tested under `node --test`):**

- `packages/core/src/projects/browserDiagnostics.ts` (new): `BrowserDiagnosticsRecorder` — one
  instance per (project, run, service), owning its own bounded ring buffers (`DEFAULT_CONSOLE_BUFFER_SIZE`
  / `DEFAULT_NETWORK_BUFFER_SIZE` = 200 each) so a chatty page can never grow capture without limit; a
  push past capacity drops the oldest entry and sets `truncated: true` on the eventual snapshot rather
  than silently discarding without a trace. `recordConsole`/`recordNetworkFailure` redact every string
  (message, URL, error) through `workflows/workflowEvidence.ts`'s existing `redactEvidenceContent`
  before it ever reaches the buffer — reused rather than re-implemented, and exercised directly: a
  `Bearer sk_live_…` console line and an `?api_key=…` failed-request URL both come back scrubbed with
  `redacted: true`, an ordinary message/URL comes back `redacted: false`. A network failure records
  `status` (an HTTP response that came back, e.g. 500) and `error` (a connection-level failure, e.g.
  refused/DNS) as genuinely distinct, never conflated fields. `snapshot()` is a pure, immutable read —
  isolation between sessions holds because each recorder is its own object with no shared or global
  state, proven directly (two recorders for two different runIds never see each other's entries).
- Storage: `writeBrowserDiagnosticsBundle`/`readBrowserDiagnosticsBundle` (JSON manifest,
  overwrite-not-append, malformed-file-safe) and `writeScreenshot`/`readScreenshot` (binary, filename
  generated internally — never accepted from a caller, so a hand-edited bundle's `path` can't be used
  to escape the bundle's own directory; `readScreenshot` re-validates it anyway before joining a
  filesystem path). `<storageRoot>/<projectId>/<runId>/<serviceId>/` mirrors
  `workflowEvidence.ts`'s `evidenceBundleDir` exactly: every segment checked with the newly-exported
  `isSafeSegment`, then the joined result re-checked against the resolved root — the same
  defence-in-depth, applied to the project/run/service isolation boundary this story holds as an
  invariant rather than a convenience.
- `packages/core/src/workflows/workflowEvidence.ts` — exported `isSafeSegment` and `truncateUtf8Tail`
  (both were already correct, private helpers) so `browserDiagnostics.ts` reuses the exact same
  path-safety and tail-preserving-truncation logic instead of a second copy. Pure extraction — no
  behavior change, confirmed by the existing workflow-evidence suite passing unmodified.
- `packages/core/src/projects/previewAccess.ts` — added `grantFor(url)` (the missing half of
  `isOriginGranted`: recovers *which* project/run/service granted a URL's origin, not just whether
  one did) — needed because the preview surface only ever has a URL, and diagnostics captured from it
  must be attributed to the actual owning identity, not asserted separately.
- Tests: 17 in `browserDiagnostics.test.ts` (seeded console error and failed request land in the
  correct bundle fields; connection-level vs. HTTP-status failures distinguished; credential
  redaction in both console and network capture; ordinary content not falsely marked redacted;
  cross-run isolation; bounded-buffer drop-and-truncate; round-trip storage; malformed-file and
  never-written-bundle handling; two projects' bundles never collide; a path-traversal-shaped
  projectId is refused before touching disk; screenshot round-trip; a path-traversal-shaped
  screenshot record fails closed; a `missing` screenshot carries its reason) plus 2 new
  `previewAccess.test.ts` tests for `grantFor`.

**Implemented — main process (compiles, Electron-unverified):**

- `apps/praxis-desktop/main/src/main/browserDiagnosticsStorage.ts` (new) —
  `userData/browser-diagnostics/`, the same per-profile-isolated pattern as TASK-133's
  `evidenceStorageRoot()` and TASK-146's `runStateStorageRoot()`.
- `apps/praxis-desktop/main/src/main/previewBrowser.ts` — every `open(url)` resolves
  `previewAccess.grantFor(url)` and starts a **fresh** `BrowserDiagnosticsRecorder` for whatever
  identity granted that origin (or none, if somehow ungranted — capture becomes a documented no-op
  rather than attributing evidence to a guess). Wired real Electron events into it: `console-message`
  (mapped through Electron's documented 0–3 verbosity levels), `did-fail-load` for main-frame
  navigation failures, and `session.webRequest.onCompleted`/`onErrorOccurred` on the preview's own
  partition for subresource-level failures (a failed image/xhr/fetch the previewed page's own script
  made) — added alongside the `onBeforeRequest` access check TASK-146 already registered on that same
  session, not replacing it. `captureDiagnostics()` screenshots the live page
  (`webContents.capturePage()` → PNG), folds the result into the active recorder's snapshot (a capture
  failure records a `missing` screenshot with its reason rather than throwing the whole capture away),
  persists the bundle, and returns it.
- `apps/praxis-desktop/main/src/main/runControlIpc.ts` — added `preview:captureDiagnostics`.
  `packages/core/src/host/ipcContracts.ts` — added `PreviewIpc.captureDiagnostics()`. Preload exposure
  in `apps/praxis-desktop/main/src/preload/index.ts`.
- `apps/praxis-desktop/renderer/src/projects/PreviewPane.tsx` — a "Capture diagnostics" button and a
  one-line result summary (console/network/screenshot counts) — deliberately thin: this proves the
  round trip from a click down to a persisted bundle and back, not a diagnostics viewer. Reading a
  bundle back for actual review (by a person or an agent) is TASK-148's "expose diagnostics to
  agents" and TASK-149's verification-workflow territory.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root) —
641/641 passing (17 new diagnostics tests + 2 new `grantFor` tests; the `workflowEvidence.ts` export
additions changed no existing test's behavior). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean. `npm run check-types` in `apps/praxis-desktop/renderer` (runs
`check-core-imports` then `tsc --noEmit`) — clean.

**Remaining limitations:** Nothing has actually opened a preview, triggered a console error, or
clicked "Capture diagnostics" — Electron cannot launch in this sandbox (the same `node-pty` blocker
recorded on every prior UI-touching task). The `console-message` level mapping (0=verbose→'log',
1='info', 2='warning', 3+='error') follows Electron's documented enum but has not been checked
against a real page's actual console output. `did-fail-load`'s main-frame-only filtering assumes
`onErrorOccurred` covers every subresource failure — plausible from Electron's own API docs, not
observed. No agent-facing read path exists yet (a diagnosis session, an ACP/MCP tool, or a workflow
check cannot currently retrieve a captured bundle) — that is explicitly TASK-148's scope. Screenshot
capture has no size cap beyond whatever `capturePage()`/`toPNG()` naturally produces at the view's
current bounds — acceptable for a single manual capture, but worth a bound if this is ever
called automatically and repeatedly (e.g. by TASK-149's verification workflow).

## Description


## Comments


