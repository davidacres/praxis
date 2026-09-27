import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDialogs } from '../ui/dialogs';
import { createPortal } from 'react-dom';
import type {
  AgentRuntimeSnapshot,
  AiProvider,
  AgentWorkflowReference,
  ProjectRecord,
  WorkflowDefinition,
  WorkflowEdgeOutcome,
  WorkflowGateKind,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPolicyProfile
} from '@praxis/core';
import { isHostShimProfile, skillTitle } from '../agents/agentCatalog';
import { fetchModelOptions, hasModelCatalog, isApiModelProvider, providerIconName, providerLabel } from '../ai/modelProviders';
import { ChipSelect, type ChipSelectOption } from '../ui/ChipSelect';
import { Icon, type IconName } from '../ui/Icon';
import { NODE_KINDS, WorkflowCanvas, type WorkflowPaletteItem } from './WorkflowCanvas';
import { WorkflowValidationDialog } from './WorkflowValidationDialog';
import { WorkflowAssistantPopover } from './WorkflowAssistantPopover';
import {
  addNode,
  bucketFeedback,
  disconnect,
  duplicateNode,
  newNode,
  removeNode,
  setEntryNode,
  updateEdge,
  updateNode,
  type BucketedFeedback
} from './workflowEdits';
import { isProviderUsable, isProviderUsableForSessions } from '../ai/providerAvailability';

/**
 * Visual workflow designer (FX-BE-021 / FX-BF-014).
 *
 * Opened for one saved workflow, picked from the sidebar tree. A docked stage
 * rail and a pan/zoom canvas fill the centre; the stage/connection inspector
 * renders into the shell's right pane (`auxSlot`) so the canvas keeps the whole
 * centre column.
 */

const GATES: WorkflowGateKind[] = ['review', 'qa', 'security'];
const OUTCOMES: Array<{ value: WorkflowEdgeOutcome; label: string; description: string }> = [
  { value: 'success', label: 'On success', description: 'Follow this connection when the stage passes' },
  { value: 'failure', label: 'On failure', description: 'Follow this connection when the stage fails' },
  { value: 'always', label: 'Always', description: 'Follow this connection whatever the outcome' }
];

