#!/usr/bin/env node
// Generates crates/praxis-ai/src/session/agent_prompts.json from the compiled TypeScript prompt
// module (packages/core/out). The session prompt constants are module-private there, so this
// evaluates the compiled file with an export shim appended. Run `npm run build:core` first.
// Once the TypeScript prompts are retired this JSON becomes the source of truth.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const file = path.join(root, 'packages/core/out/ai/agentPrompt.js');
const names = ['IMPLEMENTATION_SYSTEM_PROMPT', 'PLANNING_SYSTEM_PROMPT', 'ANALYSIS_SESSION_SYSTEM_PROMPT', 'CHAT_SESSION_SYSTEM_PROMPT', 'INTERACTIVE_RESPONSE_SURFACES_PROMPT', 'VERIFICATION_EVIDENCE_PROMPT'];
const source = `${readFileSync(file, 'utf8')}\nmodule.exports.__private = { ${names.join(', ')} };`;
const sandbox = { module: { exports: {} }, exports: {}, require: id => require(id.startsWith('.') ? path.resolve(path.dirname(file), id) : id), __dirname: path.dirname(file) };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: file });
const { __private, BROWSER_TOOLS_PROMPT, CODE_INTELLIGENCE_PROMPT, AUTOPILOT_SESSION_PROMPT, CODE_INTELLIGENCE_SERVER_NAME } = sandbox.module.exports;
const { TICKET_REVIEW_SESSION_PROMPT } = require(path.join(root, 'packages/core/out/ai/ticketReview.js'));
const { HUMAN_REVIEW_SESSION_PROMPT } = require(path.join(root, 'packages/core/out/ai/humanReview.js'));
const data = { ...__private, BROWSER_TOOLS_PROMPT, CODE_INTELLIGENCE_PROMPT, AUTOPILOT_SESSION_PROMPT, CODE_INTELLIGENCE_SERVER_NAME, TICKET_REVIEW_SESSION_PROMPT, HUMAN_REVIEW_SESSION_PROMPT };
for (const [key, value] of Object.entries(data)) if (typeof value !== 'string' || !value) throw new Error(`Missing prompt ${key}`);
const out = path.join(root, 'crates/praxis-ai/src/session/agent_prompts.json');
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}: ${Object.keys(data).length} prompts`);

// Golden outputs from the TypeScript builder, so the Rust port is held to byte-for-byte parity.
const { buildSystemPrompt, buildWorktreeName } = require(path.join(root, 'packages/core/out/ai/agentPrompt.js'));
const issue = { key: 'APP-101', summary: 'Café login — now!', issueType: 'Story', status: 'To Do', projectKey: 'APP', description: 'Details here' };
const base = { goal: 'Do the thing', scope: 'This issue and related files', definitionOfDone: 'All criteria met' };
const cases = [
  { name: 'chat', task: { ...base, kind: 'general', sessionMode: 'chat' }, issue },
  { name: 'chat-with-ticket-context', task: { ...base, kind: 'general', sessionMode: 'chat', ticketContext: '## Ticket\nBody', nonGoals: ['auth'], completionContract: 'Report' }, issue },
  { name: 'default', task: { ...base, kind: 'general' }, issue },
  { name: 'default-full', task: { ...base, kind: 'implementation', nonGoals: ['touch auth', 'rename db'], completionContract: 'Return DELIVERY_RESULT', workingStyle: 'small commits', projectInstructions: 'Use tabs.', workflow: { name: 'Gov', instructionsPath: '/w.md', description: 'Playbook', link: 'https://x' }, attachments: [{ fileName: 'a.png', localPath: '/tmp/a.png', mediaType: 'image/png', sizeBytes: 12, sourceUrl: 'https://s' }], ticketContext: 'CONTEXT BLOCK' }, issue },
  { name: 'analysis', task: { ...base, kind: 'analysis' }, issue },
  { name: 'ticket-review', task: { ...base, kind: 'ticket-review' }, issue: { ...issue, key: 'review~APP-101' } }
];
const golden = {
  worktree: [issue, { key: 'X-1', summary: '' }, { key: 'APP-101', summary: 'APP-101 Add a router' }].map(i => ({ issue: i, name: buildWorktreeName(i) })),
  system: cases.map(c => ({ name: c.name, task: c.task, issue: c.issue, prompt: buildSystemPrompt(c.task, c.issue) }))
};
const goldenOut = path.join(root, 'crates/praxis-ai/src/session/prompt_golden.json');
writeFileSync(goldenOut, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${path.relative(root, goldenOut)}: ${golden.system.length} prompt cases, ${golden.worktree.length} worktree names`);
