/**
 * One holder at a time per resource (FX-BE-149). A parallel scheduled run keeps
 * each ticket in its own worktree, so the only thing two tickets share is the
 * project's base checkout, which a merge stage writes to. Merges into one
 * repository take turns through this; different repositories never wait.
 *
 * In-process only: it serialises the work this Praxis instance starts.
 */
export class ExclusiveResources {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `work` once every earlier holder of `resource` has finished, whether it succeeded or threw. */
  public async with<T>(resource: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(resource) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(resource, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(resource) === tail) this.tails.delete(resource);
    }
  }

  /** True while something holds or waits for `resource`. */
  public busy(resource: string): boolean {
    return this.tails.has(resource);
  }
}
