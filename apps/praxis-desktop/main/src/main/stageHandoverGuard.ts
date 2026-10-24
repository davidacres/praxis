/** Keeps a workflow stage attached while an intentional provider interruption is in progress. */
export class StageHandoverGuard {
  private readonly held = new Set<string>();
  private readonly observers = new Map<string, () => void>();

  public observe(key: string, check: () => void): () => void {
    this.observers.set(key, check);
    return () => this.observers.delete(key);
  }

  public isHeld(key: string): boolean { return this.held.has(key); }

  public async during<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) throw new Error('A provider handover is already in progress.');
    this.held.add(key);
    try {
      return await action();
    } finally {
      this.held.delete(key);
      this.observers.get(key)?.();
    }
  }
}

export const stageHandoverGuard = new StageHandoverGuard();
