import { useState } from 'react';
import type { AgentRuntimeSnapshot } from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  agentStartBlockedReason,
  describeCapabilities,
  eligibleAgentsForSkill,
  hostRuntimeState,
  skillActivateBlockedReason
} from './agentCatalog';
import type { ActivationMap, CatalogSelection, LifecycleAction } from './agentSelection';

/**
 * Agent Hub runtime panel — the shell's right pane for the `agents` route.
 *
 * Answers "what is this doing?": host lifecycle, negotiated capabilities, which
 * skills are active, the sessions attributed to the agent, and every action that
 * changes runtime state. The centre pane stays the read-only record.
 */

export interface AgentRuntimePanelProps {
  snapshot?: AgentRuntimeSnapshot;
  selection?: CatalogSelection;
  busy: boolean;
  activations: ActivationMap;
  sessions: Array<{ issueKey: string; title: string; agentId?: string }>;
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
  onActivate: (agentId: string, skillName: string) => void;
  onStartSession?: (agentId: string, skillNames: string[]) => void;
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
  const agent = selection?.kind === 'agent' ? snapshot?.runtimeHosts?.find(a => a.manifest.id === selection.id) : undefined;
  const skill = selection?.kind === 'skill' ? snapshot?.skills.find(s => s.metadata.name === selection.name) : undefined;

  if (!snapshot || (!profile && !agent && !skill)) {
    return (
      <div className="empty-state" data-testid="agent-runtime-empty">
        <Icon name="zap" size={26} />
        <span>Runtime state &mdash; host, capabilities, sessions &mdash; appears here for the selected agent or skill.</span>
      </div>
    );
  }

  return (
    <section className="inspector agent-runtime" aria-label="Agent runtime">
      {profile ? (
        <ProfileBinding profile={profile} snapshot={snapshot} sessions={sessions.filter(session => session.agentId === profile.profile.id)} onOpenSession={onOpenSession} />
      ) : agent ? (
        <AgentRuntime
          agent={agent}
          snapshot={snapshot}
          busy={busy}
          activations={activations[agent.manifest.id] ?? []}
          sessions={sessions.filter(session => session.agentId === agent.manifest.id)}
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
  sessions,
  onOpenSession
}: {
  profile: NonNullable<AgentRuntimeSnapshot['profiles']>[number];
  snapshot: AgentRuntimeSnapshot;
  sessions: Array<{ issueKey: string; title: string }>;
  onOpenSession?: (issueKey: string) => void;
}) {
  const compatibleHosts = (snapshot.runtimeHosts ?? snapshot.agents).filter(host => host.errors.length === 0 && host.trusted);
  return (
    <>
      <div className="agent-runtime-block">
        <Line label="Type">Provider-neutral agent profile</Line>
        <Line label="Compatible hosts">{compatibleHosts.length ? compatibleHosts.map(host => host.manifest.name).join(', ') : 'none available'}</Line>
        <Line label="Preferred skills">{profile.profile.preferredSkills?.join(', ') || 'none'}</Line>
        <Line label="Execution">Choose this profile, a provider and a runtime host in a session or workflow stage.</Line>
      </div>
      {sessions.length > 0 && (
        <div className="agent-runtime-block">
          <span className="rail-sub">Sessions</span>
          <ul className="agent-runtime-sessions">
            {sessions.map(session => (
              <li key={session.issueKey}><button type="button" className="btn-compact" onClick={() => onOpenSession?.(session.issueKey)}>{session.title}</button></li>
            ))}
          </ul>
        </div>
      )}
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
  sessions: Array<{ issueKey: string; title: string }>;
  onLifecycle: (agentId: string, action: LifecycleAction) => void;
  onStartSession?: (agentId: string, skillNames: string[]) => void;
  onOpenSession?: (issueKey: string) => void;
}) {
  const id = agent.manifest.id;
  const blocked = agentStartBlockedReason(agent);
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
        {onStartSession && (
          <button
            type="button"
            className="btn"
            disabled={busy || !!blocked}
            title={blocked}
            onClick={() => onStartSession(id, activations.map(a => a.skill))}
          >
            <Icon name="chats" size={13} /> Open a session
          </button>
        )}
      </div>
      {blocked && <p className="hint is-warn">{blocked}</p>}

      {sessions.length > 0 && (
        <div className="agent-runtime-block">
          <span className="rail-sub">Sessions</span>
          <ul className="agent-runtime-sessions">
            {sessions.map(session => (
              <li key={session.issueKey}>
                <button type="button" className="btn-compact" onClick={() => onOpenSession?.(session.issueKey)}>
                  {session.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
            <select value={target} onChange={event => setAgentId(event.target.value)}>
              {eligible.map(agent => (
                <option key={agent.manifest.id} value={agent.manifest.id}>
                  {agent.manifest.name}
                </option>
              ))}
            </select>
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
