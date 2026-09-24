# AGENTS.md

Guidance for AI coding agents working in this repository. This is the single
source; `CLAUDE.md` points here.

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

---

# Praxis desktop app (`apps/praxis-desktop/renderer` + `apps/praxis-desktop/main`)

Plain React in a normal DOM.

All confirmations, alerts, prompts, and destructive-action warnings must use
themed in-app UI. Never use native OS/browser dialogs such as `window.confirm`,
`window.alert`, or `window.prompt`; they do not match the Praxis visual system.

Do not put board or entity identity icons inside decorative bordered or filled
tiles solely to sit beside a title. Render identity icons directly on the themed
surface; reserve bordered icon containers for interactive controls or meaningful
status indicators.

`renderer/src` is grouped by feature. Put a new file in the folder that owns its
screen; only genuinely cross-cutting primitives belong in `ui/`.

```
renderer/src/
├── app/            shell: App, Sidebar, TitleBar, BottomPanel, splash
├── projects/       project home, workspace, wizard, work mode
├── board/          board view, filter bar, board preferences
├── issues/         issue detail, new issue, peek, analysis
├── git/            graph, diff workspace, conflict workspace
├── ai/             sessions, model manager, review pages, workflow picker
├── settings/       SettingsPage, themes, surfacePacks, surfacePatterns
├── taskDesigner/   task designer page, sidebar, state
├── connections/    connection + board setup
├── ui/             shared primitives (Icon, Markdown, form controls)
├── assets/         images and generated texture tiles
├── main.tsx        vite entry — stays at the root
└── theme.css, surfaces.css
```

## Theming

Four independent attribute axes on `<html>`, all composing:

| Attribute | Meaning |
| --- | --- |
| `data-mode` | `light` / `dark` — the surface + text ramp |
| `data-accent` | the single accent hue |
| `data-theme` | a complete named palette (`praxis-dark`, `github-light`, …) |
| `data-surface` | the **material** layer (`flat`, `parchment`, `graphite`, …) |

**Components only ever read tokens** (`--bg`, `--text`, `--accent`, `--border`, …). A
theme redefines those tokens per `[data-theme]` / `[data-mode]` block; never hard-code a
colour in a component.

A **surface pack sets only `--surface-*` properties** — never a colour token. That is
exactly what lets any pack compose with any palette.

## Surface packs and motifs

- **Patterns are data, not CSS.** `surfacePatterns.ts` holds the tile library; a pack
  references one by id and `applySurfacePack` renders it into `--surface-watermark-*`.
  Adding a material means **adding a library entry — never a new `[data-surface]`
  block**, and never a change to the panes.
- **Texture tiles are generated, not hand-authored.** Run
  `npm run textures --workspace=@praxis/desktop-renderer` (renders through Electron's
  own Chromium into `src/assets/surfaces/`). Do not hand-edit the `.webp` files.
- **A pattern's colour is baked into an SVG `data:` URI**, so it cannot follow a `var()`.
  It must be re-baked whenever the palette changes — see `refreshSurfacePattern`, wired
  to the `tm-theme-changed` event.
