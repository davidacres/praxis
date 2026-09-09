/**
 * GitHub Actions deployment orchestration (FX-BE-061 / TASK-162-163).
 *
 * Orchestrates deployments via GitHub Actions, handling both dispatch mode
 * (TASK-162 — trigger a new workflow run) and observe mode (TASK-163 —
 * correlate an already-triggered run).
 *
 * Like `directDeploymentOrchestrator.ts`, this module composes existing
 * pieces — the GitHub Actions executor and observer, the `DeploymentRun`
 * state machine, and the run store — and does not reimplement core logic.
 *
 * **Observe-only mode** allows a deployment to attach to an existing workflow
 * run rather than triggering a new one. This is useful when:
 * - A merge trigger has already started a workflow via GitHub's push/PR events
 * - The deployment wants to attach to and monitor that run, not duplicate it
 *
 * The profile's `executor.observeOnly` flag controls the mode:
 * - `false` or absent: dispatch mode (default, TASK-162 path)
 * - `true`: observe mode (TASK-163 path)
 */

import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';
import type {
  DeploymentProfile,
  PublishedArtifact,
  GitHubActionsExecutorRef
} from '../projects/deploymentProfile';
import {
  applyDeploymentRunCommand,
  createDeploymentRun,
  type DeploymentRun,
  type DeploymentTargetLockRegistry
} from '../projects/deploymentRunState';
import type { DeploymentRunStore } from '../projects/deploymentRunStore';
import { GitHubActionsDeploymentExecutor, validateDispatchRequest } from './githubActionsExecutor';
import { GitHubActionsObserver, type WorkflowRunCorrelationOutcome } from './githubActionsObserver';

// ── Prepare ──────────────────────────────────────────────────────────────

export interface PrepareGitHubActionsDeploymentInput {
  store: DeploymentRunStore;
  runId: string;
  profile: DeploymentProfile;
  artifact: PublishedArtifact;
  now: () => string;
  issueKey?: string;
  issueConnectionId?: string;
  workflowRunId?: string;
  targetUrl?: string;
}

/**
 * Creates and persists a fresh GitHub Actions deployment run.
 * Same semantics as `prepareDirectDeployment` — a no-op-safe entry point.
 */
export async function prepareGitHubActionsDeployment(input: PrepareGitHubActionsDeploymentInput): Promise<DeploymentRun> {
  const run = createDeploymentRun({
    runId: input.runId,
    deploymentProfileId: input.profile.id,
    profileVersion: input.profile.version,
    environment: input.profile.environment,
    artifactId: input.artifact.id,
    artifactDigest: input.artifact.digest,
    at: input.now(),
    issueKey: input.issueKey,
    issueConnectionId: input.issueConnectionId,
    workflowRunId: input.workflowRunId,
    targetUrl: input.targetUrl
  });
  await input.store.save(run);
  return run;
}

// ── Observe ──────────────────────────────────────────────────────────────

export interface ObserveGitHubActionsDeploymentInput {
  store: DeploymentRunStore;
  runId: string;
  profile: DeploymentProfile;
  artifact: PublishedArtifact;
  config: GitHubActionsConfig;
  now: () => string;
  /** For testing: custom fetch implementation passed to the observer. */
  fetchImpl?: typeof fetch;
}

export interface ObserveGitHubActionsDeploymentResult {
  attached: boolean;
  run: DeploymentRun;
  reason?: string;
  /** When `attached` is false and multiple candidates exist, return them for explicit selection. */
  candidates?: Array<{ id: number; workflowName: string; status: string; htmlUrl: string }>;
}

/**
 * Observe mode: correlate an already-triggered workflow run with this
 * deployment. This is only valid when the profile's executor is in observe-only mode.
 *
 * The correlation outcome determines whether a single run is automatically
 * attached, multiple candidates are returned for selection, or no suitable run
 * is found (error case).
 */
