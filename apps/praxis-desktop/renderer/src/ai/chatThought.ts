import type { AgentEventSummary } from '@praxis/core';

/**
 * Thought grouping for the session chat.
 *
 * The agent emits one `message` event per model round-trip, so a single turn
 * that uses tools produces several assistant messages — and each one may carry
 * the reasoning accumulated so far. Rendering that verbatim gives a stack of
 * near-identical "Thought process" cards that reprint each other's text.
 *
 * A thought run is a maximal span of consecutive assistant messages that carry
 * reasoning. It becomes one collapsible caption at the head of the run, with
 * the reasoning merged once.
 */
export interface ThoughtRun {
  /** Index of the first event in the run — where the caption renders. */
  startIndex: number;
  /** Indices of every event contributing reasoning to this run. */
  memberIndices: number[];
  /** Reasoning pieces in order, duplicates and cumulative overlaps removed. */
  steps: string[];
}

function isAssistantMessage(event: AgentEventSummary): boolean {
  return event.type === 'message';
}

/**
 * Fold a reasoning piece into the steps collected so far.
 *
 * Providers that accumulate per round-trip send a string that already contains
 * every earlier piece, so a naive join repeats the opening paragraph over and
 * over. Three cases:
 *   - already a prefix of what we have → nothing new
 *   - extends what we have → replace (it supersedes the shorter prefix)
 *   - genuinely new text → append as its own step
 */
export function mergeReasoningStep(steps: string[], incoming: string): string[] {
  const text = incoming.trim();
  if (!text) return steps;

  const last = steps[steps.length - 1];
  if (last !== undefined) {
    if (last.startsWith(text)) return steps;
    if (text.startsWith(last)) return [...steps.slice(0, -1), text];
  }

  return [...steps, text];
}

export function collectThoughtRuns(
  events: readonly AgentEventSummary[]
): ThoughtRun[] {
  const runs: ThoughtRun[] = [];
  let current: ThoughtRun | undefined;

  events.forEach((event, index) => {
    if (!isAssistantMessage(event)) {
      // Any non-assistant event ends the run, so a user message always gets a
      // fresh thought block rather than inheriting the previous turn's.
      current = undefined;
      return;
    }

    const reasoning = event.reasoning?.trim();
    if (!reasoning) {
      // An assistant message with no reasoning does not break a run — a turn
      // can interleave a bare text reply between two reasoning steps.
      return;
    }

    if (!current) {
      current = { startIndex: index, memberIndices: [], steps: [] };
      runs.push(current);
    }

    current.memberIndices.push(index);
    current.steps = mergeReasoningStep(current.steps, reasoning);
  });

  return runs;
}

/** The run that starts at `index`, if any — used to render one caption per run. */
export function thoughtRunStartingAt(
  runs: readonly ThoughtRun[],
  index: number
): ThoughtRun | undefined {
  let starts = startCache.get(runs);
  if (!starts) {
    starts = new Map(runs.map(run => [run.startIndex, run]));
    startCache.set(runs, starts);
  }
  return starts.get(index);
}

// Looked up once per rendered event, so index the runs once per array.
const startCache = new WeakMap<readonly ThoughtRun[], Map<number, ThoughtRun>>();

/** `1m 20s` / `16s` — the duration half of a caption. */
export function formatCaptionDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds === 0) return '<1s';
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/** `4m 2s · 3 tool calls`, from whichever of the two the turn reported. */
export function captionText(durationMs: number | undefined, toolCalls: number | undefined): string {
  const parts: string[] = [];
  if (durationMs && durationMs > 0) parts.push(formatCaptionDuration(durationMs));
  if (toolCalls && toolCalls > 0) parts.push(`${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`);
  return parts.join(' · ');
}

/**
 * Caption for a thought run. The host stamps each round-trip's message with
 * the turn's running duration and tool names, so the run's last event already
 * describes the whole turn; adding the earlier events up would double-count.
 */
export function thoughtCaption(
  run: ThoughtRun,
  events: readonly AgentEventSummary[],
  toolCallsAt?: (event: AgentEventSummary) => number | undefined
): string {
  const last = events[run.memberIndices[run.memberIndices.length - 1]];
  const toolCalls = (last && toolCallsAt?.(last)) ?? last?.toolNames?.length;
  return captionText(last?.durationMs, toolCalls);
}
