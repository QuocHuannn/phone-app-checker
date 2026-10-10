// One benchmark stage in a fresh process, run by bench/run.ts. Every stage prints exactly one
// JSON line on stdout; the driver measures wall time and peak RSS around the process.
//   node bench/lib/stage.ts --repo <path> --work <dir> --stage <name> --rows N [options]
// Stages: gen | parse | normalize | commits | check | report | sim
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { generateCsv } from './synthetic-csv.ts';
import { makeLoadAdapter, truthOf, type FakeCounters } from './fake-adapter.ts';
import { VirtualClock } from './virtual-clock.ts';
import type { CliDeps, createProgram } from '../../src/cli.ts';
import type { Store, StoredResult } from '../../src/store.ts';
import type { App, CheckStatus } from '../../src/types.ts';

type CliModule = { createProgram: typeof createProgram };
type StoreCtor = { prototype: Store; open(dataDir: string): Store };
type ConfigModule = { DEFAULT_APPS: Record<App, { minIntervalMs: number; jitterMs: number }> };

// A fixed UTC instant so report timestamps (and the golden sha256) do not depend on the host zone.
const START = Date.UTC(2026, 9, 10, 9, 0, 0);

interface Args {
  repo: string;
  stage: string;
  rows: number;
  seed: number;
  apps: string[];
  accounts: number;
  latencyMs: number;
  batch: number;
  work: string;
  defaultPacing: boolean;
  /** `maxParallelAccounts` written into the sim config (1 keeps the historical serial loop). */
  parallel: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { rows: 20_000, seed: 1, accounts: 2, latencyMs: 0, batch: 10, defaultPacing: false, parallel: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--repo': args.repo = value as string; i += 1; break;
      case '--work': args.work = value as string; i += 1; break;
      case '--stage': args.stage = value as string; i += 1; break;
      case '--rows': args.rows = Number(value); i += 1; break;
      case '--seed': args.seed = Number(value); i += 1; break;
      case '--apps': args.apps = (value as string).split(','); i += 1; break;
      case '--accounts': args.accounts = Number(value); i += 1; break;
      case '--latency-ms': args.latencyMs = Number(value); i += 1; break;
      case '--batch': args.batch = Number(value); i += 1; break;
      case '--default-pacing': args.defaultPacing = true; break;
      case '--parallel': args.parallel = Number(value); i += 1; break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!args.repo || !args.stage || !args.work) throw new Error('need --repo, --stage and --work');
  args.repo = resolve(args.repo);
  args.apps ??= ['telegram', 'whatsapp', 'zalo', 'viber', 'line'];
  return args as Args;
}

/** Refuse to write state anywhere inside a checkout: real sessions live in <repo>/data. */
function assertOutsideRepo(path: string, repo: string): void {
  const root = realpathSync(repo);
  const resolved = resolve(path);
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
  if (real === root || real.startsWith(root + sep)) {
    throw new Error(`refusing to run a benchmark stage with state inside the repo: ${path}`);
  }
}

const out = (value: unknown) => console.log(JSON.stringify(value));
const ms = (t0: number) => Number((performance.now() - t0).toFixed(1));

// The target repo's modules are loaded by absolute URL so `--repo` can point at another checkout
// (e.g. the base commit in a git worktree) while this stage file stays in the current tree.
const imp = <T>(repo: string, rel: string) => import(pathToFileURL(join(repo, rel)).href) as Promise<T>;

/** Counts store transactions and time spent inside them (top-level calls only). */
function instrumentStore(Store: StoreCtor) {
  const stats = { transactions: 0, transactionMs: 0, allResultsCalls: 0, allResultsRows: 0 };
  const proto = Store.prototype;
  const origAll = proto.allResults;
  proto.allResults = function allResults(this: Store, app: App): Map<string, StoredResult> {
    const map = origAll.call(this, app);
    stats.allResultsCalls += 1;
    stats.allResultsRows += map.size;
    return map;
  };
  const original = proto.transaction;
  let depth = 0;
  proto.transaction = function transaction<T>(this: Store, fn: () => T): T {
    if (depth > 0) return original.call(this, fn) as T;
    depth += 1;
    stats.transactions += 1;
    const t0 = performance.now();
    try {
      return original.call(this, fn) as T;
    } finally {
      stats.transactionMs += performance.now() - t0;
      depth -= 1;
    }
  };
  return stats;
}

