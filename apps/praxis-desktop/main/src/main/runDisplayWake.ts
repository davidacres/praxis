import type { WorkflowRun } from '@praxis/core';

/**
 * Keeps the display awake while any workflow run has a stage running.
 *
 * On macOS an Electron app launched while the display is off never opens its window. A scheduled
 * run that went on after the display slept had every e2e test time out waiting for one — QA failed
 * 189 of 189 overnight on a change that passed once the display was back on. A run waiting for a
 * person (an approval, a decision) holds nothing, so the display can sleep while nothing is moving.
 */
export class RunDisplayWake {
  private readonly busy = new Set<string>();
  private blockerId: number | undefined;

  constructor(private readonly ports: { start: () => number; stop: (id: number) => void }) {}

  update(run: WorkflowRun): void {
    const running = run.status === 'running' && Object.values(run.nodes).some(state => state.outcome === 'running');
    if (running) this.busy.add(run.runId);
    else this.busy.delete(run.runId);
    if (this.busy.size > 0 && this.blockerId === undefined) {
      this.blockerId = this.ports.start();
    } else if (this.busy.size === 0 && this.blockerId !== undefined) {
      this.ports.stop(this.blockerId);
      this.blockerId = undefined;
    }
  }

  get holding(): boolean {
    return this.blockerId !== undefined;
  }
}
