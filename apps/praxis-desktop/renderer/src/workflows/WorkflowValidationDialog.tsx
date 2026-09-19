import { useEffect, useMemo, useState } from 'react';
import type { ProjectRecord, WorkflowDefinition } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import {
  analyzeWorkflowValidation,
  type BucketedFeedback,
  type ValidationCategoryKind,
  type WorkflowValidationCategory
} from './workflowEdits';

export interface WorkflowValidationDialogProps {
  project: ProjectRecord;
  definition: WorkflowDefinition;
  feedback: BucketedFeedback | undefined;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onRevalidate?: () => void;
  busy?: boolean;
}

const CATEGORY_ICONS: Record<ValidationCategoryKind, IconName> = {
  connections: 'split-horizontal',
  flow: 'git-branch',
  configuration: 'gear',
  gates: 'shield',
  policy: 'shield'
};

export function WorkflowValidationDialog({
  project,
  definition,
  feedback,
  onClose,
  onSelectNode,
  onRevalidate,
  busy = false
}: WorkflowValidationDialogProps) {
  const [filterCategory, setFilterCategory] = useState<ValidationCategoryKind | 'all'>('all');

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const report = useMemo(
    () => analyzeWorkflowValidation(definition, feedback),
    [definition, feedback]
  );

  const displayedErrors = useMemo(
    () =>
      filterCategory === 'all'
        ? report.allErrors
        : report.allErrors.filter(err => err.category === filterCategory),
    [report.allErrors, filterCategory]
  );

  const displayedWarnings = useMemo(
    () =>
      filterCategory === 'all'
        ? report.allWarnings
        : report.allWarnings.filter(w => w.category === filterCategory),
    [report.allWarnings, filterCategory]
  );

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wf-validation-title"
    >
      <div
        className="modal-card wf-validation-dialog"
        onClick={e => e.stopPropagation()}
        data-testid="workflow-validation-dialog"
      >
        <div className="modal-header">
          <Icon name="shield" size={16} />
          <div>
            <h3 id="wf-validation-title">Validate workflow</h3>
            <span className="wf-val-subtitle">
              {definition.name} · {project.name}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm wf-val-close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="modal-body wf-val-body">
          {/* Top Status Banner */}
          <div
            className={`wf-val-banner ${report.valid ? 'is-valid' : 'is-invalid'}`}
            data-testid="wf-validation-banner"
          >
            <span className="wf-val-banner-icon">
              <Icon name={report.valid ? 'check-square' : 'warning'} size={20} />
            </span>
            <div className="wf-val-banner-text">
              <strong>
                {report.valid
                  ? 'Workflow is configured and valid'
                  : 'Workflow configuration requires attention'}
              </strong>
              <p>
                {report.valid
                  ? `All ${report.totalConnections} connection${
                      report.totalConnections === 1 ? '' : 's'
                    } and ${report.totalStages} stage${
                      report.totalStages === 1 ? '' : 's'
                    } passed inspection. Flow topology and stage configurations are sound.`
                  : `${report.allErrors.length} error${
                      report.allErrors.length === 1 ? '' : 's'
                    } and ${report.allWarnings.length} warning${
                      report.allWarnings.length === 1 ? '' : 's'
                    } found. Check the diagnostic details below.`}
              </p>
            </div>
          </div>

          {/* Categories Grid */}
          <div className="wf-val-categories" role="group" aria-label="Validation categories">
            {report.categories.map(cat => {
              const icon = CATEGORY_ICONS[cat.kind];
              const isSelected = filterCategory === cat.kind;
              return (
                <div
                  key={cat.kind}
                  className={`wf-val-card${!cat.valid ? ' is-invalid' : ''}${isSelected ? ' is-selected' : ''}`}
                  data-testid={`wf-val-category-${cat.kind}`}
                >
                  <div className="wf-val-card-header">
                    <Icon name={icon} size={15} />
                    <span className="wf-val-card-title">{cat.title}</span>
                    <span
                      className={`badge ${
                        cat.valid
                          ? 'badge-done'
                          : cat.errors.length > 0
                            ? 'badge-blocked'
                            : 'badge-progress'
                      }`}
                    >
                      {cat.valid ? 'Valid' : `${cat.errors.length} issue${cat.errors.length === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  <p className="wf-val-card-summary">{cat.summary}</p>
                </div>
              );
            })}
          </div>

          {/* Issues List if invalid or has warnings */}
          {(displayedErrors.length > 0 || displayedWarnings.length > 0) && (
            <div className="wf-val-issues-section">
              <div className="wf-val-issues-header">
                <strong>Diagnostic issues</strong>
                {filterCategory !== 'all' && (
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => setFilterCategory('all')}
                  >
                    Show all categories
                  </button>
                )}
              </div>
              <ul className="wf-val-issue-list" aria-label="Validation issues">
                {displayedErrors.map((err, idx) => (
                  <li key={`err-${idx}`} className="wf-val-issue-item is-error">
                    <span className="wf-val-issue-badge is-error">Error</span>
                    <span className="wf-val-issue-text">{err.message}</span>
                    {err.targetNodeName && (
                      <span className="wf-val-issue-target">
                        Stage: <strong>{err.targetNodeName}</strong>
                      </span>
                    )}
                    {err.targetNodeId && (
                      <button
                        type="button"
                        className="btn btn-compact wf-val-goto-btn"
                        onClick={() => {
                          onSelectNode(err.targetNodeId!);
                          onClose();
                        }}
                      >
                        Go to stage
                      </button>
                    )}
                  </li>
                ))}
                {displayedWarnings.map((warn, idx) => (
                  <li key={`warn-${idx}`} className="wf-val-issue-item is-warning">
                    <span className="wf-val-issue-badge is-warning">Warning</span>
                    <span className="wf-val-issue-text">{warn.message}</span>
                    {warn.targetNodeName && (
                      <span className="wf-val-issue-target">
                        Stage: <strong>{warn.targetNodeName}</strong>
                      </span>
                    )}
                    {warn.targetNodeId && (
                      <button
                        type="button"
                        className="btn btn-compact wf-val-goto-btn"
                        onClick={() => {
                          onSelectNode(warn.targetNodeId!);
                          onClose();
                        }}
                      >
                        Go to stage
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer wf-val-footer">
          {onRevalidate ? (
            <button
              type="button"
              className="btn"
              onClick={onRevalidate}
              disabled={busy}
              data-testid="wf-val-recheck-btn"
            >
              <Icon name="refresh" size={13} /> {busy ? 'Checking…' : 'Check again'}
            </button>
          ) : (
            <div />
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
            data-testid="wf-val-done-btn"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
