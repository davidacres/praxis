import { useEffect, useState } from 'react';
import type { CoordinationClaim, CoordinationResource, CoordinationState } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * Who else is working here, in the sessions inspector (FX-BF-048 / TASK-394).
 *
 * Shows what this session holds, what other sessions in the same repository hold or are
 * waiting for, and how firmly this session is coordinated: `enforced` (every write and
 * command goes through Praxis), `cooperative` (only what the agent routes through Praxis or
 * claims itself), `observed`. A claim whose owner stopped responding is never handed over
 * on its own; a person confirms it stopped, here.
 *
 * Renders nothing when this session has never coordinated and nothing else is held nearby.
 */

const COVERAGE_HELP: Record<string, string> = {
  enforced: 'Enforced: every file write and shell command this session makes is checked first, and refused if another session holds it.',
  cooperative: 'Cooperative: the agent runs its own tools, so Praxis checks only the writes it routes through Praxis and what it claims itself.',
  observed: 'Observed: Praxis sees this session but cannot stop its changes.'
};

/** Mirrors core's `describeResource` (the renderer imports types only from core). */
function describe(resource: CoordinationResource): string {
  switch (resource.kind) {
    case 'file':
      return resource.path;
    case 'directory':
      return resource.path ? `${resource.path}/` : 'the whole repository';
    case 'worktree':
      return 'the whole checkout';
    case 'checkout':
      return 'the branch';
    case 'git-index':
      return 'staged changes';
    case 'app-ui':
      return 'the running app';
    case 'browser':
      return 'the in-app browser';
    case 'desktop':
      return 'the desktop';
    case 'build-output':
      return `build output ${resource.dir}`;
    case 'port':
      return `port ${resource.port}`;
    case 'fixture':
      return `fixture ${resource.id}`;
  }
}

function since(ms: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}

export function SessionCoordination({ sessionKey }: { sessionKey: string }) {
  const [state, setState] = useState<CoordinationState | undefined>();
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.praxis.coordination
        .state()
        .then(result => {
          if (!alive) return;
          setState(result.state);
          setBlockedReason(result.blockedReason);
        })
        .catch(() => undefined);
    void load();
    const off = window.praxis.coordination.onChanged(() => void load());
    // Another app instance may be the broker; its changes arrive here by polling.
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      off();
      window.clearInterval(timer);
    };
  }, []);

  if (!state) return null;
  const me = state.sessions[sessionKey];
  const scope = me?.scope;
  const nearby = (claim: CoordinationClaim) => claim.owner.sessionKey === sessionKey || !scope || state.sessions[claim.owner.sessionKey]?.scope === scope;
  const mine = state.claims.filter(claim => claim.owner.sessionKey === sessionKey);
  const others = state.claims.filter(claim => claim.owner.sessionKey !== sessionKey && nearby(claim));
  const waiting = state.waiters.filter(waiter => waiter.owner.sessionKey === sessionKey || !scope || state.sessions[waiter.owner.sessionKey]?.scope === scope);
  if (!me && others.length === 0 && !blockedReason) return null;

  const recover = (claim: CoordinationClaim) => {
    setError(undefined);
    window.praxis.coordination.recover(claim.claimId, `Confirmed in Praxis that ${claim.owner.sessionKey} stopped.`).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const row = (claim: CoordinationClaim) => (
    <li key={claim.claimId} className={`is-${claim.state}`} data-testid="session-coordination-claim">
      <Icon name={claim.state === 'recovery-required' ? 'warning' : 'file'} size={12} />
      <span className="session-coordination-text">
        <strong>{describe(claim.resource)}</strong>
        {claim.owner.sessionKey !== sessionKey && <> · {claim.owner.sessionKey}</>}
        <span className="session-coordination-reason"> — {claim.reason} · {since(claim.grantedAt)}</span>
        {claim.state === 'recovery-required' && <span className="session-coordination-reason"> · its session stopped responding</span>}
      </span>
      {claim.state === 'recovery-required' && (
        <button type="button" className="btn btn-quiet btn-compact" onClick={() => recover(claim)} data-testid="session-coordination-recover">
          Confirm stopped
        </button>
      )}
    </li>
  );

  return (
    <div className="agent-runtime-block session-coordination" data-testid="session-coordination">
      <div className="session-tasks-heading">
        <span className="rail-sub">Coordination</span>
        {me && (
          <span className={`session-coordination-coverage is-${me.coverage}`} title={COVERAGE_HELP[me.coverage]} data-testid="session-coordination-coverage">
            {me.coverage}
          </span>
        )}
      </div>
      {blockedReason && <p className="session-coordination-alert" role="alert">{blockedReason}</p>}
      {mine.length > 0 && (
        <>
          <span className="rail-sub">Holding</span>
          <ul className="session-tasks-list session-coordination-list">{mine.map(row)}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <span className="rail-sub">Other sessions here</span>
          <ul className="session-tasks-list session-coordination-list">{others.map(row)}</ul>
        </>
      )}
      {waiting.length > 0 && (
        <>
          <span className="rail-sub">Waiting</span>
          <ul className="session-tasks-list session-coordination-list">
            {waiting.map(waiter => (
              <li key={waiter.requestId} data-testid="session-coordination-waiter">
                <Icon name="dot" size={12} />
                <span className="session-coordination-text">
                  {waiter.owner.sessionKey === sessionKey ? 'This session' : waiter.owner.sessionKey}
                  <span className="session-coordination-reason"> — {waiter.reason} · {since(waiter.enqueuedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {me && mine.length === 0 && others.length === 0 && waiting.length === 0 && <p className="rail-sub">Nothing held; no other session is working here.</p>}
      {error && <p className="session-coordination-alert" role="alert">{error}</p>}
    </div>
  );
}
