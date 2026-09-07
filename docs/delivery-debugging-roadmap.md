# Praxis diagnosis, deployment and debugging roadmap

Status: Planned; implementation has not started.
Prepared: 2026-09-07.
Source baseline: c060a166f2e5d8fb463c0c69df3b12daa7ec46ed.

## Agreed product decisions

- Deployment profiles belong to the Praxis project and are independent of its issue backend.
- A tracker connection may suggest an executor; it never restricts executor or target choices.
- Tracker (Jira/GitHub/GitLab/folder), executor (local process/CI/runner) and target (IIS/local web root/cloud) are separate identities.
- Publish produces an immutable artifact. Deploy installs that artifact. Promote reuses the same digest across environments.
- Run owns ephemeral local services and previews; Deployments owns persistent installed versions.
- Pipeline profiles explicitly choose trigger or observe. If merge already triggers CD, Praxis observes the correlated run instead of submitting another deployment.
- Local/direct execution works without GitHub. Remote IIS initially uses an existing Windows pipeline runner; a new generic remote runner is deferred.
- Interactive debugging uses a DAP service and read-only source viewer. Agent debugging reuses that service; a full editor is outside scope.
- Retain ACP. Provider-native integration is a bounded, capability-led follow-on, not a prerequisite.

## Existing implementation to extend

The current core already has workflow DAGs, immutable snapshots, worktree management, approvals, check execution and recovery. Extend these services, do not create a second workflow engine. BrowserBridge and browser MCP already support navigation and interaction; add diagnostic capture and explicit managed-preview access. GitHub issue support is implemented despite stale README wording; deployment provider APIs remain separate from issue tracking. deliveryWorkflow.ts currently centres publish settings and prompts on MSI output, which must be generalised deliberately.

Application-written configuration must use shared constants for the AGENTS.md naming rule: <name>.praxis.<ext>. The established repository planning layout remains feature.md, story.md and task-NNN-slug.md.

## Recommended delivery order and completion gates

| Priority | Feature | Story range | Task range | Completion gate |
| --- | --- | --- | --- | --- |
| 1 | [FX-BF-021](/docs/plans/features/fx-bf-021-failure-diagnosis/feature.md) — Reproducible failure diagnosis and verification evidence | FX-BE-051–FX-BE-053 | TASK-132–TASK-140 | Failed local/CI job reaches an independently verified repair with retained evidence. |
| 2 | [FX-BF-022](/docs/plans/features/fx-bf-022-managed-run-and-preview/feature.md) — Managed project runs and diagnostic browser previews | FX-BE-054–FX-BE-056 | TASK-141–TASK-149 | Frontend/API services launch with scoped previews and diagnostic capture. |
| 3 | [FX-BF-023](/docs/plans/features/fx-bf-023-project-deployment-foundation/feature.md) — Project deployment profiles and direct execution | FX-BE-057–FX-BE-060 | TASK-150–TASK-161 | Folder-backed project publishes and deploys a fixed artifact locally with health and rollback evidence. |
| 4 | [FX-BF-024](/docs/plans/features/fx-bf-024-pipeline-managed-deployment/feature.md) — Pipeline-managed deployment and continuous delivery observation | FX-BE-061–FX-BE-063 | TASK-162–TASK-170 | GitHub and GitLab trigger/observe paths reconcile without duplicate deployment. |
| 5 | [FX-BF-025](/docs/plans/features/fx-bf-025-iis-deployment-target/feature.md) — IIS deployment target and recovery templates | FX-BE-064–FX-BE-066 | TASK-171–TASK-179 | Disposable IIS target proves install, unhealthy release and explicit rollback. |
| 6 | [FX-BF-026](/docs/plans/features/fx-bf-026-interactive-agent-debugging/feature.md) — Interactive and agent-assisted runtime debugging | FX-BE-067–FX-BE-070 | TASK-180–TASK-191 | Node and C# interactive debugging works; bounded agent investigation ends in independent tests. |
| 7 | [FX-BF-027](/docs/plans/features/fx-bf-027-advanced-execution-follow-ons/feature.md) — Deferred execution reliability and automation extensions | FX-BE-071–FX-BE-073 | TASK-192–TASK-200 | Deferred: feasibility evidence and explicit go/no-go; not a core release blocker. |

## Hard dependencies versus scheduling priority

The Dependencies sections in the canonical files are the executable prerequisite graph. Feature/story containment is metadata and a completion roll-up, not a start dependency: a story must never wait for completion of its own parent.

- FX-BF-021 relies on already-completed check/session/log integration stories.
- FX-BF-022 and FX-BF-023 can proceed independently after FX-BF-021. The recommended single-team order prioritises previews first.
- FX-BF-024 and FX-BF-025 both depend on FX-BF-023. Local IIS does not require pipeline support; use pipeline-backed IIS only once the relevant executor is complete.
- FX-BF-026 depends on FX-BF-022 and can proceed alongside deployment work if capacity permits.
- FX-BF-027 depends on FX-BF-024 and FX-BF-026 and remains Backlog.
- Within each feature stories are sequential. Within each story tasks are sequential. A first task inherits the story's external prerequisites; later tasks depend on their predecessor. The parent completes only after every child is complete.
- Links, IDs and parser-visible dependency sections must stay aligned when implementation changes ordering.

