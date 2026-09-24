import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  buildStageContext,
  buildStageTaskDefinition,
  discoverWorkspaceAgentWorkflows,
  extractProviderLimitMessage,
  isProviderLimitError,
  preflightStage,
  stageOutcomeFromSession,
  stageSessionKey,
  chooseStageModel,
  formatUpstreamReports,
  formatUpstreamLogs,
  parsePublishablePlan,
  planIssueInputs,
  projectConnectionId,
  nodeOutputs,
  stageProvider,
  type FinishedStageSession,
  type AiProvider,
  type IssueDetails,
  type StageDispatchContext,
  type StageOutcome,
  type WorkflowAgentTaskNode,
  type WorkflowBoardReference,
  type WorkflowRun
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
import { getServiceForConnection } from './serviceRegistry';
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
  // The stage's AI: one it was switched to in this run, its own choice, the run's, or the selected AI.
  const runProvider = workflowRun.aiProvider || settings.ai.activeProvider;
  const provider = stageProvider(workflowRun, node.id, runProvider) as AiProvider;
  const taskDefinition = buildStageTaskDefinition(stageContext);

  // Hand the stage what earlier stages concluded, so it does not start cold and re-derive it. A report
  // artifact has no file; its text is the producing stage session's final response.
  const upstream = formatUpstreamReports(
    stageContext.inputs
      .filter(input => !input.path)
      .map(input => ({
        contractId: input.contractId,
        stageName: workflowRun.definition.nodes.find(candidate => candidate.id === input.nodeId)?.name ?? input.nodeId,
        text: getAiSessionManager().getAgentSession(stageSessionKey(workflowRun.runId, input.nodeId))?.responseText ?? ''
      }))
  );
  if (upstream) taskDefinition.scope += `\n\n${upstream}`;

  // A check's log lives in the evidence store, outside the worktree the agent's file tools are
  // confined to — so it travels inline, or the stage would be told of output it cannot read.
  const logs = formatUpstreamLogs(
    await Promise.all(
      stageContext.inputs
        .filter(input => input.kind === 'log' && input.path)
        .map(async input => ({
          contractId: input.contractId,
          stageName: workflowRun.definition.nodes.find(candidate => candidate.id === input.nodeId)?.name ?? input.nodeId,
          text: await readFile(input.path as string, 'utf8').catch(() => '')
        }))
    )
  );
  if (logs) taskDefinition.scope += `\n\n${logs}`;

  // Attempts that judged the stage and failed. The one launching now is not among them, and one
  // that stopped without a verdict (provider limit, environment) never spent the stage.
  const failedAttempts = (workflowRun.nodes[node.id]?.attempts ?? []).filter(
    attempt => attempt.outcome === 'failed' && !attempt.pause
  ).length;
  // A model id belongs to the AI it was chosen for: the stage's exact model only
  // on the stage's own AI, the run's model only on the run's AI.
  const switched = Boolean(workflowRun.stageProviders?.[node.id]);
  const ownProvider = node.agent.providerId?.trim();
  const modelChoice = chooseStageModel({
    node: !switched && (!ownProvider || ownProvider === provider) ? node : { ...node, model: undefined },
    provider,
    tiers: settings.ai.modelTiers,
    runModel: provider === runProvider ? workflowRun.aiModel : undefined,
    attemptsSpent: failedAttempts
  });

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
      ...(modelChoice.model ? { model: modelChoice.model } : {}),
      workingDirectory: worktreePath,
      toolMode,
      autoApprovePermissions: workflowRun.permissionMode === 'auto'
    });
    skillActivations = prepared.skillActivations;
  } catch (error) {
    settled.cancel();
    // A launch refused for credits/quota/budget is the account's problem, not the stage's:
    // pause the run rather than spend the stage's attempt on it.
    const isLimit = isProviderLimitError(error);
    const errorMessage = isLimit
      ? extractProviderLimitMessage(error)
      : error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: errorMessage,
      provider,
      ...(isLimit ? { pause: 'provider-limit' as const } : {})
    };
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
      ...(workflowRun.controllerSessionKey ? { parentSessionKey: workflowRun.controllerSessionKey } : {}),
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

  const outcome = stageOutcomeFromSession(node, {
    ...finished,
    ...(snapshotRef ? { snapshotRef } : {})
  });
  return { ...(await publishPlanOutputs(node, workflowRun, outcome, finished.responseText)), provider };
}

/**
 * Creates a stage's `publishTo: 'board'` plan on the run's project board once the stage has
 * succeeded, and records the feature's key on the artifact. A plan that cannot be read or created
 * fails the stage with the reason, so a retry is told exactly what to fix.
 */
async function publishPlanOutputs(
  node: WorkflowAgentTaskNode,
  run: WorkflowRun,
  outcome: StageOutcome,
  responseText: string | undefined
): Promise<StageOutcome> {
  const contracts = nodeOutputs(node).filter(contract => contract.publishTo === 'board');
  if (outcome.status !== 'succeeded' || contracts.length === 0) return outcome;
  try {
    const reference = await publishPlanToBoard(run, responseText);
    workflowLogSink.appendLine(`[workflow ${run.runId}] ${node.name} created plan ${reference.key} with ${reference.itemKeys.length} items on the board.`);
    return {
      ...outcome,
      artifacts: (outcome.artifacts ?? []).map(artifact =>
        contracts.some(contract => contract.id === artifact.contractId) ? { ...artifact, reference } : artifact
      )
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function publishPlanToBoard(run: WorkflowRun, responseText: string | undefined): Promise<WorkflowBoardReference> {
  const plan = parsePublishablePlan(responseText);
  const service = await getServiceForConnection(projectConnectionId(run.projectId));
  // The board's own key: a folder board's `board.praxis.json` can name a different key from the
  // Praxis project's, and the board refuses items filed under any other.
  const projectKey = (await service.getProjects())[0]?.key ?? getProjectStore().get(run.projectId)?.key;
  if (!projectKey) throw new Error('The run\'s project has no board to create the plan on.');
  const inputs = planIssueInputs(plan, projectKey);
  const feature = await service.createIssue(inputs.feature).catch(error => {
    throw new Error(`Could not create the plan on the board: ${error instanceof Error ? error.message : String(error)}`);
  });
  const itemKeys: string[] = [];
  for (const item of inputs.items(feature.key)) {
    try {
      itemKeys.push((await service.createIssue(item)).key);
    } catch (error) {
      throw new Error(
        `Plan ${feature.key} was created, but only ${itemKeys.length} of ${plan.items.length} items were added before the board refused "${item.summary}": ${error instanceof Error ? error.message : String(error)}. Finish or delete ${feature.key} on the board before retrying, or the retry creates a second plan.`
      );
    }
  }
  return { key: feature.key, title: feature.summary, itemKeys };
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
      const limitCandidate = (record?.lastError && isProviderLimitError(record.lastError))
        ? record.lastError
        : (record?.responseText && isProviderLimitError(record.responseText))
          ? record.responseText
          : undefined;
      const isLimit = Boolean(record?.providerLimitReached || limitCandidate);
      const effectiveLastError = limitCandidate
        ? extractProviderLimitMessage(limitCandidate)
        : record?.lastError;
      resolve({
        state,
        ...(record?.responseText ? { responseText: record.responseText } : {}),
        ...(effectiveLastError ? { lastError: effectiveLastError } : {}),
        ...(isLimit ? { providerLimitReached: true } : {})
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
