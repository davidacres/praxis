# Workflow experience — UX design plan

**Status:** Proposed · **Feature:** FX-BF-014 (proposed) · **Depends on:** FX-BF-012, FX-BF-013 (functional; this replaces their placeholder UI)

The workflow engine, designer state model, orchestrator, and run monitor are
built and tested. What ships today is a **functional placeholder UI**: one
scrolling centre-pane page with a tab strip, inline styles, and a canvas bolted
above a 2‑column grid. It works; it does not feel like Praxis, and it asks the
user to hold too much at once.

This plan redesigns the surface so it reads as one calm, native part of the app.
Nothing about the engine changes.

---

## 1. Principles

1. **Two jobs, two calm screens.** *Authoring* a workflow and *operating* a run
   are different mindsets. Never show both. The current tab strip conflates them.
2. **Let the shell do the work.** Praxis already has a three‑pane idiom —
   left rail selects, centre shows the one thing, right rail shows its
   properties (issue list → issue → issue detail). Workflows should use it, not
   reinvent a page-internal grid.
3. **Progressive disclosure.** The canvas shows *shape*. The right rail shows
   *depth*, and only for the selected element. A stage's twelve fields never
   appear until you click the stage.
4. **Themed, never styled.** Every surface reads design tokens and composes with
   `data-mode` / `data-theme` / `data-surface` / surface packs. Reuse the
   existing `.designer-canvas` / `.designer-node` / `.btn` / `.chip` /
   `.empty-state` vocabulary. Zero inline colour, spacing, or radius.
5. **Status is legible in two seconds.** A run's state is a sentence, a pipeline
   picture, and a gate ledger — not a data table. Tables are for *evidence*, not
   status.
6. **One click to value.** The built‑in Governed delivery template is the
   default path. "New workflow" and "Duplicate" are secondary.

---

## 2. Information architecture

`Workflows` stays a **project-scoped** sidebar entry (it already is). Selecting
it opens the **Workflow Library** in the centre pane. From there:

```
Workflows (sidebar entry, per project)
│
├─ Library            centre: cards — templates + this project's workflows
│                     right rail: nothing (or a one-line "what is a workflow")
│
├─ Designer           left rail: stage list (selectable, drag-reorder, badges)
│  (opens a workflow)  centre:   canvas (the hero) — pan/zoom, drag, connect
│                      right rail: inspector for the selected stage OR edge
│                      footer bar: validation summary + Save + Run
│
└─ Runs               left rail: run list (newest first, live status dot)
   (opens the monitor)  centre:   run board — sentence, pipeline diagram,
                                  gate ledger, timeline
                        right rail: selected stage detail — evidence,
                                  artifacts, session link, per-stage actions
```

The **Designer** and **Runs** are reached by a segmented control in the page
header (`Design ⇄ Runs`), not a tab strip buried mid-page — and each is a
distinct layout, not a swapped `<div>`.

### Left rail: which sidebar?

Praxis's left rail is the global `Sidebar` (project tree). The Designer's *stage
list* and the Runs' *run list* are **secondary navigation** local to the page.
They render as a **docked themed column** inside `pane-main`, using the exact
`.sessions-list` pattern (surface-panel opacity, tint wash, accent glow, blur,
grain) so it reads as a real panel and not a plain box. DOM order keeps the list
first for tab order; `flex-direction: row-reverse` is available if we ever want
it on the right.

### Right rail: the shell's `pane-aux`

The stage/edge inspector and the run-stage detail belong in the existing
resizable `aside.pane-aux` — the same slot that holds issue details and
`TaskDesignerItemDetail`. This is free: the shell already renders it, resizes
it, and remembers its width. `App.tsx`'s `centre()`/aux routing gains a
`feature === 'workflows'` branch that puts the right content there instead of
inside the page.

Result: the workflow page's own markup shrinks to **left column + centre**, and
the shell supplies the third pane — exactly like every other feature.

---

## 3. Screen: Workflow Library

**Purpose:** choose a starting point, or reopen a workflow. Nothing else.

