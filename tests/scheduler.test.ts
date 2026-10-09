import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Config } from '../src/config.ts';
import type { ProgressEvent } from '../src/progress.ts';
import { describeRun, isFresh, MAX_BATCH_FAILURES, MAX_CONSECUTIVE_ERRORS, runChecks, type AppRunSummary } from '../src/scheduler.ts';
import { formatLocalTime } from '../src/ui.ts';
import { nextLocalMidnight, Store } from '../src/store.ts';
import {
  AccountBanned,
  APPS,
  RateLimited,
  type Adapter,
  type App,
  type CheckStatus,
  type PacingSettings,
  type PhoneNumber,
} from '../src/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 9, 8, 12, 0, 0).getTime();

type Handler = (account: string, batch: PhoneNumber[], callNo: number) => Map<string, CheckStatus>;

interface Call {
  app: App;
  account: string;
  e164s: string[];
}

const tempDirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function num(i: number, country = 'VN'): PhoneNumber {
  return { e164: `+8490100${String(i).padStart(4, '0')}`, country };
}

const numbers = (count: number) => Array.from({ length: count }, (_, i) => num(i));

function openStore(path = ':memory:'): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checker-sched-'));
  tempDirs.push(dir);
  return join(dir, 'checker.db');
}

function makeConfig(pacing: Partial<PacingSettings> = {}): Config {
  const apps = structuredClone(DEFAULT_APPS);
  for (const app of APPS) {
    Object.assign(
      apps[app],
      { batchSize: 2, dailyCap: 100, minIntervalMs: 1000, jitterMs: 0, rateLimitCooldownMs: 60_000, errorCooldownMs: 5_000 },
      pacing,
    );
  }
  return { defaultRegion: 'VN', dataDir: '/unused', maxAgeDays: 30, apps };
}

const allYes: Handler = (_account, batch) => new Map(batch.map((n) => [n.e164, 'yes' as const]));

function fakeAdapter(app: App, calls: Call[], handler: Handler): Adapter {
  return {
    app,
    async login() {},
    async open(ctx) {
      return {
        async check(batch) {
          calls.push({ app, account: ctx.account, e164s: batch.map((n) => n.e164) });
          return handler(ctx.account, batch, calls.length);
        },
        async close() {},
      };
    },
  };
}

interface Harness {
  store: Store;
  calls: Call[];
  sleeps: number[];
  logs: string[];
  clock: { t: number };
  run(options?: RunOptions): Promise<AppRunSummary[]>;
}

interface RunOptions {
  apps?: App[];
  numbers?: PhoneNumber[];
  handlers?: Partial<Record<App, Handler>>;
  accounts?: Partial<Record<App, string[]>>;
  wait?: boolean;
  maxAgeMs?: number;
  signal?: AbortSignal;
  /** Replaces the default fake sleep (which just advances the clock). */
  sleep?: (ms: number) => Promise<void>;
  loadAdapter?: (app: App) => Promise<Adapter>;
  random?: () => number;
  onProgress?: (event: ProgressEvent) => void;
}

function harness(config: Config, store: Store = openStore(), start = NOON): Harness {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const clock = { t: start };
  return {
    store,
    calls,
    sleeps,
    logs,
    clock,
    run: (options = {}) =>
      runChecks({
        store,
        config,
        numbers: options.numbers ?? numbers(4),
        apps: options.apps ?? ['telegram'],
        maxAgeMs: options.maxAgeMs ?? 30 * DAY,
        wait: options.wait ?? true,
        signal: options.signal,
        loadAdapter:
          options.loadAdapter ??
          (async (app) => fakeAdapter(app, calls, options.handlers?.[app] ?? allYes)),
        listAccounts: (app) => options.accounts?.[app] ?? ['a'],
        accountDir: (app, name) => `/unused/${app}/${name}`,
        now: () => clock.t,
        sleep:
          options.sleep ??
          (async (ms) => {
            sleeps.push(ms);
            clock.t += ms;
          }),
        random: options.random ?? (() => 0),
        log: (message) => logs.push(message),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      }),
  };
}

const status = (store: Store, app: App, n: PhoneNumber) => store.getResult(n.e164, app)?.status;

