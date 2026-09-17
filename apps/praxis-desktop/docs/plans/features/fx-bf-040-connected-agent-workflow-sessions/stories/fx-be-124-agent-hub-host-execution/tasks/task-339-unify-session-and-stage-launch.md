---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.729Z
**Type:** Task
**Priority:** Medium
id: TASK-339
title: Route interactive delegation and workflow stages through one launch compiler
status: Planned
story: FX-BE-124
updated: 2026-09-17
dependencies: [TASK-338]
validation: [npm run test:core, npm run test:desktop]
---

# Route interactive delegation and workflow stages through one launch compiler

## Goal

Remove the split where `aiIpc.ts` and `workflowAgentStage.ts` resolve Agent Hub
metadata but independently choose provider-driven launch paths.

## Done when

- New Session and `WorkflowSessionPort` call the same binding-to-adapter
  compiler and lifecycle surface.
- A stage session uses the selected host entry/transport and still records
  provider/model information where the adapter uses them.
- Provider-only legacy sessions remain supported through an explicit legacy
  adapter, never a silent mismatch.

## Notes

Keep the port narrow enough that orchestration does not depend on renderer or
Electron details.

## Description


## Dependencies



## Comments