async function runCli(
  createProgramFn: CliModule['createProgram'],
  argv: string[],
  clock: VirtualClock,
  deps: CliDeps,
  workDir: string,
) {
  const logs: string[] = [];
  const prints: string[] = [];
  let checkedLines = 0;
  const program = createProgramFn({
    ...deps,
    log: (message: string) => {
      if (message.includes(' checked, ')) checkedLines += 1;
      else logs.push(message);
    },
    print: (text: string) => prints.push(text),
    exit: () => {},
    env: {},
    lifecycleDir: join(workDir, 'lifecycle'),
    listDevices: async () => [],
    quietFirstRun: true,
  });
  let error: string | undefined;
  const t0 = performance.now();
  try {
    await clock.drive(program.parseAsync(argv, { from: 'node' }));
  } catch (caught) {
    error = String((caught as Error)?.message ?? caught);
  }
  return { ms: ms(t0), error, checkedLines, logTail: logs.slice(-6), printed: prints.join('\n').slice(0, 600) };
}

function writeConfig(dir: string, dataDir: string, apps: string[], defaultPacing: boolean, parallel: number): string {
  const perApp: Record<string, Record<string, number>> = {};
  // --default-pacing keeps the shipped pacing and only lifts the daily cap so a run can finish.
  // The key is written only above 1, so K=1 runs use a config byte-identical to the phase-1 golden run.
  for (const app of apps) {
    perApp[app] = defaultPacing ? { dailyCap: 1_000_000_000 } : { minIntervalMs: 0, jitterMs: 0, dailyCap: 1_000_000_000 };
    if (parallel > 1 && app !== 'viber') perApp[app].maxParallelAccounts = parallel;
  }
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ dataDir, apps: perApp }));
  return cfgPath;
}

