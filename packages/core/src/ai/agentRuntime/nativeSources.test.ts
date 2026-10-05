import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildSessionInstructions,
  discoverNativeSources,
  findProjectRoot,
  mergeById,
  parseNativeAgent,
  summarizeDescription,
  toolModeFromList,
  type NativeSourceOptions
} from './nativeSources';
import { AgentRuntimeManager } from './manager';
import { yamlScalar } from './skillRegistry';
import { mergeAppSettings, sanitizeAppSettings } from '../../config/appSettings';

async function put(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}

const SHARED_RULES = '# Conventions\n\nUse tabs. Run the tests before committing.';

/** A repository and a home folder laid out the way each tool documents. */
async function fixture(): Promise<{ project: string; home: string; praxisData: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-native-'));
  const project = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const praxisData = path.join(base, 'praxis');
  await mkdir(path.join(project, '.git'), { recursive: true });
  await put(project, 'AGENTS.md', SHARED_RULES);
  await put(project, 'CLAUDE.md', `${SHARED_RULES}\n`); // same rules, whitespace aside
  await put(project, 'GEMINI.md', 'Prefer small functions.');
  await put(project, '.github/copilot-instructions.md', 'Write JSDoc for exported functions.');
  await put(project, '.github/instructions/api.instructions.md', '---\napplyTo: "src/api/**"\n---\nValidate every request body.');
  await put(project, '.cursor/rules/style.mdc', '---\ndescription: Style\nalwaysApply: true\n---\nNo default exports.');
  await put(project, '.cursor/rules/tests.mdc', '---\nglobs: "**/*.test.ts"\nalwaysApply: false\n---\nOne assertion per test.');
  await put(
    project,
    '.claude/agents/reviewer.md',
    '---\nname: repo-reviewer\ndescription: Use this agent to review a change before merge.\\n\\n<example>\\nuser: review\\n</example>\ntools: Read, Grep, Glob\nmodel: sonnet\n---\n\nYou review changes carefully.'
  );
  await put(project, '.github/agents/docs-writer.agent.md', '---\ndescription: Writes and updates documentation.\ntools: ["read", "edit"]\n---\nYou write documentation.');
  await put(project, '.gemini/agents/researcher.md', '---\nname: researcher\ndescription: Researches libraries.\n---\nYou research.');
  await put(project, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploys the service.\n---\nSteps.');
  await put(project, '.agents/skills/changelog/SKILL.md', '---\nname: changelog\ndescription: Writes changelog entries.\n---\nSteps.');
  await put(home, '.claude/agents/csharp-reviewer.md', '---\nname: csharp-reviewer\ndescription: Reviews C# code.\n---\nYou review C#.');
  await put(home, '.claude/skills/dotnet-solid-dry/SKILL.md', '---\nname: dotnet-solid-dry\ndescription: SOLID and DRY for .NET (personal copy).\n---\nPersonal rules.');
  await put(home, '.codex/skills/playwright/SKILL.md', '---\nname: playwright\ndescription: Drives a browser.\n---\nSteps.');
  await put(home, '.codex/AGENTS.md', 'Personal Codex preferences.');
  await put(home, '.gemini/GEMINI.md', 'Personal Gemini preferences.');
  await put(praxisData, 'skills/dotnet-solid-dry/SKILL.md', '---\nname: dotnet-solid-dry\ndescription: Built-in SOLID and DRY review.\n---\nBuilt-in rules.');
  return { project, home, praxisData };
}

function options(project: string, home: string, projectApproved = true): NativeSourceOptions {
  return { projectRoot: project, homeDir: home, projectApproved };
}

test('finds the project root from a nested folder by its .git', async () => {
  const { project } = await fixture();
  await mkdir(path.join(project, 'apps', 'web'), { recursive: true });
  assert.equal(await findProjectRoot(path.join(project, 'apps', 'web')), project);
});

test('discovers each tool’s instructions, agents and skills with their native readers', async () => {
  const { project, home } = await fixture();
  const found = await discoverNativeSources(options(project, home));

  const instructions = Object.fromEntries(found.instructions.map(file => [file.displayPath, file]));
  assert.deepEqual(Object.keys(instructions).sort(), [
    '.cursor/rules/style.mdc',
    '.cursor/rules/tests.mdc',
    '.github/copilot-instructions.md',
    '.github/instructions/api.instructions.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '~/.codex/AGENTS.md',
    '~/.gemini/GEMINI.md'
  ]);
  assert.deepEqual(instructions['AGENTS.md']!.readBy, ['codex-cli', 'copilot-cli']);
  assert.deepEqual(instructions['CLAUDE.md']!.readBy, ['claude-code-cli']);
  assert.equal(instructions['.github/instructions/api.instructions.md']!.alwaysApplies, false);
  assert.equal(instructions['.github/instructions/api.instructions.md']!.appliesTo, 'src/api/**');
  assert.equal(instructions['.cursor/rules/style.mdc']!.alwaysApplies, true);
  assert.equal(instructions['.cursor/rules/tests.mdc']!.alwaysApplies, false);
  assert.equal(instructions['~/.codex/AGENTS.md']!.scope, 'user');

  const agents = Object.fromEntries(found.agents.map(entry => [entry.profile.id, entry]));
  assert.deepEqual(Object.keys(agents).sort(), ['csharp-reviewer', 'docs-writer', 'repo-reviewer', 'researcher']);
  assert.equal(agents['repo-reviewer']!.source?.ecosystem, 'claude');
  assert.equal(agents['repo-reviewer']!.profile.description, 'Use this agent to review a change before merge.');
  assert.equal(agents['repo-reviewer']!.profile.toolMode, 'read-only');
  assert.equal(agents['docs-writer']!.source?.ecosystem, 'copilot');
  assert.equal(agents['docs-writer']!.profile.toolMode, undefined, 'edit is a write tool');
  assert.equal(agents['researcher']!.source?.ecosystem, 'gemini');
  assert.equal(agents['csharp-reviewer']!.source?.scope, 'user');

  const skills = Object.fromEntries(found.skills.map(skill => [skill.metadata.name, skill]));
  assert.deepEqual(Object.keys(skills).sort(), ['changelog', 'deploy', 'dotnet-solid-dry', 'playwright']);
  assert.deepEqual(skills['changelog']!.source?.readBy, ['codex-cli', 'copilot-cli']);
  assert.deepEqual(skills['playwright']!.source?.readBy, ['codex-cli']);
});

test('project files stay untrusted until the project is approved; the user’s own are trusted', async () => {
  const { project, home } = await fixture();
  const found = await discoverNativeSources(options(project, home, false));
  assert.ok(found.agents.filter(entry => entry.source?.scope === 'project').every(entry => !entry.trusted));
  assert.ok(found.skills.filter(skill => skill.source?.scope === 'project').every(skill => !skill.trusted));
  assert.ok(found.agents.filter(entry => entry.source?.scope === 'user').every(entry => entry.trusted));
});

test('turning a tool off stops reading its folders', async () => {
  const { project, home } = await fixture();
  const found = await discoverNativeSources({ ...options(project, home), enabled: { claude: false, cursor: false } });
  assert.equal(found.agents.some(entry => entry.source?.ecosystem === 'claude'), false);
  assert.equal(found.instructions.some(file => file.ecosystem === 'claude' || file.ecosystem === 'cursor'), false);
  assert.ok(found.instructions.some(file => file.displayPath === 'AGENTS.md'));
});

test('agent files parse into profiles with readable names and descriptions', () => {
  const copilot = parseNativeAgent('---\nname: Accessibility Checker\ndescription: Checks a11y.\n---\nBody.', 'a11y.agent.md', '.agent.md');
  assert.equal(copilot.profile.id, 'a11y');
  assert.equal(copilot.profile.name, 'Accessibility Checker');
  const claude = parseNativeAgent('---\nname: csharp-dotnet-code-reviewer\n---\nBody.', 'x.md', '.md');
  assert.equal(claude.profile.name, 'Csharp Dotnet Code Reviewer');
  assert.match(parseNativeAgent('---\nname: empty\n---\n', 'empty.md', '.md').error ?? '', /no instructions/);
  assert.equal(summarizeDescription('A'.repeat(400))!.length <= 241, true);
  assert.equal(toolModeFromList('Read, Grep'), 'read-only');
  assert.equal(toolModeFromList('Read, Bash'), undefined);
  assert.equal(toolModeFromList('*'), undefined);
});

test('instructions are given only to runtimes that do not read them, once, AGENTS.md first', async () => {
  const { project, home } = await fixture();
  const { instructions } = await discoverNativeSources(options(project, home));
  const names = (runtime: string) => buildSessionInstructions(instructions, runtime, { projectApproved: true }).included.map(file => file.displayPath);

  // Claude Code reads CLAUDE.md itself; everything else always-applying is added.
  assert.deepEqual(names('claude-code-cli'), ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/style.mdc']);
  // Codex reads AGENTS.md; CLAUDE.md carries the same rules, so it comes in once, as CLAUDE.md.
  assert.deepEqual(names('codex-cli'), ['CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/style.mdc']);
  // Copilot reads AGENTS.md and its own instructions.
  assert.deepEqual(names('copilot-cli'), ['CLAUDE.md', 'GEMINI.md', '.cursor/rules/style.mdc']);
  // Cursor reads .cursorrules and .cursor/rules/*.mdc.
  assert.deepEqual(names('cursor-cli'), ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']);
  // An API provider reads nothing: AGENTS.md, and CLAUDE.md is a duplicate of it.
  const api = buildSessionInstructions(instructions, 'anthropic', { projectApproved: true });
  assert.deepEqual(api.included.map(file => file.displayPath), ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/style.mdc']);
  assert.deepEqual(api.skipped.find(file => file.displayPath === 'CLAUDE.md'), { displayPath: 'CLAUDE.md', reason: 'duplicate' });
  assert.deepEqual(api.skipped.find(file => file.displayPath === '.github/instructions/api.instructions.md')?.reason, 'path-specific');
  assert.deepEqual(api.skipped.find(file => file.displayPath === '~/.codex/AGENTS.md')?.reason, 'user-scope');
  assert.match(api.text, /^## Project instructions/);
  assert.match(api.text, /### AGENTS\.md\n\n# Conventions/);

  const unapproved = buildSessionInstructions(instructions, 'anthropic', { projectApproved: false });
  assert.equal(unapproved.text, '');
  assert.ok(unapproved.skipped.every(file => file.reason === 'untrusted' || file.reason === 'user-scope'));
});

test('one catalog entry per id: Praxis’s own first, then project, user, built-in', () => {
  type Item = { id: string; scope: string; builtIn?: boolean; source?: { ecosystem: 'claude'; scope: 'project' | 'user'; path: string; readBy: [] }; alsoIn?: string[] };
  const items: Item[] = [
    { id: 'a', scope: 'global', builtIn: true },
    { id: 'a', scope: 'global', source: { ecosystem: 'claude', scope: 'user', path: '/u', readBy: [] } },
    { id: 'b', scope: 'global', source: { ecosystem: 'claude', scope: 'user', path: '/u', readBy: [] } },
    { id: 'b', scope: 'project', source: { ecosystem: 'claude', scope: 'project', path: '/p', readBy: [] } },
    { id: 'c', scope: 'global', source: { ecosystem: 'claude', scope: 'project', path: '/p', readBy: [] } },
    { id: 'c', scope: 'global' }
  ];
  const merged = Object.fromEntries(mergeById(items, item => item.id).map(item => [item.id, item]));
  assert.equal(merged.a!.source?.scope, 'user');
  assert.deepEqual(merged.a!.alsoIn, ['Praxis built-in']);
  assert.equal(merged.b!.source?.scope, 'project');
  assert.deepEqual(merged.b!.alsoIn, ['Claude Code · your user folder']);
  assert.equal(merged.c!.source, undefined, 'a Praxis copy replaces the tool file it came from');
});

test('the runtime manager lists other tools’ items, gives agents a session-runtime host, and never double-loads skills', async () => {
  const { project, home, praxisData } = await fixture();
  const manager = new AgentRuntimeManager({
    skillRoots: [path.join(praxisData, 'skills')],
    trustedSkillRoots: [path.join(praxisData, 'skills')],
    profileRoots: [],
    includeBundled: true,
    nativeSources: () => options(project, home)
  });
  const snapshot = await manager.refresh();

  const reviewer = snapshot.profiles?.find(entry => entry.profile.id === 'repo-reviewer');
  assert.equal(reviewer?.source?.ecosystem, 'claude');
  const host = snapshot.runtimeHosts?.find(candidate => candidate.manifest.id === 'repo-reviewer');
  assert.equal(host?.followsSessionRuntime, true);
  assert.equal(host?.manifest.entry, 'session');

  // The personal Claude copy of dotnet-solid-dry wins over the installed built-in.
  const dotnet = snapshot.skills.find(skill => skill.metadata.name === 'dotnet-solid-dry');
  assert.equal(dotnet?.source?.ecosystem, 'claude');
  assert.deepEqual(dotnet?.alsoIn, ['Praxis built-in']);
  assert.equal(snapshot.instructions?.some(file => 'content' in file), false, 'contents stay in the main process');
  assert.equal(manager.nativeInstructionFiles().find(file => file.displayPath === 'AGENTS.md')?.content, SHARED_RULES);
  assert.deepEqual(snapshot.nativeProject, { root: project, approved: true, itemCount: 12 });

  // On Claude Code the Claude skill is loaded natively; on an API provider Praxis supplies it.
  const onClaude = await manager.createBinding('repo-reviewer', 'repo-reviewer', { id: 'claude-code-cli' }, ['deploy', 'changelog']);
  assert.deepEqual(onClaude.activations.map(activation => [activation.skillId, activation.mode, activation.instructionsIncluded]), [
    ['deploy', 'native', false],
    ['changelog', 'context', true]
  ]);
  const onApi = await manager.createBinding('repo-reviewer', 'repo-reviewer', { id: 'anthropic' }, ['deploy']);
  assert.deepEqual(onApi.activations.map(activation => [activation.mode, activation.instructionsIncluded]), [['context', true]]);
});

test('native source settings are sanitised and merge field by field', () => {
  const settings = sanitizeAppSettings({ ai: { nativeSources: { ecosystems: { claude: false, bogus: true }, approvedProjects: ['/a', '/a'], injectInstructions: 'yes' } } });
  assert.deepEqual(settings.ai.nativeSources, { ecosystems: { claude: false }, approvedProjects: ['/a'], injectInstructions: true, instructionSource: 'all', extraSkillPaths: [], extraAgentPaths: [] });
  const merged = mergeAppSettings(settings, { ai: { nativeSources: { ecosystems: { cursor: false }, approvedProjects: ['/a', '/b'] } } });
  assert.deepEqual(merged.ai.nativeSources.ecosystems, { claude: false, cursor: false });
  assert.deepEqual(merged.ai.nativeSources.approvedProjects, ['/a', '/b']);
  assert.equal(sanitizeAppSettings({}).ai.nativeSources.injectInstructions, true);
});

test('quoted front-matter values are decoded, not shown with their escapes', () => {
  assert.equal(yamlScalar('"Set up \\"AI Runway\\" on AKS."'), 'Set up "AI Runway" on AKS.');
  assert.equal(yamlScalar("'It''s fine'"), "It's fine");
  assert.equal(yamlScalar('plain value'), 'plain value');
  assert.equal(yamlScalar('"unbalanced \\" quote'), '"unbalanced \\" quote');
});

test('an instruction file too large for a session is left out and flagged in the snapshot', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-native-large-'));
  const repo = path.join(base, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await put(repo, 'AGENTS.md', 'x'.repeat(30_000));
  await put(repo, 'CLAUDE.md', 'Small and useful.');
  const options: NativeSourceOptions = { projectRoot: repo, homeDir: path.join(base, 'home'), projectApproved: true };
  const { instructions } = await discoverNativeSources(options);
  const built = buildSessionInstructions(instructions, 'gateway', { projectApproved: true });
  assert.deepEqual(built.skipped.map(item => [item.displayPath, item.reason]), [['AGENTS.md', 'size-limit']]);
  assert.match(built.text, /Small and useful/);
  const manager = new AgentRuntimeManager({ skillRoots: [], profileRoots: [], nativeSources: () => options });
  const snapshot = await manager.refresh();
  const flags = Object.fromEntries((snapshot.instructions ?? []).map(file => [file.displayPath, file.tooLargeForSessions]));
  assert.deepEqual(flags, { 'AGENTS.md': true, 'CLAUDE.md': false });
});

test('with one tool chosen as the source, only its instruction files are added', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'praxis-native-source-'));
  const repo = path.join(base, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await put(repo, 'AGENTS.md', 'Shared: PELICAN.');
  await put(repo, 'CLAUDE.md', 'Claude: CORMORANT.');
  await put(repo, 'GEMINI.md', 'Gemini: GANNET.');
  const { instructions } = await discoverNativeSources({ projectRoot: repo, homeDir: path.join(base, 'home'), projectApproved: true });
  const claudeOnly = buildSessionInstructions(instructions, 'gateway', { projectApproved: true, source: 'claude' });
  assert.match(claudeOnly.text, /CORMORANT/);
  assert.doesNotMatch(claudeOnly.text, /PELICAN|GANNET/);
  assert.deepEqual(claudeOnly.skipped.filter(item => item.reason === 'other-source').map(item => item.displayPath).sort(), ['AGENTS.md', 'GEMINI.md']);
  // Codex reads AGENTS.md itself; with Claude's files as the source it still gets CLAUDE.md.
  assert.match(buildSessionInstructions(instructions, 'codex-cli', { projectApproved: true, source: 'claude' }).text, /CORMORANT/);
  // Claude Code reads CLAUDE.md itself, so nothing is added.
  assert.equal(buildSessionInstructions(instructions, 'claude-code-cli', { projectApproved: true, source: 'claude' }).text, '');
  assert.match(buildSessionInstructions(instructions, 'gateway', { projectApproved: true, source: 'all' }).text, /PELICAN[\s\S]*CORMORANT/);
});
