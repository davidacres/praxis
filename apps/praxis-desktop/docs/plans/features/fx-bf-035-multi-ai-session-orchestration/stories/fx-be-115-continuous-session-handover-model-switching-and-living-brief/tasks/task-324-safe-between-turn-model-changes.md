---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-324
title: "Change models safely between turns across API and ACP providers"
status: Proposed
story: FX-BE-115
feature: FX-BF-035
updated: 2026-09-14
dependencies: [TASK-322, FX-BE-093]
---

# TASK-324: Change models safely between turns across API and ACP providers

## Objective

Allow the model used by an existing Praxis session to change for its next turn
while preserving history, accurately recording the transition and respecting each
provider runtime's real capabilities.

## Implementation notes

- Add typed IPC that validates the requested model against the current provider
  and changes it only while no turn, approval or input request is active.
- For API providers, persist the selected model and pass it into the next
  `resumeTask` call; do not retroactively relabel earlier usage or events.
- For ACP providers, use stable config-option support when the host advertises and
  accepts model reconfiguration. If it does not, start a fresh native runtime and
  seed it through the same portable-context path used by provider handover.
- Do not silently fall back to the old or connection-default model after the user
  selected another one. Validation or runtime rejection leaves the current epoch
  open and returns an actionable error.
- On success, close the old epoch, open the new one and append a visible
  `model_change` event before the next user turn begins.

## Acceptance criteria

- The next API turn uses the selected model and earlier epochs retain their model.
- ACP reconfiguration is tested both when supported and when a fresh runtime is
  required.
- Switching is rejected during execution, approval and outstanding-input states.
- A rejected model leaves session state and runtime history unchanged.
- Usage and cost remain attributable to the epoch that reported them.

## Verification

Run the targeted gateway and ACP host tests, `npm run test:core`, and
`npm run check-types`.

## Description


## Dependencies


## Comments

