# Interactive chat gadgets roadmap

**Status:** Delivered on desktop; workflow/deployment actions and the mobile host outstanding  
**Prepared:** 2026-09-10  
**Feature:** [FX-BF-036](plans/features/fx-bf-036-interactive-chat-gadgets/feature.md)

## Purpose

Allow Praxis chat responses to include safe, typed, interactive surfaces when a question, decision, dataset, change set or operational result is better represented as a gadget than prose.

## Product decisions

- Gadgets are versioned typed chat blocks; Markdown parsing is only a fallback.
- The provider or workflow may request a gadget, but Praxis validates its schema, scope and allowed actions.
- Informational gadgets do not imply authority to mutate state.
- Mutating or approval-required actions return through the command ledger and are audited.
- Every gadget is scoped to host, project, session and work where applicable.
- Stale, expired, disconnected or superseded gadgets become visibly non-actionable.
- Desktop and mobile render the same browser-safe contract with responsive layouts and thin native adapters.
- Unknown gadget kinds degrade to a readable text representation.
- Gadget payloads never contain secrets, opaque provider credentials or unbounded model output.
- The first release is local-first and does not require GenericSystem, Roleover, Azure or cloud connectivity.

## Target flow

Agent/workflow response -> typed chat blocks -> contract and policy validation -> renderer registry -> user action -> command ledger -> host service -> structured result event

## Delivery order

| Priority | Story | Outcome | State |
| --- | --- | --- | --- |
| 1 | FX-BE-097 | Versioned gadget and action contracts | Done |
| 2 | FX-BE-098 | Renderer registry and core chat surfaces | Done |
| 3 | FX-BE-099 | Safe action lifecycle, scope and stale-state handling | Done |
| 4 | FX-BE-100 | Workflow, agent and orchestration integration | Provider mapping and gate approval done; expected-response declarations and deployment/progress detail outstanding |
| 5 | FX-BE-101 | Accessibility, mobile, fixtures and end-to-end proof | Desktop done; mobile host outstanding |

## Initial gadget catalogue

Choice, confirmation, form, table, chart, progress/activity, diff, artifact preview, context/handoff review, conflict resolution and approval.

## Cross-cutting completion requirements

- A response can contain Markdown and multiple gadgets in deterministic order.
- Choice and confirmation gadgets can complete a real local workflow decision.
- Tables and charts remain useful when the gadget is unavailable or unsupported.
- Actions are idempotent, replay-safe and tied to the originating response and scope.
- A second device or provider cannot apply an action against a changed session without a fresh validation.
- Streaming responses can create, update, supersede and complete gadgets by stable ID.
- Provider adapters remain provider-neutral and do not depend on private transcript access.
- Automated tests cover valid, malformed, oversized, stale, expired, duplicated and unauthorized actions.
- The read-only Praxis plan parser accepts the feature, stories, tasks and dependencies.

## Implementation

See [interactive-chat-gadgets.md](interactive-chat-gadgets.md) for the delivered
pipeline, the fence a provider emits, the safety properties and how to add a kind.
