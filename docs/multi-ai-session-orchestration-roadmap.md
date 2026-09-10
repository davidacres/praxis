# Multi-AI session orchestration roadmap

**Status:** Planned  
**Prepared:** 2026-09-10  
**Feature:** [FX-BF-035](plans/features/fx-bf-035-multi-ai-session-orchestration/feature.md)

## Purpose

Allow Praxis to coordinate work across Claude Code, Codex and GitHub Copilot while preserving a shared understanding of the objective, decisions, files, changes, validation evidence and outstanding work.

## Product decisions

- Git state, task records and validation results are authoritative; model claims are evidence to verify.
- Every provider runs through a common adapter behind WorkflowSessionPort.
- Every write-capable session receives an isolated Git worktree or branch.
- Shared context is generated from durable project artifacts, not copied conversation transcripts.
- Provider instruction files remain supported: AGENTS.md, CLAUDE.md and .github/copilot-instructions.md.
- Copilot begins with a capability-led adapter and controlled handoff; it must not depend on private IDE transcript access.
- Runtime events are append-only and redact secrets before persistence.
- Automatic merge requires successful deterministic validation and policy approval where configured.

## Target flow

Task -> context snapshot -> provider preflight -> isolated session -> file/change events -> validation -> handoff -> review -> merge

## Delivery order

| Priority | Story | Outcome |
| --- | --- | --- |
| 1 | FX-BE-092 | Durable shared task, context and handoff contracts |
| 2 | FX-BE-093 | Provider-neutral adapters for Codex, Claude and Copilot |
| 3 | FX-BE-094 | Worktree, file-claim and change governance |
| 4 | FX-BE-095 | Task graph orchestration, event log and recovery |
| 5 | FX-BE-096 | Session monitor, handoff review and operational controls |

## Cross-cutting completion requirements

- A session can be resumed by another provider using repository artifacts and the generated snapshot.
- The orchestrator records commits, changed files, commands, exit codes, tests and handoff status.
- Two write sessions cannot own the same worktree or overlapping file claims.
- Context is bounded, deterministic and reproducible from a recorded snapshot manifest.
- Provider capability differences are visible and never silently treated as available.
- Failed or interrupted sessions can be cancelled, recovered, retried or escalated without losing evidence.
- Secrets and credentials never enter prompts, snapshots, logs or committed artifacts.
- The planning parser accepts every canonical feature, story and task file; dependencies resolve and the graph remains acyclic.

## Capability notes

Codex supports repository work, Git checkpoints, codex exec, MCP and non-interactive workflows. Claude Code provides project instructions and lifecycle hooks for session, tool, file and completion events. Copilot surfaces vary by CLI, IDE and GitHub-hosted agent, so its first milestone is capability-led and evidence-based.
