# AGENTS.md

Guidance for AI coding agents working in this repository. This is the root
file (`CLAUDE.md` imports it); area notes live next to the code, indexed below.

## Project Overview

A monorepo: the **Praxis** desktop app over a shared core.

| Workspace | npm name | What it is |
| --- | --- | --- |
| `packages/core` | `@praxis/core` | Shared types, settings, Git parsing, folder/plans parsing, AI/MCP plumbing. CommonJS. |
| `apps/praxis-desktop/renderer` | `@praxis/desktop-renderer` | The desktop renderer — React + Vite. Ordinary DOM. |
| `apps/praxis-desktop/main` | `@praxis/desktop-main` | Electron main + preload + the Playwright e2e suite. Hosts the renderer build. |

Core is consumed only by the Electron app (`main` directly, `renderer` for
types). It targets Node/Electron — no host-abstraction ports.

## Shared logic belongs in core

When both `main` and `renderer` need the same logic it lives in `packages/core`.
The renderer imports **types only** from core at runtime — core is CommonJS and
pulls in `chokidar` / `markdown-it` (and, transitively, native bindings like
`fsevents.node`), so it cannot be tree-shaken into the browser bundle (see the
`settingsDefaults.ts` note below). **A value import from `@praxis/core` anywhere
under `apps/praxis-desktop/renderer/src` compiles clean under `tsc --noEmit` and
only fails `vite build`** — `types` don't care where a value comes from, so this
is easy to reintroduce without noticing if you only typecheck. It happened once
(a small pure function pulled in for reuse instead of duplicated locally,
exactly like `settingsDefaults.ts` already does for `parseHexRgb`) and the
failure read as an unrelated native-binding error three layers down, nothing
like "you imported a value from core." Writing the rule down here did not stop
it recurring, so it is now enforced, not just stated: `npm run check-core-imports`
(`apps/praxis-desktop/renderer/scripts/checkCoreImports.cjs`, TS-compiler-API based,
no regex) runs before both `check-types` and `build` and fails the exact line.
If you need core logic in the renderer, duplicate the small pure function next to
where it's used (as `sessionNav.ts`'s `isLatestEditToPath` duplicates core's
`agentEventUtils.ts` one) rather than importing it.

## Area notes live next to the code

This file holds only what applies to every change. Before working in one of these
areas, read its notes. Claude Code loads them itself when it reads files in that
folder (through the `CLAUDE.md` beside each one); other tools may read only this root
file, so use the table.

| Area | Notes | Covers |
| --- | --- | --- |
| Desktop renderer UI | `apps/praxis-desktop/renderer/AGENTS.md` | feature folder map, theming, surface packs, focus, tooltips, controls, dialogs, command palette, sidebar tree, onboarding, AI provider settings, **verifying a UI change** |
| Workflow run UI | `apps/praxis-desktop/renderer/src/workflows/AGENTS.md` | run tree nodes and the run workspace |
| AI runtime | `packages/core/src/ai/AGENTS.md` | other tools' agents/skills/instructions, ACP agent sessions, interactive ticket review |
| Add-on marketplace | `packages/core/src/marketplace/AGENTS.md` | registry, install, catalogue |
| Plan files | `apps/praxis-desktop/docs/AGENTS.md` | the rules a plan file must meet to appear on the board |
| Phone app (Flutter) | `apps/praxis-flutter/AGENTS.md` | the phone app: protocol port, stage desktop, text metrics, deploy |
| Phone app (Expo, being archived) | `apps/praxis-mobile/AGENTS.md` | the original React Native app the Flutter app replaces |

---

## Renderer CSP

`apps/praxis-desktop/renderer/index.html` carries the CSP, and it **must** keep `img-src 'self' data:`.
The surface pattern and grain layers are inline SVG / data tiles; without that directive
they compute correctly but silently never paint — a failure that looks like a styling bug
and is genuinely hard to trace. An e2e test decodes a live tile through `Image()` to catch
a regression loudly.

## Settings

- One shared JSON document, read through `sanitizeAppSettings` (which also migrates) and
  merged with `mergeAppSettings`. IPC: `settings.get` / `settings.set` / `settings.onChanged`.
- **`apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts` is a hand-maintained, browser-safe mirror
  of core's `DEFAULT_APP_SETTINGS`.** Core is CommonJS and pulls in `chokidar` and
  `markdown-it`, so it cannot be tree-shaken into the renderer bundle. **Add an appearance
  field to core and you must add it here too**, or the Settings page silently drifts from
  what the main process sees.