describe('isFresh', () => {
  it('reuses yes/not_found inside the max age, never unknown', () => {
    expect(isFresh({ status: 'yes', checkedAt: NOON - DAY }, NOON, 30 * DAY)).toBe(true);
    expect(isFresh({ status: 'not_found', checkedAt: NOON - 31 * DAY }, NOON, 30 * DAY)).toBe(false);
    expect(isFresh({ status: 'unknown', checkedAt: NOON }, NOON, 30 * DAY)).toBe(false);
    expect(isFresh(undefined, NOON, 30 * DAY)).toBe(false);
    expect(isFresh({ status: 'yes', checkedAt: NOON }, NOON, 0)).toBe(false);
  });

  it('never reuses a result dated in the future (clock moved backwards), even with a huge or zero max age', () => {
    expect(isFresh({ status: 'yes', checkedAt: NOON + 1 }, NOON, 30 * DAY)).toBe(false);
    expect(isFresh({ status: 'not_found', checkedAt: NOON + DAY }, NOON, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isFresh({ status: 'yes', checkedAt: NOON + 1 }, NOON, 0)).toBe(false);
    expect(isFresh({ status: 'yes', checkedAt: Number.NaN }, NOON, 30 * DAY)).toBe(false);
    // age 0 is the boundary: fresh for any positive max age
    expect(isFresh({ status: 'yes', checkedAt: NOON }, NOON, 1)).toBe(true);
  });

  it('re-checks a future-dated result in a real run', async () => {
    const h = harness(makeConfig());
    const [n] = numbers(1) as [PhoneNumber];
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n.e164, 'yes']]), NOON + 3600_000);
    const [summary] = await h.run({ numbers: [n] });
    expect(summary).toMatchObject({ needed: 1, attempted: 1, conclusive: 1, inconclusive: 0 });
    expect(h.calls).toHaveLength(1);
  });
});

