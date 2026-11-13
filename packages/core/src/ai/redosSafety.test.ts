/**
 * ReDoS regressions (CodeQL js/polynomial-redos). Each case checks the linear
 * replacement against the regex it replaced on representative inputs
 * (differential), and runs it on a 50,000-character adversarial input that
 * made the old pattern quadratic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPath } from './coordination/coordinationPolicy';
import { findFencedBody, stripTaggedBlocks, stripTrailingSlashes, trimRepeatedChar } from './linearText';
import { isSecretPath } from './contextSnapshot';
import { hasFileOrPathAnchor } from './feedback/promptSignals';
import { findSkillFiles } from './skillUsage';
import { parseAssistantReply } from './assistant/assistantEngine';
import { stripGadgetFences } from './gadgets/answerText';
import { findGadgetFences, parseChatBlocks } from './gadgets/blockParser';
import { endpoint, formatGatewayErrorMessage } from './gateway/gatewayClient';
import { compactHistoryForReplay } from './gateway/wire';
import { extractProviderLimitMessage } from './providerLimitError';
import { canonicalCliModelId, cursorModelMetadata } from './providers/cliModelMetadata';
import { getKnownContextLength } from './providers/modelPricing';
import { providerDisplayName } from './providers/registry';
import { customProviderIdFor, normalizeApiPath } from './providers/customProviders';
import { mcpServerSlug } from './mcp/mcpServerConfig';
import { normalizeModelId, resolveDeliveryPublishCommand } from './deliveryWorkflow';
import { parseTierSuggestions } from './workflowModelRecommendation';

const N = 50_000;
const BUDGET_MS = 200;

function fast<T>(label: string, fn: () => T): T {
  const started = Date.now();
  const result = fn();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed}ms on adversarial input`);
  return result;
}

test('trailing-slash and repeated-char trimming match the regexes and stay linear', () => {
  for (const sample of ['', '/', '////', 'a', 'a/', 'a//b///', '//a', 'http://x.y/z/']) {
    assert.equal(stripTrailingSlashes(sample), sample.replace(/\/+$/, ''), sample);
    assert.equal(trimRepeatedChar(sample, '/'), sample.replace(/^\/+|\/+$/g, ''), sample);
  }
  for (const sample of ['---a--b---', '-', 'a', '--']) {
    assert.equal(trimRepeatedChar(sample, '-'), sample.replace(/^-+|-+$/g, ''), sample);
  }
  const slashes = `${'/'.repeat(N)}x`;
  fast('stripTrailingSlashes', () => stripTrailingSlashes(slashes));
  fast('trimRepeatedChar', () => trimRepeatedChar(`${'-'.repeat(N)}a`, '-'));
  fast('canonicalPath', () => canonicalPath(slashes));
  assert.equal(canonicalPath('.//a//b///'), 'a/b');
  fast('normalizeApiPath', () => normalizeApiPath(slashes));
  assert.equal(normalizeApiPath('v1//'), '/v1');
  fast('endpoint', () => endpoint({ url: slashes, apiPath: slashes } as never, '/x'));
  assert.equal(endpoint({ url: 'http://h//', apiPath: '/v1/' } as never, '/chat'), 'http://h/v1/chat');
  fast('mcpServerSlug', () => mcpServerSlug(`${'_'.repeat(N)}!`));
  assert.equal(mcpServerSlug('GitHub Tools'), 'github_tools');
  assert.equal(mcpServerSlug('  !! '), 'server');
  fast('customProviderIdFor', () => customProviderIdFor(`${'-'.repeat(N)}a`, []));
  assert.equal(customProviderIdFor('My Local LLM!', []), 'custom:my-local-llm');
  fast('normalizeModelId', () => normalizeModelId(`${'`'.repeat(N)}x`));
  assert.equal(normalizeModelId('`opus`'), normalizeModelId('opus'));
});

test('fenced block extraction matches the lazy regex and stays linear', () => {
  const samples = [
    'x ```json\n{"a":1}\n``` y',
    '```JSON   {"a":1}```',
    '```json\nunterminated',
    'no fence',
    '```json\n```\n```json\n{"b":2}```',
    '``` ```',
  ];
  for (const sample of samples) {
    const old = /```json\s*([\s\S]*?)```/i.exec(sample);
    const now = findFencedBody(sample, /```json/i);
    assert.equal(now?.body, old?.[1], sample);
    assert.equal(now?.full, old?.[0], sample);
    const oldBare = /```\s*([\s\S]*?)```/.exec(sample);
    assert.equal(findFencedBody(sample, /```/)?.body, oldBare?.[1], sample);
  }
  const repeated = '```json'.repeat(N / 7);
  fast('findFencedBody', () => findFencedBody(repeated, /```json/i));
  fast('parseTierSuggestions', () => {
    try { parseTierSuggestions(repeated, { id: 'w', name: 'w', stages: [] } as never); } catch { /* invalid JSON is expected */ }
  });
  fast('parseAssistantReply', () => parseAssistantReply('```praxis-assistant '.repeat(N / 20)));
  assert.equal(parseAssistantReply('hi\n```praxis-assistant\n{"choices":[]}\n```').text, 'hi');
  assert.equal(parseAssistantReply('plain').text, 'plain');
});

