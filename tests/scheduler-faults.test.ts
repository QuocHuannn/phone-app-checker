import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Config } from '../src/config.ts';
import { runChecks, type AppRunSummary } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { APPS, RateLimited, type Adapter, type App, type CheckStatus, type PacingSettings, type PhoneNumber, type Session } from '../src/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 9, 8, 12, 0, 0).getTime();

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // closed by the test
    }
  }
});

const numbers = (count: number): PhoneNumber[] => Array.from({ length: count }, (_, i) => ({ e164: `+8490100${String(i).padStart(4, '0')}`, country: 'VN' }));

function config(pacing: Partial<PacingSettings> = {}): Config {
  const apps = structuredClone(DEFAULT_APPS);
  for (const app of APPS) {
    Object.assign(apps[app], { batchSize: 2, dailyCap: 1000, minIntervalMs: 1000, jitterMs: 0, rateLimitCooldownMs: 60_000, errorCooldownMs: 5_000 }, pacing);
  }
  return { defaultRegion: 'VN', dataDir: '/unused', maxAgeDays: 30, theme: 'auto', apps };
}

interface Rig {
  store: Store;
  clock: { t: number };
  opened: number;
  closed: number;
  logs: string[];
  run(options: { apps?: App[]; numbers: PhoneNumber[]; session: (account: string, callNo: number) => Partial<Session>; closeTimeoutMs?: number; wait?: boolean; config?: Config }): Promise<AppRunSummary[]>;
}

function rig(store = new Store(':memory:')): Rig {
  stores.push(store);
  const state: Rig = {
    store,
    clock: { t: NOON },
    opened: 0,
    closed: 0,
    logs: [],
    run: (options) => {
      let calls = 0;
      const adapter = (app: App): Adapter => ({
        app,
        async login() {},
        async open(ctx) {
          state.opened += 1;
          const custom = options.session(ctx.account, ++calls);
          return {
            check: custom.check ?? (async (batch) => new Map(batch.map((n) => [n.e164, 'yes' as const]))),
            close: async () => {
              state.closed += 1;
              await custom.close?.();
            },
          };
        },
      });
      return runChecks({
        store,
        config: options.config ?? config(),
        numbers: options.numbers,
        apps: options.apps ?? ['telegram'],
        maxAgeMs: 30 * DAY,
        wait: options.wait ?? false,
        loadAdapter: async (app) => adapter(app),
        listAccounts: () => ['a'],
        accountDir: () => '/unused',
        now: () => state.clock.t,
        sleep: async (ms) => {
          state.clock.t += ms;
        },
        random: () => 0,
        log: (message) => state.logs.push(message),
        ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      });
    },
  };
  return state;
}

const answered = (store: Store, app: App, count: number) => numbers(count).filter((n) => store.getResult(n.e164, app) !== undefined).length;

