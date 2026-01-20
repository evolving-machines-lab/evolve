/**
 * Simple semaphore for global concurrency control.
 *
 * Ensures no more than N sandboxes run concurrently across all swarm operations.
 */

export class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(max: number) {
    if (max < 1) throw new Error("Semaphore max must be >= 1");
    this.permits = max;
  }

  /**
   * Execute a function under the semaphore.
   * Acquires a permit before running, releases after completion.
   */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.permits++;
    }
  }
}
