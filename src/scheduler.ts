import { plural } from './plural.ts';
import { APP_SCOPE } from './adapters/index.ts';
import type { Config } from './config.ts';
import type { AccountProgress, ProgressEvent } from './progress.ts';
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
  /** Every stored result of the app, updated as batches commit: the report reads this once. */
  results: Map<string, StoredResult>;
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
  /** Last account state as committed (or reserved for an in-flight batch); the dispatcher keeps it current. */
  state: AccountState | undefined;
  /** Numbers of in-flight batches already reserved against the daily cap. */
  reserved: number;
  /** Wall time of the last batch that finished this run. */
  lastBatchMs: number | undefined;
  /** Numbers this account answered in this run, per status (for the per-account progress rows). */
  counts: Record<CheckStatus, number>;
}

/** A batch sent to an account's session, awaiting its outcome in `completions`. */
interface InFlight {
  slot: Slot;
  name: string;
  /** Numbers actually sent to the adapter. */
  batch: PhoneNumber[];
  /** The retry-queue entry this batch belongs to (its numbers may exceed `batch`: the tail was not sent yet). */
  retry: RetryBatch | undefined;
  /** When the dispatcher handed the batch out (the day its daily usage is charged to). */
  dispatchedAt: number;
  /** True once Session.check was actually invoked (a session that would not open measures no latency). */
  checked: boolean;
  /** When Session.check was called: batch latency is measured from here, not from session opening. */
  checkStartedAt: number | undefined;
  finishedAt: number;
  failed: boolean;
  failure: unknown;
  answers: Map<string, CheckStatus>;
  /** Set when the grace window ran out: a late return is ignored, the numbers were already charged. */
  abandoned: boolean;
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
  options: Pick<SchedulerOptions, 'store' | 'numbers' | 'maxAgeMs' | 'inScope'> & { stored?: Map<string, StoredResult> },
  app: App,
  now: number,
): PhoneNumber[] {
  const inScope = options.inScope ?? ((a: App, n: PhoneNumber) => APP_SCOPE[a](n));
  const stored = options.stored ?? options.store.allResults(app);
  return options.numbers.filter((n) => inScope(app, n) && !isFresh(stored.get(n.e164), now, options.maxAgeMs));
}

