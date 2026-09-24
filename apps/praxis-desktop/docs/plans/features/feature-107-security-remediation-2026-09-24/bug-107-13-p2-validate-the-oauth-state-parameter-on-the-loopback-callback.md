# [P2] Validate the OAuth state parameter on the loopback callback

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:55.806Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P2 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-014** (Low, CWE-352) — `apps/praxis-desktop/main/src/main/mcpOAuthManager.ts:339-379` (`handleRequest`, `settlePending`); listener port constant at `:28`.

## Why this priority

Low: PKCE makes an injected authorization code fail the token exchange, so today's practical impact is a reliable denial of the MCP sign-in flow — any local process, or any web page in any browser via a cross-origin `GET` to the predictable `http://127.0.0.1:53682/callback?error=access_denied`, settles the pending authorization. `state` is nonetheless the control specifically meant to prevent this, and there is no fallback if PKCE enforcement is ever absent or downgraded. S effort. The report's Needs-verification #1 should be answered as part of this item.

## Change

- **First**, read the installed `@modelcontextprotocol/sdk`'s `client/auth` types for an optional `state()` provider hook. If one exists, implement it in the provider class and assert the returned value rather than adding a second, competing state.
- Otherwise, in `apps/praxis-desktop/main/src/main/mcpOAuthManager.ts`: generate a cryptographically random `state` per authorization, store it on `pendingAuthorization` beside the code verifier, and include it in the authorization URL. In `settlePending` (`:359+`) read `url.searchParams.get('state')` **before** `error` or `code`, and reject — without settling the pending authorization — when it is missing or does not match (constant-time comparison on equal-length buffers). Bind the pending authorization to that state rather than to whichever request arrives first, and apply it to both the loopback path and the `praxis://` protocol path that shares `settlePending`.

## Verification

A unit test asserting that a callback with a missing or wrong `state` leaves the pending authorization pending and returns no resolution, that the matching `state` resolves it, and that the generated authorization URL carries the parameter. Exercise the full sign-in through the desktop MCP path to confirm the real provider round-trips it.

## Effort

S

## Depends on

None.

## Risk

If the SDK already generates its own `state`, adding a second produces a mismatch that breaks every MCP sign-in — check the SDK before writing any code. Rejecting unknown-state callbacks means a stale browser tab from an earlier attempt no longer settles the flow, so confirm the existing 5-minute `AUTH_TIMEOUT_MS` path still ends the wait cleanly rather than leaving the UI spinning.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

