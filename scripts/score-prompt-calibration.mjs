#!/usr/bin/env node
/**
 * Score the composer's prompt clarity check against your own labels.
 *
 * Reads the set from scripts/build-prompt-calibration-set.mjs and your reviewed
 * labels.csv (both in <profile>/prompt-calibration), gets the checklist answers
 * for each prompt, and reports how often the check agrees with you. It uses the
 * same prompt, parser and scoring as the app (packages/core/out), so the numbers
 * describe what the composer actually does.
 *
 * Nothing is sent anywhere unless you pass --run. With --run every prompt (and
 * the earlier messages a follow-up carries, secrets already masked) goes to the
 * endpoint you name. Answers are cached in answers.json by item and model, so a
 * rerun only asks for what is missing.
 *
 * Usage:
 *   node scripts/score-prompt-calibration.mjs                      # report from cached answers only
 *   PRAXIS_CALIBRATION_API_KEY=… node scripts/score-prompt-calibration.mjs --run \
 *     --endpoint https://ai-gateway.vercel.sh/v1 --model anthropic/claude-haiku-4.5
 *   node scripts/score-prompt-calibration.mjs --reviewed-only      # only rows you ticked as reviewed
 *   node scripts/score-prompt-calibration.mjs --run --cli claude   # through the Claude Code CLI, as the
 *                                                                  # app does when a CLI agent runs prompt checks
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreClarity = path.join(repoRoot, 'packages/core/out/ai/feedback/promptClarity.js');
if (!fs.existsSync(coreClarity)) {
  console.error('packages/core is not built. Run: npm run test:core (or tsc -p packages/core) first.');
  process.exit(1);
}
const { CLARITY_SYSTEM_PROMPT, CLARITY_CHECKLIST_VERSION, CLARITY_COACH_THRESHOLD, buildClarityPrompt, parseClarityAnswers, scoreClarityAnswers } = require(coreClarity);
const pricingModule = path.join(repoRoot, 'packages/core/out/ai/providers/modelPricing.js');
const { estimateTurnCost } = fs.existsSync(pricingModule) ? require(pricingModule) : { estimateTurnCost: () => undefined };

function defaultUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Praxis');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Praxis');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Praxis');
}
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = name => process.argv.includes(name);

const dir = path.join(option('--user-data-dir', defaultUserDataDir()), 'prompt-calibration');
const endpoint = option('--endpoint', '').replace(/\/+$/, '');
const cli = option('--cli', '');
const model = option('--model', cli === 'claude' ? 'claude-code-cli/cli-default' : '');
const fillModel = option('--fill-model', '');
const run = flag('--run');
const reviewedOnly = flag('--reviewed-only');
const concurrency = Number(option('--concurrency', '3'));
/**
 * The pass mark. Only about one prompt in ten needs coaching, so plain agreement
 * is useless as a gate: a coach that never speaks agrees ~90% of the time. It has
 * to be right when it speaks (precision) and catch the prompts that need it (recall).
 */
const TARGET_PRECISION = Number(option('--min-precision', '0.7'));
const TARGET_RECALL = Number(option('--min-recall', '0.7'));
const threshold = Number(option('--threshold', String(CLARITY_COACH_THRESHOLD ?? 5)));

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF, and a UTF-8 BOM from spreadsheet apps. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(cell => cell.trim()));
  return body.map(r => Object.fromEntries(header.map((name, index) => [name.trim(), (r[index] ?? '').trim()])));
}

const set = JSON.parse(fs.readFileSync(path.join(dir, 'calibration-set.json'), 'utf8'));
const labels = new Map(parseCsv(fs.readFileSync(path.join(dir, 'labels.csv'), 'utf8')).map(row => [row.id, row]));
const answersFile = path.join(dir, 'answers.json');
const cache = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf8')) : {};
const cacheKey = id => `${id}@${model || 'cached'}@v${CLARITY_CHECKLIST_VERSION}`;

const items = set.items.filter(item => labels.has(item.id) && (!reviewedOnly || /^(y|yes|x|true|1)$/i.test(labels.get(item.id).reviewed)));
const priorContext = item => item.position === 'follow-up'
  ? { turnCount: item.turnIndex, touchedPaths: [], recentMessages: item.priorMessages ?? [] }
  : undefined;

/**
 * A CLI agent gets the instructions and the prompt as one message, like the app's
 * promptOnce path. It runs in an empty folder so no project instructions load, with
 * tools blocked: the check judges the text, it does not explore a repository.
 */
const cliFolder = cli ? fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-calibration-')) : '';
if (cliFolder) process.on('exit', () => fs.rmSync(cliFolder, { recursive: true, force: true }));
function askCli(item) {
  const cliModel = model.startsWith('claude-code-cli/') ? model.slice('claude-code-cli/'.length) : model;
  const args = ['-p', '--output-format', 'text', '--no-session-persistence',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
    ...(cliModel && cliModel !== 'cli-default' ? ['--model', cliModel] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: cliFolder, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out after 180s')); }, 180_000);
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.end(`${CLARITY_SYSTEM_PROMPT}\n\n${buildClarityPrompt(item.prompt, priorContext(item))}`);
  });
}

