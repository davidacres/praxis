import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoredTemplateRecommendation, TemplateReadiness, WorkflowDefinition, WorkflowTemplate } from '@praxis/core';
import { API_MODEL_PROVIDERS } from '../ai/modelProviders';
import { Icon } from '../ui/Icon';
import { getWorkflowTemplateGuidance, getWorkflowStageSequence } from './workflowTemplateGuidance';
import { isProviderUsable } from '../ai/providerAvailability';

/**
 * New Workflow Dialog (FX-BF-014 / FX-BF-034).
 *
 * Master-detail workflow picker:
 * - Left pane: Search, source tabs (All, Built-in, Marketplace), scannable list of templates
 * - Right pane: Comprehensive preview:
 *   - Overview, badges & stack indicator
 *   - "What it's good for" guidance card with key highlights
 *   - Visual pipeline sequence preview (stages & stage types)
 *   - Enforced quality & security gates and thresholds
 *   - Agent requirements and live readiness status
 * - Primary action to instantiate the chosen template
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
  const [selectedId, setSelectedId] = useState<string>();
  const [filterQuery, setFilterQuery] = useState('');
  const [sourceTab, setSourceTab] = useState<'all' | 'built-in' | 'marketplace'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // AI-recommended template: gated on some api-kind provider (Vercel AI
  // Gateway, OpenAI, or Anthropic — same set the workflow agent
  // recommendation uses) actually being configured, fetched once as a free
  // cache read — `getRecommendedTemplate` never calls the AI, only an
  // explicit refresh click does (see `requestTemplateRecommendation`).
  // `undefined` is "still checking" (render nothing yet, not "unconfigured");
  // without that third state the button flashes as unavailable for every
  // user, even a configured one, until the status check resolves.
  const [recommendationAvailable, setRecommendationAvailable] = useState<boolean | undefined>(undefined);
  const [recommendation, setRecommendation] = useState<StoredTemplateRecommendation | undefined>();
  const [recommending, setRecommending] = useState(false);
  const [recommendError, setRecommendError] = useState<string>();

  useEffect(() => {
    void window.praxis.workflows
      .listTemplates(projectId)
      .then(list => {
        const filtered = list.filter(entry => entry.source !== 'project');
        setTemplates(filtered);
        if (filtered.length > 0 && !selectedId) {
          setSelectedId(filtered[0].definition.id);
        }
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));

    void window.praxis.workflows
      .templateReadiness(projectId)
      .then(rows => setReadiness(Object.fromEntries(rows.map(row => [row.templateId, row]))));

    void window.praxis.workflows.getRecommendedTemplate(projectId).then(setRecommendation);
    void window.praxis.ai
      .listProviderStatuses()
      .then(statuses => setRecommendationAvailable(statuses.some(status => API_MODEL_PROVIDERS.has(status.provider) && isProviderUsable(status))))
      .catch(() => setRecommendationAvailable(false));
  }, [projectId]);

  const requestTemplateRecommendation = useCallback(async () => {
    setRecommending(true);
    setRecommendError(undefined);
    try {
      const result = await window.praxis.workflows.recommendTemplate(projectId);
      setRecommendation({ templateId: result.templateId, rationale: result.rationale, model: result.model, computedAt: new Date().toISOString() });
    } catch (cause) {
      setRecommendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRecommending(false);
    }
  }, [projectId]);

  const rawList = useMemo(() => templates ?? [], [templates]);

  // Filter templates by query and tab
  const list = useMemo(() => {
    return rawList.filter(template => {
      if (sourceTab !== 'all') {
        if (sourceTab === 'built-in' && template.source !== 'built-in') return false;
        if (sourceTab === 'marketplace' && template.source !== 'marketplace' && template.source !== 'global') return false;
      }
      if (!filterQuery.trim()) return true;
      const q = filterQuery.toLowerCase();
      return (
        template.definition.name.toLowerCase().includes(q) ||
        (template.definition.description || '').toLowerCase().includes(q) ||
        template.definition.id.toLowerCase().includes(q)
      );
    });
  }, [rawList, filterQuery, sourceTab]);

  // Ensure an item is selected if list changes
  useEffect(() => {
    if (list.length > 0) {
      if (!selectedId || !list.some(t => t.definition.id === selectedId)) {
        setSelectedId(list[0].definition.id);
      }
    }
  }, [list, selectedId]);

  const selectedTemplate = useMemo(() => {
    return rawList.find(t => t.definition.id === selectedId) ?? list[0];
  }, [rawList, list, selectedId]);

  const guidance = useMemo(() => {
    if (!selectedTemplate) return undefined;
    return getWorkflowTemplateGuidance(selectedTemplate.definition);
  }, [selectedTemplate]);

  const stages = useMemo(() => {
    if (!selectedTemplate) return [];
    return getWorkflowStageSequence(selectedTemplate.definition);
  }, [selectedTemplate]);

  const selectedReadiness = selectedTemplate ? readiness[selectedTemplate.definition.id] : undefined;
  const blockingReasons = selectedReadiness ? Object.entries(selectedReadiness.blockingByNode) : [];

  const use = (templateId: string) => {
    setBusy(true);
    setError(undefined);
    void window.praxis.workflows
      .instantiate(projectId, templateId)
      .then(onCreated)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card wf-picker-card" role="dialog" aria-modal="true" aria-label="New workflow">
        <div className="wf-picker-header">
          <div className="wf-picker-title-group">
            <h3>
              <Icon name="git-branch" size={16} />
              Select workflow template
            </h3>
            <div className="wf-picker-subtitle-row">
              <p className="wf-picker-subtitle">
                Choose a workflow template as the foundation for this project's delivery pipeline.
              </p>
              {recommendationAvailable === true && (
                <button
                  type="button"
                  className="btn btn-compact wf-picker-recommend-btn"
                  data-testid={recommendation ? 'wf-picker-refresh-btn' : 'wf-picker-recommend-btn'}
                  title={
                    recommendation
                      ? 'Ask the AI to recommend again — the last recommendation is saved with the project and doesn’t re-ask on its own'
                      : 'Ask the configured AI which template fits this project'
                  }
                  disabled={recommending}
                  onClick={() => void requestTemplateRecommendation()}
                >
                  <Icon name={recommendation ? 'refresh' : 'sparkles'} size={12} />
                  {recommendation ? 'Refresh recommendation' : 'Recommend a template'}
                </button>
              )}
              {recommendationAvailable === false && (
                <span
                  className="btn btn-compact wf-picker-recommend-btn is-disabled"
                  data-testid="wf-picker-recommend-unavailable"
                  title="Recommending a template needs an API-based AI provider (Vercel AI Gateway, OpenAI, or Anthropic) configured in Settings → AI."
                >
                  <Icon name="sparkles" size={12} />
                  Recommend a template
                </span>
              )}
            </div>
            {recommending && (
              <p className="hint wf-picker-recommend-status" data-testid="wf-picker-recommend-loading">
                Asking the AI which template fits this project…
              </p>
            )}
            {recommendError && (
              <p className="hint is-danger wf-picker-recommend-status" data-testid="wf-picker-recommend-error">
                {recommendError}
              </p>
            )}
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="wf-picker-body">
          {/* Left Pane: Filter, Tabs & Template List */}
          <div className="wf-picker-sidebar">
            <div className="wf-picker-filter-bar">
              <div className="wf-picker-search">
                <Icon name="search" size={13} />
                <input
                  type="text"
                  placeholder="Filter templates…"
                  value={filterQuery}
                  onChange={e => setFilterQuery(e.target.value)}
                  aria-label="Filter templates"
                />
                {filterQuery && (
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label="Clear filter"
                    onClick={() => setFilterQuery('')}
                  >
                    <Icon name="close" size={11} />
                  </button>
                )}
              </div>
              <div className="wf-picker-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className={`wf-picker-tab ${sourceTab === 'all' ? 'active' : ''}`}
                  onClick={() => setSourceTab('all')}
                >
                  All ({rawList.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`wf-picker-tab ${sourceTab === 'built-in' ? 'active' : ''}`}
                  onClick={() => setSourceTab('built-in')}
                >
                  <Icon name="shield" size={12} />
                  Built-in
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`wf-picker-tab ${sourceTab === 'marketplace' ? 'active' : ''}`}
                  onClick={() => setSourceTab('marketplace')}
                >
                  <Icon name="package" size={12} />
                  Marketplace
                </button>
              </div>
            </div>

            <ul className="wf-picker-list" role="list">
              {error && (
                <p role="alert" className="error-banner">
                  {error}
                </p>
              )}
              {!templates ? (
                <p className="hint" style={{ padding: 'var(--space-3)' }}>
                  Loading templates…
                </p>
              ) : list.length === 0 ? (
                <div className="wf-picker-empty">
                  <Icon name="search" size={24} />
                  <p>No matching templates found.</p>
                </div>
              ) : (
                list.map(template => {
                  const isSelected = selectedTemplate?.definition.id === template.definition.id;
                  const isRecommended = recommendation?.templateId === template.definition.id;
                  const itemReady = readiness[template.definition.id];
                  const stageCount = template.definition.nodes.length;
                  return (
                    <li
                      key={`${template.source}:${template.definition.id}`}
                      role="listitem"
                      className="wf-picker-item-wrapper"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`wf-picker-item ${isSelected ? 'active' : ''}${isRecommended ? ' is-recommended' : ''}`}
                        onClick={() => setSelectedId(template.definition.id)}
                      >
                        <div className="wf-picker-item-icon">
                          <Icon
                            name={
                              template.definition.id.includes('dotnet')
                                ? 'tools'
                                : template.definition.id.includes('python')
                                ? 'terminal'
                                : template.definition.id.includes('quick')
                                ? 'zap'
                                : 'git-branch'
                            }
                            size={15}
                          />
                        </div>
                        <div className="wf-picker-item-content">
                          <div className="wf-picker-item-head">
                            <span className="wf-picker-item-name">{template.definition.name}</span>
                            {isRecommended && (
                              <span
                                className="wf-picker-recommended-badge"
                                data-testid="wf-picker-recommended-badge"
                                title={recommendation?.rationale}
                              >
                                <Icon name="sparkles" size={11} /> Recommended
                              </span>
                            )}
                            <span
                              className={`wf-picker-source-badge ${
                                template.source === 'built-in' ? 'is-builtin' : 'is-marketplace'
                              }`}
                              title={template.source === 'built-in' ? 'Built-in template' : 'Marketplace add-on'}
                              aria-label={template.source === 'built-in' ? 'Built-in template' : 'Marketplace add-on'}
                            >
                              <Icon
                                name={template.source === 'built-in' ? 'shield' : 'package'}
                                size={13}
                              />
                            </span>
                          </div>
                          {template.definition.description && (
                            <p className="wf-picker-item-desc">{template.definition.description}</p>
                          )}
                          {isRecommended && recommendation?.rationale && (
                            <p className="wf-picker-item-rationale">{recommendation.rationale}</p>
                          )}
                          <div className="wf-picker-item-meta">
                            <span>{stageCount} stages</span>
                            {itemReady?.autoInstallable ? (
                              <span className="wf-picker-status is-available">
                                <Icon name="sparkles" size={11} /> Auto-installs
                              </span>
                            ) : itemReady && !itemReady.agentsOk ? (
                              <span className="wf-picker-status is-warning">
                                <Icon name="warning" size={11} /> Missing agents
                              </span>
                            ) : itemReady?.agentsOk ? (
                              <span className="wf-picker-status is-ready">
                                <Icon name="check" size={11} /> Ready
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Right Pane: Selected Template Preview & Guidance */}
          <div className="wf-picker-detail">
            {selectedTemplate && guidance ? (
                <div className="wf-picker-detail-content">
                  {/* Template Title & Overview */}
                  <div className="wf-picker-detail-head">
                    <div className="wf-picker-detail-title-row">
                      <h2>{selectedTemplate.definition.name}</h2>
                      <div className="wf-picker-detail-badges">
                        {guidance.stack && (
                          <span className="chip chip-muted">{guidance.stack}</span>
                        )}
                        <span
                          className={`wf-chip ${
                            selectedTemplate.source === 'built-in' ? 'wf-chip-builtin' : 'wf-chip-marketplace'
                          }`}
                        >
                          <Icon
                            name={selectedTemplate.source === 'built-in' ? 'shield' : 'package'}
                            size={12}
                          />
                          {selectedTemplate.source === 'built-in' ? 'Built-in template' : 'Marketplace add-on'}
                        </span>
                      </div>
                    </div>
                    {selectedTemplate.definition.description && (
                      <p className="wf-picker-detail-desc">{selectedTemplate.definition.description}</p>
                    )}
                  </div>

                  {/* "What it's good for" Callout Box */}
                  <div className="wf-guidance-card">
                    <div className="wf-guidance-card-title">
                      <Icon name="lightbulb" size={13} />
                      What it's good for
                    </div>
                    <p>{guidance.bestFor}</p>
                    {guidance.highlights.length > 0 && (
                      <ul className="wf-guidance-highlights">
                        {guidance.highlights.map((highlight, idx) => (
                          <li key={idx}>{highlight}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Visual Stage Sequence Preview */}
                  <div className="wf-flow-section">
                    <h4>Pipeline Stages ({stages.length})</h4>
                    <div className="wf-flow-steps">
                      {stages.map((step, idx) => {
                        const isApproval = step.type === 'approval';
                        return (
                          <div
                            key={step.id}
                            className={`wf-flow-step ${step.isGate ? 'is-gate' : ''} ${
                              isApproval ? 'is-approval' : ''
                            }`}
                          >
                            <div className="wf-flow-step-left">
                              <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', minWidth: '18px' }}>
                                {idx + 1}.
                              </span>
                              {step.type === 'agent-task' && <Icon name="robot" size={13} />}
                              {step.type === 'check' && <Icon name="terminal" size={13} />}
                              {step.type === 'join' && <Icon name="graph" size={13} />}
                              {step.type === 'approval' && <Icon name="shield" size={13} />}
                              {step.type === 'deployment' && <Icon name="rocket" size={13} />}
                              <strong>{step.name}</strong>
                              <span className="wf-flow-step-badge">
                                {step.isGate ? 'Gate owner' : step.type}
                              </span>
                            </div>
                            {step.detail && <span className="wf-flow-step-detail">{step.detail}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Requirements & Readiness */}
                  <div className="wf-meta-section">
                    <h4>Requirements & Readiness</h4>
                    <div className="wf-preview-meta-grid">
                      <div className="wf-preview-meta-box">
                        <strong>Enforced Policy Gates</strong>
                        {selectedTemplate.definition.nodes.filter(n => n.type === 'approval').length > 0 ? (
                          <ul>
                            {selectedTemplate.definition.nodes
                              .filter(n => n.type === 'approval')
                              .flatMap(a => (a.type === 'approval' ? a.requiredGates : []))
                              .map((gate, i) => (
                                <li key={i} style={{ textTransform: 'capitalize' }}>
                                  {gate} gate required before approval
                                </li>
                              ))}
                          </ul>
                        ) : (
                          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            No automated gates required.
                          </p>
                        )}
                      </div>

                      <div className="wf-preview-meta-box">
                        <strong>Agent & Skill Dependencies</strong>
                        {selectedReadiness?.dependencies && selectedReadiness.dependencies.length > 0 ? (
                          <ul className="wf-dep-list">
                            {selectedReadiness.dependencies.map(dep => {
                              const isInstalled = dep.status === 'installed';
                              const isAvailable = dep.status === 'available';
                              return (
                                <li key={dep.agentId} className={`wf-dep-item is-${dep.status}`}>
                                  <div className="wf-dep-header">
                                    <Icon
                                      name={isInstalled ? 'check' : isAvailable ? 'sparkles' : 'warning'}
                                      size={12}
                                    />
                                    <code>{dep.agentId}</code>
                                    <span className={`wf-dep-status-badge is-${dep.status}`}>
                                      {isInstalled ? 'Installed' : isAvailable ? 'Installs on selection' : 'Missing'}
                                    </span>
                                  </div>
                                  {dep.skillNames && dep.skillNames.length > 0 && (
                                    <div className="wf-dep-skills">
                                      Skills: {dep.skillNames.join(', ')}
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : selectedReadiness?.agentsOk ? (
                          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--success)' }}>
                            <Icon name="check" size={12} /> All required agents are installed and trusted.
                          </p>
                        ) : blockingReasons.length > 0 ? (
                          <div style={{ color: 'var(--warning)', fontSize: 'var(--text-xs)' }}>
                            <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Missing required agents:</p>
                            <ul>
                              {blockingReasons.map(([nodeId, reason]) => (
                                <li key={nodeId}>
                                  Stage "{nodeId}": {reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            No specialized agents required.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
            ) : (
              <div className="wf-picker-empty">
                <Icon name="git-branch" size={32} />
                <p>Select a template on the left to preview its pipeline stages and details.</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer Bar — a sibling of the sidebar/detail grid, not scoped to
            the right column, so it spans the whole dialog's width instead of
            leaving the sidebar's bottom edge without a matching strip. */}
        <div className="wf-picker-footer">
          <div className="wf-picker-footer-status">
            {selectedReadiness?.autoInstallable ? (
              <span style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <Icon name="sparkles" size={13} />
                Missing agent dependencies will be installed automatically upon selection.
              </span>
            ) : selectedReadiness && !selectedReadiness.agentsOk ? (
              <span style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Icon name="warning" size={13} />
                You can instantiate this template, but missing agents must be installed before running.
              </span>
            ) : null}
          </div>
          <div className="wf-picker-footer-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !selectedTemplate}
              onClick={() => selectedTemplate && use(selectedTemplate.definition.id)}
            >
              {busy ? 'Instantiating…' : selectedTemplate ? `Use "${selectedTemplate.definition.name}"` : 'Use template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