describe('scheduler', () => {
  it('checks in batches, paces batches and stores every result', async () => {
    const h = harness(makeConfig());
    const [summary] = await h.run({ numbers: numbers(5) });

    expect(h.calls.map((c) => c.e164s.length)).toEqual([2, 2, 1]);
    expect(h.sleeps).toEqual([1000, 1000]);
    expect(summary).toMatchObject({ app: 'telegram', needed: 5, answered: 5, remaining: 0, stopped: 'done' });
    for (const n of numbers(5)) expect(status(h.store, 'telegram', n)).toBe('yes');
    expect(h.store.getAccount('telegram', 'a').usedToday).toBe(5);
  });

  describe('progress events (onProgress)', () => {
    it('reports the start, then every batch, with needed and remaining; remaining ends at 0', async () => {
      const h = harness(makeConfig());
      const events: ProgressEvent[] = [];
      await h.run({ numbers: numbers(5), onProgress: (event) => events.push(structuredClone(event)) });
      const remaining = events.filter((event) => event.waiting === undefined).map((event) => event.remaining);
      // Each wait is followed by a "back to work" report with the same count: one entry per distinct state.
      expect(remaining.filter((value, index) => index === 0 || value !== remaining[index - 1])).toEqual([5, 3, 1, 0]);
      expect(events.every((event) => event.needed === 5)).toBe(true);
      expect(events.every((event) => event.app === 'telegram')).toBe(true);
    });

    it('says when it waits out the pacing interval, then goes back to working', async () => {
      const h = harness(makeConfig());
      const events: ProgressEvent[] = [];
      await h.run({ numbers: numbers(4), onProgress: (event) => events.push(structuredClone(event)) });
      const waits = events.filter((event) => event.waiting !== undefined);
      expect(waits).toMatchObject([{ app: 'telegram', needed: 4, remaining: 2, waiting: { until: NOON + 1000, kind: 'pacing' } }]);
      const at = events.indexOf(waits[0] as ProgressEvent);
      expect(events[at + 1]).toMatchObject({ app: 'telegram', needed: 4, remaining: 2 });
      expect(events[at + 1]?.waiting).toBeUndefined();
    });

    it('says when every account rests (a cooldown) and when it resumes', async () => {
      const h = harness(makeConfig({ batchSize: 2, rateLimitCooldownMs: 60_000 }));
      let first = true;
      const events: ProgressEvent[] = [];
      await h.run({
        numbers: numbers(4),
        handlers: {
          telegram: (_account, batch) => {
            if (first) {
              first = false;
              throw new RateLimited('slow down', undefined, new Map());
            }
            return new Map(batch.map((n) => [n.e164, 'yes' as const]));
          },
        },
        onProgress: (event) => events.push(structuredClone(event)),
      });
      const rest = events.find((event) => event.waiting?.kind === 'cooldown');
      expect(rest).toMatchObject({ needed: 4, remaining: 4, waiting: { kind: 'cooldown' } });
      expect(rest?.waiting?.until).toBeGreaterThan(NOON);
      expect(events.at(-1)).toMatchObject({ app: 'telegram', needed: 4, remaining: 0 });
      expect(events.at(-1)?.waiting).toBeUndefined();
    });

    it('reports nothing for an app with nothing to check, and a run without a listener is unchanged', async () => {
      const h = harness(makeConfig());
      const events: ProgressEvent[] = [];
      await h.run({ numbers: [], onProgress: (event) => events.push(event) });
      expect(events).toEqual([]);
      const plain = harness(makeConfig());
      await expect(plain.run({ numbers: numbers(3) })).resolves.toHaveLength(1);
    });
  });

  it('adds jitter on top of the minimum interval', async () => {
    const h = harness(makeConfig({ minIntervalMs: 1000, jitterMs: 500 }));
    await h.run({ numbers: numbers(4), random: () => 0.5 });
    expect(h.sleeps).toEqual([1250]);
  });

  it('reuses fresh results and re-checks unknown, stale and missing ones', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const [n0, n1, n2, n3] = numbers(4) as [PhoneNumber, PhoneNumber, PhoneNumber, PhoneNumber];
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n0.e164, 'yes']]), NOON - DAY);
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n1.e164, 'not_found']]), NOON - 40 * DAY);
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n2.e164, 'unknown']]), NOON - 1000);

    await h.run({ numbers: [n0, n1, n2, n3] });
    expect(h.calls.flatMap((c) => c.e164s)).toEqual([n1.e164, n2.e164, n3.e164]);
    expect(h.store.getResult(n0.e164, 'telegram')?.checkedAt).toBe(NOON - DAY);
  });

  it('does not check the same number twice on a second run', async () => {
    const h = harness(makeConfig());
    await h.run();
    const first = h.calls.length;
    const [summary] = await h.run();
    expect(h.calls.length).toBe(first);
    expect(summary).toMatchObject({ needed: 0, stopped: 'done' });
  });

  it('skips numbers outside the app scope (Zalo is VN only)', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const sg = num(9, 'SG');
    await h.run({ apps: ['zalo', 'telegram'], numbers: [num(0), sg] });

    expect(h.calls.find((c) => c.app === 'zalo')?.e164s).toEqual([num(0).e164]);
    expect(h.calls.find((c) => c.app === 'telegram')?.e164s).toEqual([num(0).e164, sg.e164]);
    expect(h.store.getResult(sg.e164, 'zalo')).toBeUndefined();
  });

  it('stores unanswered or malformed answers as unknown and does not retry them in the same run', async () => {
    const h = harness(makeConfig());
    const handler: Handler = (_a, batch) =>
      batch.length === 2
        ? new Map<string, CheckStatus>([
            [batch[0]!.e164, 'yes'],
            [batch[1]!.e164, 'maybe' as CheckStatus],
          ])
        : new Map<string, CheckStatus>();
    await h.run({ numbers: numbers(3), handlers: { telegram: handler } });

    expect(status(h.store, 'telegram', num(0))).toBe('yes');
    expect(status(h.store, 'telegram', num(1))).toBe('unknown');
    expect(status(h.store, 'telegram', num(2))).toBe('unknown');
    expect(h.calls.length).toBe(2);

    const retry = harness(makeConfig(), h.store);
    await retry.run({ numbers: numbers(3) });
    expect(retry.calls.flatMap((c) => c.e164s)).toEqual([num(1).e164, num(2).e164]);
  });

  it('reports a missing account instead of failing silently, without loading the adapter', async () => {
    const h = harness(makeConfig());
    let loaded = 0;
    const [summary] = await h.run({
      accounts: { telegram: [] },
      loadAdapter: async () => {
        loaded += 1;
        return fakeAdapter('telegram', h.calls, allYes);
      },
    });
    expect(summary).toMatchObject({ stopped: 'no_accounts', remaining: 4 });
    expect(loaded).toBe(0);
    expect(h.logs.join('\n')).toContain('login telegram');
  });

  it('keeps going for other apps when one adapter cannot be loaded', async () => {
    const h = harness(makeConfig());
    const summaries = await h.run({
      apps: ['telegram', 'whatsapp'],
      loadAdapter: async (app) => {
        if (app === 'telegram') throw new Error('Cannot load the telegram adapter: boom');
        return fakeAdapter(app, h.calls, allYes);
      },
    });
    expect(summaries.map((s) => [s.app, s.stopped])).toEqual([
      ['telegram', 'adapter_error'],
      ['whatsapp', 'done'],
    ]);
  });
});

