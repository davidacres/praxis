---
**Status:** ✅ Complete
**Created:** 2026-09-01T19:20:12.662Z
**Type:** Task
**Priority:** Medium
id: TASK-093
title: Implement workflow validation and migration
status: Done
story: FX-BE-018
updated: 2026-09-02
dependencies: [TASK-092]
validation: [npm run build:core, npm run test:core]
---

# TASK-093: Implement workflow validation and migration
## Implement workflow validation and migration
## Goal
Normalize versioned workflow payloads and fail closed on cycles, dangling nodes, invalid joins, unsafe permissions, and missing required gates.
## Done when
- Valid payloads round-trip and older supported versions migrate deterministically.
- Validation errors identify the exact node, edge, policy, or artifact path.

## Description


## Dependencies



## Comments


