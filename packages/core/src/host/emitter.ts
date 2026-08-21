export interface Event<T> {
  (listener: (value: T) => void): Disposable;
}

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> implements Disposable {
  private listeners = new Set<(value: T) => void>();

  public readonly event: Event<T> = listener => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}
