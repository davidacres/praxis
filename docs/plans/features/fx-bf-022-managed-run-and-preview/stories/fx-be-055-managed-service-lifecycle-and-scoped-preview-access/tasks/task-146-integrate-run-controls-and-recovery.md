---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-146
title: "Integrate Run controls and recovery"
status: in-progress
story: FX-BE-055
updated: 2026-09-09
dependencies: [TASK-145]
---

# TASK-146: Integrate Run controls and recovery

**Priority:** High
**Created:** 2026-09-07

## Goal

Show service health, live output, start/stop/restart and preview URL; after app restart reconcile owned processes conservatively and label uncertain state.

## Implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-145
## Acceptance criteria

- Electron fixtures exercise multi-service startup, crash and recovery; closing a preview tab does not silently terminate a persistent deployment.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: this closes the loop across the whole story — TASK-144's manager and TASK-145's origin
grants are now wired into a real main-process registry, real IPC, a real (structurally complete)
Electron preview surface, and a real renderer UI with live status/logs/preview. Left `in-progress`
because none of the Electron-specific pieces (the process registry's actual process lifecycle, the
preview `WebContentsView`'s navigation guards, the IPC round trip) have been run — Electron itself
remains blocked in this sandbox (missing `node-pty` native binding, rebuild blocked by egress
policy), the same limitation recorded on every UI-touching task this session.**

**Implemented — core (extends TASK-144/145, fully tested under plain `node --test`):**

- `packages/core/src/projects/runServiceManager.ts` — added `stopService`/`startService`/
  `restartService` to `RunServiceManager` (Run controls' per-service actions; the manager previously
  only supported starting/stopping the whole run at once). `startService` reuses the `projectFolder`/
  `readinessTimeoutMs` the run itself was started with (now kept on the instance) and refuses —
  rather than silently marking the service failed on its own initiative, the way the bulk `start()`
  fan-out does — when the service's own `dependsOn` aren't currently `ready`, since a direct
  per-service action from a person deserves a clear rejection, not an inferred failure. 6 new tests:
  `stopService` leaves the rest of the run alone; `startService` spawns a genuinely new process (pid
  changes) rather than reusing the old one; `restartService` is stop-then-start; both refuse an
  unknown service id and a dependency that isn't ready; `startService` refuses outright when no run
  is active.
- `packages/core/src/projects/runReconciliation.ts` (new) — the "after app restart" half.
  `writeRunState`/`readRunState`/`clearRunState` persist a project's run (schema-versioned JSON, same
  overwrite-not-append discipline as `runProfileStore.ts`). `reconcileRunState` is the conservative
  policy itself: a `RunServiceManager` is purely in-memory, so after a relaunch there is no
  `ChildProcess` handle to reattach to and no way to re-verify what "ready" ever meant for a given
  pid — the only honest question reconciliation can answer is "does a process with this pid still
  exist" (`process.kill(pid, 0)`, which asks the OS without actually signaling). Alive → labeled
  `unknown-running`, never `ready` — Praxis cannot claim live control over it. Gone, or no pid was
  ever recorded → `stopped-while-closed`, and the record can be cleared. Nothing is ever
  auto-restarted. 11 tests, including two spawning real processes: a still-alive pid reconciles to
  `unknown-running`; a pid whose process has actually exited reconciles to `stopped-while-closed`;
  round-trip, overwrite-not-append, malformed-file, two-projects-don't-collide, and clear-is-a-no-op
  variants for the storage half.

**Implemented — main process (structurally complete, Electron-unverified):**

- `apps/praxis-desktop/main/src/main/runStateStorage.ts` (new) — `userData/run-state/`, the same
  per-profile-isolated pattern as TASK-133's `evidenceStorageRoot()`.
- `apps/praxis-desktop/main/src/main/runManagerInstance.ts` (new) — the per-project
  `RunServiceManager` registry nothing previously owned: `startProjectRun`/`stopProjectRun`/
  `stopProjectRunService`/`startProjectRunService`/`restartProjectRunService`/`projectRunStatus`.
  Every status transition is persisted (`writeRunState`) and broadcast to every window
  (`runs:statusChanged`), following `workflowOrchestratorInstance.ts`'s exact `broadcastRunChanged`
  pattern; every log line is broadcast too (`runs:log`). A service reaching `ready` with a declared
  `port` is granted preview access (`previewAccess.grant(projectId, runId, serviceId,
  http://127.0.0.1:<port>)`); stopping the whole run revokes every grant that run held
  (`previewAccess.revokeRun`) and clears its persisted state. `reconcileProjectRun` is a thin wrapper
  over the core reconciliation, short-circuiting to "nothing to reconcile" once this session's own
  manager already owns a project's run (there is nothing stale to reconcile against once live status
  is the truth).
