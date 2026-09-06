---
type: Story
id: FX-BE-035
title: Real GitHub backend
status: complete
feature: FX-BF-016
issue: docs/issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/stories/fx-be-035-github-backend/issue.md
updated: 2026-09-05
commits: [5fd2cf6, 60aa032, 580613c, fe77ae8]
dependencies: []
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Real GitHub backend

## User or operational impact

The target audience is mostly on GitHub, not Jira. A GitHub connection
appeared in the new-connection dropdown and stored a PAT in the keychain, but
`getServiceForConnection` fell through to `StubBackendService` — it read empty
and every mutation threw "GitHub project mode is not implemented yet". A real
backend closes that: connect a repo, get a real board with real editing.

## As built (2026-09-05)

Shipped in `580613c` / `fe77ae8`; the authoritative implementation record,
including the three scope corrections caught before coding, is
[the issue](../../../../issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/stories/fx-be-035-github-backend/issue.md).
Summary:

- **Modeled on `FolderService`, not `GitLabBoardService`.** GitLab is a
  partial implementation whose refusals say "not implemented yet"; folder's
  refusals are decided boundaries that name the alternative. GitHub follows
  folder — refusals in folder's voice, never touching the network to refuse.
- `packages/core/src/github/`: `GitHubApiService` (REST client against
  `api.github.com`, PAT via the existing `secretNamesForMode('github')`
  wiring, Link-header pagination, errors surfaced verbatim), `GitHubBoardService
  implements IssueTrackerService` (one repo = one board, columns synthesized
  from discovered `status: …` labels), `GitHubConfigStore`.
- Implemented: `getIssues`, `getIssue`, `getFilterMetadata`, `createIssue`
  (behind `allowIssueCreation`, as folder does), `updateIssue` (summary /
  description / assignee — `UpdateIssueInput` is a frozen shared type with no
  labels/milestone field, so this matches GitLab's three fields, not folder's
  seven), `addComment`, `transitionIssue` (status-label swap + open/closed
  state — status labels move only via board drag-drop, never the edit form),
  `getBoards`, `getBoard`.
- Refused, folder-style: `createBoard`/`updateBoard`/`deleteBoard` (a GitHub
  board is the repo), `deleteIssue` (no REST delete — close it), attachments
  (no issue-attachment API).
- **No new renderer component and no new CSS token.** The only renderer-visible
  change is a `ConnectionForm` branch for repo owner/name and the status-label
  set, built from the same form primitives GitLab and Jira Cloud use;
  everything else renders through the existing `BACKEND_MODE_META.github` /
  `--tone-github` path that was already defined.
- **Non-regression gate held.** `serviceRegistry.ts` got a new `case 'github'`
  before `default` (unreachable from `case 'folder'`); the three shared
  switches that genuinely needed editing (`canCreateIssue`,
  `backendModeContext`, `autoSynthesizesBoard`) each extended a github-only
  arm with the gitlab/folder arms left byte-identical. `folder.spec.ts` +
  `folderMulti.spec.ts` + `editIssue.spec.ts` + `newIssue.spec.ts`: 13 passed,
  matched before and after.

## Open decisions — resolved

1. **Board source** — issue labels, matching folder's synthesize-from-connection
   model (not GitHub Projects v2, which needs GraphQL and a different scope).
2. **Default status-label set** — discovered from the repo's own `status: …`
   labels rather than a fixed default; a repo with none still renders
   Backlog/Closed.
3. **Create-issue support** — follows folder: gated behind `allowIssueCreation`.

## Acceptance criteria — all verified

Each is proven by a named test, not a pending claim:

- A GitHub connection with a valid PAT lists real repo issues as a board with
  columns from discovered status labels. ✓ `github.spec.ts` "board renders
  every synthesized column with its issue".
- Edit round-trips summary / description / assignee. ✓ `github.spec.ts`.
- Comments and status transitions round-trip; a transition moves only the
  status label. ✓ `github.spec.ts`.
- Issue creation respects `allowIssueCreation`. ✓ `github.spec.ts`
  (disabled / enabled cases).
- An invalid/expired PAT — and a missing owner/repo — fail with GitHub's own
  error text, never falling back to demo or empty. ✓
  `githubBoardService.test.ts` (missing PAT, missing owner/repo, 401, 404).
- Unsupported operations refuse in folder's voice, without a network call. ✓
  `githubBoardService.test.ts`, one test per refused method against a `fetch`
  that throws if called.

## Task list

Built in one pass rather than the staged breakdown the original plan
anticipated — see the commits above.

## Close when

Connecting a GitHub repo gives a real board with real editing, and the folder
gate is unchanged at 13 passed. **Met.**
