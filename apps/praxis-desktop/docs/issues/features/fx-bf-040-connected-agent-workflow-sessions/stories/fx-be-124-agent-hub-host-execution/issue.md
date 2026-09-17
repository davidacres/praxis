# FX-BE-124 — Agent Hub host execution for interactive and stage sessions

**Type:** Story
**Status:** Planned
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
