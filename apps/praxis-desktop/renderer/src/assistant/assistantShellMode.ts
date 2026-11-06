/**
 * Where the assistant panel lives (floating popover or docked column) and whether it is open.
 *
 * TASK-484 AC-A: switching a panel between dock and float must not change execution ownership. The
 * conversation subscription, the pending-submission map and every mutation command live in
 * `AssistantProvider`, keyed by conversation id; the shell only decides which container renders the
 * one panel. So the shell mode is exactly two persisted booleans plus the conversation it is
 * showing — and a mode change carries that conversation through untouched, issuing no assistant
 * command of any kind.
 */

export const DOCKED_KEY = 'tm-assistant-docked';
export const OPEN_KEY = 'tm-assistant-open';

/** The minimal storage the shell mode persists into; `localStorage` in the app. */
export interface ShellModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ShellModeAction = 'dock' | 'float' | 'toggleDock' | 'open' | 'close' | 'toggleOpen';

export interface ShellMode {
  docked: boolean;
  open: boolean;
}

/** The shell's state plus the conversation it is showing; the id is carried, never derived. */
export interface ShellModeState extends ShellMode {
  /** The open conversation, if any. Docking or floating never changes it. */
  conversationId?: string;
}

export function readBool(store: ShellModeStore, key: string, fallback: boolean): boolean {
  const raw = store.getItem(key);
  return raw === null ? fallback : raw === '1';
}

export function readShellMode(store: ShellModeStore): ShellMode {
  return { docked: readBool(store, DOCKED_KEY, false), open: readBool(store, OPEN_KEY, false) };
}

/** The persisted form of a mode: the two keys the app has always used. */
export function persistShellMode(store: ShellModeStore, mode: ShellMode): void {
  store.setItem(DOCKED_KEY, mode.docked ? '1' : '0');
  store.setItem(OPEN_KEY, mode.open ? '1' : '0');
}

/** The mode after one shell action. Pure: no storage, no IPC, no conversation state. */
export function nextShellMode(current: ShellMode, action: ShellModeAction): ShellMode {
  switch (action) {
    case 'dock': return { ...current, docked: true };
    case 'float': return { ...current, docked: false };
    case 'toggleDock': return { ...current, docked: !current.docked };
    case 'open': return { ...current, open: true };
    case 'close': return { ...current, open: false };
    case 'toggleOpen': return { ...current, open: !current.open };
  }
}

/**
 * A shell action applied to the whole shell state.
 *
 * Returns the assistant commands the transition issues — always none — alongside the new state, so
 * the ownership-neutrality claim is something a test can assert rather than something a reader has
 * to take on trust. `conversationId` is copied through by construction: nothing in this module can
 * read or write conversation state.
 */
export function applyShellModeAction(state: ShellModeState, action: ShellModeAction): { state: ShellModeState; commands: readonly string[] } {
  return { state: { ...nextShellMode(state, action), ...(state.conversationId === undefined ? {} : { conversationId: state.conversationId }) }, commands: [] };
}
