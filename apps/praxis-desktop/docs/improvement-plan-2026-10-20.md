# Improvement plan — five existing features (2026-10-20)

Scope: features that already ship but have a documented or in-code gap. Nothing here is a new
product area. Evidence is `docs/desktop-feature-parity.md`, `docs/desktop-gap-plan.md` and
explicit "not implemented / not supported yet" errors in the code.

## Candidates considered

| Candidate | Evidence | Outcome |
| --- | --- | --- |
| Output log has no search / copy / export | gap plan "UX gaps (high-value, low-effort)" | **Chosen (1)** |
| Output log lost on restart (500-line RAM ring) | parity doc "Remaining gaps" #3 | **Chosen (2)** |
| GitLab cannot create issues | `createIssue` throws "not implemented yet"; GitHub has it, gated | **Chosen (3)** |
| GitLab refusals do not say what to do instead | GitHub's refusals name alternatives; GitLab's all say "not implemented yet" | **Chosen (4)** |
| Folder multi-root: New issue fails only after the form is filled | `folderService.createIssue` throws for any non-primary root | **Chosen (5)**, narrowed to refusing up front — see review 3 |
| Signed auto-update | blocked on credentials | Rejected: not doable here |
| Multi-file / shell agent proof (FX-BE-036) | already shipped (`8a52f794`); docs stale | Housekeeping: fix the docs |
| Code-intel language-aware hybrid weight | needs its own experiment | Rejected: research, not a feature fix |
| Deployment / diagnosis "no Electron e2e" | coverage debt, needs fixtures | Rejected: large, low user-visible gain |

## Five review passes

1. **User impact.** (1)(2) are used daily when debugging; (3) unblocks a whole backend's
   create flow; (4) turns dead-end errors into next steps; (5) removes a silent-sounding refusal.
   Order by impact: 1, 3, 2, 5, 4.
2. **Evidence.** Every chosen item cites a line in the repo's own docs or code. The FX-BE-036
   candidate was dropped here after checking history showed it already shipped.
3. **Risk.** (1) renderer-only. (2) touches main only; must never break startup if the file is
   unreadable. (3) new write path to a remote — gate it behind `allowIssueCreation` default-off,
   exactly as GitHub does. (5) was first scoped as "create in the chosen root". Reading the code
   showed feature-id allocation, parent resolution, key generation and table-row writes all use
   primary-root state, so a quick change would misfile issues — the thing the refusal exists to
   prevent. Narrowed to what is safe: mark secondary-root boards `issueCreation: { allowed: false, reason }`
   and disable New issue up front with that reason. Real per-root creation stays open.
4. **Testability.** Core/main logic is unit-testable (log persistence, GitLab create with a
   fake `fetch`). The renderer has no unit-test runner, so the filter is covered through
   Playwright specs scoped to the bottom panel, GitLab gating and multi-root boards.
5. **Scope / dependencies.** No new IPC channel shapes beyond one optional `log:export`-free
   design: export uses the existing clipboard / save path in the renderer (Blob download), so
   no contract change. Persistence is a file in userData written by main. Items are independent
   and each gets its own commit-sized change.

## Plan

1. **Output filter + copy + clear** (renderer): text filter box, case-insensitive, matches
   the `[tag]` prefix too; Copy visible lines; Save via Blob; Clear view (view only — a reload
   re-reads the buffer). Pure helper `filterLogLines` in `app/logFilter.ts`.
2. **Log persistence**: main (`logPersistence.ts`) seeds the existing `LogBus` from, and appends
   every line to, `<userData>/logs/application.log` (JSON string per line, rotated once past 1 MB).
   Core is unchanged and host-neutral. Seeding is a synchronous bounded read so order is exact.
3. **GitLab issue creation**: `GitLabApiService.createIssue`, `GitLabConfigStore.getGitLabAllowIssueCreation`,
   board service `createIssue` gated and validated like GitHub.
4. **GitLab refusals**: delete → "close the issue instead", attachments → "add a link";
   board CRUD → "manage boards in GitLab".
5. **Folder multi-root**: secondary-root boards carry `issueCreation`; New issue and Quick
   capture disable up front with the reason (no create-in-root yet).

Housekeeping: correct the parity / gap docs (FX-BE-036 shipped; logs gap narrowed).

Verification: package unit tests (`packages/core`), `check-types`, scoped Playwright for the
bottom panel only (per the repo's test-scoping rule).

## Outcome

| Check | Result |
| --- | --- |
| `packages/core` `npm test` | 1563 tests, 1561 pass, 0 fail (new: `gitLabBoardService.test.ts`, 6) |
| `apps/praxis-desktop/main` `npm run test:git` | 78 pass, 0 fail (new: `logPersistence.test.ts`, 6) |
| `check-types` (main and renderer) | clean |
| Playwright: `shellPolish`, `folderMulti`, `gitlab`, `quickCapture`, `newIssue`, `iconButtonTooltips`, `keyboardFocus` | all pass (new: 2 log, 1 multi-root, 2 GitLab gating) |
| Full e2e suite | not run (changes are scoped; see the scope rule) |
| Not verified | creating a GitLab issue against a real server — only against a fake `fetch`; the mock GitLab server has no create route |

## Backlog follow-up (same day)

| Item | Result |
| --- | --- |
| FX-BG-048 `--border-subtle` undefined | Done — declared on `:root` as an alias of `--border` |
| FX-BG-049 `--radius-xs` undefined | Done — declared on `:root`, scales with `--ui-scale` |
| TASK-440 chat links in an isolated pane | Done, with a deviation: opens in the session console's in-app browser dock, not the shared right pane |
| FX-BF-047 scheduled ticket work runs | Not started — unattended, money-spending execution with open design questions (where schedules live, approval behaviour); needs a decision first |
| TASK-438 coordination on Linux and Windows | Not possible from this macOS machine |

Verification: new `cssTokens.spec.ts` and `chatLinks.spec.ts` pass; `aiBrowser`, `aiAcpBrowser`, `iconButtonTooltips`, `keyboardFocus` and the screenshot specs for the shell, projects, workflow themes, marketplace and workflow designer pass. `assistant.spec.ts:135` fails (compact usage summary shows `––`, spec expects "Not reported") — unrelated to these changes and not on the known-failures list.
