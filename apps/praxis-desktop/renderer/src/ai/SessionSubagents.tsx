import { Icon } from '../ui/Icon';
import { agentStateBadgeClass, agentStateLabel, isTerminalAgentState } from './aiSessionState';
import { formatSubagentTokens, type SubagentItem } from './sessionNav';

export interface SessionSubagentsTabProps {
  subagents: SubagentItem[];
  onSelectSession?: (issueKey: string) => void;
}

export function SessionSubagentsTab({ subagents, onSelectSession }: SessionSubagentsTabProps) {
  if (subagents.length === 0) {
    return (
      <div className="empty-state" data-testid="session-subagents-empty">
        <Icon name="robot" size={26} />
        <span>No subagents used by this agent.</span>
        <p className="hint">
          When this agent delegates tasks to subagents or executes workflow stages, they will appear here with their status, model, and token usage.
        </p>
      </div>
    );
  }

  const completed = subagents.filter(s => s.status === 'completed').length;
  const active = subagents.filter(s => !isTerminalAgentState(s.status)).length;
  const failed = subagents.filter(s => s.status === 'failed').length;

  const totalTokens = subagents.reduce((sum, s) => {
    if (s.tokenUsage?.totalTokens) return sum + s.tokenUsage.totalTokens;
    if (s.tokenUsage) return sum + (s.tokenUsage.inputTokens || 0) + (s.tokenUsage.outputTokens || 0);
    return sum;
  }, 0);

  const models = Array.from(new Set(subagents.map(s => s.model).filter(Boolean)));

  return (
    <div className="session-subagents-tab" data-testid="session-subagents-tab">
      <div className="session-subagents-metrics" data-testid="session-subagents-metrics">
        <div className="session-subagents-metric">
          <span className="rail-sub">Subagents</span>
          <strong>{subagents.length}</strong>
        </div>
        <div className="session-subagents-metric">
          <span className="rail-sub">Status</span>
          <span className="session-subagents-status-summary">
            {completed > 0 && <span className="chip chip-success">{completed} completed</span>}
            {active > 0 && <span className="chip chip-warn">{active} active</span>}
            {failed > 0 && <span className="chip chip-danger">{failed} failed</span>}
            {completed === 0 && active === 0 && failed === 0 && (
              <span className="chip chip-muted">{subagents.length} total</span>
            )}
          </span>
        </div>
        {totalTokens > 0 && (
          <div className="session-subagents-metric">
            <span className="rail-sub">Total Token Use</span>
            <strong data-testid="subagents-total-tokens">{formatSubagentTokens({ totalTokens })}</strong>
          </div>
        )}
        {models.length > 0 && (
          <div className="session-subagents-metric">
            <span className="rail-sub">Models ({models.length})</span>
            <div className="session-subagents-models-list">
              {models.map(m => (
                <span key={m} className="chip chip-muted" data-testid="subagents-model-badge">{m}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="session-subagents-cards-list" data-testid="session-subagents-cards-list">
        {subagents.map(subagent => (
          <div key={subagent.id} className="session-subagent-card" data-testid="session-subagent-card">
            <div className="session-subagent-card-header">
              <div className="session-subagent-card-title-group">
                <span className={agentStateBadgeClass(subagent.status)} data-testid="subagent-status-badge">
                  {agentStateLabel(subagent.status)}
                </span>
                <strong className="session-subagent-card-title" title={subagent.title}>
                  {subagent.title}
                </strong>
              </div>
              {subagent.sessionKey && onSelectSession && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost session-subagent-card-open"
                  data-testid="subagent-open-session-btn"
                  onClick={() => onSelectSession(subagent.sessionKey!)}
                  title={`Open session ${subagent.sessionKey}`}
                >
                  <Icon name="external-link" size={12} />
                  <span>Open</span>
                </button>
              )}
            </div>

            <div className="session-subagent-card-meta">
              <div className="session-subagent-pill session-subagent-model-pill" data-testid="subagent-model">
                <Icon name="robot" size={11} />
                <span>{subagent.model}</span>
              </div>
              <div className="session-subagent-pill session-subagent-tokens-pill" data-testid="subagent-tokens">
                <Icon name="zap" size={11} />
                <span>{formatSubagentTokens(subagent.tokenUsage, subagent.cost)}</span>
              </div>
              {subagent.role && (
                <div className="session-subagent-pill session-subagent-role-pill">
                  <span>{subagent.role}</span>
                </div>
              )}
              {subagent.elapsed && (
                <div className="session-subagent-pill session-subagent-elapsed-pill">
                  <Icon name="clock" size={11} />
                  <span>{subagent.elapsed}</span>
                </div>
              )}
              {subagent.stepCount !== undefined && subagent.stepCount > 0 && (
                <div className="session-subagent-pill session-subagent-steps-pill">
                  <span>{subagent.stepCount} {subagent.stepCount === 1 ? 'step' : 'steps'}</span>
                </div>
              )}
            </div>

            {subagent.tokenUsage && ((subagent.tokenUsage.inputTokens ?? 0) > 0 || (subagent.tokenUsage.outputTokens ?? 0) > 0) && (
              <div className="session-subagent-token-details">
                <span className="rail-sub">Input: {(subagent.tokenUsage.inputTokens ?? 0).toLocaleString()}</span>
                <span className="rail-sub">·</span>
                <span className="rail-sub">Output: {(subagent.tokenUsage.outputTokens ?? 0).toLocaleString()}</span>
                {(subagent.tokenUsage.cachedInputTokens ?? 0) > 0 && (
                  <>
                    <span className="rail-sub">·</span>
                    <span className="rail-sub">Cache: {subagent.tokenUsage.cachedInputTokens?.toLocaleString()}</span>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface SessionSubagentsSummaryBlockProps {
  subagents: SubagentItem[];
  onViewAll: () => void;
  onSelectSession?: (issueKey: string) => void;
}

export function SessionSubagentsSummaryBlock({
  subagents,
  onViewAll,
  onSelectSession
}: SessionSubagentsSummaryBlockProps) {
  if (subagents.length === 0) return null;

  return (
    <div className="agent-runtime-block session-subagents-summary-block" data-testid="session-subagents-summary-block">
      <div className="session-subagents-summary-header">
        <span className="rail-sub">Subagents ({subagents.length})</span>
        <button
          type="button"
          className="btn-link rail-sub session-subagents-view-all"
          data-testid="session-subagents-view-all"
          onClick={onViewAll}
        >
          View all
        </button>
      </div>
      <div className="session-subagents-compact-list" data-testid="session-subagents-compact-list">
        {subagents.map(subagent => (
          <div
            key={subagent.id}
            className={`session-subagent-compact-row${subagent.sessionKey ? ' is-clickable' : ''}`}
            data-testid="session-subagent-compact-row"
            onClick={() => subagent.sessionKey && onSelectSession?.(subagent.sessionKey)}
          >
            <span className={agentStateBadgeClass(subagent.status)} data-testid="subagent-status-badge">
              {agentStateLabel(subagent.status)}
            </span>
            <div className="session-subagent-compact-body">
              <strong className="session-subagent-compact-title" title={subagent.title}>
                {subagent.title}
              </strong>
              <div className="session-subagent-compact-meta">
                <span className="session-subagent-model-chip" data-testid="subagent-model">{subagent.model}</span>
                <span className="session-subagent-tokens-chip" data-testid="subagent-tokens">
                  {formatSubagentTokens(subagent.tokenUsage, subagent.cost)}
                </span>
                {subagent.elapsed && <span className="rail-sub">· {subagent.elapsed}</span>}
              </div>
            </div>
            {subagent.sessionKey && (
              <span className="session-subagent-row-arrow" aria-hidden="true">
                <Icon name="arrow-right" size={11} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
