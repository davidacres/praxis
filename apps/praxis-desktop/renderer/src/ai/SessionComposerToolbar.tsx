import type { ReactNode } from 'react';

/** Shared toolbar shell for draft and active-session composers. */
export function SessionComposerToolbar({ children }: { children: ReactNode }) {
  return <div className="composer-controls">{children}</div>;
}
