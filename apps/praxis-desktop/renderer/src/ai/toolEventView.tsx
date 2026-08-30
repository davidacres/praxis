import type { AgentEventSummary } from '@praxis/core';

/** How the session console renders a tool event's body. */
export type ToolViewKind = 'shell' | 'write' | 'read' | 'list' | 'other';

/**
 * Prefers the structured `event.data.kind` from the host; falls back to parsing
 * the tool name out of the `summary` string so `data`-less events (older
 * sessions, some ACP/Copilot updates) still bucket sensibly.
 */
export function resolveToolView(event: AgentEventSummary): ToolViewKind {
  const kind = event.data?.kind;
  if (kind === 'shell' || kind === 'write' || kind === 'read' || kind === 'list') {
    return kind;
  }
  if (kind === 'search' || kind === 'tracker' || kind === 'other') {
    return 'other';
  }
  const name = (event.data?.toolName ?? event.summary.match(/tool:?\s*([\w-]+)/i)?.[1] ?? '').toLowerCase();
  if (name.includes('shell') || name.includes('bash') || name.includes('exec') || name.includes('run')) {
    return 'shell';
  }
  if (name.includes('write') || name.includes('edit') || name.includes('patch')) {
    return 'write';
  }
  if (name.includes('read') || name.includes('cat')) {
    return 'read';
  }
  if (name.includes('list') || name.includes('ls') || name.includes('dir')) {
    return 'list';
  }
  return 'other';
}

/** A compact one-line label for the arguments of a `tool_start` event. */
export function toolArgsLabel(event: AgentEventSummary): string {
  const summary = event.data?.argsSummary?.trim();
  if (summary) {
    return summary;
  }
  // `Running tool: run_shell` -> nothing useful; only surface a stray arg blob.
  const detail = event.detail?.trim();
  if (detail && !detail.startsWith('{') && detail.length <= 120) {
    return detail;
  }
  return '';
}

/** The tool name shown in the summary row. */
export function toolNameLabel(event: AgentEventSummary): string {
  return (
    event.data?.toolName?.trim() ||
    event.summary.match(/tool[:\s]+([\w-]+)/i)?.[1] ||
    event.summary
  );
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Classifies each line of a unified diff for red/green rendering. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  return text.replace(/\n$/, '').split('\n').map(line => {
    if (line.startsWith('@@')) {
      return { kind: 'hunk' as const, text: line };
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('Index: ')) {
      return { kind: 'meta' as const, text: line };
    }
    if (line.startsWith('+')) {
      return { kind: 'add' as const, text: line };
    }
    if (line.startsWith('-')) {
      return { kind: 'del' as const, text: line };
    }
    return { kind: 'context' as const, text: line };
  });
}

export function ToolDiff({ diff }: { diff: string }) {
  return (
    <pre className="session-tool-diff" data-testid="session-tool-diff">
      {parseUnifiedDiff(diff).map((line, index) => (
        <span key={index} className={`diff-${line.kind}`}>
          {line.text || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function ToolTerminal({ text }: { text: string }) {
  return (
    <pre className="session-tool-terminal" data-testid="session-tool-terminal">
      {text || '(no output)'}
    </pre>
  );
}
