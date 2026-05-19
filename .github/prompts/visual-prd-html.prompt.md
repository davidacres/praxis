---
name: Visual PRD HTML
description: "Create a polished visual PRD or implementation plan as self-contained HTML. Use when you have a feature idea, screenshots, wireframes, whiteboard sketches, or branding notes and want a reader-friendly plan artifact."
argument-hint: "Describe the feature, include any mockup or screenshot notes, target audience, brand cues, fidelity expectations, and constraints."
agent: "HTML Feature Planner"
---

Create a complete self-contained HTML visual PRD using the available context and the user input for this prompt.

Interpret the input as the planning source of truth, including any combination of:

- feature or product requirements
- tickets or initiative summaries
- whiteboard sketches or wireframe notes
- screenshot descriptions or clone targets
- brand cues, tone words, palette hints, or style references
- technical constraints, milestones, and delivery risks

Requirements for the output:

- If critical inputs are missing, ask concise clarifying questions before generating files.
- Generate the main result as an HTML file under `docs/html/`.
- Generate any supporting help files under `docs/html/` as well.
- Open the main generated HTML file in the internal browser when done.
- Make the document presentation-ready with inline CSS and no external dependencies.
- Include the core planning structure: summary, goals, scope, architecture or delivery approach, phased execution, dependencies, risks, verification, rollout, and open questions.
- Include the visual translation structure when relevant: whiteboard sketch to working UI, screenshot to working clone, visual inventory, and fidelity notes.
- Include a dedicated styles, colors, and branding section.
- Include a dedicated design system section.
- Include working design-system examples for key controls and containers, such as buttons, text inputs, boxes, groups, panels, radii, and shade treatments.
- If the user provides brand or style direction, derive recommendations from that input and label them clearly.
- If the user does not provide brand or style direction, fall back to the planner's default Claude Code-inspired warm developer-tool aesthetic and label it as a fallback recommendation.
- If the user provides design-system cues, derive recommendations from that input and label them clearly.
- If the user does not provide design-system cues, fall back to the planner's default compact admin-tool design system and label it as a fallback recommendation.
- Distinguish clearly between observed details, inferred behavior, and implementation recommendations whenever the plan is based on visual references.
- In the final response, provide links or file paths to the generated files and identify which one was opened in the internal browser.

Quality bar:

- The artifact should help a designer, engineer, or stakeholder understand both what to build and how it should look and feel.
- Prefer concrete implementation guidance over generic product language.
- Surface missing information as assumptions or open questions instead of inventing certainty.

Use the planner's existing HTML planning structure and visual system as the baseline.