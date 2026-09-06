import { spawnCheck } from './workflowCheckProcess';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { app } from 'electron';
import type { StageDispatchContext, StageOutcome, WorkflowCheckNode } from '@praxis/core';

/**
 * Deterministic check execution (FX-BE-024 / TASK-112).
 *
 * A check's exit code decides its outcome — no model is involved, which is
 * exactly why a QA or security gate can rest on one. Output is captured to a
 * file under the run's artifact directory and reported as the node's declared
 * artifact, so a reviewer can read what the check actually said.
 */

const OUTPUT_TAIL = 4000;

/** `userData/workflow-artifacts/<runId>/<nodeId>/` — isolated per profile. */
export function runArtifactDir(runId: string, nodeId: string): string {
  return path.join(app.getPath('userData'), 'workflow-artifacts', runId, nodeId);
}

export async function runWorkflowCheck(
  node: WorkflowCheckNode,
  context: StageDispatchContext,
  fallbackCwd: string | undefined
): Promise<StageOutcome> {
  const cwd = context.worktreePath ?? fallbackCwd;
  if (!cwd) {
    return { status: 'failed', error: 'This check has no working directory; attach a folder to the project.' };
  }
  if (!node.command.trim()) {
    return { status: 'failed', error: 'This check has no command.' };
  }

  const successCodes = node.successExitCodes?.length ? node.successExitCodes : [0];
  const result = await spawnCheck(node, cwd, context.signal);

  const artifactPath = await writeOutput(context.run.runId, node.id, result.output).catch(() => undefined);
  const artifacts = node.outputs.map(contract => ({
    contractId: contract.id,
    kind: contract.kind,
    ...(artifactPath ? { path: artifactPath } : {})
  }));

  if (result.timedOut) {
    return { status: 'failed', error: `Check timed out after ${node.timeoutMs}ms.`, artifacts: [] };
  }
  if (result.error) {
    return { status: 'failed', error: result.error, artifacts: [] };
  }
  if (result.code !== null && successCodes.includes(result.code)) {
    return { status: 'succeeded', exitCode: result.code, artifacts };
  }

  return {
    status: 'failed',
    exitCode: result.code ?? undefined,
    // The tail is what a person needs to act; the whole log is in the artifact.
    error: `${node.command} exited ${result.code ?? 'without a code'}${
      result.output.trim() ? `:\n${tail(result.output)}` : '.'
    }`,
    artifacts
  };
}

async function writeOutput(runId: string, nodeId: string, output: string): Promise<string> {
  const dir = runArtifactDir(runId, nodeId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'output.log');
  await fs.writeFile(filePath, output, 'utf8');
  return filePath;
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
}
