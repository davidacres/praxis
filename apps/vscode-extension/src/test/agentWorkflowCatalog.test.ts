import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverWorkspaceAgentWorkflows,
  resolveWorkflowReference,
  resolveRelevantAgentWorkflow,
  resolveConfiguredAgentWorkflow
} from '@praxis/core';

async function createSkill(tempRoot: string, skillName: string, content: string): Promise<string> {
  const skillDir = path.join(tempRoot, '.github', 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

suite('agentWorkflowCatalog', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  test('discovers workspace workflow packs from .github/skills', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ticket-manager-workflow-'));
    tempDirs.push(tempRoot);

    await createSkill(
      tempRoot,
      'add-edit-dotnet-web-api',
      [
        '---',
        'name: add-edit-dotnet-web-api',
        'description: Multi-agent orchestration workflow for CRUD Web API delivery.',
        '---',
        '',
        '# Add/Edit .NET Web API Workflow',
        '',
        'Coordinates implementation, review, security, and test phases.'
      ].join('\n')
    );

    const workflows = await discoverWorkspaceAgentWorkflows(tempRoot);

    assert.strictEqual(workflows.length, 1);
    assert.deepStrictEqual(workflows[0], {
      id: 'add-edit-dotnet-web-api',
      name: 'Add/Edit .NET Web API Workflow',
      description: 'Multi-agent orchestration workflow for CRUD Web API delivery.',
      instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md',
      link: undefined
    });
  });

  test('discovers workflow packs from symlinked skill directories', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ticket-manager-workflow-'));
    tempDirs.push(tempRoot);

    const sharedSkillRoot = await mkdtemp(path.join(os.tmpdir(), 'ticket-manager-shared-skill-'));
    tempDirs.push(sharedSkillRoot);

    const sharedSkillDir = path.join(sharedSkillRoot, 'add-edit-dotnet-web-api');
    await mkdir(sharedSkillDir, { recursive: true });
    await writeFile(
      path.join(sharedSkillDir, 'SKILL.md'),
      [
        '---',
        'name: add-edit-dotnet-web-api',
        'description: Shared workflow loaded through a symlinked folder.',
        '---',
        '',
        '# Add/Edit .NET Web API Workflow'
      ].join('\n'),
      'utf8'
    );

    const skillsRoot = path.join(tempRoot, '.github', 'skills');
    await mkdir(skillsRoot, { recursive: true });
    await symlink(sharedSkillDir, path.join(skillsRoot, 'add-edit-dotnet-web-api'), 'junction');

    const workflows = await discoverWorkspaceAgentWorkflows(tempRoot);

    assert.strictEqual(workflows.length, 1);
    assert.deepStrictEqual(workflows[0], {
      id: 'add-edit-dotnet-web-api',
      name: 'Add/Edit .NET Web API Workflow',
      description: 'Shared workflow loaded through a symlinked folder.',
      instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md',
      link: undefined
    });
  });

  test('resolves a configured workflow directory to the repo-relative skill file', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ticket-manager-workflow-'));
    tempDirs.push(tempRoot);

    const skillDir = await createSkill(
      tempRoot,
      'add-edit-dotnet-web-api',
      [
        '---',
        'name: add-edit-dotnet-web-api',
        'description: Multi-agent orchestration workflow for CRUD Web API delivery.',
        '---',
        '',
        '# Add/Edit .NET Web API Workflow'
      ].join('\n')
    );

    const workflow = await resolveConfiguredAgentWorkflow({
      workspaceRoot: tempRoot,
      configuredPath: skillDir,
      workflowUrl: 'https://git.example/workflows/add-edit-dotnet-web-api'
    });

    assert.deepStrictEqual(workflow, {
      id: 'add-edit-dotnet-web-api',
      name: 'Add/Edit .NET Web API Workflow',
      description: 'Multi-agent orchestration workflow for CRUD Web API delivery.',
      instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md',
      link: 'https://git.example/workflows/add-edit-dotnet-web-api'
    });
  });

  test('matches a relevant workflow from issue text', () => {
    const resolution = resolveRelevantAgentWorkflow({
      issue: {
        issueType: 'Story',
        summary: 'Add an ASP.NET Core endpoint for device registration',
        description: 'Create a new .NET Web API controller and validation flow.'
      },
      workflows: [
        {
          id: 'add-edit-dotnet-web-api',
          name: 'Add/Edit .NET Web API Workflow',
          description: 'Workflow for ASP.NET Core REST API delivery.',
          instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md'
        },
        {
          id: 'frontend-ui',
          name: 'Frontend UI Workflow',
          description: 'Workflow for React pages and CSS refinements.',
          instructionsPath: '.github/skills/frontend-ui/SKILL.md'
        }
      ]
    });

    assert.strictEqual(resolution.workflow?.id, 'add-edit-dotnet-web-api');
    assert.ok(resolution.reason?.includes('.NET Web API') || resolution.reason?.includes('backend service'));
  });

  test('recommends workflow types when no relevant workflow is found', () => {
    const resolution = resolveRelevantAgentWorkflow({
      issue: {
        issueType: 'Story',
        summary: 'Refresh the settings page layout',
        description: 'Update the React UI and CSS to match the latest mockup.'
      },
      workflows: []
    });

    assert.strictEqual(resolution.workflow, undefined);
    assert.ok(resolution.recommendations.includes('UI or frontend implementation workflow'));
  });

  test('resolves an explicit workflow reference by name or id', () => {
    const workflows = [
      {
        id: 'add-edit-dotnet-web-api',
        name: 'Add/Edit .NET Web API Workflow',
        description: 'Workflow for ASP.NET Core REST API delivery.',
        instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md'
      },
      {
        id: 'frontend-ui',
        name: 'Frontend UI Workflow',
        description: 'Workflow for React pages and CSS refinements.',
        instructionsPath: '.github/skills/frontend-ui/SKILL.md'
      }
    ];

    assert.strictEqual(
      resolveWorkflowReference('Workflow pack: add-edit-dotnet-web-api', workflows)?.id,
      'add-edit-dotnet-web-api'
    );
    assert.strictEqual(
      resolveWorkflowReference('Add/Edit .NET Web API Workflow', workflows)?.id,
      'add-edit-dotnet-web-api'
    );
  });
});