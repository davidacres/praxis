import type { WorkflowRun } from '@praxis/core';

/**
 * Coalesce terminal notifications; never save the snapshot sent to the tracker.
 *
 * A retried run settles again, and an outcome identical to the one already on the ticket is not
 * sent twice: it is only marked, so the ticket keeps one record of a failure that keeps repeating.
 */
export class WorkflowIssueWriteBack {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly ports: {
    get: (runId: string) => WorkflowRun | undefined;
    /** The outcome as written, without anything (time, duration) that differs on every settle. */
    outcomeOf: (run: WorkflowRun) => string;
    send: (run: WorkflowRun) => Promise<void>;
    mark: (runId: string, at: string, outcome: string) => Promise<void>;
  }) {}

  write(runId: string): Promise<void> {
    const pending = this.pending.get(runId);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      const run = this.ports.get(runId);
      if (!run?.issueKey || run.issueWriteBackAt) return;
      const outcome = this.ports.outcomeOf(run);
      if (run.issueWriteBackOutcome !== outcome) await this.ports.send(run);
      await this.ports.mark(runId, new Date().toISOString(), outcome);
    }).finally(() => this.pending.delete(runId));
    this.pending.set(runId, work);
    return work;
  }
}
