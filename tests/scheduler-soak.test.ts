import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_SCOPE } from '../src/adapters/index.ts';
import { DEFAULT_APPS, type Config } from '../src/config.ts';
import type { InputEntry } from '../src/csv.ts';
import { buildReport, formatReportCsv, type ReportRow } from '../src/report.ts';
import { describeRun, runChecks, selectPending, type AppRunSummary } from '../src/scheduler.ts';
import { localDay, Store, type StoredResult } from '../src/store.ts';
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
import { Prng } from './helpers/prng.ts';
import { VirtualClock } from './helpers/virtual-clock.ts';

/*
 * Scheduler soak: thousands of numbers, five fake adapters with random throttling, bans, errors,
 * poison numbers, sloppy answers and aborts at random points, on a virtual clock (no real waiting).
 * Everything is driven by seeded PRNGs, so a failure reproduces from its seed.
 */

/** Fixed so CI is deterministic; set SOAK_SEED_OFFSET to explore other schedules (a failure prints its seed). */
const SEED_OFFSET = Number(process.env.SOAK_SEED_OFFSET ?? 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const START = new Date(2026, 9, 8, 9, 0, 0).getTime();
// Longer than the whole simulated campaign, so answers never expire mid-run (expiry has its own test).
const MAX_AGE_MS = 120 * DAY;

// Sized so one account finishes 10k numbers well inside max-age: a list that needs longer
// than max-age can never complete, because the first answers expire before the last one arrives.
const PACING: Record<App, Partial<PacingSettings>> = {
  telegram: { batchSize: 25, dailyCap: 600, minIntervalMs: 90_000, jitterMs: 60_000, rateLimitCooldownMs: 6 * HOUR },
  whatsapp: { batchSize: 40, dailyCap: 900, minIntervalMs: 120_000, jitterMs: 60_000, rateLimitCooldownMs: 6 * HOUR },
  zalo: { batchSize: 10, dailyCap: 400, minIntervalMs: 30_000, jitterMs: 30_000, rateLimitCooldownMs: 24 * HOUR },
  viber: { batchSize: 50, dailyCap: 1500, minIntervalMs: 30 * 60_000, jitterMs: 10 * 60_000, rateLimitCooldownMs: 12 * HOUR },
  line: { batchSize: 10, dailyCap: 700, minIntervalMs: 120_000, jitterMs: 60_000, rateLimitCooldownMs: 24 * HOUR },
  threema: { batchSize: 10, dailyCap: 700, minIntervalMs: 120_000, jitterMs: 60_000, rateLimitCooldownMs: 24 * HOUR },
  matrix: { batchSize: 10, dailyCap: 700, minIntervalMs: 120_000, jitterMs: 60_000, rateLimitCooldownMs: 24 * HOUR },
};

function makeConfig(): Config {
  const apps = structuredClone(DEFAULT_APPS);
  for (const app of APPS) Object.assign(apps[app], { enabled: true, errorCooldownMs: 10 * 60_000 }, PACING[app]);
  return { defaultRegion: 'VN', dataDir: '/unused', maxAgeDays: 30, apps };
}

/** Deterministic hash used for ground truth and sloppy-answer choices. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function truthOf(app: App, e164: string, epoch: number): 'yes' | 'not_found' {
  return hash(`${epoch}|${app}|${e164}`) % 3 === 0 ? 'yes' : 'not_found';
}

function makeNumbers(total: number): PhoneNumber[] {
  return Array.from({ length: total }, (_, i) =>
    i % 10 < 7
      ? { e164: `+849${String(i).padStart(8, '0')}`, country: 'VN' }
      : { e164: `+658${String(i).padStart(7, '0')}`, country: 'SG' },
  );
}

const definitive = (value: unknown): value is 'yes' | 'not_found' => value === 'yes' || value === 'not_found';

interface SimOptions {
  seed: number;
  total: number;
  /** Abort the run at random points (calls and sleeps), then start a new run on the same store. */
  kill: boolean;
  poisonPerApp: number;
  /** Mean number of adapter calls between aborts. */
  killEvery?: number;
}

