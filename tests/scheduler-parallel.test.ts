import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type AppConfig, type Config } from '../src/config.ts';
import type { ProgressEvent } from '../src/progress.ts';
import { runChecks, type AppRunSummary } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { APPS, RateLimited, type Adapter, type App, type CheckStatus, type PhoneNumber } from '../src/types.ts';
import { VirtualClock } from './helpers/virtual-clock.ts';

/*
 * Per-app dispatcher with maxParallelAccounts > 1, on a virtual clock (no real waiting except the
 * short grace window of the Ctrl-C tests). Adapter doubles only; nothing touches a platform.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 9, 8, 12, 0, 0).getTime();
const LATENCY = 1000;
const PACING = 1000;

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const numbers = (count: number): PhoneNumber[] => Array.from({ length: count }, (_, i) => ({ e164: `+8490100${String(i).padStart(4, '0')}`, country: 'VN' }));
const yes = (batch: PhoneNumber[]) => new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));

function makeConfig(parallel: number, pacing: Partial<AppConfig> = {}): Config {
  const apps = structuredClone(DEFAULT_APPS);
  for (const app of APPS) {
    Object.assign(
      apps[app],
      { batchSize: 2, dailyCap: 100, minIntervalMs: PACING, jitterMs: 0, rateLimitCooldownMs: 60_000, errorCooldownMs: 5_000, maxParallelAccounts: parallel },
      pacing,
    );
  }
  return { defaultRegion: 'VN', dataDir: '/unused', maxAgeDays: 30, theme: 'auto', apps };
}

interface Behave {
  (call: { account: string; batch: PhoneNumber[]; callNo: number }): Promise<Map<string, CheckStatus>>;
}

interface RunOptions {
  numbers?: PhoneNumber[];
  apps?: App[];
  wait?: boolean;
  signal?: AbortSignal;
  closeTimeoutMs?: number;
  /** Replaces the default behaviour: wait `LATENCY` on the virtual clock, then answer yes. */
  behave?: Behave;
}

/** One scheduler run per call; `probe` records what the adapters saw. */
function rig(parallel: number, options: { pacing?: Partial<AppConfig>; accounts?: string[]; store?: Store; start?: number; instant?: boolean } = {}) {
  const store = options.store ?? new Store(':memory:');
  if (options.store === undefined) stores.push(store);
  const clock = new VirtualClock(options.start ?? NOON);
  const config = makeConfig(parallel, options.pacing);
  const probe = { running: 0, maxRunning: 0, maxPerAccount: 0, starts: [] as { account: string; at: number }[], sent: new Map<string, string[]>() };
  const inFlight = new Map<string, number>();
  const logs: string[] = [];
  const events: ProgressEvent[] = [];
  let calls = 0;

  const adapter = (app: App, behave: Behave | undefined): Adapter => ({
    app,
    async login() {},
    async open(ctx) {
      return {
        async check(batch) {
          calls += 1;
          probe.starts.push({ account: ctx.account, at: clock.now() });
          probe.sent.set(ctx.account, [...(probe.sent.get(ctx.account) ?? []), ...batch.map((n) => n.e164)]);
          probe.running += 1;
          probe.maxRunning = Math.max(probe.maxRunning, probe.running);
          const mine = (inFlight.get(ctx.account) ?? 0) + 1;
          inFlight.set(ctx.account, mine);
          probe.maxPerAccount = Math.max(probe.maxPerAccount, mine);
          try {
            if (behave !== undefined) return await behave({ account: ctx.account, batch, callNo: calls });
            await clock.sleep(LATENCY);
            return yes(batch);
          } finally {
            probe.running -= 1;
            inFlight.set(ctx.account, mine - 1);
          }
        },
        async close() {},
      };
    },
  });

  const run = (given: RunOptions = {}): Promise<AppRunSummary[]> => {
    const pending = runChecks({
      store,
      config,
      numbers: given.numbers ?? numbers(8),
      apps: given.apps ?? ['telegram'],
      maxAgeMs: 30 * DAY,
      wait: given.wait ?? false,
      signal: given.signal,
      loadAdapter: async (app) => adapter(app, given.behave),
      listAccounts: () => options.accounts ?? ['a', 'b'],
      accountDir: (app, name) => `/unused/${app}/${name}`,
      now: clock.now,
      // `instant` advances the clock without yielding to the virtual-clock driver (no timers to fire).
      sleep: options.instant ? async (ms) => clock.advance(ms) : clock.sleep,
      random: () => 0,
      log: (message) => logs.push(message),
      onProgress: (event) => events.push(structuredClone(event)),
      ...(given.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: given.closeTimeoutMs }),
    });
    return options.instant ? pending : clock.drive(pending);
  };
  return { store, clock, probe, logs, events, run };
}

