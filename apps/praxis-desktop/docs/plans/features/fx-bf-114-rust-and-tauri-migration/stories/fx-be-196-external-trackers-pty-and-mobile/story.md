---
**Created:** 2026-11-07T21:21:11.980Z
id: FX-BE-196
type: Story
status: To Do
---

# Port External Trackers, Portable PTY Terminal, and Mobile Host

**Status:** To Do
**Type:** Story
**Priority:** Medium

## Description

Port the external issue tracker services (`JiraCloudService`, `GitHubBoardService`, `GitLabBoardService`, `DemoService`, `StubService`, and CI evidence providers) into `crates/praxis-trackers`, replace `node-pty` with `portable-pty` in `crates/praxis-workflows`, and port the Ed25519 mobile pairing protocol, LAN WebSocket host, and relay server into `crates/praxis-mobile`.

### Execution Order & Parallelism (Wave 3 — Fully Parallel Story & Tasks)

- **Story-Level Concurrency**: Runs in Wave 3 in parallel with `FX-BE-197` (Workflows) and `FX-BE-198` (AI Runtime).
- **Task-Level Concurrency (3-Way Parallel)**: All three tasks (`TASK-518` in `crates/praxis-trackers`, `TASK-519` in `crates/praxis-workflows::pty`, and `TASK-520` in `crates/praxis-mobile`) have zero code overlap and can be executed simultaneously. (`TASK-519` and `TASK-520` can even start as soon as `TASK-514` finishes in Wave 2.)

## Tasks

- `TASK-518` (`High`, Parallel Track A) — Port Jira, GitHub, GitLab, and CI evidence services to reqwest
- `TASK-519` (`Medium`, Parallel Track B) — Replace node-pty with Rust portable-pty terminal manager
- `TASK-520` (`Medium`, Parallel Track C) — Port Ed25519 mobile pairing, LAN WebSocket host, and relay

## Acceptance Criteria

- `serviceRegistry` resolves every connection mode (`folder`, `project`, `jiracloud`, `github`, `gitlab`, `demo`, plus `default` stub fallback) without affecting `folder` behavior.
- `github.spec.ts`, `gitlab.spec.ts`, `jira.spec.ts`, `terminal.spec.ts`, and `mobileAccess.spec.ts` pass.
- `node-pty` C++ native rebuild scripts are no longer required by the Rust runtime.

## Dependencies

- `FX-BE-195`

## Comments


