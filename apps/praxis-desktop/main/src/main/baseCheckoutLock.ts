import { resolve } from 'node:path';
import { ExclusiveResources } from '@praxis/core';

/**
 * One writer at a time on a project's base checkout (FX-BF-047).
 *
 * Parallel scheduled tickets each work in their own worktree, but several things
 * still write to the checkout they all branch from: a merge stage, a new run
 * branching its worktree (which refuses a dirty base), and Praxis's own ticket
 * bookkeeping on a folder-backed board — a status move or an outcome comment,
 * each written to a plan file and committed. Interleaved, one lane's half-written
 * plan file makes another lane's worktree refuse to start, and two commits at
 * once fight over the index lock and leave a file uncommitted. Everything that
 * writes to a base checkout takes its turn here; different repositories never wait.
 */
const baseCheckouts = new ExclusiveResources();

export function withBaseCheckout<T>(folder: string, work: () => Promise<T>): Promise<T> {
  return baseCheckouts.with(resolve(folder), work);
}
