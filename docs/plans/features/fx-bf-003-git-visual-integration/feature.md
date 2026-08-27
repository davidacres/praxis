# FX-BF-003: Git Integration With Visual Commit Graph

**Status:** Complete
**Owner:** Electron desktop app
**Priority:** P1
**Risk:** Medium
**Created:** 2026-08-26

## Outcome

Give Praxis a clear, editor-sized view of repository history and a clean, easy diff workspace that helps non-expert Git users understand what changed, where work split, where it came back together, and what safe action to take next. The feature uses the installed system Git executable and keeps repository mutations explicit and recoverable.

## Fit decision

This belongs in `packages/electron-app` + `packages/frontend` as a first-class `Git Graph` page. Electron’s main process owns subprocess execution, repository discovery, caching, and mutation safety; the preload exposes a narrow typed IPC contract; React owns rendering and interaction. `packages/core` owns shared serializable contracts. The VS Code extension is not part of this delivery because adding a second Git host would duplicate process/error/cache behavior.

The existing desktop service/IPC patterns are reused, but the new Git layer must be independently testable and must not depend on Jira, GitLab, board state, or AI providers. Git operations must never be run in the renderer.

## Scope

### First vertical slice

1. Discover the active repository by walking from the workspace file/folder to the nearest `.git` directory or Git worktree metadata.
2. Detect and report the system Git executable, with a configurable override.
3. Load local and remote refs, commit history, parent/child relationships, merge commits, and branch hints.
4. Build a deterministic lane layout for thousands of commits without third-party graph dependencies.
5. Open a full-width Git Graph editor with branch/ref rail, graph canvas, timeline controls, and commit inspector.
6. Support selection, branch focus, merge-only filtering, date filtering, zoom, pan, refresh, and opening changed files/diffs.

### Delivered follow-on slice: FX-BE-004

1. Structured Inline, Split, and Hunk comparisons for working, staged, commit, range, branch, and ref changes.
2. WIP navigation plus file, hunk, and selected-line stage/unstage/discard workflows.
3. Commit creation; branch create/delete/checkout/rename/merge/rebase; stash/pop; cherry-pick; revert; pull/push.
4. File history, blame, smart branch visibility, pinned branches, and commit context actions.
5. Three-pane conflict resolution with current/incoming choices, line selection, editable output, marker validation, and safe abort.

### Still out of scope

Reset and force-push workflows, remote hosting APIs, CI badges, pull-request review, patch-file import/export, and automatic destructive operations.

## Story map

- `FX-BE-003` — Desktop Git graph foundation and editor shell. **Complete.**
- `FX-BE-004` — Praxis diff workspace and safe Git workflows. **Complete.**

## Visual direction

The graph is the hero surface, taking inspiration from GitKraken’s readable branch topology and GitLens’s editor-native context. It should feel like a polished VS Code tool rather than a miniature desktop clone.

- **Layout:** top command bar; slim left ref rail; central horizontally pannable graph/timeline; right inspector drawer that can collapse to preserve graph width.
- **Canvas:** near-black/slate surface with a faint horizontal time grid. Commits sit on a consistent vertical rhythm; lanes are colored paths rather than isolated dots.
- **Topology:** smooth cubic connectors, short animated transitions on refresh/filter, thicker selected-path emphasis, and clear split/merge glyphs at topology events.
- **Color:** semantic branch palette with color-blind-safe hues; branch color is never the only signal. Main blue, feature green, hotfix red, release purple, detached gray; selected nodes also use a ring and label.
- **Refs:** branch and tag chips docked beside commit rows, with `HEAD` and remote badges visually distinct. Long names truncate with tooltips.
- **Inspector:** commit message first, then author/date/SHA, parent/child links, changed-file list, and diff action. The inspector should preserve selection when filters change where possible.
- **Non-expert language:** “Branch split”, “Merged work”, “Current branch”, “Remote branch”, and “Changed files” are preferred over unexplained Git jargon. Destructive actions require confirmation and plain-language explanation.
- **Motion:** 120–180ms ease-out lane emphasis, subtle node halo on selection, and no continuous animation. Respect `prefers-reduced-motion`.

## Architecture

```text
Desktop workspace/repository path
  -> Electron main: RepositoryLocator
  -> Electron main: GitRunner (system git, argument arrays, bounded output, cancellation)
  -> Electron main: GitRepositoryService (status, refs, log, show, diff, later mutations)
  -> shared/core: CommitGraphBuilder (DAG, children, lanes, branch hints, topology markers)
  -> preload: typed git IPC contract
  -> React renderer: GitGraphPage (SVG first; canvas only after measurement proves necessary)
```

Use structured separators and machine-readable formats wherever Git provides them. Do not parse human-formatted output when `--format`, `-z`, or `--porcelain` can provide stable boundaries. Every command error should preserve the Git exit code, stderr, repository path, and a user-safe message.

## Data contracts

`CommitNode` contains full hash, parent hashes, child hashes, author identity, authored/committed dates, subject/body, branch hints, lane, merge flag, divergence flag, convergence flag, and refs. `BranchInfo` contains display name, full ref, tip, local/remote classification, upstream, and current state. Graph layout output is immutable and serializable across the Electron IPC boundary.

## Delivery gates

1. Fit and visual contract reviewed in the feature plan before implementation. **Complete.**
2. Backend tests cover missing Git, non-repository folders, worktrees, shallow history, malformed output, merge commits, tags, and remote refs. **Complete through `packages/electron-app` Git integration fixtures and `packages/core` parser tests.**
3. Graph tests cover linear, split, merge, criss-cross, detached HEAD, and multiple refs on one commit. **Complete, including the 5,000-commit benchmark.**
4. Renderer tests cover selection, filters, zoom/pan, inspector, empty/error/loading states, and reduced motion. **Wide, narrow/reduced-motion, and horizontal timeline Electron visual tests complete; keyboard commit selection and settings persistence are covered.**
5. Core, Electron, and frontend type checks plus a focused Electron visual pass are green on the current repository. **Complete.**
6. Structured diff parsing and partial patch application are proven against temporary repositories. **Complete.**
7. Wide/narrow diff workspaces and a real conflicted repository are captured and verified in packaged Electron. **Complete.**
8. The complete Git Graph Electron spec passes after the production renderer is rebuilt and copied. **Complete: 3/3 current Git desktop scenarios pass, including responsive reduced-motion and a real conflicted repository.**

## Validation note

The broader Electron suite was also attempted on 2026-08-27. It is not green in the current shared worktree because legacy board tests still expect the removed root `Boards` navigation and unrelated AI-provider tests fail against current session/secret state. Those failures neither exercise nor contradict this Git feature; the independently runnable core, real-repository service, type/build, copied-renderer, and complete Git Graph Electron suites are green.

## Close conditions

- Read-only graph flow is usable and verified before any Git mutation is enabled.
- Git operations never use shell interpolation and never silently mutate the repository.
- The graph remains legible at 100, 1,000, and 5,000 commits, with a documented performance fallback.
- Errors explain what happened and give a safe next action.
- Settings, commands, docs, and tests are updated together.
