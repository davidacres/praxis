---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-109
title: Add the Agent Hub picker and effective-policy display to the inspector
status: Done
story: FX-BE-023
updated: 2026-09-02
dependencies: [FX-BE-021]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# TASK-109: Add the Agent Hub picker and effective-policy display to the inspector
## Add the Agent Hub picker and effective-policy display to the inspector
## Goal
Configure an agent stage against the real discovered catalog rather than a
free-text id, and make the composed project policy visible where it changes what
an approval stage requires.
## Done when
- The agent field is a picker sourced from `agentRuntime.list()` showing each
  agent's trust state, capabilities, and skills; an agent that fails
  `preflightStage` is shown as unusable with its remediation.
- Selecting an agent offers its declared skills as checkboxes and captures their
  fingerprints for drift detection.
- An approval stage shows any gate the effective policy adds beyond the
  definition's own `requiredGates`, and whether the policy permits bypass, from
  `workflows:effectivePolicy`.
- The catalog is read type-only in the renderer; discovery calls go over IPC.
## Notes
`agentRuntime.list()` already exists over IPC. This closes the TASK-102
acceptance text ("trust, skills, capabilities, permissions, and gate policy")
without waiting on the FX-BF-009 catalog UI.

## Description


## Dependencies



## Comments


