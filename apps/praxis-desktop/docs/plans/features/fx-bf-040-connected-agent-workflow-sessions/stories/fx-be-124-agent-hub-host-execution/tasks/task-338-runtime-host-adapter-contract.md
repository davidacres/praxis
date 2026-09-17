---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.728Z
**Type:** Task
**Priority:** Medium
id: TASK-338
title: Define and implement the runtime-host adapter launch contract
status: Planned
story: FX-BE-124
updated: 2026-09-17
dependencies: []
validation: [npm run test:core, npm run test:desktop]
---

# Define and implement the runtime-host adapter launch contract

## Goal

Turn an `AgentBinding` into an actual host-specific launch/session adapter,
including protocol handshake, capabilities, lifecycle, and termination.

## Done when

- The adapter contract separates provider model/auth from host transport and
  has explicit ACP, gateway, and unsupported/scaffold states.
- One real local ACP host adapter starts, handshakes, sends a task, receives
  events, and shuts down through the contract.
- Generic process spawn is not reported as a working agent protocol.

## Notes

Read the installed ACP schema before adding update handling. Unhandled stable
updates must not be silently discarded when they affect plans, usage, or
session state.

## Description


## Dependencies



## Comments