- **Grain and motif layers sit BEHIND pane content** (`::before` / `::after` at
  `z-index: 0`, with the panes' direct children lifted to `z-index: 1`). That is what
  lets a material be strong without ever eroding text contrast. Keep it that way.
- A motif's declared strength is **perceptually normalised** against how far its ink sits
  from the panel, so one value reads the same on every palette. Tune the declared value,
  not the correction.
- `flat` must stay a **byte-for-byte no-op** — every `--surface-*` token is declared inert
  on `:root`, so an unset surface costs nothing.
- **Every overlay shell — modal, wizard, command palette — carries the material, not just
  the three panes.** `.modal-card`, `.workspace-dialog`, `.command-palette`,
  `.project-dialog-shell`, and `.project-wizard-header`/`.project-wizard-footer` all fill
  with `color-mix(in srgb, <base> calc(var(--surface-panel-opacity) * 100%), transparent)`
  + `background-image: var(--surface-panel-tint-layer)`, take `box-shadow:
  var(--surface-accent-glow), <literal elevation shadow>`, add `backdrop-filter:
  var(--surface-backdrop)`, and boost their `border-radius` by `var(--surface-radius-boost)`.
  Inert defaults make this a no-op under `flat`. A new dialog/wizard/popover shell must follow
  the same recipe — otherwise it reads as a flat, untextured box floating over panes that all
  carry the active pack (parchment grain, aurora glass frost, noir vignette, …). Don't touch
  the shell's border *colour* or its literal elevation shadow — swapping those to
  `--surface-panel-border-color` shifted the default look and isn't required for theming.

## The centre pane is an inset card

`.pane-main` floats: `--pane-main-inset` (4px, on `:root` in `theme.css`) of margin on every side, a full
border, and all four corners rounded. The sidebar and the right pane are still docked flush and top-rounded,
so the right pane's top edge sits that much above the card's. Change the gap in the token, not on the rule.
`e2e/paneInset.spec.ts` measures it. Because the card is smaller by twice the inset in each direction, any
`toHaveScreenshot` of the pane (or the whole page) moves with it — resize failures of exactly `2 × inset` are
this, not a layout bug; open the `-actual.png` before re-baselining.

## Renderer CSP

`apps/praxis-desktop/renderer/index.html` carries the CSP, and it **must** keep `img-src 'self' data:`.
The surface pattern and grain layers are inline SVG / data tiles; without that directive
they compute correctly but silently never paint — a failure that looks like a styling bug
and is genuinely hard to trace. An e2e test decodes a live tile through `Image()` to catch
a regression loudly.

## Keyboard focus

`theme.css` ends with a single global `:focus-visible` ring, last in the file so it wins on
source order against component `:focus` rules that only tint a border. **Do not add a bare
`outline: none`.** A component may add emphasis on focus, but anything that removes the ring
has to paint something equally visible in its place — otherwise the control simply cannot be
seen when focused, which is invisible in a screenshot and only hurts the people driving the
app from the keyboard. This eroded once already (26 outline resets against 15 `:focus-visible`
rules, while `:hover` was styled 91 times); `e2e/keyboardFocus.spec.ts` now tabs through the
shell and fails loudly if any control paints nothing.

## Icon-only buttons get a tooltip

A control with no visible text shows its accessible name as a tooltip: `ui/iconButtonTooltips.ts`
(installed in `main.tsx`) copies `aria-label` into `title` the first time the pointer or focus reaches
it, never overwriting a `title` you set. So an icon-only button needs an `aria-label` that says what it
does — that one string is both what a screen reader announces and what everyone else sees on hover.
`e2e/iconButtonTooltips.spec.ts` walks the main screens (every Settings page included) and fails, naming
the element, on any visible icon-only control with no `title` and no accessible name.

## Drop-downs and control sizing

There is no native `<select>` in the renderer — like `window.confirm`, it ignores the theme and surface
pack. Use `ui/ChipSelect.tsx` (the session composer's chip + `.composer-provider-menu` list, with a filter
row once a list is long): `block` for a form field, `variant="plain"` in a toolbar. Things it already
handles and a new picker would have to rediscover: the menu is portalled with `z-index: 1100` so it clears
Settings/modals; a chip inside a `<label>` calls `preventDefault` or the label's re-dispatched click toggles
it shut; it follows its chip on scroll rather than closing (smooth-scrolling panes and Playwright's
scroll-into-view fire scroll events after the click); and its events stop at the menu so a row that selects
on click, or a popover that closes on outside mousedown, does not also react. e2e specs drive it with
`e2e/chipSelect.ts` (`chooseOption`, `chipOptionValues`) and assert with `toHaveAttribute('data-value', …)`.

Control heights come from `--field-chip-height` / `--tool-btn-size` (and `<Icon>` glyphs from `--icon-size`),
all multiplied by `--ui-scale`, so the Large display size grows the whole control, not just its text.
Compact is scale 1 and pixel-identical. Size a new control from these tokens, not a bare `px`.

## Dialogs

There is no `window.confirm` / `window.prompt` in the renderer. They are OS-modal,
unstyleable, ignore the app's themes, and block the renderer — and two of the prompts
collected real data with no validation. Use `useDialogs()` from `ui/dialogs.tsx` instead:
`await confirm({ title, message?, danger? })` and `await prompt({ title, label, validate? })`
render inside the app's own modal surface and return a promise, so a call site still reads
`if (!(await confirm(...))) return;`. `<DialogHost>` wraps `<App/>` in `main.tsx`. An e2e test
that used to accept a native dialog with `page.on('dialog', …)` now clicks the button in the
in-app dialog by its `confirmLabel`.

`.modal-card` (and everything built on it — `app-dialog`, `whats-new-card`,
`import-projects-card`) carries the active surface pack's material; see
"Surface packs and motifs" for the recipe before adding a new overlay shell.

## Command palette

`⌘K` opens `app/CommandPalette.tsx` over a flat index built in `App` (`paletteEntries`) from
the collections the shell already holds — projects, boards, sessions, agents, skills,
workflows, feature destinations, settings pages. It is navigation only; each entry's `run`
reuses the same `navigate()` / `setSettingsDialogCategory()` the sidebar uses. Add a new
navigable surface → add an entry to that `useMemo`.

## Sidebar tree indentation (`theme.css`, `app/Sidebar.tsx`)

The sidebar has grown several independent trees (a project's own tree, the
external Boards list, the Agent Hub nav under "Agents") the same way, one row
class at a time, over several sessions — and `padding-left` on a new row class
was routinely just eyeballed. It drifted three separate times before anyone
noticed: Repository's `Graph` (32px) vs `Changes` (34px), a workflow's own row
(32px) vs its `Runs` row (34px), and the Agent Hub's scope label (30px) vs its
agent rows (32px). Separately, `Run` and `Deployments` had no `padding-left`
rule at all and fell back to `.tree-row`'s flush-left default, so they read as
top-level items instead of children of the project tree.

**The fix is four CSS custom properties, `--tree-indent-1` through
`--tree-indent-4`** (defined once, right above `.sidebar-scroll` in
`theme.css`, with the full rationale in the comment there). Every row in
every sidebar tree sets its `padding-left` to one of these four — never a
bare pixel value:

- `--tree-indent-1` (18px) — a direct child of the tree's root: a collapsible
  subsection header (`Boards`, `Repository`, `Workflows`, `Docs`) or the Agent Hub
  row itself **and** a flat leaf row with no
  children of its own, so it never grows a header (`Run`, `Deployments`).
  Both are the same depth — a childless leaf sits where a header would.
- `--tree-indent-2` (30px) — one level inside a `--tree-indent-1` subsection: a
  board, `Graph`/`Changes`, a workflow and its own `Runs` row, an Agent Hub
  Agents / Skills sub-header, a project's `docs > plans` folder header. This value is not
  arbitrary: `.project-tree-children > .tree-row::before`'s connector dash is
  fixed at `left: 17px; width: 13px`, ending at 30px, so a row's icon starts
  exactly where the dash stops — no gap, no overlap. Moving the dash's
  position later means moving this token to match, not the other way round.
- `--tree-indent-3` (42px) — a document-type group header one level inside
  `docs > plans` (`.project-document-group-toggle`, e.g. "STORY"); a workflow
  **run node** one level inside the `Runs` group (`.project-run-row`, whose
  header sits at `--tree-indent-2` beside its workflow rows); and a **session
  nested beneath the session that spawned it** in the Sessions tree
  (`.session-nav-row--child`); an Agent Hub **agent or skill row** (`.agent-nav-row`).
- `--tree-indent-4` (48px) — a document itself, one level inside a
  `--tree-indent-3` group (`.project-document-row`).

  **The Agent Hub row's children are Agents and Skills, not scopes.** The root is labelled **Agent Hub**
  (feature id `agents`, `nav-agents`); under it are two collapsible kinds, and where an item comes from is
  row metadata rather than a level: a project's own items (scope `project`) sort first and carry a folder
  icon (`agent-nav-project-tag`), everything else is untagged. There is deliberately no "Global" label — it
  meant "installed for you, all projects", which is the default and needs no name. The tag is an icon, not
  a word: a text chip beside an "approval" badge squeezed the name to `pr…` in the 260px sidebar.

Icons follow the same tokens, but by **role**, not by depth — an
`--tree-indent-2`/`-3` row can be a leaf (`Graph`, a board, a document) or
another collapsible header (`docs > plans`, a document-type group), and the
two size differently: a leaf's icon (`.tree-icon`, no reserved box) is 14px at
any depth, since a leaf never implies a level under it and so never steps
down. A header's icon (`.tree-section-icon`, boxed to 18px regardless of the
glyph) steps down 1px per nesting level instead — 13px at `--tree-indent-1`,
12px at `--tree-indent-2`, 10px at `--tree-indent-3` — so a deeper group still
visibly reads as subordinate.

**The alignment is measured, not eyeballed.** `e2e/sidebarTreeAlignment.spec.ts` seeds a project with a
workflow and runs, then asserts that rows at one depth share an icon column and a label column, that every
icon sits `.tree-row`'s 6px from its label, and that deeper levels step in. It exists because two rows had
drifted unnoticed: the project's **Run** (services) row borrowed `.project-run-row` — the class for a
workflow run *node*, `--tree-indent-3` — and sat 12px too deep (it now has `.project-service-run-row`,
`--tree-indent-1`, like Deployments); and the workflow rows and the `Runs` header put their icon and label
inside a `.board-tree-main` button, which lacks `.tree-row`'s gap, so the icon touched the text (they now set
`gap: 6px`). **Reusing a row class for a different kind of row inherits its indent** — give a new kind of
row its own class.

**Adding a new row to any sidebar tree**: decide which of the four depths it
actually sits at (a header/leaf-with-no-children, or something nested one,
two, or three levels inside one), set `padding-left` to the matching token,
and size its icon by role as above. If a genuinely new fifth depth is needed,
give it its own named token the same way rather than a bare number — the
whole point is that no row's indent is ever a number typed at the call site.

## Workflow runs: tree nodes and the run workspace

There is **no Runs page**. A project's runs are child nodes under `Workflows > Runs`
in the sidebar (`Sidebar.tsx`; the list is `runsByProjectId`, lifted into `App` so the
command palette shares it). A node carries hover-revealed **cancel** (live runs only)
and **delete**; `+` on the group and a workflow row's play button open
`workflows/StartRunDialog.tsx`. Opening a node routes to
`workflows` / `workflowView: 'runs'` / `workflowRunId` and renders
`workflows/WorkflowRunPage.tsx`:

- **Centre** — the session doing the work: the running stage's, else the last stage
  that has one (so a run waiting on a person still shows the conversation behind it).
  It is `App`'s own `renderSessionsPage(sessionKey)`, the same console the Sessions
  route uses — do not fork `SessionsPage` for it. A stage with no session (check,
  approval, deployment, or not started) shows a short explanation instead.
  Picking a step in the pipeline pins it; "Follow live" un-pins.
- **Right pane** — `WorkflowPipelineVertical` (steps top to bottom, parallel steps
  bracketed), then status/controls, the selected stage's findings and evidence, gates,
  timeline, and the stage session's inspector under "Session details". It portals into
  `auxSlot` like the designer does. Step buttons keep the `Name (type): lane`
  `aria-label` the specs select by.

**Deleting a run** (`workflows:deleteRun`) cancels it first if it is live, then removes
the run, its stage sessions (`stageSessionKey`), and its entry in the controller's
`workflowRunIds`. It shares `deleteAgentSession` with `ai:deleteSession` — do not
re-implement session teardown. `removeControllerRun` only *detaches* a run from a
session; it is not delete.

**Run permission mode.** `WorkflowRun.permissionMode` (`'ask'` default | `'auto'`) is chosen
in the start-run dialog and **fixed for the life of the run**. `auto` makes each stage
session start with `allowPermissionsForTask` on (`autoApprovePermissions` through
`launchAgentTask` to both hosts) and is recorded on the session record so follow-up turns
keep it. It sits *behind* the tool-access checks — a read-only/project-only stage is still
denied writes and commands first — and it never touches the human approval gate, which
needs a person in either mode. Anything other than an explicit `'auto'` is treated as ask.

**A stage that could not judge is paused, not failed.** An attempt can stop for a reason that
says nothing about the work: `WorkflowNodeAttempt.pause` is `'provider-limit'` (the AI account
ran out of credit/quota — see `isProviderLimitError`) or `'environment'` (the stage's tooling
could not run). A paused stage keeps the run open and its worktree, does not spend
`maxAttempts` (`attemptsSpent`), takes none of its failure/always edges, leaves its gate
`pending` rather than `failed`, and is resumed with Retry. `classifyCheckEnvironmentFailure`
(core, used by `workflowCheckRunner`) decides `environment`, and it is **deliberately narrow**:
only a missing command, or a package manager doing *registry work* (audit/install/ci/view/…)
with a specific registry/network/auth/TLS signature. `npm test`, `npm run …` and every other
command run user code and are never second-guessed — a false "environment" hides a real failure
behind a pause, which is worse than a false failure. Add a signature with a fixture of real
output and a negative case in `checkEnvironmentFailure.test.ts`. (Real example: `npm audit`
against a default registry with no audit endpoint, e.g. GitHub Packages, exits 1 having checked
nothing; the Governed delivery template now audits against `registry.npmjs.org` for that reason.)

**A person can always retry a failed stage; `maxAttempts` only bounds the run continuing alone.**
`retryNode` no longer checks the attempt budget, and a `node-retry` on a **failed** run reopens it
(the one command besides `gate-decided`/`node-stopped` a settled run accepts; a `cancelled` run stays
cancelled). Siblings the orchestrator stopped when the run failed (`cancelled`) go back to `pending`
with it. `canRetry` is still what `settleRunIfDone` uses to decide whether the run keeps going by
itself, so it still fails a run whose budget is spent — it just no longer makes that final. Reopening
re-acquires the worktree, and a released worktree's branch still exists, so
`prepareDeliveryWorktree` **re-attaches an existing `WF-<run8>-<slug>` branch** (with its commits, and
without the clean-base check, which only applies when creating the branch) instead of
`worktree add -b`, which fails on the name. The pipeline's retry icon is a *sibling* of the step
button (a button cannot nest in a button), shown for any step with a `retry-stage` action.

**A stage names a model tier, not a model.** `WorkflowAgentTaskNode.modelTier` (`fast`/`standard`/
`strong`), optional `model` (exact id, wins), `escalateOnRetry` (default on). `ai.modelTiers[provider]`
in settings maps tiers to ids because ids are provider-specific — there is no honest universal
ranking, so never hard-code one. It is edited **in the provider's own row** (Settings → AI Provider →
Providers → open a provider → Model tiers, `ProviderModelTiers`) as a pick from that provider's fetched
models — never free text where a list exists, since a mistyped id fails the launch — and from the
other side in Manage models, where each model row's tier select writes the same map (a tier holds one
model, so a model holds at most one tier). `chooseStageModel` (core, `stageModel.ts`) is the only resolver:
exact model → mapped tier → run model → provider default; **an unmapped tier falls back to the run's
model rather than guessing an id** (a wrong id fails the launch). Each failed attempt after the first
moves one tier up; attempts that paused (provider limit / environment) never spent the stage and never
escalate. `instantiateTemplateForProject` gives every unset agent stage a default tier, so mapping the
tiers takes effect without editing stages; unmapped, nothing changes. "Suggest model tiers" in the
designer (`workflows:recommendModelTiers`, sibling of the template recommender) only fills the *unsaved
draft* for stages with no choice yet. **`normalizeWorkflow` (`workflowValidation.ts`) whitelists node
fields** — a new node field that is not copied there is silently dropped on save and the feature does
nothing; that is exactly how `modelTier` first failed, and only an e2e that saved and ran the workflow
showed it. Add the field to the sanitizer and to its round-trip test.

**A stage starts from what earlier stages concluded.** A report artifact has no file — its text only
ever lived on the producing stage's session — so a downstream stage used to be told a report existed
and could not read it. `runWorkflowAgentStage` now appends `formatUpstreamReports` (core, capped at
6000 chars per report, head and tail kept, the cap announced) to the stage's scope, read from the
producing session's `responseText`. Artifacts with a path are still referenced by path.

**A run's worktree starts with no dependencies, so the template installs them.** `node_modules` is
gitignored, so a fresh worktree has none; tools only appear to work when something up the tree
supplies them (the parent checkout's root `node_modules`), and a workspace package with its own
nested dependencies fails with `Cannot find module` — which is how QA failed FX-BF-036 with every
real test green. The Governed delivery and Full SDLC (node) templates therefore have an `Install
dependencies` stage (`installDependenciesNode`) that runs `npm ci` after Implement; only the stages
that need `node_modules` wait for it. Two decisions worth not undoing: it **installs** rather than
symlinking the main checkout's `node_modules` (a link is shared mutable state — an agent's
`npm install` would write into the user's real checkout — and goes stale when a stage changes the
lockfile), and it passes **`--registry=https://registry.npmjs.org/`** (with a private default
registry npm rewrites the lockfile's `registry.npmjs.org` tarball URLs to it and every public
package 404s on a cold cache — verify with `npm ci --cache=<empty dir>`, since a warm cache hides
it). `workflowInstallDeps.spec.ts` proves both halves on a real repository with a local tarball.
Praxis also relies on the desktop package's `postinstall` hook: node-pty 1.1.0's macOS prebuild
ships `spawn-helper` without an executable bit, so a cold `npm ci` otherwise lets Electron load
the addon but every terminal creation fails with `posix_spawnp failed`. Keep
`scripts/fixNodePtyPermissions.cjs` wired into `postinstall`; `--ignore-scripts` is not a valid
way to prepare a worktree that will run the desktop E2E suite.
The same goes for **build output**: `dist/`, `out/` and a copied renderer are gitignored too, so a `Build`
stage (`npm run build --if-present`, optional log) runs before QA. Without it an Electron/Playwright
suite that loads a pre-built renderer opens a **blank window** in the run worktree (the FX-BF-036 QA
symptom) — nothing about the failure says "build". `--if-present` keeps it a silent no-op for projects
with no build script, which is why its log is `required: false` (a required log with no output fails the
stage for having nothing to say). `workflowBuildStage.spec.ts` covers it, including the no-script case.
The root `npm run build` compiles `@praxis/mobile-protocol` before desktop main; main imports its types,
so omitting that workspace makes a genuinely cold Build depend on output left by an earlier command.