class Sim {
  readonly config = makeConfig();
  readonly store = new Store(":memory:");
  readonly clock = new VirtualClock(START);
  readonly numbers: PhoneNumber[];
  readonly poison = new Map<App, Set<string>>();
  readonly violations: string[] = [];
  readonly sent = new Map<string, { status: 'yes' | 'not_found'; at: number }>();
  readonly committed = new Map<string, number>();
  private readonly hasher = createHash('sha256');
  private digestHex: string | undefined;
  readonly appRng = {} as Record<App, Prng>;
  readonly killRng: Prng;
  readonly restartRng: Prng;
  abort = new AbortController();
  calls = 0;
  runs = 0;
  abortedRuns = 0;
  incompleteRuns = 0;
  truthEpoch = 0;
  private callsUntilKill: number;

  readonly options: SimOptions;

  constructor(given: SimOptions) {
    const options = { ...given, seed: given.seed + SEED_OFFSET };
    this.options = options;
    this.numbers = makeNumbers(options.total);
    this.killRng = new Prng(options.seed * 7 + 1);
    this.restartRng = new Prng(options.seed * 7 + 2);
    this.callsUntilKill = this.nextKillGap();
    const poisonRng = new Prng(options.seed * 7 + 3);
    for (const app of APPS) {
      this.appRng[app] = new Prng(options.seed * 131 + APPS.indexOf(app) + 1);
      const candidates = this.numbers.filter((n) => APP_SCOPE[app](n));
      const chosen = new Set<string>();
      while (chosen.size < options.poisonPerApp) chosen.add(poisonRng.pick(candidates).e164);
      this.poison.set(app, chosen);
    }
  }

  /** Hex digest of every adapter call made so far, in order (final once the simulation is over). */
  callDigest(): string {
    this.digestHex ??= this.hasher.digest('hex');
    return this.digestHex;
  }

  inScope(app: App): PhoneNumber[] {
    return this.numbers.filter((n) => APP_SCOPE[app](n));
  }

  violation(message: string): void {
    if (this.violations.length < 20) this.violations.push(message);
  }

  private nextKillGap(): number {
    return this.killRng.range(1, (this.options.killEvery ?? 120) * 2);
  }

  /** Called at the start of every adapter call: maybe abort the run, as Ctrl-C mid-batch would. */
  private onCall(): void {
    if (!this.options.kill) return;
    this.callsUntilKill -= 1;
    if (this.callsUntilKill <= 0) {
      this.callsUntilKill = this.nextKillGap();
      this.abort.abort();
    }
  }

  sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (this.options.kill && this.killRng.chance(0.004)) this.abort.abort();
    return this.clock.sleep(ms, signal);
  };

  record(app: App, account: string, batch: PhoneNumber[], answers: ReadonlyMap<string, unknown>, counted: number): void {
    const now = this.clock.now();
    for (const n of batch) {
      const value = answers.get(n.e164);
      if (definitive(value)) this.sent.set(`${app}|${n.e164}`, { status: value, at: now });
    }
    const key = `${app}|${account}|${localDay(now)}`;
    this.committed.set(key, (this.committed.get(key) ?? 0) + counted);
  }

  adapter(app: App): Adapter {
    const rng = this.appRng[app];
    const cfg = this.config.apps[app];
    const poison = this.poison.get(app) as Set<string>;
    return {
      app,
      login: async () => {},
      open: async (ctx) => {
        if (rng.chance(0.02)) throw new Error(`cannot open session for ${ctx.account}`);
        return {
          check: async (batch) => {
            this.calls += 1;
            this.onCall();
            const now = this.clock.now();
            const state = this.store.getAccount(app, ctx.account);
            const used = state.day === localDay(now) ? state.usedToday : 0;
            if (batch.length === 0) this.violation(`${app}/${ctx.account}: empty batch`);
            if (batch.length > cfg.batchSize) this.violation(`${app}/${ctx.account}: batch of ${batch.length} > ${cfg.batchSize}`);
            if (used + batch.length > cfg.dailyCap) this.violation(`${app}/${ctx.account}: cap ${used}+${batch.length} > ${cfg.dailyCap}`);
            if (state.disabledReason !== null) this.violation(`${app}/${ctx.account}: used while disabled`);
            if (state.cooldownUntil > now) this.violation(`${app}/${ctx.account}: used during cooldown`);
            if (state.nextAllowedAt > now) this.violation(`${app}/${ctx.account}: used before its pacing interval ended`);
            const seen = new Set<string>();
            for (const n of batch) {
              if (seen.has(n.e164)) this.violation(`${app}: duplicate ${n.e164} inside one batch`);
              seen.add(n.e164);
              if (!APP_SCOPE[app](n)) this.violation(`${app}: out-of-scope number ${n.e164} sent`);
              const earlier = this.sent.get(`${app}|${n.e164}`);
              if (earlier !== undefined && now - earlier.at < MAX_AGE_MS) {
                this.violation(`${app}: ${n.e164} checked again ${Math.round((now - earlier.at) / HOUR)} h after a definitive answer`);
              }
            }
            this.hasher.update(`${app}|${ctx.account}|${batch.map((n) => n.e164).join(',')}\n`);

            const truth = (n: PhoneNumber) => truthOf(app, n.e164, this.truthEpoch);
            if (batch.some((n) => poison.has(n.e164))) throw new Error(`platform rejected request containing ${batch[0]?.e164}`);

            const roll = rng.next();
            const answers = new Map<string, CheckStatus>();
            if (roll < 0.04) {
              const k = rng.int(batch.length + 1);
              for (const n of batch.slice(0, k)) answers.set(n.e164, truth(n));
              this.record(app, ctx.account, batch, answers, k);
              throw new RateLimited(`throttled ${k}`, rng.chance(0.5) ? rng.range(1000, 30 * 60_000) : undefined, answers);
            }
            if (roll < 0.07) throw new Error(`network down while checking ${batch[0]?.e164}`);
            if (roll < 0.073 && ctx.account === 'b') {
              const k = rng.int(batch.length + 1);
              for (const n of batch.slice(0, k)) answers.set(n.e164, truth(n));
              this.record(app, ctx.account, batch, answers, k);
              throw new AccountBanned('account banned', answers);
            }
            for (const n of batch) {
              if (roll >= 0.073 && roll < 0.09 && rng.chance(0.4)) continue; // adapter forgot this number
              if (roll >= 0.09 && roll < 0.1 && rng.chance(0.4)) answers.set(n.e164, 'unknown');
              else if (roll >= 0.1 && roll < 0.11 && rng.chance(0.4)) answers.set(n.e164, 'maybe' as CheckStatus);
              else answers.set(n.e164, truth(n));
            }
            // A sloppy adapter also answers for numbers nobody asked about.
            if (rng.chance(0.03)) answers.set(`+999${rng.digits(9)}`, 'yes');
            const stranger = this.numbers[rng.int(this.numbers.length)]?.e164 ?? '';
            if (rng.chance(0.02) && !seen.has(stranger)) answers.set(stranger, 'yes');
            this.record(app, ctx.account, batch, answers, batch.length);
            return answers;
          },
          close: async () => {
            if (rng.chance(0.01)) throw new Error('close failed');
          },
        };
      },
    };
  }

  /** One scheduler run over the same store (a process start). */
  async runOnce(wait: boolean): Promise<AppRunSummary[]> {
    this.abort = new AbortController();
    this.runs += 1;
    const startedAt = this.clock.now();
    const needed = new Map(APPS.map((app) => [app, selectPending({ store: this.store, numbers: this.numbers, maxAgeMs: MAX_AGE_MS }, app, startedAt)]));
    const summaries = await this.clock.drive(
      runChecks({
        store: this.store,
        config: this.config,
        numbers: this.numbers,
        apps: [...APPS],
        maxAgeMs: MAX_AGE_MS,
        wait,
        signal: this.abort.signal,
        loadAdapter: async (app) => this.adapter(app),
        listAccounts: () => ['a', 'b'],
        accountDir: (app, name) => `/unused/${app}/${name}`,
        now: this.clock.now,
        sleep: this.sleep,
        random: this.restartRng.next.bind(this.restartRng),
      }),
    );
    for (const s of summaries) {
      if (s.answered + s.remaining !== s.needed) {
        this.violation(`${s.app}: answered ${s.answered} + remaining ${s.remaining} != needed ${s.needed} (${s.stopped})`);
      }
      if (s.inconclusive !== s.needed - s.conclusive || s.conclusive > s.answered || s.retainedStale > s.inconclusive) {
        this.violation(`${s.app}: inconsistent counts ${JSON.stringify(s)}`);
      }
    }
    // Independent oracle (store only, no summary counters): a needed number is conclusive iff it now holds a
    // yes/not_found written during this run. INCOMPLETE must be shown iff some needed number is not.
    const description = describeRun(summaries);
    let truthInconclusive = 0;
    for (const app of APPS) {
      const stored = this.store.allResults(app);
      const missing = (needed.get(app) ?? []).filter((n) => {
        const result = stored.get(n.e164);
        return !(result !== undefined && definitive(result.status) && result.checkedAt >= startedAt);
      }).length;
      truthInconclusive += missing;
      const s = summaries.find((x) => x.app === app);
      if (s?.inconclusive !== missing) this.violation(`${app}: inconclusive ${s?.inconclusive} but the store says ${missing}`);
      const line = description.lines.find((l) => l.startsWith(`${app}:`)) ?? '';
      if (missing > 0 && line.endsWith('(all conclusive)')) this.violation(`${app}: line claims completion with ${missing} inconclusive`);
    }
    // (description computed above)
    const shown = description.banner.some((line) => line.startsWith('INCOMPLETE'));
    if (shown !== truthInconclusive > 0 || description.incomplete !== shown) {
      this.violation(`INCOMPLETE banner ${shown ? 'shown' : 'absent'} but ${truthInconclusive} number(s) are inconclusive`);
    }
    if (description.lines.some((line) => /remaining 0 \(done\)/.test(line))) this.violation('a summary line says "remaining 0 (done)"');
    this.incompleteRuns += shown ? 1 : 0;
    if (this.abort.signal.aborted) this.abortedRuns += 1;
    return summaries;
  }

  definitiveCount(): number {
    let count = 0;
    for (const app of APPS) for (const result of this.store.allResults(app).values()) if (definitive(result.status)) count += 1;
    return count;
  }

  complete(): boolean {
    return APPS.every((app) => {
      const stored = this.store.allResults(app);
      return this.inScope(app).every((n) => definitive(stored.get(n.e164)?.status));
    });
  }

  /** Results must only ever move unknown -> answer, or be refreshed after max-age; never regress. */
  private previous = new Map<string, StoredResult>();
  checkMonotonic(): void {
    for (const app of APPS) {
      for (const [e164, result] of this.store.allResults(app)) {
        const before = this.previous.get(`${app}|${e164}`);
        if (before !== undefined && definitive(before.status)) {
          if (result.status !== before.status || result.checkedAt !== before.checkedAt) {
            if (!(definitive(result.status) && result.checkedAt - before.checkedAt >= MAX_AGE_MS)) {
              this.violation(`${app} ${e164}: ${before.status}@${before.checkedAt} became ${result.status}@${result.checkedAt}`);
            }
          }
        }
        this.previous.set(`${app}|${e164}`, result);
      }
    }
  }

  /** Run (and restart after aborts) until every number has an answer, or progress stops. */
  async converge(maxRuns: number): Promise<void> {
    let quietRuns = 0;
    let last = -1;
    let lastProgressAt = this.clock.now();
    for (let i = 0; i < maxRuns; i += 1) {
      const wait = this.options.kill ? this.restartRng.chance(0.85) : true;
      await this.runOnce(wait);
      this.checkMonotonic();
      if (this.complete()) return;
      const count = this.definitiveCount();
      if (count !== last) {
        last = count;
        lastProgressAt = this.clock.now();
        quietRuns = 0;
      } else if (wait && !this.abort.signal.aborted) {
        quietRuns += 1;
      }
      // With poison numbers the work never completes: stop once nothing has moved for days of runs.
      if (this.options.poisonPerApp > 0 && quietRuns >= 3 && this.clock.now() - lastProgressAt > 2 * DAY) return;
      // The operator restarts the tool some time later (sometimes the next day).
      this.clock.advance(this.restartRng.chance(0.1) ? this.restartRng.range(HOUR, DAY) : this.restartRng.range(0, 20 * 60_000));
    }
    throw new Error(`did not converge within ${maxRuns} runs (seed ${this.options.seed})`);
  }

  entries(): InputEntry[] {
    return this.numbers.map((n) => ({ input: n.e164, phone: n }));
  }

  report(withTimes: boolean): string {
    const rows: ReportRow[] = buildReport(this.store, this.entries(), APPS, { now: this.clock.now(), maxAgeMs: MAX_AGE_MS });
    return formatReportCsv(withTimes ? rows : rows.map((row) => ({ ...row, lastCheckedAt: undefined, observations: {} })));
  }

  /** Invariants that must hold after any amount of chaos. */
  assertInvariants(): void {
    expect(this.violations, `seed ${this.options.seed}`).toEqual([]);
    for (const [key, count] of this.committed) {
      const app = key.split('|')[0] as App;
      expect(count, `${key} answers committed in one local day`).toBeLessThanOrEqual(this.config.apps[app].dailyCap);
    }
    const known = new Set(this.numbers.map((n) => n.e164));
    for (const app of APPS) {
      const scope = new Set(this.inScope(app).map((n) => n.e164));
      for (const [e164, result] of this.store.allResults(app)) {
        expect(known.has(e164), `${app} stored an answer for unrequested ${e164}`).toBe(true);
        expect(scope.has(e164), `${app} stored an answer for out-of-scope ${e164}`).toBe(true);
        expect(['yes', 'not_found', 'unknown']).toContain(result.status);
        if (definitive(result.status)) {
          expect(result.status, `${app} ${e164}`).toBe(truthOf(app, e164, this.truthEpoch));
          expect(this.poison.get(app)?.has(e164), `${app} answered poison number ${e164}`).toBe(false);
        }
      }
    }
    for (const state of this.store.listAccounts()) {
      if (state.day === '') continue;
      expect(state.usedToday, `${state.app}/${state.name} usedToday`).toBeLessThanOrEqual(this.config.apps[state.app].dailyCap);
      expect(state.usedToday).toBeGreaterThanOrEqual(0);
    }
    const integrity = this.store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
  }
}