```
┌ Workflows · Delivery Project ─────────────────  [ Design | Runs ]  ┐
│                                                                     │
│  This project                                                       │
│  ┌───────────────────────────┐ ┌───────────────────────────┐       │
│  │ Governed delivery      v3 │ │ Hotfix                 v1 │  …     │
│  │ 7 stages · ✔ ready         │ │ 3 stages · ⚠ 1 agent      │       │
│  │                    [Open]  │ │ missing          [Open]   │       │
│  └───────────────────────────┘ └───────────────────────────┘       │
│                                                                     │
│  Start from a template                                              │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │ ●  Governed delivery                          built-in     │     │
│  │    Plan → Implement → Review · QA · Security → Approve      │     │
│  │    ✔ all agents resolve                       [Use this]    │     │
│  ├───────────────────────────────────────────────────────────┤     │
│  │ ○  Quick change                              built-in      │     │
│  │    One implementation stage and a human sign-off.          │     │
│  │                                              [Use this]    │     │
│  └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

- **Project workflows** as `.card`s in a responsive grid (`repeat(auto-fill,
  minmax(280px, 1fr))`, the app's standard). Each: name, version chip,
  stage count, a single readiness line (`✔ ready` / `⚠ N agents missing`),
  and `Open`.
- **Templates** as a bordered list (`.overview-starter-strip` idiom). Built-in
  templates carry a muted `built-in` chip and cannot be edited in place —
  `Use this` instantiates a project copy and opens the Designer.
- **Empty state** (no project workflows yet): the template list is the whole
  screen, with a one-line lede — *"A workflow assigns trusted agents to
  controlled stages and gates delivery behind review, QA, and security."*
- Readiness is fetched once (`templateReadiness`) and shown inline; a template
  that needs an uninstalled agent is still usable but the line says which node
  and links to Agent Hub.

**Right rail:** empty-state card explaining what a workflow is, until something
is opened.

---

## 4. Screen: Designer

**Purpose:** shape a workflow. The canvas is the hero; everything else supports it.

```
┌ Workflows · Delivery Project ─── Governed delivery ──  [ Design | Runs ]  ┐
│┌ Stages ────────┐┌ Canvas ──────────────────────────────────────────────┐│
││ ▸ Plan     entry││   ┌─Plan─┐   ┌─Implement─┐   ┌─Review─┐              ││
││   Implement  ⚠1 ││   │ agent│──▸│  agent    │┬─▸│ agent  │──┐           ││
││   Review    gate││   └──────┘   └───────────┘│  └────────┘  │           ││
││   QA        gate││                           ├─▸┌─QA──┐──┐  ├─▸┌─Gates─┐ ││
││   Security  gate││                           │  └─────┘  │  │  └───┬───┘ ││
││   Gates    join ││                           └─▸┌─Sec─┐──┼──┘      │     ││
││   Approve   ✔   ││                              └─────┘  │    ┌─Approve─┐ ││
││ ─────────────── ││                                       └───▸│ human  │ ││
││ + Agent  + Check││                              [＋] [－] [⤢]  └────────┘ ││
││ + Approval + Join││ dot-grid canvas, pan/zoom, themed nodes             ││
│└────────────────┘└──────────────────────────────────────────────────────┘│
│ ✔ Valid · 0 warnings                              [ Run ▸ ]   [ Save ]    │
└─────────────────────────────────────────────────────────────────────────┘
        right rail (pane-aux) → inspector for the selected Plan node
