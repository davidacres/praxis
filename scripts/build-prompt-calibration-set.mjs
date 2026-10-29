#!/usr/bin/env node
/**
 * Build a calibration set for the composer's prompt clarity check from the
 * prompts in your own Praxis session history.
 *
 * The set stays in your Electron profile (never in the repository): it holds
 * your real prompts. Each item gets empty label columns for the same five
 * checks the model answers (see CLARITY_CHECKLIST in packages/core), plus an
 * overall "should the coach have spoken" judgement. Sampling is deterministic:
 * the same history and seed always give the same set, so labels survive a
 * rebuild.
 *
 * Usage:
 *   node scripts/build-prompt-calibration-set.mjs
 *   node scripts/build-prompt-calibration-set.mjs --sample 150 --seed v1
 *   node scripts/build-prompt-calibration-set.mjs --user-data-dir /path/to/profile
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Praxis');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Praxis');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Praxis');
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const userDataDir = option('--user-data-dir', defaultUserDataDir());
const sampleSize = Number(option('--sample', '150'));
const seed = option('--seed', 'v1');
const correctionCap = Number(option('--corrections', '70'));
const outDir = path.join(userDataDir, 'prompt-calibration');

/** Sessions a person drives from the composer; workflow stages, diagnoses and reviews are generated prompts. */
const COMPOSER_SESSION = /^(?:SESSION-[0-9a-f]+|[A-Z]{2,10}-[A-Z]?\d+(?:-\d+)?)$/;
/** Turns Praxis writes on the user's behalf. */
const GENERATED_TURN = [
  /^Gadget response\b/i,
  /^#\s*Session handover\b/i,
  /^Continue the work described in Next steps/i,
  /^Follow up on the previous turn:/i,
  /^User input provided$/i
];
/**
 * The next message pushing back on the result. Rough on purpose: it flags turns
 * worth looking at, it is not ground truth that the prompt was unclear.
 */
const CORRECTION = /\b(still (?:not|broken|failing|doesn'?t|isn'?t|wrong|there|the same|showing|happening)|(?:that'?s|this is|it'?s) (?:wrong|not (?:right|what))|didn'?t (?:work|fix|change)|doesn'?t work|not working|did you (?:fix|test|verify|check|run)|you (?:missed|forgot|broke)|no change|nothing (?:changed|happened)|same (?:issue|problem|error))\b/i;

function readSessions(file) {
  const full = path.join(userDataDir, file);
  if (!fs.existsSync(full)) return [];
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  return Object.values(data['praxis.agentSessions'] ?? {});
}

function readEvents(session) {
  if ((session.events ?? []).length > 5) return session.events;
  const file = path.join(userDataDir, 'ai-transcripts', `${session.sessionId}.json`);
  if (!session.sessionId || !fs.existsSync(file)) return session.events ?? [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).events ?? []; } catch { return []; }
}

/**
 * Pasted terminal output and config can carry credentials. They are masked in
 * everything written out, and above all before any item is sent to a model.
 */
const SECRET_PATTERNS = [
  // No leading \b: pasted terminal output often runs a token straight into the previous word
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)=\S+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
const redact = text => SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[REDACTED]'), String(text ?? ''));

