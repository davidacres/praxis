# HTML Plan Writing Guide

## Structure

Use this order unless the user requests a different shape:

1. Title block with status, owner, date, and confidence
2. Executive summary
3. Goals and non-goals
4. Scope, assumptions, and constraints
5. Architecture or delivery approach
6. Phased plan or workstreams
7. Dependency map
8. Risk register
9. Verification and rollout
10. Open questions and decision log
11. Styles, colors, and branding direction

For UI-heavy or mockup-led work, also add:

12. Whiteboard sketch to working UI
13. Screenshot to working clone
14. Visual inventory and fidelity notes

## Content Rules

- Replace placeholders with concrete project-specific details.
- Keep each section actionable; avoid generic planning prose.
- Explicitly label assumptions and unresolved questions.
- Use concise bullets for execution tasks and short paragraphs for rationale.
- Prefer verification criteria that can be observed or tested.
- For visual planning, separate `Observed`, `Inferred`, and `Recommended` so readers know what came from the mockup versus the plan author.
- Turn screenshots and sketches into implementation guidance by mapping regions, controls, states, spacing patterns, and interaction intent.
- Explain the target fidelity level: pixel-close clone, behavior-close adaptation, or design-system translation.
- Add a styles, colors, and branding section that explains the intended visual identity in practical implementation terms.
- If the prompt contains brand cues, preserve them; otherwise recommend a default warm Claude Code-style direction and label it as a fallback recommendation.

## Styling Rules

- Treat the page like a developer artifact, not a marketing site.
- Use a warm dark palette with soft borders and restrained accent color.
- Use contrast to separate primary content, secondary notes, and caution states.
- Keep motion out unless a task explicitly asks for interactivity.
- Make print output clean: white background, dark text, reduced shadows.

## Output Rules

- Return `<!DOCTYPE html>` and a full document.
- Keep CSS inside a single `<style>` block.
- Avoid external libraries.
- Avoid JavaScript unless the request explicitly requires interactive behavior.