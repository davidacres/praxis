import type { AgentMessageSegment } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import type { ToolCallRow } from './chatToolCalls';
import './sessionPresentation.css';

/** Progress and tools belong to the work history, independent of optional reasoning. */
export function SessionActivityBlock({ segments = [], tools = [], streaming = false }: {
  segments?: readonly AgentMessageSegment[];
  tools?: readonly ToolCallRow[];
  streaming?: boolean;
}) {
  const rows = [
    ...segments.map((segment, index) => ({ at: segment.timestamp, key: `message-${segment.messageId ?? index}`, segment, tool: undefined as ToolCallRow | undefined })),
    ...tools.map((tool, index) => ({ at: tool.timestamp ?? '', key: `tool-${tool.callId ?? index}`, segment: undefined as AgentMessageSegment | undefined, tool }))
  ].sort((a,b) => a.at.localeCompare(b.at));
  if (!rows.length) return null;
  return <details className="session-chat-activity" data-testid="session-work-activity" open={streaming || undefined}>
    <summary className="session-chat-activity-summary">
      <Icon name="radio-tower" size={11} />
      <span>Activity</span>
      {tools.length > 0 && <span className="hint">{tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>}
    </summary>
    <ol className="session-work-history">
      {rows.map(row => <li key={row.key}>
        {row.segment && <div data-provider-message-id={row.segment.messageId ?? undefined} data-message-phase={row.segment.phase ?? undefined}>
          <Markdown text={row.segment.text} testId="session-commentary" />
        </div>}
        {row.tool && <details className="session-work-tool" data-testid="session-work-tool">
          <summary><Icon name={row.tool.ok === false ? 'close' : row.tool.ok ? 'check' : 'tools'} size={12} />
            <span>{row.tool.detail || row.tool.name}</span>
            <small>{row.tool.ok === undefined ? 'Running' : row.tool.ok ? 'Completed' : 'Failed'}</small>
          </summary>
          <dl><dt>Tool</dt><dd>{row.tool.name}</dd></dl>
          {row.tool.locations?.map(location => <div className="session-work-location" key={`${location.path}:${location.line ?? ''}`}>{location.path}{location.line ? `:${location.line}` : ''}</div>)}
          {row.tool.args && <details><summary>Arguments</summary><pre>{JSON.stringify(row.tool.args, null, 2)}</pre></details>}
          {row.tool.output !== undefined ? <pre>{row.tool.output}</pre> : <p className="hint">Output not supplied by provider.</p>}
        </details>}
      </li>)}
    </ol>
  </details>;
}
