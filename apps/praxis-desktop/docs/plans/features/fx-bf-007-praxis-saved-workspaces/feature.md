---
id: FX-BF-007
status: Done
type: Feature
---

# FX-BF-007: Praxis Saved Workspaces

**Created:** 2026-08-28T18:59:35.084Z
**Type:** Feature
**Status:** Done
**Owner:** Electron desktop app
**Priority:** P1

## Outcome

Let people create, switch, and save a durable Praxis workspace that groups
projects, connections, objectives, and the current operating context. A saved
workspace is a collection of project references, not a duplicate project store.

## Scope

- Workspace records persisted in desktop app storage.
- Workspace selector at the top of the project-first sidebar.
- Create, switch, save-to-file, and open-from-file flows.
- Versioned `.praxis-workspace.json` format with schema compatibility checks.
- Project membership references, connection references, objectives, and default project.
- No credentials or secrets in exported files.

## Story map

- `FX-BE-008` — Saved workspace model, versioned file format, and sidebar flow.

## Dependencies

- `FX-BF-005` — Sidebar project, board, and Git navigation.
- Existing project IPC and Electron native dialog contracts.

## Close conditions

- A user can create a workspace, switch between workspaces, and see only its projects.
- A workspace can be exported and reopened with provenance metadata intact.
- Newer unsupported schema versions fail closed without overwriting local data.
- Existing projects are available in an automatically-created `My Workspace`.
- Core, Electron, and frontend checks pass.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


