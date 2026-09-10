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
| [TASK-132](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-132-define-evidence-identity-and-storage.md) | Task | Define evidence identity and storage | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-133](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-133-preserve-failed-process-evidence.md) | Task | Preserve failed process evidence | Planned | TASK-132 |
| [TASK-134](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/tasks/task-134-expose-evidence-in-the-run-monitor.md) | Task | Expose evidence in the run monitor | Planned | TASK-133 |
| [FX-BE-051](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-051-failure-evidence-contracts-and-retained-logs/story.md) | Story | Failure evidence contracts and retained logs | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-135](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-135-create-diagnosis-sessions-from-evidence.md) | Task | Create diagnosis sessions from evidence | Planned | FX-BE-051 |
| [TASK-136](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-136-bound-repair-attempts-and-freshness.md) | Task | Bound repair attempts and freshness | Planned | TASK-135 |
| [TASK-137](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/tasks/task-137-show-diagnosis-and-verified-outcomes.md) | Task | Show diagnosis and verified outcomes | Planned | TASK-136 |
| [FX-BE-052](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-052-bounded-diagnose-and-verify-workflow/story.md) | Story | Bounded diagnose and verify workflow | Planned | FX-BE-051 |
| [TASK-138](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-138-define-read-only-ci-evidence-providers.md) | Task | Define read-only CI evidence providers | Planned | FX-BE-052 |
| [TASK-139](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-139-add-failure-selection-and-refresh.md) | Task | Add failure selection and refresh | Planned | TASK-138 |
| [TASK-140](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/tasks/task-140-connect-ci-evidence-to-diagnosis.md) | Task | Connect CI evidence to diagnosis | Planned | TASK-139 |
| [FX-BE-053](/docs/plans/features/fx-bf-021-failure-diagnosis/stories/fx-be-053-import-ci-failures-with-exact-run-provenance/story.md) | Story | Import CI failures with exact run provenance | Planned | FX-BE-052 |
| [FX-BF-021](/docs/plans/features/fx-bf-021-failure-diagnosis/feature.md) | Feature | Reproducible failure diagnosis and verification evidence | Planned | FX-BE-024, FX-BE-025, FX-BE-041 |
| [TASK-141](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-141-define-run-profile-schema.md) | Task | Define run profile schema | Planned | FX-BF-021 |
| [TASK-142](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-142-resolve-launch-configuration.md) | Task | Resolve launch configuration | Planned | TASK-141 |
| [TASK-143](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/tasks/task-143-build-project-run-profile-editor.md) | Task | Build project Run profile editor | Planned | TASK-142 |
| [FX-BE-054](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-054-portable-run-profiles-and-readiness-contracts/story.md) | Story | Portable run profiles and readiness contracts | Planned | FX-BF-021 |
| [TASK-144](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-144-implement-process-lifecycle-manager.md) | Task | Implement process lifecycle manager | Planned | FX-BE-054 |
| [TASK-145](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-145-add-explicit-preview-origin-grants.md) | Task | Add explicit preview origin grants | Planned | TASK-144 |
| [TASK-146](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/tasks/task-146-integrate-run-controls-and-recovery.md) | Task | Integrate Run controls and recovery | Planned | TASK-145 |
| [FX-BE-055](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-055-managed-service-lifecycle-and-scoped-preview-access/story.md) | Story | Managed service lifecycle and scoped preview access | Planned | FX-BE-054 |
| [TASK-147](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-147-capture-scoped-browser-evidence.md) | Task | Capture scoped browser evidence | Planned | FX-BE-055 |
| [TASK-148](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-148-expose-diagnostics-to-agents.md) | Task | Expose diagnostics to agents | Planned | TASK-147 |
| [TASK-149](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/tasks/task-149-add-preview-verification-workflow.md) | Task | Add preview verification workflow | Planned | TASK-148 |
| [FX-BE-056](/docs/plans/features/fx-bf-022-managed-run-and-preview/stories/fx-be-056-browser-diagnostics-and-repeatable-verification/story.md) | Story | Browser diagnostics and repeatable verification | Planned | FX-BE-055 |
| [FX-BF-022](/docs/plans/features/fx-bf-022-managed-run-and-preview/feature.md) | Feature | Managed project runs and diagnostic browser previews | Planned | FX-BF-021 |
| [TASK-150](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-150-define-deployment-domain-contracts.md) | Task | Define deployment domain contracts | Planned | FX-BF-021 |
| [TASK-151](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-151-persist-portable-profiles-and-references.md) | Task | Persist portable profiles and references | Planned | TASK-150 |
| [TASK-152](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/tasks/task-152-separate-publish-from-deploy.md) | Task | Separate publish from deploy | Planned | TASK-151 |
| [FX-BE-057](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-057-independent-deployment-profiles-and-immutable-artifacts/story.md) | Story | Independent deployment profiles and immutable artifacts | Planned | FX-BF-021 |
| [TASK-153](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-153-add-deployment-transitions-and-policy.md) | Task | Add deployment transitions and policy | Planned | FX-BE-057 |
| [TASK-154](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-154-persist-side-effects-and-reconcile.md) | Task | Persist side effects and reconcile | Planned | TASK-153 |
| [TASK-155](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/tasks/task-155-integrate-workflow-designer-and-monitor.md) | Task | Integrate workflow designer and monitor | Planned | TASK-154 |
| [FX-BE-058](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-058-durable-deployment-state-and-workflow-operations/story.md) | Story | Durable deployment state and workflow operations | Planned | FX-BE-057 |
| [TASK-156](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-156-implement-direct-process-executor.md) | Task | Implement direct process executor | Planned | FX-BE-058 |
| [TASK-157](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-157-add-local-directory-target-and-health-verification.md) | Task | Add local directory target and health verification | Planned | TASK-156 |
| [TASK-158](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/tasks/task-158-expose-direct-deployment-actions.md) | Task | Expose direct deployment actions | Planned | TASK-157 |
| [FX-BE-059](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-059-script-based-direct-deployment-executor/story.md) | Story | Script-based direct deployment executor | Planned | FX-BE-058 |
| [TASK-159](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-159-build-profile-selection-and-review.md) | Task | Build profile selection and review | Planned | FX-BE-059 |
| [TASK-160](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-160-add-deployment-history-and-promotion.md) | Task | Add deployment history and promotion | Planned | TASK-159 |
| [TASK-161](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/tasks/task-161-verify-complete-direct-delivery-journey.md) | Task | Verify complete direct delivery journey | Planned | TASK-160 |
| [FX-BE-060](/docs/plans/features/fx-bf-023-project-deployment-foundation/stories/fx-be-060-deployment-profile-and-history-experience/story.md) | Story | Deployment profile and history experience | Planned | FX-BE-059 |
| [FX-BF-023](/docs/plans/features/fx-bf-023-project-deployment-foundation/feature.md) | Feature | Project deployment profiles and direct execution | Planned | FX-BF-021 |
| [TASK-162](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-162-implement-workflow-discovery-and-dispatch.md) | Task | Implement workflow discovery and dispatch | Planned | FX-BF-023 |
| [TASK-163](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-163-observe-existing-continuous-deployments.md) | Task | Observe existing continuous deployments | Planned | TASK-162 |
| [TASK-164](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/tasks/task-164-map-logs-and-verified-results.md) | Task | Map logs and verified results | Planned | TASK-163 |
| [FX-BE-061](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-061-github-actions-deployment-executor/story.md) | Story | GitHub Actions deployment executor | Planned | FX-BF-023 |
| [TASK-165](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-165-implement-pipeline-preflight-and-trigger.md) | Task | Implement pipeline preflight and trigger | Planned | FX-BE-061 |
| [TASK-166](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-166-observe-pipelines-and-environments.md) | Task | Observe pipelines and environments | Planned | TASK-165 |
| [TASK-167](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/tasks/task-167-prove-cross-provider-parity.md) | Task | Prove cross-provider parity | Planned | TASK-166 |
| [FX-BE-062](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-062-gitlab-ci-deployment-executor/story.md) | Story | GitLab CI deployment executor | Planned | FX-BE-061 |
| [TASK-168](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-168-build-provider-configuration-forms.md) | Task | Build provider configuration forms | Planned | FX-BE-062 |
| [TASK-169](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-169-reconcile-external-runs-on-reopen.md) | Task | Reconcile external runs on reopen | Planned | TASK-168 |
| [TASK-170](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/tasks/task-170-verify-cd-and-deployment-journeys.md) | Task | Verify CD and deployment journeys | Planned | TASK-169 |
| [FX-BE-063](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/stories/fx-be-063-pipeline-setup-and-recovery-experience/story.md) | Story | Pipeline setup and recovery experience | Planned | FX-BE-062 |
| [FX-BF-024](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/feature.md) | Feature | Pipeline-managed deployment and continuous delivery observation | Planned | FX-BF-023 |
| [TASK-171](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-171-define-iis-target-and-prerequisites.md) | Task | Define IIS target and prerequisites | Planned | FX-BF-023 |
| [TASK-172](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-172-validate-target-boundaries-and-credentials.md) | Task | Validate target boundaries and credentials | Planned | TASK-171 |
| [TASK-173](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/tasks/task-173-build-iis-profile-template.md) | Task | Build IIS profile template | Planned | TASK-172 |
| [FX-BE-064](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-064-iis-capability-preflight-and-target-configuration/story.md) | Story | IIS capability preflight and target configuration | Planned | FX-BF-023 |
| [TASK-174](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-174-implement-staged-iis-installation.md) | Task | Implement staged IIS installation | Planned | FX-BE-064 |
| [TASK-175](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-175-verify-health-and-retain-recovery-evidence.md) | Task | Verify health and retain recovery evidence | Planned | TASK-174 |
| [TASK-176](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/tasks/task-176-implement-explicit-rollback-procedure.md) | Task | Implement explicit rollback procedure | Planned | TASK-175 |
| [FX-BE-065](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-065-iis-install-health-and-explicit-rollback/story.md) | Story | IIS install health and explicit rollback | Planned | FX-BE-064 |
| [TASK-177](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-177-add-windows-iis-fixture-workflow.md) | Task | Add Windows IIS fixture workflow | Planned | FX-BE-065 |
| [TASK-178](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-178-exercise-direct-and-pipeline-target-journeys.md) | Task | Exercise direct and pipeline target journeys | Planned | TASK-177 |
| [TASK-179](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/tasks/task-179-document-supported-methods-and-recovery.md) | Task | Document supported methods and recovery | Planned | TASK-178 |
| [FX-BE-066](/docs/plans/features/fx-bf-025-iis-deployment-target/stories/fx-be-066-iis-end-to-end-proof-and-operational-guidance/story.md) | Story | IIS end-to-end proof and operational guidance | Planned | FX-BE-065 |
| [FX-BF-025](/docs/plans/features/fx-bf-025-iis-deployment-target/feature.md) | Feature | IIS deployment target and recovery templates | Planned | FX-BF-023 |
| [TASK-180](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-180-define-debug-session-model.md) | Task | Define debug session model | Planned | FX-BF-022 |
| [TASK-181](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-181-prove-node-and-net-adapter-choices.md) | Task | Prove Node and .NET adapter choices | Planned | TASK-180 |
| [TASK-182](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/tasks/task-182-define-trusted-adapter-configuration.md) | Task | Define trusted adapter configuration | Planned | TASK-181 |
| [FX-BE-067](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/story.md) | Story | Debugger contracts and adapter capability proof | Planned | FX-BF-022 |
| [TASK-183](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-183-implement-protocol-and-lifecycle.md) | Task | Implement protocol and lifecycle | Planned | FX-BE-067 |
| [TASK-184](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-184-implement-breakpoints-and-inspection.md) | Task | Implement breakpoints and inspection | Planned | TASK-183 |
| [TASK-185](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/tasks/task-185-expose-typed-debugger-ipc.md) | Task | Expose typed debugger IPC | Planned | TASK-184 |
| [FX-BE-068](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-068-dap-service-and-node-typescript-debugging/story.md) | Story | DAP service and Node TypeScript debugging | Planned | FX-BE-067 |
| [TASK-186](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-186-build-debugging-surface.md) | Task | Build debugging surface | Planned | FX-BE-068 |
| [TASK-187](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-187-integrate-net-launch-and-attach.md) | Task | Integrate .NET launch and attach | Planned | TASK-186 |
| [TASK-188](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/tasks/task-188-verify-interactive-workflows.md) | Task | Verify interactive workflows | Planned | TASK-187 |
| [FX-BE-069](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-069-debug-workspace-and-net-support/story.md) | Story | Debug workspace and .NET support | Planned | FX-BE-068 |
| [TASK-189](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-189-expose-narrow-debug-tools.md) | Task | Expose narrow debug tools | Planned | FX-BE-069 |
| [TASK-190](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-190-separate-inspection-from-evaluation.md) | Task | Separate inspection from evaluation | Planned | TASK-189 |
| [TASK-191](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/tasks/task-191-connect-debugger-evidence-to-diagnosis.md) | Task | Connect debugger evidence to diagnosis | Planned | TASK-190 |
| [FX-BE-070](/docs/plans/features/fx-bf-026-interactive-agent-debugging/stories/fx-be-070-controlled-agent-debugging-tools/story.md) | Story | Controlled agent debugging tools | Planned | FX-BE-069 |
| [FX-BF-026](/docs/plans/features/fx-bf-026-interactive-agent-debugging/feature.md) | Feature | Interactive and agent-assisted runtime debugging | Planned | FX-BF-022 |
| [TASK-192](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-192-audit-supported-agent-protocol-capabilities.md) | Task | Audit supported agent protocol capabilities | Backlog | FX-BF-024, FX-BF-026 |
| [TASK-193](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-193-prototype-optional-codex-app-server-adapter.md) | Task | Prototype optional Codex App Server adapter | Backlog | TASK-192 |
| [TASK-194](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/tasks/task-194-add-recovery-and-attempt-level-usage-presentation.md) | Task | Add recovery and attempt-level usage presentation | Backlog | TASK-193 |
| [FX-BE-071](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/story.md) | Story | Capability-led session recovery and cost attribution | Backlog | FX-BF-024, FX-BF-026 |
| [TASK-195](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-195-define-event-subscription-and-deduplication.md) | Task | Define event subscription and deduplication | Backlog | FX-BE-071 |
| [TASK-196](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-196-apply-automation-limits-and-approval-boundaries.md) | Task | Apply automation limits and approval boundaries | Backlog | TASK-195 |
| [TASK-197](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/tasks/task-197-verify-opt-in-event-journeys.md) | Task | Verify opt-in event journeys | Backlog | TASK-196 |
| [FX-BE-072](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-072-event-triggered-bounded-failure-repair/story.md) | Story | Event-triggered bounded failure repair | Backlog | FX-BE-071 |
| [TASK-198](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-198-define-runner-trust-and-capability-contract.md) | Task | Define runner trust and capability contract | Backlog | FX-BE-072 |
| [TASK-199](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-199-prototype-one-controlled-remote-execution-path.md) | Task | Prototype one controlled remote execution path | Backlog | TASK-198 |
| [TASK-200](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/tasks/task-200-record-rollout-decision-and-remaining-work.md) | Task | Record rollout decision and remaining work | Backlog | TASK-199 |
| [FX-BE-073](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/story.md) | Story | Shared executor feasibility and runner boundary | Backlog | FX-BE-072 |
| [FX-BF-027](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/feature.md) | Feature | Deferred execution reliability and automation extensions | Backlog | FX-BF-024, FX-BF-026 |