- Anything from settings that ends up baked into CSS (a colour, a blend mode) must be
  validated to a strict literal in core — a hex, or a keyword from a fixed set. Never pass
  user text through into a stylesheet.

## Workspace / project / connection model

Three layers, each with one job:

- **Workspace** (`.workspace.praxis.json` file, `WorkspaceRecord`) — a saved, shareable set
  of project + connection references. Groups; owns no board data.
- **Project** (`ProjectRecord`, `ProjectStore`) — the unit of planned work. One board.
  `storage: 'app'` keeps work items in app JSON; `storage: 'folder'` backs them with a
  markdown plans folder under `project.workspaceFolder`. Synthetic connection id
  `project:<id>`, `mode: 'project'`.
- **Connection** (`Connection`, `connectionStore`) — an external/system backend.
  `mode ∈ { jiracloud | gitlab | github | demo | folder }`. `folder` points at one or
  more plans-folder roots on disk (native multi-root; each root's `board.praxis.json`
  carries its own `projectKey` / `projectName`).

### Backend modes → services

Every mode resolves to one `IssueTrackerService` through `serviceRegistry.ts`'s
`getServiceForConnection` — a `switch` on `connection.mode` with a `default` arm
that returns a **stub** (`getStubService(mode)`: reads empty, throws a named
message on mutation, and — deliberately — never silently becomes demo data).
A mode with no `case` is a mode with no backend. Per-mode completeness lives in
`docs/desktop-feature-parity.md`'s "Backends & connections" table — keep that
current when a backend's state changes.

