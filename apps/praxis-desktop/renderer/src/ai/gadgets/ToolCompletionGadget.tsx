import type { AgentEventSummary, AgentToolFileChange } from '@praxis/core';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { ToolDiff } from '../toolEventView';

interface ToolCompletionItem {
  key: string;
  name: string;
  groupKey: string;
  groupLabel: string;
  eventTimestamp: string;
  startedAt?: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed';
  argsSummary?: string;
  detail?: string;
  diff?: string;
  fileChanges?: AgentToolFileChange[];
}

interface ToolCompletionGroup {
  key: string;
  label: string;
  items: ToolCompletionItem[];
}

function toolGroup(name: string, kind?: string): { key: string; label: string } {
  const lower = `${kind ?? ''} ${name}`.toLowerCase();
  if (kind === 'shell' || /shell|bash|exec|terminal|command|run/.test(lower)) {
    return { key: 'shell', label: 'Terminal commands' };
  }
  if (kind === 'write' || /write|edit|patch|delete|move|rename/.test(lower)) {
    return { key: 'write', label: 'File changes' };
  }
  if (kind === 'read' || /read|cat|open|file/.test(lower)) {
    return { key: 'read', label: 'File reads' };
  }
  if (kind === 'list' || kind === 'search' || /list|ls|dir|search|find|grep|glob/.test(lower)) {
    return { key: 'browse', label: 'File and project browsing' };
  }
  if (kind === 'tracker' || /ticket|issue|transition|comment|tracker/.test(lower)) {
    return { key: 'tracker', label: 'Project updates' };
  }
  return { key: `tool:${name.toLowerCase()}`, label: name };
}

function toolName(event: AgentEventSummary): string {
  return event.data?.toolName?.trim()
    || event.summary.match(/(?:running tool|tool (?:completed|failed)|tool):?\s*([\w.-]+)/i)?.[1]
    || event.summary;
}

function formatDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const milliseconds = end - start;
  if (milliseconds < 1000) return '<1s';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: ToolCompletionItem['status']): string {
  return status === 'running' ? 'Running' : status === 'failed' ? 'Failed' : 'Completed';
}

function editEventTimestamp(item: ToolCompletionItem): string {
  // File-change undo is keyed to the completion event in the session store;
  // the start timestamp is only the stable identity of the grouped run.
  return item.completedAt ?? item.eventTimestamp;
}

function itemKey(event: AgentEventSummary, index: number): string {
  return event.data?.callId ? `call:${event.data.callId}` : `fallback:${index}`;
}

/**
 * Combines the start and completion events for each logical tool call.
 *
 * `callId` is present for the modern provider hosts. Older persisted sessions
 * may not have it, so unmatched starts are paired by tool name and a
 * completion without a start remains visible as its own completed item.
 */
export function groupToolCompletions(events: readonly AgentEventSummary[]): ToolCompletionItem[] {
  const items: ToolCompletionItem[] = [];
  const byCallId = new Map<string, ToolCompletionItem>();
  const openByName = new Map<string, ToolCompletionItem[]>();

  events.forEach((event, index) => {
    if (event.type !== 'tool_start' && event.type !== 'tool_complete') return;
    const name = toolName(event);
    const callId = event.data?.callId;

    if (event.type === 'tool_start') {
      const group = toolGroup(name, event.data?.kind);
      const item: ToolCompletionItem = {
        key: itemKey(event, index),
        name,
        groupKey: group.key,
        groupLabel: group.label,
        eventTimestamp: event.timestamp,
        startedAt: event.timestamp,
        status: 'running',
        argsSummary: event.data?.argsSummary?.trim()
      };
      items.push(item);
      if (callId) byCallId.set(callId, item);
      else {
        const open = openByName.get(name);
        if (open) open.push(item);
        else openByName.set(name, [item]);
      }
      return;
    }

    let item = callId ? byCallId.get(callId) : undefined;
    if (!item && !callId) {
      const open = openByName.get(name) ?? [];
      for (let candidateIndex = open.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        if (open[candidateIndex].status === 'running') {
          item = open[candidateIndex];
          break;
        }
      }
    }
    if (item) {
      // A duplicate completion update should settle the existing item, not
      // add another row to the activity log.
      item.completedAt = event.timestamp;
      item.status = event.data?.ok === false || /^tool failed/i.test(event.summary) ? 'failed' : 'completed';
      item.detail = event.data?.output ?? event.detail;
      item.diff = event.data?.diff;
      item.fileChanges = event.data?.fileChanges?.filter(change => change.diff);
      if (!item.argsSummary) item.argsSummary = event.data?.argsSummary?.trim();
      return;
    }

    const group = toolGroup(name, event.data?.kind);
    items.push({
      key: itemKey(event, index),
      name,
      groupKey: group.key,
      groupLabel: group.label,
      eventTimestamp: event.timestamp,
      completedAt: event.timestamp,
      status: event.data?.ok === false || /^tool failed/i.test(event.summary) ? 'failed' : 'completed',
      detail: event.data?.output ?? event.detail,
      diff: event.data?.diff,
      fileChanges: event.data?.fileChanges?.filter(change => change.diff)
    });
  });

  return items;
}

