import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PROVIDER_DESCRIPTORS,
  buildStageContext,
  buildStageTaskDefinition,
  preflightStage,
  stageOutcomeFromSession,
  stageSessionKey,
  type FinishedStageSession,
  type IssueDetails,
  type StageDispatchContext,
  type StageOutcome,
  type WorkflowAgentTaskNode
} from '@praxis/core';
import {
  abortActiveTask,
  getAcpAgentHost,
  getAiSessionManager,
  getCopilotAgentHost,
  getVercelAgentService,
  hasActiveTask,
  resolveAcpStartOptions,
  resolveConnectionOptions,
  resolveCopilotStartOptions
} from './aiInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getWorkflowPolicyStore } from './workflowStoreInstance';
import { workflowLogSink } from './workflowLogSink';

/**
 * Agent stages as real, attributed sessions (FX-BE-025 / TASK-114, TASK-115).
 *
 * Implements the orchestrator's `runAgentStage`: preflight the binding, build
 * the closed stage brief, start the session on whichever host the provider
 * needs, wait for it to settle, freeze the worktree for a mutating stage, and
 * hand the outcome back.
 *
 * The session key is derived from the run and node, so a replay or a recovery
 * re-attaches to the same session record rather than forking a second one.
 */

const run = promisify(execFile);

/** Whether the app can drive agent stages at all right now. */
export function canDispatchAgentStage(): boolean {
  const settings = getSettingsBackend().read();
  return !!settings.ai.activeProvider;
}

