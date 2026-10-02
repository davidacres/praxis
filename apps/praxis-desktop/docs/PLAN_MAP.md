# Plan Map

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-003 | Feature | Git integration with visual commit graph and diff workspace | Complete | None |
| FX-BE-003 | Story | Desktop Git graph foundation and editor shell | Complete | FX-BF-003 |
| FX-BE-004 | Story | Praxis diff workspace and safe Git workflows | Complete | FX-BE-003 |
| FX-BF-004 | Feature | Project-scoped Git workspace and repository onboarding | Complete | FX-BF-003 |
| FX-BE-005 | Story | Project-scoped Git entry point and repository onboarding | Complete | FX-BF-004 |
| FX-BF-005 | Feature | Sidebar project, board, and Git navigation | Complete | FX-BF-004 |
| FX-BE-006 | Story | Sidebar-owned project, board, and Git tree | Complete | FX-BF-005 |
| TASK-031 | Task | Confirm desktop fit and visual contract | Complete | None |
| TASK-032 | Task | Implement Electron Git runner and repository discovery | Complete | TASK-031 |
| TASK-033 | Task | Implement commit, branch, and graph model | Complete | TASK-032 |
| TASK-034 | Task | Render desktop graph page with interaction states | Complete | TASK-033 |
| TASK-035 | Task | Add commit inspection and safe read-only actions | Complete | TASK-034 |
| TASK-036 | Task | Add Git mutations and refresh/error handling | Complete | TASK-035 |
| TASK-037 | Task | Verify performance, accessibility, and visual quality | Complete | TASK-034 |
| TASK-038 | Task | Structured comparison and patch model | Complete | FX-BE-003 |
| TASK-039 | Task | Clean responsive diff workspace | Complete | TASK-038 |
| TASK-040 | Task | WIP and granular change actions | Complete | TASK-038, TASK-039 |
| TASK-041 | Task | Graph-native workflows, history, and blame | Complete | TASK-039 |
| TASK-042 | Task | Three-way conflict resolution | Complete | TASK-038, TASK-041 |
| TASK-043 | Task | Verification, accessibility, and documentation | Complete | TASK-039, TASK-040, TASK-041, TASK-042 |
| TASK-044 | Task | Define project Git context and typed repository preflight contract | Complete | FX-BF-003 |
| TASK-045 | Task | Implement Electron repository classification and safe initialization/open actions | Complete | TASK-044 |
| TASK-046 | Task | Add project-scoped Git navigation and onboarding states | Complete | TASK-044 |
| TASK-047 | Task | Integrate onboarding with Graph/diff loading and friendly error recovery | Complete | TASK-045, TASK-046 |
| TASK-048 | Task | Add packaged Electron, accessibility, and responsive verification | Complete | TASK-046, TASK-047 |
| TASK-049 | Task | Refactor sidebar hierarchy for project-owned Boards and Git | Complete | FX-BF-004 |
| TASK-050 | Task | Replace center project navigation cards with focused project summary | Complete | TASK-049 |
| TASK-051 | Task | Connect Git child actions to Graph, Changes, and Conflict contexts | Complete | TASK-049 |
| TASK-052 | Task | Verify navigation semantics, accessibility, responsive layout, and migration snapshots | Complete | TASK-049, TASK-050, TASK-051 |
| FX-BF-006 | Feature | Praxis Atlas — explorable spatial multi-project workspace | Proposed | FX-BF-005 |
| FX-BF-008 | Feature | Project-details inspector and board surface controls | Complete | FX-BF-005 |
| FX-BE-009 | Story | Project-details inspector, theme-aware detail panes, per-board plain background, sidebar board removal, no-boards centre state | Complete | FX-BF-008 |
| FX-BE-007 | Story | Atlas spatial shell and continuous zoom vertical slice | Proposed | FX-BF-005 |
| TASK-053 | Task | Renderer stack spike and visual contract gate | Proposed | FX-BF-005 |
| TASK-054 | Task | Atlas snapshot model and builder in core | Proposed | TASK-053 |
| TASK-055 | Task | Deterministic orbital layout solver in core | Proposed | TASK-054 |
| TASK-056 | Task | Atlas scene, LOD tiers, and semantic-zoom camera | Proposed | TASK-053, TASK-055 |
| TASK-057 | Task | Node visual encoding and raycast selection into detail surfaces | Proposed | TASK-056 |
| TASK-058 | Task | Live activity pass and awaiting-approval signal | Proposed | TASK-056 |
| TASK-059 | Task | Atlas navigation integration and vertical-slice verification | Proposed | TASK-057, TASK-058 |
| FX-BF-009 | Feature | Agent Hub catalog and navigation | Complete | FX-BF-005 |
| FX-BE-010 | Story | Agent Hub navigation and scope-aware catalog | Complete | FX-BF-009 |
| FX-BE-011 | Story | Agent and skill detail, trust, and capabilities | Complete | FX-BF-009 |
| TASK-076 | Task | Implement Agent Hub shell and route | Complete | FX-BE-010 |
| TASK-077 | Task | Add scope-aware discovery tree | Complete | FX-BE-010 |
| TASK-078 | Task | Build agent and skill detail panes | Complete | FX-BE-011 |
| TASK-079 | Task | Define trust, capabilities, and settings boundary | Complete | FX-BE-011 |
| FX-BF-010 | Feature | Agent and skill creation | Complete | FX-BF-009 |
| FX-BE-012 | Story | Create Agent wizard and starter scaffold | Complete | FX-BF-010 |
| FX-BE-013 | Story | Create complete Skill package | Complete | FX-BF-010 |
| FX-BE-014 | Story | Import and validate runtime items | Complete | FX-BF-010 |
| TASK-080 | Task | Implement agent manifest wizard | Complete | FX-BE-012 |
| TASK-081 | Task | Generate transport starter scaffold | Complete | FX-BE-012 |
| TASK-082 | Task | Implement full skill package wizard | Complete | FX-BE-013 |
| TASK-083 | Task | Validate and safely write skill packages | Complete | FX-BE-013 |
| TASK-084 | Task | Add agent and skill import flow | Complete | FX-BE-014 |
| TASK-085 | Task | Enforce duplicate and path safety | Complete | FX-BE-014 |
| FX-BF-011 | Feature | Agent runtime and session integration | Complete | FX-BF-009, FX-BF-010 |
| FX-BE-015 | Story | Runtime lifecycle dashboard | Complete | FX-BF-011 |
| FX-BE-016 | Story | Skill activation and session handoff | Complete | FX-BF-011 |
| FX-BE-017 | Story | Advanced Settings boundary and verification | Complete | FX-BF-011 |
| TASK-086 | Task | Extend runtime status contracts | Complete | FX-BE-015 |
| TASK-087 | Task | Add start, stop, and restart controls | Complete | FX-BE-015 |
| TASK-088 | Task | Implement skill activation flow | Complete | FX-BE-016 |
| TASK-089 | Task | Add new-session agent selection | Complete | FX-BE-016 |
| TASK-090 | Task | Move runtime management to advanced Settings | Complete | FX-BE-017 |
| TASK-091 | Task | Add desktop E2E and accessibility verification | Complete | FX-BE-017 |
| FX-BF-012 | Feature | Governed agent delivery workflows | Complete | FX-BF-009, FX-BF-010, FX-BF-011 |
| FX-BE-018 | Story | Workflow definition, policy, and validation contracts | Complete | FX-BF-012 |
| FX-BE-019 | Story | Workflow execution, persistence, and recovery | Complete | FX-BE-012 |
| FX-BE-020 | Story | Agent session stages, gates, artifacts, and approvals | Complete | FX-BE-012 |
| FX-BE-021 | Story | Visual workflow designer and template library | Complete | FX-BE-012 |
| FX-BE-022 | Story | Run monitor, delivery template, and end-to-end verification | Complete | FX-BE-012 |
| TASK-092 | Task | Add workflow contract types | Complete | FX-BE-018 |
| TASK-093 | Task | Implement workflow validation and migration | Complete | FX-BE-018 |
| TASK-094 | Task | Add workflow and policy stores | Complete | FX-BE-018 |
| TASK-095 | Task | Implement WorkflowRun persistence | Complete | FX-BE-019 |
| TASK-096 | Task | Implement workflow scheduler and joins | Complete | FX-BE-019 |
| TASK-097 | Task | Add workflow retry and recovery controls | Complete | FX-BE-019 |
| TASK-098 | Task | Add stage agent preflight and binding | Complete | FX-BE-020 |
| TASK-099 | Task | Attribute sessions and typed artifacts to workflow stages | Complete | FX-BE-020 |
| TASK-100 | Task | Implement policy gates and approvals | Complete | FX-BE-020 |
| TASK-101 | Task | Add workflow template library | Complete | FX-BE-021 |
| TASK-102 | Task | Implement workflow canvas and inspector | Complete | FX-BE-021 |
| TASK-103 | Task | Add workflow persistence and accessibility verification | Complete | FX-BE-021 |
| TASK-104 | Task | Define the built-in governed delivery template | Complete | FX-BE-022 |
| TASK-105 | Task | Implement workflow run monitor and controls | Complete | FX-BE-022 |
| TASK-106 | Task | Add workflow E2E and delivery documentation | Complete | FX-BE-022 |
| FX-BE-023 | Story | Designer completion and folder persistence | Complete | FX-BE-021 |
| TASK-107 | Task | Run the full desktop suite and add designer/monitor visual snapshots | Complete | FX-BE-023 |
| TASK-108 | Task | Persist project workflows to .praxis/workflows with path safety and reload | Complete | FX-BE-023 |
| TASK-109 | Task | Add the Agent Hub picker and effective-policy display to the inspector | Complete | FX-BE-023 |
| TASK-110 | Task | Add the pan/zoom workflow canvas with draggable nodes and edges | Complete | FX-BE-023 |
| FX-BF-013 | Feature | Workflow orchestration runtime | Complete | FX-BF-012, FX-BE-023 |
| FX-BE-024 | Story | Orchestrator loop, check execution, and run worktrees | Complete | FX-BF-013 |
| FX-BE-025 | Story | Agent stage sessions and completion | Complete | FX-BF-013 |
| FX-BE-026 | Story | Live updates, timeouts, and end-to-end verification | Complete | FX-BF-013 |
| TASK-111 | Task | Add the WorkflowOrchestrator service and scheduler-driven dispatch | Complete | FX-BE-024 |
| TASK-112 | Task | Implement deterministic check execution and artifact capture | Complete | FX-BE-024 |
| TASK-113 | Task | Add the per-run git worktree lifecycle and frozen snapshots | Complete | FX-BE-024 |
| TASK-114 | Task | Implement WorkflowSessionPort over the agent hosts | Complete | FX-BE-025 |
| TASK-115 | Task | Wire stage completion, artifact extraction, and the snapshot commit | Complete | FX-BE-025 |
| TASK-116 | Task | Attribute stage sessions to their workflow run and node | Complete | FX-BE-025 |
| TASK-117 | Task | Add the workflows:runChanged push channel and monitor subscription | Complete | FX-BE-026 |
| TASK-118 | Task | Add the timeout enforcement tick | Complete | FX-BE-026 |
| TASK-119 | Task | Add the unattended-run E2E with a stub agent, and update the docs | Complete | FX-BE-026 |
| FX-BF-014 | Feature | Workflow experience — native designer and run monitor UI | Complete | FX-BF-012, FX-BF-013 |
| FX-BE-027 | Story | Shell integration and theming foundation | Complete | FX-BF-014 |
| FX-BE-028 | Story | Workflow Library and Designer | Complete | FX-BF-014 |
| FX-BE-029 | Story | Run Monitor | Complete | FX-BF-014 |
| FX-BE-030 | Story | States, accessibility, and theme verification | Complete | FX-BF-014 |
| TASK-120 | Task | Route workflow detail out of the global aux; add the Design/Runs header control | Complete | FX-BE-027 |
| TASK-121 | Task | Add wf- classes and kind-accent tokens; fix undefined --success/--warning | Complete | FX-BE-027 |
| TASK-122 | Task | Add the workflowView route field (run count badge folded into FX-BE-028) | Complete | FX-BE-027 |
| TASK-123 | Task | Build the Library card grid and template list with readiness | Complete | FX-BE-028 |
| TASK-124 | Task | Build the Designer: docked stage rail, canvas hero, sticky footer | Complete | FX-BE-028 |
| TASK-125 | Task | Move the inspector to pane-aux with the agent picker and policy display | Complete | FX-BE-028 |
| TASK-126 | Task | Build the run rail with live status dots and the start form | Complete | FX-BE-029 |
| TASK-127 | Task | Build the run board: sentence, pipeline diagram, gate ledger, timeline | Complete | FX-BE-029 |
| TASK-128 | Task | Build the stage detail panel with evidence and session link | Complete | FX-BE-029 |
| TASK-129 | Task | Implement the states matrix for all three screens | Complete | FX-BE-030 |
| TASK-130 | Task | Accessibility and focus-order pass | Complete | FX-BE-030 |
| TASK-131 | Task | Add the screens to the theme-gallery e2e and verify responsiveness | Complete | FX-BE-030 |
| FX-BF-015 | Feature | Session review, cost, and correction | Complete | FX-BF-014 |
| FX-BE-031 | Story | Verify and harden the ticket-to-agent flow | Complete | FX-BF-011 |
| FX-BE-032 | Story | Cost, context, and task visibility | Complete | FX-BF-015 |
| FX-BE-033 | Story | Review and correction controls | Complete | FX-BF-015 |
| FX-BF-016 | Feature | Packaging, GitHub backend, and agent proof-of-concept | Planned | FX-BF-015 |
| FX-BE-034 | Story | Signed auto-update | Blocked | — |
| FX-BE-035 | Story | Real GitHub backend | Complete | — |
| FX-BE-036 | Story | Prove multi-file and terminal-using agent paths | Planned | FX-BE-031 |
| FX-BF-017 | Feature | AI session UX and workflow ticket integration | Complete | FX-BF-015 |
| FX-BE-037 | Story | Command palette issue search | Complete | FX-BF-017 |
| FX-BE-038 | Story | Surface ACP session modes and slash commands | Complete | FX-BF-017 |
| FX-BE-039 | Story | Cost and token spend report | Complete | FX-BF-017 |
| FX-BE-040 | Story | Ticket-triggered workflow runs with outcome write-back | Complete | FX-BF-017 |
| FX-BE-041 | Story | Wire workflow failures into the Output tab's log bus | Complete | FX-BF-017 |
| FX-BF-018 | Feature | Add-on marketplace | In progress | None |
| FX-BE-042 | Story | GitHub Packages add-on marketplace | In progress | FX-BF-018 |
| FX-BF-019 | Feature | A project's workflow is data, authored once and rendered by every backend | Complete | — |
| FX-BE-043 | Story | Stage category as a first-class field | Complete | FX-BF-019 |
| FX-BE-044 | Story | Resolve a freeform status against a declared workflow | Complete | FX-BE-043 |
| FX-BE-045 | Story | Folder boards read their workflow instead of declaring it | Complete | FX-BE-044 |
| FX-BE-046 | Story | Editing a project's workflow | Complete | FX-BE-045 |
| FX-BE-047 | Story | PROJECT.md derived from the effective workflow | Complete | FX-BE-046 |
| FX-BF-020 | Feature | Praxis files are namespaced, and a workspace file is portable | Complete | — |
| FX-BE-048 | Story | A single naming rule for Praxis files | Complete | FX-BF-020 |
| FX-BE-049 | Story | Workspace files store in-tree paths relative to themselves | Complete | FX-BF-020 |
| FX-BE-050 | Story | A workspace file is .praxis.json, not .praxis | Complete | FX-BE-049 |