function defaultItemKey(items: readonly ToolCompletionItem[]): string | undefined {
  return items.find(item => item.status === 'failed')?.key ?? items.at(-1)?.key;
}

function groupItems(items: readonly ToolCompletionItem[]): ToolCompletionGroup[] {
  const groups = new Map<string, ToolCompletionGroup>();
  for (const item of items) {
    const existing = groups.get(item.groupKey);
    if (existing) existing.items.push(item);
    else groups.set(item.groupKey, { key: item.groupKey, label: item.groupLabel, items: [item] });
  }
  return [...groups.values()];
}

/**
 * True when the args summary says nothing the tool name has not already said.
 *
 * Hosts vary: some send `argsSummary: "Edit sum.js"` for a tool already named
 * "Edit sum.js". Showing both is a line of pure repetition.
 */
function redundantArgs(item: ToolCompletionItem): boolean {
  const args = item.argsSummary?.trim().toLowerCase();
  if (!args) return true;
  const name = item.name.trim().toLowerCase();
  return args === name || name.includes(args) || args.includes(name);
}

function ToolCompletionDetail({
  item,
  onUndo,
  canUndo,
  undoingKey,
  undoDisabled
}: {
  item: ToolCompletionItem;
  onUndo?: (eventTimestamp: string, path: string) => void;
  canUndo?: (eventTimestamp: string, path: string) => boolean;
  undoingKey?: string;
  undoDisabled?: boolean;
}) {
  // The detail renders directly beneath the run it belongs to, which is already
  // highlighted, so it does not repeat that run's name, status or duration.
  // It used to sit detached at the foot of the gadget and restate all three —
  // barely noticeable across the full transcript width, but in the inspector's
  // rail it was most of what you could see.
  const args = redundantArgs(item) ? undefined : item.argsSummary;
  if (!args && !item.detail && !item.diff && !item.fileChanges?.length) return null;

  return (
    <div className="tool-completion-selected-detail" data-testid="tool-completion-selected-detail">
      {args && <code className="tool-completion-item-args">{args}</code>}
      {item.fileChanges?.map(change => {
        const eventTimestamp = editEventTimestamp(item);
        const undoKey = `${eventTimestamp}|${change.path}`;
        const undoAllowed = Boolean(onUndo && canUndo?.(eventTimestamp, change.path));
        return (
          <div className="tool-completion-file" key={change.path}>
            <div className="tool-completion-file-head">
              <code>{change.path}</code>
              {undoAllowed && (
                <button
                  type="button"
                  className="btn-quiet session-tool-undo"
                  data-testid="session-tool-undo"
                  disabled={undoDisabled || Boolean(undoingKey)}
                  title="Restore this file to what it was before this edit"
                  onClick={() => onUndo?.(eventTimestamp, change.path)}
                >
                  {undoingKey === undoKey ? 'Undoing…' : 'Undo edit'}
                </button>
              )}
            </div>
            <ToolDiff diff={change.diff ?? ''} />
          </div>
        );
      })}
      {!item.fileChanges?.length && item.diff && <ToolDiff diff={item.diff} />}
      {!item.fileChanges?.length && !item.diff && item.detail && <pre>{item.detail}</pre>}
    </div>
  );
}

