// Fake adapter for the benchmark: deterministic answers from a hash of `app|e164`, optional
// virtual-clock latency, call counters. No network, no real numbers, no adapter libraries.
import type { Adapter, App, CheckStatus } from '../../src/types.ts';

/** Deterministic fake ground truth; identical for a given seed of the dataset on every machine. */
export function truthOf(app: string, e164: string): CheckStatus {
  let h = 2166136261;
  const text = `${app}|${e164}`;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 3 === 0 ? 'yes' : 'not_found';
}

export interface FakeCounters {
  calls: Record<string, number>;
  numbers: Record<string, number>;
}

interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** `CliDeps.loadAdapter`: every app opens a session whose `check` waits `latencyMs` on the clock. */
export function makeLoadAdapter(clock: Sleeper, latencyMs: number, counters: FakeCounters): (app: App) => Promise<Adapter> {
  return async (app) => ({
    app,
    login: async () => {},
    open: async () => ({
      check: async (batch) => {
        counters.calls[app] = (counters.calls[app] ?? 0) + 1;
        counters.numbers[app] = (counters.numbers[app] ?? 0) + batch.length;
        if (latencyMs > 0) await clock.sleep(latencyMs);
        const answers = new Map<string, CheckStatus>();
        for (const n of batch) answers.set(n.e164, truthOf(app, n.e164));
        return answers;
      },
      close: async () => {},
    }),
  });
}