async function ask(item) {
  const promptText = buildClarityPrompt(item.prompt, priorContext(item));
  if (cli === 'claude') {
    const content = await askCli(item);
    const inputTokens = Math.max(1, Math.round((CLARITY_SYSTEM_PROMPT.length + promptText.length) / 4));
    const outputTokens = Math.max(1, Math.round(content.length / 4));
    return {
      reply: content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
    };
  }
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PRAXIS_CALIBRATION_API_KEY ?? ''}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: CLARITY_SYSTEM_PROMPT },
        { role: 'user', content: promptText }
      ]
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content ?? '';
  const inputTokens = body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? Math.max(1, Math.round((CLARITY_SYSTEM_PROMPT.length + promptText.length) / 4));
  const outputTokens = body.usage?.completion_tokens ?? body.usage?.output_tokens ?? Math.max(1, Math.round(content.length / 4));
  const totalTokens = body.usage?.total_tokens ?? (inputTokens + outputTokens);
  return {
    reply: content,
    usage: { inputTokens, outputTokens, totalTokens }
  };
}

function recordCalibrationUsage(usage) {
  try {
    const logFile = path.join(option('--user-data-dir', defaultUserDataDir()), 'ai-usage-log.json');
    let data = { 'praxis.aiUsageLog.v1': [] };
    if (fs.existsSync(logFile)) {
      data = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      if (!Array.isArray(data['praxis.aiUsageLog.v1'])) data['praxis.aiUsageLog.v1'] = [];
    }
    const cost = estimateTurnCost(undefined, model, usage);
    data['praxis.aiUsageLog.v1'].push({
      id: `calib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      source: 'prompt-calibration',
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {})
    });
    fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
  } catch (err) {
    // Best-effort ledger persistence
  }
}

if (run) {
  if (cli && cli !== 'claude') { console.error('--cli supports: claude'); process.exit(1); }
  if (!cli && (!endpoint || !model)) { console.error('--run needs --endpoint and --model, or --cli claude.'); process.exit(1); }
  // Failed calls are retried; only real replies are kept
  const isUnanswered = item => {
    if (fillModel) {
      const fillKey = `${item.id}@${fillModel}@v${CLARITY_CHECKLIST_VERSION}`;
      if (cache[fillKey]?.reply) return false;
    }
    return !cache[cacheKey(item.id)]?.reply;
  };
  const unanswered = items.filter(isUnanswered);
  const missing = unanswered.slice(0, Number(option('--limit', 'Infinity')));
  console.log(`Asking ${model} about ${missing.length} prompts (${items.length - unanswered.length} already answered)…`);
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < missing.length) {
      const currentIdx = next++;
      const item = missing[currentIdx];
      const start = Date.now();
      try {
        const result = await ask(item);
        const reply = typeof result === 'string' ? result : result.reply;
        if (result && typeof result === 'object' && result.usage) {
          recordCalibrationUsage(result.usage);
        }
        cache[cacheKey(item.id)] = { reply, at: new Date().toISOString() };
        if (fillModel) {
          const fillKey = `${item.id}@${fillModel}@v${CLARITY_CHECKLIST_VERSION}`;
          cache[fillKey] = { reply, model, at: new Date().toISOString(), filledFrom: model };
        }
        completed++;
        console.log(`[${completed}/${missing.length}] ${item.id} ok (${Date.now() - start}ms)`);
      } catch (error) {
        completed++;
        cache[cacheKey(item.id)] = { error: String(error instanceof Error ? error.message : error), at: new Date().toISOString() };
        console.log(`[${completed}/${missing.length}] ${item.id} failed: ${error.message}`);
      }
      fs.writeFileSync(answersFile, JSON.stringify(cache, null, 2));
    }
  }));
} else if (!Object.keys(cache).length) {
  console.log(`No cached answers in ${answersFile}.`);
  console.log(`Nothing has been sent. To score ${items.length} labelled prompts, rerun with --run --endpoint <OpenAI-compatible base URL> --model <id>`);
  console.log('and PRAXIS_CALIBRATION_API_KEY set. Each prompt and its earlier messages (secrets masked) will be sent to that endpoint.');
  process.exit(0);
}

// The app's rule for each check: which answer is a problem, and whether it applies to non-instructions
const CHECKS = [
  { id: 'target', column: 'target', bad: 'no', instructionOnly: true },
  { id: 'outcome', column: 'outcome', bad: 'no', instructionOnly: true },
  { id: 'done', column: 'done', bad: 'no', instructionOnly: true },
  { id: 'context-gap', column: 'contextGap', bad: 'yes', instructionOnly: false },
  { id: 'ambiguity', column: 'ambiguity', bad: 'yes', instructionOnly: true }
];
const fails = (check, answer, kind) => {
  if (!answer || (check.instructionOnly && kind !== 'instruction')) return false;
  return check.bad === 'no' ? answer !== 'yes' : answer !== 'no';
};

const results = [];
const errors = [];
for (const item of items) {
  let entry = cache[cacheKey(item.id)] ?? Object.entries(cache).find(([key]) => key.startsWith(`${item.id}@${model || ''}`) && key.includes(`@v${CLARITY_CHECKLIST_VERSION}`))?.[1];
  if (!entry?.reply) {
    entry = Object.entries(cache).find(([key]) => key.startsWith(`${item.id}@${model || ''}`))?.[1];
  }
  if (!entry?.reply && fillModel) {
    const fallback = cache[`${item.id}@${fillModel}@v${CLARITY_CHECKLIST_VERSION}`] ?? Object.entries(cache).find(([key]) => key.startsWith(`${item.id}@${fillModel}`))?.[1];
    if (fallback?.reply) entry = fallback;
  }
  if (!entry) continue;
  if (entry.error) { errors.push({ id: item.id, error: entry.error }); continue; }
  try {
    const answers = parseClarityAnswers(entry.reply, item.prompt, priorContext(item));
    const scored = scoreClarityAnswers(answers, {}, { threshold });
    results.push({ item, label: labels.get(item.id), answers, coach: scored.findings.length > 0 });
  } catch (error) {
    errors.push({ id: item.id, error: `rejected reply: ${error instanceof Error ? error.message : error}` });
  }
}
if (!results.length) { console.log('No usable answers to score yet.', errors.length ? `${errors.length} failed.` : ''); process.exit(errors.length ? 1 : 0); }

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const lines = [];
const say = text => { lines.push(text); console.log(text); };

const labelCoach = r => /^y/i.test(r.label.coach);
const tp = results.filter(r => r.coach && labelCoach(r)).length;
const fp = results.filter(r => r.coach && !labelCoach(r)).length;
const fn = results.filter(r => !r.coach && labelCoach(r)).length;
const agree = results.filter(r => r.coach === labelCoach(r)).length;
const kindAgree = results.filter(r => r.answers.kind === r.label.kind).length;

say(`# Prompt check calibration — ${model || 'cached answers'}`);
say('');
say(`Scored ${results.length} of ${items.length} labelled prompts${reviewedOnly ? ' (reviewed rows only)' : ''} (coach deduction threshold: ≥ ${threshold} pts); ${errors.length} replies failed or were rejected.`);
say('');
const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;
const passes = precision >= TARGET_PRECISION && recall >= TARGET_RECALL;
const quietBaseline = results.filter(r => !labelCoach(r)).length;
say('## Should the coach speak?');
say(`- **${passes ? 'Passes' : 'Does not pass'}** the gate: precision ≥ ${TARGET_PRECISION * 100}% and recall ≥ ${TARGET_RECALL * 100}%.`);
say(`- When it speaks, you agree (precision): **${pct(tp, tp + fp)}** — false alarms: ${fp}`);
say(`- Of the prompts you said need it, it catches (recall): **${pct(tp, tp + fn)}** — missed: ${fn}`);
say(`- Plain agreement: ${pct(agree, results.length)} — a coach that never spoke would score ${pct(quietBaseline, results.length)}, so this number alone proves nothing.`);
say(`- Prompt kind matches your label: ${pct(kindAgree, results.length)}`);
say('');
say('## Per check (pass/fail as the app scores it)');
say('| Check | Agreement | Model flags | You flag |');
say('| --- | --- | --- | --- |');
for (const check of CHECKS) {
  let same = 0, modelFlags = 0, humanFlags = 0;
  for (const r of results) {
    const m = fails(check, r.answers.checks[check.id]?.answer, r.answers.kind);
    const h = fails(check, r.label[check.column], r.label.kind);
    if (m === h) same++;
    if (m) modelFlags++;
    if (h) humanFlags++;
  }
  say(`| ${check.id} | ${pct(same, results.length)} | ${modelFlags} | ${humanFlags} |`);
}
say('');
say('## Does it pick out the turns that drew a correction?');
const corrected = results.filter(r => r.item.corrected);
const others = results.filter(r => !r.item.corrected);
say(`- Coach speaks on ${pct(corrected.filter(r => r.coach).length, corrected.length)} of corrected turns vs ${pct(others.filter(r => r.coach).length, others.length)} of the rest.`);
say('- A correction is a rough signal (it often follows a bug, not an unclear prompt); treat this as supporting evidence, not ground truth.');
say('');
say('## Disagreements on "should the coach speak"');
for (const r of results.filter(r => r.coach !== labelCoach(r)).slice(0, 40)) {
  const flagged = CHECKS.filter(check => fails(check, r.answers.checks[check.id]?.answer, r.answers.kind)).map(check => check.id);
  say(`- \`${r.item.id}\` model ${r.coach ? 'speaks' : 'quiet'} (${flagged.join(', ') || 'no checks failed'}), you said ${labelCoach(r) ? 'speak' : 'quiet'}: ${r.item.prompt.replace(/\s+/g, ' ').slice(0, 110)}`);
}
if (errors.length) {
  say('');
  say('## Failed or rejected replies');
  for (const e of errors.slice(0, 20)) say(`- \`${e.id}\`: ${e.error.slice(0, 160)}`);
}
fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n') + '\n');
console.log(`\nReport written to ${path.join(dir, 'report.md')}`);
