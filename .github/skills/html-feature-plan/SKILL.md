---
name: html-feature-plan
description: 'Create feature-rich HTML implementation plans, execution roadmaps, migration plans, and technical design plans. Use for planning tasks that should end as a polished self-contained HTML artifact with a Claude Code-inspired warm dark layout.'
argument-hint: 'Describe the feature, ticket, problem, or initiative to plan, plus any constraints, milestones, and required sections.'
user-invocable: true
---

# HTML Feature Plan

Generate a planning artifact as a complete HTML document instead of markdown.

## When To Use

- The user wants a plan, roadmap, implementation strategy, or migration document.
- The plan should be shareable as a rich artifact or easy to export to PDF.
- The output needs stronger visual hierarchy than plain markdown.
- The plan needs to combine scope, sequencing, risk, dependency, and verification detail in one document.
- The user has sketches, screenshots, wireframes, or mockups that need to be translated into a buildable UI plan or visual PRD.
- The reader would benefit from explicit style, palette, and brand recommendations alongside the implementation plan.
- The user wants a generated artifact they can open immediately in the internal browser instead of only reading inline chat output.

## Procedure

1. Gather the concrete planning inputs from the user request, nearby code, existing docs, tickets, and configuration.
2. If key inputs are missing, ask clarifying questions before generating the final artifact.
3. Separate confirmed facts from assumptions, unknowns, and decisions that still need confirmation.
4. Build the plan around the structure in [the HTML template](./assets/feature-plan-template.html).
5. If visual references exist, add explicit sections for whiteboard sketch to working UI and screenshot to working clone.
6. Add a styles, colors, and branding section that either follows prompt-derived cues or falls back to the planner's Claude Code-inspired default system.
7. Add a design system section that either follows prompt-derived cues or falls back to the planner's compact admin-tool defaults.
8. Fill the document with concrete project details instead of generic filler text.
9. Keep the output self-contained with inline CSS and a warm developer-tool visual language.
10. Save the generated files under `docs/html/`, open the main result in the internal browser, and report links or file paths back to the user.

## Content Requirements

- Include an executive summary that explains why the work matters.
- State goals, non-goals, scope boundaries, and assumptions.
- Break execution into phases or workstreams with sensible ordering.
- Surface dependencies, risks, mitigation steps, and verification strategy.
- End with open questions or decisions when the source material is incomplete.
- For mockup-driven tasks, include a visual translation layer: what is directly observed, what is inferred, what components are needed, and what fidelity level is expected.
- For clone-oriented tasks, explain which details must match the reference closely and which can adapt to the target stack or design system.
- Include explicit visual identity guidance: palette, typography mood, surface treatment, iconography direction, and branding notes.
- State whether each branding suggestion is prompt-derived, reference-derived, or a default Claude Code-style fallback.
- Include explicit design-system guidance: tokens, spacing, component families, states, interaction patterns, and layout rules.
- State whether each design-system suggestion is prompt-derived, reference-derived, or a planner-default fallback.
- Include working component specimens inside the document so the design system demonstrates actual buttons, text inputs, boxes, groups, panels, radii, and shade layers.

## Visual Requirements

- Use charcoal or graphite surfaces, warm neutral text, amber accents, and restrained status colors.
- Prefer cards, section dividers, metadata chips, and compact tables over large prose blocks.
- Keep the layout readable on desktop and narrow screens.
- Add print rules so the artifact remains usable when exported.
- When useful, include side-by-side comparison cards or mapping tables that connect reference visuals to implementation tasks.

## References

- [Template](./assets/feature-plan-template.html)
- [Writing guide](./references/plan-writing-guide.md)