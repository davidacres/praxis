import { useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { agentStateLabel } from '../../ai/aiSessionState';

export interface SessionTicketCardProps {
  session: AgentSessionRecord;
}

export function SessionTicketCard({ session }: SessionTicketCardProps) {
  const [collapsed, setCollapsed] = useState(false);

  const purpose = session.purpose;
  const brief = session.handoverBrief;
  const taskDef = session.taskDefinition;

  // Title & Ticket Identification
  const displayTitle =
    session.title?.trim() ||
    purpose?.title?.trim() ||
    taskDef?.goal?.split('\n')[0]?.trim() ||
    session.issueKey;

  const ticketKey =
    (purpose?.issueKey && !/^SESSION-/i.test(purpose.issueKey) ? purpose.issueKey : undefined) ||
    (session.linkedIssueKey && !/^SESSION-/i.test(session.linkedIssueKey) ? session.linkedIssueKey : undefined);

  const goal = purpose?.goal?.trim() || taskDef?.goal?.trim() || '';
  const scope = purpose?.scope?.trim() || taskDef?.scope?.trim();
  const definitionOfDone = purpose?.definitionOfDone?.trim() || taskDef?.definitionOfDone?.trim();

  const hasBrief = Boolean(brief && (brief.progress || brief.changes || brief.nextSteps || (brief.touchedFiles && brief.touchedFiles.length > 0)));

  return (
    <div className="session-ticket-card" data-testid="session-ticket-card">
      <div className="session-ticket-card__header">
        <div className="session-ticket-card__header-left">
          <span className="session-ticket-card__icon" aria-hidden="true">
            <Icon name={ticketKey ? 'check-square' : 'lightbulb'} size={16} />
          </span>
          <div className="session-ticket-card__title-group">
            {ticketKey && (
              <span className="session-ticket-card__key" data-testid="session-ticket-key">
                {ticketKey}
              </span>
            )}
            <h2 className="session-ticket-card__title" data-testid="session-ticket-title">
              {displayTitle}
            </h2>
          </div>
        </div>

        <div className="session-ticket-card__header-right">
          <span
            className={`easymode-status-dot is-${session.state === 'executing' ? 'running' : session.state === 'failed' ? 'failed' : 'complete'}`}
            aria-hidden="true"
          />
          <span className="session-ticket-card__status-text" data-testid="session-ticket-status">
            {agentStateLabel(session.state)}
          </span>
          <button
            type="button"
            className="session-ticket-card__toggle-btn"
            data-testid="session-ticket-toggle-btn"
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand ticket details' : 'Collapse ticket details'}
            onClick={() => setCollapsed(c => !c)}
          >
            <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="session-ticket-card__body">
          {/* Goal & Scope */}
          {goal && (
            <div className="session-ticket-card__section session-ticket-card__goal-section">
              <span className="session-ticket-card__label">Goal & Purpose</span>
              <p className="session-ticket-card__text" data-testid="session-ticket-goal">
                {goal}
              </p>
            </div>
          )}

          {scope && scope !== 'This issue and related files' && (
            <div className="session-ticket-card__meta-item">
              <span className="session-ticket-card__label">Scope:</span>
              <span className="session-ticket-card__meta-val">{scope}</span>
            </div>
          )}

          {definitionOfDone && definitionOfDone !== 'All acceptance criteria met, code compiles, tests pass' && (
            <div className="session-ticket-card__meta-item">
              <span className="session-ticket-card__label">Criteria:</span>
              <span className="session-ticket-card__meta-val">{definitionOfDone}</span>
            </div>
          )}

          {/* Outcome & Progress (Handover Brief) */}
          {hasBrief && (
            <div className="session-ticket-card__outcome-box" data-testid="session-ticket-outcome">
              <div className="session-ticket-card__outcome-head">
                <span className="session-ticket-card__outcome-title">
                  <Icon name="sparkles" size={13} />
                  <span>Outcome & Progress</span>
                </span>
                {brief?.updatedAt && (
                  <span className="session-ticket-card__outcome-time">
                    Updated {new Date(brief.updatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {brief?.progress && (
                <div className="session-ticket-card__outcome-field">
                  <p className="session-ticket-card__outcome-text" data-testid="session-ticket-progress">
                    {brief.progress}
                  </p>
                </div>
              )}

              {brief?.changes && brief.changes !== 'No file changes have been recorded.' && (
                <div className="session-ticket-card__outcome-field">
                  <span className="session-ticket-card__sublabel">Changes:</span>
                  <p className="session-ticket-card__outcome-text">{brief.changes}</p>
                </div>
              )}

              {brief?.touchedFiles && brief.touchedFiles.length > 0 && (
                <div className="session-ticket-card__outcome-field">
                  <span className="session-ticket-card__sublabel">Touched Files:</span>
                  <div className="session-ticket-card__files-chips" data-testid="session-ticket-files">
                    {brief.touchedFiles.map(filePath => (
                      <span key={filePath} className="session-ticket-file-chip" title={filePath}>
                        <Icon name="file" size={11} />
                        <span>{filePath.split('/').pop() || filePath}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {brief?.nextSteps && (
                <div className="session-ticket-card__outcome-field">
                  <span className="session-ticket-card__sublabel">Next Steps:</span>
                  <p className="session-ticket-card__outcome-text">{brief.nextSteps}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
