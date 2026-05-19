---
name: HTML Plan Authoring
description: "Use when creating or editing HTML planning agents, plan templates, or plan-generation workflow assets. Keep plan artifacts self-contained, detailed, semantic, print-friendly, and styled with a warm Claude Code-inspired developer-tool aesthetic."
applyTo:
  - ".github/agents/html-feature-planner.agent.md"
  - ".github/skills/html-feature-plan/**"
---

# HTML Plan Authoring Guidelines

- Prefer one complete HTML document over fragments.
- Keep styles inline and driven by CSS variables so the artifact is portable.
- Use semantic structure and obvious section headings so the output still works if styles are stripped.
- Favor warm dark neutrals, amber accents, subtle borders, and compact typography over glossy marketing-page styling.
- Include enough planning detail to execute the work: scope, assumptions, dependencies, risks, verification, rollout, and open questions.
- When the input is a sketch, wireframe, screenshot, or mockup, include explicit translation sections that explain how the visual reference becomes a working UI.
- Prefer visual-spec sections such as screen inventory, component mapping, interaction notes, layout tokens, and implementation checkpoints when the plan is UI-heavy.
- Include a dedicated styles, colors, and branding section when the work is UI-facing so visual direction is explicit.
- If the user provides brand cues, derive suggestions from those cues; otherwise, fall back to the standard Claude Code-inspired palette, typography density, and surface treatment already used by this planner.
- Make unknowns explicit instead of filling gaps with invented certainty.
- Add print-friendly rules so the document remains usable when exported to PDF.
- Avoid JavaScript unless the task explicitly needs interaction.
- Keep tables and cards readable on narrow screens; default to simple responsive grids.