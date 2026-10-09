import { describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Config } from '../src/config.ts';
import { describeRun, runChecks } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { AccountBanned, APPS, RateLimited, type Adapter, type App, type CheckStatus, type PhoneNumber } from '../src/types.ts';
import { Prng } from './helpers/prng.ts';

/*
 * Property: the INCOMPLETE banner is shown iff some number that needed a check at the start of a run does
 * not hold a yes/not_found written during that run at its end. The oracle reads only the store (no summary
 * counters, no scheduler helpers), so it cannot share a bug with the code it checks.
 */

const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const START = new Date(2026, 9, 8, 12, 0, 0).getTime();
const ITERATIONS = 400;

const conclusive = (status: string | undefined) => status === 'yes' || status === 'not_found';

function numbersOf(count: number): PhoneNumber[] {
  return Array.from({ length: count }, (_, i) => ({ e164: `+8490200${String(i).padStart(4, '0')}`, country: 'VN' }));
}

function configOf(prng: Prng): Config {
  const apps = structuredClone(DEFAULT_APPS);
  for (const app of APPS) {
    Object.assign(apps[app], {
      batchSize: prng.range(1, 3),
      dailyCap: prng.range(1, 6),
      minIntervalMs: prng.pick([0, 200, 1000]),
      jitterMs: 7, // never lets a later write land on exactly an earlier timestamp (see the oracle)
      rateLimitCooldownMs: prng.range(1, 5) * 1000,
      errorCooldownMs: prng.range(1, 5) * 1000,
    });
  }
  return { defaultRegion: 'VN', dataDir: '/unused', maxAgeDays: 30, apps };
}

describe('INCOMPLETE is shown iff work stays inconclusive (independent oracle over the store)', () => {
  it(`holds over ${ITERATIONS} random scenarios with random answers, errors, rate limits, bans, caps, aborts and old/future results`, () => {
    let incomplete = 0;
    let complete = 0;
    return (async () => {
      for (let seed = 1; seed <= ITERATIONS; seed += 1) {
        const prng = new Prng(seed * 7919);
        const store = new Store(':memory:');
        const config = configOf(prng);
        const nums = numbersOf(prng.range(0, 8));
        const apps = prng.shuffle(APPS).slice(0, prng.range(1, 3)) as App[];
        let clock = START;

        // Pre-seed: conclusive results of every age (fresh, stale, future), and unknowns.
        for (const app of apps) {
          for (const n of nums) {
            if (!prng.chance(0.5)) continue;
            const status = prng.pick<CheckStatus>(['yes', 'not_found', 'unknown']);
            const at = START + prng.pick([-90 * DAY, -40 * DAY, -DAY, -1000, 0, 1234, 2 * DAY + 17]);
            store.saveResults(app, new Map([[n.e164, status]]), at);
          }
        }

        for (let run = 0; run < prng.range(1, 3); run += 1) {
          const abort = new AbortController();
          let calls = 0;
          const accountsOf = new Map(apps.map((app) => [app, prng.pick([[], ['a'], ['a'], ['a', 'b']])]));
          const adapter = (app: App): Adapter => ({
            app,
            async login() {},
            async open() {
              return {
                async check(batch) {
                  calls += 1;
                  if (calls > 30) abort.abort();
                  const roll = prng.next();
                  if (roll < 0.1) throw new Error('boom');
                  if (roll < 0.15) throw new RateLimited('slow', prng.range(1, 4) * 1000, new Map(batch.slice(0, 1).map((n) => [n.e164, 'yes' as const])));
                  if (roll < 0.17) throw new AccountBanned('logged out');
                  const out = new Map<string, CheckStatus>();
                  for (const n of batch) {
                    const r = prng.next();
                    if (r < 0.45) out.set(n.e164, 'yes');
                    else if (r < 0.7) out.set(n.e164, 'not_found');
                    else if (r < 0.9) out.set(n.e164, 'unknown');
                    // else: silently unanswered
                  }
                  return out;
                },
                async close() {},
              };
            },
          });

          const startedAt = clock;
          const before = new Map(apps.map((app) => [app, store.allResults(app)]));
          // Oracle: needed = in-scope numbers without a yes/not_found that is non-negative-aged and younger than max age.
          const needed = new Map<App, PhoneNumber[]>();
          for (const app of apps) {
            const stored = store.allResults(app);
            needed.set(
              app,
              nums.filter((n) => {
                const r = stored.get(n.e164);
                return !(r !== undefined && conclusive(r.status) && startedAt - r.checkedAt >= 0 && startedAt - r.checkedAt < MAX_AGE);
              }),
            );
          }

          const summaries = await runChecks({
            store,
            config,
            numbers: nums,
            apps,
            maxAgeMs: MAX_AGE,
            wait: prng.chance(0.5),
            signal: abort.signal,
            loadAdapter: async (app) => adapter(app),
            listAccounts: (app) => accountsOf.get(app) ?? [],
            accountDir: (app, name) => `/unused/${app}/${name}`,
            now: () => clock,
            sleep: async (ms) => {
              clock += Math.max(ms, 0);
              if (clock > startedAt + 40 * DAY) abort.abort();
            },
            random: () => 0.9,
          });
          // Time between runs: sometimes a clock that went backwards. The odd millisecond keeps a later
          // write from landing on exactly the timestamp of an earlier one, which no store-only oracle could tell apart.
          const endedAt = clock;
          clock += prng.pick([0, 1000, DAY, -3_600_007]);

          let missing = 0;
          for (const app of apps) {
            const stored = store.allResults(app);
            const was = before.get(app);
            const gone = (needed.get(app) ?? []).filter((n) => {
              const r = stored.get(n.e164);
              const old = was?.get(n.e164);
              // Written during this run: a yes/not_found that differs from the snapshot taken before the run.
              const written = r !== undefined && (old === undefined || old.status !== r.status || old.checkedAt !== r.checkedAt);
              return !(written && conclusive(r.status));
            }).length;
            missing += gone;
            const summary = summaries.find((s) => s.app === app);
            expect(summary?.inconclusive, `seed ${seed} run ${run} ${app}`).toBe(gone);
            expect(summary?.needed, `seed ${seed} run ${run} ${app} needed`).toBe(needed.get(app)?.length);
            const line = describeRun(summaries).lines.find((l) => l.startsWith(`${app}:`)) ?? '';
            expect(line.includes('(all conclusive)'), `seed ${seed} run ${run} ${app} line: ${line}`).toBe(gone === 0 && summary?.stopped === 'done');
            expect(line).not.toContain('(done)');
          }
          const description = describeRun(summaries);
          const shown = description.banner.some((l) => l.startsWith('INCOMPLETE'));
          expect(shown, `seed ${seed} run ${run}: banner vs ${missing} inconclusive (ended ${endedAt})`).toBe(missing > 0);
          expect(description.incomplete).toBe(shown);
          if (shown) {
            incomplete += 1;
            // every incomplete app is listed with at least one reason
            for (const s of summaries) {
              if (s.inconclusive > 0) expect(description.banner.join('\n')).toContain(`  ${s.app}: ${s.inconclusive} inconclusive`);
            }
          } else {
            complete += 1;
            expect(description.banner).toEqual([]);
          }
        }
        store.close();
      }
      // Non-vacuous both ways.
      expect(incomplete).toBeGreaterThan(100);
      expect(complete).toBeGreaterThan(100);
    })();
  }, 120_000);
});