```

### Left column — stage list (~240px, docked themed panel)

- One row per stage: kind glyph, name, and at most **one** trailing marker —
  `entry`, a gate name, or `⚠ N` (never all three; priority: error > gate >
  entry). This is the a11y-first surface: full keyboard nav, `aria-pressed`,
  reorder with the keyboard.
- Below a divider: four **add** buttons (`.chip` style) — Agent, Check,
  Approval, Join. New node lands near the viewport centre and is auto-selected.
- Selecting a row selects the node on the canvas and vice-versa (single source
  of truth: `selectedNodeId`).

### Centre — canvas (reuses `.designer-canvas`)

- The existing Task Designer canvas CSS verbatim: dot-grid background, themed
  node cards with a per-kind left accent (`--designer-node-accent` set per
  node type: agent = accent, check = info, approval = warning, join = dim),
  curved SVG edges, a floating zoom toolbar (`.designer-toolbar`).
- **Node card** (compact): kind glyph + name, then a single sub-line —
  the agent name, the command, `mode: all`, or the gate it satisfies. A `⚠`
  corner badge when the node has validation issues. An `entry` ribbon on the
  entry node.
- **Edge**: success = solid border-strong, failure = dashed danger, `always` =
  solid dim. A small pill at the edge midpoint on hover shows `success` /
  `required` and offers delete. Outcome/required are edited in the right rail,
  not on the canvas.
- **Connect**: drag from a node's right-edge handle to another node. The
  scheduler forbids a non-join node having two *concurrent* parents; the canvas
  lets the drag complete and the validation badge + right-rail message explain
  it, rather than refusing silently mid-gesture.
- **Keyboard**: arrow keys nudge the selected card, `Enter` opens its inspector,
  `Tab` cycles cards. Edge creation without a pointer stays in the right rail's
  From/To/Connect control (kept, relabelled "Connections").

### Footer bar (sticky, inside `pane-main`)

- Left: the validation summary as a `.chip` — `✔ Valid · 0 warnings` /
  `✕ 2 errors` (danger). Clicking it focuses the first offending node.
- Right: `Run ▸` (primary when valid, opens a small "run against which task?"
  popover then jumps to Runs) and `Save` (disabled until dirty; label flips to
  `Saved`). For a folder-backed project, Save writes `.praxis/workflows/…` and
  a subtle "committed to repo" note appears.

### Right rail — the inspector (`pane-aux`)

One panel, driven by what's selected on the canvas:

- **Agent stage:** name · **agent picker** (dropdown of discovered agents with a
  trust dot and capability line; an unusable pick shows its remediation and a
  link to Agent Hub) · tool mode · skills (checkboxes, drift flag) ·
  instructions (textarea) · "writes the worktree" toggle · satisfies-gate.
- **Check:** name · command · args · success exit codes · satisfies-gate.
- **Approval:** name · prompt · required gates (a policy-required gate is
  checked and locked, with a "required by project policy" note) · allow
  attributed bypass (locked off when policy forbids) · a "policy requires a
  human approval stage" note when relevant.
- **Join:** name · mode (`all` / `all-required`) with a one-line explanation.
- **Edge:** from → to (read-only) · outcome · required.
- Node-level validation issues list at the bottom, in danger text.
- Header actions: `Make entry` · `Duplicate` · `Remove`.

No selection → an `.empty-state`: *"Select a stage to edit it."*

---

## 5. Screen: Run Monitor

**Purpose:** understand a run at a glance; act only when needed.

```
┌ Workflows · Delivery Project ────────────────────  [ Design | Runs ]  ┐
│┌ Runs ──────────┐┌ Governed delivery — "Ship the widget" ─────────────┐│
││ ● awaiting      ││ ◆  Waiting for a human approval — every required   ││
││   Ship the widget││    gate has resolved.                             ││
││ ─────────────── ││                                                    ││
││ ● running        ││   Plan ✔ ─ Implement ✔ ─┬─ Review ✔ ──┐           ││
││   Fix the export ││                          ├─ QA ✔ ──────┤ Gates ✔  ││
││ ✔ succeeded      ││                          └─ Security ✔ ─┘   │      ││
││   Nightly deploy ││                                       Approve ◆    ││
││ ✕ failed         ││                                                    ││
││   Old migration  ││   Gates                                            ││
││ ─────────────── ││   review   ✔ passed     Review succeeded           ││
││ [ Start a run ] ││   qa       ✔ passed     check · npm test           ││
││                  ││   security ✔ passed     check · npm audit          ││
││                  ││                                                    ││
││                  ││   [ Approve ]   [ Cancel run ]                     ││
│└────────────────┘└────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
        right rail (pane-aux) → detail for the stage you click in the diagram
