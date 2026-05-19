---
name: HTML Plan Authoring
description: "Use when creating or editing HTML planning agents, plan templates, or plan-generation workflow assets. Keep plan artifacts self-contained, detailed, semantic, print-friendly, and styled with a warm Claude Code-inspired developer-tool aesthetic."
applyTo:
  - ".github/agents/html-feature-planner.agent.md"
  - ".github/skills/html-feature-plan/**"
---

# HTML Plan Authoring Guidelines

- Prefer one complete HTML document over fragments.
- Prefer generating real workspace artifacts under `docs/html/` when the task is about producing a plan document for review.
- Keep styles inline and driven by CSS variables so the artifact is portable.
- Use semantic structure and obvious section headings so the output still works if styles are stripped.
- Favor warm dark neutrals, amber accents, subtle borders, and compact typography over glossy marketing-page styling.
- Include enough planning detail to execute the work: scope, assumptions, dependencies, risks, verification, rollout, and open questions.
- When the input is a sketch, wireframe, screenshot, or mockup, include explicit translation sections that explain how the visual reference becomes a working UI.
- Prefer visual-spec sections such as screen inventory, component mapping, interaction notes, layout tokens, and implementation checkpoints when the plan is UI-heavy.
- Include a dedicated styles, colors, and branding section when the work is UI-facing so visual direction is explicit.
- Include a dedicated design system section when the work is UI-facing so tokens, components, states, and interaction rules are easy to follow.
- Include working component examples inside the design-system section so readers can see specimen buttons, text inputs, boxes, groups, panels, radii, and surface shades instead of reading abstract guidance alone.
- If the user provides brand cues, derive suggestions from those cues; otherwise, fall back to the standard Claude Code-inspired palette, typography density, and surface treatment already used by this planner.
- If critical planning inputs are unclear, ask before generating the final artifact. Typical gaps include target users, fidelity expectations, primary actions, information hierarchy, brand constraints, and design-system expectations.
- When files are generated, keep them in `docs/html/` and return clear links or filenames for the main output and any supporting help files.
- Make unknowns explicit instead of filling gaps with invented certainty.
- Add print-friendly rules so the document remains usable when exported to PDF.
- Avoid JavaScript unless the task explicitly needs interaction.
- Keep tables and cards readable on narrow screens; default to simple responsive grids.