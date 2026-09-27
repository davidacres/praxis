import { useState } from 'react';
import type { AgentRuntimeSnapshot, AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  agentStartBlockedReason,
  describeCapabilities,
  eligibleAgentsForSkill,
  hostRuntimeState,
  skillActivateBlockedReason
} from './agentCatalog';
import type { ActivationMap, CatalogSelection, LifecycleAction } from './agentSelection';
import { ChipSelect } from '../ui/ChipSelect';
import { agentStateBadgeClass, agentStateLabel } from '../ai/aiSessionState';
import { formatSubagentTokens, type SubagentItem } from '../ai/sessionNav';

/**
 * Agent Hub runtime panel — the shell's right pane for the `agents` route.
 *
 * Answers "what is this doing?": host lifecycle, negotiated capabilities, which
 * skills are active, the sessions attributed to the agent, and every action that
 * changes runtime state. The centre pane stays the read-only record.
 */

export interface AgentRuntimeSessionItem {
  issueKey: string;
  title: string;
  agentId?: string;
  profileId?: string;
  hostId?: string;
  state?: AgentSessionRecord['state'];
  model?: string;
  tokenUsage?: AgentSessionRecord['tokenUsage'];
  cost?: AgentSessionRecord['cost'];
  subagents?: SubagentItem[];
}

export interface AgentRuntimePanelProps {
  snapshot?: AgentRuntimeSnapshot;
  selection?: CatalogSelection;
  busy: boolean;
  activations: ActivationMap;
  sessions: AgentRuntimeSessionItem[];
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
  onActivate: (agentId: string, skillName: string) => void;
  onStartSession?: (agentId: string, skillNames: string[], profileId?: string) => void;
  onOpenSession?: (issueKey: string) => void;
}

export function AgentRuntimePanel({
  snapshot,
  selection,
  busy,
  activations,
  sessions,
  onLifecycle,
  onActivate,
  onStartSession,
  onOpenSession
}: AgentRuntimePanelProps) {
  const profile = selection?.kind === 'profile' ? snapshot?.profiles?.find(item => item.profile.id === selection.id) : undefined;
  const agent = selection?.kind === 'agent' ? (snapshot?.runtimeHosts ?? snapshot?.agents)?.find(a => a.manifest.id === selection.id) : undefined;
  const skill = selection?.kind === 'skill' ? snapshot?.skills.find(s => s.metadata.name === selection.name) : undefined;

  if (!snapshot || (!profile && !agent && !skill)) {
    return (
      <div className="empty-state" data-testid="agent-runtime-empty">
        <Icon name="zap" size={26} />
        <span>Runtime state &mdash; binding, capabilities, sessions &mdash; appears here for the selected profile, binding or skill.</span>
      </div>
    );
  }

  return (
    <section className="inspector agent-runtime" aria-label="Agent runtime">
      {profile ? (
        <ProfileBinding
          key={profile.profile.id}
          profile={profile}
          snapshot={snapshot}
          busy={busy}
          activations={activations[profile.profile.id] ?? []}
          sessions={sessions.filter(session => (session.profileId ?? session.agentId) === profile.profile.id)}
          onLifecycle={onLifecycle}
          {...(onStartSession ? { onStartSession } : {})}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
      ) : agent ? (
        <AgentRuntime
          agent={agent}
          snapshot={snapshot}
          busy={busy}
          activations={activations[agent.manifest.id] ?? []}
          sessions={sessions.filter(session => (session.hostId ?? session.agentId) === agent.manifest.id)}
          onLifecycle={onLifecycle}
          {...(onStartSession ? { onStartSession } : {})}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
      ) : skill ? (
        <SkillRuntime skill={skill} snapshot={snapshot} busy={busy} activations={activations} onActivate={onActivate} />
      ) : null}
    </section>
  );
}


