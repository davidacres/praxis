/** Fences legacy work before waiting, including text-only requests and queued saves. */
export class TeamChatActivation {
  public constructor(private readonly enabled = true) {}
  private fenced = false;
  private pending = new Set<Promise<unknown>>();
  private activation?: Promise<void>;
  public legacy<T>(work: () => Promise<T>): Promise<T> {
    if (this.fenced) return Promise.reject(new Error('Legacy assistant writes are disabled after durable activation.'));
    const promise = work();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  public activate(commit: () => Promise<void>): Promise<void> {
    if (!this.enabled) return Promise.reject(new Error('Durable team chat activation is disabled.'));
    this.fenced = true;
    this.activation ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await commit();
    })().catch(error => { this.activation = undefined; throw error; });
    return this.activation;
  }
}
