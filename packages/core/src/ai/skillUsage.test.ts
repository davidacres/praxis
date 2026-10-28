import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEventSummary, AgentToolEventData } from './agentTypes';
import { detectSkillUses, mergeDetectedSkillUses } from './skillUsage';

function tool(data: AgentToolEventData, at = '2026-10-26T10:00:00.000Z', summary = `Running tool: ${data.toolName ?? ''}`): AgentEventSummary {
  return { timestamp: at, type: 'tool_start', summary, data };
}

const ids = (events: AgentEventSummary[]) => detectSkillUses(events).map(use => `${use.skillId}:${use.via}`);

test('Claude Code Skill tool calls are detected by their argument', () => {
  assert.deepEqual(ids([tool({ toolName: 'Skill', args: { skill: 'praxis-scheduled-runs' } })]), ['praxis-scheduled-runs:skill-tool']);
  assert.deepEqual(ids([tool({ toolName: 'Skill', args: { command: '/plan-authoring' } })]), ['plan-authoring:skill-tool']);
  assert.deepEqual(ids([tool({ toolName: 'Skill: visual-verification' })]), ['visual-verification:skill-tool']);
  assert.deepEqual(ids([tool({ toolName: 'Skill', args: { skill: 'anthropic-skills:pdf' } })]), ['anthropic-skills:pdf:skill-tool']);
});

test('reading a SKILL.md file is detected, as Codex does through file reads and shell commands', () => {
  assert.deepEqual(ids([tool({ toolName: "Read file '/Users/me/.codex/skills/playwright/SKILL.md'", kind: 'read' })]), ['playwright:skill-file']);
  const shell = tool({
    toolName: 'cat packages/core/src/ai/AGENTS.md; cat /Users/me/.codex/plugins/cache/x/skills/fix-finding/SKILL.md; sed -n 1,240p .agents/skills/plan-authoring/SKILL.md',
    kind: 'shell'
  });
  const uses = detectSkillUses([shell]);
  assert.deepEqual(uses.map(use => use.skillId), ['fix-finding', 'plan-authoring']);
  assert.equal(uses[1].path, '.agents/skills/plan-authoring/SKILL.md');
  assert.deepEqual(ids([tool({ toolName: 'Read', kind: 'read', args: { file_path: '/repo/.claude/skills/human-review/SKILL.md' } })]), ['human-review:skill-file']);
});

test('searches, globs, writes and unrelated events are not skill loads', () => {
  assert.deepEqual(ids([
    tool({ toolName: "rg --files -g 'SKILL.md' -g 'AGENTS.md'", kind: 'shell' }),
    tool({ toolName: 'ls .agents/skills/*/SKILL.md', kind: 'shell' }),
    tool({ toolName: 'find .agents/skills -name SKILL.md', kind: 'shell' }),
    tool({ toolName: 'Write', kind: 'write', args: { file_path: '.agents/skills/new-skill/SKILL.md' } }),
    tool({ toolName: 'Edit', args: { file_path: '.agents/skills/new-skill/SKILL.md' } }),
    tool({ toolName: "cat > .agents/skills/new-skill/SKILL.md <<'EOF'", kind: 'shell' }),
    tool({ toolName: 'Skill', args: {} }),
    { timestamp: '2026-10-26T10:00:00.000Z', type: 'message', summary: 'See skills/plan-authoring/SKILL.md' }
  ]), []);
});

test('uses are aggregated per skill with counts, first and last times, and the stronger source', () => {
  const first = mergeDetectedSkillUses(undefined, detectSkillUses([
    tool({ toolName: 'cat .agents/skills/plan-authoring/SKILL.md', kind: 'shell' }, '2026-10-26T10:00:00.000Z')
  ]));
  const merged = mergeDetectedSkillUses(first, detectSkillUses([
    tool({ toolName: 'Skill', args: { skill: 'plan-authoring' } }, '2026-10-26T11:00:00.000Z'),
    tool({ toolName: 'Skill', args: { skill: 'human-review' } }, '2026-10-26T11:30:00.000Z')
  ]));
  assert.deepEqual(merged, [
    { skillId: 'plan-authoring', via: 'skill-tool', firstAt: '2026-10-26T10:00:00.000Z', lastAt: '2026-10-26T11:00:00.000Z', count: 2, path: '.agents/skills/plan-authoring/SKILL.md' },
    { skillId: 'human-review', via: 'skill-tool', firstAt: '2026-10-26T11:30:00.000Z', lastAt: '2026-10-26T11:30:00.000Z', count: 1 }
  ]);
  assert.equal(first?.length, 1, 'merging does not mutate the earlier list');
  assert.equal(first?.[0].count, 1);
});
