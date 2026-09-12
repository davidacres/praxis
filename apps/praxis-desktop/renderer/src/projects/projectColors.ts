import type { ProjectColorName } from '@praxis/core';

/**
 * Duplicated from core's `PROJECT_COLOR_NAMES`, not imported — core is
 * CommonJS and a value import from `@praxis/core` compiles clean under
 * `tsc --noEmit` but silently breaks `vite build` (see AGENTS.md's "Shared
 * logic belongs in core" section). Keep this list identical to core's;
 * `projectTypes.ts` names it as the thing to keep in sync. Shared by every
 * renderer spot that shows or picks a project's color (`ProjectHome`,
 * `Sidebar`) so there is exactly one renderer-side copy, not one per file.
 *
 * The actual hex per name lives in `theme.css` as `--project-color-<name>` —
 * this file only ever references those custom properties, never a hex
 * literal, so the color has exactly one owner.
 */
export const PROJECT_COLOR_NAMES: readonly ProjectColorName[] = [
  'blue',
  'orange',
  'aqua',
  'yellow',
  'magenta',
  'green',
  'violet',
  'red'
];

/** The CSS value for a project's color name — `undefined` for "no color picked". */
export function projectColorValue(color: ProjectColorName | undefined): string | undefined {
  return color ? `var(--project-color-${color})` : undefined;
}
