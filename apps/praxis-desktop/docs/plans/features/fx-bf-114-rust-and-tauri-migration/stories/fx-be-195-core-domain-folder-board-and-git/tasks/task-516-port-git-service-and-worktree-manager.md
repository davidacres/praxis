---
**Created:** 2026-11-07T21:21:11.982Z
id: TASK-516
type: Task
status: To Do
---

# Port git CLI parser, graph builder, and worktree manager

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port `gitParsing.ts`, `gitGraph.ts`, `gitWorktreeManager.ts`, and `apps/praxis-desktop/main/src/main/gitService.ts` into `crates/praxis-core::git` using `tokio::process::Command::new("git")` so user SSH agents, credential helpers, and GPG signing configurations work identically.

## Acceptance Criteria

- All unit cases from `gitGraph.test.js`, `gitParsing.test.js`, `gitWorktreeManager.test.js`, and `npm run test:desktop:git` pass in `cargo test -p praxis-core`.
- `gitGraph.spec.ts` and `gitOnboarding.spec.ts` pass.

## Dependencies

- `TASK-514`

## Comments