- `apps/praxis-desktop/main/src/main/previewBrowser.ts` (new) — the actual Electron surface TASK-145
  deferred: a `WebContentsView` in the exact structural idiom of `aiBrowser.ts` (own partition,
  downloads cancelled, all permission requests denied, no popups), but a passive viewer rather than
  something an agent drives — no click/type/snapshot, just `open(url)`. `will-navigate` and
  `will-redirect` are both guarded by `previewAccessBlockedReason` (TASK-145's one decision function,
  applied identically at both hooks — this is literally what makes "redirected private host" a real
  enforcement point and not just a tested pure function). `session.webRequest.onBeforeRequest` applies
  the same function to every non-`mainFrame` request — every subresource the previewed page's own
  script pulls in — which is what "unapproved private subresource" means as actual browser behavior
  rather than a unit test. **Hiding the view (`setVisible(false)`, what the renderer does when the
  preview tab closes) calls nothing in `runManagerInstance.ts`** — by construction, since
  `previewBrowser.ts` never imports any stop/kill function, only `previewAccess` (read-only checks).
  This is the acceptance criterion "closing a preview tab does not silently terminate a persistent
  deployment," satisfied by the module simply having no code path that could do that, not by a
  runtime check that might be bypassed.
- `apps/praxis-desktop/main/src/main/runControlIpc.ts` (new) — `registerRunControlIpc()`:
  `runs:start` (reads the project's saved Run profile via TASK-143's `readRunProfile` and refuses if
  none exists or a run is already active), `runs:stop`, `runs:stopService`/`startService`/
  `restartService`, `runs:status`, `runs:reconcile`, `runs:previewUrl` (only returns a URL for a
  service that is actually `ready` — no handing out a grant's origin for a service that isn't up
  yet), and the preview view's `preview:attach`/`setBounds`/`setVisible`/`open`, mirroring
  `browserIpc.ts`'s exact `BrowserWindow.fromWebContents` pattern. Registered in
  `apps/praxis-desktop/main/src/main/index.ts` alongside the other `registerXIpc()` calls.
- `packages/core/src/host/ipcContracts.ts` — added `RunsIpc` (start/stop/per-service controls/
  status/reconcile/previewUrl/onStatusChanged/onLog) and `PreviewIpc` (attach/setBounds/setVisible/
  open) to `PraxisIpc`, and preload exposure in `apps/praxis-desktop/main/src/preload/index.ts`.

**Implemented — renderer:**

- `apps/praxis-desktop/renderer/src/projects/RunProfileEditor.tsx` — a "Run controls" panel between
  the profile Name field and the services editor: a Start run / Stop run button; a status row per
  service (a colored dot, state, pid, error message) once a run is active, each with contextual
  Start/Restart/Stop buttons (only the actions valid for that service's current state are shown); a
  reconciliation banner (dismissible client-side; it never claims to have stopped or reattached
  anything — see the core module's own honesty constraint above) when `runs:reconcile` reports
  services still alive from a previous session; a collapsible live log tail fed by `runs:onLog`; and
  a Preview button on any `ready` service with a declared port, which opens `PreviewPane`.
- `apps/praxis-desktop/renderer/src/projects/PreviewPane.tsx` (new) — the renderer half of the
  preview surface, structurally identical to `BrowserPane.tsx`'s placeholder-rectangle-reporting
  pattern (`ResizeObserver` + a 250ms poll pushing `preview.setBounds`) but with no toolbar beyond a
  close button — a preview only ever shows the one granted URL it was given.
- `theme.css` — a `run-controls`/`run-status-*`/`run-reconcile-banner`/`run-logs`/`run-preview-*`
  class block, `run-status-dot` colored by state (`--success`/`--warning`/`--danger`/
  `--text-tertiary`, the same tokens the rest of the app already uses for state coloring).

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root) —
622/622 passing (6 new `RunServiceManager` per-service tests + 11 new reconciliation tests; nothing
else changed behavior). `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` — clean.
`npm run check-types` in `apps/praxis-desktop/renderer` (runs `check-core-imports` then
`tsc --noEmit`) — clean.

**Remaining limitations:** No Electron fixture exercises any of this — "multi-service startup, crash
and recovery" and "closing a preview tab does not silently terminate a persistent deployment" are the
acceptance criteria's own words for behavior that can only really be shown by running the app, and
Electron cannot launch in this sandbox at all. The implementation is real and internally consistent
(every piece compiles against every other piece's actual contract, and everything below the Electron
boundary is genuinely tested against real spawned processes), but nobody has clicked Start run and
watched a service come up. Two design gaps worth naming rather than hiding: (1) `${secret:NAME}`
references in a service's `env` are still passed through unresolved — no code path anywhere in this
story resolves them against the secret store, so a profile using one would currently launch with the
literal placeholder string; (2) the reconciliation banner is informational-only — there is no "force
stop this orphaned pid" action, so a genuinely stuck `unknown-running` service can only be dealt with
outside Praxis (Task Manager / `kill`) until a future task adds one. Both are called out rather than
silently worked around.

## Description


## Comments