## Diagnosis, preview, deployment and debugging roadmap

Canonical sequencing and architectural decisions: [delivery roadmap](delivery-debugging-roadmap.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [TASK-132](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-132-define-evidence-identity-and-storage.md) | Task | Define evidence identity and storage | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-133](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-133-preserve-failed-process-evidence.md) | Task | Preserve failed process evidence | Planned | TASK-132 |
| [TASK-134](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-134-expose-evidence-in-the-run-monitor.md) | Task | Expose evidence in the run monitor | Planned | TASK-133 |
| [FX-BE-051](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/story.md) | Story | Failure evidence contracts and retained logs | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-135](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-135-create-diagnosis-sessions-from-evidence.md) | Task | Create diagnosis sessions from evidence | Planned | FX-BE-051 |
| [TASK-136](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-136-bound-repair-attempts-and-freshness.md) | Task | Bound repair attempts and freshness | Planned | TASK-135 |
| [TASK-137](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-137-show-diagnosis-and-verified-outcomes.md) | Task | Show diagnosis and verified outcomes | Planned | TASK-136 |
| [FX-BE-052](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/story.md) | Story | Bounded diagnose and verify workflow | Planned | FX-BE-051 |
| [TASK-138](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-138-define-read-only-ci-evidence-providers.md) | Task | Define read-only CI evidence providers | Planned | FX-BE-052 |
| [TASK-139](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-139-add-failure-selection-and-refresh.md) | Task | Add failure selection and refresh | Planned | TASK-138 |
| [TASK-140](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-140-connect-ci-evidence-to-diagnosis.md) | Task | Connect CI evidence to diagnosis | Planned | TASK-139 |
| [FX-BE-053](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/story.md) | Story | Import CI failures with exact run provenance | Planned | FX-BE-052 |
| [FX-BF-021](/apps/praxis-desktop/docs/plans/features/fx-bf-021-failure-diagnosis/feature.md) | Feature | Reproducible failure diagnosis and verification evidence | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-141](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-141-define-run-profile-schema.md) | Task | Define run profile schema | Planned | FX-BF-021 |
| [TASK-142](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-142-resolve-launch-configuration.md) | Task | Resolve launch configuration | Planned | TASK-141 |
| [TASK-143](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-143-build-project-run-profile-editor.md) | Task | Build project Run profile editor | Planned | TASK-142 |
| [FX-BE-054](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/story.md) | Story | Portable run profiles and readiness contracts | Planned | FX-BF-021 |
| [TASK-144](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-144-implement-process-lifecycle-manager.md) | Task | Implement process lifecycle manager | Planned | FX-BE-054 |
| [TASK-145](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-145-add-explicit-preview-origin-grants.md) | Task | Add explicit preview origin grants | Planned | TASK-144 |
| [TASK-146](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-146-integrate-run-controls-and-recovery.md) | Task | Integrate Run controls and recovery | Planned | TASK-145 |
| [FX-BE-055](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/story.md) | Story | Managed service lifecycle and scoped preview access | Planned | FX-BE-054 |
| [TASK-147](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-147-capture-scoped-browser-evidence.md) | Task | Capture scoped browser evidence | Planned | FX-BE-055 |
| [TASK-148](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-148-expose-diagnostics-to-agents.md) | Task | Expose diagnostics to agents | Planned | TASK-147 |
| [TASK-149](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-149-add-preview-verification-workflow.md) | Task | Add preview verification workflow | Planned | TASK-148 |
| [FX-BE-056](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/story.md) | Story | Browser diagnostics and repeatable verification | Planned | FX-BE-055 |
| [FX-BF-022](/apps/praxis-desktop/docs/plans/features/fx-bf-022-managed-run-and-preview/feature.md) | Feature | Managed project runs and diagnostic browser previews | Planned | FX-BF-021 |
| [TASK-150](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-150-define-deployment-domain-contracts.md) | Task | Define deployment domain contracts | Planned | FX-BF-021 |
| [TASK-151](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-151-persist-portable-profiles-and-references.md) | Task | Persist portable profiles and references | Planned | TASK-150 |
| [TASK-152](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-152-separate-publish-from-deploy.md) | Task | Separate publish from deploy | Planned | TASK-151 |
| [FX-BE-057](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/story.md) | Story | Independent deployment profiles and immutable artifacts | Planned | FX-BF-021 |
| [TASK-153](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-153-add-deployment-transitions-and-policy.md) | Task | Add deployment transitions and policy | Planned | FX-BE-057 |
| [TASK-154](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-154-persist-side-effects-and-reconcile.md) | Task | Persist side effects and reconcile | Planned | TASK-153 |
| [TASK-155](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-155-integrate-workflow-designer-and-monitor.md) | Task | Integrate workflow designer and monitor | Planned | TASK-154 |
| [FX-BE-058](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/story.md) | Story | Durable deployment state and workflow operations | Planned | FX-BE-057 |
| [TASK-156](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-156-implement-direct-process-executor.md) | Task | Implement direct process executor | Planned | FX-BE-058 |
| [TASK-157](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-157-add-local-directory-target-and-health-verification.md) | Task | Add local directory target and health verification | Planned | TASK-156 |
| [TASK-158](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-158-expose-direct-deployment-actions.md) | Task | Expose direct deployment actions | Planned | TASK-157 |
| [FX-BE-059](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/story.md) | Story | Script-based direct deployment executor | Planned | FX-BE-058 |
| [TASK-159](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-159-build-profile-selection-and-review.md) | Task | Build profile selection and review | Planned | FX-BE-059 |
| [TASK-160](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-160-add-deployment-history-and-promotion.md) | Task | Add deployment history and promotion | Planned | TASK-159 |
| [TASK-161](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-161-verify-complete-direct-delivery-journey.md) | Task | Verify complete direct delivery journey | Planned | TASK-160 |
| [FX-BE-060](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/story.md) | Story | Deployment profile and history experience | Planned | FX-BE-059 |
| [FX-BF-023](/apps/praxis-desktop/docs/plans/features/fx-bf-023-project-deployment-foundation/feature.md) | Feature | Project deployment profiles and direct execution | Planned | FX-BF-021 |
| [TASK-162](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-162-implement-workflow-discovery-and-dispatch.md) | Task | Implement workflow discovery and dispatch | Planned | FX-BF-023 |
| [TASK-163](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-163-observe-existing-continuous-deployments.md) | Task | Observe existing continuous deployments | Planned | TASK-162 |
| [TASK-164](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-164-map-logs-and-verified-results.md) | Task | Map logs and verified results | Planned | TASK-163 |
| [FX-BE-061](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/story.md) | Story | GitHub Actions deployment executor | Planned | FX-BF-023 |
| [TASK-165](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-165-implement-pipeline-preflight-and-trigger.md) | Task | Implement pipeline preflight and trigger | Planned | FX-BE-061 |
| [TASK-166](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-166-observe-pipelines-and-environments.md) | Task | Observe pipelines and environments | Planned | TASK-165 |
| [TASK-167](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-167-prove-cross-provider-parity.md) | Task | Prove cross-provider parity | Planned | TASK-166 |
| [FX-BE-062](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/story.md) | Story | GitLab CI deployment executor | Planned | FX-BE-061 |
| [TASK-168](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-168-build-provider-configuration-forms.md) | Task | Build provider configuration forms | Planned | FX-BE-062 |
| [TASK-169](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-169-reconcile-external-runs-on-reopen.md) | Task | Reconcile external runs on reopen | Planned | TASK-168 |
| [TASK-170](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-170-verify-cd-and-deployment-journeys.md) | Task | Verify CD and deployment journeys | Planned | TASK-169 |
| [FX-BE-063](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/story.md) | Story | Pipeline setup and recovery experience | Planned | FX-BE-062 |
| [FX-BF-024](/apps/praxis-desktop/docs/plans/features/fx-bf-024-pipeline-managed-deployment/feature.md) | Feature | Pipeline-managed deployment and continuous delivery observation | Planned | FX-BF-023 |
| [TASK-171](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-171-define-iis-target-and-prerequisites.md) | Task | Define IIS target and prerequisites | Planned | FX-BF-023 |
| [TASK-172](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-172-validate-target-boundaries-and-credentials.md) | Task | Validate target boundaries and credentials | Planned | TASK-171 |
| [TASK-173](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-173-build-iis-profile-template.md) | Task | Build IIS profile template | Planned | TASK-172 |
| [FX-BE-064](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/story.md) | Story | IIS capability preflight and target configuration | Planned | FX-BF-023 |
| [TASK-174](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-174-implement-staged-iis-installation.md) | Task | Implement staged IIS installation | Planned | FX-BE-064 |
| [TASK-175](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-175-verify-health-and-retain-recovery-evidence.md) | Task | Verify health and retain recovery evidence | Planned | TASK-174 |
| [TASK-176](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-176-implement-explicit-rollback-procedure.md) | Task | Implement explicit rollback procedure | Planned | TASK-175 |
| [FX-BE-065](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/story.md) | Story | IIS install health and explicit rollback | Planned | FX-BE-064 |
| [TASK-177](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-177-add-windows-iis-fixture-workflow.md) | Task | Add Windows IIS fixture workflow | Planned | FX-BE-065 |
| [TASK-178](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-178-exercise-direct-and-pipeline-target-journeys.md) | Task | Exercise direct and pipeline target journeys | Planned | TASK-177 |
| [TASK-179](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-179-document-supported-methods-and-recovery.md) | Task | Document supported methods and recovery | Planned | TASK-178 |
| [FX-BE-066](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/story.md) | Story | IIS end-to-end proof and operational guidance | Planned | FX-BE-065 |
| [FX-BF-025](/apps/praxis-desktop/docs/plans/features/fx-bf-025-iis-deployment-target/feature.md) | Feature | IIS deployment target and recovery templates | Planned | FX-BF-023 |
| [TASK-180](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-180-define-debug-session-model.md) | Task | Define debug session model | Planned | FX-BF-022 |
| [TASK-181](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-181-prove-node-and-net-adapter-choices.md) | Task | Prove Node and .NET adapter choices | Planned | TASK-180 |
| [TASK-182](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-182-define-trusted-adapter-configuration.md) | Task | Define trusted adapter configuration | Planned | TASK-181 |
| [FX-BE-067](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/story.md) | Story | Debugger contracts and adapter capability proof | Planned | FX-BF-022 |
| [TASK-183](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-183-implement-protocol-and-lifecycle.md) | Task | Implement protocol and lifecycle | Planned | FX-BE-067 |
| [TASK-184](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-184-implement-breakpoints-and-inspection.md) | Task | Implement breakpoints and inspection | Planned | TASK-183 |
| [TASK-185](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-185-expose-typed-debugger-ipc.md) | Task | Expose typed debugger IPC | Planned | TASK-184 |
| [FX-BE-068](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/story.md) | Story | DAP service and Node TypeScript debugging | Planned | FX-BE-067 |
| [TASK-186](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-186-build-debugging-surface.md) | Task | Build debugging surface | Planned | FX-BE-068 |
| [TASK-187](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-187-integrate-net-launch-and-attach.md) | Task | Integrate .NET launch and attach | Planned | TASK-186 |
| [TASK-188](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-188-verify-interactive-workflows.md) | Task | Verify interactive workflows | Planned | TASK-187 |
| [FX-BE-069](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/story.md) | Story | Debug workspace and .NET support | Planned | FX-BE-068 |
| [TASK-189](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-189-expose-narrow-debug-tools.md) | Task | Expose narrow debug tools | Planned | FX-BE-069 |
| [TASK-190](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-190-separate-inspection-from-evaluation.md) | Task | Separate inspection from evaluation | Planned | TASK-189 |
| [TASK-191](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-191-connect-debugger-evidence-to-diagnosis.md) | Task | Connect debugger evidence to diagnosis | Planned | TASK-190 |
| [FX-BE-070](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/story.md) | Story | Controlled agent debugging tools | Planned | FX-BE-069 |
| [FX-BF-026](/apps/praxis-desktop/docs/plans/features/fx-bf-026-interactive-agent-debugging/feature.md) | Feature | Interactive and agent-assisted runtime debugging | Planned | FX-BF-022 |
| [TASK-192](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-192-audit-supported-agent-protocol-capabilities.md) | Task | Audit supported agent protocol capabilities | Backlog | FX-BF-024, FX-BF-026 |
| [TASK-193](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-193-prototype-optional-codex-app-server-adapter.md) | Task | Prototype optional Codex App Server adapter | Backlog | TASK-192 |
| [TASK-194](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-194-add-recovery-and-attempt-level-usage-presentation.md) | Task | Add recovery and attempt-level usage presentation | Backlog | TASK-193 |
| [FX-BE-071](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/story.md) | Story | Capability-led session recovery and cost attribution | Backlog | FX-BF-024, FX-BF-026 |
| [TASK-195](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-195-define-event-subscription-and-deduplication.md) | Task | Define event subscription and deduplication | Backlog | FX-BE-071 |
| [TASK-196](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-196-apply-automation-limits-and-approval-boundaries.md) | Task | Apply automation limits and approval boundaries | Backlog | TASK-195 |
| [TASK-197](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-197-verify-opt-in-event-journeys.md) | Task | Verify opt-in event journeys | Backlog | TASK-196 |
| [FX-BE-072](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/story.md) | Story | Event-triggered bounded failure repair | Backlog | FX-BE-071 |
| [TASK-198](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-198-define-runner-trust-and-capability-contract.md) | Task | Define runner trust and capability contract | Backlog | FX-BE-072 |
| [TASK-199](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-199-prototype-one-controlled-remote-execution-path.md) | Task | Prototype one controlled remote execution path | Backlog | TASK-198 |
| [TASK-200](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-200-record-rollout-decision-and-remaining-work.md) | Task | Record rollout decision and remaining work | Backlog | TASK-199 |
| [FX-BE-073](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/story.md) | Story | Shared executor feasibility and runner boundary | Backlog | FX-BE-072 |
| [FX-BF-027](/apps/praxis-desktop/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/feature.md) | Feature | Deferred execution reliability and automation extensions | Backlog | FX-BF-024, FX-BF-026 |