describe('maxParallelAccounts > 1', () => {
  it('overlaps batches of different accounts (one per account) and finishes sooner than serial dispatch', async () => {
    const serial = rig(1);
    const [s] = await serial.run();
    const parallel = rig(2);
    const [p] = await parallel.run();

    for (const summary of [s, p]) expect(summary).toMatchObject({ needed: 8, answered: 8, remaining: 0, stopped: 'done' });
    expect(serial.probe.maxRunning).toBe(1);
    expect(parallel.probe.maxRunning).toBe(2);
    expect(parallel.probe.maxPerAccount).toBe(1);
    expect(parallel.clock.t - NOON).toBeLessThan(serial.clock.t - NOON);
    // Same work, same answers.
    for (const n of numbers(8)) expect(parallel.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
  });

  it('never starts an account again before its own pacing interval ended, however many accounts run', async () => {
    const r = rig(3, { accounts: ['a', 'b', 'c'] });
    await r.run({ numbers: numbers(18) });
    for (const account of ['a', 'b', 'c']) {
      const at = r.probe.starts.filter((start) => start.account === account).map((start) => start.at);
      expect(at.length).toBeGreaterThan(1);
      for (let i = 1; i < at.length; i += 1) {
        // pacing starts when the batch returns: latency + minimum interval
        expect((at[i] as number) - (at[i - 1] as number), `${account} start ${i}`).toBeGreaterThanOrEqual(LATENCY + PACING);
      }
    }
    expect(r.probe.maxRunning).toBe(3);
  });

  it('never exceeds the daily cap of any account with batches in flight', async () => {
    const r = rig(3, { accounts: ['a', 'b', 'c'], pacing: { dailyCap: 3, minIntervalMs: 0 } });
    const [summary] = await r.run({ numbers: numbers(12) });

    // Every account may take 3 numbers a day: 2 + the 1 that is left of its allowance.
    expect(summary).toMatchObject({ answered: 9, remaining: 3, stopped: 'blocked', blockedBy: ['daily_cap'] });
    for (const account of ['a', 'b', 'c']) {
      expect(r.probe.sent.get(account)).toHaveLength(3);
      expect(r.store.getAccount('telegram', account).usedToday).toBe(3);
    }
    expect(r.probe.maxRunning).toBe(3);
  });

  it('keeps Viber at one batch at a time even when the configuration says more', async () => {
    const r = rig(3);
    // The config is built by hand (rig sets every app to 3): loadConfig would refuse it for Viber.
    const [summary] = await r.run({ apps: ['viber'] });
    expect(summary).toMatchObject({ app: 'viber', answered: 8, stopped: 'done' });
    expect(r.probe.maxRunning).toBe(1);
  });

  it('a rate-limited account rests while the other accounts carry on', async () => {
    const r = rig(2);
    const [summary] = await r.run({
      behave: async ({ account, batch }) => {
        if (account === 'a') throw new RateLimited('slow down', 3_600_000, new Map());
        await r.clock.sleep(LATENCY);
        return yes(batch);
      },
    });

    expect(summary).toMatchObject({ answered: 8, remaining: 0, stopped: 'done' });
    expect(r.probe.starts.filter((start) => start.account === 'a')).toHaveLength(1);
    for (const n of numbers(8)) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
    expect(r.store.getAccount('telegram', 'a').cooldownUntil).toBeGreaterThan(NOON + 3_000_000);
    const resting = r.events.find((event) => event.accounts?.some((row) => row.account === 'a' && row.state === 'cooldown'));
    expect(resting?.accounts?.find((row) => row.account === 'a')?.waitingUntil).toBeGreaterThan(NOON);
  });

  it('reports a row per account and records how long its batches take', async () => {
    const r = rig(2);
    await r.run();

    const bothWorking = r.events.find((event) => event.accounts?.every((row) => row.state === 'working'));
    expect(bothWorking?.accounts?.map((row) => row.account)).toEqual(['a', 'b']);
    const last = r.events.at(-1)?.accounts ?? [];
    expect(last.map((row) => row.state)).toEqual(['done', 'done']);
    expect(last.reduce((total, row) => total + row.done, 0)).toBe(8);
    expect(last.reduce((total, row) => total + row.counts.yes, 0)).toBe(8);
    for (const row of last) expect(row.lastBatchMs).toBe(LATENCY);

    // The same facts are persisted for `accounts`, so the maintainer can judge whether to raise K.
    for (const account of ['a', 'b']) {
      expect(r.store.getAccount('telegram', account)).toMatchObject({ batchesDone: 2, avgBatchMs: LATENCY, lastBatchMs: LATENCY });
    }
  });
});

describe('Ctrl-C with batches in flight', () => {
  it('lets batches that return inside the grace window commit, and loses nothing', async () => {
    const abort = new AbortController();
    const r = rig(2);
    let first = true;
    const [summary] = await r.run({
      signal: abort.signal,
      closeTimeoutMs: 5000,
      behave: async ({ batch }) => {
        if (first) {
          first = false;
          // the interrupt arrives while both accounts are still waiting for their platform
          void r.clock.sleep(LATENCY / 2).then(() => abort.abort());
        }
        await r.clock.sleep(LATENCY);
        return yes(batch);
      },
    });

    expect(summary).toMatchObject({ stopped: 'aborted', answered: 4, remaining: 4 });
    expect(r.logs.join('\n')).not.toContain('did not return in time');
    for (const account of ['a', 'b']) expect(r.store.getAccount('telegram', account).usedToday).toBe(2);
    for (const n of numbers(4)) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
    expect(r.store.getResult(numbers(5)[4]!.e164, 'telegram')).toBeUndefined();
  });

  it('abandons a batch that never returns: its numbers stay unknown and count against the cap; a rerun skips what finished', async () => {
    const abort = new AbortController();
    const r = rig(2, { instant: true });
    let finishedCalls = 0;
    const [summary] = await r.run({
      numbers: numbers(6),
      signal: abort.signal,
      closeTimeoutMs: 30,
      behave: async ({ account, batch }) => {
        // b's platform never answers; a answers twice, and the second answer comes with the interrupt
        if (account === 'b') return new Promise<Map<string, CheckStatus>>(() => {});
        finishedCalls += 1;
        if (finishedCalls === 2) abort.abort();
        return yes(batch);
      },
    });

    expect(summary).toMatchObject({ stopped: 'aborted', answered: 4, remaining: 2 });
    expect(r.logs.join('\n')).toContain('did not return in time');
    const stuck = numbers(6).slice(2, 4);
    for (const n of stuck) expect(r.store.getResult(n.e164, 'telegram')).toBeUndefined();
    for (const n of [...numbers(2), ...numbers(6).slice(4)]) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
    // The platform may have counted b's two numbers already: they are charged although nothing came back.
    expect(r.store.getAccount('telegram', 'b').usedToday).toBe(2);
    expect(r.store.getAccount('telegram', 'a').usedToday).toBe(4);

    const rerun = rig(2, { instant: true, store: r.store, start: r.clock.t + DAY });
    // `instant` has no virtual-clock driver, so the adapter must answer without waiting on the clock.
    const [again] = await rerun.run({ numbers: numbers(6), behave: async ({ batch }) => yes(batch) });
    expect(again).toMatchObject({ needed: 2, answered: 2, remaining: 0, stopped: 'done' });
    expect([...rerun.probe.sent.values()].flat()).toEqual(stuck.map((n) => n.e164));
  });

  it('with one account at a time (K = 1) waits for the batch in flight however long it takes, as before', async () => {
    const abort = new AbortController();
    const r = rig(1, { instant: true, accounts: ['a'] });
    const [summary] = await r.run({
      numbers: numbers(6),
      signal: abort.signal,
      // far shorter than the batch: the old single-batch contract has no deadline, so it must not apply
      closeTimeoutMs: 20,
      behave: async ({ batch }) => {
        abort.abort();
        // Real time on purpose: the grace window under test is a real timer (like the session close window),
        // so only a genuinely slower batch shows that K = 1 does not apply it; the virtual clock cannot.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 120);
        await promise;
        return yes(batch);
      },
    });

    expect(summary).toMatchObject({ stopped: 'aborted', answered: 2, remaining: 4 });
    expect(r.logs.join('\n')).not.toContain('did not return in time');
    expect(r.store.getAccount('telegram', 'a').usedToday).toBe(2);
    for (const n of numbers(2)) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
  });
});