describe('adapters that misbehave', () => {
  it.each([
    ['rejects with undefined', () => Promise.reject(undefined)],
    ['rejects with null', () => Promise.reject(null)],
    ['rejects with a string', () => Promise.reject('plain text reason')],
    ['throws a number', () => Promise.reject(404)],
    ['resolves undefined', () => Promise.resolve(undefined as unknown as Map<string, CheckStatus>)],
    ['resolves null', () => Promise.resolve(null as unknown as Map<string, CheckStatus>)],
    ['resolves an array', () => Promise.resolve([] as unknown as Map<string, CheckStatus>)],
    ['resolves a plain object', () => Promise.resolve({ '+84901000000': 'yes' } as unknown as Map<string, CheckStatus>)],
  ])('check() that %s counts as a failed lookup: nothing is recorded as an answer, the account rests', async (_name, result) => {
    const r = rig();
    const [summary] = await r.run({ numbers: numbers(4), session: () => ({ check: result }) });
    expect(summary).toMatchObject({ answered: 0, remaining: 4 });
    expect(answered(r.store, 'telegram', 4)).toBe(0);
    expect(r.store.getAccount('telegram', 'a').usedToday).toBe(0);
    expect(r.store.getAccount('telegram', 'a').cooldownUntil).toBeGreaterThan(NOON);
    expect(r.logs.join('\n')).toContain('error (1/3)');
    // The numbers are suspects for the next run.
    expect(r.store.failedChecks('telegram').size).toBe(2);
  });

  it('a session that cannot be opened is an account problem, not a verdict on the numbers', async () => {
    const r = rig();
    const adapter: Adapter = {
      app: 'telegram',
      async login() {},
      async open() {
        throw new Error('cannot reach the server');
      },
    };
    const [summary] = await runChecks({
      store: r.store,
      config: config(),
      numbers: numbers(4),
      apps: ['telegram'],
      maxAgeMs: 30 * DAY,
      wait: false,
      loadAdapter: async () => adapter,
      listAccounts: () => ['a'],
      accountDir: () => '/unused',
      now: () => r.clock.t,
      sleep: async (ms) => {
        r.clock.t += ms;
      },
      random: () => 0,
      log: (message) => r.logs.push(message),
    });
    expect(summary).toMatchObject({ answered: 0, remaining: 4 });
    expect(r.store.failedChecks('telegram').size).toBe(0);
  });

  it('garbage inside a result map is unknown, never stored as a status and never thrown', async () => {
    const r = rig();
    const nums = numbers(5);
    const weird = new Map<string, unknown>([
      [nums[0]!.e164, 'YES'],
      [nums[1]!.e164, 1],
      [nums[2]!.e164, null],
      [nums[3]!.e164, { status: 'yes' }],
      [nums[4]!.e164, 'yes'],
      ['+84999999999', 'yes'],
      ['', 'yes'],
    ]);
    const [summary] = await r.run({
      numbers: nums,
      session: () => ({ check: async (batch) => new Map(batch.map((n) => [n.e164, weird.get(n.e164) as CheckStatus])) }),
    });
    expect(summary).toMatchObject({ answered: 5, remaining: 0 });
    expect(nums.map((n) => r.store.getResult(n.e164, 'telegram')?.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'yes']);
    expect(r.store.getResult('+84999999999', 'telegram')).toBeUndefined();
  });

  it('partial answers carried by a throttle are used only for numbers of the batch', async () => {
    const r = rig();
    const nums = numbers(6);
    const [summary] = await r.run({
      numbers: nums,
      session: () => ({
        check: async (batch) => {
          throw new RateLimited('slow down', 10_000, new Map<string, CheckStatus>([
            [batch[0]!.e164, 'yes'],
            [nums[5]!.e164, 'not_found'], // not part of this batch
            ['+84999999999', 'yes'],
            [batch[1]!.e164, 'maybe' as CheckStatus],
          ]));
        },
      }),
    });
    expect(summary?.answered).toBe(1);
    expect(r.store.getResult(nums[0]!.e164, 'telegram')?.status).toBe('yes');
    expect(r.store.getResult(nums[5]!.e164, 'telegram')).toBeUndefined();
    expect(r.store.getResult('+84999999999', 'telegram')).toBeUndefined();
    expect(r.store.getResult(nums[1]!.e164, 'telegram')).toBeUndefined();
    expect(r.store.getAccount('telegram', 'a').usedToday).toBe(1);
  });

  it.each([
    [Number.NaN, 60_000],
    [Number.POSITIVE_INFINITY, 60_000],
    [-5, 60_000],
    [0, 60_000],
    [10_000, 10_000],
    [1e15, 1e15],
  ])('a throttle that asks to wait %s ms rests the account for %s ms', async (asked, rests) => {
    const r = rig();
    await r.run({ numbers: numbers(2), session: () => ({ check: async () => { throw new RateLimited('slow', asked); } }) });
    const state = r.store.getAccount('telegram', 'a');
    expect(state.cooldownUntil).toBe(NOON + rests);
    expect(Number.isSafeInteger(state.cooldownUntil) || rests === 1e15).toBe(true);
  });

  it('abandons a session whose close() never returns instead of hanging the finished run', async () => {
    const r = rig();
    const started = Date.now();
    const [summary] = await r.run({
      numbers: numbers(4),
      closeTimeoutMs: 40,
      session: () => ({ close: () => new Promise<void>(() => {}) }),
    });
    expect(summary).toMatchObject({ answered: 4, remaining: 0, stopped: 'done' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.logs.join('\n')).toContain('did not close within 40 ms');
    expect(r.closed).toBe(r.opened);
  });

  it('a close() that throws is logged and does not fail the run', async () => {
    const r = rig();
    const [summary] = await r.run({ numbers: numbers(2), session: () => ({ close: async () => { throw new Error('socket already gone'); } }) });
    expect(summary).toMatchObject({ answered: 2, stopped: 'done' });
    expect(r.logs.join('\n')).toContain('socket already gone');
  });
});

describe('database failure in the middle of a run', () => {
  it('stops every app with the real error, closes every session, and a rerun repeats at most the batch in flight', async () => {
    const r = rig();
    const nums = numbers(40);
    const original = r.store.saveAccount.bind(r.store);
    let saves = 0;
    r.store.saveAccount = (state) => {
      saves += 1;
      if (saves === 7) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
      original(state);
    };
    const sent: string[] = [];
    const session = () => ({
      check: async (batch: PhoneNumber[]) => {
        sent.push(...batch.map((n) => n.e164));
        return new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));
      },
    });
    await expect(r.run({ numbers: nums, apps: ['telegram', 'whatsapp', 'zalo'], session })).rejects.toThrow('database or disk is full');
    expect(r.closed).toBe(r.opened);
    expect(r.logs.join('\n')).toContain('stopped by an unexpected error: database or disk is full');
    const integrity = r.store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    // The failed transaction was rolled back as a unit: results and account usage agree.
    for (const app of ['telegram', 'whatsapp', 'zalo'] as const) {
      const checked = answered(r.store, app, 40);
      expect(r.store.getAccount(app, 'a').usedToday).toBe(checked);
    }

    r.store.saveAccount = original;
    r.clock.t += DAY;
    const summaries = await r.run({ numbers: nums, apps: ['telegram', 'whatsapp', 'zalo'], session });
    expect(summaries.every((s) => s.stopped === 'done' && s.remaining === 0)).toBe(true);
    for (const app of ['telegram', 'whatsapp', 'zalo'] as const) expect(answered(r.store, app, 40)).toBe(40);
    // 3 apps x 40 numbers; only the one batch (2 numbers) whose commit failed is asked again.
    expect(sent.length).toBeLessThanOrEqual(3 * 40 + 2);
  });
});

