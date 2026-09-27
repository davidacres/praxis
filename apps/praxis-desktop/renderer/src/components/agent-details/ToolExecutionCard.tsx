import { useState } from 'react';
import type { AgentToolFileChange } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { ToolDiff } from '../../ai/toolEventView';

export interface ToolExecutionCardProps {
  toolName: string;
  kind?: string;
  argsSummary?: string;
  args?: Record<string, unknown> | string;
  result?: string;
  diff?: string;
  fileChanges?: AgentToolFileChange[];
  duration?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  onUndo?: (timestamp: string, path: string) => void;
  canUndo?: (timestamp: string, path: string) => boolean;
  undoDisabled?: boolean;
  undoingKey?: string;
  defaultExpanded?: boolean;
}

function toolIconName(name: string, kind?: string): 'terminal' | 'pencil' | 'file' | 'search' | 'tools' {
  const lower = `${kind ?? ''} ${name}`.toLowerCase();
  if (kind === 'shell' || /shell|bash|exec|terminal|command|run/.test(lower)) {
    return 'terminal';
  }
  if (kind === 'write' || /write|edit|patch|create|delete|move/.test(lower)) {
    return 'pencil';
  }
  if (kind === 'read' || /read|cat|open|view/.test(lower)) {
    return 'file';
  }
  if (kind === 'list' || kind === 'search' || /list|ls|dir|search|find|grep/.test(lower)) {
    return 'search';
  }
  return 'tools';
}

export function ToolExecutionCard({
  toolName,
  kind,
  argsSummary,
  args,
  result,
  diff,
  fileChanges,
  duration,
  status,
  completedAt,
  onUndo,
  canUndo,
  undoDisabled,
  undoingKey,
  defaultExpanded = false
}: ToolExecutionCardProps) {
  const [isOpen, setIsOpen] = useState(defaultExpanded || status === 'failed' || status === 'running');

  const formattedArgs = typeof args === 'string'
    ? args
    : args && Object.keys(args).length > 0
      ? JSON.stringify(args, null, 2)
      : undefined;

  const hasContent = Boolean(
    formattedArgs ||
    argsSummary ||
    result ||
    diff ||
    (fileChanges && fileChanges.length > 0)
  );

  const eventTimestamp = completedAt || '';

  return (
    <div
      className={`tool-execution-card is-${status} ${isOpen ? 'is-open' : ''}`}
      data-testid="tool-execution-card"
    >
      <div
        className="tool-execution-card__header"
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => hasContent && setIsOpen(!isOpen)}
        onKeyDown={e => {
          if ((e.key === 'Enter' || e.key === ' ') && hasContent) {
            e.preventDefault();
            setIsOpen(!isOpen);
          }
        }}
      >
        <span className="tool-execution-card__icon" aria-hidden="true">
          <Icon name={toolIconName(toolName, kind)} size={14} />
        </span>

        <span className="tool-execution-card__name" title={toolName}>
          {toolName}
        </span>

        {argsSummary && (
          <span className="tool-execution-card__summary" title={argsSummary}>
            {argsSummary}
          </span>
        )}

        <div className="tool-execution-card__meta">
          {duration && (
            <span className="tool-execution-card__duration" data-testid="tool-duration">
              {duration}
            </span>
          )}

          <span
            className={`tool-execution-card__status-badge status-${status}`}
            data-testid={`tool-status-${status}`}
            title={`Status: ${status}`}
          >
            {status === 'running' && <span className="easymode-status-dot is-running" />}
            {status === 'completed' && <Icon name="check" size={12} />}
            {status === 'failed' && <Icon name="close" size={12} />}
            <span>{status}</span>
          </span>

          {hasContent && (
            <span className="tool-execution-card__chevron" aria-hidden="true">
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            </span>
          )}
        </div>
      </div>

      {isOpen && hasContent && (
        <div className="tool-execution-card__body" data-testid="tool-execution-body">
          {formattedArgs && (
            <div className="tool-execution-card__section">
              <div className="tool-execution-card__section-title">Arguments</div>
              <pre className="tool-execution-card__code" data-testid="tool-args">
                {formattedArgs}
              </pre>
            </div>
          )}

          {fileChanges && fileChanges.length > 0 && (
            <div className="tool-execution-card__section">
              <div className="tool-execution-card__section-title">File Changes</div>
              {fileChanges.map(change => {
                const undoKey = `${eventTimestamp}|${change.path}`;
                const undoAllowed = Boolean(onUndo && canUndo?.(eventTimestamp, change.path));
                return (
                  <div className="tool-execution-card__file-change" key={change.path} data-testid="tool-file-change">
                    <div className="tool-execution-card__file-head">
                      <code className="tool-execution-card__file-path">{change.path}</code>
                      {undoAllowed && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost tool-undo-btn"
                          data-testid="session-tool-undo"
                          disabled={undoDisabled || Boolean(undoingKey)}
                          title="Restore this file to what it was before this edit"
                          onClick={e => {
                            e.stopPropagation();
                            onUndo?.(eventTimestamp, change.path);
                          }}
                        >
                          {undoingKey === undoKey ? 'Undoing…' : 'Undo edit'}
                        </button>
                      )}
                    </div>
                    {change.diff && <ToolDiff diff={change.diff} />}
                  </div>
                );
              })}
            </div>
          )}

          {!fileChanges?.length && diff && (
            <div className="tool-execution-card__section">
              <div className="tool-execution-card__section-title">Diff</div>
              <ToolDiff diff={diff} />
            </div>
          )}

          {result && (
            <div className="tool-execution-card__section">
              <div className="tool-execution-card__section-title">Output</div>
              <pre className="tool-execution-card__output" data-testid="tool-output">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
