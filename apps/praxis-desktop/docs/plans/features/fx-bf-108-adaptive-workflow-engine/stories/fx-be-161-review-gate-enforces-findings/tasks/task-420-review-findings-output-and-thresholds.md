---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-420
slug: review-findings-output-and-thresholds
title: Review emits findings and Approve thresholds the review gate
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 161
---

# TASK-420: Review emits findings and Approve thresholds the review gate

## Description

In `governedDeliveryTemplate()`, change Review's output from `report` to a required `findings` output, add `plan-doc` to its inputs, and give Approve `gateThresholds` for `review` (no finding at `high` or above). Update the stage instructions so the reviewer judges the change against the plan and returns the findings block `praxis-reviewer` already specifies.

## Acceptance criteria

- Review declares `review-findings` (kind `findings`, required) and takes `plan-doc`.
- Approve's `requiredGates` still lists review, qa and security; its inputs reference `review-findings`.
- A run whose review reports one `high` finding shows the review gate `failed` with the existing "Found N finding(s) with severity >= high" detail.
- A reply with no findings block fails the stage ("Prose alone fails this stage").
- `workflowPlanPublishing.test.ts`'s template round-trip and `workflowTemplates` tests pass; a new test pins the gate behaviour.

## Dependencies

- None

## Comments