This is an ordering plan, not a calendar estimate. Adapter/runtime compatibility, IIS integration and provider API behaviour must be proven by their assigned tasks before expanding scope.

## Vertical milestones

1. Diagnose a failed command with its exact source SHA, preserve timeout evidence, and show a passing independent rerun.
2. Run a frontend plus API, reproduce a browser error and collect its console/network/screenshot evidence.
3. Publish an artifact and deploy it into a temporary persistent local web root from a folder-backed project.
4. Trigger a selected pipeline or observe existing merge-triggered CD; reopen Praxis and reconnect to the same deployment.
5. Install and recover an artifact on disposable IIS using the supported method.
6. Pause Node and C# fixtures at breakpoints, inspect real state, and let a bounded agent investigation use the same service.

## Cross-cutting acceptance requirements

- Every evidence/approval/deployment record binds project, source snapshot, attempt and artifact identity as applicable. A changed artifact or target invalidates approval.
- Preserve bounded stdout/stderr and capture errors for timeout, cancellation and failed startup; redact before sending evidence to a model.
- Check success is an exit result; deployment success additionally requires configured health/version verification. Agent prose alone cannot satisfy either.
- Persist dispatch intent before external side effects. Lost acknowledgements produce an unknown/reconciling state, not a blind retry.
- Environment locks prevent overlapping deploys to one destination. Cancel requested is distinct from cancellation confirmed; direct script cancellation may leave partial installation requiring reconciliation.
- Rollback is an explicit target capability with recorded previous artifact/backup and a new health check. Database changes are separate reviewed work, never assumed reversible.
- New credentials stay in secret stores or executor-managed secrets. Portable files contain references and relative paths; machine-local paths require explicit rebinding.
- Local previews get project/run-scoped origin grants. Existing private-network restrictions remain outside that scope; redirects and subresources are part of verification.
- Debug references are invalidated on resume; expression evaluation is separately controlled because it may execute application code.
- Costs remain provider-supplied and currency-aware. Context occupancy is not cumulative usage; missing cost/limits remain unknown.
- New surfaces reuse theme tokens, pane conventions, dialogs, keyboard focus and command-palette navigation. Do not introduce runtime core imports into renderer code.

## Verification and definition of done

Each task includes a concrete acceptance scenario and completion-evidence section. Implementers run the focused core checks and real affected build paths; UI changes rebuild and copy the renderer before focused Electron tests, then inspect actual captures. Paid agent tests, real CI dispatch and IIS/runner integration remain opt-in and use disposable resources. Routine verification uses scripted ACP/DAP and provider fixtures. A mock cannot establish production adapter compatibility.

For this planning change, run the repository's read-only parsePlanFolder directly over baseline and final plans. Verify all new IDs are unique, all new files appear with expected type/title/status, dependency tokens survive parsing, dependency targets exist, the new prerequisite graph is acyclic, and all local document links resolve. Do not invoke FolderService write paths against these plans. Existing plan statuses must remain unchanged.

## Research provenance and implementation checks

These are design precedents reviewed on 2026-09-07, not guaranteed capabilities of a CLI hosted through ACP:
- [Claude managed previews](https://claude.com/blog/preview-review-and-merge-with-claude-code)
- [Claude PR failure repair](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude release notes and usage visibility](https://code.claude.com/docs/en/changelog)
- [Codex release notes and session recovery](https://learn.chatgpt.com/docs/changelog)
- [Codex App Server integration](https://learn.chatgpt.com/docs/app-server)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/overview.html)
- [CoreCLR debugger candidate](https://github.com/Samsung/netcoredbg)

Before implementation, inspect the installed ACP schema and current provider/adapter documentation. Record chosen versions and supported capabilities. Remote App Server transport and shared runners are not core release dependencies.

## Planning validation completed

On 2026-09-07 the actual repository parser was run read-only over the baseline and final planning trees:

| Parsed items | Baseline | Final | Added |
| --- | --- | --- | --- |
| Features | 24 | 31 | 7 |
| Stories | 66 | 89 | 23 |
| Tasks | 88 | 157 | 69 |

All 99 new items have stable IDs, declared types, H1 titles and expected Planned/Backlog mapping. Canonical dependency targets exist, resolve to the generated board keys, and the new prerequisite graph is acyclic. Existing item titles, statuses and numeric identities are unchanged. Local links in the updated plan/index set were checked against physical files and the repository tree.

Validation exposed an existing defect: the dependency scanner truncated FX-BE/FX-BF IDs and the board resolver treated local TASK IDs as external tracker keys. The accompanying small parser/resolver fix preserves explicit planning IDs and maps them to board keys; legacy filenames and external tracker references remain supported. Four parser tests passed, including two dependency regression tests. Reinstating the old scanner made the canonical-reference regression fail, and restoring the fix made it pass.

The tests used Node 24 native TypeScript support with a temporary extension-resolution loader. A full TypeScript compile and desktop suite were not run in this planning workspace; the normal core test script already includes markdownPlanParser.test.ts. No live agent, CI deployment or real IIS operation was performed.
