---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.191Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-035
title: "Multi-AI session orchestration across Claude, Codex and Copilot"
status: To Do
updated: 2026-09-10
dependencies: [FX-BF-011, FX-BF-012, FX-BF-013, FX-BF-015, FX-BF-019]
---

# FX-BF-035: Multi-AI session orchestration across Claude, Codex and Copilot

## Outcome

Praxis can plan, launch, observe, hand off, review and recover AI coding sessions across multiple providers while keeping task context and file/change ownership consistent.

## Scope

- Shared task, session, context snapshot and handoff contracts.
- Provider adapters and capability discovery.
- Git worktrees, branches, file claims and change-set evidence.
- Dependency-aware dispatch and bounded parallelism.
- Event log, cancellation, timeout, retry and recovery.
- Session monitor, context inspection, handoff review and merge readiness.
- Continuous in-session model changes, provider handovers and runtime history.
- A living, user-editable handover brief and visible ticket or plan purpose.
- Manual and automated provider handoffs.
- Redacted operational evidence and deterministic validation.

## Non-goals

- Reimplementing Claude, Codex or Copilot.
- Reading private provider conversation histories.
- Allowing concurrent writes to one worktree.
- Automatically merging unvalidated or policy-blocked changes.
- Requiring cloud services for the local milestone.
- Treating a provider completion claim as proof of success.

## Stories

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-092 | Shared session context and handoff contracts | Planned | FX-BF-011, FX-BF-019 |
| FX-BE-093 | Provider adapters and capability preflight | Planned | FX-BE-092 |
| FX-BE-115 | Continuous session handover, model switching and living brief | Done | FX-BE-092, FX-BE-093, FX-BF-015, FX-BF-017 |
| FX-BE-094 | Worktree, file claims and change governance | Planned | FX-BE-092, FX-BF-003 |
| FX-BE-095 | Orchestration runtime, task graph and recovery | Planned | FX-BE-093, FX-BE-094, FX-BF-013 |
| FX-BE-096 | Session operations and review experience | Planned | FX-BE-095, FX-BE-115, FX-BF-014, FX-BF-015 |

## Definition of done

A fixture repository can run design, implementation, independent review and final validation stages across providers; each stage receives the correct context, changes are isolated and attributed, handoffs are consumable by the next provider, failures are recoverable, and the UI exposes the purpose, living handover brief, runtime history and complete evidence chain.

## Verification

Use stub adapters for deterministic end-to-end tests and captured output fixtures for provider-specific parsers. Test clean, failed, cancelled, timed-out, retried, conflicting and resumed sessions. Run the read-only plan parser against baseline and final plans. Do not use the repository's own plans as a write-path test target.

## Description


## Dependencies



## Comments