function ProfileBinding({
  profile,
  snapshot,
  busy,
  activations,
  sessions,
  onLifecycle,
  onStartSession,
  onOpenSession
}: {
  profile: NonNullable<AgentRuntimeSnapshot['profiles']>[number];
  snapshot: AgentRuntimeSnapshot;
  busy: boolean;
  activations: Array<{ skill: string; mode: string }>;
  sessions: AgentRuntimeSessionItem[];
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
  onStartSession?: (hostId: string, skillNames: string[], profileId?: string) => void;
  onOpenSession?: (issueKey: string) => void;
}) {
  const compatibleHosts = (snapshot.runtimeHosts ?? snapshot.agents).filter(host => host.errors.length === 0 && host.trusted);
  // The launch binding that shares this profile's id is what actually runs
  // it — bundled agents (Praxis Reviewer, etc.) always have one. Treat it as
  // implicit and show its lifecycle directly, rather than asking the user to
  // pick a binding for something Praxis already knows how to run.
  const canonicalHost = compatibleHosts.find(host => host.manifest.id === profile.profile.id);
  const [hostId, setHostId] = useState(canonicalHost?.manifest.id ?? compatibleHosts[0]?.manifest.id ?? '');

  return (
    <>
      <div className="agent-runtime-block">
        <Line label="Type">Provider-neutral agent profile</Line>
        <Line label="Preferred skills">{profile.profile.preferredSkills?.join(', ') || 'none'}</Line>
        {!canonicalHost && (
          <Line label="Compatible bindings">{compatibleHosts.length ? compatibleHosts.map(host => host.manifest.name).join(', ') : 'none available'}</Line>
        )}
      </div>

      {canonicalHost ? (
        <HostLifecycle
          host={canonicalHost}
          snapshot={snapshot}
          busy={busy}
          activations={activations}
          onLifecycle={onLifecycle}
        />
      ) : (
        onStartSession &&
        compatibleHosts.length > 0 && (
          <div className="inspector-actions">
            <label className="form-field">
              <span>Launch binding</span>
              <ChipSelect
                ariaLabel="Launch binding"
                value={hostId}
                onChange={setHostId}
                options={compatibleHosts.map(host => ({ value: host.manifest.id, label: host.manifest.name }))}
              />
            </label>
          </div>
        )
      )}

      {onStartSession && (canonicalHost || compatibleHosts.length > 0) && (
        <div className="inspector-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hostId}
            onClick={() => onStartSession(hostId, profile.profile.preferredSkills ?? [], profile.profile.id)}
          >
            <Icon name="chats" size={13} /> Open a session
          </button>
        </div>
      )}

      <AgentRuntimeSessionsList sessions={sessions} onOpenSession={onOpenSession} />
    </>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="agent-runtime-line">
      <span className="rail-sub">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** Status, capabilities, active skills, and start/restart/stop for one launch binding's process. */
function HostLifecycle({
  host,
  snapshot,
  busy,
  activations,
  onLifecycle
}: {
  host: NonNullable<AgentRuntimeSnapshot['agents'][number]>;
  snapshot: AgentRuntimeSnapshot;
  busy: boolean;
  activations: Array<{ skill: string; mode: string }>;
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
}) {
  const id = host.manifest.id;
  const blocked = agentStartBlockedReason(host);
  const runtime = snapshot.hosts[id];
  const state = hostRuntimeState(snapshot, id);
  const caps = describeCapabilities(snapshot.capabilities[id]);

  return (
    <>
      <div className="agent-runtime-status">
        <span className={`lane lane--${state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'idle'}`}>●</span>
        <div>
          <strong>{state === 'running' ? 'Running' : state === 'failed' ? 'Failed to start' : 'Stopped'}</strong>
          {state === 'running' && runtime && (
            <p className="rail-sub">
              {runtime.pid ? `pid ${runtime.pid} · ` : ''}
              since {new Date(runtime.startedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>
      {runtime?.error && <p className="hint is-danger">{runtime.error}</p>}

      <div className="agent-runtime-block">
        <Line label="Capabilities">
          {caps ? (caps.features.length > 0 ? caps.features.join(', ') : 'none reported') : 'not reported yet'}
        </Line>
        {caps?.model && <Line label="Model">{caps.model}</Line>}
        {caps?.version && <Line label="Version">{caps.version}</Line>}
        <Line label="Active skills">
          {activations.length > 0 ? activations.map(a => `${a.skill} (${a.mode})`).join(', ') : 'none'}
        </Line>
      </div>

      <div className="inspector-actions">
        {state === 'running' ? (
          <>
            <button type="button" className="btn btn-primary" disabled={busy || !!blocked} title={blocked} onClick={() => onLifecycle(id, 'restart')}>
              Restart host
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => onLifecycle(id, 'stop')}>
              Stop host
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy || !!blocked} title={blocked} onClick={() => onLifecycle(id, 'start')}>
            {state === 'failed' ? 'Retry start' : 'Start host'}
          </button>
        )}
      </div>
      {blocked && <p className="hint is-warn">{blocked}</p>}
    </>
  );
}

function AgentRuntime({
  agent,
  snapshot,
  busy,
  activations,
  sessions,
  onLifecycle,
  onStartSession,
  onOpenSession
}: {
  agent: NonNullable<AgentRuntimeSnapshot['agents'][number]>;
  snapshot: AgentRuntimeSnapshot;
  busy: boolean;
  activations: Array<{ skill: string; mode: string }>;
  sessions: AgentRuntimeSessionItem[];
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
  onStartSession?: (agentId: string, skillNames: string[]) => void;
  onOpenSession?: (issueKey: string) => void;
}) {
  const id = agent.manifest.id;
  const blocked = agentStartBlockedReason(agent);

  return (
    <>
      <HostLifecycle host={agent} snapshot={snapshot} busy={busy} activations={activations} onLifecycle={onLifecycle} />

      {onStartSession && (
        <div className="inspector-actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !!blocked}
            title={blocked}
            onClick={() => onStartSession(id, activations.map(a => a.skill))}
          >
            <Icon name="chats" size={13} /> Open a session
          </button>
        </div>
      )}

      <AgentRuntimeSessionsList sessions={sessions} onOpenSession={onOpenSession} />
    </>
  );
}

function AgentRuntimeSessionsList({
  sessions,
  onOpenSession
}: {
  sessions: AgentRuntimeSessionItem[];
  onOpenSession?: (issueKey: string) => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div className="agent-runtime-block" data-testid="agent-runtime-sessions-block">
      <span className="rail-sub">Sessions ({sessions.length})</span>
      <div className="agent-runtime-sessions-list" data-testid="agent-runtime-sessions-list">
        {sessions.map(session => (
          <div key={session.issueKey} className="agent-runtime-session-card" data-testid="agent-runtime-session-card">
            <div className="agent-runtime-session-card-header">
              <button
                type="button"
                className="btn-compact agent-runtime-session-title"
                onClick={() => onOpenSession?.(session.issueKey)}
                title={session.title}
              >
                {session.title}
              </button>
              {session.state && (
                <span className={agentStateBadgeClass(session.state)} data-testid="agent-session-state-badge">
                  {agentStateLabel(session.state)}
                </span>
              )}
            </div>
            <div className="agent-runtime-session-meta">
              {session.model && (
                <span className="chip chip-muted" data-testid="agent-session-model">{session.model}</span>
              )}
              {(session.tokenUsage || session.cost) && (
                <span className="rail-sub" data-testid="agent-session-tokens">{formatSubagentTokens(session.tokenUsage, session.cost)}</span>
              )}
            </div>
            {session.subagents && session.subagents.length > 0 && (
              <div className="agent-runtime-session-subagents" data-testid="agent-runtime-subagents">
                <span className="rail-sub">Subagents ({session.subagents.length}):</span>
                <ul className="agent-runtime-subagents-list">
                  {session.subagents.map(sub => (
                    <li key={sub.id} className="agent-runtime-subagent-item" data-testid="agent-runtime-subagent-item">
                      <span className={agentStateBadgeClass(sub.status)}>{agentStateLabel(sub.status)}</span>
                      <button
                        type="button"
                        className="btn-link agent-runtime-subagent-name"
                        title={sub.title}
                        onClick={() => sub.sessionKey && onOpenSession?.(sub.sessionKey)}
                      >
                        {sub.title}
                      </button>
                      <span className="chip chip-muted" data-testid="subagent-model">{sub.model}</span>
                      <span className="rail-sub" data-testid="subagent-tokens">{formatSubagentTokens(sub.tokenUsage, sub.cost)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillRuntime({
  skill,
  snapshot,
  busy,
  activations,
  onActivate
}: {
  skill: NonNullable<AgentRuntimeSnapshot['skills'][number]>;
  snapshot: AgentRuntimeSnapshot;
  busy: boolean;
  activations: ActivationMap;
  onActivate: (agentId: string, skillName: string) => void;
}) {
  const eligible = eligibleAgentsForSkill(skill, snapshot.agents);
  const blocked = skillActivateBlockedReason(skill, snapshot.agents);
  const [agentId, setAgentId] = useState('');
  const target = agentId || eligible[0]?.manifest.id || '';
  const activeOn = Object.entries(activations)
    .map(([id, list]) => ({ id, entry: list.find(a => a.skill === skill.metadata.name) }))
    .filter((row): row is { id: string; entry: { skill: string; mode: string } } => !!row.entry);

  return (
    <>
      <div className="agent-runtime-block">
        <Line label="Active on">
          {activeOn.length > 0 ? activeOn.map(row => `${row.id} · ${row.entry.mode} mode`).join(', ') : 'not activated'}
        </Line>
      </div>

      <div className="inspector-actions">
        {eligible.length > 1 && (
          <label className="form-field">
            <span>Activate with</span>
            <ChipSelect
              ariaLabel="Activate with"
              value={target}
              onChange={setAgentId}
              options={eligible.map(agent => ({ value: agent.manifest.id, label: agent.manifest.name }))}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !!blocked || !target}
          title={blocked}
          onClick={() => onActivate(target, skill.metadata.name)}
        >
          {eligible.length === 1 ? `Activate with ${eligible[0].manifest.name}` : 'Activate'}
        </button>
      </div>
      {blocked && <p className="hint is-warn">{blocked}</p>}
    </>
  );
}
