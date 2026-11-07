---
**Created:** 2026-11-07T21:21:11.980Z
id: FX-BE-196
type: Story
status: To Do
---

# Port External Trackers, Portable PTY Terminal, and Mobile Host

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Port the external issue tracker services (`JiraCloudService`, `GitHubBoardService`, `GitLabBoardService`, `DemoService`, `StubService`, and CI evidence providers) into `crates/praxis-trackers`, replace `node-pty` with `portable-pty` in `crates/praxis-workflows`, and port the Ed25519 mobile pairing protocol, LAN WebSocket host, and relay server into `crates/praxis-mobile`.

## Tasks

- `TASK-518` — Port Jira, GitHub, GitLab, and CI evidence services to reqwest
- `TASK-519` — Replace node-pty with Rust portable-pty terminal manager
- `TASK-520` — Port Ed25519 mobile pairing, LAN WebSocket host, and relay

## Acceptance Criteria

- `serviceRegistry` resolves every connection mode (`folder`, `project`, `jiracloud`, `github`, `gitlab`, `demo`, plus `default` stub fallback) without affecting `folder` behavior.
- `github.spec.ts`, `gitlab.spec.ts`, `jira.spec.ts`, `terminal.spec.ts`, and `mobileAccess.spec.ts` pass.
- `node-pty` C++ native rebuild scripts are no longer required by the Rust runtime.

## Dependencies

- `FX-BE-195`

## Comments


