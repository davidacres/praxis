# Agent notes: `apps/praxis-desktop/docs`

Area-specific guidance, moved out of the root [AGENTS.md](../../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.
This file sits outside `docs/plans` on purpose: the plan parser scans that folder.

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
