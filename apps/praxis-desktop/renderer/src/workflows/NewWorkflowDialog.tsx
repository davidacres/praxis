import { useEffect, useMemo, useState } from 'react';
import type { TemplateReadiness, WorkflowDefinition, WorkflowTemplate } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * New Workflow (FX-BF-014). Picks a built-in or global template, instantiates it
 * as a saved project workflow, and hands the definition back so the shell can
 * open its designer. The project's own workflows are the sidebar tree, not here.
 */

export function NewWorkflowDialog({
  projectId,
  onClose,
  onCreated
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (definition: WorkflowDefinition) => void;
}) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>();
  const [readiness, setReadiness] = useState<Record<string, TemplateReadiness>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.praxis.workflows
      .listTemplates(projectId)
      .then(list => setTemplates(list.filter(entry => entry.source !== 'project')))
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    void window.praxis.workflows
      .templateReadiness(projectId)
      .then(rows => setReadiness(Object.fromEntries(rows.map(row => [row.templateId, row]))));
  }, [projectId]);

  const use = (templateId: string) => {
    setBusy(true);
    setError(undefined);
    void window.praxis.workflows
      .instantiate(projectId, templateId)
      .then(onCreated)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const list = useMemo(() => templates ?? [], [templates]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="New workflow">
        <div className="modal-header agent-hub-dialog-head">
          <h3>New workflow</h3>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="modal-body agent-hub-dialog">
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          {!templates ? (
            <p className="wf-hint">Loading templates…</p>
          ) : (
            <ul className="wf-template-list">
              {list.map(template => {
                const ready = readiness[template.definition.id];
                const blocking = ready ? Object.entries(ready.blockingByNode) : [];
                return (
                  <li key={`${template.source}:${template.definition.id}`} className="wf-template">
                    <div className="wf-template-head">
                      <div>
                        <strong>{template.definition.name}</strong>
                        <span className="chip chip-muted">{template.source}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => use(template.definition.id)}
                      >
                        Use
                      </button>
                    </div>
                    {template.definition.description && (
                      <p className="wf-template-desc">{template.definition.description}</p>
                    )}
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
          )}
        </div>
      </div>
    </div>
  );
}
