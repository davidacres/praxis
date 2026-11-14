import type { AgentSessionRecord } from '@praxis/core';

/** Execution facts only. A successful command is not a claim that a test suite passed. */
export function sessionCommandEvidence(session: AgentSessionRecord) {
  return session.events.flatMap((event, index) => {
    if (event.type !== 'tool_complete' || event.data?.kind !== 'shell') return [];
    const data = event.data;
    const outcome = data.exitCode !== undefined ? (data.exitCode === 0 ? 'Succeeded' : 'Failed')
      : data.ok === false ? 'Failed' : 'Outcome unreported';
    return [{ id: `${index}:${event.timestamp}`, command: data.argsSummary || event.summary,
      output: data.output || event.detail || '', outcome, exitCode: data.exitCode, timestamp: event.timestamp }];
  });
}