describe('rate limiting', () => {
  const limitedOnce: Handler = (account, batch, callNo) => {
    if (callNo === 1) throw new RateLimited('slow down', 10_000, new Map([[batch[0]!.e164, 'yes']]));
    return allYes(account, batch, callNo);
  };

  it('puts the account in cooldown, keeps partial results and leaves the rest unchecked (--no-wait)', async () => {
    const h = harness(makeConfig());
    const [summary] = await h.run({ wait: false, handlers: { telegram: limitedOnce } });

    expect(summary).toMatchObject({ stopped: 'blocked', answered: 1, remaining: 3 });
    expect(status(h.store, 'telegram', num(0))).toBe('yes');
    expect(h.store.getResult(num(1).e164, 'telegram')).toBeUndefined();
    expect(h.store.getAccount('telegram', 'a').cooldownUntil).toBe(NOON + 10_000);
    expect(h.sleeps).toEqual([]);
  });

  it('sleeps until the cooldown ends, then finishes the remaining numbers', async () => {
    const h = harness(makeConfig());
    const [summary] = await h.run({ handlers: { telegram: limitedOnce } });

    expect(h.sleeps[0]).toBe(10_000);
    expect(summary).toMatchObject({ stopped: 'done', remaining: 0 });
    expect(h.calls.map((c) => c.e164s)).toEqual([
      [num(0).e164, num(1).e164],
      [num(1).e164, num(2).e164],
      [num(3).e164],
    ]);
    for (const n of numbers(4)) expect(status(h.store, 'telegram', n)).toBe('yes');
  });

  it('uses rateLimitCooldownMs when the adapter gives no wait time', async () => {
    const h = harness(makeConfig({ rateLimitCooldownMs: 77_000 }));
    const handler: Handler = () => {
      throw new RateLimited('flood');
    };
    await h.run({ wait: false, handlers: { telegram: handler } });
    expect(h.store.getAccount('telegram', 'a').cooldownUntil).toBe(NOON + 77_000);
  });

  it('fails over to another account while one is cooling down', async () => {
    const h = harness(makeConfig());
    const handler: Handler = (account, batch, callNo) => {
      if (account === 'a') throw new RateLimited('slow down', 3_600_000);
      return allYes(account, batch, callNo);
    };
    await h.run({ wait: false, accounts: { telegram: ['a', 'b'] }, handlers: { telegram: handler } });

    expect(h.calls.filter((c) => c.account === 'a')).toHaveLength(1);
    for (const n of numbers(4)) expect(status(h.store, 'telegram', n)).toBe('yes');
  });
});

describe('banned accounts', () => {
  const bannedA: Handler = (account, batch, callNo) => {
    if (account === 'a') throw new AccountBanned('logged out +84901234567');
    return allYes(account, batch, callNo);
  };

  it('disables the account and lets another account continue', async () => {
    const h = harness(makeConfig());
    const [summary] = await h.run({ numbers: numbers(3), accounts: { telegram: ['a', 'b'] }, handlers: { telegram: bannedA } });

    expect(summary).toMatchObject({ stopped: 'done', remaining: 0 });
    expect(h.calls.map((c) => c.account)).toEqual(['a', 'b', 'b']);
    const disabled = h.store.getAccount('telegram', 'a').disabledReason;
    expect(disabled).toContain('logged out');
    expect(disabled).not.toContain('+84901234567');
    expect(h.logs.some((line) => line.includes('WARNING a'))).toBe(true);
    for (const n of numbers(3)) expect(status(h.store, 'telegram', n)).toBe('yes');
  });

  it('disables an account whose session cannot be opened as logged out, with a single attempt', async () => {
    const h = harness(makeConfig());
    let opens = 0;
    const unlinked: Adapter = {
      app: 'telegram',
      async login() {},
      async open() {
        opens += 1;
        throw new AccountBanned('not logged in. Run `login telegram --account <name>` again.');
      },
    };
    const [summary] = await h.run({ loadAdapter: async () => unlinked });
    expect(opens).toBe(1);
    expect(summary).toMatchObject({ stopped: 'no_accounts', answered: 0, remaining: 4 });
    expect(h.store.getAccount('telegram', 'a').disabledReason).toContain('not logged in');
    expect(h.logs.join('\n')).not.toContain('dropped for the rest of this run');
  });

  it('keeps a banned account disabled on later runs', async () => {
    const h = harness(makeConfig());
    await h.run({ numbers: numbers(2), accounts: { telegram: ['a', 'b'] }, handlers: { telegram: bannedA } });
    const later = harness(makeConfig(), h.store, NOON + DAY);
    await later.run({ numbers: numbers(4), accounts: { telegram: ['a', 'b'] }, handlers: { telegram: bannedA } });
    expect(later.calls.length).toBeGreaterThan(0);
    expect(later.calls.every((c) => c.account === 'b')).toBe(true);
  });

  it('stops with no_accounts when every account is banned', async () => {
    const h = harness(makeConfig());
    const [summary] = await h.run({ handlers: { telegram: bannedA } });
    expect(summary).toMatchObject({ stopped: 'no_accounts', answered: 0, remaining: 4 });
    expect(h.calls).toHaveLength(1);
  });

  it('keeps results the adapter returned before the ban', async () => {
    const h = harness(makeConfig());
    const handler: Handler = (_a, batch) => {
      throw new AccountBanned('banned', new Map([[batch[0]!.e164, 'not_found']]));
    };
    await h.run({ handlers: { telegram: handler } });
    expect(status(h.store, 'telegram', num(0))).toBe('not_found');
  });
});

