import { plural } from './plural.ts';
import { APP_SCOPE } from './adapters/index.ts';
import type { Config } from './config.ts';
import type { ProgressEvent } from './progress.ts';
import { localDay, nextLocalMidnight, type AccountState, type Store, type StoredResult } from './store.ts';
import {
  AccountBanned,
  RateLimited,
  redactPhones,
  type Adapter,
  type App,
  type CheckStatus,
  type PhoneNumber,
  type Session,
} from './types.ts';

/** setTimeout cannot wait longer than a signed 32-bit millisecond count. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** An account failing this many batches in a row (unexpected errors) is dropped for the rest of the run. */
export const MAX_CONSECUTIVE_ERRORS = 3;
/**
 * A batch that keeps failing with an unexpected error although this run already got answers is
 * parked for the rest of the run after this many failures (its numbers stay `unknown`), even when
 * it is the last work left. The parking failure does not put the account on cooldown.
 */
export const MAX_BATCH_FAILURES = 2;
/** A session whose close() does not return this fast is abandoned: it must not keep a finished run from writing its report. */
export const CLOSE_TIMEOUT_MS = 30_000;

export type StopReason =
  /** Nothing left to check for this app. */
  | 'done'
  /** Ctrl-C / abort signal. */
  | 'aborted'
  /** No account directory, or every account is disabled/dropped. */
  | 'no_accounts'
  /** Every usable account is cooling down or at its daily cap and waiting was not allowed. */
  | 'blocked'
  /** The adapter module could not be loaded. */
  | 'adapter_error';

export interface AppRunSummary {
  app: App;
  /** Numbers that needed a check when the run started. */
  needed: number;
  /** Distinct numbers whose lookup was actually sent to the platform in this run (failed lookups included). */
  attempted: number;
  /** Numbers for which an account returned an answer (yes, not_found or unknown) in this run. */
  answered: number;
  /** Numbers newly observed as yes or not_found in this run. */
  conclusive: number;
  /** `needed - conclusive`: numbers that leave this run without a fresh yes/not_found (unknown, failed, not reached, kept stale). */
  inconclusive: number;
  /** Part of `inconclusive`: numbers that still show an older yes/not_found from before this run. */
  retainedStale: number;
  /** Numbers still without any answer when the run stopped. */
  remaining: number;
  /** Batches that failed with an unexpected error (or whose session would not open). */
  errors: number;
  /** Batches given up on for the rest of the run, and the numbers in them. */
  parkedBatches: number;
  parked: number;
  /** Why the run ended blocked: accounts resting after a rate limit / error and/or at their daily cap. */
  blockedBy: ('cooldown' | 'daily_cap')[];
  /** Earliest time (epoch ms) an account is usable again, when the run ended blocked. */
  resumeAt: number | undefined;
  stopped: StopReason;
}

export interface SchedulerOptions {
  store: Store;
  config: Config;
  /** Unique valid numbers, in the order they should be checked. */
  numbers: PhoneNumber[];
  /** Apps to check. */
  apps: App[];
  /** yes/not_found results younger than this are reused. */
  maxAgeMs: number;
  /** Sleep through cooldowns and daily caps. When false, stop instead. Short pacing delays are always honoured. */
  wait: boolean;
  signal?: AbortSignal | undefined;
  /** Adapter factory — the test seam; production passes adapters/index.ts loadAdapter. */
  loadAdapter: (app: App) => Promise<Adapter>;
  /** Account names available for an app. */
  listAccounts: (app: App) => string[];
  accountDir: (app: App, name: string) => string;
  /** Overrides APP_SCOPE. */
  inScope?: (app: App, number: PhoneNumber) => boolean;
  now?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
  /** Called with each app's progress after every change (start, each batch, every wait); never affects the run. */
  onProgress?: (event: ProgressEvent) => void;
  /** Real milliseconds a session may take to close (default CLOSE_TIMEOUT_MS). */
  closeTimeoutMs?: number;
}

/**
 * Whether a stored result can be reused instead of checking again. The age must be non-negative: a
 * result stamped in the future (clock moved backwards) is never fresh, even with a max age of 0.
 */
