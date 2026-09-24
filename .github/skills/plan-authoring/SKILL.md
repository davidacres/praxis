---
name: plan-authoring
title: Plan Authoring
description: "Write markdown plan items (features, stories, tasks, bugs) that a folder-backed Praxis board can parse."
triggers: plan, feature plan, story, task, bug, board, docs/plans, remediation plan
version: 1.0.0
---

# Plan Authoring

A folder-backed Praxis board is built from the markdown files in the project's plans folder
(usually docs/plans or docs/plans/features). **A file that breaks these rules is skipped silently**:
no error, it just never appears on the board. Check every file you write against all of them.

1. **Title is the H1.** The first "# ..." heading is the card title. Frontmatter "title:" is ignored.
   No H1 means the card reads "Untitled".
2. **Every item declares its type.** feature.md is recognised by its filename. Anything else needs a
   frontmatter "type:" (Feature, Story, Task, Bug, Idea) or a "**Type:**" line, or a filename of the form
   story-N-N-slug.md, task-N-N-slug.md, bug-N-N-slug.md or idea-N-N-slug.md. A nested stories/<id>/story.md
   matches no filename pattern, so it needs "type: Story".
3. **Ids are unique across the whole plans tree.** Take the id from "id:" (or the directory name). A
   duplicate is given an auto-assigned 9000+ number that depends on file order, so its board key is not
   stable. Look at the existing ids before choosing a new one.
4. **Status uses words the board resolves.** Use "status:" or a "**Status:**" line. Without a declared
   workflow: complete / done / ✅ → Done; blocked → Blocked; in progress / doing / wip → In Progress;
   todo / pending / planned → To Do; anything else → Backlog. If the plans folder has a board.praxis.json
   with a workflow, use that workflow's stage names.
5. **Dependencies** go in a "## Dependencies" section or on a "**Dependencies:**" line, naming item ids.
6. **Keep to the folder's existing layout and naming.** Read two or three existing items first and match
   their frontmatter, headings and file names.

When you have finished, list every file you wrote with its id, type, status and H1, and say which rule
each satisfies. If the repository provides a plan validator or parser test, run it and report the
feature/story/task counts before and after; a count that did not move by what you added means a file
was skipped.
