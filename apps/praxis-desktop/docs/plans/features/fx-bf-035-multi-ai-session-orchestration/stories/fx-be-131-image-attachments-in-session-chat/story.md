---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-131
title: "Image attachments in session chat"
status: Complete
feature: FX-BF-035
issue: docs/issues/features/fx-bf-035-multi-ai-session-orchestration/stories/fx-be-131-image-attachments-in-session-chat/issue.md
updated: 2026-09-20
tasks: [TASK-357, TASK-358, TASK-359]
dependencies: [FX-BE-096, FX-BE-122]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run test:core, npm run build --workspace=@praxis/desktop-renderer, git diff --check]
---

# FX-BE-131: Image attachments in session chat

## Outcome

Users can paste or drag images into a session composer, preview and remove
attachments before sending, and inspect them later in the persisted transcript.
The same image reaches API, ACP, and multi-AI conversation turns safely.

## Scope

- Wire image attachment contracts, provider serialization, ACP image blocks,
  session history, IPC sanitization, and gateway/ACP threading.
- Composer paste/drop handling, bounded image downscaling, attachment chips,
  transcript thumbnails, and full-size lightbox viewing.
- A global drop guard preventing accidental browser navigation outside the
  composer and coverage for queued conversation messages.

## Acceptance criteria

- Paste and drag/drop stage supported images without navigating the app.
- Sending preserves images through gateway, ACP, and queued multi-AI turns.
- Images appear on the user transcript event after persistence/reopen.
- Users can remove staged images and open transcript thumbnails full size.
- IPC limits and MIME validation prevent unbounded or unsupported payloads.

## Tasks

- `TASK-357` — Thread image attachments through core, ACP, gateway, and IPC.
- `TASK-358` — Build composer chips, transcript thumbnails, lightbox, and drop guard.
- `TASK-359` — Verify gateway, ACP, conversation, persistence, and visual flows.

## Close when

The image attachment journey is implemented across all runtime paths and
verified by core/e2e tests and visual evidence. **Met.**

## Description


## Dependencies



## Comments


