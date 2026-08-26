# TASK-032: System Git Runner And Repository Discovery

**Status:** Complete
**Depends on:** TASK-031
**Parallel with:** TASK-033 after contracts are stable

## Work

Implement argument-array subprocess execution, Git version/probe, workspace-to-repository discovery including worktrees, cancellation, bounded output, structured errors, and cache invalidation hooks.

## Done when

The runner is unit tested without shell interpolation and repository discovery handles normal repos, linked worktrees, missing Git, and non-repository folders.
