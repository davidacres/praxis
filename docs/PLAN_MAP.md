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
