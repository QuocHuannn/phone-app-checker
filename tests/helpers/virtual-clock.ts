interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/**
 * Discrete-event clock for scheduler simulations. `sleep` never waits in real time: a timer fires
 * only when every other task is blocked, and then the clock jumps straight to it. Concurrent
 * sleepers (one per app) therefore interleave the way they would in real time, in microseconds.
 */
export class VirtualClock {
  t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start: number) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve };
    this.timers.push(timer);
    signal?.addEventListener(
      'abort',
      () => {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
        resolve();
      },
      { once: true },
    );
    return promise;
  };

  /** Move time forward without any task noticing (the process was not running). */
  advance(ms: number): void {
    this.t += ms;
  }

  /** Run `work` to completion, firing timers whenever everything else is idle. */
  async drive<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const finished = work.finally(() => {
      done = true;
    });
    finished.catch(() => {});
    while (!done) {
      // One macrotask turn lets every promise continuation (no real I/O involved) settle first.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (done) break;
      let next: Timer | undefined;
      for (const timer of this.timers) {
        if (next === undefined || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
      }
      if (next === undefined) throw new Error('simulation deadlocked: every task is waiting and no timer is pending');
      this.timers.splice(this.timers.indexOf(next), 1);
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    return finished;
  }
}
