---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Task
**Priority:** High
type: Task
id: TASK-357
title: "Thread image attachments through core, ACP, gateway, and IPC"
status: Complete
story: FX-BE-131
feature: FX-BF-035
updated: 2026-09-20
dependencies: [FX-BE-122]
---

# TASK-357: Thread image attachments through core, ACP, gateway, and IPC

## Completed work

- Added `WireImageAttachment` and conversation/session image carriage.
- Serialized images for OpenAI-compatible, Anthropic, and Gemini requests and
  emitted native ACP image content blocks.
- Threaded images through agent loops, session queues, gateway/ACP launchers,
  preload contracts, IPC handlers, and the queued conversation scheduler.
- Enforced MIME, count, and byte-size limits at the main-process boundary.

## Verification

Core tests and main/renderer typechecks passed. **Complete.**

## Description


## Dependencies



## Comments


