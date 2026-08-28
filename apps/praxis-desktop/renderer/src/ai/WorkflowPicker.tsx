import { useEffect, useState } from 'react';
import type { AgentWorkflowReference } from '@praxis/core';
import { Icon } from '../ui/Icon';

interface WorkflowPickerProps {
  /** Currently assigned pack (shown pinned at the top when not re-discovered). */
  current?: AgentWorkflowReference;
  /** Picked pack, or null for the explicit "No workflow pack" choice. */
  onSelect: (workflow: AgentWorkflowReference | null) => void;
  onClose: () => void;
}

function sameWorkflow(left: AgentWorkflowReference, right: AgentWorkflowReference): boolean {
  return left.instructionsPath === right.instructionsPath || left.id === right.id;
}

/**
 * Modal workflow-pack picker — the desktop counterpart of the extension's
 * `promptForAgentWorkflowSelection` quick-pick. Lists packs discovered under
 * `<workingDirectory>/.github/skills` plus an explicit "no pack" row.
 */
export function WorkflowPicker({ current, onSelect, onClose }: WorkflowPickerProps) {
  const [packs, setPacks] = useState<AgentWorkflowReference[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    window.ticketManager.ai
      .listWorkflowPacks()
      .then(discovered => {
        if (cancelled) {
          return;
        }
        const pinned =
          current && !discovered.some(pack => sameWorkflow(pack, current)) ? [current] : [];
        setPacks([...pinned, ...discovered]);
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPacks([]);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" data-testid="workflow-picker" onClick={onClose}>
      <div className="modal-card" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <Icon name="robot" size={14} />
          <h3>Workflow pack</h3>
          <span style={{ flex: 1 }} />
          <button className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          {!packs && !error && <p className="placeholder-text">Discovering packs…</p>}
          {packs && (
            <>
              <button
                className={`workflow-pack-row${!current ? ' selected' : ''}`}
                data-testid="workflow-pack-none"
                onClick={() => onSelect(null)}
              >
                <span className="workflow-pack-name">No workflow pack</span>
                <span className="workflow-pack-desc">
                  Run without a workflow pack — no workflow directive is added to the task.
                </span>
              </button>
              {packs.map(pack => (
                <button
                  key={pack.id}
                  className={`workflow-pack-row${current && sameWorkflow(pack, current) ? ' selected' : ''}`}
                  data-testid={`workflow-pack-${pack.id}`}
                  onClick={() => onSelect(pack)}
                >
                  <span className="workflow-pack-name">{pack.name}</span>
                  {pack.description && <span className="workflow-pack-desc">{pack.description}</span>}
                  <span className="workflow-pack-path">{pack.instructionsPath}</span>
                </button>
              ))}
              {packs.length === 0 && (
                <p className="placeholder-text">
                  No packs found. Add one under <code>.github/skills</code> in the AI working
                  directory.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
