---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-145
title: "Add explicit preview origin grants"
status: In Progress
story: FX-BE-055
updated: 2026-09-09
dependencies: [TASK-144]
---

# TASK-145: Add explicit preview origin grants

**Priority:** High
**Created:** 2026-09-07

## Goal

Bind allowed loopback origins to project and run identity; enforce redirect and subresource policy; preserve default private-host restrictions outside granted previews.

## Implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-144
## Acceptance criteria

- A granted localhost port opens; another project or port, redirected private host and unapproved private subresource remain blocked; revoke on run closure.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the origin-grant registry and access-decision policy are implemented and fully tested; no
Electron surface enforces them yet (no preview `WebContentsView`, no `will-navigate`/`will-redirect`/
`webRequest` wiring, no IPC, no UI). Left `in-progress` — deliberately, and for the same reason
TASK-144 stayed `in-progress`: this story splits pure/testable policy (TASK-144, this task) from
Electron integration and UI (TASK-146, "Integrate Run controls and recovery"), and the acceptance
criteria's "a granted localhost port opens" et al. describe the behavior of a running Electron
surface that doesn't exist until that task wires this policy into one.**

**Implemented:**

- `packages/core/src/ai/tools/browserTools.ts` — extracted `isPrivateOrLoopbackHost(host)` out of
  `blockedBrowserUrlReason`'s inline check and exported it, so the new preview policy reuses the
  exact same loopback/RFC-1918/link-local vocabulary the AI browser already enforces rather than a
  second copy of the same regex (AGENTS.md: reuse over reinvention). `blockedBrowserUrlReason`'s own
  behavior is unchanged — this is a pure extraction, not a behavior change — confirmed by the full
  suite still passing unmodified.
- `packages/core/src/projects/previewAccess.ts` (new):
  - `PreviewAccessRegistry` — `grant(projectId, runId, serviceId, origin)` records exactly one active
    grant per origin (scheme+host+port; path/query stripped so a grant on `http://127.0.0.1:5173`
    covers every path under it, not just the exact URL granted). **Fails closed on a non-loopback/
    non-private origin** — granting `https://example.com` throws rather than silently accepting a
    grant that would never matter, since the whole point of a preview grant is carving a hole in the
    private-host restriction. `revokeRun(projectId, runId)` removes exactly that run's grants and no
    others (tested against a second, unrelated project's grant surviving). `revokeAll()` for a full
    reset. Re-granting an origin already held by a different run supersedes it rather than erroring —
    matches how a restarted run would naturally re-grant its own ports.
  - `previewAccessBlockedReason(url, registry)` — the single access decision, deliberately shared
    across all three call sites the acceptance criteria name (top-level navigate, redirect, and
    subresource) rather than three near-identical functions: a public (non-private) host is always
    allowed regardless of grants — ordinary web browsing inside a previewed page (a docs link, a CDN
    asset) is not this policy's concern; a private/loopback host is allowed only when its *exact*
    origin currently has an active grant. This is what makes "another project or port … remain
    blocked" and "unapproved private subresource" the same rule applied at different points in a
    page's lifecycle, not two different policies to keep in sync.
- `packages/core/src/projects/previewAccess.test.ts` (new, 16 tests): granted origin opens; a
  different port on the same host stays blocked even with another port granted (same-host,
  different-port collision — the literal "another … port" from the acceptance criteria);
  another project's ungranted origin stays blocked; `localhost` and `127.0.0.1` are treated as
  distinct origins (a grant on one does not leak to the other — a real gap a looser "is this a
  loopback host at all" check would have missed); a public host is never blocked, granted or not; a
  private *non-loopback* host (`192.168.x`) is blocked without a grant and opens once granted (proves
  the policy isn't loopback-only); a redirect to an unapproved private host is blocked by the same
  function; an unapproved private subresource (modeled on a cloud metadata-style SSRF target,
  `169.254.169.254`) is blocked by the same function; unsupported scheme and malformed URL are
  refused outright; `grant()` refuses a non-private origin and a malformed origin; revoke-on-closure
  removes exactly one run's grants and leaves an unrelated project's grant intact; re-granting
  supersedes; `revokeAll` clears everything; `grants()` reports the full granting identity
  (project/run/service/origin/timestamp) for whatever eventually needs to render "what's currently
  previewable" in the UI.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root) —
605/605 passing (16 new; the `browserTools.ts` extraction changed no existing test's behavior).
`npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean (neither consumes the new module yet).

**Remaining limitations:** No process anywhere calls `grant`/`revokeRun` yet — nothing connects a
`RunServiceManager` service reaching `ready` to a grant, or a run stopping to a revoke; that wiring,
plus the actual Electron preview surface (a `WebContentsView` guarded by `previewAccessBlockedReason`
on `will-navigate`/`will-redirect`, and a `session.webRequest.onBeforeRequest` filter for
subresources — following `apps/praxis-desktop/main/src/main/aiBrowser.ts`'s exact structural pattern
for the guards themselves), IPC surface, and any UI, are TASK-146's explicit scope. Electron
end-to-end verification was not attempted for the same reason as every other task this session: there
is no Electron-specific code yet to verify, and Electron itself remains blocked in this sandbox
(missing `node-pty` native binding, rebuild blocked by egress policy).

## Description


## Comments


