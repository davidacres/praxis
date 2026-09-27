import { useMemo, useState } from 'react';
import type { ProjectRecord, WorkflowDefinition } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { NODE_KINDS } from './WorkflowCanvas';
import {
  analyzeWorkflowValidation,
  type BucketedFeedback,
  type ValidationCategoryKind
} from './workflowEdits';

export interface WorkflowValidationPaneProps {
  project: ProjectRecord;
  definition: WorkflowDefinition;
  feedback: BucketedFeedback | undefined;
  selectedNodeId?: string;
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

export function WorkflowValidationPane({
  project,
  definition,
  feedback,
  selectedNodeId,
  onClose,
  onSelectNode,
  onRevalidate,
  busy = false
}: WorkflowValidationPaneProps) {
  const [filterCategory, setFilterCategory] = useState<ValidationCategoryKind | 'all'>('all');
  const [cleared, setCleared] = useState(false);

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

  const stageIcon = (type: string): IconName => {
    return NODE_KINDS.find(k => k.type === type)?.icon ?? 'gear';
  };

  const errorCount = report.allErrors.length;
  const warningCount = report.allWarnings.length;

  return (
    <section
      className="bottom-panel wf-validation-pane"
      data-testid="workflow-validation-pane"
      aria-label="Workflow validation pane"
    >
      <div className="panel-tabs wf-val-pane-tabs">
        <div className="panel-tab active" data-testid="wf-val-tab-workflow">
          <Icon name="shield" size={13} />
          <span>Workflow</span>
        </div>
        {!cleared && (
          <span className="panel-source">
            {report.valid ? (
              <span className="badge badge-done" data-testid="wf-val-status-badge">Valid</span>
            ) : (
              <span className="badge badge-blocked" data-testid="wf-val-status-badge">
                {errorCount} {errorCount === 1 ? 'error' : 'errors'}
                {warningCount > 0 ? `, ${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}` : ''}
              </span>
            )}
          </span>
        )}
        <span className="spacer" />
        {onRevalidate && (
          <button
            type="button"
            className="btn btn-compact wf-val-revalidate-btn"
            onClick={() => {
              setCleared(false);
              onRevalidate();
            }}
            disabled={busy}
            data-testid="wf-val-recheck-btn"
            title="Revalidate workflow configuration"
          >
            <Icon name="refresh" size={12} className={busy ? 'is-spinning' : undefined} />
            <span>{busy ? 'Validating…' : 'Revalidate'}</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn-compact wf-val-clear-btn"
          onClick={() => setCleared(true)}
          disabled={cleared}
          data-testid="wf-val-clear-btn"
          title="Clear validation results"
        >
          <Icon name="close" size={12} />
          <span>Clear</span>
        </button>
        <span className="panel-divider" />
        <button
          type="button"
          className="icon-btn icon-btn-sm wf-val-close-btn"
          aria-label="Close pane"
          title="Close pane"
          onClick={onClose}
          data-testid="wf-val-close-btn"
          id="wf-val-close-btn"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className={`panel-body wf-val-pane-body${cleared ? ' is-cleared' : ''}`}>
        {cleared ? (
          <div className="wf-val-cleared-state" data-testid="wf-val-cleared-state">
            <Icon name="shield" size={24} />
            <div>
              <strong>Validation results cleared</strong>
              <p>Click Revalidate to check workflow topology, stage configurations, and policies.</p>
            </div>
            {onRevalidate && (
              <button
                type="button"
                className="btn btn-compact btn-primary"
                onClick={() => {
                  setCleared(false);
                  onRevalidate();
                }}
              >
                <Icon name="refresh" size={12} />
                <span>Revalidate</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Top status banner */}
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
                      } passed inspection in ${project.name}. Flow topology and stage configurations are sound.`
                    : `${errorCount} error${
                        errorCount === 1 ? '' : 's'
                      } and ${warningCount} warning${
                        warningCount === 1 ? '' : 's'
                      } found. Check the diagnostic details below.`}
                </p>
              </div>
            </div>

            {/* Validation categories / checks */}
            <div className="wf-val-categories" role="group" aria-label="Validation categories">
              {report.categories.map(cat => {
                const icon = CATEGORY_ICONS[cat.kind];
                const isSelected = filterCategory === cat.kind;
                return (
                  <div
                    key={cat.kind}
                    className={`wf-val-card${!cat.valid ? ' is-invalid' : ''}${isSelected ? ' is-selected' : ''}`}
                    data-testid={`wf-val-category-${cat.kind}`}
                    onClick={() => setFilterCategory(current => (current === cat.kind ? 'all' : cat.kind))}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    title={`Filter by ${cat.title}`}
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

            {/* Stages / steps with icons and status */}
            {definition.nodes.length > 0 && (
              <div className="wf-val-stages-section">
                <div className="wf-val-section-header">
                  <strong>Workflow steps ({definition.nodes.length})</strong>
                </div>
                <div className="wf-val-stages-grid" role="group" aria-label="Workflow steps">
                  {definition.nodes.map(node => {
                    const issues = feedback?.byNode[node.id] ?? [];
                    const isSelected = node.id === selectedNodeId;
                    const hasIssues = issues.length > 0;
                    return (
                      <div
                        key={node.id}
                        className={`wf-val-stage-card${hasIssues ? ' is-invalid' : ' is-valid'}${isSelected ? ' is-selected' : ''}`}
                        onClick={() => onSelectNode(node.id)}
                        role="button"
                        tabIndex={0}
                        title={`Select step "${node.name}" (${node.type})`}
                        data-testid={`wf-val-stage-${node.id}`}
                      >
                        <div className="wf-val-stage-card-header">
                          <Icon name={stageIcon(node.type)} size={14} />
                          <span className="wf-val-stage-name">{node.name}</span>
                          <span className="wf-val-stage-type">{node.type}</span>
                          <span className={`badge ${hasIssues ? 'badge-blocked' : 'badge-done'}`}>
                            {hasIssues ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'Valid'}
                          </span>
                        </div>
                        {hasIssues && (
                          <div className="wf-val-stage-issues-hint">
                            {issues.map((issue, idx) => (
                              <span key={idx} className="wf-val-stage-issue-line">
                                • {issue.message}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Issues list if invalid or has warnings */}
            {(displayedErrors.length > 0 || displayedWarnings.length > 0) && (
              <div className="wf-val-issues-section">
                <div className="wf-val-issues-header">
                  <strong>Diagnostic issues ({displayedErrors.length + displayedWarnings.length})</strong>
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
                          onClick={() => onSelectNode(err.targetNodeId!)}
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
                          onClick={() => onSelectNode(warn.targetNodeId!)}
                        >
                          Go to stage
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
