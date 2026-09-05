---
id: FX-BE-035
title: Real GitHub backend
status: planned
feature: FX-BF-016
issue: docs/issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/stories/fx-be-035-github-backend/issue.md
updated: 2026-09-05
commits: []
dependencies: []
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Real GitHub backend

## User or operational impact

The target audience is mostly on GitHub, not Jira. Today a GitHub connection
saves as metadata only — "which tracker" is the first wall a new user hits if
they don't already use Jira Cloud or folder-of-markdown-plans.

## What already exists (verified 2026-09-05, not to be re-litigated)

- `github` is a real entry in `CONNECTION_MODES` (`connectionPolicy.ts`) — it
  appears in the "new connection" dropdown.
- `secretNamesForMode('github')` stores a PAT (`pat`) through the same OS
  keychain path every other mode uses.
- `ConnectionForm.tsx`'s github case renders an explicit placeholder: "GitHub
  mode is not implemented yet — there is no GitHub board backend in either the
  extension or the desktop app. The connection saves as metadata only."
- `serviceRegistry.ts` has no `case 'github'` — it falls through to
  `getStubService(connection.mode)`, which reads empty and throws a clear
  message on any mutation.
- No GitHub API surface exists anywhere in the repo (`api.github.com`,
  `octokit`, or otherwise) — confirmed by search, not assumed.

## Scope (not started)

- A real GitHub REST or GraphQL client, authenticated via the already-stored
  PAT.
- Issue listing mapped to Praxis's `IssueTrackerService` contract (the same
  one Jira Cloud and GitLab implement).
- A board synthesized from repo issues/labels/milestones (auto-synthesized
  board, matching how Jira Cloud and GitLab connections behave today).
- Issue create/edit, to the extent GitHub's API supports it.
- OAuth as a PAT alternative, if warranted once the REST/GraphQL layer exists.

## Acceptance criteria

- A GitHub connection with a valid PAT lists real issues as a Praxis board.
- Creating/editing an issue in Praxis round-trips to the real GitHub issue.
- An invalid or revoked PAT produces the same clear, non-silent failure the
  other real backends already give (never falls back to demo data).

## Task list

Not yet broken into tasks — this is a multi-week feature (auth,
REST/GraphQL, issue/board/transition mapping), not something to fake in one
pass. Break it down before writing code: start with read-only issue listing,
then create/edit, then a board mapping — in that order, each independently
shippable.

## Close when

A GitHub-tracked repo has the same "which tracker" answer Jira Cloud and
GitLab already do: connect it, see real issues, no metadata-only surprise.
