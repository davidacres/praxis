import type { AgentRuntimeSnapshot, DiscoveredAgent, DiscoveredAgentProfile, DiscoveredSkill, ProjectRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { isHostShimProfile, runningHostCount, transportLabel, skillTitle } from './agentCatalog';
import type { CatalogSelection } from './agentSelection';

/**
 * Agent Hub detail (FX-BF-009 / FX-BF-011, revised layout).
 *
 * The centre pane answers "what is this?" — identity, manifest, and where it
 * came from — for whichever catalog item the sidebar has selected. What it is
 * *doing* (host state, capabilities, activation, sessions) lives in the right
 * pane, so this surface stays a calm, readable record.
 */

export interface AgentDetailPageProps {
  snapshot?: AgentRuntimeSnapshot;
  selection?: CatalogSelection;
  project?: ProjectRecord;
  error?: string;
  onNew: (kind: 'agent' | 'profile' | 'skill' | 'import') => void;
  onOpenSettings?: () => void;
}

export function AgentDetailPage({ snapshot, selection, project, error, onNew, onOpenSettings }: AgentDetailPageProps) {
  const profile = selection?.kind === 'profile' ? snapshot?.profiles?.find(item => item.profile.id === selection.id) : undefined;
  const agent = selection?.kind === 'agent' ? snapshot?.runtimeHosts?.find(a => a.manifest.id === selection.id) : undefined;
  const skill = selection?.kind === 'skill' ? snapshot?.skills.find(s => s.metadata.name === selection.name) : undefined;

  return (
    <div className="view-scroll agent-page">
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!snapshot ? (
        <div className="empty-state" aria-busy="true">
          <Icon name="robot" size={28} />
          <span>Loading the agent catalog…</span>
        </div>
      ) : profile ? (
        <ProfileRecord profile={profile} project={project} />
      ) : agent ? (
        <AgentRecord agent={agent} project={project} />
      ) : skill ? (
        <SkillRecord skill={skill} project={project} />
      ) : (
        <CatalogOverview snapshot={snapshot} onNew={onNew} onOpenSettings={onOpenSettings} />
      )}
    </div>
  );
}

function Hero({ title, chips, lede }: { title: string; chips: React.ReactNode; lede?: string }) {
  return (
    <header className="agent-hero">
      <h1>{title}</h1>
      <div className="agent-hero-chips">{chips}</div>
      {lede && <p className="agent-hero-lede">{lede}</p>}
    </header>
  );
}

function TrustChip({ trusted, invalid }: { trusted: boolean; invalid: boolean }) {
  if (invalid) return <span className="chip chip-danger">invalid</span>;
  if (trusted) return <span className="chip chip-success">trusted</span>;
  return <span className="chip chip-warn">approval required</span>;
}

function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="agent-facts">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function scopeLabel(scope: 'global' | 'project', project?: ProjectRecord): string {
  return scope === 'global' ? 'Global' : project?.name ?? 'This project';
}


function ProfileRecord({ profile, project }: { profile: DiscoveredAgentProfile; project?: ProjectRecord }) {
  return (
    <>
      <Hero
        title={profile.profile.name}
        lede={profile.profile.description}
        chips={
          <>
            <span className="chip chip-muted">agent profile</span>
            <span className="chip chip-muted">{scopeLabel(profile.scope, project)}</span>
            <TrustChip trusted={profile.trusted} invalid={!!profile.error} />
            {profile.legacy && <span className="chip chip-warn">legacy brief.md</span>}
          </>
        }
      />
      <section className="agent-section" aria-label="Agent profile">
        <h2>Agent profile</h2>
        <Facts>
          <Fact label="ID"><code>{profile.profile.id}</code></Fact>
          {profile.profile.version && <Fact label="Version">{profile.profile.version}</Fact>}
          <Fact label="Instructions"><pre className="agent-profile-instructions">{profile.profile.instructions}</pre></Fact>
          <Fact label="Source"><code className="agent-path">{profile.profilePath}</code></Fact>
        </Facts>
      </section>
      {profile.error && <p className="hint is-danger">{profile.error}</p>}
      {profile.legacy && <p className="hint is-warn">Legacy profile discovered from brief.md. Save it as AGENT.md to use the canonical format.</p>}
    </>
  );
}

