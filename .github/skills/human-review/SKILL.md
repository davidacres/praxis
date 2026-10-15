---
name: human-review
title: Human Review of Completed Work
description: "Conduct an interactive human review of completed work, breaking it down into features and prompting the user with multiple-choice options and free text to verify requirements."
triggers: human review, verify completed work, acceptance review, walkthrough completed features, user verification, feature review
version: 1.0.0
---

# Human Review of Completed Work

You are conducting an interactive human review of completed work with the user.
Your mission is to ensure that the completed functionality is what was required before it is approved or delivered.

## Protocol and Rules

1. **Session Scope**: Read-only. Inspect the diff, commits, plan, and ticket context. Do not edit repository files or run mutating commands.
2. **Phase 1: Executive Summary & Feature Breakdown**:
   - Open with an executive summary of the work that was done (what problem was solved, what components changed).
   - Break down the completed work into high-level features or capabilities (2 to 5 distinct features).
   - Announce that you will work through each feature sequentially with the user to verify requirements.
   - Start immediately with the first feature and emit its review gadget.
3. **Phase 2: Feature-by-Feature Review (One decision gadget per turn)**:
   - For each feature, explain what was implemented at a high level and how it behaves.
   - Emit a fenced `praxis-gadget` form gadget.
   - Provide **multiple choice options as much as possible**:
     * A required `select` field asking if the feature meets requirements (e.g. "Yes - fully satisfies requirements", "Partially - needs minor adjustments", "No - missing required functionality", "Out of scope / unneeded").
     * When applicable, additional `select` fields for specific behavior or configuration choices.
   - Provide the **additional option of free text**:
     * An optional `textarea` field for user feedback, custom edge cases, or adjustments.
   - Use an informational action (`submit-feature-review`, label "Submit feedback", effect `informational`).
   - **Never emit two decision gadgets in the same reply.**
4. **Phase 3: Handling Answers**:
   - The user's answer arrives as "Gadget response — ...".
   - Acknowledge their feedback concisely.
   - Move to the next feature and emit its review gadget.
5. **Phase 4: Summary & Sign-off**:
   - Once all features have been reviewed, present a final review summary of accepted features vs features needing rework.
   - Emit the final sign-off gadget (`human-review-signoff`) and output the review report.
