import { boundedFeedbackMessages } from './promptClarity';
import type { AgentEventSummary, AgentSessionRecord } from '../agentTypes';
import type { FeedbackPriorContext, FeedbackWorkspaceHints } from './feedbackTypes';

/**
 * Workspace grounding: turns the host's raw workspace facts (changed files,
 * test files, package scripts) into concrete suggestions ranked against the
 * prompt, so a fix chip pins a real file or names a real test command instead
 * of pasting generic advice into the prompt.
 */

export interface RankedFileCandidate {
  path: string;
  score: number;
}

export interface TestCommandCandidate {
  /** Short chip label, e.g. `sessionFeedback.spec.ts` or `npm run check-types`. */
  label: string;
  command: string;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'are', 'was',
  'can', 'you', 'please', 'make', 'should', 'would', 'could', 'have', 'has', 'not', 'but', 'all',
  'add', 'fix', 'update', 'change', 'use', 'new', 'its', 'our', 'out', 'any', 'get', 'set', 'run',
  'tsx', 'jsx', 'src', 'test', 'tests', 'spec', 'file', 'files', 'index', 'main', 'app', 'lib',
  // Actions and qualities: they say what to do, never where
  'put', 'move', 'make', 'rename', 'remove', 'delete', 'create', 'show', 'hide', 'bigger', 'smaller',
  'larger', 'better', 'faster', 'slower', 'simpler', 'cleaner', 'nicer', 'properly', 'correctly'
]);

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

/** Lower-cased words of at least three letters, singularised by a trailing `s`. */
function promptTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    terms.add(raw.endsWith('s') && raw.length > 4 ? raw.slice(0, -1) : raw);
  }
  return terms;
}

/** Splits `SessionPromptScoreBar.tsx` into `session`, `prompt`, `score`, `bar`. */
function fileTerms(filePath: string): string[] {
  const stem = basename(filePath).replace(/\.(?:spec|test)\.[a-z]+$/i, '').replace(/\.[a-z0-9]+$/i, '');
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length >= 3 && !STOPWORDS.has(part))
    .map(part => (part.endsWith('s') && part.length > 4 ? part.slice(0, -1) : part));
}

function overlapScore(terms: Set<string>, filePath: string): number {
  return fileTerms(filePath).filter(term => terms.has(term)).length;
}

/** Whether the prompt already names this file (by basename or path). */
export function promptMentionsFile(promptText: string, filePath: string): boolean {
  const lower = promptText.toLowerCase();
  const name = basename(filePath).toLowerCase();
  return lower.includes(name) || lower.includes(filePath.toLowerCase());
}

/**
 * Files whose name shares at least one meaningful word with the prompt, best
 * match first. Changed files win ties (they are what the user is working on),
 * then shorter paths; tests and files the prompt already names are excluded.
 */
export function rankFileCandidates(
  promptText: string,
  hints: FeedbackWorkspaceHints | undefined,
  limit = 2
): RankedFileCandidate[] {
  if (!hints) return [];
  const terms = promptTerms(promptText);
  if (terms.size === 0) return [];
  const changed = new Set(hints.changedFiles);
  // A file the user is not working on must match as well as the prompt allows: one shared
  // word ("bar") is not enough to suggest TitleBar.tsx for "the score bar".
  const vocabulary = hints.trackedFiles?.length ? workspaceVocabulary(hints.trackedFiles) : undefined;
  const groundedTerms = vocabulary ? [...terms].filter(term => vocabulary.has(term)).length : terms.size;
  const unchangedMinimum = Math.max(1, Math.min(2, groundedTerms));
  return [...new Set([...hints.changedFiles, ...(hints.trackedFiles ?? [])])]
    .filter(file => !/\.(?:spec|test)\.[a-z]+$/i.test(file) && !promptMentionsFile(promptText, file))
    .map(path => ({ path, score: overlapScore(terms, path) }))
    .filter(candidate => candidate.score >= (changed.has(candidate.path) ? 1 : unchangedMinimum))
    .sort((a, b) =>
      b.score - a.score ||
      Number(changed.has(b.path)) - Number(changed.has(a.path)) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path)
    )
    .slice(0, limit);
}

