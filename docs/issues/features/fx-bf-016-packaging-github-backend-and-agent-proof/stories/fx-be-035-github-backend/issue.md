# FX-BE-035 — Real GitHub backend

**Type:** Story  **Status:** Planned  **Priority:** P2  **Depends on:** —

## Business or operational impact

The target audience is mostly on GitHub, not Jira. A GitHub connection exists in
the UI today, appears in the new-connection dropdown, and stores a PAT in the OS
keychain — but `getServiceForConnection` falls through to `StubBackendService`,
so the connection reads empty and every mutation throws
`"GitHub project mode is not implemented yet"`. The mode is a promise the app
does not keep.

## The model: folder, not GitLab

GitLab is the wrong template. It is a *partial* implementation whose refusals say
"not implemented yet" — `createBoard`, `updateBoard`, `deleteBoard`,
`createIssue`, `deleteIssue`, `attachFile` and `downloadAttachment` all throw
that phrase (`gitLabBoardService.ts:579-664`), and `updateIssue` accepts three
fields.

`FolderService` is the reference for what *complete* means here. Its refusals are
decided boundaries that name the alternative — "Folder mode does not support
deleting issues. Remove the markdown files directly." (`folderService.ts:800`) —
and the surface it does implement is deep: seven editable fields
(`folderService.ts:688-779`), working comments, working transitions, board
synthesis from the connection itself, and issue creation gated behind an explicit
`allowIssueCreation` setting with real hierarchy rules.

GitHub should be judged against folder. GitLab is consulted only for HTTP-tracker
mechanics — auth headers, pagination, label-to-column mapping, assignee
resolution — never for scope.

## Scope

### Backend (`packages/core/src/github/`)

- `GitHubApiService` — REST client (`api.github.com`), PAT from the keychain via
  the existing `secretNamesForMode('github') → ['pat']` wiring. Link-header
  pagination. Errors surfaced verbatim, never swallowed into empty results.
- `GitHubBoardService implements IssueTrackerService` — one repo, one board,
  synthesized from the connection the way folder synthesizes from its primary
  root. Columns derive from a configured status-label set; `getBoard` maps
  `state` + status labels onto columns.
- Implemented, matching folder's depth: `getIssues`, `getIssue`,
  `getFilterMetadata`, `createIssue` (behind `allowIssueCreation`, as folder
  does), `updateIssue` (summary, description, assignee, labels, milestone),
  `addComment`, `transitionIssue` (status label swap + open/closed state),
  `getBoards`, `getBoard`.
- Refused, folder-style — a decided boundary that names the alternative, not
  "not implemented yet": `createBoard`/`updateBoard`/`deleteBoard` (a GitHub
  board is the repo), `deleteIssue` (GitHub has no issue delete on the REST API
  — close it instead), attachments (GitHub has no issue-attachment API; files
  live in comment markdown).

### UI and theme — no new surface

This is the point of the design, so it is stated as a constraint rather than a
task: **the feature adds no new component and no new CSS token.** Every visual
affordance GitHub needs already exists and is mode-driven:

- `BACKEND_MODE_META.github` is already defined (`boardMeta.ts:78`) with label
  `GitHub`, the `git-branch` icon, and tone `var(--tone-github)`.
- `--tone-github: #8b7bb8` is already declared in `theme.css:37`, in the same
  base block as `--tone-gitlab` and `--tone-jira` — a fixed brand tone that
  every one of the four theme axes (`data-mode`, `data-accent`, `data-theme`,
  `data-surface`) already inherits without a per-theme override, exactly as the
  other backends do.
- Board cards, the sidebar connection group, `ConnectionStatusDot`, the
  backend-mode chip and the project wizard all read that metadata by mode. They
  render GitHub correctly today; only the data behind them is empty.