test('thinking blocks are stripped from replayed history, linearly', () => {
  assert.equal(stripTaggedBlocks('a<thought>x</thought>b<THINKING>y\nz</thinking>c', 'thought'), 'ab<THINKING>y\nz</thinking>c');
  assert.equal(stripTaggedBlocks('a<thought>never closed', 'thought'), 'a<thought>never closed');
  const out = compactHistoryForReplay([{ role: 'assistant', content: '<thinking>plan</thinking>answer' }]);
  assert.equal(out[0].content, 'answer');
  fast('stripTaggedBlocks', () => stripTaggedBlocks('<thought'.repeat(N / 8), 'thought'));
  fast('compactHistoryForReplay', () => compactHistoryForReplay([{ role: 'assistant', content: '<thinking'.repeat(N / 9) }]));
});

test('JSON object extraction from error bodies matches the regexes and stays linear', () => {
  assert.equal(formatGatewayErrorMessage(429, 'oops {"error":{"message":"slow down","code":7}} tail'), 'slow down (Code 7 · HTTP 429)');
  assert.equal(formatGatewayErrorMessage(500, '   '), 'Gateway returned HTTP 500');
  assert.match(extractProviderLimitMessage('Provider error: {"error":{"message":"You hit your usage limit"}}'), /usage limit/i);
  fast('formatGatewayErrorMessage', () => formatGatewayErrorMessage(500, '{'.repeat(N)));
  fast('extractProviderLimitMessage', () => extractProviderLimitMessage(`${'{'.repeat(N)}`));
});

test('gadget fences behave as before and stay linear', () => {
  const closed = 'before\n```praxis-gadget\n{"kind":"choice"}\n```\nafter';
  assert.equal(findGadgetFences(closed).length, 1);
  assert.equal(findGadgetFences(closed)[0].body, '{"kind":"choice"}\n');
  assert.equal(stripGadgetFences(closed), 'before\n\nafter'.replace('\n\n', '\n\n'));
  assert.equal(stripGadgetFences('keep\n  ```praxis-gadget\n{"half'), 'keep');
  assert.equal(stripGadgetFences('x```praxis-gadget\n{"a":"```"}\n```'), 'x');
  assert.equal(stripGadgetFences('no gadget here'), 'no gadget here');
  const opens = '```praxis-gadget\n'.repeat(N / 17);
  fast('findGadgetFences', () => findGadgetFences(opens));
  fast('stripGadgetFences', () => stripGadgetFences(opens));
  fast('stripGadgetFences blanks', () => stripGadgetFences(`${' '.repeat(N)}praxis-gadget`));
  fast('parseChatBlocks', () => parseChatBlocks(opens, {
    scope: { hostId: 'h', projectId: 'p', sessionId: 's', workId: 'w' },
    issuedAt: '2026-01-01T00:00:00.000Z',
    idPrefix: 'x'
  }));
});

test('secret path detection matches the old regex and stays linear', () => {
  const old = /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
  const samples = [
    '.env', '.ENV.local', 'app/.env', 'app/.env.production', '.env.d/x', '.envrc', 'env', '.env.',
    '.npmrc', 'home/.netrc', 'id_rsa', 'ssh/id_ed25519.pub', 'id_rsa.bak', 'certs/site.PEM', 'a.key', 'keyfile',
    'credentials', 'x/credentials.json', 'credentials.yaml', 'secret.yml', 'secrets.toml', 'secretsx.json', 'src/index.ts', '', '.env.a\nb'
  ];
  for (const sample of samples) assert.equal(isSecretPath(sample), old.test(sample), JSON.stringify(sample));
  fast('isSecretPath env', () => isSecretPath(`${'/.env.'.repeat(N / 6)}\n`));
  fast('isSecretPath dots', () => isSecretPath(`${'a.'.repeat(N / 2)}x`));
});