function AgentRecord({ agent, project }: { agent: DiscoveredAgent; project?: ProjectRecord }) {
  const entry = agent.manifest.entry;
  const command =
    typeof entry === 'string' ? entry : [entry.command, ...(entry.args ?? [])].filter(Boolean).join(' ') || entry.url || '—';

  return (
    <>
      <Hero
        title={agent.manifest.name}
        chips={
          <>
            <span className="chip chip-muted">{transportLabel(agent.manifest.type)}</span>
            <span className="chip chip-muted">{scopeLabel(agent.scope, project)}</span>
            <TrustChip trusted={agent.trusted} invalid={agent.errors.length > 0} />
          </>
        }
      />

      <section className="agent-section" aria-label="Launch binding manifest">
        <h2>Launch binding manifest</h2>
        <Facts>
          <Fact label="ID">
            <code>{agent.manifest.id}</code>
          </Fact>
          <Fact label="Activation">{agent.manifest.activation ?? 'onDemand'}</Fact>
          <Fact label="Entry">
            <code>{command}</code>
          </Fact>
          {agent.manifest.config && (
            <Fact label="Config">
              <code>{agent.manifest.config}</code>
            </Fact>
          )}
          {agent.manifest.skills && agent.manifest.skills.length > 0 && (
            <Fact label="Declares skills">{agent.manifest.skills.join(', ')}</Fact>
          )}
          <Fact label="Source">
            <code className="agent-path" title={agent.manifestPath}>
              {agent.manifestPath}
            </code>
          </Fact>
        </Facts>
      </section>

      {agent.errors.length > 0 && (
        <section className="agent-section" aria-label="Manifest problems">
          <h2>Problems</h2>
          <ul className="issues">
            {agent.errors.map((issue, index) => (
              <li key={index}>
                {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function SkillRecord({ skill, project }: { skill: DiscoveredSkill; project?: ProjectRecord }) {
  return (
    <>
      <Hero
        title={skillTitle(skill.metadata)}
        lede={skill.metadata.description || undefined}
        chips={
          <>
            <span className="chip chip-muted">skill</span>
            <span className="chip chip-muted">{scopeLabel(skill.scope, project)}</span>
            <TrustChip trusted={skill.trusted} invalid={!!skill.error} />
          </>
        }
      />

      <section className="agent-section" aria-label="Package">
        <h2>Package</h2>
        <Facts>
          <Fact label="Skill ID">{skill.metadata.name}</Fact>
          {skill.metadata.version && <Fact label="Version">{skill.metadata.version}</Fact>}
          {skill.metadata.triggers.length > 0 && (
            <Fact label="Triggers">
              <span className="chip-row">
                {skill.metadata.triggers.map(trigger => (
                  <span key={trigger} className="chip chip-muted">
                    {trigger}
                  </span>
                ))}
              </span>
            </Fact>
          )}
          <Fact label="Fingerprint">
            <code className="agent-path" title={skill.fingerprint}>
              {skill.fingerprint.slice(0, 16)}…
            </code>
          </Fact>
          <Fact label="Source">
            <code className="agent-path" title={skill.instructionsPath}>
              {skill.instructionsPath}
            </code>
          </Fact>
        </Facts>
      </section>

      {skill.error && (
        <section className="agent-section" aria-label="Skill problems">
          <h2>Problems</h2>
          <p className="hint is-danger">{skill.error}</p>
        </section>
      )}
    </>
  );
}

function CatalogOverview({
  snapshot,
  onNew,
  onOpenSettings
}: {
  snapshot: AgentRuntimeSnapshot;
  onNew: (kind: 'agent' | 'profile' | 'skill' | 'import') => void;
  onOpenSettings?: () => void;
}) {
  const running = runningHostCount(snapshot);
  const curatedProfiles = (snapshot.profiles ?? []).filter(profile => !isHostShimProfile(profile));
  const empty = curatedProfiles.length === 0 && snapshot.skills.length === 0;

  return (
    <>
      <Hero
        title="Agents"
        lede={
          empty
            ? 'Agent profiles define behaviour, skills add reusable capabilities, and a provider is picked when a session starts.'
            : 'Pick an agent or skill in the sidebar to see its record. Runtime state and actions are in the right pane.'
        }
        chips={
          <>
            <span className="chip chip-muted">
              {curatedProfiles.length} profile{curatedProfiles.length === 1 ? '' : 's'}
            </span>
            <span className="chip chip-muted">
              {snapshot.skills.length} skill{snapshot.skills.length === 1 ? '' : 's'}
            </span>
            {running > 0 && <span className="chip chip-success">{running} running</span>}
          </>
        }
      />

      <section className="agent-section" aria-label="Get started">
        <div className="agent-start-grid">
          <button type="button" className="agent-start-card" onClick={() => onNew('profile' as never)}>
            <Icon name="robot" size={18} />
            <strong>New agent profile</strong>
            <span>Create a provider-neutral AGENT.md role and instructions.</span>
          </button>
          <button type="button" className="agent-start-card" onClick={() => onNew('skill')}>
            <Icon name="sparkles" size={18} />
            <strong>New skill</strong>
            <span>Create a SKILL.md package with optional scripts and references.</span>
          </button>
          <button type="button" className="agent-start-card" onClick={() => onNew('import')}>
            <Icon name="folder-open" size={18} />
            <strong>Import</strong>
            <span>Validate an existing profile or skill folder and copy it in. Nothing is executed.</span>
          </button>
        </div>
        {onOpenSettings && (
          <p className="hint">
            Custom launch bindings, discovery paths, trust policy, and diagnostics live in{' '}
            <button type="button" className="btn-compact" onClick={onOpenSettings}>
              Settings → Agent runtime
            </button>
            .
          </p>
        )}
      </section>
    </>
  );
}
