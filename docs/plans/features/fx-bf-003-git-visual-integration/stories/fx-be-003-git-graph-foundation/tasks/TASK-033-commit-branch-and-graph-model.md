# TASK-033: Commit Branch And Graph Model

**Status:** Complete
**Depends on:** TASK-032
**Parallel with:** TASK-034 after serialized graph output is available

## Work

Implement typed Git records, stable parsing for commits/refs/details/diffs, parent-child indexing, branch tagging, deterministic lane assignment, and divergence/convergence markers.

## Done when

Fixture tests prove correct graph output for linear, branched, merged, detached, shallow, and multi-ref histories; layout output is deterministic for the same Git state.