**A finished run leaves nothing running.** When a required stage fails the run, the orchestrator
stops every sibling still in flight and records it `cancelled` (`stopInFlight`, the post-settle
`node-stopped` command — the only command besides `gate-decided` a settled run absorbs). Recovery
repairs older records that still show stages `running` in a finished run. Do not let results fall
on a settled run and vanish.

**A run's work is its branch, and deleting the run does not decide its fate.** A governed run's
output is commits on `WF-<run8>-<slug>` (found by its `WF-<run8>` prefix — `runWork.ts`),
checked out in a worktree while the run is live. Three rules, each pinned by a test:
- **Releasing a worktree never deletes the branch** (`removeDeliveryWorktree(…, { keepBranch: true })`).
  The old release passed `WF-<run8>` to `git branch -D`, which only failed to match the real
  `WF-<run8>-<slug>` name by luck — one naming change from deleting a finished run's delivered work.
- **Uncommitted changes are kept, not discarded.** `git worktree remove --force` throws them away, so
  `release` first commits them to the branch (`preserveUncommittedWork`); if that fails, release throws
  and the worktree is left in place.
- **Deleting a run asks.** `workflows:inspectRunWork` reports the branch, the commits that exist on *no
  other* branch (`--not --exclude=<bare name> --branches --remotes` — give `--exclude` the bare branch
  name, not `refs/heads/…`, or it silently excludes nothing and reports 0 at risk), and uncommitted
  files. `useDeleteRun` (shared by the sidebar node and the run panel) shows them and offers an
  **unchecked** "Also delete branch" option; only `deleteRun(runId, { deleteWork: true })` removes
  the worktree and branch, and never a branch checked out in the main working tree.