So "does not stand out" is not a styling exercise — it is achieved by adding
nothing to the renderer's visual layer at all. The single renderer-visible change
is a `ConnectionForm` branch for repo owner/name and the status-label set, built
from the same form primitives the GitLab and Jira Cloud branches use.

## Non-regression constraint

Live folder is the proven backend and must be provably unaffected. This is an
acceptance criterion, not a precaution.

**Frozen — must not change:**

- The `IssueTrackerService` interface. Any signature change forces every backend
  to change and puts folder in the blast radius.
- Shared types in `packages/core/src/types.ts`.
- Everything under `packages/core/src/folder/`.

**Additive only — a new arm beside existing ones, no existing arm edited:**

- `serviceRegistry.ts:217` — new `case 'github'` before `default`. The switch is
  on `connection.mode`, so this is unreachable from `case 'folder'`.
- `EDITABLE_FIELDS_BY_MODE` (`IssueDetail.tsx:295`) — the `github:` key only.
- `ConnectionForm.tsx` — new branch.
- `stubBackendService.ts:19` — its github arm becomes dead code.

**Shared conditions that genuinely need editing — three, each verified in the
diff:**

1. `canCreateIssue` (`App.tsx:1198`) — extend the existing OR with
   `|| connection.mode === 'github'`. Folder already sits in that branch and
   evaluates identically.
2. `backendModeContext.ts:19` — `case 'github':` and `case 'gitlab':` share one
   arm returning `configured: false`. GitHub must move out, so the label is
   **split** and gitlab's arm left byte-identical. This is the one place a slip
   could silently change another backend.
3. `autoSynthesizesBoard` (`connectionPolicy.ts:45`) — a GitHub repo is its own
   board, as a folder root is; github joins `folder || demo` as an OR-extension.

**Measured gate.** Before and after every commit:

```
xvfb-run -a npx playwright test folder.spec.ts folderMulti.spec.ts \
  editIssue.spec.ts newIssue.spec.ts --project=functional --workers=1
```

Baseline at plan time: **13 passed**. Folder is additionally exercised by
`connectionsManager`, `deadConnection`, `boardSettingsFile`, `journey`,
`projects`, `workspaceFile`, `importProjects`, `aiWorkflows`, `gitlab` and
`workflowRun` specs, plus the `boardConfigFile` and `markdownPlanParser` core
unit tests; the full suite runs before the story closes.

## Acceptance criteria

- A GitHub connection with a valid PAT lists real repo issues as a board, with
  columns derived from the configured status labels.
- Edit round-trips to the real issue for summary, description, assignee, labels
  and milestone — folder-depth, not GitLab's three fields.
- Comments and status transitions round-trip.
- Issue creation respects `allowIssueCreation`, the same gate folder uses.
- An invalid or expired PAT fails with the GitHub error text, never falling back
  to demo or empty data.
- Unsupported operations refuse in folder's voice — naming the alternative — not
  with "not implemented yet".
- No new CSS token and no new renderer component; GitHub renders through the
  existing `BACKEND_MODE_META` path under all four theme axes.
- The folder gate above reports 13 passed after the change, and no non-github
  arm of any shared switch differs in the diff.

## Validation

- `npm run check-types`
- `npm run check-core-imports`
- `npm run test:core`
- `npm run test:desktop`
- The folder gate, before and after each commit.

## Open decisions

Blocking design questions, to be settled before implementation starts:

1. **Board source.** Synthesize columns from issue labels (simple, works on
   every repo, no extra scopes) versus GitHub Projects v2 (GraphQL-only,
   different auth scope, and not every repo has a project). Recommendation:
   labels, matching folder's synthesize-from-connection model.
2. **Default status-label set** — what ships when a repo has no Praxis labels.
3. **Create-issue support.** Folder allows it behind a setting; GitLab does not
   implement it at all. Recommendation: follow folder.

## Close when

Connecting a GitHub repo gives a real board with folder-depth editing, and the
folder gate is unchanged at 13 passed.
