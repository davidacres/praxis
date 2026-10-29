import type { AgentToolMode, FeedbackFinding, FeedbackRemediation } from '@praxis/core';
import type { PhraseMarker } from './PromptCoachDetails';

/**
 * One thing the coach wants changed, in the form it is accepted:
 * - `setting` changes a session setting, never the text;
 * - `insert` adds text at the end of the draft (shown as ghost text first);
 * - `phrase` replaces an unclear phrase with the user's answer;
 * - `question` appends the user's answer as a labelled line;
 * - `advice` has no one-step fix and can only be read and skipped.
 */
export type CoachSuggestionKind = 'setting' | 'insert' | 'phrase' | 'question' | 'advice';

export interface CoachSuggestion {
  key: string;
  kind: CoachSuggestionKind;
  finding: FeedbackFinding;
  /** What the strip says; may contain `code` spans. */
  text: string;
  /** Settings and inserts: the remediation first, then its alternatives (cycled with ⌥] / ⌥[). */
  options: FeedbackRemediation[];
  marker?: PhraseMarker;
  points?: number;
}

const KIND_ORDER: Record<CoachSuggestionKind, number> = { setting: 0, phrase: 1, insert: 2, question: 3, advice: 4 };

export function isSettingsFix(remediation: FeedbackRemediation): boolean {
  return remediation.kind === 'change-tool-mode' || remediation.kind === 'attach-skill' || remediation.kind === 'select-agent';
}

function isTextFix(remediation: FeedbackRemediation): boolean {
  return remediation.kind === 'pin-file' || remediation.kind === 'add-test-command' || remediation.kind === 'add-verification';
}

/** Label for the accept action of a setting or insert option. */
export function optionLabel(remediation: FeedbackRemediation): string {
  if (remediation.kind === 'change-tool-mode') return 'Switch to Full Access';
  if (remediation.kind === 'attach-skill' && remediation.targetId) return `Attach ${remediation.targetId}`;
  return remediation.label;
}

function settingText(finding: FeedbackFinding, toolMode: AgentToolMode): string {
  if (finding.id === 'prompt-tool-mode-conflict') {
    return `The prompt asks for edits, but the session is \`${toolMode === 'read-only' ? 'Read-only' : toolMode}\``;
  }
  if (finding.remediation.kind === 'attach-skill' && finding.remediation.targetId) {
    return `This matches the \`${finding.remediation.targetId}\` skill`;
  }
  return finding.title;
}

function insertText(remediation: FeedbackRemediation): string {
  return remediation.kind === 'pin-file' ? 'Name the file to change' : 'Say how the result should be checked';
}

function adviceText(finding: FeedbackFinding): string {
  // When nothing matches the workspace, what was looked for is the useful part
  return finding.title.startsWith('Nothing in the prompt matches')
    ? `${finding.evidence} ${finding.remediation.description}`
    : finding.remediation.description || finding.title;
}

/** Ordered list: setting conflicts first, then phrases in reading order, then additions, questions, advice. */
export function buildCoachSuggestions(findings: readonly FeedbackFinding[], markers: readonly PhraseMarker[], toolMode: AgentToolMode): CoachSuggestion[] {
  const suggestions: CoachSuggestion[] = [];
  for (const finding of findings) {
    const { remediation } = finding;
    const points = finding.scoreImpact;
    const marker = markers.find(m => `clarity-${m.id}` === finding.id);
    if (isSettingsFix(remediation)) {
      suggestions.push({ key: finding.id, kind: 'setting', finding, text: settingText(finding, toolMode), options: [remediation], points });
    } else if (isTextFix(remediation) && remediation.suggestedPromptSnippet) {
      const options = [remediation, ...(remediation.alternatives ?? []).filter(option => option.suggestedPromptSnippet)];
      suggestions.push({ key: finding.id, kind: 'insert', finding, text: insertText(remediation), options, points });
    } else if (marker) {
      suggestions.push({ key: finding.id, kind: marker.start >= 0 ? 'phrase' : 'question', finding, text: marker.text, options: [], marker, points });
    } else if (!finding.id.startsWith('clarity-')) {
      suggestions.push({ key: finding.id, kind: 'advice', finding, text: adviceText(finding), options: [], points });
    }
  }
  // Naming the file reads before saying how to check it
  const insertRank = (s: CoachSuggestion) => s.options[0]?.kind === 'pin-file' ? 0 : 1;
  return suggestions.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.marker?.start ?? 0) - (b.marker?.start ?? 0) || insertRank(a) - insertRank(b));
}

/** Weaves a clause into the draft sentence: `fix the bar` + `in @Bar.tsx` → `fix the bar in @Bar.tsx.` */
export function insertPromptClause(prompt: string, clause: string): string {
  const trimmed = prompt.trimEnd();
  if (/^(?:in|and|with|for)\b/i.test(clause)) {
    return `${trimmed.replace(/[.!]+$/, '')} ${clause}.`;
  }
  return `${trimmed}\n\n${clause}`;
}

/** The part `insertPromptClause` would add after the draft, as ghost text. */
export function ghostTextFor(prompt: string, clause: string): string {
  const next = insertPromptClause(prompt, clause);
  const kept = prompt.trimEnd().replace(/[.!]+$/, '');
  return next.startsWith(kept) ? next.slice(kept.length) : next;
}

/** The draft after answering a phrase or open question. */
export function answerSuggestion(prompt: string, suggestion: CoachSuggestion, answer: string): string {
  const marker = suggestion.marker;
  if (marker && marker.start >= 0 && prompt.slice(marker.start, marker.start + marker.phrase.length) === marker.phrase) {
    return prompt.slice(0, marker.start) + answer + prompt.slice(marker.start + marker.phrase.length);
  }
  const label = marker?.id === 'done' ? 'Verify' : marker?.id === 'context-gap' ? 'Context' : 'Clarification';
  return `${prompt.trimEnd()}\n\n${label}: ${answer}`;
}
