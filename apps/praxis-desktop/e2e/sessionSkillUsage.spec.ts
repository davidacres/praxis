import * as fs from 'node:fs';
import { openSession } from './sessionNavigation';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * Which agent and skills a session used: skills Praxis attached at launch, and
 * skills the AI loaded itself (its Skill tool, or reading a SKILL.md), detected
 * from the session's tool calls. A session recorded before detection existed is
 * scanned the first time it is opened.
 */

let app: TestApp | undefined;
const shots = path.resolve(__dirname, '../../.praxis/session-artifacts');

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('a session shows its agent and the skills it used, and a skill lists the sessions that used it', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();

  const at = (minute: number) => `2026-10-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
  fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({
    'praxis.agentSessions': {
      'SESSION-SKILLS': {
        issueKey: 'SESSION-SKILLS',
        sessionId: 'skills-session',
        title: 'Plan the scheduled run',
        state: 'completed',
        startedAt: at(0),
        completedAt: at(9),
        provider: 'claude-code-cli',
        profileId: 'praxis-planner',
        activeSkills: ['plan-authoring'],
        taskDefinition: { goal: 'Plan the scheduled run', sessionMode: 'chat' },
        stepCount: 3,
        eventCount: 3,
        events: []
      }
    }
  }));
  const transcripts = path.join(profile.userDataDir, 'ai-transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, 'skills-session.json'), JSON.stringify({
    events: [
      { timestamp: at(1), type: 'tool_start', summary: 'Running tool: cat', data: { toolName: 'cat .agents/skills/plan-authoring/SKILL.md', kind: 'shell' } },
      { timestamp: at(2), type: 'tool_start', summary: 'Running tool: Skill', data: { toolName: 'Skill', args: { skill: 'praxis-scheduled-runs' } } },
      { timestamp: at(3), type: 'message', summary: 'Assistant', detail: 'Prepared the request file.' }
    ]
  }));

  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  const win = app.window;
  await openSession(win, 'SESSION-SKILLS');

  const block = win.getByTestId('session-agent-skills');
  await expect(block).toBeVisible();
  await expect(block.getByTestId('session-agent')).toHaveText('praxis-planner');
  const skill = (name: string) => block.locator(`[data-testid="session-skill"][data-skill="${name}"]`);
  // Attached by Praxis, and the AI was seen reading it: evidence it was applied.
  await expect(skill('plan-authoring')).toHaveAttribute('data-usage', 'attached-loaded');
  await expect(skill('plan-authoring')).toContainText('attached · loaded by the AI');
  // Never attached; the AI loaded it on its own.
  await expect(skill('praxis-scheduled-runs')).toHaveAttribute('data-usage', 'detected');
  await expect(skill('praxis-scheduled-runs')).toContainText('loaded by the AI');
  fs.mkdirSync(shots, { recursive: true });
  await win.keyboard.press('Escape');
  await win.mouse.move(700, 400);
  await win.screenshot({ path: path.join(shots, 'session-agent-and-skills.png') });

  // The detection is saved with the session, not recomputed for display only.
  await expect.poll(() => {
    const stored = JSON.parse(fs.readFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), 'utf8'));
    return (stored['praxis.agentSessions']['SESSION-SKILLS'].detectedSkills ?? []).map((use: { skillId: string }) => use.skillId);
  }).toEqual(['plan-authoring', 'praxis-scheduled-runs']);

  // The skill's Agent Hub record lists the session that used it.
  await skill('praxis-scheduled-runs').getByRole('button', { name: 'praxis-scheduled-runs' }).click();
  await expect(win.getByRole('main').getByRole('heading', { name: 'Scheduled Run Authoring', level: 1 })).toBeVisible();
  const usedBy = win.getByTestId('agent-runtime-sessions-block');
  await expect(usedBy).toContainText('Used by (1)');
  await expect(usedBy.getByTestId('agent-runtime-session-card')).toContainText('Plan the scheduled run');
  await expect(usedBy.locator('[data-testid="session-skill"][data-skill="praxis-scheduled-runs"]')).toHaveAttribute('data-usage', 'detected');
  await win.mouse.move(700, 400);
  await win.screenshot({ path: path.join(shots, 'skill-used-by.png') });
});
