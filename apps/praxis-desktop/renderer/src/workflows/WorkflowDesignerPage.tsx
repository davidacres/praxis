import { useCallback, useEffect, useState } from 'react';
import type {
  ProjectRecord,
  WorkflowDefinition,
  WorkflowEdgeOutcome,
  WorkflowGateKind,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowTemplate,
  TemplateReadiness
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { WorkflowRunMonitor } from './WorkflowRunMonitor';
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

export interface WorkflowDesignerPageProps {
  project: ProjectRecord;
}

export function WorkflowDesignerPage({ project }: WorkflowDesignerPageProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [readiness, setReadiness] = useState<Record<string, TemplateReadiness>>({});
  const [projectWorkflows, setProjectWorkflows] = useState<WorkflowDefinition[]>([]);
  const [definition, setDefinition] = useState<WorkflowDefinition | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'design' | 'runs'>('design');

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
    <div className="view-scroll" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Workflows</h1>
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{project.name}</span>
        <div role="tablist" aria-label="View" style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'design'}
            className="ghost-button"
            onClick={() => setView('design')}
          >
            Design
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'runs'}
            className="ghost-button"
            onClick={() => setView('runs')}
          >
            Runs
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      )}

      {view === 'runs' ? (
        <WorkflowRunMonitor
          project={project}
          runnableWorkflows={projectWorkflows.map(workflow => ({ id: workflow.id, name: workflow.name }))}
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
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) 1fr', gap: 20, alignItems: 'start' }}>
          <section aria-label="Workflow stages" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{definition.name}</strong>
              <button type="button" onClick={() => setDefinition(undefined)} className="ghost-button">
                Close
              </button>
            </div>

            <div role="group" aria-label="Add stage" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {NODE_KINDS.map(kind => (
                <button
                  key={kind.type}
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    const node = newNode(kind.type, { x: 80, y: 80 + definition.nodes.length * 40 });
                    mutate(addNode(definition, node));
                    setSelectedNodeId(node.id);
                  }}
                >
                  <Icon name={kind.icon as never} /> {kind.label}
                </button>
              ))}
            </div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {definition.nodes.map(node => {
                const issues = feedback?.byNode[node.id]?.length ?? 0;
                const isEntry = node.id === definition.entryNodeId;
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-pressed={node.id === selectedNodeId}
                      aria-label={`${node.name} (${node.type})${isEntry ? ', entry stage' : ''}${
                        issues > 0 ? `, ${issues} issue${issues === 1 ? '' : 's'}` : ''
                      }`}
                      onClick={() => setSelectedNodeId(node.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: node.id === selectedNodeId ? 'var(--surface-active, var(--bg-elevated))' : 'var(--bg)',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{node.name}</span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 6 }}>{node.type}</span>
                      </span>
                      {isEntry && (
                        <span title="Entry stage" style={{ fontSize: 11, color: 'var(--accent)' }}>
                          entry
                        </span>
                      )}
                      {issues > 0 && (
                        <span
                          title={`${issues} validation issue${issues === 1 ? '' : 's'}`}
                          style={{ fontSize: 11, color: 'var(--danger)' }}
                        >
                          ⚠ {issues}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            <ValidationSummary feedback={feedback} />

            <button
              type="button"
              onClick={save}
              disabled={busy || !feedback?.valid || savedAt === definition.updatedAt}
              className="primary-button"
            >
              {savedAt === definition.updatedAt ? 'Saved' : 'Save workflow'}
            </button>
            {!feedback?.valid && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-dim)' }}>
                Resolve the {feedback?.errors.length} error{feedback?.errors.length === 1 ? '' : 's'} before saving.
              </p>
            )}
          </section>

          <section aria-label="Stage inspector" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {selectedNode ? (
              <NodeInspector
                definition={definition}
                node={selectedNode}
                issues={feedback?.byNode[selectedNode.id] ?? []}
                onChange={mutate}
                onSelectNode={setSelectedNodeId}
              />
            ) : (
              <p style={{ color: 'var(--text-dim)' }}>Select a stage to edit it.</p>
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
  onChange,
  onSelectNode
}: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  issues: Array<{ path: string; message: string }>;
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
        <>
          <Field label="Agent Hub id">
            <input
              value={node.agent.agentId}
              placeholder="e.g. praxis-reviewer"
              onChange={event => set({ agent: { ...node.agent, agentId: event.target.value } })}
            />
          </Field>
          <Field label="Tool mode">
            <select
              value={node.agent.toolMode}
              onChange={event => set({ agent: { ...node.agent, toolMode: event.target.value as never } })}
            >
              <option value="read-only">read-only</option>
              <option value="project-only">project-only</option>
              <option value="full">full</option>
            </select>
          </Field>
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
            {GATES.map(gate => (
              <label key={gate} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={node.requiredGates.includes(gate)}
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
            ))}
          </fieldset>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={node.allowBypass} onChange={event => set({ allowBypass: event.target.checked })} />
            Allow an attributed gate bypass
          </label>
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