export async function observeGitHubActionsDeployment(
  input: ObserveGitHubActionsDeploymentInput
): Promise<ObserveGitHubActionsDeploymentResult> {
  const existing = requireRun(input.store, input.runId);
  const executor = input.profile.executor as GitHubActionsExecutorRef;

  // Observe mode only makes sense from 'queued' state
  const started = applyDeploymentRunCommand(existing, { kind: 'start-deploying', at: input.now() });
  if (started === existing) {
    return {
      attached: false,
      run: existing,
      reason: `Run status is "${existing.status}", not queued; nothing to observe.`
    };
  }
  await input.store.save(started);

  const observer = new GitHubActionsObserver(input.config, input.fetchImpl);
  let outcome: WorkflowRunCorrelationOutcome;

  try {
    // Extract workflow ID from the workflowFile (e.g., ".github/workflows/deploy.yml" → "deploy.yml")
    const workflowName = executor.workflowFile.split('/').pop() || executor.workflowFile;
    outcome = await observer.correlateWorkflowRun(workflowName, input.artifact.sourceCommit, input.profile.environment);
  } catch (error) {
    const failed = applyDeploymentRunCommand(started, {
      kind: 'health-failed',
      at: input.now(),
      error: error instanceof Error ? error.message : String(error)
    });
    await input.store.save(failed);
    return {
      attached: false,
      run: failed,
      reason: `Failed to correlate workflow run: ${failed.endedReason}`
    };
  }

  switch (outcome.kind) {
    case 'single-candidate': {
      const run = outcome.run;
      let current = applyDeploymentRunCommand(started, {
        kind: 'record-external-id',
        at: input.now(),
        externalId: `github-actions:${run.id}:${run.attempt}`
      });
      current = applyDeploymentRunCommand(current, { kind: 'start-verifying', at: input.now() });
      current = applyDeploymentRunCommand(current, {
        kind: 'health-verified',
        at: input.now()
      });
      await input.store.save(current);
      return { attached: true, run: current };
    }

    case 'multiple-candidates': {
      // Multiple candidates found — return them for explicit selection
      let current = applyDeploymentRunCommand(started, { kind: 'start-verifying', at: input.now() });
      const failed = applyDeploymentRunCommand(current, {
        kind: 'health-failed',
        at: input.now(),
        error: `Multiple workflow runs found for SHA ${input.artifact.sourceCommit.kind === 'commit' ? input.artifact.sourceCommit.sha : 'unknown'}; explicit selection required.`
      });
      await input.store.save(failed);
      return {
        attached: false,
        run: failed,
        reason: 'Multiple candidates found',
        candidates: outcome.runs.map(r => ({
          id: r.id,
          workflowName: r.workflowName,
          status: r.status,
          htmlUrl: r.htmlUrl
        }))
      };
    }

    case 'no-candidates': {
      let current = applyDeploymentRunCommand(started, { kind: 'start-verifying', at: input.now() });
      const failed = applyDeploymentRunCommand(current, {
        kind: 'health-failed',
        at: input.now(),
        error: `No workflow run found matching the artifact's source commit (${
          input.artifact.sourceCommit.kind === 'commit' ? input.artifact.sourceCommit.sha : 'unknown'
        }).`
      });
      await input.store.save(failed);
      return {
        attached: false,
        run: failed,
        reason: 'No workflow run found for this commit SHA'
      };
    }

    case 'stale-run': {
      // A run was found but for a different SHA than expected
      let current = applyDeploymentRunCommand(started, { kind: 'start-verifying', at: input.now() });
      const failed = applyDeploymentRunCommand(current, {
        kind: 'health-failed',
        at: input.now(),
        error: `Run ${outcome.run.id} is from commit ${outcome.run.sha}, not the expected ${outcome.expectedSha} — stale run rejected.`
      });
      await input.store.save(failed);
      return {
        attached: false,
        run: failed,
        reason: 'Rejected stale run from different commit'
      };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function requireRun(store: DeploymentRunStore, runId: string): DeploymentRun {
  const run = store.get(runId);
  if (!run) {
    throw new Error(`Deployment run "${runId}" not found in store.`);
  }
  return run;
}
