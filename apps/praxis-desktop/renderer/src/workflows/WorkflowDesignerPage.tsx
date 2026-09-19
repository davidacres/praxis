import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDialogs } from '../ui/dialogs';
import { createPortal } from 'react-dom';
import type {
  AgentRuntimeSnapshot,
  ProjectRecord,
  WorkflowDefinition,
  WorkflowEdgeOutcome,
  WorkflowGateKind,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPolicyProfile
} from '@praxis/core';
import { API_MODEL_PROVIDERS } from '../ai/modelProviders';
import { Icon } from '../ui/Icon';
import { WorkflowCanvas, type WorkflowPaletteItem } from './WorkflowCanvas';
import { WorkflowValidationDialog } from './WorkflowValidationDialog';
import {
  addNode,
  bucketFeedback,
  connectNodes,
  disconnect,
  duplicateNode,
  newNode,
  removeNode,
  setEntryNode,
  updateEdge,
  updateNode,
  type BucketedFeedback
} from './workflowEdits';

/**
 * Visual workflow designer (FX-BE-021 / FX-BF-014).
 *
 * Opened for one saved workflow, picked from the sidebar tree. A docked stage
 * rail and a pan/zoom canvas fill the centre; the stage/connection inspector
 * renders into the shell's right pane (`auxSlot`) so the canvas keeps the whole
 * centre column.
 */

const NODE_KINDS: Array<{ type: WorkflowNodeType; label: string; icon: string; description: string }> = [
  { type: 'agent-task', label: 'Agent stage', icon: 'robot', description: 'Autonomous agent task stage' },
  { type: 'check', label: 'Check', icon: 'shield', description: 'Verification, test, or security gate' },
  { type: 'approval', label: 'Approval', icon: 'check-square', description: 'Manual human sign-off gate' },
  { type: 'deployment', label: 'Deployment', icon: 'rocket', description: 'Deployment or release step' },
  { type: 'join', label: 'Join', icon: 'split-horizontal', description: 'Parallel branches synchronizer' }
];

const GATES: WorkflowGateKind[] = ['review', 'qa', 'security'];
const OUTCOMES: WorkflowEdgeOutcome[] = ['success', 'failure', 'always'];

/** The gate a stage satisfies, without importing a core runtime helper. */
function railGate(node: WorkflowNode): WorkflowGateKind | undefined {
  return node.type === 'agent-task' || node.type === 'check' || node.type === 'deployment'
    ? node.satisfiesGate
    : undefined;
}

function profileHostId(catalog: AgentRuntimeSnapshot | undefined, profileId: string): string | undefined {
  const hosts = catalog?.runtimeHosts ?? catalog?.agents ?? [];
  return hosts.find(host => host.manifest.id === profileId)?.manifest.id;
}

function bindProfileToStage(
  definition: WorkflowDefinition,
  catalog: AgentRuntimeSnapshot | undefined,
  profileId: string,
  at: { x: number; y: number }
): WorkflowDefinition {
  const profile = (catalog?.profiles ?? []).find(candidate => candidate.profile.id === profileId);
  if (!profile) return definition;
  const hostId = profileHostId(catalog, profileId) ?? '';
  const node = newNode('agent-task', at);
  if (node.type !== 'agent-task') return definition;
  node.name = profile.profile.name;
  node.agent = {
    agentId: hostId,
    profileId: profile.profile.id,
    hostId,
    scope: profile.scope,
    toolMode: profile.profile.toolMode ?? 'read-only'
  };
  return addNode(definition, node);
}

function addSkillToStage(
  definition: WorkflowDefinition,
  catalog: AgentRuntimeSnapshot | undefined,
  nodeId: string,
  skillName: string
): WorkflowDefinition {
  const node = definition.nodes.find(candidate => candidate.id === nodeId);
  const skill = (catalog?.skills ?? []).find(candidate => candidate.metadata.name === skillName);
  if (!node || node.type !== 'agent-task' || !skill) return definition;
  const skillNames = node.agent.skillNames ?? [];
  if (skillNames.includes(skillName)) return definition;
  return updateNode(definition, nodeId, {
    agent: {
      ...node.agent,
      skillNames: [...skillNames, skillName],
      skillFingerprints: { ...(node.agent.skillFingerprints ?? {}), [skillName]: skill.fingerprint }
    }
  } as never);
}

export interface WorkflowDesignerPageProps {
  project: ProjectRecord;
  /** The saved project workflow to edit. */
  workflowId: string;
  /** The shell's right-pane element the inspector portals into. */
  auxSlot: HTMLElement | null;
  /** Ask the shell to reveal the right pane (a stage was selected). */
  onRequireAux?: () => void;
  /** Persisted a change — the sidebar list may need to re-read (name changes). */
  onSaved?: () => void;
  /** The workflow was deleted — navigate away. */
  onDeleted?: () => void;
}

