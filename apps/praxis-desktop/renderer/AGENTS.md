# Agent notes: `apps/praxis-desktop/renderer`

Area-specific guidance, moved out of the root [AGENTS.md](../../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Praxis desktop app (`apps/praxis-desktop/renderer` + `apps/praxis-desktop/main`)

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