describe('unexpected errors', () => {
  it('cools down, retries, then drops the account and never logs full numbers', async () => {
    const h = harness(makeConfig());
    const handler: Handler = () => {
      throw new Error('lookup failed for +84901234567');
    };
    const [summary] = await h.run({ handlers: { telegram: handler } });

    expect(h.calls).toHaveLength(MAX_CONSECUTIVE_ERRORS);
    expect(h.sleeps).toEqual([5000, 5000]);
    expect(summary).toMatchObject({ stopped: 'no_accounts', remaining: 4 });
    const text = h.logs.join('\n');
    expect(text).not.toContain('+84901234567');
    expect(text).toContain('+8490****567');
    // A dropped account is not banned: it is usable again on the next run.
    expect(h.store.getAccount('telegram', 'a').disabledReason).toBeNull();
  });
});

describe('daily cap and day rollover', () => {
  const capped = () => makeConfig({ dailyCap: 3, minIntervalMs: 0 });

  it('stops at the daily cap with --no-wait', async () => {
    const h = harness(capped());
    const [summary] = await h.run({ numbers: numbers(5), wait: false });
    expect(h.calls.map((c) => c.e164s.length)).toEqual([2, 1]);
    expect(summary).toMatchObject({ stopped: 'blocked', answered: 3, remaining: 2 });
  });

  it('sleeps until local midnight, then continues with a fresh allowance', async () => {
    const h = harness(capped());
    const [summary] = await h.run({ numbers: numbers(5) });
    expect(h.sleeps).toEqual([nextLocalMidnight(NOON) - NOON]);
    expect(summary).toMatchObject({ stopped: 'done', remaining: 0 });
    expect(h.store.getAccount('telegram', 'a').usedToday).toBe(2);
  });

  it("ignores yesterday's usage", async () => {
    const h = harness(capped());
    h.store.saveAccount({
      app: 'telegram',
      name: 'a',
      cooldownUntil: 0,
      disabledReason: null,
      day: '2000-01-01',
      usedToday: 3,
      nextAllowedAt: 0,
      lastBatchMs: null,
      avgBatchMs: null,
      batchesDone: 0,
    });
    const [summary] = await h.run({ numbers: numbers(3), wait: false });
    expect(summary).toMatchObject({ stopped: 'done', answered: 3 });
  });
});

describe('account rotation', () => {
  it('alternates accounts while each one waits out its pacing interval', async () => {
    const h = harness(makeConfig());
    await h.run({ numbers: numbers(6), accounts: { telegram: ['a', 'b'] } });
    expect(h.calls.map((c) => c.account)).toEqual(['a', 'b', 'a']);
    expect(h.sleeps).toEqual([1000]);
  });
});

describe('kill and resume', () => {
  it('finishes the current batch on abort and resumes without re-checking', async () => {
    const dbPath = tempDb();
    const abort = new AbortController();
    const first = harness(makeConfig(), openStore(dbPath));
    const abortOnSecond: Handler = (account, batch, callNo) => {
      if (callNo === 2) abort.abort();
      return allYes(account, batch, callNo);
    };
    const [interrupted] = await first.run({ numbers: numbers(7), signal: abort.signal, handlers: { telegram: abortOnSecond } });
    expect(interrupted).toMatchObject({ stopped: 'aborted', answered: 4, remaining: 3 });
    first.store.close();

    // A restarted process starts later than the batches it finds committed.
    const second = harness(makeConfig(), openStore(dbPath), first.clock.t);
    const [resumed] = await second.run({ numbers: numbers(7) });
    expect(resumed).toMatchObject({ needed: 3, stopped: 'done', remaining: 0 });

    const all = [...first.calls, ...second.calls].flatMap((c) => c.e164s);
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });

  it('survives a crash mid-run: committed batches are kept and not repeated', async () => {
    const dbPath = tempDb();
    const first = harness(makeConfig(), openStore(dbPath));
    await expect(
      first.run({
        numbers: numbers(6),
        sleep: async () => {
          throw new Error('process killed');
        },
      }),
    ).rejects.toThrow('process killed');
    expect(first.calls).toHaveLength(1);
    first.store.close();

    const second = harness(makeConfig(), openStore(dbPath), NOON + 60_000);
    await second.run({ numbers: numbers(6) });
    const all = [...first.calls, ...second.calls].flatMap((c) => c.e164s);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    // Usage recorded before the crash carries over to the resumed run.
    expect(second.store.getAccount('telegram', 'a').usedToday).toBe(6);
  });

  it('stops promptly when aborted while sleeping through a cooldown', async () => {
    const abort = new AbortController();
    const h = harness(makeConfig());
    const limited: Handler = () => {
      throw new RateLimited('slow down', 3_600_000);
    };
    const [summary] = await h.run({
      signal: abort.signal,
      handlers: { telegram: limited },
      sleep: async () => abort.abort(),
    });
    expect(summary).toMatchObject({ stopped: 'aborted', remaining: 4 });
  });
});

