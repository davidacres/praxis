import { useCallback, useEffect, useState } from 'react';
import type {
  AgentRuntimeSnapshot,
  ProjectRecord,
  WorkflowDefinition,
  WorkflowEdgeOutcome,
  WorkflowGateKind,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPolicyProfile,
  WorkflowTemplate,
  TemplateReadiness
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { WorkflowRunMonitor } from './WorkflowRunMonitor';
import { WorkflowCanvas } from './WorkflowCanvas';
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
 * Visual workflow designer (FX-BE-021). A structured editor rather than a
 * free-drag canvas: nodes are a keyboard-navigable list, edges are explicit
 * from/to rows, and every mutation runs through the pure `workflowDesignerState`
 * helpers so undo is a value stack. Live validation from core over IPC
 * badges the offending node and blocks Save.
 */

const NODE_KINDS: Array<{ type: WorkflowNodeType; label: string; icon: string }> = [
  { type: 'agent-task', label: 'Agent stage', icon: 'robot' },
  { type: 'check', label: 'Check', icon: 'shield' },
  { type: 'approval', label: 'Approval', icon: 'check-square' },
  { type: 'join', label: 'Join', icon: 'split-horizontal' }
];

const GATES: WorkflowGateKind[] = ['review', 'qa', 'security'];
const OUTCOMES: WorkflowEdgeOutcome[] = ['success', 'failure', 'always'];

/** The gate a stage satisfies, without importing a core runtime helper. */
function railGate(node: WorkflowNode): WorkflowGateKind | undefined {
  return node.type === 'agent-task' || node.type === 'check' ? node.satisfiesGate : undefined;
}

export interface WorkflowDesignerPageProps {
  project: ProjectRecord;
  /** Which half of the feature is open — controlled by the route. */
  view?: 'design' | 'runs';
  onViewChange?: (view: 'design' | 'runs') => void;
  /** Opens the agent session behind a run stage. */
  onOpenSession?: (sessionKey: string) => void;
}

export function WorkflowDesignerPage({
  project,
  view: viewProp,
  onViewChange,
  onOpenSession
}: WorkflowDesignerPageProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [readiness, setReadiness] = useState<Record<string, TemplateReadiness>>({});
  const [projectWorkflows, setProjectWorkflows] = useState<WorkflowDefinition[]>([]);
  const [definition, setDefinition] = useState<WorkflowDefinition | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  // The inspector column is a single panel at a time — a stage's fields or the
  // connection list — so neither overflows the 340px column.
  const [inspectorTab, setInspectorTab] = useState<'stage' | 'connections'>('stage');
  const selectStage = useCallback((nodeId: string | undefined) => {
    setSelectedNodeId(nodeId);
    if (nodeId) setInspectorTab('stage');
  }, []);
  const [error, setError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [uncontrolledView, setUncontrolledView] = useState<'design' | 'runs'>('design');
  const view = viewProp ?? uncontrolledView;
  const setView = onViewChange ?? setUncontrolledView;
  const [catalog, setCatalog] = useState<AgentRuntimeSnapshot | undefined>();
  const [policy, setPolicy] = useState<WorkflowPolicyProfile | undefined>();

  useEffect(() => {
    void window.praxis.agentRuntime.list().then(setCatalog);
    void window.praxis.workflows.effectivePolicy(project.id).then(setPolicy);
  }, [project.id]);

  const [libraryLoading, setLibraryLoading] = useState(true);
  const reloadLibrary = useCallback(() => {
    setLibraryLoading(true);
    void window.praxis.workflows
      .listTemplates(project.id)
      .then(list => {
        setTemplates(list);
        setProjectWorkflows(list.filter(entry => entry.source === 'project').map(entry => entry.definition));
      })
      .finally(() => setLibraryLoading(false));
    void window.praxis.workflows
      .templateReadiness(project.id)
      .then(rows => setReadiness(Object.fromEntries(rows.map(row => [row.templateId, row]))));
  }, [project.id]);

  useEffect(reloadLibrary, [reloadLibrary]);

  // Validation runs in core over IPC, debounced, so the renderer bundle stays
  // free of the validator (and the chokidar-laden core barrel).
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

  const mutate = useCallback((next: WorkflowDefinition) => {
    setDefinition(next);
    setSavedAt(undefined);
  }, []);

  const openTemplate = useCallback(
    async (templateId: string) => {
      setError(undefined);
      setBusy(true);
      try {
        const copy = await window.praxis.workflows.instantiate(project.id, templateId);
        setDefinition(copy);
        setSelectedNodeId(copy.nodes[0]?.id);
        setSavedAt(copy.updatedAt);
        reloadLibrary();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [project.id, reloadLibrary]
  );

  const openExisting = useCallback((workflow: WorkflowDefinition) => {
    setDefinition(workflow);
    setSelectedNodeId(workflow.nodes[0]?.id);
    setSavedAt(workflow.updatedAt);
    setError(undefined);
  }, []);

  const save = useCallback(async () => {
    if (!definition) return;
    setError(undefined);
    setBusy(true);
    try {
      const saved = await window.praxis.workflows.save(project.id, definition);
      setDefinition(saved);
      setSavedAt(saved.updatedAt);
      reloadLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [definition, project.id, reloadLibrary]);

  const selectedNode = definition?.nodes.find(node => node.id === selectedNodeId);

  return (
    <div className="view-scroll wf-page">
      <header className="wf-header">
        <h1>Workflows</h1>
        <span className="wf-header-sub">{project.name}</span>
        <div role="tablist" aria-label="Workflow view" className="wf-viewswitch">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'design'}
            className={`btn-compact${view === 'design' ? ' active' : ''}`}
            onClick={() => setView('design')}
          >
            Design
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'runs'}
            className={`btn-compact${view === 'runs' ? ' active' : ''}`}
            onClick={() => setView('runs')}
          >
            Runs
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}

      {view === 'runs' ? (
        <WorkflowRunMonitor
          project={project}
          runnableWorkflows={projectWorkflows.map(workflow => ({ id: workflow.id, name: workflow.name }))}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
      ) : !definition ? (
        <TemplateLibrary
          templates={templates}
          readiness={readiness}
          projectWorkflows={projectWorkflows}
          busy={busy}
          loading={libraryLoading}
          onUseTemplate={openTemplate}
          onOpenExisting={openExisting}
        />
      ) : (
        <div className="wf-designer">
          <nav className="wf-rail" aria-label="Workflow stages">
            <div className="wf-rail-head">
              <strong>{definition.name}</strong>
              <button
                type="button"
                className="btn btn-compact"
                onClick={() => {
                  setDefinition(undefined);
                  reloadLibrary();
                }}
              >
                Close
              </button>
            </div>

            <div role="group" aria-label="Add stage" className="wf-rail-add">
              {NODE_KINDS.map(kind => (
                <button
                  key={kind.type}
                  type="button"
                  className="chip"
                  onClick={() => {
                    const node = newNode(kind.type, { x: 120, y: 120 + definition.nodes.length * 40 });
                    mutate(addNode(definition, node));
                    selectStage(node.id);
                  }}
                >
                  <Icon name={kind.icon as never} size={13} /> {kind.label}
                </button>
              ))}
            </div>

            <ul className="wf-rail-list">
              {definition.nodes.map(node => {
                const issues = feedback?.byNode[node.id]?.length ?? 0;
                const isEntry = node.id === definition.entryNodeId;
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      className="wf-rail-row"
                      aria-pressed={node.id === selectedNodeId}
                      aria-label={`${node.name} (${node.type})${isEntry ? ', entry stage' : ''}${
                        issues > 0 ? `, ${issues} issue${issues === 1 ? '' : 's'}` : ''
                      }`}
                      onClick={() => selectStage(node.id)}
                    >
                      <span className="wf-rail-main">
                        <span className="wf-rail-name">{node.name}</span>
                        <span className="wf-rail-sub">{node.type}</span>
                      </span>
                      {issues > 0 ? (
                        <span className="wf-rail-mark is-issue" title={`${issues} validation issue${issues === 1 ? '' : 's'}`}>
                          ⚠ {issues}
                        </span>
                      ) : isEntry ? (
                        <span className="wf-rail-mark is-entry">entry</span>
                      ) : railGate(node) ? (
                        <span className="wf-rail-mark is-gate">{railGate(node)}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="wf-rail-foot">
              <ValidationSummary feedback={feedback} />
              {!project.workspaceFolder && (
                <p className="wf-hint is-warn">Attach a folder to this project to run this workflow.</p>
              )}
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
              issuesByNode={Object.fromEntries(
                Object.entries(feedback?.byNode ?? {}).map(([id, list]) => [id, list.length])
              )}
              onChange={mutate}
              onSelectNode={selectStage}
            />
          </div>

          <section className="wf-inspector wf-inspector--tabbed" aria-label="Stage inspector">
            <div role="tablist" aria-label="Inspector" className="wf-inspector-tabs">
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

            <div className="wf-inspector-body">
              {inspectorTab === 'stage' ? (
                selectedNode ? (
                  <NodeInspector
                    definition={definition}
                    node={selectedNode}
                    issues={feedback?.byNode[selectedNode.id] ?? []}
                    catalog={catalog}
                    policy={policy}
                    onChange={mutate}
                    onSelectNode={selectStage}
                  />
                ) : (
                  <div className="empty-state">
                    <Icon name="cursor" size={26} />
                    <span>Select a stage to edit it.</span>
                  </div>
                )
              ) : (
                <EdgeEditor definition={definition} onChange={mutate} />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ── Template library ─────────────────────────────────────────────────────

function TemplateLibrary({
  templates,
  readiness,
  projectWorkflows,
  busy,
  loading,
  onUseTemplate,
  onOpenExisting
}: {
  templates: WorkflowTemplate[];
  readiness: Record<string, TemplateReadiness>;
  projectWorkflows: WorkflowDefinition[];
  busy: boolean;
  loading: boolean;
  onUseTemplate: (templateId: string) => void;
  onOpenExisting: (workflow: WorkflowDefinition) => void;
}) {
  if (loading && templates.length === 0) {
    return (
      <div className="wf-library" aria-busy="true">
        <section aria-label="Loading workflows">
          <h2>Start from a template</h2>
          <ul className="wf-template-list">
            {[0, 1, 2].map(i => (
              <li key={i} className="wf-template wf-skeleton" aria-hidden />
            ))}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <div className="wf-library">
      {projectWorkflows.length > 0 && (
        <section aria-label="This project's workflows">
          <h2>This project</h2>
          <div className="wf-card-grid">
            {projectWorkflows.map(workflow => (
              <button key={workflow.id} type="button" className="wf-card" onClick={() => onOpenExisting(workflow)}>
                <strong>{workflow.name}</strong>
                <span className="wf-rail-sub">v{workflow.version}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Workflow templates">
        <h2>Start from a template</h2>
        <p className="wf-library-lede">
          Pick a starting point and edit it on the canvas — a governed pipeline with review, QA,
          and security gates, or a quick single-stage change.
        </p>
        <ul className="wf-template-list">
          {templates.map(template => {
            const ready = readiness[template.definition.id];
            const blocking = ready ? Object.entries(ready.blockingByNode) : [];
            return (
              <li key={`${template.source}:${template.definition.id}`} className="wf-template">
                <div className="wf-template-head">
                  <div>
                    <strong>{template.definition.name}</strong>
                    <span className="chip chip-muted">{template.source}</span>
                  </div>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onUseTemplate(template.definition.id)}>
                    Use template
                  </button>
                </div>
                {template.definition.description && <p className="wf-template-desc">{template.definition.description}</p>}
                {ready && !ready.agentsOk && (
                  <p role="status" className="wf-template-warn">
                    Needs agents that are not installed:{' '}
                    {blocking.map(([nodeId, message]) => `${nodeId} — ${message}`).join('; ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

// ── Validation summary ───────────────────────────────────────────────────

function ValidationSummary({ feedback }: { feedback: BucketedFeedback | undefined }) {
  if (!feedback) return null;
  const graphIssues = feedback.byNode[''] ?? [];
  return (
    <div role="status" aria-live="polite" className={`wf-validation${feedback.valid ? '' : ' is-invalid'}`}>
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
  onChange,
  onSelectNode
}: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  issues: Array<{ path: string; message: string }>;
  catalog: AgentRuntimeSnapshot | undefined;
  policy: WorkflowPolicyProfile | undefined;
  onChange: (next: WorkflowDefinition) => void;
  onSelectNode: (nodeId: string | undefined) => void;
}) {
  const set = (patch: Partial<WorkflowNode>) => onChange(updateNode(definition, node.id, patch as never));

  return (
    <div className="wf-inspector-card">
      <div className="wf-inspector-head">
        <h2>{node.type}</h2>
        <div className="wf-inspector-head-actions">
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
            onClick={() => {
              onChange(removeNode(definition, node.id));
              onSelectNode(undefined);
            }}
          >
            Remove
          </button>
        </div>
      </div>

      <Field label="Name">
        <input value={node.name} onChange={event => set({ name: event.target.value })} />
      </Field>

      {node.type === 'agent-task' && (
        <AgentStageFields node={node} catalog={catalog} policy={policy} set={set} />
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

      {node.type === 'approval' && (
        <>
          <Field label="Prompt">
            <textarea rows={2} value={node.prompt} onChange={event => set({ prompt: event.target.value })} />
          </Field>
          <fieldset className="wf-fieldset">
            <legend>Required gates</legend>
            {GATES.map(gate => {
              const policyRequires = policy?.requiredGates.includes(gate) ?? false;
              return (
                <label key={gate} className="wf-check">
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
                  {policyRequires && <span className="wf-hint"> — required by project policy</span>}
                </label>
              );
            })}
          </fieldset>
          <label className={`wf-check${policy?.allowGateBypass === false ? ' is-disabled' : ''}`}>
            <input
              type="checkbox"
              checked={node.allowBypass && policy?.allowGateBypass !== false}
              disabled={policy?.allowGateBypass === false}
              onChange={event => set({ allowBypass: event.target.checked })}
            />
            Allow an attributed gate bypass
            {policy?.allowGateBypass === false && (
              <span className="wf-hint"> — forbidden by project policy</span>
            )}
          </label>
          {policy?.requireHumanApproval && (
            <p className="wf-hint">Project policy requires a human approval stage.</p>
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
        <ul className="wf-issues">
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
  node,
  catalog,
  policy,
  set
}: {
  node: Extract<WorkflowNode, { type: 'agent-task' }>;
  catalog: AgentRuntimeSnapshot | undefined;
  policy: WorkflowPolicyProfile | undefined;
  set: (patch: Partial<WorkflowNode>) => void;
}) {
  const agents = catalog?.agents ?? [];
  const skills = catalog?.skills ?? [];
  const requireTrust = policy?.requireTrustedAgents ?? true;

  const chosen = agents.find(candidate => candidate.manifest.id === node.agent.agentId);
  const caps = catalog?.capabilities[node.agent.agentId];
  const unusable =
    node.agent.agentId && chosen
      ? chosen.errors.length > 0 || (requireTrust && !chosen.trusted)
      : false;

  // One warning at a time, shown as a glyph on the Agent field with the full
  // text in its tooltip — the picker itself carries the "(untrusted)" hints.
  const agentWarning =
    agents.length === 0
      ? 'No agents were discovered. Install one under the trusted agents folder, or advance this stage by hand from the run monitor.'
      : node.agent.agentId && !chosen
        ? `"${node.agent.agentId}" is not in the discovered catalog — the stage will fail preflight until it is installed.`
        : unusable
          ? `This agent would fail preflight ${
              chosen && chosen.errors.length > 0
                ? '(fix its manifest)'
                : '(move it under the trusted agents folder, or relax the policy)'
            }.`
          : undefined;

  const setAgent = (patch: Partial<typeof node.agent>) => set({ agent: { ...node.agent, ...patch } });

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
      <Field label="Agent" warning={agentWarning}>
        {agents.length > 0 ? (
          <select
            value={node.agent.agentId}
            onChange={event => setAgent({ agentId: event.target.value })}
          >
            <option value="">— choose an agent —</option>
            {agents.map(agent => (
              <option key={agent.manifest.id} value={agent.manifest.id}>
                {agent.manifest.name}
                {agent.trusted ? '' : ' (untrusted)'}
                {agent.errors.length > 0 ? ' (invalid manifest)' : ''}
              </option>
            ))}
            {node.agent.agentId && !chosen && (
              <option value={node.agent.agentId}>{node.agent.agentId} (not discovered)</option>
            )}
          </select>
        ) : (
          <input
            value={node.agent.agentId}
            placeholder="e.g. praxis-reviewer"
            onChange={event => setAgent({ agentId: event.target.value })}
          />
        )}
      </Field>

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
        <fieldset className="wf-fieldset">
          <legend>Skills to activate</legend>
          {skills.map(skill => {
            const on = (node.agent.skillNames ?? []).includes(skill.metadata.name);
            const drifted = on && node.agent.skillFingerprints?.[skill.metadata.name] !== skill.fingerprint;
            return (
              <label key={skill.metadata.name} className="wf-check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={event => toggleSkill(skill.metadata.name, skill.fingerprint, event.target.checked)}
                />
                {skill.metadata.name}
                {skill.error && <span className="wf-hint is-danger"> (invalid)</span>}
                {!skill.trusted && <span className="wf-hint"> (untrusted)</span>}
                {drifted && <span className="wf-hint is-warn"> (changed since pinned)</span>}
              </label>
            );
          })}
        </fieldset>
      )}

      <Field label="Instructions">
        <textarea rows={3} value={node.instructions} onChange={event => set({ instructions: event.target.value })} />
      </Field>
      <label className="wf-check">
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
  onChange
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  return (
    <div className="wf-inspector-card">
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
          return (
            <li key={edge.id} className="wf-edge-row">
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
                <label className="wf-check">
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
                  onClick={() => onChange(disconnect(definition, edge.id))}
                >
                  <Icon name="window-close" size={12} />
                </button>
              </div>
            </li>
          );
        })}
        {definition.edges.length === 0 && <li className="wf-rail-empty">No connections yet.</li>}
      </ul>
    </div>
  );
}

// ── Small field wrapper ──────────────────────────────────────────────────

function Field({
  label,
  warning,
  children
}: {
  label: string;
  /** Renders a warning glyph on the field; the full text is its tooltip. */
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`wf-field${warning ? ' has-warn' : ''}`}>
      <label className="wf-field-label">
        <span>{label}</span>
        {children}
      </label>
      {warning && (
        <span className="wf-field-warn" role="img" aria-label={`Warning: ${warning}`} title={warning}>
          <Icon name="warning" size={12} />
        </span>
      )}
    </div>
  );
}
