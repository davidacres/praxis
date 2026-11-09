---
**Created:** 2026-11-07T21:21:12.871Z
id: TASK-518
type: Task
status: In Progress
---

# Port Jira, GitHub, GitLab, and CI evidence services to reqwest

**Status:** In Progress
**Type:** Task
**Priority:** High

## Description

Define the async `IssueTrackerService` trait in `crates/praxis-trackers` and implement `JiraCloudService`, `GitHubBoardService`, `GitLabBoardService`, `DemoService`, and `StubService` using `reqwest` with `rustls`. Port `githubActionsEvidenceProvider`, `gitLabCiEvidenceProvider`, and `ciSecurityReports` for CI run inspection and evidence import.

## Acceptance Criteria

- `githubBoardService.test.js`, `gitLabBoardService.test.js`, `jiraShape.test.js`, and CI evidence unit tests pass in `cargo test -p praxis-trackers`.
- `github.spec.ts`, `gitlab.spec.ts`, and `jira.spec.ts` E2E tests pass.

## Dependencies

- `TASK-515`

## Comments

### 2026-11-08 — slice 1: contract, stub, GitHub board and GitHub Actions evidence

Ported to `crates/praxis-trackers`:

- `backends/issueTrackerService.ts` → `issue_tracker_service.rs`: async `IssueTrackerService` trait (string error messages, matching `FolderService`), `LogSink`/`SilentLogSink`, `SubTaskInput`.
- `backends/stubBackendService.ts` → `stub_backend_service.rs`: empty reads, named refusal on every mutation, never demo data.
- `github/githubApiService.ts`, `githubConfigStore.ts`, `githubBoardService.ts` → `github/`: a public, reusable `GitHubApiService` (injectable base URL; `request_json`, `request_json_paginated`, `request_json_page`, `send`, `repo_path` and `build_url` are public for TASK-522's Actions dispatch and run observation), `GitHubConfigStore` + `StaticGitHubConfig`, and `GitHubBoardService` implementing the trait.
- `ci/ciEvidenceProvider.ts` + `ci/githubActionsEvidenceProvider.ts` → `ci/`.
- `issues/` needed nothing new: `praxis-core::issues` already covers it.

Tests: `githubBoardService.test.ts` (10) and `githubActionsEvidenceProvider.test.ts` (8) are ported, plus client, board synthesis, transition, editing and stub coverage — 49 tests in `praxis-trackers`, run against a local axum stub server.

Deliberate differences from the TS:

- Every GitHub request sends `User-Agent: praxis`. GitHub requires one; Node's `fetch` sent one, `reqwest` does not.
- The `GITHUB_TOKEN` fallback is an injectable lookup on `GitHubBoardServiceOptions`, so tests never mutate the process environment. A secret-store token is trimmed (the TS trims only the inline one).
- `localeCompare` is approximated as case-insensitive, then lowercase-first on a case-only tie (matches ICU for ASCII labels and keys).
- The optional `getSubTasks`/`createSubTasks`/`getSecurityReports` are default trait methods gated by `supports_*()`. `AbortSignal` is dropped: dropping the future cancels the request.
- `CiSourceRef` repeats the JSON shape of `praxis-workflows`' `WorkflowEvidenceSourceRef` to avoid a dependency cycle once workflows depends on this crate.
- The Actions provider sends through `GitHubApiService::send` rather than a standalone client; its status messages are unchanged. Unlike the TS, it does not trim the token for the code-scanning call alone.
- `GitHubApiConfig` and `StaticGitHubConfig` redact the token in `Debug` and are not serializable.

Still open: `JiraCloudService`, `GitLabBoardService` (+ `gitLabCiEvidenceProvider`), `DemoService`, `ciSecurityReports` and `ciEvidenceImport`, an `IssueTrackerService` impl for `FolderService`, routing channels to Rust (FX-BE-203), and the E2E acceptance specs.



### 2026-11-09 — slice 2: GitLab board and GitLab CI evidence

Ported to `crates/praxis-trackers`:

- `rest_support.rs` (new, shared): the helpers slice 1 kept private to `github/` now serve both REST backends — `as_string`/`as_u64`, `encode_uri_component`, error-detail truncation, the `localeCompare` approximation, `sortIssuesByUpdated`, in-memory issue filtering/paging and filter metadata, board filters, the unsupported-edit-field check, and token resolution. `GitHubSecretSource` became the shared `TrackerSecretSource`.
- `gitlab/gitLabApiService.ts` → `gitlab/api_service.rs`: a public `GitLabApiService` (injectable base URL; `send`, `build_url`, `request_json`, `request_json_paginated` (`x-next-page`), `encode_project_ref` public), every endpoint including the merge-request ones, plus `parse_gitlab_remote_url`, `infer_gitlab_project_from_repo`, issue-key matching, discussion-note flatten/diff, and the review/done status helpers.
- `gitLabConfigStore.ts` → `gitlab/config_store.rs`: `GitLabConfigStore` + `StaticGitLabConfig`, and `GitLabBoardServiceOptions` (secret source, workspace-folder lookup, injectable project inference and `GITLAB_TOKEN` lookup).
- `gitLabBoardService.ts` → `gitlab/board_service.rs`: `GitLabBoardService` implementing `IssueTrackerService`.
- `ci/gitLabCiEvidenceProvider.ts` → `ci/gitlab_ci_evidence_provider.rs`, sending through `GitLabApiService::send`, including `getSecurityReports`.

Tests: `gitLabBoardService.test.ts` (6) and `gitLabCiEvidenceProvider.test.ts` (8) are ported, plus client, board loading, transition, assignee resolution, selected-board and project-inference coverage — 90 tests in `praxis-trackers` (735 workspace-wide), against the local axum stub.

Deliberate differences from the TS:

- Every GitLab request sends `User-Agent: praxis`; the config types redact the token in `Debug` and are not serializable; transport errors drop the URL.
- `GITLAB_TOKEN` and the project-from-git-remote inference are injectable options, so tests touch neither the environment nor `git`. A secret-store token is trimmed (the TS trims only the inline one).
- Multi-project lookups (`resolveProjects`, `listBoardsForProjects`, selected boards) run sequentially instead of `Promise.all`; board + lists and issue + comments still load concurrently.
- The board context no longer carries the unused `projectRef`.
- GitLab's `skipped` pipeline status maps to `unknown`: the TS passed it through as a conclusion outside the shared `CiRunConclusion` vocabulary.
- `getSecurityReports` branches on the HTTP status rather than matching `'403'` / `'read_api'` in error messages; a pipeline without an id reads as unavailable rather than run id `"undefined"`.
- Discussion notes sort by `created_at` (the `localeCompare` approximation) then id case-insensitively, matching `sensitivity: 'base'`.

Still open: `JiraCloudService`, `DemoService`, `ciSecurityReports` and `ciEvidenceImport`, an `IssueTrackerService` impl for `FolderService`, routing channels to Rust (FX-BE-203), and the E2E acceptance specs.
