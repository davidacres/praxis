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
| FX-BF-019 | Feature | A project's workflow is data, authored once and rendered by every backend | Proposed | — |
| FX-BE-043 | Story | Stage category as a first-class field | Proposed | FX-BF-019 |
| FX-BE-044 | Story | Resolve a freeform status against a declared workflow | Proposed | FX-BE-043 |
| FX-BE-045 | Story | Folder boards read their workflow instead of declaring it | Proposed | FX-BE-044 |
| FX-BE-046 | Story | Editing a project's workflow | Proposed | FX-BE-045 |
| FX-BE-047 | Story | PROJECT.md derived from the effective workflow | Proposed | FX-BE-046 |
