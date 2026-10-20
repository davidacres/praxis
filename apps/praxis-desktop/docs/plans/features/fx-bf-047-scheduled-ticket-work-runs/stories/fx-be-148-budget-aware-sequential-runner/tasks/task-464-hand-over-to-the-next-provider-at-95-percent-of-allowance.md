---
**Status:** 📋 Proposed
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-464
title: Hand over to the next provider at 95% of the active provider allowance
status: Backlog
story: FX-BE-148
updated: 2026-10-20
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

