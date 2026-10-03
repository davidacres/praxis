import type { AgentSessionRecord } from '@praxis/core';
import { SessionsPage, type SessionComposerOptions } from './SessionsPage';

interface SessionComposerProps {
  session: AgentSessionRecord;
  /** All sessions for account spend totals; the active record comes from the owning conversation. */
  sessions?: AgentSessionRecord[];
  options?: SessionComposerOptions;
}

const noNavigation = () => undefined;

/**
 * The existing-session composer, with its queue, attachments, runtime controls
 * and permission responses. Both presentations use the SessionsPage controller;
 * embedding it does not mount a second transcript, browser or gadget executor.
 */
export function SessionComposer({ session, sessions = [], options }: SessionComposerProps) {
  return (
    <SessionsPage
      presentation="composer"
      composerOptions={options}
      sessions={[session, ...sessions.filter(candidate => candidate.issueKey !== session.issueKey)]}
      selectedKey={session.issueKey}
      onNewSession={noNavigation}
      onSelectSession={noNavigation}
      onOpenAiSettings={noNavigation}
    />
  );
}