- **`folder` (`FolderService`) is the reference for what "complete" means**, not
  `GitLabBoardService`. GitLab is partial: seven of its methods throw
  "not implemented yet" and `updateIssue` takes three fields. Folder's refusals
  are decided boundaries that name the alternative ("Remove the markdown files
  directly"), it has seven editable fields, working comments/transitions, board
  synthesis from the connection itself, and gated issue creation. `github`
  (`GitHubBoardService`, FX-BE-035) is modeled on folder — REST-tracker mechanics
  borrowed from GitLab (auth headers, pagination, label↔column mapping), scope
  judged against folder.
- **Adding or changing a mode: `folder` must be provably unaffected.** The new
  work is a `case` *before* `default` (unreachable from `case 'folder'`), plus a
  github-only arm on each of the three shared switches that genuinely branch on
  mode — `canCreateIssue` (`App.tsx`), `backendModeContext.ts` (split the
  shared `case 'github': case 'gitlab':`, leave gitlab byte-identical),
  `autoSynthesizesBoard` (`connectionPolicy.ts`). Run `folder.spec.ts` +
  `folderMulti.spec.ts` + `editIssue.spec.ts` + `newIssue.spec.ts` before and
  after and confirm the count is unchanged.
- **No new renderer component or CSS token for a new backend.** Every visual
  affordance is already mode-driven: `BACKEND_MODE_META.<mode>` (`boardMeta.ts`)
  and a `--tone-<mode>` in `theme.css`'s base block, inherited by all four theme
  axes with no per-theme override. The one renderer-visible change is a
  `ConnectionForm` branch built from the existing form primitives.

## Naming a file Praxis writes (FX-BE-048, FX-BE-050)

**One form: `<name>.praxis.<ext>`.** Every file Praxis puts in a user's folder
carries `praxis` in its name and keeps its real extension last.

| file | |
| --- | --- |
| `project.praxis.md` | the project's identity, purpose, brief and workflow |
| `board.praxis.json` | that folder's board — key, name, workflow |
| `<slug>.workspace.praxis.json` | a workspace — which projects and connections travel together |

The real extension goes last because **these files are meant to be committed**,
so they are read, diffed and reviewed far more often than they are opened by
the app. That buys editor highlighting, GitHub rendering and JSON schema
association.

There was briefly a second form — `.praxis` as the extension itself, on the
grounds that a workspace file is "opened with Praxis". That justification was
aspirational: there is no `fileAssociations` entry in the electron-builder
config and no `open-file` handler, so double-clicking one has never opened
anything. It was paying the tooling cost for an affordance that did not exist.
If double-click-to-open is built later, register the association against
`.praxis.json` — the same trade VS Code makes for `.code-workspace`, which
GitHub also declines to highlight.

The generic name this replaced (`PROJECT.md`) was a real bug, not untidiness:
Praxis only rewrites a project file carrying its own markers, so a repository
that already had a `PROJECT.md` silently got no Praxis project file at all —
neither adopted nor created. Namespacing removes the collision rather than
arbitrating it.

Use `PROJECT_FILE_NAME` and `PRAXIS_WORKSPACE_FILE_SUFFIX` from core; do not
write either filename as a literal.

## Workspace files are meant to be committed (FX-BE-049)

`toWorkspaceFile` strips anything matching
`/token|secret|password|apikey|api_key|\bpat\b/i` from connection settings —
the point being that "a token must not be the thing that leaks when a workspace
file is committed to a repo". Two things follow that are easy to undo by
accident:

- **Folder paths inside the file's own tree are stored relative to the file**
  (`./apps/web`, POSIX separators) and resolved against the file's directory on
  read, so a committed workspace opens wherever the tree is cloned. A folder
  *outside* that tree stays absolute — there is nothing sensible to make it
  relative to, and rewriting it would be worse than being honest.
- **`folderInspection` is dropped on write.** It caches *local* filesystem
  facts — detected languages, manifests, whether there is a git repo. Shipping
  it to someone else hands them our snapshot as if it were theirs. It is
  re-derived by `inspectFolder`.

`workspacePaths.ts` holds both directions and is unit-tested; pass the file's
directory to `toWorkspaceFile` / `readWorkspaceFile` or paths are written
verbatim.

## A project's workflow is data (FX-BF-019)

A workflow describes **how a team works**. It is authored once, stays editable,
and every backend *renders* it in its own storage — Jira as its board's
statuses, GitHub as `status: …` labels, folder as the status text in its
markdown, app-storage as the project record's stages. It is not a constant in
any one backend, and `FolderService` no longer declares one.

- **A stage carries a category.** `ProjectWorkflowStage` is
  `{ id, name, category: 'todo' | 'indeterminate' | 'done' }`. The category is
  load-bearing, not decoration: plan documents are prose ("✅ Complete",
  "🚧 In progress", "📋 Proposed") and you cannot fuzzy-infer "Architecture"
  from "Proposed". Resolving *through the category* is what lets freeform text
  land somewhere sensible on a workflow whose stages are named nothing like the
  default five.
- **`resolveStatus(raw, workflow)` (`projects/projectWorkflow.ts`) is the only
  status mapper.** Four tiers: exact stage name → the synonym's preferred name →
  the first stage of the synonym's category → the first stage. The preferred
  name matters — "blocked" must reach `Blocked`, not merely the first in-flight
  stage. `mapMarkdownStatusToPlanStatus` remains only as a deprecated alias for
  `resolveStatus(raw, DEFAULT_WORKFLOW)`.
- **`DEFAULT_WORKFLOW` is the compatibility contract.** It is exactly the five
  statuses folder boards always had, in the same order with the same
  categories. Anything with no declared workflow must stay byte-identical, and
  the gate for that is `folder.spec.ts` + `folderMulti.spec.ts` +
  `editIssue.spec.ts` + `newIssue.spec.ts` holding at **13 passed**.
- **A folder board's workflow lives in `board.praxis.json`** — that file exists
  so a board's identity travels with its folder, and a workflow is board
  identity. An invalid or malformed one is *ignored*, never fatal.
- **Read the board config before parsing.** `loadFromDisk` identifies the plans
  root, reads `board.praxis.json`, *then* parses. Parsing first resolves every
  status against the default five, so a document naming a declared stage
  silently lands in the first column — a bug that passes every unit test.
- **Never rebuild a stage as `{ id, name }`.** Dropping `category` is silent:
  the record still loads, `normalizeWorkflowStages` infers by position, and the
  workflow is subtly wrong. Two shipped code paths did exactly this
  (`projectManager.create` and the wizard's stage state).
- **`PROJECT.md` is generated, but Praxis rewrites only a file it wrote.**
  A new file gets a `praxis:begin`/`praxis:end` block; a marked file has only
  that block replaced; **a marker-less file is left completely alone.** It
  renders the *effective* workflow, so a generated file cannot advertise a
  column the board does not have.

  The last rule is not caution for its own sake. `writeProjectSnapshot` used to
  open with the `wx` flag — crude, but "never touch an existing file" was a
  real safety property. The first version of FX-BE-047 replaced it with an
  "adopt a marker-less file by rewriting the sections we recognise" path, and
  the very next full e2e run overwrote **this repository's own PROJECT.md**
  with a fixture project's two-stage workflow and an empty purpose.
  `projectSnapshot.test.ts` (in the main workspace's `test:git` run) now holds
  the line with a case built from this repo's actual file shape.

## Repo skills are edited in `.agents/skills` only

`.github/skills` (Copilot) and `.claude/skills` (Claude Code) are generated copies.
Edit `.agents/skills`, then run `npm run skills:sync`; CI runs `npm run test:skills`
and fails on drift. Copies, not symlinks, so Windows checkouts work.

## Build and test

Root scripts are prefixed by the surface they act on. `build` and `test` with no
prefix run **everything**, in dependency order.

```bash
npm run build          # core -> renderer -> copy-renderer -> desktop
npm run test           # test:core, test:desktop
npm run check-types    # every workspace

# or one surface at a time
npm run build:core     # must precede the others: they consume its emitted types
npm run build:renderer
npm run desktop:copy-renderer   # REQUIRED before e2e
npm run build:desktop

npm run test:core             # node:test
npm run test:desktop          # Playwright e2e
npm run test:desktop:git      # gitService unit tests
```

**The e2e suite loads the pre-built renderer** from `apps/praxis-desktop/main/renderer/`, not
a dev server. A frontend change is invisible to e2e until you rebuild **and** run
`copy-renderer`.

**No test may point a Praxis write path at the working tree.** `journey.spec.ts`
deliberately runs the "adopt a folder of real plans" journey against the Praxis
Desktop app's own planning content (`apps/praxis-desktop/docs/plans`,
`apps/praxis-desktop/project.praxis.md`, `apps/praxis-desktop/board.praxis.json`)
— that is what makes it worth having, because the data is genuine rather than a
hand-built fixture. It now runs against a **temp copy** of those three, and a
`beforeAll`/`afterAll` fingerprint over those files fails the spec if anything
writes into the real tree.

The guarded set is **derived from the naming rule**, not listed: every
root-level `*.praxis.*` file (the workspace file) plus every `*.praxis.*` file
under `apps/praxis-desktop` plus `apps/praxis-desktop/docs/plans`. A Praxis file
added later is covered without anyone remembering to extend the guard — which
matters, because the list had already gone stale once when the workspace file
was renamed.

This is not hypothetical. Two Praxis write paths fire automatically on any
folder a project points at:

- `FolderService.loadFromDisk` runs a **template-upgrade pass**
  (`ensureFrontMatter`) that rewrites plan markdown — injecting `**Status:**`,
  `**Created:** <now>`, `**Type:**`, `**Priority:**` and appending
  `## Description` / `## Comments`. Every plan doc in this repo carries that
  front matter because a test run put it there; the `**Created:**` timestamps
  in the newer files are the moment a suite ran, not the moment anyone wrote
  them. It is idempotent once applied, so a *new* plan doc is the one that gets
  rewritten.
- `writeProjectSnapshot` regenerates `PROJECT.md` — and before the marker rule
  it overwrote this repo's own file with a fixture project's workflow.

**`vite build` needs a native binding, and the lockfile must carry every CI platform's.**
Vite 8 bundles with `rolldown` and minifies CSS with `lightningcss` — both load a
platform-specific `.node`. `npm` regenerating `package-lock.json` on macOS prunes the
non-host platform bindings of *transitive* optional deps (npm/cli#4828), so `npm ci` on
the Linux runner then has nothing to load and the build dies with `Cannot find native
binding` — long after `tsc` and the tests have all passed locally. The bindings are
pinned as root `optionalDependencies` (see the `//optionalDependencies` note in
`package.json`) so the lockfile stays platform-complete; keep those versions matched to
the resolved `rolldown` / `lightningcss` when either bumps.

## Testing expectations for agents

**Testing is mandatory, not optional.** This is a visual application with real UI regressions that pass all assertions. An agent must:

- **Run the e2e suite against any UI change** (`npm run test:desktop`). A green suite does not mean it looks right (see "Verifying a UI change" in `apps/praxis-desktop/renderer/AGENTS.md`).
- **Visually inspect the app** after implementing a feature. Launch it (`npm run start` or equivalent), navigate to the changed surface, and interact with it end-to-end before reporting success.
- **Update snapshots deliberately.** Never assume a snapshot update is safe. Open the `-actual.png` and diff, read what changed, and confirm it is the fix (not a regression) before accepting it.
- **Never say "I can't test"** when the suite is runnable and the app is launchable. If you encounter a blocker, investigate and fix it rather than declaring testing impossible.
- **Document what you tested.** Report which e2e tests passed, which snapshots were updated, and which manual interactions verified the feature works. A session ending with "build succeeded" is not done — include verification in the completion.

No test *guarantees* correctness (a regression can still paint), but tests + screenshots catch real bugs. Use both.