export interface ToolCompletionGadgetProps {
  events: readonly AgentEventSummary[];
  onUndo?: (eventTimestamp: string, path: string) => void;
  canUndo?: (eventTimestamp: string, path: string) => boolean;
  undoingKey?: string;
  undoDisabled?: boolean;
}

export function ToolCompletionGadget({ events, onUndo, canUndo, undoingKey, undoDisabled }: ToolCompletionGadgetProps) {
  const items = useMemo(() => groupToolCompletions(events), [events]);
  const groups = useMemo(() => groupItems(items), [items]);
  const [selectedItemKey, setSelectedItemKey] = useState(() => defaultItemKey(items));

  useEffect(() => {
    if (!items.some(item => item.key === selectedItemKey)) {
      setSelectedItemKey(defaultItemKey(items));
    }
  }, [items, selectedItemKey]);

  if (items.length === 0) return null;

  const completed = items.filter(item => item.status === 'completed').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const running = items.filter(item => item.status === 'running').length;
  const selectedItem = items.find(item => item.key === selectedItemKey) ?? items.at(-1);

  return (
    <section className="tool-completion-gadget" data-testid="tool-completion-gadget" aria-label="Tool completions">
      <div className="tool-completion-gadget-header">
        <Icon name="tools" size={13} />
        <strong>Tool activity</strong>
        <span className="tool-completion-gadget-count">
          {items.length} {items.length === 1 ? 'run' : 'runs'}
        </span>
        {running > 0 && <span className="tool-completion-gadget-state is-running">{running} running</span>}
        {failed > 0 && <span className="tool-completion-gadget-state is-failed">{failed} failed</span>}
        {running === 0 && failed === 0 && <span className="tool-completion-gadget-state is-completed">{completed} completed</span>}
      </div>
      <div className="tool-completion-gadget-list">
        {groups.map(group => {
          const groupFailed = group.items.filter(item => item.status === 'failed').length;
          const groupCompleted = group.items.filter(item => item.status === 'completed').length;
          return (
            <details
              className="tool-completion-group"
              key={group.key}
              data-testid="tool-completion-group"
              open={group.items.some(item => item.key === selectedItem?.key)}
            >
              <summary>
                <Icon name={groupFailed > 0 ? 'warning' : 'tools'} size={12} />
                <strong>{group.label}</strong>
                {groups.length > 1 && (
                  <>
                    <span className="tool-completion-group-count">{group.items.length} {group.items.length === 1 ? 'run' : 'runs'}</span>
                    {groupFailed > 0 && <span className="tool-completion-item-status is-failed">{groupFailed} failed</span>}
                    {groupFailed === 0 && <span className="tool-completion-item-status is-completed">{groupCompleted} completed</span>}
                  </>
                )}
              </summary>
              <div className="tool-completion-run-list">
                {group.items.map(item => (
                  <Fragment key={item.key}>
                    <button
                      type="button"
                      className="tool-completion-run"
                      data-testid="tool-completion-item"
                      aria-pressed={item.key === selectedItem?.key}
                      onClick={() => setSelectedItemKey(item.key)}
                    >
                      <Icon name={item.status === 'failed' ? 'warning' : item.status === 'running' ? 'zap' : 'check-square'} size={12} />
                      <code>{item.name}</code>
                      <span className={`tool-completion-item-status is-${item.status}`}>{statusLabel(item.status)}</span>
                      {formatDuration(item.startedAt, item.completedAt) && <span className="tool-completion-item-duration">{formatDuration(item.startedAt, item.completedAt)}</span>}
                    </button>
                    {item.key === selectedItem?.key && (
                      <ToolCompletionDetail
                        item={item}
                        onUndo={onUndo}
                        canUndo={canUndo}
                        undoingKey={undoingKey}
                        undoDisabled={undoDisabled}
                      />
                    )}
                  </Fragment>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