describe('definitive answers survive unknown re-checks', () => {
  it('keeps a stale yes/not_found when the re-check gets no answer or only unknown', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const [n0, n1] = numbers(2) as [PhoneNumber, PhoneNumber];
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n0.e164, 'yes']]), NOON - 40 * DAY);
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n1.e164, 'not_found']]), NOON - 40 * DAY);

    const silent: Handler = () => new Map();
    await h.run({ numbers: [n0, n1], handlers: { telegram: silent } });
    expect(h.store.getResult(n0.e164, 'telegram')).toEqual({ status: 'yes', checkedAt: NOON - 40 * DAY });
    expect(h.store.getResult(n1.e164, 'telegram')).toEqual({ status: 'not_found', checkedAt: NOON - 40 * DAY });

    const throttled: Handler = (_account, batch) => {
      throw new RateLimited('deferred', 1000, new Map(batch.map((n) => [n.e164, 'unknown' as const])));
    };
    await h.run({ numbers: [n0, n1], handlers: { telegram: throttled }, wait: false });
    expect(status(h.store, 'telegram', n0)).toBe('yes');
    expect(status(h.store, 'telegram', n1)).toBe('not_found');
  });
});

describe('one bad batch does not take down the account', () => {
  it('parks a batch that keeps failing while others succeed, and keeps the account', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const poison = num(2);
    const handler: Handler = (_account, batch) => {
      if (batch.some((n) => n.e164 === poison.e164)) throw new Error('unmapped response for the number');
      return allYes(_account, batch, 0);
    };
    const [summary] = await h.run({ numbers: numbers(6), handlers: { telegram: handler } });

    for (const n of numbers(6)) {
      expect(status(h.store, 'telegram', n)).toBe(n.e164 === poison.e164 ? undefined : 'yes');
    }
    expect(h.calls.filter((c) => c.e164s.includes(poison.e164))).toHaveLength(MAX_BATCH_FAILURES);
    expect(summary).toMatchObject({ answered: 5, remaining: 1, stopped: 'done' });
    expect(h.logs.join('\n')).toContain('leaving them unknown for this run');
    expect(h.logs.join('\n')).not.toContain('dropped for the rest of this run');
    expect(h.store.getAccount('telegram', 'a').disabledReason).toBeNull();
  });
  it('serves a failed batch from the retry queue after the fresh numbers, and settles it', async () => {
    const h = harness(makeConfig({ batchSize: 2, minIntervalMs: 0, errorCooldownMs: 0 }));
    let callNo = 0;
    const handler: Handler = (account, batch) => {
      callNo += 1;
      if (callNo === 1) throw new Error('transient lookup failure');
      return allYes(account, batch, callNo);
    };
    const [summary] = await h.run({ numbers: numbers(6), handlers: { telegram: handler } });

    // The first batch goes to the retry queue, the rest of the input is checked first, and the
    // retried numbers are removed from their own (small) queue when the answer finally arrives.
    expect(h.calls.map((c) => c.e164s)).toEqual([
      [num(0).e164, num(1).e164],
      [num(2).e164, num(3).e164],
      [num(4).e164, num(5).e164],
      [num(0).e164, num(1).e164],
    ]);
    for (const n of numbers(6)) expect(status(h.store, 'telegram', n)).toBe('yes');
    expect(summary).toMatchObject({ answered: 6, remaining: 0, errors: 1, stopped: 'done' });
  });

  it('keeps only the unanswered tail of a retried batch queued after a partial answer', async () => {
    const h = harness(makeConfig({ batchSize: 2, minIntervalMs: 0, errorCooldownMs: 0 }));
    const calls: string[][] = [];
    const handler: Handler = (account, batch) => {
      calls.push(batch.map((n) => n.e164));
      if (calls.length === 1) throw new Error('transient lookup failure');
      if (calls.length === 4) {
        // The retried batch answers its first number but is cut off before the second.
        throw new RateLimited('cut off', 1, new Map([[(batch[0] as PhoneNumber).e164, 'yes']]));
      }
      return allYes(account, batch, calls.length);
    };
    const [summary] = await h.run({ numbers: numbers(6), handlers: { telegram: handler } });

    expect(calls).toEqual([
      [num(0).e164, num(1).e164],
      [num(2).e164, num(3).e164],
      [num(4).e164, num(5).e164],
      [num(0).e164, num(1).e164],
      [num(1).e164],
    ]);
    for (const n of numbers(6)) expect(status(h.store, 'telegram', n)).toBe('yes');
    expect(summary).toMatchObject({ answered: 6, remaining: 0, errors: 1, stopped: 'done' });
  });


  it('does not park batches while nothing succeeds: a real outage still drops the account', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const down: Handler = () => {
      throw new Error('network down');
    };
    const [summary] = await h.run({ numbers: numbers(4), handlers: { telegram: down } });
    expect(h.calls).toHaveLength(MAX_CONSECUTIVE_ERRORS);
    expect(summary).toMatchObject({ stopped: 'no_accounts', remaining: 4 });
    expect(h.logs.join('\n')).toContain('dropped for the rest of this run');
  });

  it('lets the other accounts carry on past a number one account keeps failing on', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const poison = num(1);
    const handler: Handler = (_account, batch) => {
      if (batch.some((n) => n.e164 === poison.e164)) throw new Error('unmapped response for the number');
      return allYes(_account, batch, 0);
    };
    const [summary] = await h.run({ numbers: numbers(8), handlers: { telegram: handler }, accounts: { telegram: ['a', 'b'] } });
    expect(summary).toMatchObject({ answered: 7, remaining: 1, stopped: 'done' });
    for (const name of ['a', 'b']) expect(h.store.getAccount('telegram', name).disabledReason).toBeNull();
  });

  it('parks a poison batch even when it is the last work left, without cooldown or dropping the accounts', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const poison = num(5);
    const handler: Handler = (_account, batch) => {
      if (batch.some((n) => n.e164 === poison.e164)) throw new Error('unmapped response for the number');
      return allYes(_account, batch, 0);
    };
    const [summary] = await h.run({ numbers: numbers(6), handlers: { telegram: handler }, accounts: { telegram: ['a', 'b'] } });

    expect(summary).toMatchObject({ answered: 5, remaining: 1, stopped: 'done' });
    expect(h.calls.filter((c) => c.e164s.includes(poison.e164))).toHaveLength(MAX_BATCH_FAILURES);
    expect(h.logs.join('\n')).toContain('leaving them unknown for this run');
    expect(h.logs.join('\n')).not.toContain('dropped for the rest of this run');
    for (const name of ['a', 'b']) {
      expect(h.store.getAccount('telegram', name).disabledReason).toBeNull();
    }
    // Neither the account that failed first nor the one that parked the batch keeps a cooldown for it.
    for (const name of ['a', 'b']) {
      expect(h.store.getAccount('telegram', name).cooldownUntil).toBe(0);
    }
  });

  it('parks a final poison batch on a single account too', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const poison = num(3);
    const handler: Handler = (_account, batch) => {
      if (batch.some((n) => n.e164 === poison.e164)) throw new Error('unmapped response for the number');
      return allYes(_account, batch, 0);
    };
    const [summary] = await h.run({ numbers: numbers(4), handlers: { telegram: handler } });
    expect(summary).toMatchObject({ answered: 3, remaining: 1, stopped: 'done' });
    expect(h.calls.filter((c) => c.e164s.includes(poison.e164))).toHaveLength(MAX_BATCH_FAILURES);
    expect(h.logs.join('\n')).not.toContain('dropped for the rest of this run');
    expect(h.store.getAccount('telegram', 'a').cooldownUntil).toBe(0);
  });
});

