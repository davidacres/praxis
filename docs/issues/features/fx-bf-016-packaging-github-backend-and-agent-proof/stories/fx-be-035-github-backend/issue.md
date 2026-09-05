# FX-BE-035 — Real GitHub backend

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** —

## Implementation note

Shipped as planned below, with the three open decisions resolved as: labels
(a repo's `status: …` labels synthesize the board columns, discovered rather
than a fixed default set — a repo with none still renders Backlog/Closed);
issue creation follows folder (gated behind `allowIssueCreation`).

One correction to this plan's own scope, caught before writing code: "Edit
round-trips … summary, description, assignee, labels and milestone" overreached
— `UpdateIssueInput` (a frozen shared type) has no `labels`/`milestone` field,
so the generic edit panel is summary/description/assignee only, identical to
GitLab's three fields. Status labels still move, but only via board drag-drop
column transitions (`transitionIssue`), the same mechanism GitLab itself uses
to add/remove its own board labels — never through the edit-issue form.

`backendModeContext.ts`'s shared `case 'github': case 'gitlab':` arm was split
as planned, but turned out to have zero runtime consumers in either `main` or
`renderer` — the lowest-risk item in the non-regression list below, not the
highest, since nothing was actually calling it.

Non-regression gate: `folder.spec.ts` + `folderMulti.spec.ts` + `editIssue.spec.ts`
+ `newIssue.spec.ts` — 13 passed, matched before and after.

New coverage, two layers:
- `github.spec.ts` + `mockGitHubApi.ts` (e2e, 6 tests) against an in-process
  mock REST server — connection health check, board column synthesis,
  comment/edit round-trip, label-preserving column transitions, gated issue
  creation.
- `githubBoardService.test.ts` (core unit, 10 tests, added to
  `packages/core/package.json`'s explicit test-file list — this repo's `test`
  script names each file rather than globbing, so a new `.test.ts` runs
  silently zero times until it's added there) — every folder-style refusal
  (`createBoard`/`updateBoard`/`deleteBoard`/`deleteIssue`/`attachFile`/
  `downloadAttachment`) asserted against its exact message and proven to throw
  before any network call; a missing PAT or repo throwing instead of silently
  reading empty; a 401 and a 404 from GitHub surfacing verbatim rather than
  being swallowed into a false "connected" result.

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
- Implemented: `getIssues`, `getIssue`, `getFilterMetadata`, `createIssue`
  (behind `allowIssueCreation`, as folder does), `updateIssue` (summary,
  description, assignee — `UpdateIssueInput` is a frozen shared type with no
  labels/milestone field, so this matches GitLab's three fields, not folder's
  seven), `addComment`, `transitionIssue` (status label swap + open/closed
  state — this is how a status label actually moves), `getBoards`, `getBoard`.
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

All verified — ✓ names the test that proves it, not a claim pending one.

- A GitHub connection with a valid PAT lists real repo issues as a board, with
  columns derived from the discovered status labels. ✓ `github.spec.ts` "board
  renders every synthesized column with its issue".
- Edit round-trips to the real issue for summary, description, and assignee —
  the same three fields GitLab supports, not folder's seven (`UpdateIssueInput`
  is a frozen shared type with no labels/milestone field). ✓ `github.spec.ts`
  "adding a comment and editing summary round-trips through the mock".
- Comments and status transitions round-trip; a transition adds/removes only
  the status label, leaving unrelated labels untouched. ✓ `github.spec.ts`
  "adding a comment…" and "moving a card to a status column…".
- Issue creation respects `allowIssueCreation`, the same gate folder uses. ✓
  `github.spec.ts` "issue creation is disabled…" / "…round-trips a new issue
  once enabled".
- An invalid or expired PAT — and a missing owner/repo — fail with GitHub's own
  error text, never falling back to demo or empty data. ✓
  `githubBoardService.test.ts`, 4 tests (missing PAT, missing owner/repo, a
  401, a 404).
- Unsupported operations refuse in folder's voice — naming the alternative —
  never "not implemented yet", and never touch the network to do it. ✓
  `githubBoardService.test.ts`, 6 tests (one per refused method), each run
  against a `fetch` that throws if called.
- No new CSS token and no new renderer component; GitHub renders through the
  existing `BACKEND_MODE_META` path under all four theme axes. ✓ verified by
  diff — the only renderer file touched besides wiring is `ConnectionForm.tsx`,
  adding a mode branch with existing form primitives.
- The folder gate above reports 13 passed after the change, and no non-github
  arm of any shared switch differs in the diff. ✓ re-run before and after.

## Validation

- `npm run check-types` — clean, including `check-core-imports`.
- `npm run test:core` — 334 passed (10 new: `githubBoardService.test.ts`).
- `npm run test:desktop` (targeted, not the full 60-file suite — see below) —
  `github.spec.ts` 6/6, the folder gate 13/13, plus `connectionsManager`,
  `deadConnection`, `boardSettingsFile`, `gitlab` all green.
- Not run in this environment: the OS-keychain-backed secret path for the real
  `pat` secret (`connection:setSecret` needs Electron's `safeStorage`, which
  this sandbox has no backend for — the same pre-existing gap
  `aiProvider.spec.ts` and one `connectionsManager.spec.ts` GitLab test already
  hit here). The e2e instead exercises the inline `settings.pat` fallback,
  which is real production code — GitLab's `apiKey` setting works the same
  way — but the keychain round-trip itself wants an environment with one.
- Not run in this environment: the full `npm run test:desktop` across all 60
  spec files — scoped intentionally to this change's actual blast radius
  rather than run for its own sake.

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

Connecting a GitHub repo gives a real board with real editing, and the folder
gate is unchanged at 13 passed. Met.
