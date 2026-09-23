import { normalizeMobileAppearance, type MobileAppearance } from '@praxis/core';

/**
 * The theme the desktop window last applied, resolved to colours by the
 * renderer. Main can't resolve it itself: built-in, custom and marketplace
 * themes only exist as CSS and renderer registrations. Paired phones read it
 * from `host.info` and follow changes through the `host.appearance` event.
 */
let current: MobileAppearance | undefined;
const listeners = new Set<(appearance: MobileAppearance) => void>();

export function getDesktopAppearance(): MobileAppearance | undefined {
  return current;
}

/** Accepts a renderer-supplied appearance; malformed input is ignored, and an unchanged one notifies nobody. */
export function setDesktopAppearance(value: unknown): void {
  const appearance = normalizeMobileAppearance(value);
  if (!appearance || JSON.stringify(appearance) === JSON.stringify(current)) return;
  current = appearance;
  for (const listener of listeners) listener(appearance);
}

export function onDidChangeDesktopAppearance(listener: (appearance: MobileAppearance) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