/**
 * Check every needed number for the selected apps. Apps run concurrently (they never share
 * accounts); within an app a dispatcher hands batches to accounts that are ready now, at most one
 * batch in flight per account and at most `maxParallelAccounts` in flight per app (default 1, the
 * historical serial behaviour). Daily caps are reserved at dispatch and settled at commit, so
 * parallel accounts cannot overshoot a cap.
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

  // The app's results table is read once and shared by the pending selection and the stale-result
  // bookkeeping below; the same scan used to run three times per app per run.
  const storedBefore = options.store.allResults(app);
  const needed = selectPending({ ...options, stored: storedBefore }, app, now());
  // Numbers that already hold an older yes/not_found: if this run cannot refresh them, they keep it.
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
    results: storedBefore,
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

  const slots = new Map<string, Slot>(
    names.map((name) => [
      name,
      {
        session: undefined,
        consecutiveErrors: 0,
        dropped: false,
        state: undefined,
        reserved: 0,
        lastBatchMs: undefined,
        counts: { yes: 0, not_found: 0, unknown: 0 },
      },
    ]),
  );
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
  /** Batches handed to a session and not yet committed: their numbers are off the queues but still unanswered. */
  const jobs = new Set<InFlight>();
  /** Batches whose session call returned (or failed), waiting to be committed by the dispatcher. */
  const completions: InFlight[] = [];
  const queued = () => {
    let total = pending.length;
    for (const entry of retries) total += entry.numbers.length;
    for (const job of jobs) total += job.retry === undefined ? job.batch.length : job.retry.numbers.length;
    return total;
  };
  const accountRows = (): AccountProgress[] => {
    const t = now();
    const idle = queued() === 0;
    const rows: AccountProgress[] = [];
    for (const [name, slot] of slots) {
      const state = slot.state;
      const row: AccountProgress = {
        account: name,
        state: 'waiting',
        counts: { ...slot.counts },
        done: slot.counts.yes + slot.counts.not_found + slot.counts.unknown,
      };
      if (slot.lastBatchMs !== undefined) row.lastBatchMs = slot.lastBatchMs;
      if (slot.dropped || (state !== undefined && state.disabledReason !== null)) {
        row.state = 'disabled';
      } else if (slot.reserved > 0) {
        row.state = 'working';
      } else if (idle) {
        row.state = 'done';
      } else if (state !== undefined) {
        const used = state.day === localDay(t) ? state.usedToday : 0;
        if (used >= pacing.dailyCap) {
          row.state = 'cooldown';
          row.waitingUntil = Math.max(state.cooldownUntil, nextLocalMidnight(t));
        } else if (state.cooldownUntil > t) {
          row.state = 'cooldown';
          row.waitingUntil = state.cooldownUntil;
        } else if (state.nextAllowedAt > t) {
          row.waitingUntil = state.nextAllowedAt;
        }
      }
      rows.push(row);
    }
    return rows;
  };
  const progress = (waiting?: ProgressEvent['waiting']): void => {
    if (options.onProgress === undefined) return;
    options.onProgress({
      app,
      needed: summary.needed,
      remaining: queued() + quarantined,
      ...(waiting === undefined ? {} : { waiting }),
      accounts: accountRows(),
    });
  };
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

  // Dispatcher: at most one batch in flight per account and `maxParallel` per app. A worker only
  // fills its own job and pushes it to `completions`; this coroutine alone changes the queues, the
  // account state and the store, so every queue change happens synchronously between awaits and
  // one Store connection with one transaction per completed batch is enough.
  const requested = pacing.maxParallelAccounts;
  // One Android device serves every Viber account, so Viber never runs two batches at once.
  const maxParallel = app === 'viber' || !(requested >= 1) ? 1 : Math.floor(requested);
  let onArrival: (() => void) | undefined;

  /** Resolves when a batch returned, the run was aborted, or `ms` passed (when given). */
  const wait = async (ms?: number): Promise<void> => {
    if (completions.length > 0 || signal?.aborted) return;
    const woken = Promise.withResolvers<void>();
    const timer = new AbortController();
    const onAbort = () => woken.resolve();
    onArrival = woken.resolve;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await (ms === undefined ? woken.promise : Promise.race([woken.promise, sleep(ms, timer.signal)]));
    } finally {
      onArrival = undefined;
      signal?.removeEventListener('abort', onAbort);
      timer.abort();
    }
  };

  /** Drop answered numbers from a (small) retry list in place. */
  const settle = (list: PhoneNumber[], answers: ReadonlyMap<string, CheckStatus>): void => {
    const left = list.filter((n) => !answers.has(n.e164));
    list.length = 0;
    list.push(...left);
  };

  const runJob = async (job: InFlight): Promise<void> => {
    const { slot, name, batch } = job;
    try {
      slot.session ??= await adapter.open({
        app,
        account: name,
        accountDir: options.accountDir(app, name),
        pacing,
        options: config.apps[app].options,
        log: (message) => log(`${name}: ${redactPhones(message)}`),
      });
      job.checked = true;
      for (const n of batch) attempted.add(n.e164);
      job.checkStartedAt = now();
      const result = await slot.session.check(batch);
      if (!(result instanceof Map)) throw new TypeError('the adapter returned no result map');
      job.answers = result;
    } catch (error) {
      // `failed` rather than `failure !== undefined`: a rejected promise may carry no reason at all.
      job.failed = true;
      job.failure = error;
    }
    if (job.abandoned) return;
    job.finishedAt = now();
    completions.push(job);
    onArrival?.();
  };

  /** Take the next batch off the queues, reserve it against the account's daily cap and start it. */
  const dispatch = (name: string, slot: Slot, room: number, t: number): void => {
    const retry = pending.length === 0 ? retries.shift() : undefined;
    const size = Math.min(pacing.batchSize, room);
    const batch = retry === undefined ? pending.splice(0, size) : retry.numbers.slice(0, size);
    const job: InFlight = {
      slot,
      name,
      batch,
      retry,
      dispatchedAt: t,
      checked: false,
      checkStartedAt: undefined,
      finishedAt: t,
      failed: false,
      failure: undefined,
      answers: new Map(),
      abandoned: false,
    };
    slot.reserved += batch.length;
    jobs.add(job);
    void runJob(job);
  };

  /** Commit one finished batch: settle the reservation to the charge rules, store, requeue what was not answered. */
  const complete = async (job: InFlight): Promise<void> => {
    const { slot, name, batch, retry } = job;
    jobs.delete(job);
    slot.reserved -= batch.length;
    const finished = job.finishedAt;
    const wanted = new Set(batch.map((n) => n.e164));
    let answers = job.answers;
    // Re-read: another completion may have lifted this account's cooldown while the batch ran.
    const base = refreshDay(store.getAccount(app, name), job.dispatchedAt);
    let next: AccountState = base;
    const lifted: AccountState[] = [];
    let failedNumbers: string[] = [];
    // The failure branch already put the batch back into the retry queue (or parked it).
    let handedToRetries = false;
    let unexpected = false;

    if (!job.failed) {
      slot.consecutiveErrors = 0;
      successes += 1;
      // Numbers the adapter did not answer for are unknown; they are retried on the next run.
      const filled = new Map<string, CheckStatus>();
      for (const n of batch) {
        const value = answers.get(n.e164);
        filled.set(n.e164, isCheckStatus(value) ? value : 'unknown');
      }
      answers = filled;
      const took = finished - (job.checkStartedAt ?? finished);
      slot.lastBatchMs = took;
      next = {
        ...base,
        usedToday: base.usedToday + batch.length,
        nextAllowedAt: finished + pacing.minIntervalMs + Math.floor(random() * pacing.jitterMs),
        lastBatchMs: took,
        avgBatchMs: ((base.avgBatchMs ?? 0) * base.batchesDone + took) / (base.batchesDone + 1),
        batchesDone: base.batchesDone + 1,
      };
    } else {
      const failure = job.failure;
      const partial: Map<string, CheckStatus> =
        failure instanceof RateLimited || failure instanceof AccountBanned ? failure.partial : new Map();
      answers = new Map();
      for (const [e164, status] of partial) {
        if (wanted.has(e164) && isCheckStatus(status)) answers.set(e164, status);
      }
      next = { ...base, usedToday: base.usedToday + answers.size };
      if (failure instanceof RateLimited) {
        const rest =
          failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0
            ? failure.retryAfterMs
            : pacing.rateLimitCooldownMs;
        next.cooldownUntil = finished + rest;
        log(`${name}: rate limited, resting until ${new Date(next.cooldownUntil).toISOString()}`);
      } else if (failure instanceof AccountBanned) {
        next.disabledReason = describeError(failure);
        log(`WARNING ${name}: account disabled (${next.disabledReason}). Fix it, then: login ${app} --account ${name}`);
      } else {
        unexpected = true;
        // Only a failed lookup says something about these numbers (not a session that would not open).
        if (job.checked) failedNumbers = batch.map((n) => n.e164);
        // The same batch failing repeatedly although this run already got answers points at the
        // batch (e.g. one number the platform rejects), not at the account: park it so later
        // numbers still run, even when it is the last work left. Without any success yet the
        // failure is indistinguishable from an outage, so the account-level handling applies.
        const entry: RetryBatch = retry ?? { numbers: [...batch], failures: 0, cooldowns: [] };
        entry.failures += 1;
        const park = entry.failures >= MAX_BATCH_FAILURES && successes > 0;
        // A parked batch is blamed on its numbers, so it does not count against the account either:
        // a few bad numbers in a row must not get an account that works dropped.
        if (!park) slot.consecutiveErrors += 1;
        summary.errors += 1;
        log(`${name}: error (${slot.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${describeError(failure)}`);
        retries.push(entry);
        handedToRetries = true;
        if (park) {
          retries.splice(retries.indexOf(entry), 1);
          quarantined += entry.numbers.length;
          summary.parkedBatches += 1;
          // The cooldowns this batch's earlier failures caused blamed the accounts for it: lift them.
          for (const cooled of entry.cooldowns) {
            if (cooled.account === name) {
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
          entry.cooldowns.push({ account: name, set: finished + pacing.errorCooldownMs, previous: next.cooldownUntil });
          next.cooldownUntil = finished + pacing.errorCooldownMs;
        }
        if (slot.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          slot.dropped = true;
          log(`${name}: dropped for the rest of this run after repeated errors`);
        }
      }
      await closeSession(name, slot);
    }

    store.transaction(() => {
      if (failedNumbers.length > 0) store.recordFailedChecks(app, failedNumbers, finished);
      store.saveResults(app, answers, finished);
      store.saveAccount(next);
      for (const state of lifted) store.saveAccount(state);
    });
    slot.state = next;
    // Mirror the store's upsert rule (an unknown never replaces a yes/not_found) so the report can reuse this map.
    for (const [e164, status] of answers) {
      const current = summary.results.get(e164);
      if (current === undefined || status !== 'unknown' || current.status === 'unknown') {
        summary.results.set(e164, { status, checkedAt: finished });
      }
    }
    // What was not answered goes back to the queue it came from, in front, so the next batch repeats it.
    if (retry !== undefined) {
      settle(retry.numbers, answers);
      if (!handedToRetries && retry.numbers.length > 0) retries.unshift(retry);
    } else if (!unexpected && answers.size < batch.length) {
      pending.unshift(...batch.filter((n) => !answers.has(n.e164)));
    }
    summary.answered += answers.size;
    for (const [e164, status] of answers) {
      if (status !== 'unknown') refreshed.add(e164);
      slot.counts[status] += 1;
    }
    if (answers.size > 0) log(`${name}: ${answers.size} checked, ${queued()} left`);
    progress();
  };

  /** A batch that did not return inside the grace window: its numbers stay unknown, and the account is charged for them. */
  const abandon = (job: InFlight): void => {
    job.abandoned = true;
    jobs.delete(job);
    const { slot, name, batch, retry } = job;
    slot.reserved -= batch.length;
    // The platform may already have counted the numbers, so charge them in full.
    const base = refreshDay(store.getAccount(app, name), job.dispatchedAt);
    const next: AccountState = { ...base, usedToday: base.usedToday + batch.length };
    store.transaction(() => store.saveAccount(next));
    slot.state = next;
    if (retry !== undefined) retries.unshift(retry);
    else pending.unshift(...batch);
    log(`${name}: a batch of ${plural(batch.length, 'number')} did not return in time; its numbers stay unknown and count against today's cap`);
  };

  /**
   * After an interrupt: let batches in flight return and commit. With one batch at a time (K = 1) the
   * old contract holds: wait for it however long it takes (a second Ctrl-C force-quits). With K > 1
   * the close window bounds the wait and batches still out after it are abandoned and charged.
   */
  const drain = async (): Promise<void> => {
    if (jobs.size === 0) return;
    let expired = false;
    // Real time on purpose (like the close window): the batch is a real request even when pacing is simulated.
    const timer =
      maxParallel === 1
        ? undefined
        : setTimeout(() => {
            expired = true;
            onArrival?.();
          }, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    try {
      while (jobs.size > 0 && !expired) {
        if (completions.length === 0) {
          const woken = Promise.withResolvers<void>();
          onArrival = woken.resolve;
          await woken.promise;
          onArrival = undefined;
        }
        while (completions.length > 0) await complete(completions.shift() as InFlight);
      }
    } finally {
      clearTimeout(timer);
    }
    for (const job of [...jobs]) abandon(job);
  };

  try {
    for (;;) {
      while (completions.length > 0) await complete(completions.shift() as InFlight);
      if (queued() === 0) break;
      if (signal?.aborted) {
        summary.stopped = 'aborted';
        await drain();
        break;
      }
      // Nothing to hand out right now: every worker slot is busy, or what is left is in flight.
      if (jobs.size >= maxParallel || (pending.length === 0 && retries.length === 0)) {
        await wait();
        continue;
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
        slot.state = state;
        if (state.disabledReason !== null) continue;
        usable += 1;
        // One batch at a time per account: pacing starts when its batch returns.
        if (slot.reserved > 0) continue;
        const room = pacing.dailyCap - state.usedToday - slot.reserved;
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

      if (ready.length === 0) {
        if (jobs.size > 0) {
          // Others are still working: wake for the next account that becomes ready, or for a returning batch.
          const wake = Math.min(intervalWake, options.wait ? blockedWake : Infinity);
          await wait(Number.isFinite(wake) ? wake - t : undefined);
          continue;
        }
        if (intervalWake !== Infinity) {
          progress({ until: intervalWake, kind: 'pacing' });
          await wait(intervalWake - t);
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
        await wait(blockedWake - t);
        progress();
        continue;
      }
      summary.blockedBy = [];
      summary.resumeAt = undefined;

      // Least-used account first; hand out batches until the app's worker limit or the queue is exhausted.
      ready.sort((a, b) => a.state.usedToday - b.state.usedToday || a.name.localeCompare(b.name));
      for (const candidate of ready) {
        if (jobs.size >= maxParallel || (pending.length === 0 && retries.length === 0)) break;
        dispatch(candidate.name, candidate.slot, candidate.room, t);
      }
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
