# FX-BF-040 — Connected agent workflow sessions and governed delivery

**Type:** Feature
**Status:** Planned
**Owner:** Electron desktop app

## Outcome

Connect session workflow selection to the governed workflow engine so Agent Hub
bindings, skills, runtime hosts, designers, gates, runs, artifacts, approvals,
and recovery describe one executable and auditable path.

## Stories

- [FX-BE-123 — Workflow selection and session/run linkage](stories/fx-be-123-workflow-selection-and-session-run-linkage/issue.md)
- [FX-BE-124 — Agent Hub host execution](stories/fx-be-124-agent-hub-host-execution/issue.md)
- [FX-BE-125 — Workflow packs and skill activation](stories/fx-be-125-workflow-packs-and-skill-activation/issue.md)
- [FX-BE-126 — Designer-to-run integration](stories/fx-be-126-designer-to-run-integration/issue.md)
- [FX-BE-127 — Gates, approvals, and run operations](stories/fx-be-127-gates-approvals-and-run-operations/issue.md)
- [FX-BE-128 — Migration, observability, and proof](stories/fx-be-128-migration-observability-and-proof/issue.md)

## Close condition

From a session, a user selects a ready governed workflow and compatible binding;
the app starts a durable run, executes attributed stage sessions through the
selected host and skills, enforces gates and approvals, and preserves the full
relationship after restart without changing legacy prompt-only sessions.