export interface PromptGrounding {
  /** Whether a workspace vocabulary was available to check against at all. */
  checked: boolean;
  /** Prompt terms that match a tracked file or folder name. */
  matched: string[];
  /** Prompt terms that match nothing in the workspace. */
  unmatched: string[];
  /** Near-miss spellings: an unmatched term and the workspace term it is one edit away from. */
  nearMisses: Array<{ term: string; suggestion: string }>;
}

const vocabularyCache = new WeakMap<readonly string[], Set<string>>();

/** Every word used in a tracked file's folders and name (`ai/SessionPromptScoreBar.tsx` → ai, session, prompt, score, bar). */
function workspaceVocabulary(files: readonly string[]): Set<string> {
  const cached = vocabularyCache.get(files);
  if (cached) return cached;
  const vocabulary = new Set<string>();
  for (const file of files) {
    for (const segment of file.split('/')) {
      for (const term of fileTerms(segment)) vocabulary.add(term);
    }
  }
  vocabularyCache.set(files, vocabulary);
  return vocabulary;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Checks the prompt's meaningful words against the workspace's own file and
 * folder names. A target nobody can find in the repository ("the box") is the
 * clearest sign the agent will have to guess.
 */
export function groundPromptTerms(promptText: string, hints: FeedbackWorkspaceHints | undefined): PromptGrounding {
  const files = hints?.trackedFiles ?? [];
  if (files.length === 0) return { checked: false, matched: [], unmatched: [], nearMisses: [] };
  const vocabulary = workspaceVocabulary(files);
  // Identifiers are checked against the code index (`hints.symbols`), not file names:
  // a found symbol grounds the prompt, an unknown one is reported on its own.
  const identifiers = extractPromptIdentifiers(promptText);
  const found = new Set((hints?.symbols ?? []).filter(symbol => symbol.found).map(symbol => symbol.name));
  const identifierTerms = new Set(identifiers.map(name => name.toLowerCase()));
  const matched: string[] = identifiers.filter(name => found.has(name));
  const unmatched: string[] = [];
  const nearMisses: Array<{ term: string; suggestion: string }> = [];
  for (const term of [...promptTerms(promptText.replace(/`[^`]*`/g, ' '))].sort()) {
    if (identifierTerms.has(term)) continue;
    if (vocabulary.has(term)) {
      matched.push(term);
      continue;
    }
    unmatched.push(term);
    if (term.length >= 4) {
      const suggestion = [...vocabulary].filter(word => word.length >= 4 && withinOneEdit(term, word)).sort()[0];
      if (suggestion) nearMisses.push({ term, suggestion });
    }
  }
  return { checked: true, matched, unmatched, nearMisses };
}

const IDENTIFIER_PATTERNS = [
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, // PascalCase with two or more humps
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g // snake_case
];

/**
 * Code identifiers the prompt names — the words worth an exact lookup in the code
 * index. File names count by their stem, so `SessionPromptScoreBar.tsx` checks
 * `SessionPromptScoreBar`.
 */
export function extractPromptIdentifiers(promptText: string): string[] {
  const names = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of promptText.match(pattern) ?? []) names.add(match);
  }
  for (const match of promptText.matchAll(/`([A-Za-z_$][\w$]{2,80})`/g)) names.add(match[1]);
  return [...names].sort();
}

/** A name the prompt is asking to bring into being — "rename X to Y", "add a `Y` hook" — is meant not to exist yet. */
function isIntroducedName(promptText: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:to|as|into|called|named|new|create|add|introduce|extract)\\s+(?:an?\\s+|the\\s+)?\`?${escaped}\\b`, 'i').test(promptText);
}

/** Identifiers the code index looked up and could not find, unless a tracked file carries that name or the prompt introduces it. */
export function unknownIdentifiers(hints: FeedbackWorkspaceHints | undefined, promptText = ''): string[] {
  const stems = new Set((hints?.trackedFiles ?? []).map(file => basename(file).replace(/\.[^.]+$/, '').replace(/\.(?:spec|test)$/, '')));
  return (hints?.symbols ?? [])
    .filter(symbol => !symbol.found && !stems.has(symbol.name) && !isIntroducedName(promptText, symbol.name))
    .map(symbol => symbol.name)
    .sort();
}

function commandForTestFile(testFile: string): string {
  if (/(?:^|\/)e2e\//.test(testFile) || /\.spec\.[a-z]+$/i.test(testFile)) {
    const relative = testFile.replace(/^.*?(?=(?:^|\/)e2e\/)/, '').replace(/^\//, '');
    return `npx playwright test ${relative}`;
  }
  return `node --test ${testFile}`;
}

/**
 * The single most relevant verification command: a test file matching the
 * prompt (or the files it is about to touch) when there is one, otherwise the
 * workspace's own typecheck/test script.
 */
export function pickTestCommand(
  promptText: string,
  hints: FeedbackWorkspaceHints | undefined,
  relatedPaths: readonly string[] = []
): TestCommandCandidate | undefined {
  if (!hints) return undefined;
  const terms = promptTerms([promptText, ...relatedPaths.map(basename)].join(' '));
  // Same bar as file suggestions: one shared word ("button") does not make a spec relevant
  const vocabulary = hints.trackedFiles?.length ? workspaceVocabulary(hints.trackedFiles) : undefined;
  const groundedTerms = vocabulary ? [...terms].filter(term => vocabulary.has(term)).length : terms.size;
  const minimum = Math.max(1, Math.min(2, groundedTerms));
  const bestTest = [...new Set(hints.testFiles)]
    .map(path => ({ path, score: overlapScore(terms, path) }))
    .filter(candidate => candidate.score >= minimum)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
  if (bestTest) {
    return { label: basename(bestTest.path), command: commandForTestFile(bestTest.path) };
  }
  const scripts = new Set(hints.packageScripts);
  const script = ['check-types', 'typecheck', 'test', 'build'].find(name => scripts.has(name));
  if (script) {
    const command = script === 'test' ? 'npm test' : `npm run ${script}`;
    return { label: command, command };
  }
  return undefined;
}

function userTurnCount(events: readonly AgentEventSummary[], hasGoal: boolean): number {
  const followUps = events.filter(event => event.type === 'user_input_completed').length;
  return followUps + (hasGoal ? 1 : 0);
}

/** What a new follow-up prompt inherits from a session's earlier turns. */
export function derivePriorContext(session: AgentSessionRecord): FeedbackPriorContext {
  const events = session.events ?? [];
  const messages: NonNullable<FeedbackPriorContext['recentMessages']> = [];
  const goal = session.taskDefinition?.goal?.trim();
  if (goal) messages.push({ role: 'user', text: goal });
  for (const event of events) {
    if (event.type !== 'user_input_completed' && event.type !== 'message') continue;
    const text = (event.detail || event.summary || '').trim();
    const role = event.type === 'message' ? 'assistant' as const : 'user' as const;
    const previous = messages[messages.length - 1];
    if (text && (previous?.text !== text || previous.role !== role)) messages.push({ role, text });
  }
  const recentMessages = boundedFeedbackMessages({ turnCount: 0, touchedPaths: [], recentMessages: messages });
  const touched = new Set<string>();
  for (const event of events) {
    for (const change of event.data?.fileChanges ?? []) {
      if (change.path) touched.add(change.path);
    }
  }
  const issueKey = /^[A-Z]{2,10}(?:-[A-Z]+)?-\d+$/.test(session.issueKey) ? session.issueKey : undefined;
  return {
    turnCount: userTurnCount(events, Boolean(session.taskDefinition?.goal?.trim())),
    touchedPaths: [...touched].sort(),
    ...(recentMessages.length ? { recentMessages } : {}),
    ...(issueKey ? { issueKey } : {})
  };
}