**Session hierarchy.** `AgentSessionRecord.parentSessionKey` is the session that spawned
this one. It is set when a stage session is created (from `run.controllerSessionKey`)
and back-filled for older records in `recoverWorkflowRunsOnStartup`. `SessionsNav`
nests children under a parent that is in the list; a child whose parent is missing
(archived, other workspace) stays a top-level row rather than vanishing. Archiving or
deleting a parent cascades to its children (delete asks first). A run started with no
controller has no parent, so its stage sessions are top-level rows in Sessions — but two or
more from the same run gather under one run header (`SessionsNav`'s `rootItems`, labelled from
the run's workflow name via `runNames`; a lone one stays a plain row). The header is not a
session: it cannot be selected or renamed and never becomes a `parentSessionKey`. It does carry **archive
and delete** (`session-run-archive-btn` / `session-run-delete-btn`) that act on the whole group exactly as
they do on a parent session — every stage session under it, children before their stage, deleting asks
first and names the count. The *run itself* is untouched (it stays under Workflows → Runs; deleting the
run is `workflows:deleteRun`), and archived sessions are restored one by one from the Sessions tab.

**What a stage hands on, and how a run ends.**

- **Agent stages deliver `findings` from their reply.** `stageOutcomeFromSession` reads the last fenced
  ```json block holding a `findings` array (`parseReviewFindings`), and the brief tells the stage that
  format (`FINDINGS_BLOCK_INSTRUCTIONS`). Before this, no agent stage could satisfy a required `findings`
  output, so every agent review stage in the Full SDLC templates failed.
- **Check logs travel inline.** A check's log lives in the evidence store, outside the worktree that
  gateway agents' file tools are sandboxed to (`resolveSandboxedPath`), so `workflowAgentStage` inlines
  `log` inputs (`formatUpstreamLogs`) the same way reports are inlined (`formatUpstreamReports`, 24k cap).
  A report past that cap is also written whole to `<worktree>/.praxis-run/<contract>.md` and the brief
  names it, but **only for a read-only, non-mutating stage** (it could otherwise be committed by a
  freeze); the folder is removed when the session ends. Real review reports run to ~70k characters.
- **`publishTo: 'board'` on a `plan` output** creates the plan on the run's project board: the stage ends
  with a `praxis-plan` block (`workflowPlanPublishing.ts`), and the app creates a feature plus items via the
  project connection's `createIssue` (real plan markdown for a folder-backed project) and records the
  feature key on `WorkflowArtifactRef.reference`.
  `CreateIssueInput.priority` / `severity` / `sections` carry P0–P3 (as Highest…Low), severity and a
  Bug's steps/expected/actual into the folder template; other boards ignore them. Leave template
  sections present: `FolderService`'s upgrade pass re-adds any missing one on every load.
- **`optional: true` on an approval** offers **Skip** (`skipApproval`), which skips everything after it.
  It is opt-in so that a delivery sign-off can never be skipped.
- **`advanceJoins` also settles branches that can no longer run** (the scheduler's `skip` list), except
  those closed by a *failure*, which a person can still retry. Without this, an untaken branch kept a
  finished run at `running` forever.
- **`normalizeWorkflowRun` keeps node `findings`.** It used to drop them on reload, so a run read back
  from disk showed no findings and passed every severity threshold.
- **`normalizeWorkflow` copies fields one by one.** Every save/load runs through it, so a node field it
  does not copy is silently deleted on the first save. Approval `gateThresholds`/`waivers` and a check's
  `adapter`/`reportPath`/`observe` were missing, which stripped every Full SDLC security threshold and
  SARIF parse. Add any new node field there; `workflowPlanPublishing.test.ts` round-trips the shipped
  templates to catch this.

## Onboarding and the walkthrough

First run is: Getting Started's "Create your first project" (a default workspace is created
behind the scenes) → a three-panel wizard → the project dashboard, which carries a Get
Started strip while the project has no sessions. `praxis-onboarded` marks the profile past
Getting Started and shortens the splash; `praxis-walkthrough-seen` marks the tour done.

`app/Walkthrough.tsx` is a short, non-blocking tour that rings controls the shell already
renders — it annotates the user's real project rather than seeding a demo one. Stops are
declared in `App` (`walkthroughStops`) as CSS selectors over existing `data-testid`s; a stop
whose target is absent is skipped, not shown empty. Two invariants, both covered by
`e2e/walkthrough.spec.ts`: **the ring never takes pointer events** (the highlighted control
stays clickable), and **the ring must enclose the control the callout describes** — do not
add a CSS transition to the ring's geometry, which left it lagging a stop behind.

The ring is `3px dashed var(--tone-tour)`, a magenta used nowhere else in the chrome. Do not
put it back on the accent: that was a fourth meaning for a token already carrying brand and
primary action, it was indistinguishable from the `2px solid var(--focus-ring)` keyboard
ring, and it vanished when it landed on an accent button. An annotation must not look like a
control — the dashed style and the off-palette hue are both asserted.

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

## AI provider settings (`SettingsPage.tsx` → `AiSection`)

Settings → AI Provider is four tabs — **Providers · Defaults · Spend · Tools** — and each
provider is **one row**: name, status, "Make default", and an on/off switch, with its
connection details (key, URL, model, CLI path, models) opening under the selected row.
Add a provider by adding to `AI_PROVIDERS`; add a setting to the tab it belongs to rather
than the top of the page.

`ai.providers[id].enabled` is stored only when set; **undefined means enabled**. A provider
is *usable* only when it is also `configured` (key present / CLI found), so leaving it unset
changes nothing for an existing setup, and only an explicit `false` turns one off. Every
picker applies the same rule through `ai/providerAvailability.ts`'s `isProviderUsable`
(`AiProviderStatus.configured && .enabled`) — do not filter on `configured` alone in a new
picker. The default provider's switch is locked on (choose another default first), and an
unconfigured provider's switch is disabled with the reason in its tooltip. Main enforces it
too: `ai:delegate` refuses a provider that is turned off, and the recommendation-provider
resolver skips it. Turning a provider off never touches its stored key or config, and
sessions already running on it are unaffected.

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

## Add-on marketplace (`packages/core/src/marketplace/`, FX-BF-018)

Installs **themes, surface packs, agents, and workflow templates** from a
**GitHub Packages** npm registry the user configures. Not connection modes —
those are code (see above), never catalogue data.

- **Two endpoints, one transport.** Discovery is the GitHub REST API
  (`GET /users|orgs/<owner>/packages?package_type=npm`, Link-paginated,
  name-prefix filtered). Version metadata and tarballs come from
  `npm.pkg.github.com` (a standard packument). A bearer token is required for
  **both**, even for public packages — 401/403 carry a `read:packages` hint.
- **The core module has no host dependencies.** No `fs`, no Electron — disk
  work goes through the `AddonStorage` port (`ElectronAddonStorage` writes
  `userData/addons/<kind>/<id>/`). It unit-tests with a fake fetch + in-memory
  storage.
- **A tarball is verified before it is unpacked.** `assertTarballIntegrity`
  checks the registry's SRI (`sha512`/`384`/`256`) or hex `shasum`; a version
  the registry published **no** hash for is refused, not waved through.
- **Config is central; browsing is per-kind.** Settings → **Add-ons** holds
  only the marketplace *config* (owner, token, endpoints, enable). Each kind's
  own panel — Themes, Surfaces, Agent Runtime — carries its own marketplace
  section that browses and installs *that kind*, so a user installs a theme
  where they pick themes. `useKindAddons(kind)` (`settings/marketplaceAddons.ts`)
  wraps `window.praxis.marketplace.*` and filters catalogue/installed to one
  kind. Do **not** add a cross-kind catalogue back to the Add-ons panel.
- **Declarative kinds activate on install; an agent does not.** `theme`,
  `surface-pack`, `workflow-template` are config and take effect immediately.
  An `agent` add-on installs **disabled** — its payload is mirrored into
  `userData/agents/<id>` (the trusted discovery root) only once the user grants
  trust (in the Agent Runtime panel's marketplace section), and removed on
  revoke. Nothing downloaded runs code until then.
- **Manifest `display` hints make the catalogue visual.** A `theme`/`surface-pack`
  add-on's `praxis.display.preview` (+ `.mode` for themes) lets the panel render
  a real preview card *before* install — the payload isn't downloaded for the
  browse list.
- **Marketplace themes/packs are a separate bucket.** `registerMarketplaceThemes`
  / `registerMarketplaceSurfacePacks` (renderer `settings/themes.ts` +
  `surfacePacks.ts`) are distinct from `registerCustom*`, which the Themes /
  Surfaces editors call with the user's own drafts. Merging the two into one
  `registerCustom*` call means whichever runs last wins and silently drops the
  other set. `main.tsx` re-registers the marketplace buckets on every
  `marketplace:changed` and dispatches `praxis-marketplace-appearance` so an
  open panel re-reads the lists.
- **Token lives in the secret store**, key `marketplace:githubToken`, with a
  `PRAXIS_MARKETPLACE_TOKEN` env fallback — the e2e sandbox and headless CI
  have no `safeStorage` keychain (same as `github.spec.ts`).
- **`MarketplaceSettings` is mirrored** in `renderer/settingsDefaults.ts` like
  every other settings section — add the field there too or Settings drifts.
- e2e: `mockAddonRegistry.ts` serves both endpoints from one in-process server
  and builds real gzipped tarballs so the integrity path runs for real;
  `marketplace.spec.ts` drives install/remove/trust from each panel.
- **Agents never choose their AI.** A session uses the session's AI; a workflow stage
  uses its own AI if the designer set one (`agent.providerId`), else the run's
  (`stageProvider`). There is no per-agent "Runs on" and no runtime-pin add-on: an
  add-on reusing a built-in agent's id is never mirrored over it, and Praxis's retired
  pin packages are removed on launch (`removeRetiredPinAddons`).
- **Budget limits.** A stage whose AI runs out pauses (`pause: 'provider-limit'`, the
  attempt records `provider`, and is free). The run's `providerLimitPolicy` then
  decides: `ask` (default) waits for the user — Switch AI / Retry / Stop on the run
  page; `switch` moves the stage to the next usable AI (`chooseFallbackProvider` →
  `fallbackProviderForStage`, skipping `exhaustedProviders`); `stop` ends the run
  (`provider-limit-stop`) with a reason naming the AI and stage. `stage-provider-switched`
  records `run.stageProviders` and re-queues the stage, reopening a stopped run. A stage's
  exact model only applies on its own AI, the run's model only on the run's.
  **`normalizeWorkflowRun` whitelists run fields** — add new ones there or they vanish
  on save. A normal session that runs out gets `SessionLimitSwitch` in its composer
  (handover to another usable AI, or stop).
- **Working style** (`ai.workingStyle`, `DEFAULT_WORKING_STYLE`, mirrored in
  `settingsDefaults.ts`) is added to every session's system prompt on every runtime
  via `launchAgentTask`/`continueAgentTask`; `nativeSources.instructionSource` limits
  the project instruction files Praxis adds to one tool's.

## Other AI tools' agents, skills and instructions (`agentRuntime/nativeSources.ts`)

Praxis reads, in place, what other AI tools keep in the project and in the user's home:
`.claude/agents|skills` + `CLAUDE.md`, `.codex/skills` + `AGENTS.md`, `.agents/skills`,
`.github/agents|skills` + `copilot-instructions.md` + `instructions/*.instructions.md`,
`.gemini/agents` + `GEMINI.md`, `.cursor/rules/*.mdc` + `.cursorrules`. The project is the
nearest `.git` above the working folder (`settings → session → PRAXIS_AI_WORKING_DIR`; never
the app's own cwd). Desktop glue: `main/nativeSourcesInstance.ts`. The Agent Runtime panel
shows them under "From other AI tools" and on its Instructions tab.

- **Precedence (same id):** Praxis project > Praxis global (incl. "Copy to Praxis") >
  native project > native user > built-in; the losers are kept in `alsoIn`.
- **Trust:** project files are untrusted until "Allow this project"
  (`ai.nativeSources.approvedProjects`, keyed by git root); user-folder files are trusted.
- **No double-loading:** every source carries `readBy` — the runtimes that load it
  themselves. `createBinding` marks such a skill `native` (instructions not injected), and
  `buildSessionInstructions` skips instruction files the session's runtime reads natively
  (`effectiveRuntime`: a custom ACP command counts as reading nothing). User-level
  instruction files are never injected; path-scoped rules are shown only; one session gets
  at most `MAX_INSTRUCTION_CHARS`.
- Native agents get a synthetic `followsSessionRuntime` host so they launch on whatever
  runtime the session uses and appear in the workflow designer palette.
- **Tests:** `launchTestApp` points `PRAXIS_NATIVE_SOURCES_HOME` at the test's user-data
  dir, so a developer's real `~/.claude` etc. never leaks in. `nativeSources.spec.ts`
  builds its own repo + home fixture.

## Agent sessions (ACP)

`packages/core/src/ai/acp/` hosts a CLI agent (Claude Code, Codex) as a subprocess over
the Agent Client Protocol. `AcpAgentHost` owns the session state machine and the events;
`AcpClientWrapper` owns the wire and serves the agent's `fs/read_text_file` /
`fs/write_text_file` requests against the session's working folder, **gated by tool mode**
(`full` writes, `read-only` reads, `project-only` neither) and sandboxed to that folder.

### What the protocol actually offers

**Read the schema before claiming ACP can't do something.** This has now cost two
mistakes in one session — `plan` and `usage_update` were each called impossible, and
each turned out to be a stable part of the spec that this host simply had no `case`
for. The switch in `handleSessionUpdate` has no `default`, so an unhandled kind is a
silent no-op that looks exactly like the protocol not supporting it.

The source of truth is the installed package, not memory:

```bash
# every update kind, and the payload type for each
grep -n "^export type SessionUpdate" -A 40 \
  node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts
```

`dist/schema/` is the stable v1 export (`import * as acp from '@agentclientprotocol/sdk'`,
what this app uses). `dist/v2/` is `experimental/v2` and is **not** what we import.
Within the stable schema, individual types are still marked `**UNSTABLE**` in their
doc comment — check for that before building on one.

`sessionUpdate` kinds in the stable schema, and where each stands here:

| Kind | Stability | Handled |
| --- | --- | --- |
| `agent_message_chunk` | stable | yes — buffered into `responseText` |
| `agent_thought_chunk` | stable | yes — `reasoningText` |
| `tool_call` / `tool_call_update` | stable | yes — `tool_start` / `tool_complete` events |
| `plan` | stable | yes — `session.taskList` |
| `usage_update` | stable | yes — `contextTokens` / `contextLimit` / `cost` |
| `user_message_chunk` | stable | no |
| `available_commands_update` | stable | no — the agent's slash commands |
| `current_mode_update` | stable | no — the agent's own mode, distinct from our `SessionMode` |
| `config_option_update` | stable | no — model picker reads config options on demand instead |
| `session_info_update` | stable | no |
| `plan_update` / `plan_removed` | **UNSTABLE** | no — the incremental multi-plan variant; `plan` is the stable one |
| `compaction_update` / `compaction_summary_chunk` | **UNSTABLE** | no |

Nothing in the "no" rows is unreachable — they are unhandled, and the table is here so
the next gap is found by reading it rather than by assuming.

- **Every turn records its reply as a `message` event.** `buildConversationTranscript`
  reads `message` events to build the next turn's prompt, so a turn that finishes without
  appending one drops the agent's own answer from the following turn's context. The
  initial-turn and follow-up paths must both do this; do not "flush" a prior reply
  retroactively on the way into the next turn (that runs after the transcript is built,
  and duplicates an event the history already holds).
- Permission approval is wired end to end: `ai:respondToPermission` → the host resolves
  the pending request, `SessionsPage` renders Allow / Always allow / Deny while the
  session sits in `awaiting_approval`.
- A full-tools `ai:delegate` **requires** an explicit `workingDirectory` — it will not
  fall back to the app's cwd. Folderless projects are coerced to `project-only`.

- **The two providers report different things, and the fields are not interchangeable.**
  API providers report cumulative tokens: the gateway wire parser reads them from both
  wire formats (OpenAI's final `usage` chunk, which the request already asks for via
  `stream_options.include_usage`, and Anthropic's `message_start` / `message_delta`
  pair), the loop emits a `usage` event per turn, and `addAgentTokenUsage` sums them
  into `tokenUsage`. ACP agents report the *other* half: `usage_update` carries `used`
  (tokens **currently in the window**) and `size`, which feed `contextTokens` /
  `contextLimit`, plus an optional cumulative `cost`. So an ACP session shows a context
  bar and a cost but no token total — the protocol has no cumulative token count to
  give — and an API session shows tokens. **Never map `used` onto `tokenUsage`**: it is
  occupancy, not spend, and the two diverge the moment a conversation is trimmed.
  Anthropic also sends input and output in *different* events, so a running total must
  not be derived until the stream ends.
- **`ai.spendLimit` is a budget the user sets, not a balance anyone reports.**
  Nothing Praxis talks to exposes credits: ACP carries a cumulative `cost` but no
  limit, and the gateway client only calls `/v1/models` and `/v1/chat/completions`.
  So never word it as "credits remaining", and never derive cost from tokens for
  API providers — that needs a price table this app has neither got nor could keep
  true. `summariseSpend` totals **per currency** and yields a comparable `single`
  total only when every reporting session used one: adding USD to EUR to fill the
  banner would be exactly the invented number this section exists to prevent. The
  warning is also explicit that nothing is blocked — Praxis cannot stop an agent
  spending, only say so.

- **The agent's self-reported task list (ACP's `plan` update — Claude Code's TodoWrite,
  Codex's plan tool) renders in `SessionInspector` as `SessionTasks`, not in the
  transcript.** A `plan` event is a complete snapshot every time ("the client replaces
  the entire plan with each update" — the spec's words), so `setAgentTaskList` replaces
  `session.taskList` wholesale rather than merging; a host that merged instead would
  still look right on a single status flip and only break once two updates arrived
  close together. It deliberately does not also become a chat message: the point is to
  stay visible and current while the transcript scrolls underneath it, not to add one
  more thing scrolling past. Absent for every non-ACP provider and for any ACP session
  that never calls the tool — most won't.

- **Context is bounded in two places, for two different reasons.**
  `compactHistoryForReplay` strips tool round-trips when a session is *continued*,
  so old tool output does not replay on every follow-up.
  `trimToolOutputToBudget` runs *inside* the turn loop and elides the oldest tool
  results once the conversation passes `DEFAULT_HISTORY_BUDGET_CHARS` — without it
  history grew monotonically until the provider rejected the turn. It replaces
  content but never removes the `role: 'tool'` message: an assistant `tool_calls`
  entry without its matching result is a protocol error. User and assistant turns
  are never touched.
- **`contextTokens` is not `tokenUsage.inputTokens`.** The former is the latest
  turn's prompt (replaced each turn) and is what context pressure means; the latter
  totals every turn. A session can spend a million tokens over fifty small turns
  without ever filling its window, so never drive a "nearly full" warning from the
  cumulative figure.
- **The facts fixed when a session started (provider, model, tool access, folder,
  worktree), the mode switch, and the context-pressure banner all live on the
  composer's `.composer-controls` row in `SessionsPage`, not in `SessionInspector`.**
  Every one of them was moved there once already — into the inspector for the
  sidebar-consolidation pass, then back to the composer because that buried them
  where the user is about to act, instead of showing them where Claude and Copilot
  both do: beside the input. Change-model and hand-over chips also live on that
  composer row (disabled while a turn is running). `SessionInspector` keeps live
  status, the session purpose, the living handover brief, runtime history, the
  task list, the changeset, and terminal actions (abort, remove worktree) —
  things to watch or act on for the session as a whole, not facts read once
  before typing a message.
- **In-flight single-agent composer: minimized by default with Ask & Queue.** While a
  single-agent turn is executing, the follow-up composer remains collapsed to a compact bar
  showing only the live tool activity, an `Ask` button (`.session-ask-button`), and the
  `Stop` button (`composer-send-cancel`). Irrelevant controls (such as the workflow selector
  or ACP mode chips) are hidden to keep the view clean. Clicking `Ask` smoothly expands
  the textarea (`placeholder="Queue follow-up (sends automatically when done)…"`) and presents
  both the `Stop` button (to abort the running turn) and a `Queue` button. Submitting enqueues
  the follow-up message into `queuedFollowUpsBySession`, collapses the input, and displays
  a queued pill (`.session-runtime-chip.is-queued`) allowing cancellation or editing. As soon
  as the active turn reaches a terminal state, the queued prompt is auto-dispatched to
  `continueSession`. If the user clears their draft or presses `Escape`, the expanded composer
  automatically collapses back to the minimized bar.
- **Session usage summary: hideable bar with composer restoration & smooth closing animation.**
  `SessionUsageSummary` carries a close button on the right edge of its `<summary>` (`.session-usage-hide-btn`).
  When hidden, preference is saved in `localStorage` (`praxis:session-usage-hidden`) and a
  restoration chip (`.session-restore-usage-btn`, graph icon + "Usage") renders on the right
  side of the session composer directly to the left of the tools button (`session-tool-mode` in
  `.session-mode-panel-meta`). Clicking this chip restores the usage bar above the composer.
  Closing the usage panel (whether hiding the bar via `.session-usage-hide-btn`, collapsing the
  expanded metrics via `<summary>`, clicking anywhere outside the open panel, or pressing `Escape`)
  smoothly animates closed from top to bottom via `.session-usage-wrapper` and
  `.session-usage-details-content` using `clip-path`, `transform`, `opacity`, and `max-height` transitions.
- **Session composer horizontal rule matches border-strong.** The horizontal line separating
  `.session-mode-panel` from the textarea inside the composer uses `border-bottom: 1px solid var(--border-strong)`
  so it seamlessly matches the composer card's resting border color when unselected.
- **`.session-mode-toggle` is one shared style for the Chat/Analysis/Review
  control, used both when a session starts (`NewSession`) and to re-run a
  finished one (`SessionsPage`'s composer).** It used to be two near-identical
  rule sets (`.session-mode-toggle` / `.session-mode-switch`) after the second
  copy was written from scratch instead of reused — don't reintroduce a second
  one if this moves again.
- **`SessionChanges` can show a changed file two ways: `getComparison` for the diff,
  `git:getFileContent` for the whole current file.** This is deliberately not an
  editor — Praxis has none by design — just "let me read it" for a file a diff's
  hunk context doesn't fully show. `getGitFileContent` reads the *working tree*
  directly (not a git object), through the same `safeRepositoryFile` sandbox
  `getGitConflict` already used, so it reflects exactly what's on disk right now,
  untracked files included, and cannot escape the repository. It caps what it reads
  at `MAX_FILE_VIEW_BYTES` (1 MB) and returns `truncated` rather than growing
  unbounded, and returns `isBinary` (a null byte in the first 8 KB) with empty
  `content` rather than dumping binary bytes as text. The diff and file panes share
  one `openPath`/`openMode` pair and are mutually exclusive — opening one closes
  the other. Highlighting (`ui/codeHighlight.tsx`) is shared with `GitDiffWorkspace`:
  one small regex-based highlighter for the languages this app actually shows, not
  a real tokenizer — reach for a real one (Prism/Shiki) only if language fidelity
  ever actually matters here.

**Testing an agent flow without a model:** `e2e/fixtures/codingAcpAgent.mjs` is a real ACP
subprocess (real SDK, real wire framing) that performs a scripted edit through the same
file-I/O handlers. Two non-obvious requirements: it needs the executable bit (the host
spawns the `cliPath` command directly, not via `node`), and it resolves
`@agentclientprotocol/sdk` from its own location because it is spawned with `cwd` set to
an arbitrary project folder. `e2e/aiCodingTask.spec.ts` is the worked example.

## Interactive ticket review

"Review ticket" is a real read-only agent session, not a one-shot prompt: only a session has a
scope for gadgets to be issued against and a conversation for answers to travel back on. The
agent gives a verdict, then asks what to do about each finding as gadgets (pick findings →
answer open questions → edit and apply the resulting ticket text). Code: `packages/core/src/ai/ticketReview.ts`
(key convention, gate, prompt), `main/src/main/ticketReviewIpc.ts` (start/lookup),
`ticketReviewApply.ts` (the write), `renderer/src/ai/AiReviewPage.tsx`, and the shared
`renderer/src/ai/gadgets/useSessionGadgets.ts` (also used by `SessionsPage`).

- **The session key is `review~<ticket key>`, never the ticket's own key.** Sessions are stored
  by issue key, so reusing it would replace the ticket's implementation session. Use
  `ticketReviewSessionKey` / `reviewedIssueKey`; the renderer mirrors the prefix in `isTicketReviewKey`
  because it cannot import core values. The prompt builders translate the key back, so the agent
  is told the ticket's real key (a test asserts `review~…` never reaches the prompt).
- **One decision gadget per reply.** Every recorded answer to a `choice`, or to a form whose
  actions are all informational, is sent back to the agent as a follow-up turn. Two decision
  gadgets in one reply would each start a turn and the agent would jump ahead. The prompt says so;
  the examples in it are validated against the real gadget schema by `ticketReview.test.ts`.
- **The apply form is the one gadget with a `mutating` action** (`TICKET_REVIEW_APPLY_GATE`).
  `gadgetIpc.executeGadgetAction` routes it to `applyTicketReview`, which refuses any session
  that is not a ticket review. This is the second exception, after workflow approvals, to
  "a gadget records a decision and never reaches a service": the user's own click on an editable
  form is the approval, and the agent cannot write to the tracker itself (the session is
  read-only; CLI agents have no tracker tools at all).
- **Apply refuses to overwrite an edit made after the review started.** It compares the ticket's
  description/summary to what the review last read or wrote — not the tracker's `updated`
  marker, which a comment (including "Post as comment") also bumps.
- **The apply form's textarea must use the `.textarea` class.** `.input` fixes the height at 28px
  and collapses a whole ticket description to one line.
- **e2e:** `e2e/aiTicketReview.spec.ts` drives `e2e/fixtures/ticketReviewAcpAgent.mjs`, a real ACP
  subprocess with a fixed script — the session, gadget pipeline, follow-up turn and apply are the
  production path; only the model's words are canned.

## `docs/plans/` is a Praxis board — keep it parseable

Praxis reads its own plans: the Praxis Desktop project (`praxis-code.workspace.praxis.json`)
is folder-backed at `apps/praxis-desktop`, and `identifyPlanFolder` resolves
`apps/praxis-desktop/docs/plans` / `apps/praxis-desktop/docs/plans/features` from
there, and `parsePlanFolder` (`markdownPlanParser.ts`) turns the tree into board
issues. **A file that does not meet the contract is skipped silently** — no
error, it just never appears on the board. The contract:

- **A child item needs a declared type.** `feature.md` is matched by filename;
  everything else (`story.md`, `task-NNN-*.md`, bugs, ideas) is kept only if
  `extractTypeRaw` finds a frontmatter `type:` or a `**Type:**` line — *or* the
  filename matches `story|task|bug|idea-<n>-<n>-slug.md`. Our nested
  `stories/fx-be-NNN/story.md` layout matches no filename pattern, so
  **`type: Story` in the frontmatter is what makes a story exist.** All 34
  stories were invisible until this was added.
- **Ids come from `id:`, and they must be unique across the whole tree.**
  `planningNumber` reads `FX-BF-…` / `FX-BE-…` / `TASK-…` from `id:` (then the
  directory name). A duplicate id is pushed to an auto-assigned `9000+`, and
  those are **order-dependent, so the board key is not stable** — adding a
  folder can renumber them.
- **The title is the H1, not `title:`.** `extractMainHeading` reads `# …`;
  frontmatter `title:` is ignored for display. No H1 ⇒ the card reads
  "Untitled". 83 files were in that state.
- Status comes from `status:` or `**Status:**` and is fuzzy-mapped
  (`complete|done|✅` → Done, `block` → Blocked, `progress|doing|wip` → In
  Progress, `todo|pending|planned` → To Do, else Backlog).
- Dependencies are scraped from a `## Dependencies` section or a
  `**Dependencies:**` line.

The `plan-authoring` skill (`.agents/skills/plan-authoring/`) carries these rules for
agent sessions that write plan files.

Re-check after editing plans by running `parsePlanFolder` over the repo — if
the feature/story/task counts move unexpectedly, something stopped parsing.

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

## Verifying a UI change

**A green suite does not mean it looks right.** Three real regressions in one session passed
every test and were only found by opening a capture:

- a workflow node's stage kind wrapping to `agent-` / `task` once the type scale lifted it
  to 11px;
- an empty state collapsing into a crushed column, because its new paragraph became a
  fourth flex child of a row built for three;
- the walkthrough ring lagging a whole stop behind its callout, and separately vanishing
  into the accent button it was meant to point at.

None of those break an assertion. So after any change to layout, the type scale, spacing or
colour: **run the specs that capture the surface and look at the PNG.** Files under
`apps/praxis-desktop/main/output/playwright/` come from plain `page.screenshot` — they are
written for looking at and never fail a test, so they can also go stale; only
`toHaveScreenshot` files under `*.spec.ts-snapshots/` actually guard anything. Do not read a
plain screenshot as evidence without re-running the spec that writes it.

**Regenerating a snapshot is not verification.** A visual change moves the `toHaveScreenshot`
baselines and `--update-snapshots` will bless a regression as happily as a fix. Open the
`-actual.png` or the diff for each one you regenerate, and only then accept it.

**Prove every regression guard fails.** A guard that cannot fail is worse than none, because
it reads as coverage. Twice here a new assertion passed against the broken code — the first
keyboard-focus test passed with the ring disabled, because the browser's default outline
took over once the `outline: none` resets were gone. The habit: write the guard, break the
fix, watch it fail with the message you expect, restore. `e2e/keyboardFocus.spec.ts` and
`e2e/walkthrough.spec.ts` both carry comments recording what they were proven against.

**Changing a default cascades into the specs.** They encode current defaults heavily, and
the failure is always in a spec that looks unrelated. Defaulting the project brief to
"included" broke two wizard walk-tests; moving `window.confirm` in-app broke the two specs
that accepted a native dialog with `page.on('dialog')`; expanding the Appearance settings
group by default broke `openLooks` / `openSurface`, whose guarded `group.click()` then
*collapsed* it. Before changing a default, grep the e2e directory for assertions on the old
one.

**Live-agent tests are opt-in and stay that way.** `*.live.spec.ts` drives a real
CLI agent against a real model — it spends money on whoever's account the agent is
signed in to and takes minutes. Those files are excluded from every other Playwright
project and additionally refuse to run without the env opt-in:

```bash
PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent
```

Handover between two real CLIs is the same opt-in project, in
`aiLiveHandover.live.spec.ts` — first agent fixes addition only, then Praxis
hands the same session to a second signed-in CLI (`PRAXIS_LIVE_HANDOVER_TO` /
`PRAXIS_LIVE_HANDOVER_CMD`, default Codex) which must finish multiplication
from the envelope. Run that file alone when you want the spendy proof.

`aiLiveConversation.live.spec.ts` is the corresponding FX-BE-122 proof: it
starts an explicit two-turn, read-only consult with Claude Code and Codex and
asserts two visible attributed speakers. It uses the same `PRAXIS_LIVE_AGENT=1`
gate and is never part of `npm run test:desktop`.

**Hand over** is deliberately one-way. The separate **Bring in another AI**
composer action starts a bounded multi-AI conversation: both speakers remain in
one transcript, turns are sequential, consult/debate are read-only, and pair
mode grants full tools only to the selected owner. Never fold that opt-in flow
into handover or record its internal routing instructions as user messages.

Never add them to `npm run test:desktop`. Keep the task small and self-verifying —
the current one seeds a repository whose own `node --test` suite fails and asks the
agent to make it pass, so success is measured by running that suite afterwards
rather than by reading the agent's prose.

**Known flake, not a defect.** `aiCliAgentHost.spec.ts` intermittently hangs for minutes on
a *different* test each run, then passes in ~3s alone; it was clean across ~40 runs and the
whole suite at the configured worker count. It correlates with long unattended runs, not with
the code — `timeout: 30000, retries: 0` makes a multi-minute test impossible unless the
worker was descheduled. Don't chase it. Related: full-suite runs launched in the background
have twice been killed mid-flight with no output; smaller batches complete reliably.

## Testing expectations for agents

**Testing is mandatory, not optional.** This is a visual application with real UI regressions that pass all assertions. An agent must:

- **Run the e2e suite against any UI change** (`npm run test:desktop`). A green suite does not mean it looks right (see "Verifying a UI change" above).
- **Visually inspect the app** after implementing a feature. Launch it (`npm run start` or equivalent), navigate to the changed surface, and interact with it end-to-end before reporting success.
- **Update snapshots deliberately.** Never assume a snapshot update is safe. Open the `-actual.png` and diff, read what changed, and confirm it is the fix (not a regression) before accepting it.
- **Never say "I can't test"** when the suite is runnable and the app is launchable. If you encounter a blocker, investigate and fix it rather than declaring testing impossible.
- **Document what you tested.** Report which e2e tests passed, which snapshots were updated, and which manual interactions verified the feature works. A session ending with "build succeeded" is not done — include verification in the completion.

No test *guarantees* correctness (a regression can still paint), but tests + screenshots catch real bugs. Use both.

## Real iPhone deployment guardrail

A phone build must be **Release** (Debug expects Metro and looks like a blank app
on a phone). The full procedure and checks live in the `mobile-device-testing`
skill (`addons/skills/mobile-device-testing/`) and
`apps/praxis-mobile/docs/ios-phone-deployment.md`; follow those.

## Mobile theme follows the desktop

The phone wears the paired desktop's theme. The desktop renderer resolves its
live CSS tokens to hex (`settings/mobileAppearancePublisher.ts`) and hands them
to main on every `tm-theme-changed`; `host.info` carries them as `appearance`
and a host-wide `host.appearance` event carries changes (the LAN server lets that
one event past a phone's project scope). On the phone, `app/theme.ts` holds the
live palette: build stylesheets with `themedStyles(() => StyleSheet.create(…))`
and read `theme.x` at render time, never capture a colour in a module-level
constant, or it won't follow the desktop. The phone imports only types from
`@praxis/core`, so its validation lives in `renderer/mobileTheme.ts`.
