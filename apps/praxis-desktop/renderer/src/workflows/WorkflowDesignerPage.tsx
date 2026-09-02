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

  const reloadLibrary = useCallback(() => {
    void window.praxis.workflows.listTemplates(project.id).then(list => {
      setTemplates(list);
      setProjectWorkflows(list.filter(entry => entry.source === 'project').map(entry => entry.definition));
    });
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
                className="btn-compact"
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
                    setSelectedNodeId(node.id);
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
                      onClick={() => setSelectedNodeId(node.id)}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{node.name}</span>{' '}
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
              onSelectNode={setSelectedNodeId}
            />
          </div>

          <section className="wf-inspector" aria-label="Stage inspector">
            {selectedNode ? (
              <NodeInspector
                definition={definition}
                node={selectedNode}
                issues={feedback?.byNode[selectedNode.id] ?? []}
                catalog={catalog}
                policy={policy}
                onChange={mutate}
                onSelectNode={setSelectedNodeId}
              />
            ) : (
              <div className="empty-state">
                <Icon name="cursor" size={26} />
                <span>Select a stage to edit it.</span>
              </div>
            )}

            <EdgeEditor definition={definition} onChange={mutate} />
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
  onUseTemplate,
  onOpenExisting
}: {
  templates: WorkflowTemplate[];
  readiness: Record<string, TemplateReadiness>;
  projectWorkflows: WorkflowDefinition[];
  busy: boolean;
  onUseTemplate: (templateId: string) => void;
  onOpenExisting: (workflow: WorkflowDefinition) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {projectWorkflows.length > 0 && (
        <section aria-label="This project's workflows">
          <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>This project</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {projectWorkflows.map(workflow => (
              <li key={workflow.id}>
                <button
                  type="button"
                  onClick={() => onOpenExisting(workflow)}
                  className="ghost-button"
                  style={{ width: '100%', textAlign: 'left' }}
                >
                  <strong>{workflow.name}</strong>{' '}
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>v{workflow.version}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Workflow templates">
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>Start from a template</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map(template => {
            const ready = readiness[template.definition.id];
            const blocking = ready ? Object.entries(ready.blockingByNode) : [];
            return (
              <li
                key={`${template.source}:${template.definition.id}`}
                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <div>
                    <strong>{template.definition.name}</strong>
                    <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 8 }}>{template.source}</span>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => onUseTemplate(template.definition.id)}
                  >
                    Use template
                  </button>
                </div>
                {template.definition.description && (
                  <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>
                    {template.definition.description}
                  </p>
                )}
                {ready && !ready.agentsOk && (
                  <p role="status" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--warning, var(--danger))' }}>
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
    <div
      role="status"
      aria-live="polite"
      style={{
        fontSize: 12,
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '8px 10px',
        color: feedback.valid ? 'var(--text-dim)' : 'var(--danger)'
      }}
    >
      {feedback.valid ? (
        <>Valid — {feedback.warnings.length} warning{feedback.warnings.length === 1 ? '' : 's'}.</>
      ) : (
        <>
          {feedback.errors.length} error{feedback.errors.length === 1 ? '' : 's'}.
          {graphIssues.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{node.type}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {node.id !== definition.entryNodeId && (
            <button type="button" className="ghost-button" onClick={() => onChange(setEntryNode(definition, node.id))}>
              Make entry
            </button>
          )}
          <button type="button" className="ghost-button" onClick={() => onChange(duplicateNode(definition, node.id))}>
            Duplicate
          </button>
          <button
            type="button"
            className="ghost-button"
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
          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12, color: 'var(--text-dim)' }}>Required gates</legend>
            {GATES.map(gate => {
              const policyRequires = policy?.requiredGates.includes(gate) ?? false;
              return (
                <label key={gate} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
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
                  {policyRequires && <span style={{ color: 'var(--text-dim)' }}> — required by project policy</span>}
                </label>
              );
            })}
          </fieldset>
          <label
            style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, opacity: policy?.allowGateBypass === false ? 0.6 : 1 }}
          >
            <input
              type="checkbox"
              checked={node.allowBypass && policy?.allowGateBypass !== false}
              disabled={policy?.allowGateBypass === false}
              onChange={event => set({ allowBypass: event.target.checked })}
            />
            Allow an attributed gate bypass
            {policy?.allowGateBypass === false && (
              <span style={{ color: 'var(--text-dim)' }}> — forbidden by project policy</span>
            )}
          </label>
          {policy?.requireHumanApproval && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-dim)' }}>
              Project policy requires a human approval stage.
            </p>
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
        <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--danger)', fontSize: 12 }}>
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
      <Field label="Agent">
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

      {node.agent.agentId && !chosen && (
        <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--warning, var(--danger))' }}>
          "{node.agent.agentId}" is not in the discovered catalog — the stage will fail preflight until it is installed.
        </p>
      )}
      {chosen && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 2 }}>
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
            <span style={{ color: 'var(--danger)' }}>
              Manifest: {chosen.errors.map(error => error.message).join('; ')}
            </span>
          )}
        </div>
      )}
      {unusable && (
        <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>
          This agent would fail preflight
          {chosen && chosen.errors.length > 0 ? ' (fix its manifest)' : ' (move it under the trusted agents folder or relax the policy)'}.
        </p>
      )}

      <Field label="Tool mode">
        <select value={node.agent.toolMode} onChange={event => setAgent({ toolMode: event.target.value as never })}>
          <option value="read-only">read-only</option>
          <option value="project-only">project-only</option>
          <option value="full">full</option>
        </select>
      </Field>

      {skills.length > 0 && (
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
          <legend style={{ fontSize: 12, color: 'var(--text-dim)' }}>Skills to activate</legend>
          {skills.map(skill => {
            const on = (node.agent.skillNames ?? []).includes(skill.metadata.name);
            const drifted = on && node.agent.skillFingerprints?.[skill.metadata.name] !== skill.fingerprint;
            return (
              <label key={skill.metadata.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={event => toggleSkill(skill.metadata.name, skill.fingerprint, event.target.checked)}
                />
                {skill.metadata.name}
                {skill.error && <span style={{ color: 'var(--danger)' }}> (invalid)</span>}
                {!skill.trusted && <span style={{ color: 'var(--text-dim)' }}> (untrusted)</span>}
                {drifted && <span style={{ color: 'var(--warning, var(--danger))' }}> (changed since pinned)</span>}
              </label>
            );
          })}
        </fieldset>
      )}

      <Field label="Instructions">
        <textarea rows={3} value={node.instructions} onChange={event => set({ instructions: event.target.value })} />
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>Connections</h2>

      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
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
          className="ghost-button"
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

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {definition.edges.map(edge => {
          const fromNode = definition.nodes.find(node => node.id === edge.from);
          const toNode = definition.nodes.find(node => node.id === edge.to);
          return (
            <li key={edge.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                {fromNode?.name ?? edge.from} → {toNode?.name ?? edge.to}
              </span>
              <select
                aria-label={`Outcome for ${fromNode?.name ?? edge.from} to ${toNode?.name ?? edge.to}`}
                value={edge.on}
                onChange={event => onChange(updateEdge(definition, edge.id, { on: event.target.value as WorkflowEdgeOutcome }))}
              >
                {OUTCOMES.map(outcome => (
                  <option key={outcome} value={outcome}>
                    {outcome}
                  </option>
                ))}
              </select>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={edge.required}
                  onChange={event => onChange(updateEdge(definition, edge.id, { required: event.target.checked }))}
                />
                required
              </label>
              <button type="button" className="ghost-button" onClick={() => onChange(disconnect(definition, edge.id))}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Small field wrapper ──────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      {children}
    </label>
  );
}
