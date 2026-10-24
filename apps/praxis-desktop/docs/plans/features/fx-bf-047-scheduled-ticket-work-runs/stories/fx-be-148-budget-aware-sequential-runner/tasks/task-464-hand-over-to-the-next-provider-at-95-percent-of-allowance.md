---
**Status:** 🔄 In Progress
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-464
title: Hand over to the next provider at 95% of the active provider allowance
status: In Progress
story: FX-BE-148
updated: 2026-10-24
dependencies: [TASK-385, TASK-386]
validation: [npm run test:core, npm run test:desktop]
---

# Hand over to the next provider at 95% of the active provider allowance

## Goal

Stop a scheduled ticket before its provider runs dry: record status, commit, switch provider and carry on.

## Done when

- The runner reads the usage windows of the enabled providers before each ticket
  and while a ticket runs.
- At 95% used on the active provider it writes a handover brief, commits a
  checkpoint of the work so far, and continues the same ticket on the next usable
  provider using the existing provider-handover path.
- The ledger records the threshold, the checkpoint and the switch.
- With no other usable provider below the threshold the run pauses and asks the user.
- A provider that reports no usage data is treated as unknown and is not silently preferred.

## Notes

Reuse `nextUsableProvider` / `fallbackProviderForStage`, the session handover brief and the
existing checkpoint commit behaviour. The 95% trigger is proactive; the existing `switch`
policy only reacts after a provider reports a limit.

## Description


## Dependencies


## Comments

## Delivery status (2026-10-24)

Threshold checks, below-95% provider selection, checkpoint references, switch events and pause-with-no-headroom are implemented; core tests cover threshold and handover decisions. Remaining acceptance work: use the existing session/provider handover path and a durable handover brief to continue the same ticket on the replacement provider. The current Electron adapter updates the workflow provider for stages not yet started and leaves the active turn alone; that is narrower than this task requires. A real multi-provider handover is not proven by the mock-port tests.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
