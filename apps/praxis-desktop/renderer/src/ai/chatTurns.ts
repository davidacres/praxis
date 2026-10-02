import type { AgentEventSummary } from '@praxis/core';

/**
 * Turn grouping for the session chat.
 *
 * The agent emits one `message` event per model round-trip, so a turn that
 * uses tools produces several assistant events. Rendered one-per-event that
 * gives a stack of separate cards — each with its own header, timestamp, copy
 * button and telemetry bar — where most of them are the agent narrating its
 * own tool use ("Let me find the actual details pane summary.") rather than
 * anything addressed to the user.
 *
 * A message run is a maximal span of consecutive assistant events. It renders
 * as one card. Text the run contributes to the conversation stays in the
 * transcript; text that reads as self-narration is folded into the thought
 * block instead, where it belongs and where it already partly appears.
 */

/** One card's worth of assistant text, plus the telemetry summed over the run. */
export interface MessageRun {
  /** Index of the first event in the run — where the card renders. */
  startIndex: number;
  /** Indices of every event contributing to this run. */
  memberIndices: number[];
  /** Attribution of the card, taken from the first event in the run. */
  speaker?: AgentEventSummary['speaker'];
  /** Text addressed to the user, one entry per contributing round-trip. */
  parts: string[];
  /** Round-trips that read as narration, folded into the thought block. */
  narration: string[];
  /**
   * Telemetry for the turn, shown once. The agent host stamps every
   * round-trip's `message` with the turn's running totals, so the last event
   * already holds the whole turn — summing would count each round-trip again.
   */
  durationMs?: number;
  tokenUsage?: Record<string, number>;
  cost?: { amount: number; currency: string };
  modelId?: string;
  toolNames: string[];
  /** Tool calls made so far in the turn, when the caller can count them. */
  toolCalls?: number;
}

function isAssistantMessage(event: AgentEventSummary): boolean {
  return event.type === 'message';
}

/**
 * Whether a round-trip reads as the agent narrating its own next step.
 *
 * Deliberately narrow. Anything with structure a user might be reading — a
 * code fence, a list, a heading, a table — is never narration, however it
 * opens, and anything long enough to carry a finding is left in the
 * transcript. A false negative costs a line of preamble in the transcript; a
 * false positive would hide a real reply, which is far worse. So this only
 * claims the obviously-self-addressed case.
 */
export function isNarration(text: string): boolean {
  const body = text.trim();
  if (!canFoldIntoThought(body)) return false;

  const opener = /^(let me|i(?:'| wi)?ll|now i|next,? i|going to)\b/i;
  if (!opener.test(body)) return false;

  // "I'll check the diff, then summarise what I found and flag the risks" is
  // doing real work. Narration names an action and stops; a second clause —
  // whether it is a new sentence or just a comma — tends to add content, so
  // the guard counts both and claims only the single-clause case.
  const clauses = body.split(/(?<=[.!?])\s+|[,;:]\s+|\s+-\s+/);
  if (clauses.length > 1) return false;

  return /^(let me|i(?:'| wi)?ll|now i|next,? i|going to)\s+\w+/i.test(body);
}

/**
 * Whether a message is short, plain prose — the only kind that is safe to
 * tuck away. Anything with structure a user might be reading (a code fence, a
 * list, a heading, a table), any question to the user, and anything long
 * enough to carry a finding stays in the transcript.
 */
export function canFoldIntoThought(text: string): boolean {
  const body = text.trim();
  if (!body || body.length > 240) return false;
  if (/```|^\s*[-*+]\s|^\s*\d+\.\s|^#{1,6}\s|\|.*\||^\s*>/m.test(body)) return false;
  return !body.includes('?');
}

/**
 * Merge consecutive assistant events into one card per turn.
 *
 * `visibleText` is the caller's text extractor (gadget fences and provider
 * metadata already stripped), so the narration test runs on what the user
 * would actually see.
 */
export function collectMessageRuns(
  events: readonly AgentEventSummary[],
  visibleText: (event: AgentEventSummary) => string,
  hooks: {
    /** Tool calls made so far in the event's turn. */
    toolCallsAt?: (event: AgentEventSummary) => number | undefined;
    /** Whether the agent called a tool after this message, so it is an aside. */
    isIntermediate?: (event: AgentEventSummary) => boolean;
  } = {}
): MessageRun[] {
  const runs: MessageRun[] = [];
  let current: MessageRun | undefined;

  // The card wears one header and one set of attribution classes, so a change
  // of speaker has to start a new card even mid-turn. In practice a turn is
  // directed at one participant, but nothing upstream guarantees it.
  const speakerKey = (speaker: AgentEventSummary['speaker']) =>
    `${speaker?.participantId ?? ''}|${speaker?.provider ?? ''}|${speaker?.model ?? ''}`;

  const flush = () => {
    if (current && (current.parts.length > 0 || current.narration.length > 0)) {
      runs.push(current);
    }
    current = undefined;
  };

  events.forEach((event, index) => {
    if (!isAssistantMessage(event)) {
      // A user event closes the run, so each turn gets its own card.
      flush();
      return;
    }

    const text = visibleText(event).trim();
    if (current && speakerKey(current.speaker) !== speakerKey(event.speaker)) flush();
    if (!current) {
      current = { startIndex: index, memberIndices: [], parts: [], narration: [], toolNames: [], speaker: event.speaker };
    }
    current.memberIndices.push(index);

    if (text) {
      // A message the agent followed with tool calls is an aside however it
      // is worded; otherwise only the plainly self-addressed opener counts.
      const aside = hooks.isIntermediate?.(event) ? canFoldIntoThought(text) : isNarration(text);
      if (aside) current.narration.push(text);
      else current.parts.push(text);
    }

    // Each event carries the turn's running totals, so the latest one wins.
    if (event.durationMs !== undefined) current.durationMs = event.durationMs;
    if (event.tokenUsage) current.tokenUsage = { ...event.tokenUsage } as Record<string, number>;
    if (event.cost) current.cost = { ...event.cost };
    current.modelId = event.modelId ?? current.modelId;
    current.toolCalls = hooks.toolCallsAt?.(event) ?? current.toolCalls;

    for (const name of event.toolNames ?? []) {
      if (!current.toolNames.includes(name)) current.toolNames.push(name);
    }
  });

  flush();
  return runs;
}

interface RunIndex {
  starts: Map<number, MessageRun>;
  covered: Map<number, MessageRun>;
}

// The transcript asks "which run starts / covers this index?" once per event
// on every render, so building the lookup once per runs array keeps that
// linear in the event count instead of quadratic.
const indexCache = new WeakMap<readonly MessageRun[], RunIndex>();

function indexRuns(runs: readonly MessageRun[]): RunIndex {
  let index = indexCache.get(runs);
  if (!index) {
    index = { starts: new Map(), covered: new Map() };
    for (const run of runs) {
      index.starts.set(run.startIndex, run);
      for (const member of run.memberIndices) {
        if (member !== run.startIndex) index.covered.set(member, run);
      }
    }
    indexCache.set(runs, index);
  }
  return index;
}

/** The run that starts at `index`, if any — where the single card renders. */
export function messageRunStartingAt(
  runs: readonly MessageRun[],
  index: number
): MessageRun | undefined {
  return indexRuns(runs).starts.get(index);
}

/**
 * The run an index belongs to, if the index is a later member of one.
 *
 * Events inside a run are not rendered on their own, so this decides whether
 * `index` still needs to appear in the transcript at all.
 */
export function messageRunCovering(
  runs: readonly MessageRun[],
  index: number
): MessageRun | undefined {
  return indexRuns(runs).covered.get(index);
}
