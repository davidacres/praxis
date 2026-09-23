/**
 * Every icon-only control gets a tooltip.
 *
 * A button whose face is just a glyph says nothing to someone who has not learnt the
 * icon, so it must carry an accessible name (`aria-label`) — and that name is exactly
 * what its tooltip should say. Rather than repeat it as `title` on ~160 call sites (and
 * rely on every new button remembering), the first time the pointer or keyboard focus
 * reaches such a control we copy its `aria-label` into `title`.
 *
 * Rules:
 * - Only controls with no visible text. A labelled button ("Save workflow") needs no tooltip.
 * - An explicit `title` always wins; we never overwrite one we did not set.
 * - A title we set is marked (`data-auto-title`) and refreshed on each visit, so it follows
 *   an `aria-label` that changes (e.g. "Expand" → "Collapse").
 *
 * `e2e/iconButtonTooltips.spec.ts` checks that every visible icon-only button on the main
 * screens ends up with a tooltip — which also catches one with no accessible name at all.
 */

const CONTROL = 'button, [role="button"], a[href]';

/** Text a sighted person can read on the control — screen-reader-only text does not count. */
function visibleText(element: Element): string {
  let text = '';
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.sr-only')) continue;
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    text += node.textContent ?? '';
  }
  return text.trim();
}

export function iconOnlyTooltipText(element: Element): string | undefined {
  if (visibleText(element)) return undefined;
  const label = element.getAttribute('aria-label')?.trim();
  if (label) return label;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  return undefined;
}

function applyTooltip(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const control = target.closest(CONTROL);
  if (!control) return;
  const auto = control.hasAttribute('data-auto-title');
  if (control.hasAttribute('title') && !auto) return;
  const text = iconOnlyTooltipText(control);
  if (text) {
    if (control.getAttribute('title') !== text) control.setAttribute('title', text);
    control.setAttribute('data-auto-title', '');
  } else if (auto) {
    // It gained visible text (or lost its label) since we last set one.
    control.removeAttribute('title');
    control.removeAttribute('data-auto-title');
  }
}

let installed = false;

export function installIconButtonTooltips(): void {
  if (installed) return;
  installed = true;
  // Capture phase and passive: this only ever adds an attribute, before the browser
  // decides whether to show a tooltip for the element under the pointer.
  document.addEventListener('pointerover', event => applyTooltip(event.target), { capture: true, passive: true });
  document.addEventListener('focusin', event => applyTooltip(event.target), { capture: true });
}