export async function runWorkflowAgentStage(
  node: WorkflowAgentTaskNode,
  dispatch: StageDispatchContext,
  onSession: (sessionId: string) => void
): Promise<StageOutcome> {
  dispatch.signal?.throwIfAborted();
  const workflowRun = dispatch.run;
  const worktreePath = dispatch.worktreePath;
  if (!worktreePath) {
    return { status: 'failed', error: 'This stage needs a run worktree; attach a git folder to the project.' };
  }

  // Fail closed before anything starts: an untrusted, invalid, unavailable, or
  // capability-incompatible agent must never open a session.
  const snapshot = await getAgentRuntimeManager().list();
  const policy = getWorkflowPolicyStore().effectiveForProject(workflowRun.projectId)?.profile;
  const preflight = preflightStage(
    node,
    { agents: snapshot.agents, skills: snapshot.skills, capabilities: snapshot.capabilities },
    policy
  );
  if (!preflight.ok || !preflight.binding) {
    return {
      status: 'failed',
      error: preflight.failures
        .map(failure => `${failure.message} ${failure.remediation}`)
        .join(' ')
    };
  }

  dispatch.signal?.throwIfAborted();
  const context = buildStageContext(workflowRun, node.id, preflight.binding);
  if (!context) return { status: 'failed', error: `Stage ${node.id} is not part of this run.` };

  const issueKey = stageSessionKey(workflowRun.runId, node.id);
  const sessions = getAiSessionManager();
  const settings = getSettingsBackend().read();
  const provider = settings.ai.activeProvider;
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  const taskDefinition = buildStageTaskDefinition(context);

  // A synthetic issue: the session store is issue-keyed, and a stage is not a
  // ticket, so it carries the run/node key instead.
  const issue = {
    key: issueKey,
    summary: `${workflowRun.definition.name} — ${context.stageName}`,
    issueType: 'Task',
    status: 'In progress',
    projectKey: 'WORKFLOW'
  } as IssueDetails;

  const toolMode = preflight.binding.toolMode;
  const settled = waitForSession(issueKey);

  try {
    if (preflight.binding.skills.length > 0) {
      const activations = await Promise.all(
        preflight.binding.skills.map(skill =>
          getAgentRuntimeManager().activateSkill(preflight.binding!.agentId, skill.name)
        )
      );
      taskDefinition.goal += `\n\nActivated runtime skills:\n${activations
        .map(item => `## ${item.skill.metadata.name}\n${item.instructions}`)
        .join('\n\n')}`;
    }

    dispatch.signal?.throwIfAborted();
    if (descriptor.kind === 'cli-agent' && descriptor.hostKind === 'copilot-sdk') {
      const { runtimePath, model } = resolveCopilotStartOptions(provider);
      await getCopilotAgentHost().startTask(issue, taskDefinition, provider, {
        runtimePath,
        model,
        workingDirectory: worktreePath,
        toolMode
      });
    } else if (descriptor.kind === 'cli-agent') {
      const { command, args } = resolveAcpStartOptions(provider);
      await getAcpAgentHost().startTask(issue, taskDefinition, provider, {
        command,
        args,
        workingDirectory: worktreePath,
        toolMode
      });
    } else {
      const gateway = await resolveConnectionOptions(provider);
      dispatch.signal?.throwIfAborted();
      if (!gateway.apiKey) {
        settled.cancel();
        return { status: 'failed', error: `No ${descriptor.label} API key configured for workflow stages.` };
      }
      await getVercelAgentService().startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory: worktreePath,
        model: gateway.model,
        provider,
        toolMode
      });
    }
  } catch (error) {
    settled.cancel();
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  // Cancellation can arrive while the provider is still starting its task.
  if (dispatch.signal?.aborted) await abortActiveTask(issueKey);

  const record = sessions.getAgentSession(issueKey);
  if (record) {
    onSession(record.sessionId);
    // Attribution: what makes this session traceable back to its run and node.
    sessions.updateAgentRuntime(issueKey, {
      workingDirectory: worktreePath,
      worktreePath,
      toolMode,
      workflowRunId: workflowRun.runId,
      workflowNodeId: node.id
    });
  }

  const finished = await settled.promise;
  const snapshotRef = node.mutatesWorktree && !dispatch.signal?.aborted && finished.state === 'completed'
    ? await freezeWorktree(worktreePath, context.stageName)
    : undefined;

  return stageOutcomeFromSession(node, {
    ...finished,
    ...(snapshotRef ? { snapshotRef } : {})
  });
}

export async function cancelWorkflowAgentStage(runId: string, nodeId: string): Promise<void> {
  const issueKey = stageSessionKey(runId, nodeId);
  if (hasActiveTask(issueKey)) await abortActiveTask(issueKey);
}

/** Resolves when the stage's session reaches a terminal state. */
function waitForSession(issueKey: string): { promise: Promise<FinishedStageSession>; cancel: () => void } {
  const sessions = getAiSessionManager();
  let dispose: (() => void) | undefined;

  const promise = new Promise<FinishedStageSession>(resolve => {
    const settle = (state: FinishedStageSession['state']): void => {
      const record = sessions.getAgentSession(issueKey);
      dispose?.();
      resolve({ state, ...(record?.responseText ? { responseText: record.responseText } : {}) });
    };

    const subscription = sessions.onDidChangeAgentSession(record => {
      if (record.issueKey !== issueKey) return;
      if (record.state === 'completed') settle('completed');
      else if (record.state === 'failed') settle('failed');
      else if (record.state === 'aborted') settle('aborted');
    });
    dispose = () => subscription.dispose();
  });

  return { promise, cancel: () => dispose?.() };
}

/**
 * Commits whatever the stage changed and returns the sha.
 *
 * The commit is the stage's immutable snapshot — every verification stage
 * downstream inspects that ref rather than the branch, which keeps a later
 * writer from moving the ground under a review already in flight. A stage that
 * changed nothing returns the existing HEAD.
 */
async function freezeWorktree(worktreePath: string, stageName: string): Promise<string | undefined> {
  try {
    const status = await run('git', ['status', '--porcelain'], { cwd: worktreePath });
    if (status.stdout.trim()) {
      await run('git', ['add', '-A'], { cwd: worktreePath });
      await run('git', ['commit', '-m', `${stageName} (workflow stage)`], { cwd: worktreePath });
    }
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    return head.stdout.trim() || undefined;
  } catch (error) {
    workflowLogSink.appendLine(
      `Could not freeze the worktree for "${stageName}": ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
