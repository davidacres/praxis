# [P1] Classify IP addresses properly in the browser SSRF guard

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:53.009Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-005** (Medium, CWE-918) — `packages/core/src/ai/tools/browserTools.ts:147-166` (`PRIVATE_IPV4`, `isPrivateOrLoopbackHost`), consumed at `:174-192` (`blockedBrowserUrlReason`) and `apps/praxis-desktop/main/src/main/aiBrowser.ts:40,122-130`.

## Why this priority

Medium, reachable from prompt-injected page content whenever the in-app browser is enabled, and the bypasses are one-liners the review verified against the WHATWG parser: `http://[::ffff:127.0.0.1]/`, `http://[::ffff:169.254.169.254]/`, `http://[fd00::1]/`, `http://[fe80::1]/` and `http://100.64.1.1/` all pass the filter, while decimal and hex IPv4 forms are correctly normalised and blocked. `browser_read` pipes the response into the model context and from there into the transcript and any workflow evidence. S effort, and it is the prerequisite for the mobile locality fix, so it goes early in P1.

## Change

- `packages/core/src/ai/tools/browserTools.ts` — replace `PRIVATE_IPV4` and `isPrivateOrLoopbackHost` with a real address classifier (`ipaddr.js`, or a hand-rolled one), kept in a single exported module since `packages/core/src/projects/previewAccess.ts` consumes the same predicate per the doc comment at `:152-155`. Unwrap `::ffff:a.b.c.d` to its IPv4 form before classifying, and reject `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, plus `localhost` and `*.localhost`.
- Keep the `allowPrivateHosts` seam that `aiBrowser.ts:39-40` uses for the e2e mock server.
- For DNS-based bypass (a public name resolving to `127.0.0.1`), resolve the hostname and apply the same classifier to every returned address before the navigation proceeds, and re-check in the `will-redirect` guard rather than only re-reading the URL string.

## Verification

Extend `packages/core/src/ai/tools/browserTools.test.ts` with a table asserting `blockedBrowserUrlReason` returns a reason for each of the five bypass URLs above, still returns `undefined` for ordinary public hosts, and still returns `undefined` for the loopback mock server when `allowPrivateHosts` is set. `npm run test:core`, then `npm run test:desktop` to confirm the AI browser e2e specs still reach their mock server.

## Effort

S

## Depends on

None.

## Risk

Over-blocking. Some users legitimately browse an intranet host by name, so the host allowlist and the `allowPrivateHosts` seam must keep working or the browser e2e specs break. Adding DNS resolution makes the guard asynchronous and introduces a timeout path — treat resolution failure as *block*, and keep it out of the synchronous string check so `previewAccess.ts` is not forced async by this change.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