## Full SDLC quality and security gates

Canonical sequencing and architectural decisions: [SDLC quality gates roadmap](sdlc-quality-gates-roadmap.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [TASK-237](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-237-define-check-findings-contract-and-artifact-kind.md) | Task | Define the CheckFindings contract and the findings artifact kind | Planned | FX-BE-020, FX-BE-024 |
| [TASK-238](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-238-add-result-format-adapters.md) | Task | Add SARIF / JUnit / lcov / npm-audit / osv-scanner adapters | Planned | TASK-237 |
| [TASK-239](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-239-add-metric-and-severity-threshold-gates.md) | Task | Add metric and severity threshold gate policy | Planned | TASK-237 |
| [TASK-240](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/tasks/task-240-render-findings-and-metrics-in-the-run-monitor.md) | Task | Render findings and metrics in the run monitor | Planned | TASK-238, TASK-239 |
| [FX-BE-087](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-087-structured-check-results-and-threshold-gates/story.md) | Story | Structured check results and threshold gates | Planned | FX-BE-020, FX-BE-024 |
| [TASK-241](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-241-add-secret-sast-sca-and-license-check-presets.md) | Task | Add secret / SAST / SCA / license check presets with stack detection | Planned | FX-BE-087 |
| [TASK-242](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-242-add-an-audited-waiver-register.md) | Task | Add an audited, expiring waiver register | Planned | TASK-241 |
| [TASK-243](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/tasks/task-243-compose-the-security-gate-over-enabled-scanners.md) | Task | Compose the security gate over the union of enabled scanners | Planned | TASK-242 |
| [FX-BE-088](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-088-bundled-security-scanners/story.md) | Story | Bundled security scanners behind the security gate | Planned | FX-BE-087 |
| [TASK-244](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-244-define-the-structured-reviewer-artifact-contract.md) | Task | Define the structured reviewer artifact contract | Planned | FX-BE-087 |
| [TASK-245](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-245-deliver-review-findings-as-inline-comments.md) | Task | Deliver review findings as inline PR / ticket comments with dedupe | Planned | TASK-244 |
| [TASK-246](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/tasks/task-246-add-a-bounded-review-fix-loop.md) | Task | Add a bounded review to implement fix loop | Planned | TASK-245 |
| [FX-BE-089](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-089-structured-code-review-and-inline-delivery/story.md) | Story | Structured code review and inline delivery | Planned | FX-BE-087, FX-BE-033 |
| [TASK-247](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-247-ship-bundled-trusted-agent-manifests.md) | Task | Ship bundled trusted agent manifests | Planned | FX-BE-011 |
| [TASK-248](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-248-add-the-full-sdlc-workflow-template.md) | Task | Add the full-sdlc workflow template | Planned | TASK-247, FX-BE-088, FX-BE-089 |
| [TASK-249](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/tasks/task-249-add-per-stack-template-variants.md) | Task | Add Node / .NET / Python template variants | Planned | TASK-248 |
| [FX-BE-090](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-090-bundled-agents-and-full-sdlc-template/story.md) | Story | Bundled agents and a Full SDLC template | Planned | FX-BE-088, FX-BE-089, FX-BE-011 |
| [TASK-250](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-250-add-read-only-ci-quality-and-security-providers.md) | Task | Add read-only CI quality and security report providers | Planned | FX-BE-053 |
| [TASK-251](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-251-map-imported-reports-to-findings-evidence.md) | Task | Map imported reports to findings evidence bound to the SHA | Planned | TASK-250, TASK-237 |
| [TASK-252](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/tasks/task-252-add-an-observe-mode-gate-on-ci-evidence.md) | Task | Add an observe-mode gate resting on imported CI evidence | Planned | TASK-251, TASK-239 |
| [FX-BE-091](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/stories/fx-be-091-ingest-ci-security-and-quality-reports/story.md) | Story | Ingest CI security and quality reports | Planned | FX-BE-087, FX-BE-053 |
| [FX-BF-034](/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/feature.md) | Feature | Full SDLC quality and security gates | Planned | FX-BE-020, FX-BE-024, FX-BE-033 |


## Praxis Mobile companion

The mobile initiative has its own folder-backed PRAXISMOBILE project at [apps/praxis-mobile](../apps/praxis-mobile/README.md). Its canonical [Plan Map](../apps/praxis-mobile/docs/PLAN_MAP.md) and [master plan](../apps/praxis-mobile/docs/plans/master-plan.md) contain 6 features, 13 stories and 36 tasks: FX-BF-028–033, FX-BE-074–086, TASK-201–236. Local work is planned first; cloud integration is deferred.

The root desktop board is unchanged. Add the mobile folder as a separate project to see its work. No dependency on the deferred shared-executor or deployment/debugging roadmap is implied.

**Status as of 2026-09-10.** FX-BF-028 (execution host and protocol) is done and
tested. FX-BF-029 and FX-BF-031–033 are back to In Progress: the desktop half —
the Noise `IK` secure transport (`@praxis/mobile-protocol`), the real LAN
listener, and the host bound to the live stores — is implemented and tested, but
there is no React Native app yet, LAN discovery and the real pairing adapters
are missing, and `sessions.continue` / `permissions.respond` / `workflowRuns.start`
remain deferred pending the permission request-id rework. See the mobile
[Plan Map](../apps/praxis-mobile/docs/PLAN_MAP.md) for the per-story breakdown.

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
| FX-BE-096 | Story | Session operations and review experience | Planned | FX-BE-095, FX-BF-014, FX-BF-015 |
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

## Interactive chat gadgets

Canonical sequencing and architectural decisions: [interactive chat gadgets roadmap](interactive-chat-gadgets-roadmap.md).

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| FX-BF-036 | Feature | Interactive chat gadgets and response surfaces | Planned | FX-BF-014, FX-BF-015, FX-BF-035 |
| FX-BE-097 | Story | Versioned gadget and action contracts | Planned | FX-BF-014, FX-BF-015 |
| FX-BE-098 | Story | Renderer registry and core chat surfaces | Planned | FX-BE-097 |
| FX-BE-099 | Story | Safe action lifecycle, scope and stale-state handling | Planned | FX-BE-097, FX-BF-013 |
| FX-BE-100 | Story | Workflow, agent and orchestration integration | Planned | FX-BE-099, FX-BF-035 |
| FX-BE-101 | Story | Accessibility, mobile, fixtures and end-to-end proof | Planned | FX-BE-098, FX-BE-100 |
| TASK-276 | Task | Define ChatBlock, GadgetEnvelope and GadgetScope contracts | Planned | FX-BE-097 |
| TASK-277 | Task | Define GadgetAction, result and fallback contracts | Planned | TASK-276 |
| TASK-278 | Task | Validate payload size, schema, capability and safety policy | Planned | TASK-277 |
| TASK-279 | Task | Implement the browser-safe gadget renderer registry | Planned | FX-BE-098 |
| TASK-280 | Task | Implement choice, confirmation, table and progress renderers | Planned | TASK-279 |
| TASK-281 | Task | Implement chart, diff, artifact and handoff renderers | Planned | TASK-280 |
| TASK-282 | Task | Route gadget actions through the command ledger | Planned | FX-BE-099 |
| TASK-283 | Task | Enforce scope, authorization and policy boundaries | Planned | TASK-282 |
| TASK-284 | Task | Handle expiry, supersession, reconnect and duplicate submission | Planned | TASK-283 |
| TASK-285 | Task | Add expected-response declarations to workflows and sessions | Planned | FX-BE-100 |
| TASK-286 | Task | Integrate provider responses and multi-AI handoffs | Planned | TASK-285 |
| TASK-287 | Task | Connect gadgets to run monitor, changes and deployment decisions | Planned | TASK-286 |
| TASK-288 | Task | Add accessibility and responsive visual verification | Planned | FX-BE-101 |
| TASK-289 | Task | Create deterministic gadget fixture workflows and contract tests | Planned | TASK-288 |
| TASK-290 | Task | Prove desktop/mobile end-to-end journeys and document operations | Planned | TASK-289 |

