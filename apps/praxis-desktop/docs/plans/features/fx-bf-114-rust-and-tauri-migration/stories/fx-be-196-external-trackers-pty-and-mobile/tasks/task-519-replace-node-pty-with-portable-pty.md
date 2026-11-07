---
**Created:** 2026-11-07T21:21:13.971Z
id: TASK-519
type: Task
status: To Do
---

# Replace node-pty with Rust portable-pty terminal manager

**Status:** To Do
**Type:** Task
**Priority:** Medium

## Description

Port `apps/praxis-desktop/main/src/main/terminalManager.ts` to Rust using the `portable-pty` crate. Support spawning login shells across macOS (`zsh`/`bash`), Linux, and Windows (`powershell.exe`/`cmd.exe`), dynamic PTY resizing, streaming stdout/stderr chunks over `terminal:data` events, and clean child-process termination on session close.

## Acceptance Criteria

- Interactive terminal sessions spawn, resize, stream output, and exit cleanly across platforms without `node-pty`.
- `terminal.spec.ts` passes.

## Dependencies

- `TASK-514`

## Comments


