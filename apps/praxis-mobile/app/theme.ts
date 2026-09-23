import { useSyncExternalStore } from 'react';
import type { MobileAppearance } from '@praxis/core';
import { DEFAULT_MOBILE_PALETTE, paletteFromAppearance, type MobilePalette } from '../renderer/mobileTheme';

export type MobileDisplayMode = 'compact' | 'large';

/**
 * The live palette. It starts as Praxis Dark and becomes the paired desktop's
 * theme once `host.info` or a `host.appearance` event arrives, so every read of
 * `theme.x` at render time follows the desktop.
 */
export const theme: MobilePalette & { radius: number; space: number; displayMode: MobileDisplayMode; scale: number } = {
  ...DEFAULT_MOBILE_PALETTE,
  radius: 10,
  space: 16,
  displayMode: 'compact',
  scale: 1,
};

let appearance: MobileAppearance | undefined;
let version = 0;
const listeners = new Set<() => void>();

/** The desktop theme the phone is wearing, if it has heard of one. */
export function currentAppearance(): MobileAppearance | undefined {
  return appearance;
}

/** Wears `next` (or Praxis Dark for undefined); returns whether anything changed. */
export function applyAppearance(next: MobileAppearance | undefined): boolean {
  if (JSON.stringify(next) === JSON.stringify(appearance)) return false;
  appearance = next;
  Object.assign(theme, next ? paletteFromAppearance(next) : DEFAULT_MOBILE_PALETTE);
  version += 1;
  for (const listener of listeners) listener();
  return true;
}

/** Applies the user's preferred reading/control size while keeping compact as the default. */
export function applyDisplayMode(next: MobileDisplayMode): boolean {
  if (theme.displayMode === next) return false;
  theme.displayMode = next;
  theme.scale = next === 'large' ? 1.16 : 1;
  theme.space = next === 'large' ? 20 : 16;
  theme.radius = next === 'large' ? 12 : 10;
  version += 1;
  for (const listener of listeners) listener();
  return true;
}

export function currentDisplayMode(): MobileDisplayMode {
  return theme.displayMode;
}

/** Scales a dimension or type size for the large display mode. */
export function mobileScale(value: number): number {
  return Math.round(value * theme.scale);
}

/** Re-renders the caller whenever the palette changes. The app root uses it, which repaints everything. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/**
 * A stylesheet built from the live palette: `styles.x` is rebuilt the first
 * time it is read after the palette changes, so module-level stylesheets
 * follow the desktop's theme without each screen threading it through.
 */
export function themedStyles<T>(build: () => T): T {
  let builtFor = -1;
  let built: T;
  const current = (): T => {
    if (builtFor !== version) {
      built = build();
      builtFor = version;
    }
    return built;
  };
  return new Proxy({} as object, { get: (_target, key) => (current() as Record<PropertyKey, unknown>)[key] }) as T;
}

/** Status bar text that stays readable on the current background. */
export function statusBarStyle(): 'light-content' | 'dark-content' {
  return appearance?.mode === 'light' ? 'dark-content' : 'light-content';
}