test('prompt anchors match the old pattern and stay linear', () => {
  const old = /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|cs|dart)\b|`[^`]{2,80}`|@[A-Za-z0-9_./-]{3,})/;
  const samples = [
    'fix src/app.ts', 'update app.ts please', 'see `foo`', 'ping @alice', 'a/b', '/a', 'a/', 'x //y', 'readme.md.', 'file.tsx now',
    '-.ts', '--.ts', '-a.ts', 'a-b.json', 'plain words only', 'v1.2 done', 'index.tsz', '.ts', 'x .ts', 'fix the bug', ''
  ];
  for (const sample of samples) assert.equal(hasFileOrPathAnchor(sample), old.test(sample), JSON.stringify(sample));
  fast('anchor run', () => hasFileOrPathAnchor('a'.repeat(N)));
  fast('anchor dashes', () => hasFileOrPathAnchor('a-'.repeat(N / 2)));
  fast('anchor dots', () => hasFileOrPathAnchor('.'.repeat(N)));
});

test('skill file detection matches the old pattern and stays linear', () => {
  const old = /((?:[^\s'"`<>|;&()]*\/)?skills\/([A-Za-z0-9][\w.-]*)\/SKILL\.md)(?![\w.])/gi;
  const samples = [
    'cat .claude/skills/foo/SKILL.md', 'read skills/bar/SKILL.md now', 'x/y-skills/z/SKILL.md', '(~/skills/q/SKILL.md)',
    'skills/a/SKILL.mdx', 'skills/skills/a/SKILL.md', 'a skills/x/SKILL.md and /b/skills/y/skill.md', 'skills/*/SKILL.md'
  ];
  for (const sample of samples) {
    assert.deepEqual(findSkillFiles(sample).map(m => [m.filePath, m.skillId]), [...sample.matchAll(old)].map(m => [m[1], m[2]]), sample);
  }
  fast('findSkillFiles', () => findSkillFiles('a/'.repeat(N / 2)));
  fast('findSkillFiles long', () => findSkillFiles(`${'x'.repeat(N)}/skills/`));
});

test('model id helpers match the old patterns and stay linear', () => {
  const oldCanon = (value: string) => value.toLowerCase().split('[')[0].replace(/\s*\([^)]*\)/g, '').trim();
  for (const sample of ['Claude Opus (thinking)', 'a  (x) b (y)', 'a (unclosed', '  (x)', 'GPT 5 (high)[context=1m]', 'plain']) {
    assert.equal(canonicalCliModelId(sample), canonicalCliModelId(oldCanon(sample)), sample);
  }
  assert.equal(canonicalCliModelId('Claude Opus (thinking)'), 'claude-opus');
  fast('canonicalCliModelId', () => canonicalCliModelId(' '.repeat(N)));
  fast('canonicalCliModelId parens', () => canonicalCliModelId('('.repeat(N)));

  const meta = (markdown: string) => cursorModelMetadata({ models: [{ name: 'm', tooltipData: { markdownContent: markdown } }] }).get('m')?.contextLength;
  assert.equal(meta('Supports 1,000k token context window'), 1_000_000);
  assert.equal(meta('200K context window'), 200_000);
  assert.equal(meta('no window here'), undefined);
  fast('cursor context window', () => meta('1'.repeat(N)));
  fast('cursor context window spaces', () => meta(`1${' '.repeat(N)}`));

  assert.equal(getKnownContextLength('gpt-5[context=272k,reasoning=high]', 'cursor-cli'), 272_000);
  assert.equal(getKnownContextLength('gpt-5[reasoning=high,context=1m]', 'cursor-cli'), 1_000_000);
  assert.equal(getKnownContextLength('gpt-5[reasoning=high]', 'cursor-cli'), undefined);
  fast('cursor context id', () => getKnownContextLength(`[${','.repeat(N)}`, 'cursor-cli'));
  fast('cursor context id nested', () => getKnownContextLength('['.repeat(N), 'cursor-cli'));

  assert.equal(providerDisplayName('claude-code'), providerDisplayName('claude-code'));
  fast('providerDisplayName', () => providerDisplayName(' '.repeat(N)));
});

test('PowerShell -File commands resolve as before and stay linear', () => {
  const worktree = 'C:\\work\\tree';
  const resolved = resolveDeliveryPublishCommand('pwsh -NoProfile -File .\\scripts\\publish.ps1 -Env prod', worktree);
  assert.match(resolved, /^pwsh -NoProfile -Command /);
  assert.match(resolved, /scripts\\publish\.ps1/);
  assert.match(resolved, / -Env prod/);
  assert.match(resolveDeliveryPublishCommand('powershell.exe -File "C:\\x y\\run.ps1"', worktree), /^powershell\.exe -Command /);
  assert.equal(resolveDeliveryPublishCommand('pwsh -Command ls', worktree), 'pwsh -Command ls');
  assert.equal(resolveDeliveryPublishCommand('pwsh -File', worktree), 'pwsh -File');
  assert.equal(resolveDeliveryPublishCommand('npm run publish', worktree), 'npm run publish');
  fast('resolveDeliveryPublishCommand spaces', () => resolveDeliveryPublishCommand(`pwsh${' '.repeat(N)}x`, worktree));
  fast('resolveDeliveryPublishCommand flags', () => resolveDeliveryPublishCommand(`pwsh ${'-File '.repeat(N / 6)}`, worktree));
});
