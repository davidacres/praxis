---
**Created:** 2026-11-07T21:20:27.517Z
id: TASK-513
type: Task
status: To Do
---

# Build praxis-test-host loopback server for Playwright E2E

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Create the `praxis-test-host` binary in `crates/praxis-host` using `axum` to serve the built renderer static assets (`apps/praxis-desktop/renderer/dist`) and expose the `praxis_rpc` / `praxis_event` WebSocket endpoint on an ephemeral `127.0.0.1` port. Update `apps/praxis-desktop/main/e2e/launchTestApp.ts` to support launching `praxis-test-host` with isolated `--user-data-dir` and connecting a Playwright Chromium `BrowserContext`.

## Acceptance Criteria

- `praxis-test-host` honors `--user-data-dir`, `--settings`, `--demo`, and test environment variables (`PRAXIS_E2E=1`).
- Playwright tests can invoke `window.praxis` methods and receive pushed events in Chromium with full isolation between parallel test workers.

## Dependencies

- `TASK-512`

## Comments


