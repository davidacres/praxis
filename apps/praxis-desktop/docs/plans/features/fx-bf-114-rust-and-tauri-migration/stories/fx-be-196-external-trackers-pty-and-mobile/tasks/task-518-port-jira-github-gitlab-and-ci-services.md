---
**Created:** 2026-11-07T21:21:12.871Z
id: TASK-518
type: Task
status: To Do
---

# Port Jira, GitHub, GitLab, and CI evidence services to reqwest

**Status:** To Do
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