export function isFresh(result: StoredResult | undefined, now: number, maxAgeMs: number): boolean {
  if (!result || result.status === 'unknown') return false;
  const age = now - result.checkedAt;
  return age >= 0 && age < maxAgeMs;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, Math.min(Math.max(ms, 0), MAX_TIMER_MS));
  function onAbort(): void {
    clearTimeout(timer);
    resolve();
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

interface Slot {
  session: Session | undefined;
  consecutiveErrors: number;
  dropped: boolean;
}

/** A batch that failed with an unexpected error, waiting behind the fresh numbers for a retry. */
interface RetryBatch {
  numbers: PhoneNumber[];
  failures: number;
  /** Error cooldowns this batch's failures put on accounts, so parking it can lift them again. */
  cooldowns: { account: string; set: number; previous: number }[];
}

function isCheckStatus(value: unknown): value is CheckStatus {
  return value === 'yes' || value === 'not_found' || value === 'unknown';
}

function describeError(error: unknown): string {
  return redactPhones(error instanceof Error ? error.message : String(error));
}

/** Start-of-day rollover: usage only counts within the local calendar day it was recorded. */
function refreshDay(state: AccountState, now: number): AccountState {
  const today = localDay(now);
  return state.day === today ? state : { ...state, day: today, usedToday: 0 };
}

/** Numbers that still need a check for one app: in scope and without a fresh yes/not_found. */
export function selectPending(
  options: Pick<SchedulerOptions, 'store' | 'numbers' | 'maxAgeMs' | 'inScope'>,
  app: App,
  now: number,
): PhoneNumber[] {
  const inScope = options.inScope ?? ((a: App, n: PhoneNumber) => APP_SCOPE[a](n));
  const stored = options.store.allResults(app);
  return options.numbers.filter((n) => inScope(app, n) && !isFresh(stored.get(n.e164), now, options.maxAgeMs));
}

/**
 * Check every needed number for the selected apps. Apps run concurrently (they never share
 * accounts); within an app, one batch runs at a time on the least-used account that is
 * allowed to work. Results and account state are committed after every batch, so killing the
 * process loses at most the batch in flight.
 */
export async function runChecks(options: SchedulerOptions): Promise<AppRunSummary[]> {
  const log = options.log ?? (() => {});
  // One app failing unexpectedly (e.g. database error) stops the others gracefully.
  const stop = new AbortController();
  if (options.signal?.aborted) stop.abort();
  options.signal?.addEventListener('abort', () => stop.abort(), { once: true });
  const shared = { ...options, signal: stop.signal };

  const settled = await Promise.allSettled(
    options.apps.map(async (app): Promise<AppRunSummary> => {
      try {
        return await runApp(shared, app);
      } catch (error) {
        log(`${app}: stopped by an unexpected error: ${describeError(error)}`);
        stop.abort();
        throw error;
      }
    }),
  );
  const summaries: AppRunSummary[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    summaries.push(result.value);
  }
  return summaries;
}

async function runApp(options: SchedulerOptions, app: App): Promise<AppRunSummary> {
  const { store, config, signal } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = (message: string) => (options.log ?? (() => {}))(`${app}: ${message}`);
  const pacing = config.apps[app];

  const needed = selectPending(options, app, now());
  // Numbers that already hold an older yes/not_found: if this run cannot refresh them, they keep it.
  const storedBefore = options.store.allResults(app);
  const staleBefore = new Set(
    needed.filter((n) => storedBefore.get(n.e164)?.status !== undefined && storedBefore.get(n.e164)?.status !== 'unknown').map((n) => n.e164),
  );
  const summary: AppRunSummary = {
    app,
    needed: needed.length,
    attempted: 0,
    answered: 0,
    conclusive: 0,
    inconclusive: needed.length,
    retainedStale: staleBefore.size,
    remaining: needed.length,
    errors: 0,
    parkedBatches: 0,
    parked: 0,
    blockedBy: [],
    resumeAt: undefined,
    stopped: 'done',
  };
  if (needed.length === 0) return summary;
  const attempted = new Set<string>();
  const refreshed = new Set<string>();

  const names = options.listAccounts(app);
  if (names.length === 0) {
    log(`no accounts, ${plural(needed.length, 'number')} left unchecked. Run: login ${app} --account <name>`);
    summary.stopped = 'no_accounts';
    return summary;
  }

  let adapter: Adapter;
  try {
    adapter = await options.loadAdapter(app);
  } catch (error) {
    log(describeError(error));
    summary.stopped = 'adapter_error';
    return summary;
  }

  const slots = new Map<string, Slot>(names.map((name) => [name, { session: undefined, consecutiveErrors: 0, dropped: false }]));
  log(`${plural(needed.length, 'number')} to check with ${plural(names.length, 'account')}`);

  // Batches that failed with an unexpected error wait here (behind all fresh numbers) for a retry.
  const retries: RetryBatch[] = [];
  // Numbers whose batch failed in an earlier run and were never answered since go last and alone:
  // a number the platform keeps rejecting would otherwise sit at the head of every run, fail the
  // first batches before anything succeeds, and get the account dropped before the rest is reached.
  // Checked one by one, the healthy neighbours of such a number are answered and only it stays
  // unknown; one more failure in a run that works parks it at once.
  const failedBefore = store.failedChecks(app);
  const pending = failedBefore.size === 0 ? needed : needed.filter((n) => !failedBefore.has(n.e164));
  if (failedBefore.size > 0) {
    // Least-failed first (stable, so input order within a count): numbers that only shared a batch
    // with a bad one are answered before the ones that keep failing.
    const suspects = needed
      .filter((n) => failedBefore.has(n.e164))
      .sort((a, b) => (failedBefore.get(a.e164) ?? 0) - (failedBefore.get(b.e164) ?? 0));
    for (const n of suspects) retries.push({ numbers: [n], failures: MAX_BATCH_FAILURES - 1, cooldowns: [] });
    log(`${plural(retries.length, 'number')} failed in an earlier run: checking them last, one by one`);
  }
  let successes = 0;
  let quarantined = 0;
  const queued = () => pending.length + retries.reduce((total, entry) => total + entry.numbers.length, 0);
  const progress = (waiting?: ProgressEvent['waiting']): void =>
    options.onProgress?.({ app, needed: summary.needed, remaining: queued() + quarantined, ...(waiting === undefined ? {} : { waiting }) });
  progress();

  const closeSession = async (name: string, slot: Slot) => {
    const session = slot.session;
    slot.session = undefined;
    if (!session) return;
    const limit = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`did not close within ${limit} ms; abandoned`)), limit);
        }),
      ]);
    } catch (error) {
      log(`${name}: error while closing session: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    while (queued() > 0) {
      if (signal?.aborted) {
        summary.stopped = 'aborted';
        break;
      }
      const t = now();

      // Classify accounts: ready now, waiting out the pacing interval, or blocked (cooldown / cap).
      const ready: { name: string; slot: Slot; state: AccountState; room: number }[] = [];
      let intervalWake = Infinity;
      let blockedWake = Infinity;
      let usable = 0;
      let capped = false;
      let cooling = false;
      for (const [name, slot] of slots) {
        if (slot.dropped) continue;
        const state = refreshDay(store.getAccount(app, name), t);
        if (state.disabledReason !== null) continue;
        usable += 1;
        const room = pacing.dailyCap - state.usedToday;
        if (room <= 0) {
          capped = true;
          blockedWake = Math.min(blockedWake, Math.max(state.cooldownUntil, nextLocalMidnight(t)));
        } else if (state.cooldownUntil > t) {
          cooling = true;
          blockedWake = Math.min(blockedWake, Math.max(state.cooldownUntil, state.nextAllowedAt));
        } else if (state.nextAllowedAt > t) {
          intervalWake = Math.min(intervalWake, state.nextAllowedAt);
        } else {
          ready.push({ name, slot, state, room });
        }
      }

      if (usable === 0) {
        log(`no usable account left (disabled or failing), ${plural(queued() + quarantined, 'number')} unchecked`);
        summary.stopped = 'no_accounts';
        summary.blockedBy = [];
        summary.resumeAt = undefined;
        break;
      }

      const chosen = ready.sort((a, b) => a.state.usedToday - b.state.usedToday || a.name.localeCompare(b.name))[0];
      if (chosen === undefined) {
        if (intervalWake !== Infinity) {
          progress({ until: intervalWake, kind: 'pacing' });
          await sleep(intervalWake - t, signal);
          progress();
          continue;
        }
        const blockedBy: AppRunSummary['blockedBy'] = [];
        if (cooling) blockedBy.push('cooldown');
        if (capped) blockedBy.push('daily_cap');
        summary.blockedBy = blockedBy;
        summary.resumeAt = blockedWake;
        if (!options.wait) {
          log(`all accounts are cooling down or at their daily cap, ${plural(queued(), 'number')} unchecked (--no-wait)`);
          summary.stopped = 'blocked';
          break;
        }
        log(`all accounts are resting; resuming at ${new Date(blockedWake).toISOString()} (${queued()} left)`);
        progress({ until: blockedWake, kind: 'cooldown' });
        await sleep(blockedWake - t, signal);
        progress();
        continue;
      }
      summary.blockedBy = [];
      summary.resumeAt = undefined;

      const { slot } = chosen;
      const retryBatch = pending.length === 0 ? retries[0] : undefined;
      const batch = (retryBatch?.numbers ?? pending).slice(0, Math.min(pacing.batchSize, chosen.room));
      const wanted = new Set(batch.map((n) => n.e164));
      let answers = new Map<string, CheckStatus>();
      let next = chosen.state;
      // `failed` rather than `failure !== undefined`: a rejected promise may carry no reason at all.
      let failed = false;
      let failure: unknown;
      const lifted: AccountState[] = [];
      let failedNumbers: string[] = [];

      let checking = false;
      try {
        slot.session ??= await adapter.open({
          app,
          account: chosen.name,
          accountDir: options.accountDir(app, chosen.name),
          pacing,
          options: config.apps[app].options,
          log: (message) => log(`${chosen.name}: ${redactPhones(message)}`),
        });
        checking = true;
        for (const n of batch) attempted.add(n.e164);
        answers = await slot.session.check(batch);
        if (!(answers instanceof Map)) throw new TypeError('the adapter returned no result map');
        slot.consecutiveErrors = 0;
        successes += 1;
      } catch (error) {
        failed = true;
        failure = error;
      }

      const finished = now();
      if (!failed) {
        // Numbers the adapter did not answer for are unknown; they are retried on the next run.
        const complete = new Map<string, CheckStatus>();
        for (const n of batch) {
          const value = answers.get(n.e164);
          complete.set(n.e164, isCheckStatus(value) ? value : 'unknown');
        }
        answers = complete;
        next = {
          ...chosen.state,
          usedToday: chosen.state.usedToday + batch.length,
          nextAllowedAt: finished + pacing.minIntervalMs + Math.floor(random() * pacing.jitterMs),
        };
      } else {
        const partial: Map<string, CheckStatus> =
          failure instanceof RateLimited || failure instanceof AccountBanned ? failure.partial : new Map();
        answers = new Map();
        for (const [e164, status] of partial) {
          if (wanted.has(e164) && isCheckStatus(status)) answers.set(e164, status);
        }
        next = { ...chosen.state, usedToday: chosen.state.usedToday + answers.size };
        if (failure instanceof RateLimited) {
          const wait =
            failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0
              ? failure.retryAfterMs
              : pacing.rateLimitCooldownMs;
          next.cooldownUntil = finished + wait;
          log(`${chosen.name}: rate limited, resting until ${new Date(next.cooldownUntil).toISOString()}`);
        } else if (failure instanceof AccountBanned) {
          next.disabledReason = describeError(failure);
          log(`WARNING ${chosen.name}: account disabled (${next.disabledReason}). Fix it, then: login ${app} --account ${chosen.name}`);
        } else {
          // Only a failed lookup says something about these numbers (not a session that would not open).
          if (checking) failedNumbers = batch.map((n) => n.e164);
          // The same batch failing repeatedly although this run already got answers points at the
          // batch (e.g. one number the platform rejects), not at the account: park it so later
          // numbers still run, even when it is the last work left. Without any success yet the
          // failure is indistinguishable from an outage, so the account-level handling applies.
          const entry = retryBatch ?? { numbers: [...batch], failures: 0, cooldowns: [] };
          entry.failures += 1;
          const park = entry.failures >= MAX_BATCH_FAILURES && successes > 0;
          // A parked batch is blamed on its numbers, so it does not count against the account either:
          // a few bad numbers in a row must not get an account that works dropped.
          if (!park) slot.consecutiveErrors += 1;
          summary.errors += 1;
          log(`${chosen.name}: error (${slot.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${describeError(failure)}`);
          if (retryBatch === undefined) {
            pending.splice(0, batch.length);
            retries.push(entry);
          } else {
            retries.push(retries.shift() as RetryBatch);
          }
          if (park) {
            retries.splice(retries.indexOf(entry), 1);
            quarantined += entry.numbers.length;
            summary.parkedBatches += 1;
            // The cooldowns this batch's earlier failures caused blamed the accounts for it: lift them.
            for (const cooled of entry.cooldowns) {
              if (cooled.account === chosen.name) {
                if (next.cooldownUntil === cooled.set) next.cooldownUntil = cooled.previous;
              } else {
                const state = store.getAccount(app, cooled.account);
                if (state.cooldownUntil === cooled.set) lifted.push({ ...state, cooldownUntil: cooled.previous });
              }
            }
            log(
              `${plural(entry.numbers.length, 'number')} failed ${entry.failures} times in a run that otherwise works; ` +
                'leaving them unknown for this run (no account is put on cooldown for it)',
            );
          } else {
            entry.cooldowns.push({ account: chosen.name, set: finished + pacing.errorCooldownMs, previous: next.cooldownUntil });
            next.cooldownUntil = finished + pacing.errorCooldownMs;
          }
          if (slot.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            slot.dropped = true;
            log(`${chosen.name}: dropped for the rest of this run after repeated errors`);
          }
        }
        await closeSession(chosen.name, slot);
      }

      store.transaction(() => {
        if (failedNumbers.length > 0) store.recordFailedChecks(app, failedNumbers, finished);
        store.saveResults(app, answers, finished);
        store.saveAccount(next);
        for (const state of lifted) store.saveAccount(state);
      });
      // Answered numbers leave whichever queue they came from.
      const settle = (list: PhoneNumber[]) => {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (answers.has((list[i] as PhoneNumber).e164)) list.splice(i, 1);
        }
      };
      settle(pending);
      if (retryBatch !== undefined) {
        settle(retryBatch.numbers);
        const index = retries.indexOf(retryBatch);
        if (retryBatch.numbers.length === 0 && index >= 0) retries.splice(index, 1);
      }
      summary.answered += answers.size;
      for (const [e164, status] of answers) if (status !== 'unknown') refreshed.add(e164);
      if (answers.size > 0) log(`${chosen.name}: ${answers.size} checked, ${queued()} left`);
      progress();
    }
  } finally {
    for (const [name, slot] of slots) await closeSession(name, slot);
  }

  summary.remaining = queued() + quarantined;
  summary.attempted = attempted.size;
  summary.conclusive = refreshed.size;
  summary.inconclusive = summary.needed - refreshed.size;
  summary.retainedStale = [...staleBefore].filter((e164) => !refreshed.has(e164)).length;
  summary.parked = quarantined;
  return summary;
}

const STOP_LABELS: Record<StopReason, string> = {
  done: 'finished',
  aborted: 'interrupted',
  no_accounts: 'no usable account',
  blocked: 'blocked',
  adapter_error: 'adapter could not load',
};

export interface RunDescription {
  /** One line per app: attempted / conclusive / inconclusive counts. Never says `done` for inconclusive work. */
  lines: string[];
  /** True iff some number leaves the run without a fresh yes/not_found (sum of `inconclusive` > 0). */
  incomplete: boolean;
  /** Conspicuous multi-line banner; empty when the run is complete. */
  banner: string[];
  /** Earliest time (epoch ms) some blocked app can continue, when known. */
  resumeAt: number | undefined;
}

/** Why one app's run left work inconclusive (empty when it did not). */
function incompleteReasons(s: AppRunSummary): string[] {
  if (s.inconclusive === 0) return [];
  const reasons: string[] = [];
  if (s.stopped === 'no_accounts') reasons.push(`no_accounts: no usable ${s.app} account (log in, or fix a disabled one: login ${s.app} --account <name>)`);
  if (s.stopped === 'adapter_error') reasons.push(`adapter_error: the ${s.app} adapter could not be loaded`);
  if (s.stopped === 'aborted') reasons.push('aborted: the run was interrupted');
  if (s.blockedBy.includes('cooldown')) reasons.push('cooldown: every account is resting after a rate limit or an error');
  if (s.blockedBy.includes('daily_cap')) reasons.push('daily cap: every usable account reached its daily limit');
  if (s.errors > 0) reasons.push(`errors: ${plural(s.errors, 'batch', 'batches')} failed`);
  if (s.parkedBatches > 0) reasons.push(`parked batches: ${plural(s.parkedBatches, 'batch', 'batches')}, ${plural(s.parked, 'number')}, given up for this run`);
  const unknown = s.answered - s.conclusive;
  if (unknown > 0) reasons.push(`unknown answers: ${plural(unknown, 'number')} came back unknown`);
  if (reasons.length === 0) reasons.push('not_reached: some numbers were not checked');
  return reasons;
}

/** Per-app counts and, when anything stays inconclusive, an INCOMPLETE banner with the reasons and the next resume time. */
export function describeRun(summaries: readonly AppRunSummary[]): RunDescription {
  const lines: string[] = [];
  const banner: string[] = [];
  let inconclusive = 0;
  let needed = 0;
  let resumeAt: number | undefined;
  for (const s of summaries) {
    inconclusive += s.inconclusive;
    needed += s.needed;
    const complete = s.inconclusive === 0;
    const label = s.stopped === 'done' ? (complete ? 'all conclusive' : 'finished, NOT conclusive') : STOP_LABELS[s.stopped];
    const kept = s.retainedStale > 0 ? `, ${s.retainedStale} keep an older result` : '';
    lines.push(
      `${s.app}: needed ${s.needed}, attempted ${s.attempted}, conclusive ${s.conclusive}, ` +
        `inconclusive ${s.inconclusive}${kept}, no answer ${s.remaining} (${label})`,
    );
    if (!complete && s.resumeAt !== undefined && Number.isFinite(s.resumeAt)) {
      resumeAt = resumeAt === undefined ? s.resumeAt : Math.min(resumeAt, s.resumeAt);
    }
  }
  const incomplete = inconclusive > 0;
  if (incomplete) {
    const bar = '='.repeat(72);
    banner.push(
      bar,
      `INCOMPLETE: ${inconclusive} of ${plural(needed, 'check')} ${inconclusive === 1 ? 'has' : 'have'} no fresh yes/not_found answer.`,
      'The report is NOT final: cells marked unknown are unchecked, and an older yes/not_found may be outdated.',
    );
    for (const s of summaries) {
      const reasons = incompleteReasons(s);
      if (reasons.length === 0) continue;
      banner.push(`  ${s.app}: ${s.inconclusive} inconclusive (${s.attempted} attempted, ${s.conclusive} conclusive)`);
      for (const reason of reasons) banner.push(`    - ${reason}`);
    }
    banner.push(
      resumeAt === undefined
        ? 'Run the same command again to continue (finished numbers are not repeated).'
        : `Next resume: ${new Date(resumeAt).toISOString()}. Run the same command again then (finished numbers are not repeated).`,
      bar,
    );
  }
  return { lines, incomplete, banner, resumeAt };
}
