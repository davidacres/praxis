# TASK-500 supplemental Praxis Test contracts

Frozen source: `59e34fccb5aafea06d948a569aaa8e55f21689ff`. Runner: **node:test**. TASK-500 adds seven tests: four in `noteSendReference.test.ts` (turning a captured note snapshot into session context, and choosing which sessions can receive it) and three in `noteSendStore.test.ts` (the staged handoff between the dialog and a session composer). Both files run through `npm test --workspace=@praxis/desktop-renderer`. The generated inventory indexes only Playwright, so its validator does not count these. IDs use the existing SHA1(file + newline + title) convention. No existing IDs were renumbered.

The Playwright journeys for the same task are **PT-90ABEBFC94**, **PT-35D3A2F43C**, **PT-26461FF4CC** and **PT-63BC0F273F** in [catalog.json](catalog.json) (`apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:60`, `:74`, `:99`, `:120`).

The reference tests build plain snapshot objects for project `p`. The store tests use the module's in-memory maps directly; state is shared between tests in the file, so each test uses its own key.

## PT-3E8EC78A44

**Title:** a group reference keeps group order and copies content
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendReference.test.ts:11](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts#L11)

**Given:** a group snapshot titled "Src" with notes "Second" (body "two") then "First" (body "one").
**When:** `snapshotToReference` is called, and afterwards the first note object's title and body are changed to "edited".
**Then:** the reference has kind `note-group` and label "Group: Src (2 notes)"; "1. Second" comes before "2. First" in the content; the content still contains "two" and not "edited".

## PT-DF4904DCB7

**Title:** a single note reference and default instructions
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendReference.test.ts:22](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts#L22)

**Given:** a one-note snapshot titled "Src" and a two-note group snapshot.
**When:** `snapshotToReference` and `defaultNoteInstruction` are called.
**Then:** the single note's label is "Note: Src"; the default instruction is "Use the attached note as context." for one note and "Use the attached notes as context." for two. The single note's `kind` is not asserted.

## PT-BF2D16D5CC

**Title:** chat receipt shows the label for note references
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendReference.test.ts:29](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts#L29)

**Given:** a two-note group reference whose first body is "secret body".
**When:** the reference is wrapped into a message with `withSessionContext('Do it', …)` and that message is passed to `displaySessionContext`.
**Then:** the sent message contains "secret body"; the displayed receipt is exactly "Do it\n\nContext: Group: Src (2 notes)", so the note body is not shown in the chat. No e2e test checks the rendered receipt in a session transcript.

## PT-5EBAB8CEEE

**Title:** only the project's live top-level sessions are compatible, newest first
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendReference.test.ts:36](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts#L36)

**Given:** sessions in project `p` (three plain, one with a later `lastActivityAt`), plus one in another project, one archived, one subagent (`parentSessionKey`), one workflow stage, one workflow controller, one ticket review (`review~…`) and one with no project.
**When:** `compatibleNoteSessions(list, 'p')` is called.
**Then:** only the three plain project sessions are returned, ordered by `lastActivityAt ?? startedAt` descending: `SESSION-aaaaaa2`, `SESSION-aaaaaa3`, `SESSION-aaaaaa1`.

## PT-A46CCC1147

**Title:** a staged handoff is consumed exactly once
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendStore.test.ts:7](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts#L7)

**Given:** a handoff with instruction "go" staged under key `k`.
**When:** `peekSessionHandoff('k')` is called, then `takeSessionHandoff('k')` twice, then `peekSessionHandoff('k')` again.
**Then:** peek and the first take return the handoff; the second take and the final peek return `undefined`.

## PT-07B180DC2A

**Title:** unsent instructions are kept per source and cleared when emptied
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendStore.test.ts:15](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts#L15)

**Given:** note source `n1` in project `p`.
**When:** "hello" is saved as its draft instruction, the group with the same id is read, then an empty string is saved.
**Then:** the note's draft reads "hello"; the group `n1` reads "" (drafts are keyed by kind as well as id); after saving "" the note's draft reads "". The dialog's use of this on Cancel and reopen is not tested end to end.

## PT-D2E0BD9A9E

**Title:** a handoff only submits itself shortly after the explicit Send
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendStore.test.ts:24](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts#L24)

**Given:** a handoff staged and taken under key `f`.
**When:** `isFreshHandoff` is called now, and with a clock `HANDOFF_AUTO_SEND_MS + 1` ms after it was staged.
**Then:** it is fresh now and not fresh after the window. This tests the predicate only. Nothing checks that `SessionsPage` fills the composer without sending when a handoff is stale or the session is busy.