```

### Left column — run list (~240px, docked themed panel)

- Newest first. Each row: a **status dot** (running = pulsing accent, awaiting =
  ◆ warning, succeeded = ✔ ok, failed = ✕ danger, cancelled = – dim), the task
  title, and a relative time. Live: updates in place via `onRunChanged` without
  moving the selection.
- `Start a run` at the bottom opens a small form (workflow + task title). If the
  project has only one workflow it's preselected.

### Centre — the run board (not a table)

Reading order, top to bottom:

1. **The sentence.** `summary.explanation`, prefixed with a status glyph, in a
   bordered banner (`role="status"`, `aria-live="polite"`). This is the single
   most important element — a person should get the state without reading
   anything else.
2. **The pipeline diagram.** A left-to-right rendering of the graph (reuse the
   canvas renderer, read-only, auto-laid-out, no toolbar), each node tinted by
   lane: idle (dim outline), ready (accent outline), running (pulsing),
   done (filled ok), failed (filled danger), skipped (strikethrough), awaiting
   (◆). Branch groups visibly converge at their join, which turns solid when
   converged. Click a node → its detail opens in the right rail.
3. **The gate ledger.** One row per required gate: name, state chip
   (`passed` / `failed` / `pending` / `bypassed` / `missing`), and a short
   reason. `(deterministic check)` tag where it applies. A bypass shows who and
   why.
4. **Run actions.** `Approve` (enabled only when `summary.actions` says so),
   `Cancel run`. `Approve` opens a confirm with an optional note; a blocked
   approval is disabled with a tooltip naming the blocking gate.
5. **Timeline** (collapsed by default): the event log, newest last, as a plain
   list — for when someone needs the history.

### Right rail — stage detail (`pane-aux`)

Opens when a node in the diagram is clicked:

- Stage name · kind · lane chip · attempt count (`2 / 3`).
- **Evidence**: the immutable snapshot ref (mono), each produced artifact
  (kind + id, opens the file where one exists), and the last error in danger
  text.
- **Session**: for an agent stage, an `Open session` button routing to Sessions
  with that key — and the session there is badged `Workflow` and labelled by
  stage.
- **Actions** for this stage: `Retry` (failed, within budget), `Mark done` /
  `Mark failed` (only for a stage the orchestrator declined — no provider, no
  folder). These are the *exception* path and are visually quieter than the
  run-level actions.

No selection → `.empty-state`: *"Select a stage to see its evidence."*

---

## 6. Theming & tokens — what to build

Move **all** workflow styling into `theme.css` under a `wf-` prefix. No inline
`style={{…}}` beyond dynamic geometry (a node's `left/top`, the pan transform).

| Concern | Token / class |
| --- | --- |
| Page frame, header, segmented control | reuse `.pane-main`, add `.wf-header`, reuse `.btn-compact` for `Design ⇄ Runs` |
| Docked list column (stages / runs) | `.wf-rail` — copy `.sessions-list` (surface-panel opacity, tint, glow, blur, grain) |
| Canvas | reuse `.designer-canvas`, `.designer-toolbar` |
| Node card | `.wf-node` extending `.designer-node`; per-kind accent via `--designer-node-accent` set inline per node type only |
| Node kind accents | `--wf-agent`, `--wf-check`, `--wf-approval`, `--wf-join` in `:root` and each theme block, defaulting to `--accent` / `--ok` / `--priority` / `--text-tertiary` |
| Edge strokes | `--border-strong` (success), `--danger` (failure), `--muted` (always) — already tokens |
| Lane states (monitor) | `.wf-lane-idle/-ready/-running/-done/-failed/-skipped/-awaiting`, colours from `--ok` `--danger` `--accent` `--priority` |
| Status / gate chips | reuse `.chip`, `.chip-success`; add `.chip-danger`, `.chip-warn`, `.chip-muted` if absent |
| Cards, empty, error | reuse `.card`, `.empty-state`, `.error-banner` |
| Spacing / radius | `--space-*`, `--radius-*` throughout |

Every new class gets a `:root` definition first, then overrides only inside
`@media (prefers-color-scheme: dark)` / `[data-theme]` blocks — never a colour
defined *only* in a dark block. Verified by toggling all installed themes in the
`themeLooks` e2e (add workflow screens to its gallery pass).

---

## 7. States (every screen)

| State | Library | Designer | Monitor |
| --- | --- | --- | --- |
| Loading | card skeletons | canvas spinner, rail dimmed | list skeletons, board spinner |
| Empty | template list only + lede | n/a (always ≥1 node) | "No runs yet — start one" in the board |
| Error | `.error-banner` above the grid | banner above footer; canvas stays interactive | banner above the board; list still usable |
| Offline / no provider | — | agent picker shows "no AI provider configured — agent stages will need manual advancement", links to Settings | monitor shows Mark done/failed on agent stages, with a one-line note why |
| No git folder | — | footer note: "attach a folder to run this workflow" | Start-a-run disabled with the same note |

---

## 8. Accessibility

- The docked list columns are `<nav aria-label="Workflow stages">` /
  `<nav aria-label="Runs">`; rows are buttons with `aria-pressed`.
- The canvas is `role="application"` with a labelled description of the keyboard
  model; every node is a focusable button carrying its full state in
  `aria-label` (already true).
- The run sentence is `role="status" aria-live="polite"`; it is the only live
  region on the monitor, so background stage completions announce once, calmly.
- The gate ledger is a real `<table>` with a caption; the pipeline diagram has
  an adjacent visually-hidden ordered list of stages and their states as the
  non-visual equivalent.
- Colour never carries state alone: every lane and chip pairs colour with a
  glyph or word.
- Focus order: rail → canvas/board → footer/actions → right rail.

---

## 9. Implementation shape (proposed FX-BF-014)

Roughly one story per screen plus the theming pass. All renderer-only; no
engine, IPC, or core changes beyond a couple of view-model fields already
present.

- **FX-BE-027 — Shell integration & theming foundation.**
  Route `feature === 'workflows'` content into `pane-aux`; add `.wf-*` classes
  and kind-accent tokens to `theme.css` across all theme blocks; delete the
  inline styles from the three current components; segmented `Design ⇄ Runs`
  header. *No visual regression to the engine tests.*
- **FX-BE-028 — Library & Designer.**
  Library grid + template list with readiness. Designer as docked stage rail +
  `.designer-canvas` hero + sticky footer; inspector moves to `pane-aux`;
  agent picker with trust/capability/remediation; edge pill on the canvas.
- **FX-BE-029 — Run Monitor.**
  Run rail with live status dots; the board (sentence, read-only pipeline
  diagram, gate ledger table, collapsible timeline); stage detail in `pane-aux`
  with evidence + session link; run/stage action hierarchy.
- **FX-BE-030 — Polish & verification.**
  Loading/empty/error/offline/no-folder states; keyboard and focus-order pass;
  add the three workflow screens to the `themeLooks` gallery e2e and refresh
  snapshots; responsive behaviour down to the app's min width.

### Non-goals

- No change to the engine, orchestrator, IPC contract, or run semantics.
- No new "workflow analytics" / history-across-runs view (future).
- No multi-select or bulk operations on the canvas.
- The canvas stays 2‑D and pointer-first; a full graph auto-layout algorithm is
  out of scope (nodes keep their stored x/y; the monitor's read-only diagram
  uses a simple layered layout).

---

## 10. Decisions

### 10.1 One sidebar entry, a header segmented control, a count badge

**`Workflows` stays a single sidebar row.** `Design ⇄ Runs` is a segmented
control in the page header (`.btn-compact` pair, `role="tablist"`), not a second
sidebar entry.

Rationale: the two modes are tightly coupled — you save a workflow and
immediately want to run it; while a run is going you flip back to check the
graph. A header control makes that flip one click and keeps the project tree
(already dense with Boards / Repository / Workflows / docs) calm. The Git split
(`Graph` / `Changes` as sibling rows) is the counter-precedent, but Git's two
views are less coupled than design-then-run.

Discoverability is bought back cheaply: **the `Workflows` sidebar row carries a
count badge of non-terminal runs** (`running` + `awaiting-approval`), using the
existing `featureCounts` mechanism. "Workflows · 2" tells a browsing user that
runs exist and something is live, without a second row.

The route records the active view — `route.workflowView: 'design' | 'runs'` (and
`route.workflowId`, `route.runId`) — so back/forward, and a restart, land the
user where they were. Recovery of a running orchestrated run should restore into
`runs` with that run selected.

### 10.2 Both docked list columns go on the left

The Designer's **stage list** and the Monitor's **run list** dock on the
**left** of `pane-main`. The right side is reserved for the shell's `pane-aux`
(the stage/edge inspector, the run-stage evidence panel).

This isn't only "consistency with Sessions" — it's forced. `pane-aux` is already
a right-docked panel. Putting a list column on the right too would mean two
panels competing for the right edge, and the run board (which reads
left-to-right: sentence → pipeline diagram → ledger) would start behind
whichever won. Left-docked list, right `pane-aux`, board flush against the list.

### 10.3 Start a run from three places, one form

1. **Designer footer — `Run ▸`.** A small popover: *"Run «workflow» against a
   task"* with one text field and `Start`. Disabled while the workflow is
   invalid or unsaved (and, for a folder-backed project, uncommitted); the
   tooltip says why. On `Start` it navigates to `runs` with the new run
   selected. This serves the highest-intent moment — just finished editing.
2. **Run rail — `Start a run`.** The same popover, plus a workflow picker when
   the project has more than one. Serves "come back and run an existing
   workflow against a new task".
3. **Monitor stage/run detail — `Re-run`.** On a settled run, re-runs the same
   workflow version against a new task title (prefilled from the original).

All three call `workflows.startRun` and open the same small form component; only
the trigger and the pre-filled fields differ.