## Full SDLC quality and security gates

Canonical sequencing and architectural decisions: [SDLC quality gates roadmap](sdlc-quality-gates-roadmap.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [TASK-237](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-237-define-check-findings-contract-and-artifact-kind.md) | Task | Define the CheckFindings contract and the findings artifact kind | Planned | FX-BE-020, FX-BE-024 |
| [TASK-238](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-238-add-result-format-adapters.md) | Task | Add SARIF / JUnit / lcov / npm-audit / osv-scanner adapters | Planned | TASK-237 |
| [TASK-239](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-239-add-metric-and-severity-threshold-gates.md) | Task | Add metric and severity threshold gate policy | Planned | TASK-237 |
| [TASK-240](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-240-render-findings-and-metrics-in-the-run-monitor.md) | Task | Render findings and metrics in the run monitor | Planned | TASK-238, TASK-239 |
| [FX-BE-087](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/story.md) | Story | Structured check results and threshold gates | Planned | FX-BE-020, FX-BE-024 |
| [TASK-241](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-241-add-secret-sast-sca-and-license-check-presets.md) | Task | Add secret / SAST / SCA / license check presets with stack detection | Planned | FX-BE-087 |
| [TASK-242](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-242-add-an-audited-waiver-register.md) | Task | Add an audited, expiring waiver register | Planned | TASK-241 |
| [TASK-243](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-243-compose-the-security-gate-over-enabled-scanners.md) | Task | Compose the security gate over the union of enabled scanners | Planned | TASK-242 |
| [FX-BE-088](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/story.md) | Story | Bundled security scanners behind the security gate | Planned | FX-BE-087 |
| [TASK-244](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-244-define-the-structured-reviewer-artifact-contract.md) | Task | Define the structured reviewer artifact contract | Planned | FX-BE-087 |
| [TASK-245](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-245-deliver-review-findings-as-inline-comments.md) | Task | Deliver review findings as inline PR / ticket comments with dedupe | Planned | TASK-244 |
| [TASK-246](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-246-add-a-bounded-review-fix-loop.md) | Task | Add a bounded review to implement fix loop | Planned | TASK-245 |
| [FX-BE-089](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/story.md) | Story | Structured code review and inline delivery | Planned | FX-BE-087, FX-BE-033 |
| [TASK-247](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-247-ship-bundled-trusted-agent-manifests.md) | Task | Ship bundled trusted agent manifests | Planned | FX-BE-011 |
| [TASK-248](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-248-add-the-full-sdlc-workflow-template.md) | Task | Add the full-sdlc workflow template | Planned | TASK-247, FX-BE-088, FX-BE-089 |
| [TASK-249](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-249-add-per-stack-template-variants.md) | Task | Add Node / .NET / Python template variants | Planned | TASK-248 |
| [FX-BE-090](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/story.md) | Story | Bundled agents and a Full SDLC template | Planned | FX-BE-088, FX-BE-089, FX-BE-011 |
| [TASK-250](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-250-add-read-only-ci-quality-and-security-providers.md) | Task | Add read-only CI quality and security report providers | Planned | FX-BE-053 |
| [TASK-251](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-251-map-imported-reports-to-findings-evidence.md) | Task | Map imported reports to findings evidence bound to the SHA | Planned | TASK-250, TASK-237 |
| [TASK-252](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-252-add-an-observe-mode-gate-on-ci-evidence.md) | Task | Add an observe-mode gate resting on imported CI evidence | Planned | TASK-251, TASK-239 |
| [FX-BE-091](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/story.md) | Story | Ingest CI security and quality reports | Planned | FX-BE-087, FX-BE-053 |
| [FX-BF-034](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/feature.md) | Feature | Full SDLC quality and security gates | Planned | FX-BE-020, FX-BE-024, FX-BE-033 |


## Praxis Mobile companion

The mobile initiative has its own folder-backed PRAXISMOBILE project at [apps/praxis-mobile](../apps/praxis-mobile/README.md). Its canonical [Plan Map](../apps/praxis-mobile/docs/PLAN_MAP.md) and [master plan](../apps/praxis-mobile/docs/plans/master-plan.md) contain 6 features, 13 stories and 36 tasks: FX-BF-028–033, FX-BE-074–086, TASK-201–236. Local work is planned first; cloud integration is deferred.

The root desktop board is unchanged. Add the mobile folder as a separate project to see its work. No dependency on the deferred shared-executor or deployment/debugging roadmap is implied.

**Status as of 2026-09-10, updated 2026-09-12.** FX-BF-028 (execution host and
protocol) is done and tested: the Noise `IK` secure transport
(`@praxis/mobile-protocol`, verified against the canonical `snow` vectors), the
real LAN listener, and the host bound to the live stores. FX-BF-029 and
FX-BF-031–033 stay In Progress — there is now a React Native app
(`apps/praxis-mobile`, Expo SDK 57) that builds and runs (verified booting and
rendering in the iOS Simulator), but it talks to canned demo data only, not a
real socket; LAN discovery and the real pairing adapters (QR, keychain) are
still missing; and `sessions.continue` / `permissions.respond` /
`workflowRuns.start` remain deferred pending the permission request-id rework.
See the mobile [Plan Map](../apps/praxis-mobile/docs/PLAN_MAP.md) for the
per-story breakdown and
[development.md's "Resume here"](../apps/praxis-mobile/docs/development.md#resume-here-2026-09-12)
for the exact next steps.

## Local-first priority (2026-09-09)

GenericSystem and Roleover are not running. Deliver account-free LAN pairing, mobile continuation, workflow execution, decisions and a usable local release before cloud integration. No local completion gate requires these services or Azure. Keep internet features unavailable until the real integration is verified; use fixtures only for development. FX-BF-030 is deferred, including optional notifications moved to FX-BE-086. See the mobile master plan for the revised order.


## Multi-AI session orchestration

Canonical sequencing and architectural decisions: [multi-AI orchestration roadmap](multi-ai-session-orchestration-roadmap.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-035 | Feature | Multi-AI session orchestration across Claude, Codex and Copilot | Planned | FX-BF-011, FX-BF-012, FX-BF-013, FX-BF-015, FX-BF-019 |
| FX-BE-092 | Story | Shared session context and handoff contracts | Planned | FX-BF-011, FX-BF-019 |
| FX-BE-093 | Story | Provider adapters and capability preflight | Planned | FX-BE-092 |
| FX-BE-094 | Story | Worktree, file claims and change governance | Planned | FX-BE-092, FX-BF-003 |
| FX-BE-095 | Story | Orchestration runtime, task graph and recovery | Planned | FX-BE-093, FX-BE-094, FX-BF-013 |
| FX-BE-115 | Story | Continuous session handover, model switching and living brief | Complete | FX-BE-092, FX-BE-093, FX-BF-015, FX-BF-017 |
| FX-BE-096 | Story | Session operations and review experience | Planned | FX-BE-095, FX-BE-115, FX-BF-014, FX-BF-015 |
| FX-BE-122 | Story | Opt-in multi-AI conversation in one session | Complete | FX-BE-115, FX-BE-092, FX-BF-015, FX-BF-017 |
| TASK-253 | Task | Define shared session contracts | Planned | FX-BE-092 |
| TASK-254 | Task | Generate bounded context snapshots | Planned | TASK-253 |
| TASK-255 | Task | Generate provider-specific prompts | Planned | TASK-254 |
| TASK-256 | Task | Validate handoffs and redact evidence | Planned | TASK-255 |
| TASK-257 | Task | Define provider adapter contracts | Planned | FX-BE-092 |
| TASK-258 | Task | Implement Codex adapter | Planned | TASK-257 |
| TASK-259 | Task | Implement Claude Code adapter | Planned | TASK-257 |
| TASK-260 | Task | Implement Copilot adapter and fallback | Planned | TASK-257 |
| TASK-261 | Task | Add provider capability preflight | Planned | TASK-257 |
| TASK-262 | Task | Implement session worktree lifecycle | Planned | FX-BE-092, FX-BF-003 |
| TASK-263 | Task | Add path claims and overlap detection | Planned | TASK-262 |
| TASK-264 | Task | Capture Git change-set evidence | Planned | TASK-262 |
| TASK-265 | Task | Prepare merge candidates and conflicts | Planned | TASK-264 |
| TASK-266 | Task | Implement dependency-aware scheduler | Planned | FX-BE-093, FX-BE-094 |
| TASK-267 | Task | Add redacted append-only event log | Planned | TASK-266 |
| TASK-268 | Task | Implement timeout and recovery policies | Planned | TASK-267 |
| TASK-269 | Task | Add stage joins and handoff gates | Planned | TASK-266, TASK-268 |
| TASK-270 | Task | Add deterministic stub-agent workflow | Planned | TASK-269 |
| TASK-271 | Task | Add session monitor and live events | Planned | FX-BE-095 |
| TASK-272 | Task | Add context and change inspection | Planned | TASK-271 |
| TASK-273 | Task | Add safe session operations | Planned | TASK-271 |
| TASK-274 | Task | Add merge-readiness ledger | Planned | TASK-272, TASK-273 |
| TASK-275 | Task | Add accessibility and E2E verification | Planned | TASK-274 |
| TASK-322 | Task | Add purpose, living-brief and runtime-epoch session contracts | Complete | FX-BE-115, FX-BE-092 |
| TASK-323 | Task | Refresh a revision-safe living brief after every completed turn | Complete | TASK-322 |
| TASK-324 | Task | Change models between turns with runtime epochs | Complete | TASK-322, FX-BE-093 |
| TASK-325 | Task | Hand a continuous session between providers | Complete | TASK-322, TASK-323, FX-BE-092, FX-BE-093 |
| TASK-326 | Task | Show purpose, brief, history and transition controls | Complete | TASK-322, TASK-323, TASK-324, TASK-325, FX-BF-015 |
| TASK-327 | Task | Integrate session entry points, attribution and recovery | Complete | TASK-323, TASK-324, TASK-325, FX-BF-012, FX-BF-013 |
| TASK-328 | Task | Prove handover, model switch and living brief in e2e | Complete | TASK-326, TASK-327 |
| TASK-329 | Task | Add conversation, participant and speaker-attribution contracts | Complete | FX-BE-122, FX-BE-115, FX-BE-092 |
| TASK-330 | Task | Host bounded turn-taking between two providers | Complete | TASK-329, TASK-325 |
| TASK-331 | Task | Render each AI as a distinct speaker in chat | Complete | TASK-329, FX-BF-015, FX-BF-017 |
| TASK-332 | Task | Add Bring in another AI, stop and tool-owner controls | Complete | TASK-330, TASK-331 |
| TASK-333 | Task | Enforce tool ownership, turn cap and spend visibility | Complete | TASK-330, TASK-332 |
| TASK-334 | Task | Prove conversation, identity and safety end to end | Complete | TASK-331, TASK-332, TASK-333 |

## Interactive chat gadgets

Canonical sequencing and architectural decisions: [interactive chat gadgets roadmap](interactive-chat-gadgets-roadmap.md).
Delivered pipeline and extension guidance: [interactive chat gadgets](interactive-chat-gadgets.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-036 | Feature | Interactive chat gadgets and response surfaces | Complete | FX-BF-014, FX-BF-015, FX-BF-035 |
| FX-BE-097 | Story | Versioned gadget and action contracts | Done | FX-BF-014, FX-BF-015 |
| FX-BE-098 | Story | Renderer registry and core chat surfaces | Done | FX-BE-097 |
| FX-BE-099 | Story | Safe action lifecycle, scope and stale-state handling | Done | FX-BE-097, FX-BF-013 |
| FX-BE-100 | Story | Workflow, agent and orchestration integration | Done | FX-BE-099, FX-BF-035 |
| FX-BE-101 | Story | Accessibility, mobile, fixtures and end-to-end proof | Done | FX-BE-098, FX-BE-100 |
| TASK-276 | Task | Define ChatBlock, GadgetEnvelope and GadgetScope contracts | Done | FX-BE-097 |
| TASK-277 | Task | Define GadgetAction, result and fallback contracts | Done | TASK-276 |
| TASK-278 | Task | Validate payload size, schema, capability and safety policy | Done | TASK-277 |
| TASK-279 | Task | Implement the browser-safe gadget renderer registry | Done | FX-BE-098 |
| TASK-280 | Task | Implement choice, confirmation, table and progress renderers | Done | TASK-279 |
| TASK-281 | Task | Implement chart, diff, artifact and handoff renderers | Done | TASK-280 |
| TASK-282 | Task | Route gadget actions through the command ledger | Done | FX-BE-099 |
| TASK-283 | Task | Enforce scope, authorization and policy boundaries | Done | TASK-282 |
| TASK-284 | Task | Handle expiry, supersession, reconnect and duplicate submission | Done | TASK-283 |
| TASK-285 | Task | Add expected-response declarations to workflows and sessions | Done | FX-BE-100 |
| TASK-286 | Task | Integrate provider responses and multi-AI handoffs | Done | TASK-285 |
| TASK-287 | Task | Connect gadgets to run monitor, changes and deployment decisions | Done | TASK-286 |
| TASK-288 | Task | Add accessibility and responsive visual verification | Done | FX-BE-101 |
| TASK-289 | Task | Create deterministic gadget fixture workflows and contract tests | Done | TASK-288 |
| TASK-290 | Task | Prove desktop/mobile end-to-end journeys and document operations | Done | TASK-289 |

| FX-BF-037 | Feature | Rearrangeable panel layout | Proposed | FX-BF-005, FX-BF-008, FX-BF-017 |
| FX-BE-102 | Story | Panel and layout region model | Proposed | FX-BF-005 |
| FX-BE-103 | Story | Generic panel shells and content adapters | Proposed | FX-BE-102 |
| FX-BE-104 | Story | Drag-and-drop docking interactions | Proposed | FX-BE-103 |
| FX-BE-105 | Story | Persisted layout settings | Proposed | FX-BE-102, FX-BF-017 |
| FX-BE-106 | Story | Accessibility, theming and verification | Proposed | FX-BE-104, FX-BE-105 |
| TASK-291 | Task | Define PanelId, RegionId, and layout config types | Proposed | FX-BE-102 |
| TASK-292 | Task | Refactor App.tsx to render regions from the layout config | Proposed | TASK-291 |
| TASK-293 | Task | Provide a default layout config and reset-to-default path | Proposed | TASK-291, TASK-292 |
| TASK-294 | Task | Build a generic PanelShell component | Proposed | FX-BE-103 |
| TASK-295 | Task | Wrap existing panes as PanelShell-hosted adapters | Proposed | TASK-294 |
| TASK-296 | Task | Give main/routed content a title bar equivalent to other panels | Proposed | TASK-294, TASK-295 |
| TASK-297 | Task | Add drag-and-drop wiring to PanelShell and region containers | Proposed | FX-BE-104 |
| TASK-298 | Task | Render region drop-zone affordances during an active drag | Proposed | TASK-297 |
| TASK-299 | Task | Add a keyboard-accessible Move panel to… menu | Proposed | TASK-297 |
| TASK-300 | Task | Extend AppSettings with a layout field in core | Proposed | FX-BE-105 |
| TASK-301 | Task | Mirror the layout field in settingsDefaults.ts and wire IPC | Proposed | TASK-300 |
| TASK-302 | Task | Load persisted layout on startup and save debounced on change | Proposed | TASK-300, TASK-301 |
| TASK-303 | Task | Add ARIA roles, labels and announcements for panel drag/drop | Proposed | FX-BE-106 |
| TASK-304 | Task | Verify PanelShell chrome across the theme/mode/surface-pack matrix | Proposed | FX-BE-104 |
| TASK-305 | Task | Add end-to-end journey coverage and update documentation | Proposed | TASK-303, TASK-304 |

| FX-BF-038 | Feature | Separate providers, runtime hosts, agent profiles and skills | Complete | FX-BF-009, FX-BF-010, FX-BF-011, FX-BF-013, FX-BF-035 |
| FX-BE-115 | Story | Canonical contracts and terminology | Implemented | FX-BF-038 |
| FX-BE-116 | Story | Legacy manifest and profile migration | Implemented | FX-BE-115 |
| FX-BE-117 | Story | Provider and runtime-host adapter binding | Implemented | FX-BE-115 |
| FX-BE-118 | Story | Skill activation and fallback execution | Implemented | FX-BE-117 |
| FX-BE-119 | Story | Workflow and session persistence migration | Implemented | FX-BE-116, FX-BE-117 |
| FX-BE-120 | Story | Agent Hub, designer and composer UX | Implemented | FX-BE-119 |
| FX-BE-121 | Story | End-to-end compatibility and documentation | Implemented | FX-BE-118, FX-BE-120 |

| FX-BF-039 | Feature | Import Claude Code / Copilot plugins; add a visual, native cross-provider hook engine | Proposed | FX-BF-009, FX-BF-018, FX-BF-038 |
| FX-BE-107 | Story | Plugin marketplace contracts and source resolution | Proposed | FX-BF-018 |
| TASK-306 | Task | Define plugin source, marketplace entry, and manifest contracts | Proposed | FX-BE-107 |
| TASK-307 | Task | Implement marketplace source resolution and caching | Proposed | TASK-306 |
| FX-BE-108 | Story | Agent/skill/MCP conversion into canonical contracts | Proposed | FX-BE-107, FX-BF-038 |
| TASK-308 | Task | Convert agents/*.md and SKILL.md into AgentProfile/AgentSkillRef | Proposed | FX-BE-108, TASK-307 |
| TASK-309 | Task | Import .mcp.json entries into Praxis's MCP server config | Proposed | FX-BE-108 |
| FX-BE-109 | Story | Visual design exploration | Proposed | FX-BE-108 |
| TASK-310 | Task | Design the marketplace browsing, preview, and trust-diff experience | Proposed | FX-BE-109 |
| TASK-311 | Task | Design the visual hook builder and hook management surfaces | Proposed | FX-BE-109 |
| FX-BE-110 | Story | Agent Hub marketplace card UX | Proposed | FX-BE-109, FX-BE-108 |
| TASK-312 | Task | Build the marketplace card grid and provenance display | Proposed | FX-BE-110, TASK-310, TASK-307 |
| TASK-313 | Task | Build the preview-before-install and trust-diff flow | Proposed | TASK-312, TASK-310 |
| FX-BE-111 | Story | Native cross-provider hook engine | Proposed | FX-BF-038 |
| TASK-314 | Task | Define the native hook event/matcher/action contract | Proposed | FX-BE-111 |
| TASK-315 | Task | Execute native hooks against every runtime host's session pipeline | Proposed | TASK-314 |
| FX-BE-112 | Story | Visual hook builder and management UI | Proposed | FX-BE-109, FX-BE-111 |
| TASK-316 | Task | Build the visual hook builder | Proposed | FX-BE-112, TASK-311, TASK-314 |
| TASK-317 | Task | Build the hook management view | Proposed | TASK-316 |
| FX-BE-113 | Story | Claude Code hook passthrough and best-effort import | Proposed | FX-BE-108, FX-BE-111, FX-BE-112 |
| TASK-318 | Task | Pass hooks.json straight through to Claude Code CLI | Proposed | FX-BE-113, TASK-308 |
| TASK-319 | Task | Best-effort translate hooks.json into the native hook format | Proposed | TASK-314, TASK-318, TASK-317 |
| FX-BE-114 | Story | Trust, security, and verification | Proposed | FX-BE-110, FX-BE-113 |
| TASK-320 | Task | Extend trust-on-install to imported plugins and hook scripts | Proposed | FX-BE-114, TASK-313, TASK-316, TASK-318, TASK-319, TASK-309 |
| TASK-321 | Task | Deterministic fixtures, full e2e coverage, and documentation | Proposed | TASK-320 |

## Connected agent workflow sessions

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-040 | Feature | Connected agent workflow sessions and governed delivery | Proposed | FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-038 |
| FX-BE-123 | Story | Workflow selection and session/run linkage | Planned | FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-038 |
| TASK-335 | Task | Define workflow-selection, controller-session, and run-link contracts | Planned | FX-BE-123 |
| TASK-336 | Task | Add session composer workflow selection, readiness, and start flow | Planned | TASK-335 |
| TASK-337 | Task | Persist and navigate controller, stage, run, and node attribution | Planned | TASK-335, TASK-336 |
| FX-BE-124 | Story | Agent Hub host execution for interactive and stage sessions | Planned | FX-BF-011, FX-BF-013, FX-BF-038 |
| TASK-338 | Task | Define and implement the runtime-host adapter launch contract | Planned | FX-BE-124 |
| TASK-339 | Task | Route interactive delegation and workflow stages through one launch compiler | Planned | TASK-338 |
| TASK-340 | Task | Enforce host scope, trust, capability, sandbox, and tool-mode preflight | Planned | TASK-338, TASK-339 |
| FX-BE-125 | Story | Workflow packs and skill activation inside governed stages | Planned | FX-BF-010, FX-BF-011, FX-BF-012, FX-BF-038 |
| TASK-341 | Task | Resolve workflow packs into stage task context and provenance | Planned | FX-BE-125 |
| TASK-342 | Task | Compile skill activation and record native/tool/context outcomes | Planned | TASK-340 |
| TASK-343 | Task | Migrate legacy issue workflow-pack assignments safely | Planned | TASK-341 |
| FX-BE-126 | Story | Workflow Designer and Task Designer integration | Planned | FX-BF-012, FX-BF-014, FX-BF-015, FX-BF-017 |
| TASK-344 | Task | Share runtime readiness and dependency contracts with Workflow Designer | Planned | TASK-340 |
| TASK-345 | Task | Add explicit Task Designer plan-to-workflow input and promotion flow | Planned | TASK-335, TASK-344 |
| TASK-346 | Task | Add cross-surface navigation and run/session provenance | Planned | TASK-337, TASK-345 |
| FX-BE-127 | Story | Gate evaluation, approvals, and run operations | Planned | FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-034 |
| TASK-347 | Task | Make gate outcomes and evidence node-specific and durable | Planned | TASK-341 |
| TASK-348 | Task | Implement explicit approval and bypass target handling and policy checks | Planned | TASK-347 |
| TASK-349 | Task | Harden run monitor operations, recovery, retry, timeout, and audit events | Planned | TASK-337, TASK-348 |
| FX-BE-128 | Story | Migration, observability, compatibility, and end-to-end proof | Planned | FX-BE-123, FX-BE-124, FX-BE-125, FX-BE-126, FX-BE-127 |
| TASK-350 | Task | Define migrations and compatibility behavior for legacy records | Planned | TASK-335, TASK-343 |
| TASK-351 | Task | Add redacted lifecycle diagnostics, audit events, and support docs | Planned | TASK-339, TASK-347, TASK-349 |
| TASK-352 | Task | Add deterministic fixtures, real-host vertical E2E, and final verification | Planned | TASK-340, TASK-342, TASK-345, TASK-348, TASK-350, TASK-351 |

## Session usage and provider allowance visibility

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-041 | Feature | Session usage and provider allowance visibility | Complete | FX-BF-015, FX-BF-035 |
| FX-BE-129 | Story | Session usage, cost, and provider allowance visibility | Complete | FX-BF-041 |
| TASK-353 | Task | Implement and verify session usage and provider allowance visibility | Complete | FX-BE-129 |
| FX-BE-130 | Story | Provider extensions and session allowance correctness | Complete | FX-BE-093, FX-BE-115, FX-BF-041 |
| TASK-354 | Task | Add Z.ai provider support and pricing-aware usage estimates | Complete | FX-BE-130 |
| TASK-355 | Task | Verify Z.ai cost and budget reporting boundaries | Complete | TASK-354 |
| TASK-356 | Task | Clear stale runtime limit state and hide unconfigured providers | Complete | FX-BE-130 |
| FX-BE-131 | Story | Image attachments in session chat | Complete | FX-BE-096, FX-BE-122 |
| TASK-357 | Task | Thread image attachments through core, ACP, gateway, and IPC | Complete | FX-BE-131 |
| TASK-358 | Task | Build image composer and transcript attachment UX | Complete | TASK-357 |
| TASK-359 | Task | Verify image attachment runtime paths and visual behavior | Complete | TASK-357, TASK-358 |
| FX-BE-132 | Story | Native browser pane geometry at app zoom | Complete | FX-BE-096 |
| TASK-360 | Task | Apply and verify zoom-aware native browser bounds | Complete | FX-BE-132 |

## Chat turn telemetry, live AI activity, and reasoning UX

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-042 | Feature | Chat turn telemetry, live AI activity, and reasoning UX | Complete | FX-BF-015, FX-BF-035, FX-BF-041 |
| FX-BE-133 | Story | Live AI activity telemetry and reasoning inspector streaming | Complete | FX-BF-015, FX-BF-035, FX-BF-041 |
| TASK-361 | Task | Remove misplaced chat reasoning bubble and fix stream lifecycle | Complete | FX-BE-133 |
| TASK-362 | Task | Implement live chat activity indicator with elapsed turn timer and active action telemetry | Complete | FX-BE-133 |
| TASK-363 | Task | Fix Details pane reasoning display truncation, stream layout, and anti-bloat streamlining | Complete | FX-BE-133 |
| FX-BE-134 | Story | Per-message turn metrics, duration, token usage, and cost attribution | Complete | FX-BE-133 |
| TASK-364 | Task | Define turn duration and message-level token/cost telemetry contracts in core | Complete | FX-BE-134 |
| TASK-365 | Task | Capture and thread turn duration, token usage, cost, model attribution, and dynamic context budget through session runtime | Complete | FX-BE-134 |
| TASK-366 | Task | Render message timestamp, duration, token/cost chips, and model attribution in chat UI | Complete | FX-BE-134 |
| FX-BE-135 | Story | Chat usability enhancements, tool execution summary, and message actions | Complete | FX-BE-134 |
| TASK-367 | Task | Add tool execution summary chip to assistant messages with activity tab navigation | Complete | FX-BE-135 |
| TASK-368 | Task | Add one-click copy message button with clipboard feedback | Complete | FX-BE-135 |
| TASK-369 | Task | Verification, theming compatibility across surface packs, and accessibility/keyboard focus testing | Complete | FX-BE-135 |

## TypeSafe Jev structured decisions

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-043 | Feature | TypeSafe Jev structured-decision model (deferred evaluation) | Proposed | None |
| FX-BE-136 | Story | TypeSafe Jev structured-decision model evaluation | Proposed | FX-BF-043 |

## AI provider catalog and OpenAI-compatible endpoints

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-044 | Feature | AI provider catalog and OpenAI-compatible endpoints | Complete | FX-BF-038 |
| FX-BE-137 | Story | Open provider identity and custom endpoint settings | Complete | FX-BF-044 |
| FX-BE-138 | Story | OpenAI-compatible preset catalog and wire options | Complete | FX-BE-137 |
| FX-BE-139 | Story | Connection test and capability probe | Complete | FX-BE-137 |
| FX-BE-140 | Story | Provider catalog settings UI | Complete | FX-BE-137, FX-BE-138, FX-BE-139 |
| FX-BE-141 | Story | Runtime integration for custom endpoints | Complete | FX-BE-140 |

## Standalone conversations

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-045 | Feature | Standalone conversations (chat outside any project) | In Progress | FX-BF-035, FX-BF-041 |
| FX-BE-142 | Story | Conversations list and lifecycle | In Progress | FX-BF-045 |
| FX-BE-143 | Story | Floating chat window | In Progress | FX-BE-142 |

## EasyMode sidebar, Agent Details page, and Simple theme

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [FX-BF-046](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/feature.md) | Feature | EasyMode sidebar, Agent Details page, and Simple theme | Complete | FX-BF-013, FX-BF-042, FX-BF-045 |
| [FX-BE-144](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-144-easymode-sidebar-workspace/story.md) | Story | EasyMode sidebar workspace (Sessions, Automations, and Orca card hierarchy) | Complete | FX-BF-046 |
| [TASK-377](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-144-easymode-sidebar-workspace/tasks/task-377-section-header-and-sidebar-host.md) | Task | Create EasyModeSidebar host container and reusable SectionHeader component | Complete | TASK-375 |
| [TASK-378](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-144-easymode-sidebar-workspace/tasks/task-378-sessions-cards-subagents-glow-and-highlight.md) | Task | Implement EasyMode Sessions card list, subagents hierarchy, status glow, and selection highlight | Complete | TASK-377 |
| [TASK-379](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-144-easymode-sidebar-workspace/tasks/task-379-automations-section-and-workflow-run-launch.md) | Task | Implement EasyMode Automations section with workflow run triggers and dialog | Complete | TASK-377 |
| [FX-BE-145](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-145-dedicated-agent-details-center-page/story.md) | Story | Dedicated Agent Details center page (Activity feed, tool executions, and file edits) | Complete | FX-BE-144 |
| [TASK-380](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-145-dedicated-agent-details-center-page/tasks/task-380-agent-details-route-and-shell.md) | Task | Create Agent Details route integration, top bar, and center pane shell | Complete | TASK-378 |
| [TASK-381](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-145-dedicated-agent-details-center-page/tasks/task-381-agent-activity-timeline-diffs-undo.md) | Task | Implement Agent Activity timeline, live events, tool args, file diffs, and undo action | Complete | TASK-380 |
| [TASK-382](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-145-dedicated-agent-details-center-page/tasks/task-382-easymode-e2e-verification-and-a11y.md) | Task | End-to-end verification, accessibility audit, and visual snapshot testing | Complete | TASK-376, TASK-378, TASK-379, TASK-381 |
| [FX-BE-146](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-146-simple-dark-theme-and-preview-setting/story.md) | Story | Simple dark theme and preview setting | Complete | FX-BF-046 |
| [TASK-375](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-146-simple-dark-theme-and-preview-setting/tasks/task-375-settings-contract-and-defaults.md) | Task | Define enableEasyMode setting contract, sanitizer, and renderer defaults | Complete | None |
| [TASK-376](/apps/praxis-desktop/docs/plans/features/fx-bf-046-easymode-sidebar-and-agent-activity/stories/fx-be-146-simple-dark-theme-and-preview-setting/tasks/task-376-simple-theme-and-preview-toggle.md) | Task | Register Simple dark theme, CSS theme definition, and Settings Preview toggle | Complete | TASK-375 |

## Agent session communication and resource coordination

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [FX-BF-048](plans/features/fx-bf-048-agent-session-coordination/feature.md) | Feature | Agent session communication and resource coordination | Backlog | None |
| [FX-BE-150](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/story.md) | Story | Coordinate session activity and exclusive resources | Backlog | FX-BF-048 |
| [TASK-391](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-391-coordination-contracts.md) | Task | Define coordination schema and resource conflicts | Backlog | FX-BE-150 |
| [TASK-392](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-392-coordination-broker.md) | Task | Design and implement the single local broker | Backlog | TASK-391 |
| [TASK-393](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-393-coordination-runtime.md) | Task | Gate session tools and reconcile their lifecycle | Backlog | TASK-391, TASK-392 |
| [TASK-394](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-394-coordination-communication.md) | Task | Expose bounded messages and resource waiting status | Backlog | TASK-393 |
| [TASK-395](plans/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/tasks/task-395-coordination-verification.md) | Task | Prove contention, isolation and safe recovery | Backlog | TASK-393, TASK-394 |
