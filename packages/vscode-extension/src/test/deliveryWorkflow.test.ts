import * as assert from 'node:assert';
import {
  buildDeliveryAnalysisTaskDefinition,
  buildDeliverySuccessComment,
  buildPollingAnalysisReadyComment,
  buildDeliveryStartedComment,
  buildDeliveryTaskDefinition,
  extractAgentProviderDirective,
  extractDeliveryBaseBranch,
  parseDeliveryAnalysisResult,
  parseDeliveryTaskResult,
  resolveDeliveryPublishCommand
} from '@ticket-manager/core';

suite('deliveryWorkflow', () => {
  test('extracts the most recent explicit base branch from Jira comments', () => {
    const branch = extractDeliveryBaseBranch({
      description: '**Branch:** main',
      comments: [
        {
          id: 'comment-1',
          body: 'Base branch: release/1.2',
          created: '2026-04-15T10:00:00.000Z'
        },
        {
          id: 'comment-2',
          body: 'Base branch: feature/hotfix-123',
          created: '2026-04-15T11:00:00.000Z'
        }
      ]
    });

    assert.strictEqual(branch, 'feature/hotfix-123');
  });

  test('falls back to the Jira description when no branch marker exists in comments', () => {
    const branch = extractDeliveryBaseBranch({
      description: 'Implementation details\n\n**Branch:** release/2026.04',
      comments: [
        {
          id: 'comment-1',
          body: 'No branch marker here.',
          created: '2026-04-15T10:00:00.000Z'
        }
      ]
    });

    assert.strictEqual(branch, 'release/2026.04');
  });

  test('builds a delivery task definition with a structured completion contract', () => {
    const task = buildDeliveryTaskDefinition(
      {
        key: 'KAMAI-39',
        summary: 'Ship the MSI delivery change',
        issueType: 'Story',
        status: 'Selected for Development',
        description: 'Implement the requested workflow.'
      },
      {
        baseBranch: 'main',
        branchName: 'KAMAI-39-ship-the-msi-delivery-change',
        worktreePath: 'C:/worktrees/KAMAI-39-ship-the-msi-delivery-change',
        publishCommand: 'pwsh ./build-msi.ps1',
        artifactPattern: 'dist/*.msi',
        workflow: {
          id: 'add-edit-dotnet-web-api',
          name: 'Add/Edit .NET Web API Workflow',
          instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md'
        }
      }
    );

    assert.strictEqual(task.kind, 'jira-delivery');
    assert.ok(task.completionContract?.includes('DELIVERY_RESULT'));
    assert.ok(task.completionContract?.includes('"buildIdentifier"'));
    assert.ok(task.definitionOfDone.includes('dist/*.msi'));
    assert.strictEqual(task.workflow?.id, 'add-edit-dotnet-web-api');
  });

  test('builds an analysis-only delivery task definition for the first session', () => {
    const task = buildDeliveryAnalysisTaskDefinition(
      {
        key: 'KAMAI-39',
        summary: 'Ship the MSI delivery change',
        issueType: 'Story',
        status: 'Selected for Development',
        description: 'Implement the requested workflow.'
      },
      {
        baseBranch: 'main',
        branchName: 'KAMAI-39-ship-the-msi-delivery-change',
        worktreePath: 'C:/worktrees/KAMAI-39-ship-the-msi-delivery-change',
        publishCommand: 'pwsh ./build-msi.ps1',
        artifactPattern: 'dist/*.msi'
      }
    );

    assert.strictEqual(task.kind, 'jira-delivery');
    assert.ok(task.goal.includes('Analyze whether KAMAI-39'));
    assert.ok(task.completionContract?.includes('DELIVERY_ANALYSIS_RESULT'));
    assert.ok(task.nonGoals?.includes('Do not begin implementation in this analysis session.'));
  });

  test('builds a Jira start comment that includes the assigned workflow link', () => {
    const comment = buildDeliveryStartedComment({
      baseBranch: 'main',
      branchName: 'KAMAI-39-ship-the-msi-delivery-change',
      worktreeName: 'KAMAI-39-ship-the-msi-delivery-change',
      workflow: {
        id: 'add-edit-dotnet-web-api',
        name: 'Add/Edit .NET Web API Workflow',
        description: 'Multi-agent orchestration workflow for CRUD Web API work.',
        instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md',
        link: 'https://git.example/workflows/add-edit-dotnet-web-api'
      }
    });

    assert.ok(comment.includes('AI delivery workflow started'));
    assert.ok(comment.includes('Workflow: Add/Edit .NET Web API Workflow'));
    assert.ok(comment.includes('.github/skills/add-edit-dotnet-web-api/SKILL.md'));
    assert.ok(comment.includes('https://git.example/workflows/add-edit-dotnet-web-api'));
  });

  test('builds a polling analysis ready comment before delivery starts', () => {
    const comment = buildPollingAnalysisReadyComment();

    assert.ok(comment.includes('AI readiness analysis passed'));
    assert.ok(comment.includes('Analysis result: READY'));
    assert.ok(comment.includes('Ticket Manager is now preparing the delivery workflow.'));
  });

  test('rewrites powershell file publish commands to be worktree-scoped', () => {
    const command = resolveDeliveryPublishCommand(
      String.raw`powershell -ExecutionPolicy Bypass -File .\scripts\build-installer-msi.ps1 -Configuration Release -RuntimeIdentifier win-x64`,
      String.raw`C:\dev\system-configurator\.worktrees\KAMAI-44-test`
    );

    assert.ok(command.includes('powershell -ExecutionPolicy Bypass -Command'));
    assert.ok(command.includes(String.raw`Set-Location -LiteralPath 'C:\dev\system-configurator\.worktrees\KAMAI-44-test'`));
    assert.ok(command.includes(String.raw`& 'C:\dev\system-configurator\.worktrees\KAMAI-44-test\scripts\build-installer-msi.ps1' -Configuration Release -RuntimeIdentifier win-x64`));
  });

  test('keeps non-powershell publish commands unchanged', () => {
    const command = resolveDeliveryPublishCommand(
      'dotnet publish src/App/App.csproj -c Release',
      String.raw`C:\dev\system-configurator\.worktrees\KAMAI-44-test`
    );

    assert.strictEqual(command, 'dotnet publish src/App/App.csproj -c Release');
  });

  test('prepends the reporter mention to the delivery success comment', () => {
    const comment = buildDeliverySuccessComment(
      {
        status: 'success',
        summary: 'Implemented the requested change.',
        branch: 'KAMAI-45-implemented-change',
        artifactPaths: ['publish/installer/SystemConfigurator.msi']
      },
      {
        reporterMention: '[~accountid:abc123]'
      }
    );

    assert.ok(comment.startsWith('**THIS IS AN AI-GENERATED MESSAGE.**'));
    assert.ok(comment.includes('[~accountid:abc123] Implementation summary'));
  });

  test('falls back to reporter name when no Jira mention token exists', () => {
    const comment = buildDeliverySuccessComment(
      {
        status: 'success',
        summary: 'Implemented the requested change.',
        branch: 'KAMAI-45-implemented-change',
        artifactPaths: ['publish/installer/SystemConfigurator.msi']
      },
      {
        reporterName: 'David Acres'
      }
    );

    assert.ok(comment.startsWith('**THIS IS AN AI-GENERATED MESSAGE.**'));
    assert.ok(comment.includes('@David Acres Implementation summary'));
  });

  test('parses a structured delivery result payload', () => {
    const payload = [
      'Work complete.',
      '',
      'DELIVERY_RESULT',
      '',
      '```json',
      '{',
      '  "status": "success",',
      '  "summary": "Implemented the worktree-backed delivery workflow and added Jira MSI attachment support.",',
      '  "branch": "KAMAI-39-ship-the-msi-delivery-change",',
      '  "commitHash": "abc1234",',
      '  "pushedRef": "origin/KAMAI-39-ship-the-msi-delivery-change",',
      '  "buildIdentifier": "01",',
      '  "artifactPaths": ["dist/TicketManager-KAMAI-39.msi"]',
      '}',
      '```'
    ].join('\n');
    const result = parseDeliveryTaskResult(payload);

    assert.deepStrictEqual(result, {
      status: 'success',
      summary: 'Implemented the worktree-backed delivery workflow and added Jira MSI attachment support.',
      branch: 'KAMAI-39-ship-the-msi-delivery-change',
      commitHash: 'abc1234',
      pushedRef: 'origin/KAMAI-39-ship-the-msi-delivery-change',
      buildIdentifier: '01',
      artifactPaths: ['dist/TicketManager-KAMAI-39.msi'],
      failureReason: undefined
    });
  });

  test('parses a structured delivery analysis result payload', () => {
    const result = parseDeliveryAnalysisResult([
      'Analysis complete.',
      '',
      'DELIVERY_ANALYSIS_RESULT',
      '',
      '```json',
      '{',
      '  "status": "ready",',
      '  "summary": "The ticket is ready for implementation in the prepared worktree.",',
      '  "implementationPlan": "1. Update the workflow orchestration. 2. Add tests. 3. Validate packaging.",',
      '  "blockers": []',
      '}',
      '```'
    ].join('\n'));

    assert.deepStrictEqual(result, {
      status: 'ready',
      summary: 'The ticket is ready for implementation in the prepared worktree.',
      implementationPlan: '1. Update the workflow orchestration. 2. Add tests. 3. Validate packaging.',
      blockers: []
    });
  });

  test('rejects malformed delivery results that omit artifact paths on success', () => {
    const result = parseDeliveryTaskResult(`DELIVERY_RESULT\n\n\`\`\`json
{
  "status": "success",
  "summary": "Done.",
  "branch": "KAMAI-39-work-item",
  "artifactPaths": []
}
\`\`\``);

    assert.strictEqual(result, undefined);
  });

  test('extractAgentProviderDirective maps "use claude code" to vercel-gateway', () => {
    const provider = extractAgentProviderDirective({
      description: 'Implement the new feature.\n\nuse claude code',
      comments: []
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });

  test('extractAgentProviderDirective detects "use copilot" in description', () => {
    const provider = extractAgentProviderDirective({
      description: 'Ship this fix.\n\nuse copilot',
      comments: []
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });

  test('extractAgentProviderDirective detects "Agent: claude" in a comment', () => {
    const provider = extractAgentProviderDirective({
      description: 'Some work item.',
      comments: [
        { id: '1', body: 'Agent: claude', created: '2026-04-15T10:00:00.000Z' }
      ]
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });

  test('extractAgentProviderDirective prefers most recent comment over description', () => {
    const provider = extractAgentProviderDirective({
      description: 'use copilot',
      comments: [
        { id: '1', body: 'use vercel', created: '2026-04-15T10:00:00.000Z' }
      ]
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });

  test('extractAgentProviderDirective returns undefined when no directive found', () => {
    const provider = extractAgentProviderDirective({
      description: 'Just a regular ticket with no agent preference.',
      comments: []
    });
    assert.strictEqual(provider, undefined);
  });

  test('extractAgentProviderDirective detects "use github copilot" case-insensitively', () => {
    const provider = extractAgentProviderDirective({
      description: 'Use GitHub Copilot for this task.',
      comments: []
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });

  test('extractAgentProviderDirective detects "CLI: copilot" format', () => {
    const provider = extractAgentProviderDirective({
      description: 'CLI: copilot\n\nImplement the feature.',
      comments: []
    });
    assert.strictEqual(provider, 'vercel-gateway');
  });
});