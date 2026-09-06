import type { WorkflowRun } from '@praxis/core';

/** Coalesce terminal notifications; never save the snapshot sent to the tracker. */
export class WorkflowIssueWriteBack {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly ports: {
    get: (runId: string) => WorkflowRun | undefined;
    send: (run: WorkflowRun) => Promise<void>;
    mark: (runId: string, at: string) => Promise<void>;
  }) {}

  write(runId: string): Promise<void> {
    const pending = this.pending.get(runId);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      const run = this.ports.get(runId);
      if (!run?.issueKey || run.issueWriteBackAt) return;
      await this.ports.send(run);
      await this.ports.mark(runId, new Date().toISOString());
    }).finally(() => this.pending.delete(runId));
    this.pending.set(runId, work);
    return work;
  }
}
