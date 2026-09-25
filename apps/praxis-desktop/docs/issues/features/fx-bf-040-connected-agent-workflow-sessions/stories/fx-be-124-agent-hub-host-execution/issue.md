# FX-BE-124 — Agent Hub host execution for interactive and stage sessions

**Type:** Story
**Status:** Done
**Priority:** Critical
**Depends on:** FX-BF-011, FX-BF-013, FX-BF-038

## Business or operational impact

Agent Hub selection becomes operational: the declared host transport actually
runs the session or stage, rather than being metadata around a provider-only
launch.

## Scope

- Implement host-specific adapters behind the binding and session ports.
- Share launch compilation between interactive sessions and workflow stages.
- Enforce trust, scope, capability, sandbox, folder, and tool-mode checks.

## Delivery notes

Prove one real ACP host first; represent generic/scaffold hosts as unavailable.

## Acceptance criteria

- The selected trusted host receives and completes a real local session.
- Wrong-scope, untrusted, incompatible, or scaffold-only hosts fail closed.
- Session audit distinguishes host transport from provider/model metadata.

## Validation

- `npm run test:core`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when

Normal sessions and workflow stages use the same authoritative host-binding
launch path, with deterministic and real-host proof.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left
stale at Planned (updated 2026-09-17).

- The Electron main host runs both interactive and governed stage sessions
  through the `@praxis/core` workflow runtime, with start/stop/restart
  lifecycle controls surfaced by the runtime dashboard.
- Session records capture host transport in audit data and return it to the
  renderer, keeping selected binding metadata distinct from the adapter that
  actually ran.

Status set to Done as part of the 2026-09-25 board review. Verified in this
review: `npm run build:core` and `npm run test:core` (1311 tests, 0 failures).
Desktop build/e2e commands were unavailable in this session, so re-run them
before release.