export function WorkflowDesignerPage({
  project,
  workflowId,
  auxSlot,
  onRequireAux,
  onSaved,
  onDeleted
}: WorkflowDesignerPageProps) {
  const { confirm } = useDialogs();
  const [definition, setDefinition] = useState<WorkflowDefinition | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>();
  const [inspectorTab, setInspectorTab] = useState<'stage' | 'connections'>('stage');
  const selectStage = useCallback(
    (nodeId: string | undefined) => {
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(undefined);
      if (nodeId) {
        setInspectorTab('stage');
        onRequireAux?.();
      }
    },
    [onRequireAux]
  );
  const selectEdge = useCallback(
    (edgeId: string | undefined) => {
      setSelectedEdgeId(edgeId);
      if (edgeId) {
        setSelectedNodeId(undefined);
        setInspectorTab('connections');
        onRequireAux?.();
      }
    },
    [onRequireAux]
  );
  const [error, setError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<AgentRuntimeSnapshot | undefined>();
  const [policy, setPolicy] = useState<WorkflowPolicyProfile | undefined>();
  // Gates the "Recommended" agent-stage action — the recommendation call is a
  // direct completion against whichever api-kind provider (Vercel AI
  // Gateway, OpenAI, or Anthropic — see `workflowAgentRecommendation.ts`) is
  // configured, not a full agent session, so it only works when at least one
  // of those has a key, regardless of which provider is active for real
  // sessions. `undefined` is "still checking", not "unconfigured" — see
  // `AgentStageFields`'s use of this for why that third state matters.
  const [recommendationAvailable, setRecommendationAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    void window.praxis.agentRuntime.list().then(setCatalog);
    void window.praxis.workflows.effectivePolicy(project.id).then(setPolicy);
    void window.praxis.ai
      .listProviderStatuses()
      .then(statuses => setRecommendationAvailable(statuses.some(status => API_MODEL_PROVIDERS.has(status.provider) && status.configured)))
      .catch(() => setRecommendationAvailable(false));
  }, [project.id]);

  // Load the chosen workflow; re-runs when the sidebar picks a different one.
  useEffect(() => {
    let cancelled = false;
    setDefinition(undefined);
    setNotFound(false);
    setSelectedNodeId(undefined);
    void window.praxis.workflows
      .get(project.id, workflowId)
      .then(found => {
        if (cancelled) return;
        if (!found) {
          setNotFound(true);
          return;
        }
        setDefinition(found);
        setSelectedNodeId(found.nodes[0]?.id);
        setSavedAt(found.updatedAt);
        onRequireAux?.();
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, workflowId, onRequireAux]);

  // Validation runs in core over IPC, debounced.
  const [feedback, setFeedback] = useState<BucketedFeedback | undefined>();
  useEffect(() => {
    if (!definition) {
      setFeedback(undefined);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.praxis.workflows.validate(project.id, definition).then(result => {
        if (!cancelled) setFeedback(bucketFeedback(definition, result));
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [definition, project.id]);

  const [validationDialogOpen, setValidationDialogOpen] = useState(false);
  const [validating, setValidating] = useState(false);

  const runValidation = useCallback(async () => {
    if (!definition) return;
    setValidating(true);
    try {
      const result = await window.praxis.workflows.validate(project.id, definition);
      setFeedback(bucketFeedback(definition, result));
      setValidationDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }, [definition, project.id]);

  const mutate = useCallback((next: WorkflowDefinition) => {
    setDefinition(next);
    setSavedAt(undefined);
  }, []);

  const save = useCallback(async () => {
    if (!definition) return;
    setError(undefined);
    setBusy(true);
    try {
      const saved = await window.praxis.workflows.save(project.id, definition);
      setDefinition(saved);
      setSavedAt(saved.updatedAt);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [definition, project.id, onSaved]);

  const remove = useCallback(async () => {
    if (!(await confirm({ title: 'Delete this workflow?', message: 'Runs already started are kept.', confirmLabel: 'Delete workflow', danger: true }))) return;
    setBusy(true);
    try {
      await window.praxis.workflows.remove(project.id, workflowId);
      onSaved?.();
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [project.id, workflowId, onSaved, onDeleted, confirm]);

  const selectedNode = definition?.nodes.find(node => node.id === selectedNodeId);
  const profiles = catalog?.profiles ?? [];
  const skills = catalog?.skills ?? [];
  const selectedAgentStage = selectedNode?.type === 'agent-task' ? selectedNode : undefined;
  const presentations = useMemo(
    () =>
      Object.fromEntries(
        (definition?.nodes ?? []).flatMap(node => {
          if (node.type !== 'agent-task') return [];
          const profileId = node.agent.profileId || node.agent.agentId;
          const profile = profiles.find(candidate => candidate.profile.id === profileId);
          return [[node.id, { agent: (profile?.profile.name ?? profileId) || undefined, skills: node.agent.skillNames ?? [] }]];
        })
      ),
    [definition, profiles]
  );

  const [toolboxView, setToolboxView] = useState<'all' | 'tools' | 'stages'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const q = searchQuery.trim().toLowerCase();
  const showTools = toolboxView === 'all' || toolboxView === 'tools';
  const showStages = toolboxView === 'all' || toolboxView === 'stages';

  const filteredBlocks = useMemo(() => {
    if (!q) return NODE_KINDS;
    return NODE_KINDS.filter(k => k.label.toLowerCase().includes(q) || k.type.toLowerCase().includes(q));
  }, [q]);

  const filteredProfiles = useMemo(() => {
    if (!q) return profiles;
    return profiles.filter(
      p => p.profile.name.toLowerCase().includes(q) || (p.profile.description && p.profile.description.toLowerCase().includes(q))
    );
  }, [profiles, q]);

  const filteredSkills = useMemo(() => {
    if (!q) return skills;
    return skills.filter(
      s => s.metadata.name.toLowerCase().includes(q) || (s.metadata.description && s.metadata.description.toLowerCase().includes(q))
    );
  }, [skills, q]);

  const filteredNodes = useMemo(() => {
    if (!definition) return [];
    if (!q) return definition.nodes;
    return definition.nodes.filter(n => n.name.toLowerCase().includes(q) || n.type.toLowerCase().includes(q));
  }, [definition, q]);

  const addProfileStage = useCallback(
    (profileId: string, at?: { x: number; y: number }) => {
      if (!definition) return;
      const next = bindProfileToStage(
        definition,
        catalog,
        profileId,
        at ?? { x: 120, y: 120 + definition.nodes.length * 48 }
      );
      const added = next.nodes[next.nodes.length - 1];
      mutate(next);
      if (added) selectStage(added.id);
    },
    [definition, catalog, mutate, selectStage]
  );

  const useSkill = useCallback(
    (skillName: string, targetNodeId?: string) => {
      if (!definition) return;
      const stageId = targetNodeId ?? selectedAgentStage?.id;
      if (!stageId) {
        setError('Select an agent stage before adding a skill. Skills guide an agent; they do not run on their own.');
        return;
      }
      const next = addSkillToStage(definition, catalog, stageId, skillName);
      if (next === definition) return;
      setError(undefined);
      mutate(next);
      selectStage(stageId);
    },
    [definition, catalog, mutate, selectStage, selectedAgentStage]
  );

  if (notFound) {
    return (
      <div className="view-scroll wf-page">
        <div className="empty-state">
          <Icon name="split-horizontal" size={28} />
          <span>That workflow no longer exists.</span>
        </div>
      </div>
    );
  }

  if (!definition) {
    return (
      <div className="view-scroll wf-page">
        <div className="empty-state" aria-busy="true">
          <Icon name="split-horizontal" size={28} />
          <span>Loading workflow…</span>
        </div>
      </div>
    );
  }

  const inspector = (
    <section className="inspector inspector--tabbed aux-panel" aria-label="Stage inspector">
      <div role="tablist" aria-label="Inspector" className="inspector-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={inspectorTab === 'stage'}
          className={inspectorTab === 'stage' ? 'active' : ''}
          onClick={() => setInspectorTab('stage')}
        >
          Stage
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={inspectorTab === 'connections'}
          className={inspectorTab === 'connections' ? 'active' : ''}
          onClick={() => setInspectorTab('connections')}
        >
          Connections{definition.edges.length > 0 ? ` (${definition.edges.length})` : ''}
        </button>
      </div>
      <div className="inspector-body">
        {inspectorTab === 'stage' ? (
          selectedNode ? (
            <NodeInspector
              definition={definition}
              node={selectedNode}
              issues={feedback?.byNode[selectedNode.id] ?? []}
              catalog={catalog}
              policy={policy}
              recommendationAvailable={recommendationAvailable}
              onChange={mutate}
              onSelectNode={selectStage}
            />
          ) : (
            <div className="empty-state">
              <Icon name="cursor" size={26} />
              <span>Stage settings appear here. Pick a stage on the canvas.</span>
            </div>
          )
        ) : (
          <EdgeEditor
            definition={definition}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={selectEdge}
            onChange={mutate}
          />
        )}
      </div>
    </section>
  );

  return (
    <div className="view-scroll wf-page">
      <header className="wf-header">
        <h1>{definition.name}</h1>
        <span className="wf-header-sub">{project.name}</span>
        <div className="wf-header-actions">
          <button
            type="button"
            className="btn btn-compact"
            data-testid="wf-validate-btn"
            onClick={() => void runValidation()}
            disabled={validating || busy}
            title="Validate workflow connections, flow, and stage configuration"
          >
            <Icon name="shield" size={13} /> {validating ? 'Validating…' : 'Validate workflow'}
          </button>
          <button type="button" className="btn btn-compact wf-header-del" onClick={() => void remove()} disabled={busy}>
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}

      <div className="wf-designer wf-designer--two">
        <nav className="rail wf-composer-rail" aria-label="Workflow stages">
          <div className="wf-rail-header">
            <div className="wf-rail-header-top">
              <span className="wf-rail-title">
                <Icon name="tools" size={13} />
                <span>Toolbox</span>
              </span>
              <span className="wf-rail-badge">{definition.nodes.length} stages</span>
            </div>

            <div className="wf-rail-view-switch" role="tablist" aria-label="Toolbox view">
              <button
                type="button"
                role="tab"
                aria-selected={toolboxView === 'all'}
                className={`wf-view-btn${toolboxView === 'all' ? ' is-active' : ''}`}
                onClick={() => setToolboxView('all')}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={toolboxView === 'tools'}
                className={`wf-view-btn${toolboxView === 'tools' ? ' is-active' : ''}`}
                onClick={() => setToolboxView('tools')}
              >
                Tools
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={toolboxView === 'stages'}
                className={`wf-view-btn${toolboxView === 'stages' ? ' is-active' : ''}`}
                onClick={() => setToolboxView('stages')}
              >
                Stages
              </button>
            </div>

            <div className="wf-rail-search">
              <Icon name="search" size={12} />
              <input
                type="search"
                placeholder="Filter tools & stages…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Filter tools and stages"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="wf-rail-search-clear"
                  aria-label="Clear filter"
                  onClick={() => setSearchQuery('')}
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </div>
          </div>

          <div className="wf-rail-body">
            {showTools && (
              <section className="wf-toolbox-section" aria-labelledby="wf-section-blocks">
                <div className="wf-section-header">
                  <span id="wf-section-blocks">Blocks</span>
                  <span className="wf-section-count">{filteredBlocks.length}</span>
                </div>
                <div className="wf-toolbox-grid" role="group" aria-label="Stage blocks">
                  {filteredBlocks.map(kind => (
                    <button
                      key={kind.type}
                      type="button"
                      className="wf-tool-card wf-tool-card--block"
                      draggable
                      title={`Drag or click to add ${kind.label}: ${kind.description}`}
                      onDragStart={event => {
                        event.dataTransfer.effectAllowed = 'copy';
                        event.dataTransfer.setData(
                          'application/x-praxis-workflow-palette',
                          JSON.stringify({ kind: 'stage', nodeType: kind.type } satisfies WorkflowPaletteItem)
                        );
                      }}
                      onClick={() => {
                        const node = newNode(kind.type, { x: 120, y: 120 + definition.nodes.length * 40 });
                        mutate(addNode(definition, node));
                        selectStage(node.id);
                      }}
                    >
                      <span className="wf-tool-icon">
                        <Icon name={kind.icon as never} size={13} />
                      </span>
                      <span className="wf-tool-label">{kind.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {showTools && (
              <section className="wf-composer-palette" aria-labelledby="wf-building-blocks">
                <span id="wf-building-blocks" className="sr-only">Build with agents and skills</span>
                <div className="wf-toolbox-section">
                  <div className="wf-section-header">
                    <span>Agents</span>
                    <span className="wf-section-count">{filteredProfiles.length}</span>
                  </div>
                  <div className="wf-palette-group" role="group" aria-label="Available agents">
                    {filteredProfiles.length > 0 ? (
                      filteredProfiles.map(profile => {
                        const blocked = profile.error || !profile.trusted;
                        const title = profile.error
                          ? `Cannot use ${profile.profile.name}: ${profile.error}`
                          : !profile.trusted
                            ? `${profile.profile.name} needs trust before it can run.`
                            : `Add ${profile.profile.name} as an agent stage${profile.profile.description ? ` — ${profile.profile.description}` : ''}`;
                        return (
                          <button
                            key={profile.profile.id}
                            type="button"
                            className="wf-palette-item wf-palette-item--agent"
                            draggable={!blocked}
                            disabled={Boolean(blocked)}
                            title={title}
                            data-testid={`wf-palette-agent-${profile.profile.id}`}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData(
                                'application/x-praxis-workflow-palette',
                                JSON.stringify({ kind: 'agent', profileId: profile.profile.id } satisfies WorkflowPaletteItem)
                              );
                            }}
                            onClick={() => addProfileStage(profile.profile.id)}
                          >
                            <span className="wf-palette-item-icon">
                              <Icon name="robot" size={13} />
                            </span>
                            <div className="wf-palette-item-content">
                              <span className="wf-palette-item-title">{profile.profile.name}</span>
                              {profile.profile.description && (
                                <span className="wf-palette-item-desc">{profile.profile.description}</span>
                              )}
                            </div>
                            {blocked && (
                              <span className="wf-palette-badge is-warn">
                                {profile.error ? 'needs repair' : 'needs trust'}
                              </span>
                            )}
                          </button>
                        );
                      })
                    ) : (
                      <p className="wf-palette-empty">No matching agents</p>
                    )}
                  </div>
                </div>

                <div className="wf-toolbox-section">
                  <div className="wf-section-header">
                    <span>Skills</span>
                    <span className="wf-section-count">{filteredSkills.length}</span>
                  </div>
                  <div className="wf-palette-group" role="group" aria-label="Available skills">
                    {filteredSkills.length > 0 ? (
                      filteredSkills.map(skill => {
                        const blocked = skill.error || !skill.trusted;
                        const title = blocked
                          ? `Cannot use ${skill.metadata.name}: ${skill.error ?? 'it needs trust before it can run.'}`
                          : selectedAgentStage
                            ? `Add ${skill.metadata.name} to ${selectedAgentStage.name}${skill.metadata.description ? ` — ${skill.metadata.description}` : ''}`
                            : `Select an agent stage, then add ${skill.metadata.name}${skill.metadata.description ? ` — ${skill.metadata.description}` : ''}`;
                        return (
                          <button
                            key={skill.metadata.name}
                            type="button"
                            className="wf-palette-item wf-palette-item--skill"
                            draggable={!blocked}
                            disabled={Boolean(blocked)}
                            title={title}
                            data-testid={`wf-palette-skill-${skill.metadata.name}`}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData(
                                'application/x-praxis-workflow-palette',
                                JSON.stringify({ kind: 'skill', skillName: skill.metadata.name } satisfies WorkflowPaletteItem)
                              );
                            }}
                            onClick={() => useSkill(skill.metadata.name)}
                          >
                            <span className="wf-palette-item-icon">
                              <Icon name="sparkles" size={13} />
                            </span>
                            <div className="wf-palette-item-content">
                              <span className="wf-palette-item-title">{skill.metadata.name}</span>
                              {skill.metadata.description && (
                                <span className="wf-palette-item-desc">{skill.metadata.description}</span>
                              )}
                            </div>
                            {blocked && (
                              <span className="wf-palette-badge is-warn">
                                {skill.error ? 'needs repair' : 'needs trust'}
                              </span>
                            )}
                          </button>
                        );
                      })
                    ) : (
                      <p className="wf-palette-empty">No matching skills</p>
                    )}
                  </div>
                </div>
              </section>
            )}

            {showStages && (
              <section className="wf-toolbox-section wf-stages-section" aria-labelledby="wf-section-stages">
                <div className="wf-section-header">
                  <span id="wf-section-stages">Flow Stages</span>
                  <span className="wf-section-count">{filteredNodes.length}</span>
                </div>
                <ul className="rail-list">
                  {filteredNodes.map(node => {
                    const issues = feedback?.byNode[node.id]?.length ?? 0;
                    const isEntry = node.id === definition.entryNodeId;
                    const icon =
                      node.type === 'agent-task'
                        ? 'robot'
                        : node.type === 'check'
                          ? 'shield'
                          : node.type === 'deployment'
                            ? 'rocket'
                            : node.type === 'approval'
                              ? 'check-square'
                              : 'split-horizontal';
                    return (
                      <li key={node.id} className="wf-stage-rail-item">
                        <button
                          type="button"
                          className="rail-row"
                          aria-pressed={node.id === selectedNodeId}
                          aria-label={`${node.name} (${node.type})${isEntry ? ', entry stage' : ''}${
                            issues > 0 ? `, ${issues} issue${issues === 1 ? '' : 's'}` : ''
                          }`}
                          onClick={() => selectStage(node.id)}
                        >
                          <span className="rail-row-icon">
                            <Icon name={icon as never} size={13} />
                          </span>
                          <span className="rail-main">
                            <span className="rail-name">{node.name}</span>
                            <span className="rail-sub">{node.type}</span>
                          </span>
                          {issues > 0 ? (
                            <span className="rail-mark is-issue" title={`${issues} validation issue${issues === 1 ? '' : 's'}`}>
                              ⚠ {issues}
                            </span>
                          ) : isEntry ? (
                            <span className="rail-mark is-entry">entry</span>
                          ) : railGate(node) ? (
                            <span className="rail-mark is-gate">{railGate(node)}</span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          className="wf-stage-rail-delete"
                          title={`Delete stage ${node.name}`}
                          aria-label={`Delete stage ${node.name}`}
                          data-testid={`wf-stage-rail-delete-${node.id}`}
                          onClick={e => {
                            e.stopPropagation();
                            mutate(removeNode(definition, node.id));
                            if (selectedNodeId === node.id) selectStage(undefined);
                          }}
                        >
                          <Icon name="trash" size={11} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>

          <div className="rail-foot">
            <ValidationSummary feedback={feedback} onOpenValidation={() => void runValidation()} />
            {!project.workspaceFolder && (
              <p className="hint is-warn">Attach a folder to this project to run this workflow.</p>
            )}
            <button
              type="button"
              className="btn"
              data-testid="wf-rail-validate-btn"
              onClick={() => void runValidation()}
              disabled={validating || busy}
            >
              <Icon name="shield" size={13} /> {validating ? 'Validating…' : 'Validate workflow'}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !feedback?.valid || savedAt === definition.updatedAt}
              className="btn btn-primary"
            >
              {savedAt === definition.updatedAt ? 'Saved' : 'Save workflow'}
            </button>
          </div>
        </nav>

        <div className="wf-canvas-slot">
          <WorkflowCanvas
            definition={definition}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            issuesByNode={Object.fromEntries(
              Object.entries(feedback?.byNode ?? {}).map(([id, list]) => [id, list.length])
            )}
            presentations={presentations}
            onChange={mutate}
            onSelectNode={selectStage}
            onSelectEdge={selectEdge}
            onPaletteDrop={(item, targetNodeId, at) => {
              if (item.kind === 'stage') {
                const node = newNode(item.nodeType, at);
                mutate(addNode(definition, node));
                selectStage(node.id);
                return;
              }
              if (item.kind === 'agent') {
                if (targetNodeId) {
                  const target = definition.nodes.find(node => node.id === targetNodeId);
                  if (target?.type === 'agent-task') {
                    const profile = profiles.find(candidate => candidate.profile.id === item.profileId);
                    if (profile) {
                      const hostId = profileHostId(catalog, item.profileId) ?? '';
                      mutate(
                        updateNode(definition, target.id, {
                          name: profile.profile.name,
                          agent: {
                            ...target.agent,
                            agentId: hostId,
                            profileId: profile.profile.id,
                            hostId,
                            scope: profile.scope,
                            toolMode: profile.profile.toolMode ?? target.agent.toolMode
                          }
                        } as never)
                      );
                      selectStage(target.id);
                      return;
                    }
                  }
                }
                addProfileStage(item.profileId, at);
                return;
              }
              if (!targetNodeId) {
                setError('Drop a skill onto an agent stage. Skills guide an agent; they do not create a runnable stage alone.');
                return;
              }
              useSkill(item.skillName, targetNodeId);
            }}
          />
        </div>
      </div>

      {validationDialogOpen && (
        <WorkflowValidationDialog
          project={project}
          definition={definition}
          feedback={feedback}
          onClose={() => setValidationDialogOpen(false)}
          onSelectNode={selectStage}
          onRevalidate={() => void runValidation()}
          busy={validating}
        />
      )}

      {auxSlot ? createPortal(inspector, auxSlot) : null}
    </div>
  );
}

// ── Validation summary ───────────────────────────────────────────────────

function ValidationSummary({
  feedback,
  onOpenValidation
}: {
  feedback: BucketedFeedback | undefined;
  onOpenValidation?: () => void;
}) {
  if (!feedback) return null;
  const graphIssues = feedback.byNode[''] ?? [];
  return (
    <div
      role="status"
      aria-live="polite"
      className={`wf-validation${feedback.valid ? '' : ' is-invalid'}`}
      onClick={onOpenValidation}
      style={{ cursor: onOpenValidation ? 'pointer' : undefined }}
      title={onOpenValidation ? 'Click to view validation details' : undefined}
    >
      {feedback.valid ? (
        <>Valid — {feedback.warnings.length} warning{feedback.warnings.length === 1 ? '' : 's'}.</>
      ) : (
        <>
          {feedback.errors.length} error{feedback.errors.length === 1 ? '' : 's'}.
          {graphIssues.length > 0 && (
            <ul>
              {graphIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ── Node inspector ───────────────────────────────────────────────────────

function NodeInspector({
  definition,
  node,
  issues,
  catalog,
  policy,
  recommendationAvailable,
  onChange,
  onSelectNode
}: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  issues: Array<{ path: string; message: string }>;
  catalog: AgentRuntimeSnapshot | undefined;
  policy: WorkflowPolicyProfile | undefined;
  recommendationAvailable: boolean | undefined;
  onChange: (next: WorkflowDefinition) => void;
  onSelectNode: (nodeId: string | undefined) => void;
}) {
  const set = (patch: Partial<WorkflowNode>) => onChange(updateNode(definition, node.id, patch as never));

  return (
    <div className="inspector-card">
      <div className="inspector-head">
        <h2>{node.type}</h2>
        <div className="inspector-head-actions">
          {node.id !== definition.entryNodeId && (
            <button type="button" className="btn btn-compact" onClick={() => onChange(setEntryNode(definition, node.id))}>
              Make entry
            </button>
          )}
          <button type="button" className="btn btn-compact" onClick={() => onChange(duplicateNode(definition, node.id))}>
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-compact"
            data-testid="wf-stage-remove-btn"
            title={`Delete ${node.name}`}
            onClick={() => {
              onChange(removeNode(definition, node.id));
              onSelectNode(undefined);
            }}
          >
            <Icon name="trash" size={11} />
            <span>Delete</span>
          </button>
        </div>
      </div>

      <Field label="Name">
        <input value={node.name} onChange={event => set({ name: event.target.value })} />
      </Field>

      {node.type === 'agent-task' && (
        <AgentStageFields workflowId={definition.id} node={node} catalog={catalog} policy={policy} recommendationAvailable={recommendationAvailable} set={set} />
      )}

      {node.type === 'check' && (
        <>
          <Field label="Command">
            <input value={node.command} placeholder="npm" onChange={event => set({ command: event.target.value })} />
          </Field>
          <Field label="Arguments (space-separated)">
            <input
              value={(node.args ?? []).join(' ')}
              onChange={event => set({ args: event.target.value.split(/\s+/).filter(Boolean) })}
            />
          </Field>
          <GateSelect value={node.satisfiesGate} onChange={gate => set({ satisfiesGate: gate })} />
        </>
      )}

      {node.type === 'deployment' && (
        <>
          <Field label="Deployment profile ID">
            <input
              value={node.deploymentProfileId}
              placeholder="staging"
              onChange={event => set({ deploymentProfileId: event.target.value })}
            />
          </Field>
          <p className="hint">
            Resolved against the project&rsquo;s deployment profiles when the run reaches this stage.
          </p>
          <GateSelect value={node.satisfiesGate} onChange={gate => set({ satisfiesGate: gate })} />
        </>
      )}

      {node.type === 'approval' && (
        <>
          <Field label="Prompt">
            <textarea rows={2} value={node.prompt} onChange={event => set({ prompt: event.target.value })} />
          </Field>
          <fieldset className="form-fieldset">
            <legend>Required gates</legend>
            {GATES.map(gate => {
              const policyRequires = policy?.requiredGates.includes(gate) ?? false;
              return (
                <label key={gate} className="form-check">
                  <input
                    type="checkbox"
                    checked={node.requiredGates.includes(gate) || policyRequires}
                    disabled={policyRequires}
                    onChange={event =>
                      set({
                        requiredGates: event.target.checked
                          ? [...node.requiredGates, gate]
                          : node.requiredGates.filter(g => g !== gate)
                      })
                    }
                  />
                  {gate}
                  {policyRequires && <span className="hint"> — required by project policy</span>}
                </label>
              );
            })}
          </fieldset>
          <label className={`form-check${policy?.allowGateBypass === false ? ' is-disabled' : ''}`}>
            <input
              type="checkbox"
              checked={node.allowBypass && policy?.allowGateBypass !== false}
              disabled={policy?.allowGateBypass === false}
              onChange={event => set({ allowBypass: event.target.checked })}
            />
            Allow an attributed gate bypass
            {policy?.allowGateBypass === false && (
              <span className="hint"> — forbidden by project policy</span>
            )}
          </label>
          {policy?.requireHumanApproval && (
            <p className="hint">Project policy requires a human approval stage.</p>
          )}
        </>
      )}

      {node.type === 'join' && (
        <Field label="Mode">
          <select value={node.mode} onChange={event => set({ mode: event.target.value as never })}>
            <option value="all">all — wait for every branch</option>
            <option value="all-required">all-required — wait only for required branches</option>
          </select>
        </Field>
      )}

      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Agent stage fields ───────────────────────────────────────────────────

/**
 * Configures an agent stage against the live Agent Hub catalog: a picker of
 * discovered agents with their trust and capability state, skill checkboxes
 * that capture fingerprints for drift detection, and a warning when the chosen
 * agent would fail preflight (untrusted under a trust-requiring policy, or a
 * malformed manifest).
 */
function AgentStageFields({
  workflowId,
  node,
  catalog,
  policy,
  recommendationAvailable,
  set
}: {
  workflowId: string;
  node: Extract<WorkflowNode, { type: 'agent-task' }>;
  catalog: AgentRuntimeSnapshot | undefined;
  policy: WorkflowPolicyProfile | undefined;
  recommendationAvailable: boolean | undefined;
  set: (patch: Partial<WorkflowNode>) => void;
}) {
  const agents = catalog?.runtimeHosts ?? catalog?.agents ?? [];
  const profiles = catalog?.profiles ?? [];
  const skills = catalog?.skills ?? [];
  const requireTrust = policy?.requireTrustedAgents ?? true;

  // Trusted, preflight-clean candidates only — recommending an agent the
  // stage would immediately fail preflight on isn't a recommendation.
  const recommendableAgents = profiles.filter(candidate => !candidate.error && (!requireTrust || candidate.trusted));
  const recommendationInput = useMemo(
    () => ({
      stageName: node.name,
      instructions: node.instructions,
      candidates: recommendableAgents.map(candidate => ({
        agentId: candidate.profile.id,
        name: candidate.profile.name,
        skills: candidate.profile.preferredSkills
      }))
    }),
    [node.name, node.instructions, recommendableAgents]
  );

  type RecommendState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'done'; agentId: string; rationale: string; stale: boolean };
  const [recommendState, setRecommendState] = useState<RecommendState>({ status: 'idle' });
  // Drives which icon shows (Recommend vs Refresh) — deliberately independent
  // of `recommendState` so a refresh's `loading` phase doesn't flip the icon
  // back to "Recommend" while it's in flight.
  const [hasRecommendation, setHasRecommendation] = useState(false);

  // A free cache read (`workflows:getRecommendation` never calls the AI) —
  // this is the whole point: reopening a stage must not spend money to show
  // the same answer again. Keyed on the *stage identity*, not its current
  // text, so it doesn't re-fetch on every keystroke while the user edits
  // instructions; staleness is (re)checked here and after an explicit
  // recommend/refresh, never continuously.
  useEffect(() => {
    let cancelled = false;
    if (!recommendationAvailable) {
      return;
    }
    window.praxis.workflows
      .getRecommendation(workflowId, node.id, recommendationInput)
      .then(({ recommendation, stale }) => {
        if (cancelled) return;
        if (recommendation) {
          setRecommendState({ status: 'done', agentId: recommendation.agentId, rationale: recommendation.rationale, stale });
          setHasRecommendation(true);
        } else {
          setRecommendState({ status: 'idle' });
          setHasRecommendation(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecommendState({ status: 'idle' });
          setHasRecommendation(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, node.id, recommendationAvailable]);

  const requestRecommendation = useCallback(async () => {
    setRecommendState({ status: 'loading' });
    try {
      const result = await window.praxis.workflows.recommendAgent(workflowId, node.id, recommendationInput);
      setRecommendState({ status: 'done', agentId: result.agentId, rationale: result.rationale, stale: false });
      setHasRecommendation(true);
    } catch (error) {
      setRecommendState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [workflowId, node.id, recommendationInput]);

  const selectedHostId = node.agent.hostId || node.agent.agentId;
  const selectedProfileId = node.agent.profileId || node.agent.agentId;
  const chosen = agents.find(candidate => candidate.manifest.id === selectedHostId);
  const chosenProfile = profiles.find(candidate => candidate.profile.id === selectedProfileId);
  const caps = catalog?.capabilities[selectedHostId];
  const unusable =
    selectedHostId && chosen
      ? chosen.errors.length > 0 || (requireTrust && !chosen.trusted)
      : false;

  // One warning at a time, shown as a glyph on the Agent field with the full
  // text in its tooltip — the picker itself carries the "(untrusted)" hints.
  const agentWarning =
    agents.length === 0
      ? 'No agents were discovered. Install one under the trusted agents folder, or advance this stage by hand from the run monitor.'
      : selectedHostId && !chosen
        ? `"${selectedHostId}" is not in the discovered launch binding catalog — the stage will fail preflight until it is installed.`
        : unusable
          ? `This agent would fail preflight ${
              chosen && chosen.errors.length > 0
                ? '(fix its manifest)'
                : '(move it under the trusted agents folder, or relax the policy)'
            }.`
          : undefined;

  const setAgent = (patch: Partial<typeof node.agent>) => set({ agent: { ...node.agent, ...patch } });
  const profileWarning =
    profiles.length === 0
      ? 'No agent profiles were discovered. Create an AGENT.md profile in the Agent Hub.'
      : selectedProfileId && !chosenProfile
        ? `"${selectedProfileId}" is not in the profile catalog.`
        : chosenProfile?.error
          ? chosenProfile.error
          : requireTrust && chosenProfile && !chosenProfile.trusted
            ? 'The selected profile is not trusted.'
            : undefined;

  const toggleSkill = (name: string, fingerprint: string, on: boolean) => {
    const skillNames = on
      ? [...(node.agent.skillNames ?? []), name]
      : (node.agent.skillNames ?? []).filter(candidate => candidate !== name);
    const fingerprints = { ...(node.agent.skillFingerprints ?? {}) };
    if (on) fingerprints[name] = fingerprint;
    else delete fingerprints[name];
    setAgent({ skillNames, skillFingerprints: fingerprints });
  };

  return (
    <>
      <Field
        label="Agent profile"
        warning={profileWarning}
        actions={
          recommendationAvailable === true && recommendableAgents.length > 0 ? (
            hasRecommendation ? (
              <button
                type="button"
                className="icon-btn icon-btn-sm wf-recommend-btn"
                data-testid="wf-recommend-refresh-btn"
                title="Ask the AI to recommend again — the last recommendation is cached and doesn't re-ask on its own"
                disabled={recommendState.status === 'loading'}
                onClick={() => void requestRecommendation()}
              >
                <Icon name="refresh" size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn icon-btn-sm wf-recommend-btn"
                data-testid="wf-recommend-agent-btn"
                title="Ask the configured AI to recommend an agent profile for this stage — cached afterwards, never re-asked automatically"
                disabled={recommendState.status === 'loading'}
                onClick={() => void requestRecommendation()}
              >
                <Icon name="sparkles" size={12} />
              </button>
            )
          ) : recommendationAvailable === false ? (
            <span
              className="icon-btn icon-btn-sm wf-recommend-btn is-disabled"
              data-testid="wf-recommend-unavailable"
              title="Recommending an agent needs an API-based AI provider (Vercel AI Gateway, OpenAI, or Anthropic) configured in Settings → AI."
            >
              <Icon name="sparkles" size={12} />
            </span>
          ) : undefined
        }
      >
        {profiles.length > 0 ? (
          <select value={selectedProfileId} onChange={event => setAgent({ profileId: event.target.value })}>
            <option value="">— choose a profile —</option>
            {profiles.map(profile => (
              <option key={profile.profile.id} value={profile.profile.id}>
                {profile.profile.name}{profile.legacy ? ' (legacy brief)' : ''}{profile.trusted ? '' : ' (untrusted)'}
              </option>
            ))}
          </select>
        ) : (
          <input value={selectedProfileId} placeholder="e.g. praxis-reviewer" onChange={event => setAgent({ profileId: event.target.value })} />
        )}
      </Field>

      <Field label="Provider">
        <input
          value={node.agent.providerId ?? ''}
          placeholder="Active project provider"
          onChange={event => setAgent({ providerId: event.target.value || undefined })}
        />
      </Field>

      <Field label="Launch binding" warning={agentWarning}>
        {agents.length > 0 ? (
          <select
            value={selectedHostId}
            onChange={event => setAgent({ hostId: event.target.value, agentId: event.target.value })}
          >
            <option value="">— choose an agent —</option>
            {agents.map(agent => (
              <option key={agent.manifest.id} value={agent.manifest.id}>
                {agent.manifest.name}
                {agent.trusted ? '' : ' (untrusted)'}
                {agent.errors.length > 0 ? ' (invalid manifest)' : ''}
              </option>
            ))}
            {selectedHostId && !chosen && (
              <option value={selectedHostId}>{selectedHostId} (not discovered)</option>
            )}
          </select>
        ) : (
          <input
            value={selectedHostId}
            placeholder="e.g. claude-acp"
            onChange={event => setAgent({ hostId: event.target.value, agentId: event.target.value })}
          />
        )}
      </Field>

      {recommendState.status === 'loading' && (
        <p className="hint wf-recommend-status" data-testid="wf-recommend-loading">
          Asking the AI which agent profile fits this stage…
        </p>
      )}
      {recommendState.status === 'error' && (
        <p className="hint is-danger wf-recommend-status" data-testid="wf-recommend-error">
          {recommendState.message}
        </p>
      )}
      {recommendState.status === 'done' && (
        <div className="wf-recommend-result" data-testid="wf-recommend-result">
          <Icon name="sparkles" size={12} />
          <div className="wf-recommend-result-text">
            <strong>
              {profiles.find(candidate => candidate.profile.id === recommendState.agentId)?.profile.name ?? recommendState.agentId}
            </strong>
            <span>{recommendState.rationale}</span>
            {recommendState.stale && (
              <span className="wf-recommend-stale" data-testid="wf-recommend-stale">
                The stage changed since this was recommended — refresh to update.
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-compact"
            data-testid="wf-recommend-use"
            onClick={() => {
              setAgent({ profileId: recommendState.agentId });
              setRecommendState({ status: 'idle' });
            }}
          >
            Use this profile
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Dismiss recommendation"
            onClick={() => setRecommendState({ status: 'idle' })}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {chosen && (
        <div className="wf-agent-meta">
          <span>Trust: {chosen.trusted ? 'trusted' : 'untrusted'}</span>
          <span>
            Capabilities:{' '}
            {caps
              ? Object.entries(caps)
                  .filter(([, value]) => value === true)
                  .map(([key]) => key.replace(/^supports/, '').toLowerCase())
                  .join(', ') || 'none reported'
              : 'host not running'}
          </span>
          {chosen.errors.length > 0 && (
            <span className="is-danger">
              Manifest: {chosen.errors.map(error => error.message).join('; ')}
            </span>
          )}
        </div>
      )}

      <Field label="Tool mode">
        <select value={node.agent.toolMode} onChange={event => setAgent({ toolMode: event.target.value as never })}>
          <option value="read-only">read-only</option>
          <option value="project-only">project-only</option>
          <option value="full">full</option>
        </select>
      </Field>

      {skills.length > 0 && (
        <fieldset className="form-fieldset">
          <legend>Skills to activate</legend>
          {skills.map(skill => {
            const on = (node.agent.skillNames ?? []).includes(skill.metadata.name);
            const drifted = on && node.agent.skillFingerprints?.[skill.metadata.name] !== skill.fingerprint;
            return (
              <label key={skill.metadata.name} className="form-check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={event => toggleSkill(skill.metadata.name, skill.fingerprint, event.target.checked)}
                />
                {skill.metadata.name}
                {skill.error && <span className="hint is-danger"> (invalid)</span>}
                {!skill.trusted && <span className="hint"> (untrusted)</span>}
                {drifted && <span className="hint is-warn"> (changed since pinned)</span>}
              </label>
            );
          })}
        </fieldset>
      )}

      <Field label="Instructions">
        <textarea rows={3} value={node.instructions} onChange={event => set({ instructions: event.target.value })} />
      </Field>
      <label className="form-check">
        <input
          type="checkbox"
          checked={node.mutatesWorktree}
          onChange={event => set({ mutatesWorktree: event.target.checked })}
        />
        Writes to the implementation worktree
      </label>
      <GateSelect value={node.satisfiesGate} onChange={gate => set({ satisfiesGate: gate })} />
    </>
  );
}

function GateSelect({
  value,
  onChange
}: {
  value: WorkflowGateKind | undefined;
  onChange: (gate: WorkflowGateKind | undefined) => void;
}) {
  return (
    <Field label="Satisfies gate">
      <select value={value ?? ''} onChange={event => onChange((event.target.value || undefined) as WorkflowGateKind | undefined)}>
        <option value="">none</option>
        {GATES.map(gate => (
          <option key={gate} value={gate}>
            {gate}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ── Edge editor ──────────────────────────────────────────────────────────

function EdgeEditor({
  definition,
  selectedEdgeId,
  onSelectEdge,
  onChange
}: {
  definition: WorkflowDefinition;
  selectedEdgeId?: string;
  onSelectEdge?: (edgeId: string | undefined) => void;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  return (
    <div className="inspector-card">
      <h2>Connections</h2>

      <div className="wf-edge-form">
        <Field label="From">
          <select value={from} onChange={event => setFrom(event.target.value)}>
            <option value="">—</option>
            {definition.nodes.map(node => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <select value={to} onChange={event => setTo(event.target.value)}>
            <option value="">—</option>
            {definition.nodes.map(node => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="btn btn-compact"
          disabled={!from || !to || from === to}
          onClick={() => {
            onChange(connectNodes(definition, { from, to }));
            setFrom('');
            setTo('');
          }}
        >
          Connect
        </button>
      </div>

      <ul className="wf-edge-list">
        {definition.edges.map(edge => {
          const fromName = definition.nodes.find(node => node.id === edge.from)?.name ?? edge.from;
          const toName = definition.nodes.find(node => node.id === edge.to)?.name ?? edge.to;
          const isSelected = selectedEdgeId === edge.id;
          return (
            <li
              key={edge.id}
              className={`wf-edge-row${isSelected ? ' is-selected' : ''}`}
              onClick={() => onSelectEdge?.(edge.id)}
            >
              <span className="wf-edge-label" title={`${fromName} → ${toName}`}>
                {fromName} <span aria-hidden>→</span> {toName}
              </span>
              <div className="wf-edge-controls">
                <select
                  aria-label={`Outcome for ${fromName} to ${toName}`}
                  value={edge.on}
                  onChange={event => onChange(updateEdge(definition, edge.id, { on: event.target.value as WorkflowEdgeOutcome }))}
                >
                  {OUTCOMES.map(outcome => (
                    <option key={outcome} value={outcome}>
                      {outcome}
                    </option>
                  ))}
                </select>
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={edge.required}
                    onChange={event => onChange(updateEdge(definition, edge.id, { required: event.target.checked }))}
                  />
                  required
                </label>
                <button
                  type="button"
                  className="btn-icon wf-edge-remove"
                  aria-label={`Remove connection ${fromName} to ${toName}`}
                  title="Remove"
                  onClick={event => {
                    event.stopPropagation();
                    onChange(disconnect(definition, edge.id));
                    if (selectedEdgeId === edge.id) onSelectEdge?.(undefined);
                  }}
                >
                  <Icon name="window-close" size={12} />
                </button>
              </div>
            </li>
          );
        })}
        {definition.edges.length === 0 && <li className="rail-empty">No connections yet.</li>}
      </ul>
    </div>
  );
}

// ── Small field wrapper ──────────────────────────────────────────────────

function Field({
  label,
  warning,
  actions,
  children
}: {
  label: string;
  /** Renders a warning glyph on the field; the full text is its tooltip. */
  warning?: string;
  /** Trailing controls beside the label — e.g. the "Recommended" AI trigger on the Agent field. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`form-field${warning ? ' has-warn' : ''}`}>
      <label className="form-field-label">
        <span className="form-field-label-row">
          <span>{label}</span>
          {actions}
        </span>
        {children}
      </label>
      {warning && (
        <span className="form-field-warn" role="img" aria-label={`Warning: ${warning}`} title={warning}>
          <Icon name="warning" size={12} />
        </span>
      )}
    </div>
  );
}