function prepareAccounts(dataDir: string, apps: string[], accounts: number): void {
  for (const app of apps) for (let i = 0; i < accounts; i += 1) mkdirSync(join(dataDir, 'sessions', app, `acc${i}`), { recursive: true, mode: 0o700 });
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(args.work, `s${args.seed}-r${args.rows}`);
  // Refuse before anything is created: a state path inside a checkout would sit next to real data.
  assertOutsideRepo(dir, args.repo);
  mkdirSync(dir, { recursive: true });
  const csv = join(dir, 'input.csv');

  const { readPhoneCsv } = (await imp(args.repo, 'src/csv.ts')) as typeof import('../../src/csv.ts');
  const { normalizePhone } = (await imp(args.repo, 'src/phone.ts')) as typeof import('../../src/phone.ts');
  const { Store } = (await imp(args.repo, 'src/store.ts')) as typeof import('../../src/store.ts');

  if (args.stage === 'gen' || (args.stage !== 'report' && !existsSync(csv))) {
    const t0 = performance.now();
    const text = generateCsv(args.rows, args.seed);
    writeFileSync(csv, text);
    if (args.stage === 'gen') {
      out({ stage: 'gen', rows: args.rows, seed: args.seed, bytes: statSync(csv).size, genMs: ms(t0) });
      return;
    }
  }

  if (args.stage === 'parse') {
    const t0 = performance.now();
    const input = readPhoneCsv(csv, { defaultRegion: 'VN' });
    const parseMs = ms(t0);
    const valid = input.entries.filter((e) => e.phone !== null).length;
    out({ stage: 'parse', rows: input.rows, uniqueEntries: input.entries.length, duplicates: input.duplicates, valid, invalid: input.entries.length - valid, parseMs, bytes: statSync(csv).size, column: input.column });
    return;
  }

  if (args.stage === 'normalize') {
    const cells = readFileSync(csv, 'utf8').split('\n').slice(1).filter(Boolean).map((line) => line.split(',')[1] ?? '');
    const t0 = performance.now();
    let hits = 0;
    for (const cell of cells) if (normalizePhone(cell, 'VN') !== null) hits += 1;
    const total = ms(t0);
    out({ stage: 'normalize', cells: cells.length, normalizeMs: total, usPerCell: Number(((total * 1000) / cells.length).toFixed(2)), valid: hits });
    return;
  }

  if (args.stage === 'commits') {
    const input = readPhoneCsv(csv, { defaultRegion: 'VN' });
    const numbers = input.entries.flatMap((e) => (e.phone ? [e.phone] : []));
    const dataDir = join(dir, `commits-b${args.batch}`);
    rmSync(dataDir, { recursive: true, force: true });
    assertOutsideRepo(dataDir, args.repo);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const store = Store.open(dataDir);
    const pragma = store.db.prepare('PRAGMA synchronous').get();
    const journal = store.db.prepare('PRAGMA journal_mode').get();
    const t0 = performance.now();
    let commits = 0;
    const app: App = 'telegram';
    const state = { app, name: 'acc0', cooldownUntil: 0, disabledReason: null, day: '2026-10-10', usedToday: 0, nextAllowedAt: 0, lastBatchMs: null, avgBatchMs: null, batchesDone: 0 };
    for (let i = 0; i < numbers.length; i += args.batch) {
      const slice = numbers.slice(i, i + args.batch);
      const answers = new Map<string, CheckStatus>(slice.map((n) => [n.e164, truthOf(app, n.e164)]));
      state.usedToday += slice.length;
      state.nextAllowedAt = i;
      store.transaction(() => {
        store.saveResults(app, answers, START + i);
        store.saveAccount(state);
      });
      commits += 1;
    }
    const total = ms(t0);
    store.close();
    out({ stage: 'commits', numbers: numbers.length, batchSize: args.batch, commits, commitStageMs: total, msPerCommit: Number((total / commits).toFixed(3)), synchronous: Object.values(pragma as object)[0], journal: Object.values(journal as object)[0] });
    return;
  }

  if (args.stage === 'check' || args.stage === 'report' || args.stage === 'sim') {
    const { createProgram } = (await imp(args.repo, 'src/cli.ts')) as CliModule;
    const apps = args.apps;
    const dataDir = join(dir, 'data');
    const reportOut = join(dir, `report-${args.stage}.csv`);
    const cfgPath = writeConfig(dir, dataDir, apps, args.stage === 'sim' ? true : args.defaultPacing, args.stage === 'sim' ? args.parallel : 1);
    const clock = new VirtualClock(START);
    const counters: FakeCounters = { calls: {}, numbers: {} };
    const txStats = instrumentStore(Store);
    if (args.stage !== 'report') {
      rmSync(dataDir, { recursive: true, force: true });
      assertOutsideRepo(dataDir, args.repo);
      prepareAccounts(dataDir, apps, args.accounts);
    }
    const deps: CliDeps = {
      loadAdapter: makeLoadAdapter(clock, args.latencyMs, counters),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    };
    const argv =
      args.stage === 'report'
        ? ['node', 'phone-app-checker', '--config', cfgPath, 'report', csv, '--out', reportOut, '--apps', apps.join(','), '--force']
        : ['node', 'phone-app-checker', '--config', cfgPath, 'check', csv, '--out', reportOut, '--apps', apps.join(','), '--progress', 'off', '--force'];
    const result = await runCli(createProgram, argv, clock, deps, dir);
    const reportBytes = existsSync(reportOut) ? statSync(reportOut).size : 0;
    const reportSha256 = existsSync(reportOut) ? sha256File(reportOut) : undefined;
    const payload: Record<string, unknown> = {
      stage: args.stage,
      rows: args.rows,
      seed: args.seed,
      apps,
      accounts: args.accounts,
      parallel: args.stage === 'sim' ? args.parallel : undefined,
      latencyMs: args.latencyMs,
      realMs: result.ms,
      simulatedMs: args.stage === 'report' ? undefined : clock.t - START,
      adapterCalls: counters.calls,
      adapterNumbers: counters.numbers,
      transactions: txStats.transactions,
      transactionMs: Number(txStats.transactionMs.toFixed(1)),
      allResultsCalls: txStats.allResultsCalls,
      allResultsRows: txStats.allResultsRows,
      checkedLinesSuppressed: result.checkedLines,
      reportBytes,
      reportSha256,
      error: result.error,
      logTail: result.logTail,
    };
    if (args.stage === 'sim') {
      // Lower bound on the simulated time: batches are limited both by the worker pool (min(K, accounts)
      // batches at a time, each taking the latency) and by per-account pacing (each account starts a new
      // batch only latency + mean pacing after the previous one; mean pacing = minIntervalMs + jitterMs/2
      // of the shipped telegram config, read from the target's defaults). K=1 is the serial loop.
      const { DEFAULT_APPS } = (await imp(args.repo, 'src/config.ts')) as ConfigModule;
      const pacing = DEFAULT_APPS.telegram;
      const cycle = args.latencyMs + pacing.minIntervalMs + pacing.jitterMs / 2;
      const batches = counters.calls[apps[0] as string] ?? 0;
      const workers = Math.max(1, Math.min(args.parallel, args.accounts));
      const workerBound = Math.ceil(batches / workers) * args.latencyMs;
      const pacingBound = Math.ceil(batches / args.accounts) * cycle;
      payload.idealConcurrentMin = Number((Math.max(workerBound, pacingBound) / 60_000).toFixed(1));
      payload.simulatedMin = Number(((clock.t - START) / 60_000).toFixed(1));
      payload.serialLatencyBoundMin = Number(((batches * args.latencyMs) / 60_000).toFixed(1));
    }
    out(payload);
    return;
  }

  throw new Error(`unknown stage ${args.stage}`);
}

await main();