const sims: Sim[] = [];
afterAll(() => {
  for (const sim of sims.splice(0)) sim.store.close();
});

function sim(options: SimOptions): Sim {
  const created = new Sim(options);
  sims.push(created);
  return created;
}

/** Uninterrupted reference runs, shared by the tests that compare against them. */
const reference = new Map<string, Promise<Sim>>();
function cleanRun(seed: number, total: number): Promise<Sim> {
  const key = `${seed}:${total}`;
  let run = reference.get(key);
  if (run === undefined) {
    const s = sim({ seed, total, kill: false, poisonPerApp: 0 });
    run = s.converge(60).then(() => s);
    reference.set(key, run);
  }
  return run;
}

describe('scheduler soak', () => {
  it('uninterrupted run answers every in-scope number correctly (10k numbers x 5 apps)', async () => {
    const s = await cleanRun(11, 10_000);
    s.assertInvariants();
    expect(s.complete()).toBe(true);
    // Zalo is Vietnam-only: its Singapore numbers are never checked and are reported skipped.
    const rows = buildReport(s.store, s.entries(), APPS, { now: s.clock.now(), maxAgeMs: MAX_AGE_MS });
    for (const row of rows) {
      expect(row.statuses.zalo).toBe(row.country === 'VN' ? truthOf('zalo', row.e164, 0) : 'skipped');
      for (const app of ['telegram', 'whatsapp', 'viber', 'line'] as const) expect(row.statuses[app]).toBe(truthOf(app, row.e164, 0));
    }
    expect(s.calls).toBeGreaterThan(1500);
  }, 120_000);

  it('is deterministic: the same seed gives the same calls and a byte-identical report', async () => {
    const first = await cleanRun(5, 2500);
    const second = sim({ seed: 5, total: 2500, kill: false, poisonPerApp: 0 });
    await second.converge(60);
    expect(second.report(true)).toBe(first.report(true));
    expect(second.callDigest()).toBe(first.callDigest());
    expect(second.calls).toBe(first.calls);
    const other = await cleanRun(6, 2500);
    expect(other.report(false)).toBe(first.report(false)); // chaos differs, truth does not
    expect(other.callDigest()).not.toBe(first.callDigest());
  }, 120_000);

  it.each([
    [11, 10_000],
    [2026, 3000],
  ])('seed %i (%i numbers): aborted at random points and resumed, it reaches the uninterrupted result', async (seed, total) => {
    const clean = await cleanRun(seed, total);
    const chaotic = sim({ seed, total, kill: true, poisonPerApp: 0, killEvery: 80 });
    await chaotic.converge(3000);
    chaotic.assertInvariants();
    expect(chaotic.complete()).toBe(true);
    expect(chaotic.abortedRuns, 'the scenario must really abort runs').toBeGreaterThan(10);
    // The INCOMPLETE oracle in runOnce must have been exercised both ways, not vacuously.
    expect(chaotic.incompleteRuns, 'runs that ended INCOMPLETE').toBeGreaterThan(10);
    expect(chaotic.runs - chaotic.incompleteRuns, 'runs that ended complete').toBeGreaterThan(0);
    expect(chaotic.report(false)).toBe(clean.report(false));
    expect(chaotic.definitiveCount()).toBe(clean.definitiveCount());
  }, 120_000);

  it('poison numbers: only the poison stays unanswered, nothing is lost, nothing wrong is stored', async () => {
    const s = sim({ seed: 77, total: 4000, kill: true, poisonPerApp: 8, killEvery: 60 });
    await s.converge(1500);
    s.assertInvariants();
    for (const app of APPS) {
      const stored = s.store.allResults(app);
      const unanswered = s.inScope(app).filter((n) => !definitive(stored.get(n.e164)?.status));
      const poison = s.poison.get(app) as Set<string>;
      // Exactly the poison numbers stay unanswered: neighbours that shared a batch with one are
      // retried alone in a later run, and the poison does not stop the numbers behind it.
      expect(unanswered.map((n) => n.e164).sort(), `${app} unanswered`).toEqual([...poison].sort());
    }
    // And they are reported as unknown (pending), never silently dropped from the report.
    const csv = s.report(false);
    expect(csv.trimEnd().split('\n')).toHaveLength(4001);
  }, 120_000);

  it('stale results are refreshed after max-age, and an unknown answer never overwrites a yes/not_found', async () => {
    const s = sim({ seed: 31, total: 2000, kill: false, poisonPerApp: 0 });
    await s.converge(60);
    const before = new Map<App, Map<string, StoredResult>>(APPS.map((app) => [app, s.store.allResults(app)]));
    const callsBefore = s.calls;

    // One day later everything is still fresh: a new run must not contact any platform.
    s.clock.advance(DAY);
    const idle = await s.runOnce(true);
    expect(idle.every((x) => x.needed === 0 && x.stopped === 'done')).toBe(true);
    expect(s.calls).toBe(callsBefore);

    // Past max-age every answer is stale. The platform now answers `unknown` for half the numbers and
    // flipped answers for the rest.
    s.clock.advance(125 * DAY);
    const refreshedAt = s.clock.now();
    const seen = new Map<string, number>();
    const flaky = (app: App): Adapter => ({
      app,
      login: async () => {},
      open: async () => ({
        check: async (batch) => {
          const out = new Map<string, CheckStatus>();
          for (const n of batch) {
            seen.set(`${app}|${n.e164}`, (seen.get(`${app}|${n.e164}`) ?? 0) + 1);
            out.set(n.e164, hash(`u|${app}|${n.e164}`) % 2 === 0 ? 'unknown' : truthOf(app, n.e164, 1));
          }
          return out;
        },
        close: async () => {},
      }),
    });
    s.abort = new AbortController();
    await s.clock.drive(
      runChecks({
        store: s.store,
        config: s.config,
        numbers: s.numbers,
        apps: [...APPS],
        maxAgeMs: MAX_AGE_MS,
        wait: true,
        signal: s.abort.signal,
        loadAdapter: async (app) => flaky(app),
        listAccounts: () => ['a', 'b'],
        accountDir: (app, name) => `/unused/${app}/${name}`,
        now: s.clock.now,
        sleep: s.sleep,
        random: () => 0,
      }),
    );
    for (const app of APPS) {
      const old = before.get(app) as Map<string, StoredResult>;
      const now = s.store.allResults(app);
      for (const n of s.inScope(app)) {
        const key = `${app}|${n.e164}`;
        expect(seen.get(key), `${key} must be checked exactly once`).toBe(1);
        const was = old.get(n.e164) as StoredResult;
        const is = now.get(n.e164) as StoredResult;
        if (hash(`u|${app}|${n.e164}`) % 2 === 0) {
          expect(is, `${key}: unknown must not overwrite ${was.status}`).toEqual(was);
        } else {
          expect(is.status).toBe(truthOf(app, n.e164, 1));
          expect(is.checkedAt).toBeGreaterThanOrEqual(refreshedAt);
        }
      }
    }
  });
});
