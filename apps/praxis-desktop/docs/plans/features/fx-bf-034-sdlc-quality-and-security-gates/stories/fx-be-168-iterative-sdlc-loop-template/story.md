---
**Status:** ✅ Complete
**Type:** Story
type: Story
id: FX-BE-168
title: "Iterative SDLC loop template"
status: Done
feature: FX-BF-034
updated: 2026-09-10
dependencies: [FX-BE-087, FX-BE-088, FX-BE-089, FX-BE-090]
---

# FX-BE-168: Iterative SDLC loop template

**Priority:** Medium
**Created:** 2026-09-10

## Outcome

A marketplace template family (`full-sdlc-loop`, per-stack variants) that realizes the requested SDLC workflow: a coding task, code review, BDD testing and review, a security review, an automated test review, and a UI/UX review, with the run iterating whenever any stage fails. BDD scenarios are authored from the plan before implementation and consumed by implement, the BDD execution check, and the test review. Gate ownership splits across the verification band: QA by lint/typecheck/unit tests/BDD run, security by SAST/secrets/SCA plus a dedicated security-review agent, review by the code-review and test-review agents. UI/UX review is advisory (owns no gate) so a subjective review cannot block delivery. Because the static validator rejects every cycle, iteration is bounded: `maxAttempts` per stage plus gate thresholds that hold approval until findings are clean and coverage meets the bar, surfaced through the run monitor's retry and rework actions.

## Tasks

- [x] [TASK-437](tasks/task-253-iterative-sdlc-loop-template.md) — Add the iterative SDLC loop template with BDD and four review stages

## Description


## Dependencies



## Comments


