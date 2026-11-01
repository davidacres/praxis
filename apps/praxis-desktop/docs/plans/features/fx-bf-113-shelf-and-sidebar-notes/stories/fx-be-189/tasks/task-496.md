---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.662Z
**Type:** Task
**Priority:** Medium
id: TASK-496
type: Task
status: To Do
---

# TASK-496: Define note and group contracts

## Work and acceptance

Specify stable IDs, project ownership, timestamps, ordered many-to-many memberships, request snapshots and IPC errors. Validate titles, bodies, missing IDs, cross-project requests and malformed persisted data. Define backward-compatible schema initialisation with no notes. Add meaningful contract tests.

### Contracts-only acceptance

- Shared JSON-compatible types and pure helpers define the records, validation, ordered memberships, detached snapshots and future IPC result surface. Both update validators reject empty patches; an explicit empty body remains a valid update.
- Schema initialisation is a pure parse contract: absent storage (`undefined`) returns a fresh empty version-one document without reading or writing storage. Malformed data and unsupported versions return typed failures rather than an empty replacement.
- IPC evidence covers discriminated result narrowing, safe error payloads and JSON round trips. `PERSISTENCE_FAILURE` declares a future handler obligation; this task does not prove disk failure mapping or exercise an operational application path.
- Contract tests prove identity and ownership checks, content limits, membership integrity and snapshot independence. Build, type and test gates in the implementation plan remain required.

## Boundary

Follow FX-BF-113. Scheduled runs remain excluded. Preserve unrelated workspace changes.

TASK-497 owns storage adapters, operational main/preload IPC integration, atomic saves, post-save notifications and restart restoration. Its acceptance must verify existing-data startup, absent-storage startup and failed writes mapped to the declared result contract. Those runtime guarantees remain pending until TASK-497; completing these contracts does not complete persistence or IPC integration.

## Dependencies

None

## Description


## Comments


**PRX-T113-496** — 2026-10-31T20:39:21.261Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 11h 8m

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "implement" failed.

**PRX-T113-496** — 2026-10-31T22:51:51.074Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 21m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T113-496** — 2026-10-31T22:53:25.230Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 22m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T113-496** — 2026-10-31T22:53:32.531Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 23m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T113-496** — 2026-10-31T22:53:45.819Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 23m

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "implement" failed.

**PRX-T113-496** — 2026-10-31T22:53:52.923Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 23m

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-T113-496** — 2026-10-31T22:53:59.137Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 23m

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-T113-496** — 2026-10-31T23:05:30.879Z
**Workflow run failed: Governed delivery — TASK-496: Define note and group contracts**

Status: Failed · Duration: 13h 35m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Praxis Test contracts: pending
- ❌ Review: failed
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "review" failed.

**PRX-T113-496** — 2026-10-31T23:45:07.885Z
**Workflow run succeeded: Governed delivery — TASK-496: Define note and group contracts**

Status: Succeeded · Duration: 14h 14m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded

**PRX-T113-496** — 2026-11-01T00:34:05.461Z
**Workflow run cancelled: Governed delivery — TASK-496: Define note and group contracts**

Status: Cancelled · Duration: 9m 2s

- ✅ Plan: succeeded
- ❌ Implement: failed
- ⏭️ Praxis Test contracts: cancelled
- ⏭️ Review: cancelled
- ⏭️ Install dependencies: cancelled
- ⏭️ Build: cancelled
- ⏭️ QA: cancelled
- ⏭️ Security scan: cancelled

Skipped from the schedule.