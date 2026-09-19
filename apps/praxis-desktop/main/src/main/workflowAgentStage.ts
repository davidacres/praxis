import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  buildStageContext,
  buildStageTaskDefinition,
  discoverWorkspaceAgentWorkflows,
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
  getAiSessionManager,
  hasActiveTask
} from './aiInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getWorkflowPolicyStore } from './workflowStoreInstance';
import { getProjectStore } from './projectStoreInstance';
import { workflowLogSink } from './workflowLogSink';
import { launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';

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
const MAX_WORKFLOW_PACK_BYTES = 48_000;

function getProjectRoot(projectId: string): string | undefined {
  return getProjectStore().get(projectId)?.workspaceFolder?.trim() || undefined;
}

async function resolveStageWorkflowPack(
  workspaceRoot: string,
  workflowPackId: string | undefined
): Promise<import('@praxis/core').WorkflowPackContext | undefined> {
  const requested = workflowPackId?.trim();
  if (!requested) return undefined;

  const workflows = await discoverWorkspaceAgentWorkflows(workspaceRoot);
  const reference = workflows.find(candidate =>
    candidate.id === requested ||
    candidate.name === requested ||
    candidate.instructionsPath === requested ||
    path.basename(path.dirname(candidate.instructionsPath)) === requested
  );
  if (!reference) {
    throw new Error(`Workflow pack "${requested}" was not found under ${path.join(workspaceRoot, '.github', 'skills')}.`);
  }

  const instructionsPath = path.isAbsolute(reference.instructionsPath)
    ? reference.instructionsPath
    : path.resolve(workspaceRoot, reference.instructionsPath);
  const relative = path.relative(workspaceRoot, instructionsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Workflow pack "${requested}" resolves outside the project workspace.`);
  }

  const instructions = await readFile(instructionsPath, 'utf8');
  if (Buffer.byteLength(instructions, 'utf8') > MAX_WORKFLOW_PACK_BYTES) {
    throw new Error(`Workflow pack "${requested}" is larger than the ${MAX_WORKFLOW_PACK_BYTES}-byte stage limit.`);
  }
  return {
    reference,
    instructions,
    provenance: {
      source: 'workspace',
      resolutionMode: 'content',
      fingerprint: createHash('sha256').update(instructions, 'utf8').digest('hex'),
      ...(reference.version ? { version: reference.version } : {})
    }
  };
}

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
    { agents: snapshot.agents, runtimeHosts: snapshot.runtimeHosts, profiles: snapshot.profiles, skills: snapshot.skills, capabilities: snapshot.capabilities },
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
  const projectRoot = getProjectRoot(workflowRun.projectId);
  if (node.workflowPackId && !projectRoot) {
    return { status: 'failed', error: 'This stage declares a workflow pack, but its project has no workspace folder.' };
  }
  const workflowPack = projectRoot
    ? await resolveStageWorkflowPack(projectRoot, node.workflowPackId)
    : undefined;
  const stageContext = workflowPack ? { ...context, workflowPack } : context;

  const issueKey = stageSessionKey(workflowRun.runId, node.id);
  const sessions = getAiSessionManager();
  const settings = getSettingsBackend().read();
  const provider = settings.ai.activeProvider;
  if (preflight.binding.providerId && preflight.binding.providerId !== provider) {
    return {
      status: 'failed',
      error: `Stage requires provider "${preflight.binding.providerId}" but "${provider}" is active.`
    };
  }
  const taskDefinition = buildStageTaskDefinition(stageContext);

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
  let skillActivations: Array<{ skillId: string; mode: 'native' | 'tools' | 'context'; version?: string }> = [];

  try {
    const skillNames = preflight.binding.skills.map(skill => skill.name);
    const prepared = await prepareAgentLaunch({
      profileId: preflight.binding.profileId,
      hostId: preflight.binding.hostId,
      provider,
      skillNames
    });
    if (prepared.binding) taskDefinition.goal += `\n\n${await getAgentRuntimeManager().bindingContext(prepared.binding)}`;

    dispatch.signal?.throwIfAborted();
    await launchAgentTask(prepared, {
      issue,
      taskDefinition,
      provider,
      workingDirectory: worktreePath,
      toolMode
    });
    skillActivations = prepared.skillActivations;
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
      workflowNodeId: node.id,
      workflowId: workflowRun.workflowId,
      workflowVersion: workflowRun.workflowVersion,
      workflowRole: 'stage',
      agentId: preflight.binding.hostId,
      profileId: preflight.binding.profileId,
      hostId: preflight.binding.hostId,
      activeSkills: preflight.binding.skills.map(skill => skill.name),
      skillActivations
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
      resolve({
        state,
        ...(record?.responseText ? { responseText: record.responseText } : {}),
        ...(record?.lastError ? { lastError: record.lastError } : {})
      });
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
