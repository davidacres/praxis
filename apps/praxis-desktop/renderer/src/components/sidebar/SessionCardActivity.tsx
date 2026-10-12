import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../../ui/Icon';

/** Activity and action gates use the same presentation in both sidebar modes. */
export function SessionCardActivity({ session, gateTestId }: { session: AgentSessionRecord; gateTestId?: string }) {
  const running = ['executing', 'planning', 'awaiting_approval', 'awaiting_input'].includes(session.state);
  const latestEvent = session.events?.[session.events.length - 1];
  const ticker = running ? latestEvent?.summary || (session.state === 'planning' ? 'Planning next steps…' : 'Agent working…') : undefined;
  return <>
    {(session.state === 'awaiting_approval' || session.state === 'awaiting_input') && (
      <div className="action-gate-callout" data-testid={gateTestId}>
        <Icon name="warning" size={12} />
        <span>Action Gate: {session.state === 'awaiting_approval' ? 'Approval required' : 'Input required'}</span>
      </div>
    )}
    {ticker && (
      <div className="easymode-session-card__ticker" title={ticker}>
        <span className="easymode-ticker-dot" />
        <span className="easymode-ticker-text">{ticker}</span>
      </div>
    )}
  </>;
}