const excerpt = (text, max) => {
  const clean = redact(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const words = text => String(text).trim().split(/\s+/).filter(Boolean).length;
const hash = text => crypto.createHash('sha256').update(`${seed}\u0000${text}`).digest('hex');

const sessions = new Map();
for (const session of [...readSessions('ai-sessions.archive.json'), ...readSessions('ai-sessions.json')]) {
  if (session?.issueKey && COMPOSER_SESSION.test(session.issueKey)) sessions.set(session.issueKey, session);
}

const turns = [];
for (const session of sessions.values()) {
  const events = readEvents(session);
  const sequence = [];
  const goal = session.taskDefinition?.goal?.trim();
  if (goal) sequence.push({ role: 'user', text: goal, at: session.startedAt });
  for (const event of events) {
    if (event.type === 'user_input_completed') {
      const text = String(event.detail || '').trim();
      if (!text || event.data?.gadgetAnswer || text === 'You') continue;
      sequence.push({ role: 'user', text, at: event.timestamp });
    } else if (event.type === 'message') {
      const text = String(event.detail || event.summary || '').trim();
      if (text) sequence.push({ role: 'assistant', text, at: event.timestamp });
    }
  }
  let userTurn = 0;
  for (let index = 0; index < sequence.length; index++) {
    const entry = sequence[index];
    if (entry.role !== 'user') continue;
    const turnIndex = userTurn++;
    if (GENERATED_TURN.some(pattern => pattern.test(entry.text))) continue;
    const before = sequence.slice(0, index);
    const priorAssistant = [...before].reverse().find(item => item.role === 'assistant');
    const priorUser = [...before].reverse().find(item => item.role === 'user');
    const nextUser = sequence.slice(index + 1).find(item => item.role === 'user' && !GENERATED_TURN.some(p => p.test(item.text)));
    turns.push({
      sessionKey: session.issueKey,
      turnIndex,
      position: turnIndex === 0 ? 'first' : 'follow-up',
      prompt: entry.text,
      words: words(entry.text),
      // What the composer sends with a follow-up: the last six messages, 1,200 characters each
      // (boundedFeedbackMessages in packages/core/src/ai/feedback/promptClarity.ts)
      priorMessages: before.slice(-6).map(item => ({ role: item.role, text: redact(item.text).slice(0, 1200) })),
      priorUser: priorUser ? excerpt(priorUser.text, 300) : '',
      priorAssistant: priorAssistant ? excerpt(priorAssistant.text, 400) : '',
      nextUser: nextUser ? excerpt(nextUser.text, 200) : '',
      corrected: Boolean(nextUser && CORRECTION.test(nextUser.text))
    });
  }
}

// One item per distinct prompt: the first occurrence keeps its context
const distinct = new Map();
for (const turn of turns) {
  const key = turn.prompt.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!distinct.has(key)) distinct.set(key, turn);
  else if (turn.corrected) distinct.get(key).corrected = true;
}
const pool = [...distinct.values()];
const byHash = items => [...items].sort((a, b) => hash(a.prompt).localeCompare(hash(b.prompt)));

// Every turn that drew a correction (up to the cap), then an even split of first
// turns and follow-ups, each spread across short, medium and long prompts
const corrected = byHash(pool.filter(turn => turn.corrected)).slice(0, correctionCap);
const taken = new Set(corrected);
const bucket = turn => (turn.words <= 8 ? 'short' : turn.words <= 40 ? 'medium' : 'long');
const sampled = [];
for (const position of ['first', 'follow-up']) {
  const quota = Math.round(sampleSize / 2);
  const groups = ['short', 'medium', 'long'].map(size =>
    byHash(pool.filter(turn => !taken.has(turn) && turn.position === position && bucket(turn) === size)));
  for (let round = 0; sampled.filter(t => t.position === position).length < quota && groups.some(g => g.length); round++) {
    for (const group of groups) {
      const next = group.shift();
      if (next && sampled.filter(t => t.position === position).length < quota) sampled.push(next);
    }
  }
}

// Ids and sampling use the original text so they stay stable; only the stored text is masked
const items = [...corrected.map(turn => ({ ...turn, stratum: 'corrected' })), ...sampled.map(turn => ({ ...turn, stratum: `${turn.position}-${bucket(turn)}` }))]
  .map(turn => ({ id: hash(turn.prompt).slice(0, 10), ...turn, prompt: redact(turn.prompt), redacted: redact(turn.prompt) !== turn.prompt }));

const LABEL_COLUMNS = ['kind', 'target', 'outcome', 'done', 'contextGap', 'ambiguity', 'coach', 'note'];
fs.mkdirSync(outDir, { recursive: true });
const setFile = path.join(outDir, 'calibration-set.json');
fs.writeFileSync(setFile, JSON.stringify({
  version: 1,
  builtAt: new Date().toISOString(),
  seed,
  checklist: 'CLARITY_CHECKLIST v2 (packages/core/src/ai/feedback/promptClarity.ts)',
  labelColumns: LABEL_COLUMNS,
  sourceCounts: { sessions: sessions.size, userTurns: turns.length, distinctPrompts: pool.length, correctedTurns: pool.filter(t => t.corrected).length },
  items
}, null, 2));

console.log(`Sessions read: ${sessions.size}`);
console.log(`User turns: ${turns.length}  distinct prompts: ${pool.length}  drew a correction: ${pool.filter(t => t.corrected).length}`);
console.log(`Calibration set: ${items.length} items (${corrected.length} corrected, ${sampled.length} sampled, ${items.filter(i => i.redacted).length} with secrets masked)`);
console.log(`Written to ${setFile}`);
