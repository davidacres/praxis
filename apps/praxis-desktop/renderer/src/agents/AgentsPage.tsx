import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentRuntimeSnapshot, DiscoveredAgent, DiscoveredSkill, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  agentStartBlockedReason,
  describeCapabilities,
  eligibleAgentsForSkill,
  groupCatalog,
  hostRuntimeState,
  runningHostCount,
  skillActivateBlockedReason,
  transportLabel
} from './agentCatalog';
import { CreateAgentDialog, CreateSkillDialog, ImportDialog } from './AgentHubDialogs';

/**
 * Agent Hub (FX-BF-009).
 *
 * A scope-aware catalog for the `agents` sidebar route: a tree of Global and
 * project-local agents and skills on the left, a detail pane on the right.
 * Discovery is read-only; starting a host or activating a skill is an explicit,
 * fail-closed action. Advanced policy and paths stay in Settings.
 */

type Selection = { kind: 'agent'; id: string } | { kind: 'skill'; name: string };

export interface AgentsPageProps {
  /** The routed project, so the "This project" scope can be named. */
  project?: ProjectRecord;
  /** Opens the Settings agent-runtime section (paths, policy, diagnostics live there). */
  onOpenSettings?: () => void;
}

export function AgentsPage({ project, onOpenSettings }: AgentsPageProps) {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Selection>();
  const [dialog, setDialog] = useState<'agent' | 'skill' | 'import'>();

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(refresh ? await window.praxis.agentRuntime.refresh() : await window.praxis.agentRuntime.list());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const groups = useMemo(() => (snapshot ? groupCatalog(snapshot) : []), [snapshot]);

  const selectedAgent =
    selected?.kind === 'agent' ? snapshot?.agents.find(agent => agent.manifest.id === selected.id) : undefined;
  const selectedSkill =
    selected?.kind === 'skill' ? snapshot?.skills.find(skill => skill.metadata.name === selected.name) : undefined;

  const act = useCallback(
    async (run: () => Promise<AgentRuntimeSnapshot>) => {
      setBusy(true);
      setError(undefined);
      try {
        setSnapshot(await run());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const afterAuthoring = useCallback((snap: AgentRuntimeSnapshot) => {
    setSnapshot(snap);
    setDialog(undefined);
  }, []);

  return (
    <div className="view-scroll wf-page agent-hub">
      <header className="wf-header">
        <h1>Agents</h1>
        <span className="wf-header-sub">
          {snapshot
            ? `${snapshot.agents.length} agent${snapshot.agents.length === 1 ? '' : 's'} · ${snapshot.skills.length} skill${
                snapshot.skills.length === 1 ? '' : 's'
              }${runningHostCount(snapshot) > 0 ? ` · ${runningHostCount(snapshot)} running` : ''}`
            : 'Loading…'}
        </span>
        <div className="agent-hub-actions">
          <button type="button" className="btn btn-compact" onClick={() => setDialog('agent')} disabled={busy}>
            <Icon name="plus" size={13} /> Agent
          </button>
          <button type="button" className="btn btn-compact" onClick={() => setDialog('skill')} disabled={busy}>
            <Icon name="plus" size={13} /> Skill
          </button>
          <button type="button" className="btn btn-compact" onClick={() => setDialog('import')} disabled={busy}>
            <Icon name="folder-open" size={13} /> Import
          </button>
          <button type="button" className="btn btn-compact" onClick={() => void load(true)} disabled={busy}>
            <Icon name="refresh" size={13} /> {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}

      <div className="agent-hub-body">
        <nav className="wf-rail" aria-label="Agent catalog">
          {!snapshot ? (
            <ul className="wf-rail-list" aria-busy="true">
              {[0, 1, 2].map(i => (
                <li key={i} className="wf-rail-row wf-skeleton" aria-hidden />
              ))}
            </ul>
          ) : groups.length === 0 ? (
            <div className="empty-state">
              <Icon name="robot" size={26} />
              <span>No agents or skills discovered.</span>
              {onOpenSettings && (
                <button type="button" className="btn btn-compact" onClick={onOpenSettings}>
                  Where do these live?
                </button>
              )}
            </div>
          ) : (
            groups.map(group => (
              <section key={group.scope} className="agent-hub-group" aria-label={`${group.label} catalog`}>
                <h2>{group.scope === 'project' && project ? project.name : group.label}</h2>
                <ul className="wf-rail-list">
                  {group.agents.map(agent => (
                    <li key={`a:${agent.manifest.id}`}>
                      <button
                        type="button"
                        className="wf-rail-row"
                        aria-pressed={selected?.kind === 'agent' && selected.id === agent.manifest.id}
                        onClick={() => setSelected({ kind: 'agent', id: agent.manifest.id })}
                      >
                        <Icon name="robot" size={14} />
                        <span className="wf-rail-main">
                          <span className="wf-rail-name">{agent.manifest.name}</span>
                          <span className="wf-rail-sub">
                            {transportLabel(agent.manifest.type)}
                            {hostRuntimeState(snapshot!, agent.manifest.id) === 'running' && ' · running'}
                            {hostRuntimeState(snapshot!, agent.manifest.id) === 'failed' && ' · failed'}
                          </span>
                        </span>
                        {hostRuntimeState(snapshot!, agent.manifest.id) === 'running' ? (
                          <span className="wf-lane wf-lane--running" aria-label="Host running">●</span>
                        ) : (
                          <TrustMark trusted={agent.trusted} invalid={agent.errors.length > 0} />
                        )}
                      </button>
                    </li>
                  ))}
                  {group.skills.map(skill => (
                    <li key={`s:${skill.metadata.name}`}>
                      <button
                        type="button"
                        className="wf-rail-row"
                        aria-pressed={selected?.kind === 'skill' && selected.name === skill.metadata.name}
                        onClick={() => setSelected({ kind: 'skill', name: skill.metadata.name })}
                      >
                        <Icon name="sparkles" size={14} />
                        <span className="wf-rail-main">
                          <span className="wf-rail-name">{skill.metadata.name}</span>
                          <span className="wf-rail-sub">skill</span>
                        </span>
                        <TrustMark trusted={skill.trusted} invalid={!!skill.error} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </nav>

        <section className="wf-inspector" aria-label="Details">
          {selectedAgent && snapshot ? (
            <AgentDetail
              agent={selectedAgent}
              snapshot={snapshot}
              busy={busy}
              onLifecycle={(id, action) =>
                void act(() =>
                  action === 'stop'
                    ? window.praxis.agentRuntime.stop(id)
                    : action === 'restart'
                      ? window.praxis.agentRuntime.restart(id)
                      : window.praxis.agentRuntime.start(id)
                )
              }
            />
          ) : selectedSkill && snapshot ? (
            <SkillDetail
              skill={selectedSkill}
              agents={snapshot.agents}
              busy={busy}
              onActivate={(agentId, name) =>
                void act(async () => {
                  await window.praxis.agentRuntime.activateSkill(agentId, name);
                  return window.praxis.agentRuntime.list();
                })
              }
            />
          ) : (
            <div className="empty-state">
              <Icon name="cursor" size={26} />
              <span>Select an agent or skill to see its detail.</span>
            </div>
          )}
        </section>
      </div>

      {dialog === 'agent' && (
        <CreateAgentDialog
          defaultScope="global"
          existingIds={(snapshot?.agents ?? []).map(agent => agent.manifest.id)}
          onClose={() => setDialog(undefined)}
          onCreated={afterAuthoring}
        />
      )}
      {dialog === 'skill' && (
        <CreateSkillDialog
          defaultScope="global"
          existingNames={(snapshot?.skills ?? []).map(skill => skill.metadata.name)}
          onClose={() => setDialog(undefined)}
          onCreated={afterAuthoring}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog defaultScope="global" onClose={() => setDialog(undefined)} onImported={afterAuthoring} />
      )}
    </div>
  );
}

function TrustMark({ trusted, invalid }: { trusted: boolean; invalid: boolean }) {
  if (invalid) return <span className="wf-rail-mark is-issue" title="Invalid — see detail">⚠</span>;
  if (trusted) return <span className="wf-rail-mark is-gate" title="Trusted">✓</span>;
  return <span className="wf-rail-mark is-entry" title="Approval required">approval</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="agent-detail-row">
      <span className="agent-detail-key">{label}</span>
      <span className="agent-detail-value">{children}</span>
    </div>
  );
}

type LifecycleAction = 'start' | 'stop' | 'restart';

function AgentDetail({
  agent,
  snapshot,
  busy,
  onLifecycle
}: {
  agent: DiscoveredAgent;
  snapshot: AgentRuntimeSnapshot;
  busy: boolean;
  onLifecycle: (id: string, action: LifecycleAction) => void;
}) {
  const id = agent.manifest.id;
  const blocked = agentStartBlockedReason(agent);
  const runtime = snapshot.hosts[id];
  const state = hostRuntimeState(snapshot, id);
  const caps = describeCapabilities(snapshot.capabilities[id]);
  const entry = agent.manifest.entry;

  return (
    <div className="wf-inspector-card agent-detail">
      <div className="wf-inspector-head">
        <h2>{agent.manifest.name}</h2>
        <TrustMark trusted={agent.trusted} invalid={agent.errors.length > 0} />
      </div>

      <Row label="Host">
        <span className={`wf-lane wf-lane--${state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'idle'}`}>●</span>{' '}
        {state === 'running'
          ? `running${runtime?.pid ? ` · pid ${runtime.pid}` : ''}`
          : state === 'failed'
            ? 'failed to start'
            : 'stopped'}
      </Row>
      <Row label="ID">
        <code>{id}</code>
      </Row>
      <Row label="Transport">{transportLabel(agent.manifest.type)}</Row>
      <Row label="Scope">{agent.scope === 'global' ? 'Global (user data)' : 'This project'}</Row>
      <Row label="Activation">{agent.manifest.activation ?? 'onDemand'}</Row>
      <Row label="Entry">
        <code>
          {typeof entry === 'string'
            ? entry
            : [entry.command, ...(entry.args ?? [])].filter(Boolean).join(' ') || entry.url || '—'}
        </code>
      </Row>
      {agent.manifest.config && (
        <Row label="Config">
          <code>{agent.manifest.config}</code>
        </Row>
      )}
      {agent.manifest.skills && agent.manifest.skills.length > 0 && (
        <Row label="Declares skills">{agent.manifest.skills.join(', ')}</Row>
      )}
      <Row label="Source">
        <code className="agent-detail-path" title={agent.manifestPath}>
          {agent.manifestPath}
        </code>
      </Row>

      {agent.errors.length > 0 && (
        <ul className="wf-issues">
          {agent.errors.map((issue, index) => (
            <li key={index}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {runtime?.error && <p className="wf-hint is-danger">{runtime.error}</p>}

      <div className="agent-detail-caps">
        <span className="wf-rail-sub">Capabilities</span>
        {caps ? (
          <>
            <p>{caps.features.length > 0 ? caps.features.join(', ') : 'none reported'}</p>
            {(caps.model || caps.version) && (
              <p className="wf-rail-sub">
                {[caps.model, caps.version && `v${caps.version}`].filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        ) : (
          <p className="wf-rail-sub">Not reported — the host has not been started.</p>
        )}
      </div>

      <div className="wf-stage-actions">
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
        {blocked && <p className="wf-hint is-warn">{blocked}</p>}
      </div>
    </div>
  );
}

function SkillDetail({
  skill,
  agents,
  busy,
  onActivate
}: {
  skill: DiscoveredSkill;
  agents: DiscoveredAgent[];
  busy: boolean;
  onActivate: (agentId: string, skillName: string) => void;
}) {
  const eligible = eligibleAgentsForSkill(skill, agents);
  const blocked = skillActivateBlockedReason(skill, agents);
  const [agentId, setAgentId] = useState('');
  const target = agentId || eligible[0]?.manifest.id || '';

  return (
    <div className="wf-inspector-card agent-detail">
      <div className="wf-inspector-head">
        <h2>{skill.metadata.name}</h2>
        <TrustMark trusted={skill.trusted} invalid={!!skill.error} />
      </div>

      <p className="agent-detail-desc">{skill.metadata.description || 'No description.'}</p>

      {skill.metadata.version && <Row label="Version">{skill.metadata.version}</Row>}
      <Row label="Scope">{skill.scope === 'global' ? 'Global (user data)' : 'This project'}</Row>
      {skill.metadata.triggers.length > 0 && (
        <Row label="Triggers">
          <span className="chip-row">
            {skill.metadata.triggers.map(trigger => (
              <span key={trigger} className="chip chip-muted">
                {trigger}
              </span>
            ))}
          </span>
        </Row>
      )}
      <Row label="Fingerprint">
        <code className="agent-detail-path" title={skill.fingerprint}>
          {skill.fingerprint.slice(0, 16)}…
        </code>
      </Row>
      <Row label="Source">
        <code className="agent-detail-path" title={skill.instructionsPath}>
          {skill.instructionsPath}
        </code>
      </Row>

      {skill.error && <p className="wf-hint is-danger">{skill.error}</p>}

      <div className="wf-stage-actions">
        {eligible.length > 1 && (
          <label className="wf-field">
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
        {blocked && <p className="wf-hint is-warn">{blocked}</p>}
      </div>
    </div>
  );
}
