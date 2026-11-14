import type { AgentSessionRecord } from '@praxis/core';
import './sessionPresentation.css';

export function SessionRuntimeFacts({ session }: { session: AgentSessionRecord }) {
  if (!session.runtimeLaunch || session.runtimeLaunch.transport !== 'acp') return null;
  const mode = session.acpAvailableModes?.find(option => option.id === session.acpCurrentModeId);
  const name = mode?.name || session.acpCurrentModeId;
  return <details className="session-runtime-facts" data-testid="session-runtime-facts">
    <summary>Agent mode: {name || 'Not reported'}</summary>
    <dl>
      <dt>Requested access</dt><dd>{session.toolMode || 'Not recorded'}</dd>
      <dt>Requested approvals</dt><dd>{session.permissionMode || 'Not recorded'}</dd>
      <dt>Reported agent mode</dt><dd>{name || 'Not reported'}</dd>
      <dt>Requested model</dt><dd>{session.model || 'Provider default'}</dd>
      <dt>Last main reported model</dt><dd>{session.reportedModelId || 'Not reported'}</dd>
    </dl>
    {mode?.description && <p>{mode.description}</p>}
    <p className="hint">Requested settings and the agent's reported mode are shown separately. Write restrictions have not been verified.</p>
  </details>;
}
