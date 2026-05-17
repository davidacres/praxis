# Live Folder Migration Plan: Jira API, GitLab, and GitHub

## Goal

Implement a reliable migration path from Live Folder markdown plans to hosted issue trackers:

- Jira API first, using the existing `jiraapi` backend and linked-epic commands.
- GitLab next, accounting for the repository's existing GitLab MR/delivery helpers and different issue model.
- GitHub after a GitHub issue/board backend service is designed and added; no such backend service is currently present in `src`.

## Current State

- Live Folder mode can read and optionally write markdown features, stories, tasks, and bugs.
- `Ticket Manager: Migrate Live Folder to Jira API` exists as the current migration surface.
- `Ticket Manager: Link Jira API Epic` links a workspace to a Jira API epic.
- Jira API supports direct Jira Server/Data Center issue, transition, comment, attachment, and sub-task operations.
- GitLab support exists for API/MR delivery workflows, but it is not a full issue/board backend equivalent to Jira/File mode.
- GitHub settings/setup exist, but no GitHub issue/board backend service is currently present in `src`.

## Phase 1 — Command and UI Surfaces

1. Keep `Ticket Manager: Migrate Live Folder to Jira API` as the Jira-specific entry point.
2. Add a generalized migration command only after at least two targets share the same migration flow, for example `Ticket Manager: Migrate Live Folder`.
3. Add setup-view affordances:
   - show the current Live Folder source path
   - show the selected target backend
   - show linked Jira epic / GitLab project / GitHub owner-repo target
   - expose dry-run before execution
4. Add a migration summary panel with:
   - source items discovered
   - mapped target issue types
   - planned create/update operations
   - warnings and unsupported fields
   - rollback/idempotency metadata

## Phase 2 — Source Discovery and Validation

1. Reuse the Live Folder parser as the source of truth.
2. Validate folder shape before creating remote data:
   - feature folders contain `feature.md`
   - child markdown names are parseable
   - required fields are present or can be inferred
   - issue types are one of `Feature`, `Story`, `Task`, `Bug`
3. Normalize markdown with the existing import/template command before migration when the user opts in.
4. Detect duplicate local keys, duplicate titles under the same parent, missing parents, and invalid statuses.
5. Produce a validation report that can block destructive/ambiguous migrations.

## Phase 3 — Field Mapping

Create a target-neutral migration model first:

| Live Folder field | Target-neutral field | Notes |
| --- | --- | --- |
| title / heading | summary/title | Preserve original text. |
| `Type` | issue type | Map target-specific names separately. |
| `Status` | workflow status | Map through configured status mapping. |
| `Priority` | priority | Preserve when supported; warn otherwise. |
| `Model` | AI/model metadata | Store as label, custom field, or comment depending on target. |
| `Severity` | bug severity | Jira custom field or label; GitLab/GitHub label by default. |
| `Reported By` | reporter metadata | Preserve in description/comment if target cannot set reporter. |
| `Description` | description/body | Preserve markdown where possible. |
| `Dependencies` | linked issues/metadata | Target-specific support required. |
| `Comments` | comments/notes | Import as comments with migration attribution. |
| source path | migration metadata | Required for idempotency. |

Target-specific rules:

- Jira API: map `Feature` to Epic when appropriate; map Story/Task/Bug/Sub-task according to Jira project issue types.
- GitLab: decide whether Live Folder items become issues, epics, labels, milestones, or issue tasks; GitLab's model differs from Jira.
- GitHub: design the backend first; likely map items to issues with labels, milestones, projects, and task lists.

## Phase 4 — Hierarchy Mapping

1. Preserve hierarchy:
   - Feature → Story/Task/Bug in Live Folder
   - Jira API: Epic → Story/Task/Bug, with sub-tasks only where Jira issue types require it
   - GitLab: Epic/Issue relationship or labels/milestones depending on available APIs and instance tier
   - GitHub: Issue hierarchy through task lists, sub-issues, labels, projects, or tracked-by links depending on supported APIs
2. Store source-to-target mappings:
   - source local key
   - source file path
   - target provider
   - target project/repo
   - target issue key/id/url
   - migration version
3. Allow partial migrations to resume without duplicating already-created items.

## Phase 5 — Comments, Status, Metadata, and Attachments

1. Comments:
   - preserve author text when known
   - mark imported comments as migrated from Live Folder
   - avoid re-importing identical comments on retry
2. Status:
   - support configured status mapping per target
   - validate target transitions before trying to move issues
   - record warnings when target workflows cannot represent a Live Folder status
3. Metadata:
   - preserve priority, severity, model, source path, and parent references as native fields where possible
   - fall back to labels or a migration metadata block in the description
4. Attachments:
   - discover local markdown-linked files
   - upload only after issue creation succeeds
   - record attachment hashes for idempotency
   - warn when a target backend lacks attachment support

## Phase 6 — Dry Run, Rollback, and Idempotency

1. Dry-run is mandatory before the first mutable run:
   - no remote writes
   - full operation plan
   - validation warnings
2. Idempotency:
   - persist a migration mapping file or workspace state entry
   - stamp target issues with hidden migration metadata where the target supports it
   - match existing target issues by stored metadata first, then key/title fallback
3. Rollback:
   - support "created by this migration run" rollback for targets that allow deletion/closing
   - prefer safe rollback by adding a rollback comment and closing issues when deletion is risky
   - never rollback target issues not created by the current migration run unless explicitly selected
4. Failure recovery:
   - checkpoint after each successful create/update
   - retry transient API failures
   - surface a resumable error report

## Phase 7 — Tests

1. Unit tests:
   - Live Folder discovery and validation
   - markdown-to-neutral mapping
   - target-specific field mapping
   - hierarchy mapping
   - idempotency matching
2. Integration-style tests with fake services:
   - Jira API migration create/update/resume
   - GitLab target mapping without full issue backend assumptions
   - GitHub target blocked until backend service exists
3. Regression tests:
   - no duplicate creates on retry
   - dry-run performs no writes
   - rollback only touches run-created items
   - unsupported fields produce warnings, not silent loss

## Phase 8 — Open Decisions and Risks

- Whether `Feature` should always become a Jira Epic or be configurable per project.
- Where to persist migration mappings: workspace state, sidecar file, remote metadata, or a combination.
- How to represent GitLab hierarchy across instance tiers and APIs.
- How to represent GitHub hierarchy without an existing backend service.
- Whether comments should preserve exact timestamps or use migration-time comments with original timestamp text.
- How to handle target workflow statuses that require unavailable transitions.
- How to migrate local attachments referenced by markdown.
- How to prevent accidental writes when `ticketManager.liveFolderAllowIssueCreation` is false but target migration is requested.