function nodeKind(type: WorkflowNodeType) {
  return NODE_KINDS.find(kind => kind.type === type) ?? NODE_KINDS[0];
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
  const selectStage = useCallback(
    (nodeId: string | undefined) => {
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(undefined);
      if (nodeId) onRequireAux?.();
    },
    [onRequireAux]
  );
  const selectEdge = useCallback(
    (edgeId: string | undefined) => {
      setSelectedEdgeId(edgeId);
      if (edgeId) {
        setSelectedNodeId(undefined);
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
      .then(statuses => setRecommendationAvailable(statuses.some(status => isApiModelProvider(status.provider) && isProviderUsable(status))))
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

  const [suggestingTiers, setSuggestingTiers] = useState(false);
  const [tierNote, setTierNote] = useState<string | undefined>();

  /**
   * Asks the AI for a tier per agent stage and applies them to the unsaved draft — the author saves or
   * discards. A stage that already names a tier or an exact model is the author's choice and is left alone.
   */
  const suggestTiers = useCallback(async () => {
    if (!definition) return;
    setSuggestingTiers(true);
    setTierNote(undefined);
    setError(undefined);
    try {
      const result = await window.praxis.workflows.recommendModelTiers(project.id, definition);
      let applied = 0;
      const nodes = definition.nodes.map(node => {
        if (node.type !== 'agent-task' || node.modelTier || node.model) return node;
        const suggestion = result.stages[node.id];
        if (!suggestion) return node;
        applied += 1;
        return { ...node, modelTier: suggestion.tier };
      });
      setDefinition({ ...definition, nodes, updatedAt: new Date().toISOString() });
      setSavedAt(undefined);
      setTierNote(
        applied === 0
          ? 'Every agent stage already has a model choice, so nothing changed.'
          : `Suggested a tier for ${applied} stage${applied === 1 ? '' : 's'} (${result.model}). Review them, then save.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggestingTiers(false);
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
  const profiles = useMemo(
    () => (catalog?.profiles ?? []).filter(profile => !isHostShimProfile(profile)),
    [catalog?.profiles]
  );
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
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await window.praxis.workflows.remove(project.id, workflowId).catch(() => undefined);
                onSaved?.();
                onDeleted?.();
              }}
            >
              Remove from list
            </button>
          </div>
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

  const selectedEdge = selectedEdgeId ? definition.edges.find(edge => edge.id === selectedEdgeId) : undefined;
  const inspector = (
    <section className="inspector wf-inspector aux-panel" aria-label="Stage inspector">
      {selectedEdge ? (
        <EdgeInspector
          definition={definition}
          edgeId={selectedEdge.id}
          onChange={mutate}
          onSelectEdge={selectEdge}
          onSelectNode={selectStage}
        />
      ) : selectedNode ? (
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
          <span>Pick a stage or a connection on the canvas to edit it.</span>
        </div>
      )}
    </section>
  );

  return (
    <div className="view-scroll wf-page wf-page--designer">
      <header className="wf-header">
        <div className="wf-header-title">
          <h1>{definition.name}</h1>
          <span className="wf-header-sub">{project.name}</span>
        </div>
        <div className="wf-header-actions">
          {!project.workspaceFolder && (
            <span className="wf-header-notice" title="Attach a folder to this project to run this workflow.">
              <Icon name="warning" size={12} />
              No folder
            </span>
          )}
          <ValidationChip feedback={feedback} validating={validating} disabled={validating || busy} onValidate={() => void runValidation()} />
          <button
            type="button"
            className="icon-btn"
            data-testid="wf-suggest-tiers-btn"
            aria-label="Suggest model tiers"
            onClick={() => void suggestTiers()}
            disabled={suggestingTiers || busy}
            title={suggestingTiers ? 'Suggesting model tiers…' : 'Suggest model tiers — ask the AI which tier each agent stage needs. Stages that already have a choice are kept.'}
          >
            <Icon name="sparkles" size={14} className={suggestingTiers ? 'is-spinning' : undefined} />
          </button>
          <button
            type="button"
            className="icon-btn wf-header-del"
            aria-label="Delete workflow"
            title="Delete workflow"
            onClick={() => void remove()}
            disabled={busy}
          >
            <Icon name="trash" size={14} />
          </button>
          <span className="wf-header-sep" aria-hidden />
          <button
            type="button"
            onClick={save}
            disabled={busy || !feedback?.valid || savedAt === definition.updatedAt}
            className="btn btn-primary btn-compact wf-header-save"
            title={feedback && !feedback.valid ? 'Fix the validation errors before saving' : undefined}
          >
            {savedAt === definition.updatedAt ? 'Saved' : 'Save workflow'}
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner wf-banner">
          {error}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => setError(undefined)}>
            <Icon name="close" size={11} />
          </button>
        </p>
      )}
      {tierNote && (
        <p className="hint wf-banner" role="status" data-testid="wf-suggest-tiers-note">
          <Icon name="sparkles" size={12} />
          {tierNote}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => setTierNote(undefined)}>
            <Icon name="close" size={11} />
          </button>
        </p>
      )}

      <div className="wf-designer wf-designer--two">
        <div className="wf-canvas-slot">
          <WorkflowCanvas
            definition={definition}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            issuesByNode={Object.fromEntries(
              Object.entries(feedback?.byNode ?? {}).map(([id, list]) => [id, list.length])
            )}
            presentations={presentations}
            agents={profiles}
            skills={skills}
            selectedAgentStageName={selectedAgentStage?.name}
            onChange={mutate}
            onSelectNode={selectStage}
            onSelectEdge={selectEdge}
            onAddAgentStage={profileId => addProfileStage(profileId)}
            onUseSkill={skillName => useSkill(skillName, selectedAgentStage?.id)}
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
              const effectiveTargetId = targetNodeId ?? selectedAgentStage?.id;
              if (!effectiveTargetId) {
                setError('Drop a skill onto an agent stage. Skills guide an agent; they do not create a runnable stage alone.');
                return;
              }
              useSkill(item.skillName, effectiveTargetId);
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

      {createPortal(
        <WorkflowAssistantPopover projectId={project.id} definition={definition} onWorkflowChange={mutate} onSaved={onSaved} />,
        document.body
      )}

      {auxSlot ? createPortal(inspector, auxSlot) : null}
    </div>
  );
}

// ── Validation chip ──────────────────────────────────────────────────────

/** The header's validation state and its trigger in one: click to see the full report. */
function ValidationChip({
  feedback,
  validating,
  disabled,
  onValidate
}: {
  feedback: BucketedFeedback | undefined;
  validating: boolean;
  disabled: boolean;
  onValidate: () => void;
}) {
  const errors = feedback?.errors.length ?? 0;
  const warnings = feedback?.warnings.length ?? 0;
  const graphIssues = feedback?.byNode[''] ?? [];
  const summary = !feedback
    ? 'Checking…'
    : feedback.valid
      ? warnings > 0
        ? `Valid · ${warnings} warning${warnings === 1 ? '' : 's'}`
        : 'Valid'
      : `${errors} error${errors === 1 ? '' : 's'}`;
  const tone = !feedback ? '' : !feedback.valid ? ' is-invalid' : warnings > 0 ? ' is-warn' : ' is-valid';
  return (
    <button
      type="button"
      className={`composer-chip wf-validate-chip${tone}`}
      data-testid="wf-validate-btn"
      onClick={onValidate}
      disabled={disabled}
      title={[
        'Validate workflow — check connections, flow, and stage configuration',
        ...graphIssues.map(issue => `• ${issue.message}`)
      ].join('\n')}
    >
      <Icon name={feedback && !feedback.valid ? 'warning' : 'shield'} size={13} />
      <span role="status" aria-live="polite">
        {validating ? 'Validating…' : summary}
      </span>
    </button>
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
  const kind = nodeKind(node.type);
  const isEntry = node.id === definition.entryNodeId;

  return (
    <div className="wf-inspector-body">
      <div className="wf-inspector-head">
        <span className="wf-inspector-kind">
          <Icon name={kind.icon} size={14} />
          <h2>{kind.label}</h2>
          {isEntry && <span className="rail-mark is-entry">entry</span>}
        </span>
        <div className="wf-inspector-actions">
          {!isEntry && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="Make entry stage"
              title="Make this the entry stage — where a run starts"
              onClick={() => onChange(setEntryNode(definition, node.id))}
            >
              <Icon name="play" size={12} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Duplicate stage"
            title="Duplicate stage"
            onClick={() => onChange(duplicateNode(definition, node.id))}
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm wf-inspector-danger"
            data-testid="wf-stage-remove-btn"
            aria-label={`Delete ${node.name}`}
            title={`Delete ${node.name}`}
            onClick={() => {
              onChange(removeNode(definition, node.id));
              onSelectNode(undefined);
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="issues wf-inspector-issues">
          {issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}

      <Field label="Name" stacked>
        <input value={node.name} onChange={event => set({ name: event.target.value })} />
      </Field>

      {node.type === 'agent-task' && (
        <AgentStageFields workflowId={definition.id} node={node} catalog={catalog} policy={policy} recommendationAvailable={recommendationAvailable} set={set} />
      )}

      {node.type === 'check' && (
        <>
          <Field label="Command" stacked>
            <input value={node.command} placeholder="npm" onChange={event => set({ command: event.target.value })} />
          </Field>
          <CheckArgumentsField command={node.command} args={node.args ?? []} onChange={args => set({ args })} />
          <GateSelect value={node.satisfiesGate} onChange={gate => set({ satisfiesGate: gate })} />
        </>
      )}

      {node.type === 'deployment' && (
        <>
          <Field label="Deployment profile" stacked hint="Resolved against the project’s deployment profiles when the run reaches this stage.">
            <input
              value={node.deploymentProfileId}
              placeholder="staging"
              onChange={event => set({ deploymentProfileId: event.target.value })}
            />
          </Field>
          <GateSelect value={node.satisfiesGate} onChange={gate => set({ satisfiesGate: gate })} />
        </>
      )}

      {node.type === 'approval' && (
        <>
          <Field label="Prompt" stacked>
            <textarea rows={2} value={node.prompt} onChange={event => set({ prompt: event.target.value })} />
          </Field>
          <div className="wf-inspector-group" role="group" aria-label="Required gates">
            <span className="form-field-label-text">Required gates</span>
            <div className="wf-toggle-chips">
              {GATES.map(gate => {
                const policyRequires = policy?.requiredGates.includes(gate) ?? false;
                const on = node.requiredGates.includes(gate) || policyRequires;
                return (
                  <label
                    key={gate}
                    className={`composer-chip wf-toggle-chip${on ? ' active' : ''}${policyRequires ? ' is-locked' : ''}`}
                    title={policyRequires ? 'Required by project policy' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={on}
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
                  </label>
                );
              })}
            </div>
          </div>
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
        <Field label="Wait for">
          <ChipSelect
            ariaLabel="Mode"
            value={node.mode}
            onChange={mode => set({ mode: mode as never })}
            options={[
              { value: 'all', label: 'Every branch', description: 'Continue once every incoming branch has finished' },
              { value: 'all-required', label: 'Required branches', description: 'Continue once the required branches have finished' }
            ]}
          />
        </Field>
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
  const profiles = useMemo(
    () => (catalog?.profiles ?? []).filter(profile => !isHostShimProfile(profile)),
    [catalog?.profiles]
  );
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
          const alreadyUsing = selectedProfileId === recommendation.agentId;
          if (!alreadyUsing) {
            setRecommendState({ status: 'done', agentId: recommendation.agentId, rationale: recommendation.rationale, stale });
          } else {
            setRecommendState({ status: 'idle' });
            if (stale) {
              void window.praxis.workflows.clearRecommendation(workflowId, node.id);
            }
          }
          setHasRecommendation(!alreadyUsing || !stale);
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
  // The AIs a stage can run on: those set up and turned on in Settings › AI Provider.
  const [usableAis, setUsableAis] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
      .listProviderStatuses()
      .then(statuses => {
        if (!cancelled) setUsableAis(statuses.filter(isProviderUsableForSessions).map(status => status.provider));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const stageAi = node.agent.providerId?.trim() ?? '';
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

  const profileOptions: ChipSelectOption[] = profiles.map(profile => ({
    value: profile.profile.id,
    label: profile.profile.name,
    description: profile.profile.description,
    icon: 'robot',
    meta: [profile.scope === 'project' ? 'project' : '', profile.legacy ? 'legacy' : '', profile.trusted ? '' : 'untrusted']
      .filter(Boolean)
      .join(' · ') || undefined
  }));
  if (selectedProfileId && !chosenProfile) profileOptions.push({ value: selectedProfileId, label: selectedProfileId, meta: 'not found' });

  const bindingOptions: ChipSelectOption[] = [
    { value: '', label: 'None' },
    ...agents.map(agent => ({
      value: agent.manifest.id,
      label: agent.manifest.name,
      meta: [agent.trusted ? '' : 'untrusted', agent.errors.length > 0 ? 'invalid manifest' : ''].filter(Boolean).join(' · ') || undefined
    }))
  ];
  if (selectedHostId && !chosen) bindingOptions.push({ value: selectedHostId, label: selectedHostId, meta: 'not discovered' });
  const capabilityList = caps
    ? Object.entries(caps)
        .filter(([, value]) => value === true)
        .map(([key]) => key.replace(/^supports/, '').toLowerCase())
        .join(', ') || 'none reported'
    : 'host not running';

  const aiOptions: ChipSelectOption[] = [
    { value: '', label: 'Run’s AI', description: 'Use the AI the run was started with', icon: 'sparkles' },
    ...[...new Set([...usableAis, ...(stageAi ? [stageAi] : [])])].map(id => ({
      value: id,
      label: providerLabel(id as AiProvider) ?? id,
      icon: providerIconName(id as AiProvider),
      meta: usableAis.includes(id) ? undefined : 'not set up'
    }))
  ];

  const [stageModels, setStageModels] = useState<ChipSelectOption[] | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setStageModels(undefined);
    if (!stageAi || !hasModelCatalog(stageAi as AiProvider)) return;
    setModelsLoading(true);
    fetchModelOptions(stageAi as AiProvider, false)
      .then(result => {
        if (!cancelled) setStageModels(result?.options.map(option => ({ value: option.value, label: option.name, description: option.description })));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stageAi]);
  const modelOptions: ChipSelectOption[] = [
    { value: '', label: node.modelTier ? `${node.modelTier} tier` : 'AI’s default', description: 'Let the model tier, or the AI’s own default, decide' },
    ...(stageModels ?? []),
    ...(node.model && !(stageModels ?? []).some(option => option.value === node.model) ? [{ value: node.model, label: node.model }] : [])
  ];

  const activeSkills = node.agent.skillNames ?? [];
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);

  return (
    <>
      <InspectorSection title="Agent">
        <Field
          label="Profile"
          warning={profileWarning}
          actions={
            recommendationAvailable === true && recommendableAgents.length > 0 ? (
              <button
                type="button"
                className="icon-btn icon-btn-sm wf-recommend-btn"
                data-testid={hasRecommendation ? 'wf-recommend-refresh-btn' : 'wf-recommend-agent-btn'}
                aria-label={hasRecommendation ? 'Recommend again' : 'Recommend a profile'}
                title={
                  hasRecommendation
                    ? 'Ask the AI to recommend again — the last recommendation is cached and doesn’t re-ask on its own'
                    : 'Ask the configured AI to recommend an agent profile for this stage — cached afterwards, never re-asked automatically'
                }
                disabled={recommendState.status === 'loading'}
                onClick={() => void requestRecommendation()}
              >
                <Icon name={hasRecommendation ? 'refresh' : 'sparkles'} size={12} />
              </button>
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
            <ChipSelect
              ariaLabel="Agent profile"
              data-testid="wf-node-profile"
              value={selectedProfileId}
              placeholder="Choose a profile"
              icon="robot"
              options={profileOptions}
              searchable={profiles.length > 5}
              onChange={profileId => setAgent({ profileId })}
            />
          ) : (
            <input aria-label="Agent profile" value={selectedProfileId} placeholder="e.g. praxis-reviewer" onChange={event => setAgent({ profileId: event.target.value })} />
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
            <div className="wf-recommend-actions">
              <button
                type="button"
                className="btn btn-compact"
                data-testid="wf-recommend-use"
                onClick={() => {
                  setAgent({ profileId: recommendState.agentId });
                  setRecommendState({ status: 'idle' });
                  setHasRecommendation(false);
                  void window.praxis.workflows.clearRecommendation(workflowId, node.id);
                }}
              >
                Use
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="Dismiss recommendation"
                title="Dismiss recommendation"
                onClick={() => {
                  setRecommendState({ status: 'idle' });
                  setHasRecommendation(false);
                  void window.praxis.workflows.clearRecommendation(workflowId, node.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        )}

        <Field
          label="Launch binding"
          warning={agentWarning}
          labelTitle={chosen ? `Trust: ${chosen.trusted ? 'trusted' : 'untrusted'} · Capabilities: ${capabilityList}` : undefined}
        >
          {agents.length > 0 ? (
            <ChipSelect
              ariaLabel="Launch binding"
              data-testid="wf-node-binding"
              value={selectedHostId}
              placeholder="None"
              options={bindingOptions}
              onChange={hostId => setAgent({ hostId, agentId: hostId })}
            />
          ) : (
            <input
              aria-label="Launch binding"
              value={selectedHostId}
              placeholder="e.g. claude-acp"
              onChange={event => setAgent({ hostId: event.target.value, agentId: event.target.value })}
            />
          )}
        </Field>
        {chosen && chosen.errors.length > 0 && (
          <p className="hint is-danger">Manifest: {chosen.errors.map(error => error.message).join('; ')}</p>
        )}

        <Field label="Tool mode">
          <ChipSelect
            ariaLabel="Tool mode"
            data-testid="wf-node-tool-mode"
            value={node.agent.toolMode}
            icon="tools"
            options={[
              { value: 'read-only', label: 'Read-only', description: 'Reads the project; cannot write or run commands' },
              { value: 'project-only', label: 'Project-only', description: 'Writes and runs commands inside the project only' },
              { value: 'full', label: 'Full', description: 'Unrestricted tool access' }
            ]}
            onChange={toolMode => setAgent({ toolMode: toolMode as never })}
          />
        </Field>
      </InspectorSection>

      <InspectorSection title="Model">
        <Field
          label="AI"
          labelTitle="Which AI runs this stage. Different stages can use different AIs — plan with one, implement with another."
          warning={stageAi && usableAis.length > 0 && !usableAis.includes(stageAi) ? `${providerLabel(stageAi as AiProvider) ?? stageAi} is not set up or is turned off — set it up in Settings › AI Provider, or the run will not start.` : undefined}
        >
          <ChipSelect
            ariaLabel="AI"
            data-testid="wf-node-ai"
            value={stageAi}
            options={aiOptions}
            onChange={providerId => set({ agent: { ...node.agent, providerId: providerId || undefined }, model: undefined })}
          />
        </Field>
        {stageAi && (
          <Field label="Model" labelTitle="An exact model wins over the tier. Leave it on the default to let the tier choose.">
            <ChipSelect
              ariaLabel="Model"
              data-testid="wf-node-model"
              value={node.model ?? ''}
              options={modelOptions}
              icon="sparkles"
              searchable
              allowCustom
              placeholder={modelsLoading ? 'Loading models…' : 'AI’s default'}
              onChange={model => set({ model: model.trim() ? model : undefined })}
            />
          </Field>
        )}
        <Field
          label="Model tier"
          labelTitle="Which model this stage’s session uses. Map each tier to a model per provider in Settings → AI Provider → Providers (open a provider’s row); an unmapped tier uses the run’s model."
        >
          <ChipSelect
            ariaLabel="Model tier"
            data-testid="wf-node-model-tier"
            value={node.modelTier ?? ''}
            options={[
              { value: '', label: 'Run’s model', description: 'Use whatever model the run was started with' },
              { value: 'fast', label: 'fast', description: 'Quick, inexpensive work' },
              { value: 'standard', label: 'standard', description: 'Everyday implementation and review' },
              { value: 'strong', label: 'strong', description: 'Hard reasoning, planning, and recovery' }
            ]}
            onChange={tier => set({ modelTier: (tier || undefined) as typeof node.modelTier })}
          />
        </Field>
        {node.modelTier && (
          <label className="form-check">
            <input
              type="checkbox"
              data-testid="wf-node-escalate"
              checked={node.escalateOnRetry !== false}
              onChange={event => set({ escalateOnRetry: event.target.checked ? undefined : false })}
            />
            Move up a tier on each retry
          </label>
        )}
      </InspectorSection>

      <InspectorSection
        title="Skills"
        count={activeSkills.length}
        action={
          skills.length > 0 ? (
            <button
              type="button"
              className="composer-chip wf-section-add"
              data-testid="wf-node-add-skill"
              onClick={() => setSkillPickerOpen(true)}
            >
              <Icon name="plus" size={12} />
              Add
            </button>
          ) : undefined
        }
      >
        {activeSkills.length > 0 ? (
          <div className="wf-skill-chips" role="list" aria-label="Active skills">
            {activeSkills.map(name => {
              const skill = skills.find(candidate => candidate.metadata.name === name);
              const drifted = skill && node.agent.skillFingerprints?.[name] !== skill.fingerprint;
              const problem = !skill ? 'Not installed' : skill.error ? 'Invalid' : drifted ? 'Changed since pinned' : !skill.trusted ? 'Untrusted' : undefined;
              const label = skill ? skillTitle(skill.metadata) : name;
              return (
                <span
                  key={name}
                  role="listitem"
                  className={`wf-skill-chip${problem ? ' is-warn' : ''}`}
                  data-testid={`wf-node-skill-${name}`}
                  title={[label, skill?.metadata.description, problem].filter(Boolean).join(' — ')}
                >
                  {problem ? <Icon name="warning" size={11} /> : <Icon name="zap" size={11} />}
                  <span className="wf-skill-chip-label">{label}</span>
                  <button
                    type="button"
                    className="wf-skill-chip-remove"
                    aria-label={`Remove skill ${label}`}
                    onClick={() => toggleSkill(name, skill?.fingerprint ?? '', false)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="hint">{skills.length > 0 ? 'No skills — the agent works from its profile alone.' : 'No skills are installed.'}</p>
        )}
      </InspectorSection>

      <InspectorSection title="Behaviour">
        <Field label="Instructions" stacked>
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
      </InspectorSection>

      {skillPickerOpen && (
        <SkillPickerDialog
          stageName={node.name}
          skills={skills}
          active={activeSkills}
          fingerprints={node.agent.skillFingerprints ?? {}}
          onToggle={toggleSkill}
          onClose={() => setSkillPickerOpen(false)}
        />
      )}
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
    <Field label="Satisfies gate" labelTitle="The approval gate this stage counts towards when it passes">
      <ChipSelect
        ariaLabel="Satisfies gate"
        value={value ?? ''}
        icon="shield"
        options={[{ value: '', label: 'None' }, ...GATES.map(gate => ({ value: gate, label: gate }))]}
        onChange={gate => onChange((gate || undefined) as WorkflowGateKind | undefined)}
      />
    </Field>
  );
}

// ── Skill picker ─────────────────────────────────────────────────────────

/**
 * Every installed skill, searchable, with enough detail to choose — the stage's
 * inspector only lists the ones it has switched on. Toggling applies at once;
 * the dialog is just a bigger place to browse.
 */
function SkillPickerDialog({
  stageName,
  skills,
  active,
  fingerprints,
  onToggle,
  onClose
}: {
  stageName: string;
  skills: AgentRuntimeSnapshot['skills'];
  active: string[];
  fingerprints: Record<string, string>;
  onToggle: (name: string, fingerprint: string, on: boolean) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = skills.filter(
    skill =>
      !q ||
      skill.metadata.name.toLowerCase().includes(q) ||
      skillTitle(skill.metadata).toLowerCase().includes(q) ||
      (skill.metadata.description?.toLowerCase().includes(q) ?? false)
  );

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card wf-skill-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Stage skills"
        data-testid="wf-skill-picker"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-header">
          <Icon name="zap" size={14} />
          <h3>Skills for {stageName}</h3>
          <span className="wf-skill-picker-count">{active.length} active</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="wf-skill-picker-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="input"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={query}
            onChange={event => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className="modal-body wf-skill-picker-list" role="group" aria-label="Skills">
          {visible.length === 0 && <p className="popover-label">No matching skills</p>}
          {visible.map(skill => {
            const name = skill.metadata.name;
            const on = active.includes(name);
            const drifted = on && fingerprints[name] !== skill.fingerprint;
            return (
              <label key={name} className={`wf-skill-option${on ? ' is-on' : ''}`} data-testid={`wf-skill-option-${name}`}>
                <input type="checkbox" checked={on} onChange={event => onToggle(name, skill.fingerprint, event.target.checked)} />
                <span className="wf-skill-option-text">
                  <span className="wf-skill-option-title">
                    {skillTitle(skill.metadata)}
                    {skill.scope === 'project' && <span className="wf-palette-badge chip-muted">project</span>}
                    {skill.error && <span className="wf-palette-badge is-warn">invalid</span>}
                    {!skill.trusted && <span className="wf-palette-badge is-warn">untrusted</span>}
                    {drifted && <span className="wf-palette-badge is-warn">changed since pinned</span>}
                  </span>
                  {skill.metadata.description && <span className="wf-skill-option-desc">{skill.metadata.description}</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-primary btn-compact" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Connection inspector ─────────────────────────────────────────────────

/** One connection, selected on the canvas: its outcome, whether it is required, and delete. */
function EdgeInspector({
  definition,
  edgeId,
  onChange,
  onSelectEdge,
  onSelectNode
}: {
  definition: WorkflowDefinition;
  edgeId: string;
  onChange: (next: WorkflowDefinition) => void;
  onSelectEdge: (edgeId: string | undefined) => void;
  onSelectNode: (nodeId: string | undefined) => void;
}) {
  const edge = definition.edges.find(candidate => candidate.id === edgeId);
  if (!edge) return null;
  const from = definition.nodes.find(node => node.id === edge.from);
  const to = definition.nodes.find(node => node.id === edge.to);
  const fromName = from?.name ?? edge.from;
  const toName = to?.name ?? edge.to;

  return (
    <div className="wf-inspector-body">
      <div className="wf-inspector-head">
        <span className="wf-inspector-kind">
          <Icon name="link" size={14} />
          <h2>Connection</h2>
        </span>
        <div className="wf-inspector-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm wf-inspector-danger"
            aria-label={`Remove connection ${fromName} to ${toName}`}
            title="Remove connection"
            onClick={() => {
              onChange(disconnect(definition, edge.id));
              onSelectEdge(undefined);
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </div>
      <div className="wf-edge-ends">
        <button type="button" className="composer-chip" onClick={() => onSelectNode(edge.from)} title={`Open ${fromName}`}>
          {from && <Icon name={nodeKind(from.type).icon} size={12} />}
          <span>{fromName}</span>
        </button>
        <Icon name="arrow-right" size={12} />
        <button type="button" className="composer-chip" onClick={() => onSelectNode(edge.to)} title={`Open ${toName}`}>
          {to && <Icon name={nodeKind(to.type).icon} size={12} />}
          <span>{toName}</span>
        </button>
      </div>
      <Field label="Follow">
        <ChipSelect
          ariaLabel={`Outcome for ${fromName} to ${toName}`}
          data-testid="wf-edge-outcome"
          value={edge.on}
          options={OUTCOMES}
          onChange={on => onChange(updateEdge(definition, edge.id, { on: on as WorkflowEdgeOutcome }))}
        />
      </Field>
      <label className="form-check">
        <input
          type="checkbox"
          checked={edge.required}
          onChange={event => onChange(updateEdge(definition, edge.id, { required: event.target.checked }))}
        />
        Required — the run waits on this branch
      </label>
    </div>
  );
}

// ── Layout helpers ───────────────────────────────────────────────────────

/** A titled group inside the inspector — a heading and a hairline, not another bordered panel. */
function InspectorSection({
  title,
  count,
  action,
  children
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="wf-inspector-section" aria-label={title}>
      <div className="wf-inspector-section-head">
        <h3>
          {title}
          {count !== undefined && count > 0 && <span className="wf-section-count">{count}</span>}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A labelled control. Chips sit on the label's row (label left, value right) to
 * keep the pane dense; text inputs pass `stacked` and take the full width.
 */
function Field({
  label,
  warning,
  actions,
  stacked = false,
  hint,
  labelTitle,
  children
}: {
  label: string;
  /** Renders a warning glyph on the field; the full text is its tooltip. */
  warning?: string;
  /** Trailing controls beside the label — e.g. the "Recommended" AI trigger on the Agent field. */
  actions?: React.ReactNode;
  stacked?: boolean;
  /** A short muted line under a stacked control. */
  hint?: string;
  /** Explanatory tooltip on the label text. */
  labelTitle?: string;
  children: React.ReactNode;
}) {
  // Only a stacked text field is a <label>: wrapped around a chip plus its row actions, a
  // label click would activate whichever button came first. Chips carry their own aria-label.
  const Wrapper = stacked ? 'label' : 'div';
  return (
    <div className={`form-field wf-field${stacked ? ' is-stacked' : ''}${warning ? ' has-warn' : ''}`}>
      <Wrapper className="form-field-label">
        <span className="form-field-label-row">
          <span className="form-field-label-text" title={labelTitle}>
            {label}
            {labelTitle && <Icon name="info" size={10} className="wf-field-info" />}
          </span>
          {warning && (
            <span className="form-field-warn" role="img" aria-label={`Warning: ${warning}`} title={warning}>
              <Icon name="warning" size={12} />
            </span>
          )}
          {actions}
        </span>
        {children}
      </Wrapper>
      {hint && stacked && <span className="hint wf-field-hint">{hint}</span>}
    </div>
  );
}

const SHELLS = new Set(['sh', 'bash', 'zsh']);

/**
 * A check's arguments. Plain arguments edit as one space-separated line; a shell script
 * (`sh -c <script>`) edits as the script itself; anything else holding spaces edits as a JSON
 * list — splitting those on spaces would silently rewrite the command on the first keystroke.
 */
function CheckArgumentsField({
  command,
  args,
  onChange
}: {
  command: string;
  args: string[];
  onChange: (args: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  const [invalid, setInvalid] = useState(false);

  if (SHELLS.has(command.trim()) && args[0] === '-c' && args.length === 2) {
    return (
      <Field label="Script" stacked hint={`Run with ${command.trim()} -c`}>
        <textarea
          className="wf-check-script"
          aria-label="Script"
          rows={10}
          spellCheck={false}
          value={args[1]}
          onChange={event => onChange(['-c', event.target.value])}
        />
      </Field>
    );
  }

  if (args.some(arg => /\s/.test(arg))) {
    return (
      <Field label="Arguments" stacked hint={invalid ? 'Not a JSON list of strings — not saved' : 'JSON list, one string per argument'}>
        <textarea
          aria-label="Arguments"
          rows={4}
          spellCheck={false}
          value={draft ?? JSON.stringify(args)}
          onChange={event => {
            setDraft(event.target.value);
            try {
              const parsed = JSON.parse(event.target.value) as unknown;
              if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('not a string list');
              setInvalid(false);
              onChange(parsed);
            } catch {
              setInvalid(true);
            }
          }}
          onBlur={() => {
            setDraft(undefined);
            setInvalid(false);
          }}
        />
      </Field>
    );
  }

  return (
    <Field label="Arguments" stacked hint="Space-separated">
      <input
        value={args.join(' ')}
        placeholder="run test"
        onChange={event => onChange(event.target.value.split(/\s+/).filter(Boolean))}
      />
    </Field>
  );
}
