---
**Status:** 📋 To Do
**Created:** 2026-09-25T00:00:00.000Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:** David Acres
id: FX-BG-046
title: Folder-backed board does not refresh after external file changes
status: Backlog
updated: 2026-09-25
---

# [P2] Folder-backed board does not refresh after external file changes

## Description

A folder-backed project's board (e.g. Praxis Desktop reading its own
`docs/plans`) does not show items added or edited outside the running app —
by Git, an editor, or an agent writing directly to disk — until the app is
fully quit and relaunched. Reselecting the board, or searching it, does not
help; both keep returning the same stale in-memory snapshot.

This was found and reproduced live while authoring `FX-BF-045`: three new
files were written to `apps/praxis-desktop/docs/plans/features/` while
Praxis Desktop was already running (open since before the files were
created); the app's own board never showed them, while an already-listed
older item (`FX-BF-044`) continued to render correctly. Only a full quit and
relaunch made the new items appear.

## Investigation state

- **Confirmed — long-lived per-connection cache.**
  `apps/praxis-desktop/main/src/main/serviceRegistry.ts`'s `getServiceForConnection`
  caches one `FolderService` per connection id for the lifetime of the Electron
  main process:
  ```ts
  const cached = folderServices.get(connectionId);
  if (cached) return cached;
  ```
  Every `board:get` IPC call (`main/src/main/boardIpc.ts:49-52`) resolves through
  this cache. Caching is not itself the defect: a cached `FolderService` should
  still return fresh state after its watcher reloads from disk.
- **Confirmed — no change-notification path to the renderer.**
  `packages/core/src/folder/folderService.ts`'s `setupWatcher()` does start a
  live `chokidar.watch('**/*.md', { ignoreInitial: true })` per plans root and
  does call `reloadFromDisk()` on a change, 500ms debounced — so the *cached
  main-process instance's* in-memory model can become fresh again. But nothing
  tells the renderer this happened: a full grep of every `webContents.send(...)`
  call across `apps/praxis-desktop/main/src/main/*.ts` turns up
  `browser:didNavigate`, `update:status`, `log:appended`, `marketplace:changed`,
  run-manager events, `window:zoomChanged`/`maximizeChanged`,
  `settings:changed`, and terminal output — **no `board:changed` or equivalent**.
  `renderer/src/app/App.tsx`'s board-fetch effect only re-runs on board
  *reselection*:
  ```ts
  useEffect(() => {
    if (!selectedBoard) { setBoardDetails(undefined); return; }
    void window.praxis.board.get(selectedBoard).then(setBoardDetails);
  }, [selectedBoard]);
  ```
  Reselecting a board re-invokes `board:get`, but that still resolves to the
  same cached `FolderService`. No renderer notification means an external
  change has no guaranteed route to update an already-open UI.
- **Not yet proven — watcher/reload health for every external write.** The
  observed behavior does not prove whether the watcher saw the write, whether
  `reloadFromDisk()` completed successfully, or whether its refreshed model
  would have been returned by a subsequent IPC request. The regression test
  must observe each stage before treating it as a second root cause.

## Why this priority

Medium — no data loss, and a workaround exists (restart the app), but it
directly undermines this project's own self-hosting story ("the project
plans itself," `apps/praxis-desktop/project.praxis.md`): editing
`docs/plans` via Git, an editor, or an AI agent — the normal way this board
is meant to be edited — silently fails to show up in a long-running session,
with no error and no visible signal that anything is stale. A user has no
way to tell "the board is empty because there's nothing here" from "the
board is empty because it's stale."

## Change

**Primary behavior: automatically refresh the read model after a successful
external-file reload.** Add an observable folder-service change event after
`reloadFromDisk()` succeeds. The desktop main process forwards it as a
debounced `board:changed` IPC notification, and the renderer re-fetches only
the currently selected matching board. Defer applying that refreshed snapshot
while a board editor or drag interaction has unsaved local state, then refresh
when the local interaction ends.

**Secondary recovery affordance:** add a manual board refresh control only
after automatic refresh is working. It should request a fresh read without
making cache invalidation the normal update mechanism.

## Verification

- `packages/core`: a test constructing a `FolderService` against a temp
  directory, writing a new markdown file after the first `getBoardDetails()`
  call, observing the watcher change event after its debounce, and asserting
  the next `getBoardDetails()` returns the new item — proves watcher, reload,
  and refreshed read-model behavior end to end.
- `apps/praxis-desktop`: an e2e spec that opens a folder-backed board,
  writes a new plan file to its root via `fs.writeFileSync` (simulating an
  external editor/Git/agent write) while the app stays open, and asserts the
  new item appears without restarting the app. Cover deferral while an editor
  or drag interaction has unsaved state, followed by refresh on completion.

## Effort

S–M

## Depends on

None.

## Risk

Automatic refresh must not fight the renderer's own optimistic updates. If a
user is mid-edit on a comment or drag-and-drop reorder when `board:changed`
lands, defer the refetch until that local interaction completes; never
silently replace unsaved UI state.

## Steps to Reproduce

1. Open a folder-backed project's board in Praxis Desktop and leave the app running.
2. Outside the app — via Git, a text editor, or an agent — add or edit a
   markdown file under that project's `docs/plans` (a new `feature.md`,
   `story.md`, or `bug-*.md`).
3. In the running app, reselect the board and/or search for the new item.

## Expected Behavior

The new or changed item appears on the board within a few seconds of the
file change, without restarting the app.

## Actual Behavior

The item never appears. The board keeps showing exactly what it showed the
last time it was freshly loaded. Only fully quitting and relaunching the app
makes it appear.

## Dependencies


## Comments
