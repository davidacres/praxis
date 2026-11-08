---
**Created:** 2026-11-07T21:21:13.971Z
id: TASK-519
type: Task
status: In Progress
---

# Replace node-pty with Rust portable-pty terminal manager

**Status:** In Progress
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

### 2026-11-08 — Rust terminal manager ported

- `crates/praxis-workflows/src/terminal_manager.rs` ports `terminalManager.ts` onto `portable-pty`: `TerminalManager::{new, with_options, list, list_profiles, create, write, resize, kill, buffer, context, commands, dispose}` (drop disposes), `detect_profiles`, `terminal_output_to_plain_text`, and `TerminalEvent::{Output, Exit, ContextAvailability, Command}` on an unbounded tokio channel. Uses the existing `praxis-contracts` terminal types.
- Preserved: profile order and `SHELL` default, cwd defaulting/validation and error messages, child env (`SHELL`, macOS `BASH_SILENCE_DEPRECATION_WARNING`, `TERM`, `COLORTERM`, `TERM_PROGRAM`, integration `ZDOTDIR`, plus node-pty's `PWD` on Unix), zsh/bash OSC 633 integration through a private temp rc file, 5 KB recent/command-output limits, 50-command history, exit code + signal number (code 0 when signalled, as node-pty).
- Output is decoded as UTF-8 without splitting multi-byte sequences (matches node-pty's `setEncoding('utf8')`); the exit event waits up to 200 ms for trailing output, as node-pty does.
- Deliberate differences: kill sends SIGHUP to the shell's process group and the PTY foreground job (node-pty signals the shell pid only) and escalates to SIGKILL after 3 s; Windows kill uses `taskkill /T /F`. The integration dir is removed if spawning fails.
- 21 Rust tests (real `/bin/sh` sessions: echo, env/cwd, resize, exit code, tree kill, dispose, reuse, UTF-8 chunking; zsh integration when `/bin/zsh` exists). Workspace tests pass 3/3.
- Remaining: Windows/ConPTY is untested; `terminal.spec.ts` can only pass once `terminal:*` IPC is routed to Rust (FX-BE-203), and node-pty stays until then.