describe('numbers a platform keeps rejecting', () => {
  const poisonSet = (list: PhoneNumber[]) => new Set(list.map((n) => n.e164));
  const rejecting = (bad: Set<string>, sent: string[][]) => () => ({
    check: async (batch: PhoneNumber[]) => {
      sent.push(batch.map((n) => n.e164));
      if (batch.some((n) => bad.has(n.e164))) throw new Error('platform response not understood');
      return new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));
    },
  });

  it('three of them at the head of the list no longer stop every later number, run after run', async () => {
    const r = rig();
    const nums = numbers(13);
    const bad = poisonSet(nums.slice(0, 3));
    const sent: string[][] = [];
    const cfg = config({ batchSize: 1, minIntervalMs: 0, errorCooldownMs: 0 });

    // Nothing has succeeded yet, so the first run cannot tell this from an outage and drops the account...
    const [first] = await r.run({ numbers: nums, session: rejecting(bad, sent), config: cfg });
    expect(first).toMatchObject({ answered: 0, remaining: 13, stopped: 'no_accounts' });
    expect(r.store.failedChecks('telegram').size).toBe(3);

    // ...but the next run remembers them: it checks the other ten first and parks the three.
    r.clock.t += DAY;
    sent.length = 0;
    const [second] = await r.run({ numbers: nums, session: rejecting(bad, sent), config: cfg });
    expect(second).toMatchObject({ answered: 10, remaining: 3, stopped: 'done' });
    expect(sent.slice(0, 10).flat()).toEqual(nums.slice(3).map((n) => n.e164));
    expect(sent.slice(10).flat().every((e164) => bad.has(e164))).toBe(true);
    expect(r.store.getAccount('telegram', 'a').disabledReason).toBeNull();
    for (const n of nums.slice(3)) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe('yes');
    for (const n of nums.slice(0, 3)) expect(r.store.getResult(n.e164, 'telegram')).toBeUndefined();
  });

  it('the healthy numbers that shared a batch with a rejected one are answered on the next run, alone', async () => {
    const r = rig();
    const nums = numbers(12);
    const bad = poisonSet([nums[6]!]);
    const sent: string[][] = [];
    const cfg = config({ batchSize: 4, minIntervalMs: 0, errorCooldownMs: 0 });

    const [first] = await r.run({ numbers: nums, session: rejecting(bad, sent), config: cfg });
    // The batch holding the bad number is parked; its three neighbours stay unknown for this run.
    expect(first).toMatchObject({ answered: 8, remaining: 4, stopped: 'done' });
    expect(nums.slice(4, 8).filter((n) => r.store.getResult(n.e164, 'telegram') !== undefined)).toHaveLength(0);

    sent.length = 0;
    r.clock.t += DAY;
    const [second] = await r.run({ numbers: nums, session: rejecting(bad, sent), config: cfg });
    expect(second).toMatchObject({ answered: 3, remaining: 1, stopped: 'done' });
    expect(sent.every((batch) => batch.length === 1)).toBe(true);
    expect(sent.flat().sort()).toEqual(nums.slice(4, 8).map((n) => n.e164));
    expect(sent.filter((batch) => batch[0] === nums[6]!.e164)).toHaveLength(1);
    for (const n of nums) expect(r.store.getResult(n.e164, 'telegram')?.status).toBe(n === nums[6] ? undefined : 'yes');
  });

  it('forgets a number as soon as it is answered, and a rejected number never blocks the other apps', async () => {
    const r = rig();
    const nums = numbers(6);
    const bad = poisonSet([nums[1]!]);
    const sent: string[][] = [];
    await r.run({ numbers: nums, apps: ['telegram', 'zalo'], session: rejecting(bad, sent), config: config({ batchSize: 2, minIntervalMs: 0, errorCooldownMs: 0 }) });
    expect(r.store.failedChecks('telegram').has(nums[1]!.e164)).toBe(true);
    // Its batch partner is remembered too (it is checked alone next time); numbers of other batches are not.
    expect(r.store.failedChecks('telegram').has(nums[0]!.e164)).toBe(true);
    expect(r.store.failedChecks('telegram').has(nums[2]!.e164)).toBe(false);
    // The platform is fixed: the next run answers it and the record disappears.
    r.clock.t += DAY;
    await r.run({ numbers: nums, apps: ['telegram', 'zalo'], session: rejecting(new Set(), sent), config: config({ batchSize: 2, minIntervalMs: 0, errorCooldownMs: 0 }) });
    expect(r.store.failedChecks('telegram').size).toBe(0);
    expect(r.store.failedChecks('zalo').size).toBe(0);
    expect(nums.every((n) => r.store.getResult(n.e164, 'telegram')?.status === 'yes')).toBe(true);
  });
});
