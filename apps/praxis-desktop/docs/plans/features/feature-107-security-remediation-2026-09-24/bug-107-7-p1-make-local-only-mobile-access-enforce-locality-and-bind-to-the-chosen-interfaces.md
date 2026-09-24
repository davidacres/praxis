# [P1] Make local-only mobile access enforce locality and bind to the chosen interfaces

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:53.371Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-006** (Medium, CWE-1327 / CWE-923) — `packages/core/src/host/mobileAccessPolicy.ts:31-38` (`evaluateMobileAccess`); `apps/praxis-desktop/main/src/main/mobileLanServer.ts:143-146` (`server.listen(port, cb)` with no host) and `:296-301` (`peerContext`); defaults at `packages/core/src/config/appSettings.ts:627-633`.

## Why this priority

The shipped meaning of a mode named `local-only` is "any source address on any interface": both allowlists default to `[]` and both checks are skipped when empty, and nothing in the mode ever asks whether the peer address is actually on a private network. Pairing still protects the data — an unknown key gets `pairing-required` — so this is exposure rather than direct data loss, hence P1 not P0. But it is what makes the listener's entire pre-authorisation surface internet-reachable for a user who was told it was local.

## Change

- `packages/core/src/host/mobileAccessPolicy.ts:28-40` — in the `local-only` branch, **before** the optional allowlists, classify `peer.remoteAddress` with the classifier introduced for the SSRF item and return `{ allowed: false, reason: 'address-not-allowed' }` for anything that is not loopback, RFC 1918, link-local or ULA. Normalise `::ffff:`-mapped addresses first (the report's Needs-verification #3: a dual-stack bind makes an IPv4 peer appear as `::ffff:192.168.1.5`, which no configured prefix would ever match).
- Replace the `String.prototype.startsWith` subnet test with CIDR matching, and validate operator entries where they are edited (the mobile-access section of the renderer settings page, which documents "prefixes such as `192.168.1.`") so `192.168.1` is rejected rather than silently widening the grant to `192.168.10.x`–`192.168.19.x`.
- `apps/praxis-desktop/main/src/main/mobileLanServer.ts:143-146` — pass an explicit host to `server.listen`: the addresses of the selected `allowedInterfaces`, or loopback when none is selected, rather than the wildcard.
- `:296-301` — `peerContext()` hardcodes `authenticated: true`, which makes the `not-authenticated` arm of the policy decorative. Make it reflect the real handshake state.

## Verification

`packages/core/src/host/mobileAccessPolicy.test.ts` already exists — add: a public remote address is denied under `local-only` with empty allowlists; `::ffff:192.168.1.5` is treated exactly as `192.168.1.5`; a configured entry of `192.168.1` is rejected at validation rather than matching `192.168.10.7`. In `apps/praxis-desktop/main/src/main/mobileLanServer.test.ts`, assert `listen` is called with an explicit host. Run `npm run test:core && npm run test:desktop:mobile`. Then confirm manually with a real phone on a dual-stack network.

## Effort

M

## Depends on

Classify IP addresses properly in the browser SSRF guard

## Risk

This is the finding most likely to break working setups, and its failure mode is a silent connection timeout rather than an error. A wrong bind address, interface selection or IPv4-mapped normalisation stops every phone connecting. Test against a real device on a dual-stack host before release, log the deny reason at connection time so support can diagnose it, and if per-interface binding proves fragile, treat an empty `allowedInterfaces` as "all local interfaces" rather than "none".

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

