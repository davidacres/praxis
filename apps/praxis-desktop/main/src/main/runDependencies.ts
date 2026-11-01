import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowCheckNode, WorkflowDefinition } from '@praxis/core';
import type { CheckProcessResult } from './workflowCheckProcess';
import { removeEscapingDependencyLinks } from './worktreeDependencyLinks';

/**
 * Gives a run's worktree its dependencies, and its build output, before the first agent stage works in it.
 *
 * A run's worktree is a fresh checkout with no `node_modules`, and the workflow's own install stage
 * comes after Implement and Review. That suits a ticket that only edits code, but not one whose work
 * *is* running things: TASK-503 ("run full UI validation and preserve visual evidence") could build
 * nothing, test nothing and screenshot nothing, wrote a "blocked" report, and Review sent it back to
 * Implement four times with the worktree just as empty each time. Installing up front, with the
 * workflow's own install command, lets every stage use the project's tools.
 *
 * Build output is just as absent, and an agent that builds only the parts it thinks of leaves the rest
 * missing: TASK-503's Implement built core, renderer and desktop but not mobile-protocol, so every test
 * app it launched died at startup with `Cannot find module …/mobile-protocol/out/index.js`. So straight
 * after the install the workflow's Build stage runs too. A build that fails is reported, not fatal — a
 * stage may be there to fix exactly that.
 *
 * Only a workflow that has an install stage gets one, and only when the worktree has none yet:
 * npm's hidden lockfile (`node_modules/.package-lock.json`) is what a finished install leaves.
 */

export interface RunDependencyPorts {
  spawn(node: WorkflowCheckNode, cwd: string, signal?: AbortSignal): Promise<CheckProcessResult>;
  report?(message: string): void;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The workflow's build stage: a check that runs a package manager's `build` script. */
export function buildStageOf(definition: Pick<WorkflowDefinition, 'nodes'>): WorkflowCheckNode | undefined {
  return definition.nodes.find((node): node is WorkflowCheckNode => {
    if (node.type !== 'check') return false;
    const program = path.basename(node.command).replace(/\.(cmd|exe)$/i, '');
    return PACKAGE_MANAGERS.has(program) && node.args?.[0] === 'run' && node.args[1] === 'build';
  });
}

/** The workflow's install stage: a check that runs a package manager's `ci` or `install`. */
export function installStageOf(definition: Pick<WorkflowDefinition, 'nodes'>): WorkflowCheckNode | undefined {
  return definition.nodes.find((node): node is WorkflowCheckNode => {
    if (node.type !== 'check') return false;
    const program = path.basename(node.command).replace(/\.(cmd|exe)$/i, '');
    return PACKAGE_MANAGERS.has(program) && ['ci', 'install', 'i'].includes(node.args?.[0] ?? '');
  });
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/** Whether this worktree is a package-manager project with no completed install. */
export async function needsInstall(worktreePath: string): Promise<boolean> {
  if (!(await exists(path.join(worktreePath, 'package.json')))) return false;
  const installed = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity'];
  for (const marker of installed) if (await exists(path.join(worktreePath, marker))) return false;
  return true;
}

const inFlight = new Map<string, Promise<string | undefined>>();

/**
 * Installs the worktree's dependencies when it has none. Resolves to an error message when the install
 * failed, so the stage can stop with it instead of working without its tools.
 * Concurrent callers for one worktree (a map's items) share one install.
 */
export function ensureRunDependencies(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  worktreePath: string,
  ports: RunDependencyPorts,
  signal?: AbortSignal
): Promise<string | undefined> {
  const key = path.resolve(worktreePath);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = install(definition, key, ports, signal).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function install(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  worktreePath: string,
  ports: RunDependencyPorts,
  signal?: AbortSignal
): Promise<string | undefined> {
  const node = installStageOf(definition);
  if (!node || !(await needsInstall(worktreePath))) return undefined;
  // `npm ci` empties whatever a node_modules link points at, so a link out of the worktree goes first.
  await removeEscapingDependencyLinks(worktreePath).catch(() => []);
  const command = [node.command, ...(node.args ?? [])].join(' ');
  ports.report?.(`Installing dependencies in this run's worktree first (${command}).`);
  const result = await ports.spawn(node, worktreePath, signal);
  if (signal?.aborted) return undefined;
  if (!succeeded(node, result)) return `Could not install this run's dependencies (${command}): ${failure(result)}`;
  ports.report?.('Dependencies installed.');

  const build = buildStageOf(definition);
  if (!build) return undefined;
  const buildCommand = [build.command, ...(build.args ?? [])].join(' ');
  ports.report?.(`Building this run's worktree (${buildCommand}).`);
  const built = await ports.spawn(build, worktreePath, signal);
  if (signal?.aborted) return undefined;
  ports.report?.(succeeded(build, built)
    ? 'Build finished.'
    : `The build failed (${buildCommand}): ${failure(built)} Stages start without its output; the workflow's Build stage runs it again later.`);
  return undefined;
}

function succeeded(node: WorkflowCheckNode, result: CheckProcessResult): boolean {
  return result.code !== null && (node.successExitCodes?.length ? node.successExitCodes : [0]).includes(result.code);
}

function failure(result: CheckProcessResult): string {
  const why = result.timedOut ? 'it timed out' : result.code === null ? (result.error ?? 'it did not start') : `it exited with code ${result.code}`;
  const tail = result.output.trim().split('\n').slice(-15).join('\n');
  return `${why}.${tail ? `\n${tail}` : ''}`;
}
