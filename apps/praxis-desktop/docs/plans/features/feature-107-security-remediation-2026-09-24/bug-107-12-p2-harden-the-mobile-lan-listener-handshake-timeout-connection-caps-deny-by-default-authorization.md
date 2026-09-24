# [P2] Harden the mobile LAN listener: handshake timeout, connection caps, deny-by-default authorization

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:55.444Z
**Type:** Bug
**Priority:** Medium
**Severity:** Low
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P2 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-012** (Low, CWE-770) — `apps/praxis-desktop/main/src/main/mobileLanServer.ts:228-436` (`accept`); `packages/mobile-protocol/src/secureChannel.ts:26-44` (`RecordAssembler`).
- **SEC-015** (Low, CWE-1188) — `apps/praxis-desktop/main/src/main/mobileLanServer.ts:100-103` (`authenticatedCaller`) and `:411-413` (the attach decision).

## Why this priority

Grouped because both are pre-pairing behaviour of the same listener, in the same file, covered by the same test file. Neither is exploitable beyond the LAN today, and SEC-015 is not exploitable at all — the sole production construction site (`mobileListenerInstance.ts:41-48`) always passes `authorizePeer`. Both are Low, so P2; together they are S. SEC-012's cost is paid before any authorisation decision, so it becomes materially worse if the locality item slips, and SEC-015's defect is that the unsafe default is maximum privilege — `['view','execute','approve']` with no project scoping — waiting on a future caller to forget an optional field.

## Change

- `apps/praxis-desktop/main/src/main/mobileLanServer.ts`, in `accept()` (`:228+`) — call `socket.setTimeout` (10–15 s) covering accept through handshake-complete, destroying the socket on expiry and clearing the timer once attached. Set `server.maxConnections`, plus a separate and smaller cap on *unauthenticated* peers with a per-remote-address limit.
- `:100-103` / `:411-413` — make `authorizePeer` a required field of `MobileLanServerDeps` (or treat `undefined` as deny-all), so the unauthorised branch can no longer attach `authenticatedCaller`'s full capability set. If tests need a no-authorization mode, add an explicit `allowUnauthenticatedPeers` flag that logs loudly and grants `['view']` only.
- `packages/mobile-protocol/src/secureChannel.ts:26-44` — change `RecordAssembler.push` to an offset-based or chunk-list buffer so appending is O(1) instead of recopying the pending buffer on every chunk. Keep the existing 1 MiB per-record cap.

## Verification

In `apps/praxis-desktop/main/src/main/mobileLanServer.test.ts`: a socket that connects and sends nothing is destroyed within the timeout; connections beyond the unauthenticated cap are refused; constructing the server without `authorizePeer` either fails to compile or denies (assert the deny). In `packages/mobile-protocol`, a `RecordAssembler` test feeding a 1 MiB record one byte at a time completes within a time or allocation bound. Run `npm run test:desktop:mobile && npm run test:mobile-protocol`.

## Effort

S

## Depends on

None.

## Risk

A handshake timeout that is too tight drops real phones on congested Wi-Fi — measure an actual device's handshake time and leave headroom. Connection caps can lock out a legitimate device during a reconnect storm or behind a NAT that shares a source address; make certain a closed socket frees its slot. Making `authorizePeer` required is a breaking change to every test construction site in the repo.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

