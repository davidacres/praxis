---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-308
title: "Convert agents/*.md and SKILL.md into AgentProfile/AgentSkillRef"
status: Proposed
story: FX-BE-108
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-108, TASK-307]
---

# TASK-308: Convert agents/*.md and SKILL.md into AgentProfile/AgentSkillRef

## Objective

Parse a plugin's `agents/*.md` (Claude Code subagent format: `name`, `description`,
`model`, `color`, `tools` frontmatter + instructions body) into `AgentProfile`, and
its `skills/*/SKILL.md` / `commands/*.md` (same frontmatter+body shape, `name`,
`description`, optionally `argument-hint`/`allowed-tools`) into `AgentSkillRef`.

## Implementation notes

- Praxis's own `parseAgentProfile` (`profileRegistry.ts`) and skill frontmatter
  parser (`skillRegistry.ts`) already parse a near-identical shape — extend or
  parallel those parsers rather than writing a third, subtly different one.
  Frontmatter is a strict superset for imported content: `id`/`name` map directly,
  `description` maps directly, `instructions` is the body in both formats.
  `model`/`color`/`tools` (agents) and `argument-hint`/`allowed-tools` (skills) have
  no Praxis field today — carry them as an `importedMetadata` passthrough on the
  record rather than dropping them, so a later story can act on them without a
  re-import.
- `tools`/`allowed-tools` is the closest existing signal to `requiredCapabilities` —
  do not silently equate them; a tool name in Claude Code's vocabulary
  (`Read`, `Bash`, ...) is not the same as a Praxis `AgentHostCapabilities` flag.
- `commands/*.md` loads identically to `skills/<name>/SKILL.md` per the upstream
  plugin's own documented convention (confirmed against `example-plugin` during
  scoping) — one parser path, two directory layouts.
- Name collisions between an imported profile/skill and an existing bundled or
  FX-BF-018 marketplace one must be visible (a distinct id namespace per source, e.g.
  `plugin:<marketplace>/<plugin>/<name>`), never silently shadowed.

## Acceptance criteria

- Round-trips real `agents/*.md` and `skills/*/SKILL.md` content from at least two
  different upstream plugins without data loss.
- An imported profile/skill's id is unambiguous against bundled and marketplace ids.
- Metadata with no Praxis equivalent is preserved, not discarded.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the conversion unit tests and `npm run check-types`
across workspaces.

## Description


## Dependencies



## Comments
