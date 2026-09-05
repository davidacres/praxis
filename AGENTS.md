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

## Dialogs

There is no `window.confirm` / `window.prompt` in the renderer. They are OS-modal,
unstyleable, ignore the app's themes, and block the renderer — and two of the prompts
collected real data with no validation. Use `useDialogs()` from `ui/dialogs.tsx` instead:
`await confirm({ title, message?, danger? })` and `await prompt({ title, label, validate? })`
render inside the app's own modal surface and return a promise, so a call site still reads
`if (!(await confirm(...))) return;`. `<DialogHost>` wraps `<App/>` in `main.tsx`. An e2e test
that used to accept a native dialog with `page.on('dialog', …)` now clicks the button in the
in-app dialog by its `confirmLabel`.

## Command palette

`⌘K` opens `app/CommandPalette.tsx` over a flat index built in `App` (`paletteEntries`) from
the collections the shell already holds — projects, boards, sessions, agents, skills,
workflows, feature destinations, settings pages. It is navigation only; each entry's `run`
reuses the same `navigate()` / `setSettingsDialogCategory()` the sidebar uses. Add a new
navigable surface → add an entry to that `useMemo`.

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

## Workspace / project / connection model

Three layers, each with one job:

- **Workspace** (`.workspace.praxis` file, `WorkspaceRecord`) — a saved, shareable set
  of project + connection references. Groups; owns no board data.
- **Project** (`ProjectRecord`, `ProjectStore`) — the unit of planned work. One board.
  `storage: 'app'` keeps work items in app JSON; `storage: 'folder'` backs them with a
  markdown plans folder under `project.workspaceFolder`. Synthetic connection id
  `project:<id>`, `mode: 'project'`.
- **Connection** (`Connection`, `connectionStore`) — an external/system backend.
  `mode ∈ { jiracloud | gitlab | github | demo | folder }`. `folder` points at one or
  more plans-folder roots on disk (native multi-root; each root's `board.praxis.json`
  carries its own `projectKey` / `projectName`).

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
  both do: beside the input. `SessionInspector` keeps live status, the task list, the
  changeset, and terminal actions (abort, remove worktree) — things to watch or act on
  for the session as a whole, not facts read once before typing a message.
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