describe('attempted vs conclusive vs inconclusive, and the INCOMPLETE banner', () => {
  const banner = (summaries: AppRunSummary[]) => describeRun(summaries, undefined, NOON).banner.join('\n');

  it('a refresh that comes back unknown keeps the old answer, counts as inconclusive and is never "done"', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const [n] = numbers(1) as [PhoneNumber];
    const old = NOON - 40 * DAY;
    h.store.saveResults('telegram', new Map<string, CheckStatus>([[n.e164, 'not_found']]), old);
    const summaries = await h.run({ numbers: [n], handlers: { telegram: () => new Map() } });
    expect(summaries[0]).toMatchObject({
      needed: 1,
      attempted: 1,
      answered: 1,
      conclusive: 0,
      inconclusive: 1,
      retainedStale: 1,
      remaining: 0,
      stopped: 'done',
    });
    expect(h.store.getResult(n.e164, 'telegram')).toEqual({ status: 'not_found', checkedAt: old });
    const run = describeRun(summaries);
    expect(run.incomplete).toBe(true);
    expect(run.lines.join('\n')).not.toMatch(/\(done\)|all conclusive/);
    expect(run.lines[0]).toContain('1 keep an older result');
    expect(banner(summaries)).toContain('INCOMPLETE: 1 of 1 check has no fresh');
    expect(banner(summaries)).toContain('unknown answers: 1');
  });

  it('a fully conclusive run has no banner and says so', async () => {
    const h = harness(makeConfig());
    const summaries = await h.run({ numbers: numbers(3) });
    expect(summaries[0]).toMatchObject({ needed: 3, attempted: 3, conclusive: 3, inconclusive: 0, retainedStale: 0 });
    const run = describeRun(summaries);
    expect(run).toMatchObject({ incomplete: false, banner: [], resumeAt: undefined });
    expect(run.lines).toEqual(['telegram: needed 3, attempted 3, conclusive 3, inconclusive 0, no answer 0 (all conclusive)']);
    // Nothing needed at all (everything fresh) is complete too.
    const again = await h.run({ numbers: numbers(3) });
    expect(describeRun(again)).toMatchObject({ incomplete: false, banner: [] });
  });

  it('no account: nothing attempted, no_accounts is named', async () => {
    const h = harness(makeConfig());
    const summaries = await h.run({ numbers: numbers(4), accounts: { telegram: [] } });
    expect(summaries[0]).toMatchObject({ needed: 4, attempted: 0, conclusive: 0, inconclusive: 4, stopped: 'no_accounts' });
    expect(banner(summaries)).toContain('no_accounts');
    expect(describeRun(summaries).lines[0]).toContain('no usable account');
  });

  it('rate limited with --no-wait: cooldown reason and the exact resume time', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const limited: Handler = () => {
      throw new RateLimited('slow down', 10_000, new Map());
    };
    const summaries = await h.run({ numbers: numbers(3), handlers: { telegram: limited }, wait: false });
    expect(summaries[0]).toMatchObject({
      stopped: 'blocked',
      attempted: 3,
      conclusive: 0,
      inconclusive: 3,
      blockedBy: ['cooldown'],
      resumeAt: NOON + 10_000,
    });
    const text = banner(summaries);
    expect(text).toContain('cooldown');
    expect(text).toContain(`Next resume: ${formatLocalTime(NOON + 10_000, NOON)}`);
  });

  it('daily cap with --no-wait: daily cap reason, resume at local midnight', async () => {
    const h = harness(makeConfig({ batchSize: 2, dailyCap: 2, minIntervalMs: 0 }));
    const summaries = await h.run({ numbers: numbers(5), wait: false });
    expect(summaries[0]).toMatchObject({
      stopped: 'blocked',
      attempted: 2,
      conclusive: 2,
      inconclusive: 3,
      remaining: 3,
      blockedBy: ['daily_cap'],
      resumeAt: nextLocalMidnight(NOON),
    });
    expect(banner(summaries)).toContain('daily cap');
    expect(banner(summaries)).toContain(`Next resume: ${formatLocalTime(nextLocalMidnight(NOON), NOON)}`);
  });

  it('unexpected errors are counted and named', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const down: Handler = () => {
      throw new Error('network down');
    };
    const summaries = await h.run({ numbers: numbers(2), handlers: { telegram: down }, wait: false });
    expect(summaries[0]?.errors).toBeGreaterThan(0);
    expect(summaries[0]).toMatchObject({ conclusive: 0, inconclusive: 2 });
    expect(banner(summaries)).toContain(`errors: ${summaries[0]?.errors} ${summaries[0]?.errors === 1 ? 'batch' : 'batches'} failed`);
  });

  it('a parked batch is counted and named while the rest is conclusive', async () => {
    const h = harness(makeConfig({ batchSize: 1, minIntervalMs: 0 }));
    const poison = num(2);
    const handler: Handler = (account, batch) => {
      if (batch.some((n) => n.e164 === poison.e164)) throw new Error('unmapped response for the number');
      return allYes(account, batch, 0);
    };
    const summaries = await h.run({ numbers: numbers(6), handlers: { telegram: handler } });
    expect(summaries[0]).toMatchObject({ needed: 6, conclusive: 5, inconclusive: 1, parkedBatches: 1, parked: 1, remaining: 1 });
    expect(banner(summaries)).toContain('parked batches: 1 batch, 1 number');
  });

  it('an interrupted run is incomplete and says aborted', async () => {
    const abort = new AbortController();
    const h = harness(makeConfig());
    const stopAfterFirst: Handler = (account, batch, callNo) => {
      if (callNo === 1) abort.abort();
      return allYes(account, batch, callNo);
    };
    const summaries = await h.run({ numbers: numbers(6), signal: abort.signal, handlers: { telegram: stopAfterFirst } });
    expect(summaries[0]).toMatchObject({ stopped: 'aborted', conclusive: 2, inconclusive: 4 });
    expect(banner(summaries)).toContain('aborted');
  });

  it('names every app that is incomplete and the earliest resume time across apps', async () => {
    const h = harness(makeConfig({ batchSize: 10 }));
    const limited = (ms: number): Handler => () => {
      throw new RateLimited('slow down', ms, new Map());
    };
    const summaries = await h.run({
      apps: ['telegram', 'whatsapp', 'zalo'],
      numbers: numbers(2),
      handlers: { telegram: limited(20_000), whatsapp: limited(5_000) },
      wait: false,
    });
    const run = describeRun(summaries);
    expect(run.resumeAt).toBe(NOON + 5_000);
    expect(run.banner.join('\n')).toMatch(/telegram: 2 inconclusive[\s\S]*whatsapp: 2 inconclusive/);
    expect(run.banner.join('\n')).not.toMatch(/ zalo: \d+ inconclusive/);
    expect(run.lines.at(-1)).toContain('all conclusive');
  });
});
