import React from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { EasyModeSessionCard } from './EasyModeSessionCard';

export interface EasyModeSessionsListProps {
  sessions: AgentSessionRecord[];
  allSessions?: AgentSessionRecord[];
  selectedSessionKey?: string;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
}

export function EasyModeSessionsList({
  sessions,
  allSessions,
  selectedSessionKey,
  activeAgentId,
  onSelectSession,
  onSelectAgent
}: EasyModeSessionsListProps) {
  // Only display root sessions at top level; subagents appear inside their parent session's card
  const rootSessions = React.useMemo(() => {
    return sessions.filter(s => !s.parentSessionKey);
  }, [sessions]);

  if (rootSessions.length === 0) {
    return <div className="easymode-empty-hint">No active sessions</div>;
  }

  return (
    <div className="easymode-sessions-list" data-testid="easymode-sessions-list">
      {rootSessions.map(session => (
        <EasyModeSessionCard
          key={session.issueKey}
          session={session}
          allSessions={allSessions || sessions}
          isSelected={selectedSessionKey === session.issueKey}
          activeAgentId={activeAgentId}
          onSelectSession={onSelectSession}
          onSelectAgent={onSelectAgent}
        />
      ))}
    </div>
  );
}
