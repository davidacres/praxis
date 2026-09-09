# Praxis Mobile Master Plan

**Status:** Planned
**Type:** Master Plan
**Priority:** High

## Outcome

Continue desktop work on mobile with the same session, agents and workflows. See [architecture](../architecture.md) for accepted requirements and [Plan Map](../PLAN_MAP.md) for all 54 execution items.

## Ordered milestones

| Order | Milestone | Required completion | Proof |
| --- | --- | --- | --- |
| 1 | Stable host execution boundary | FX-BE-074, FX-BE-075 | Desktop parity, scoped commands and durable replay |
| 2 | Paired local access | FX-BE-076, FX-BE-077 | Pair/connect without accounts or internet |
| 3 | Phone continuation over LAN | FX-BE-080, FX-BE-081 | Desktop → phone → desktop, same session after phone termination |
| 4 | Authenticated internet connectivity | FX-BE-078, FX-BE-079 | Remote host list and encrypted relay, no VPN or inbound ports |
| 5 | Full mobile execution | FX-BE-082, FX-BE-083 | Start, follow up, approve, retry/cancel and review results |
| 6 | Supported release | FX-BE-084, FX-BE-085 | Lifecycle/device evidence, operations, independent packaging |

## Dependency semantics

The plan map and each canonical item's Dependencies section define hard prerequisites. Feature/story completion rolls up children; children never depend on their containing parent. Within a story tasks run in the listed order. Completing a prerequisite story includes all its tasks and evidence.

Permitted concurrent implementation: FX-BE-080 can start after FX-BE-074 while host access work continues. FX-BE-078 can start after FX-BE-075 alongside local pairing; FX-BE-079 also requires pairing FX-BE-076. LAN continuation does not depend on cloud identity/relay. Full internet approval proof requires both FX-BE-082 and FX-BE-079 before FX-BE-083.

## First implementation task

TASK-201: audit execution ownership and freeze protocol v1. Then extract services and prove durable/request-specific semantics before exposing a network listener.

## Completion policy

All 6 features, 12 stories and 36 tasks are planned, not implemented. The current change creates physical plans and folder structure only. Implementation tasks record actual commands, fixture results, captures and limitations before status changes. Real agents and infrastructure use remain explicit opt-ins.
