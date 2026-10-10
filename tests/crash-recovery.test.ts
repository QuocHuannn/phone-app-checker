import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_FILE, RECLAIM_FILE } from '../src/lock.ts';
import { Store } from '../src/store.ts';
import { APPS, type App } from '../src/types.ts';
import { Prng } from './helpers/prng.ts';
import { COLS, REPORT_HEADER } from './helpers/report-rows.ts';
import { truth } from './helpers/truth.ts';

/*
 * Real-process tests: the actual CLI entry (src/cli.ts main) runs in a child process with a test
 * adapter injected through the documented `loadAdapter` seam. The parent kills it (SIGKILL, so no
 * handler runs) at seeded points and checks what is left on disk.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures', 'cli-child.ts');
const APPS_UNDER_TEST: App[] = ['telegram', 'whatsapp', 'zalo'];
const HEADER = REPORT_HEADER;

interface Running {
  child: ChildProcess;
  stderr: () => string;
  /** Resolves true once the child has made `n` platform calls, false if it exited first. */
  waitForCall: (n: number) => Promise<boolean>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const dirs: string[] = [];
const live: ChildProcess[] = [];

afterEach(() => {
  for (const child of live.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Workspace {
  dir: string;
  csv: string;
  config: string;
  dataDir: string;
  numbers: string[];
}

function workspace(count: number, seed = 1): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'checker-crash-'));
  dirs.push(dir);
  const prng = new Prng(seed);
  const numbers = new Set<string>();
  while (numbers.size < count) numbers.add(`0${prng.pick(['90', '91', '93', '98'])}${prng.digits(7)}`);
  const csv = join(dir, 'customers.csv');
  writeFileSync(csv, ['name,phone', ...[...numbers].map((n, i) => `Khách ${i},${n}`), ''].join('\n'));
  const dataDir = join(dir, 'data');
  const pacing = { enabled: true, batchSize: 5, dailyCap: 100_000, minIntervalMs: 0, jitterMs: 0 };
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ defaultRegion: 'VN', dataDir, apps: { telegram: pacing, whatsapp: pacing, zalo: pacing, viber: { enabled: false }, line: { enabled: false } } }),
  );
  for (const app of APPS_UNDER_TEST) mkdirSync(join(dataDir, 'sessions', app, 'a'), { recursive: true });
  return { dir, csv, config, dataDir, numbers: [...numbers].map((n) => `+84${n.slice(1)}`) };
}

function start(ws: Workspace, args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', FIXTURE, '--config', ws.config, ...args], {
    // HOME inside the workspace: the lifecycle registrations of (SIGKILLed) children stay out of the real home.
    env: { ...process.env, HOME: join(ws.dir, 'home'), CRASH_DELAY_MS: '3', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.push(child);
  let stdout = '';
  let err = '';
  let calls = 0;
  const waiters: { n: number; resolve: (reached: boolean) => void }[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('CALL ')) continue;
      calls = Number(line.split(' ')[1]);
      for (const waiter of waiters.splice(0)) {
        if (calls >= waiter.n) waiter.resolve(true);
        else waiters.push(waiter);
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const waiter of waiters.splice(0)) waiter.resolve(false);
      resolve({ code, signal });
    });
  });
  return {
    child,
    stderr: () => err,
    waitForCall: (n) => (calls >= n ? Promise.resolve(true) : new Promise((resolve) => waiters.push({ n, resolve }))),
    exited,
  };
}

const checkArgs = (ws: Workspace, out: string) => ['check', ws.csv, '--out', out, '--apps', APPS_UNDER_TEST.join(',')];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until the process printed `text` on stderr (polling the condition, not guessing a delay). */
async function untilStderr(running: Running, text: string): Promise<void> {
  while (!running.stderr().includes(text)) {
    if (running.child.exitCode !== null) throw new Error(`process exited before printing "${text}": ${running.stderr()}`);
    await pause(10);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stored results by app, read through a normal Store (WAL recovery included). */
function committed(ws: Workspace): Record<App, Map<string, string>> {
  const store = Store.open(ws.dataDir);
  try {
    const integrity = store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    const out = {} as Record<App, Map<string, string>>;
    for (const app of APPS) {
      out[app] = new Map([...store.allResults(app)].map(([e164, result]) => [e164, result.status]));
    }
    return out;
  } finally {
    store.close();
  }
}

function sentLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : [];
}

/** Everything the data directory may legitimately contain once no process is running. */
function strayFiles(ws: Workspace): string[] {
  return readdirSync(ws.dataDir).filter((name) => !['checker.db', 'checker.db-wal', 'checker.db-shm', 'sessions'].includes(name));
}

function expectedRows(ws: Workspace): string[] {
  return ws.numbers.map((e164) => {
    const cells = APPS.map((app) => (APPS_UNDER_TEST.includes(app) ? truth(app, e164) : 'skipped'));
    return `${e164},VN,${cells.join(',')}`;
  });
}

/** Report rows without the input column (its spelling is the customer's) and without timestamps. */
function reportBody(path: string): string[] {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  expect(lines[0]).toBe(HEADER);
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    // The per-app observation columns follow last_checked_at.
    expect(cells[COLS.lastChecked]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(cells).toHaveLength(COLS.total);
    return cells.slice(1, COLS.lastChecked).join(',');
  });
}

describe('real process: SIGKILL at random points, then rerun', () => {
  it('loses nothing, repeats nothing that was committed, leaves no orphaned lock and a healthy database', async () => {
    const ws = workspace(450);
    const out = join(ws.dir, 'report.csv');
    const prng = new Prng(20261009);
    const sentLogs: string[] = [];
    const committedAtKill: Record<App, Map<string, string>>[] = [];
    let kills = 0;
    let finished = false;

    for (let run = 1; run <= 14 && !finished; run += 1) {
      const sentLog = join(ws.dir, `sent-${run}.log`);
      sentLogs.push(sentLog);
      const running = start(ws, checkArgs(ws, out), { CRASH_SENT_LOG: sentLog });
      const killAt = run <= 8 ? prng.range(3, 40) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(killAt) && (await running.waitForCall(killAt))) {
        await pause(prng.range(0, 20));
        running.child.kill('SIGKILL');
      }
      const { code, signal } = await running.exited;
      if (signal === 'SIGKILL') {
        kills += 1;
        const pid = running.child.pid as number;
        // A killed run leaves its lock behind; it names a process that is gone.
        const lockPath = join(ws.dataDir, LOCK_FILE);
        if (existsSync(lockPath)) {
          expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(pid);
          expect(isAlive(pid)).toBe(false);
        }
        const snapshot = committed(ws);
        for (const app of APPS_UNDER_TEST) {
          for (const [e164, status] of snapshot[app]) expect(status, `${app} ${e164} after kill ${kills}`).toBe(truth(app, e164));
        }
        committedAtKill.push(snapshot);
      } else {
        expect(running.stderr()).not.toMatch(/Error:/);
        expect(code).toBe(0);
        finished = true;
      }
    }
    expect(kills, 'the scenario must really kill runs').toBeGreaterThanOrEqual(4);
    expect(finished).toBe(true);

    // Results are complete and correct, the report matches the platforms' truth.
    const final = committed(ws);
    for (const app of APPS_UNDER_TEST) {
      expect(final[app].size).toBe(ws.numbers.length);
      for (const e164 of ws.numbers) expect(final[app].get(e164)).toBe(truth(app, e164));
    }
    expect(reportBody(out)).toEqual(expectedRows(ws));

    // Nothing committed before a kill was asked of a platform again.
    for (const [index, snapshot] of committedAtKill.entries()) {
      for (const log of sentLogs.slice(index + 1)) {
        for (const line of sentLines(log)) {
          const [app, e164] = line.split(' ') as [App, string];
          expect(snapshot[app].has(e164), `${line} was committed before kill ${index + 1} but sent again in ${log}`).toBe(false);
        }
      }
    }
    // Each number is sent at most once per run; across runs only batches in flight at a kill repeat.
    const sends = new Map<string, number>();
    for (const log of sentLogs) for (const line of sentLines(log)) sends.set(line, (sends.get(line) ?? 0) + 1);
    let repeated = 0;
    for (const count of sends.values()) if (count > 1) repeated += count - 1;
    expect(repeated, 'only batches in flight at a kill may be repeated').toBeLessThanOrEqual(kills * 5 * APPS_UNDER_TEST.length);
    expect(sends.size).toBe(ws.numbers.length * APPS_UNDER_TEST.length);

    // No orphaned lock, reclaim guard, temp or journal file survives a clean finish.
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(false);
    expect(existsSync(join(ws.dataDir, RECLAIM_FILE))).toBe(false);
    expect(strayFiles(ws)).toEqual([]);
    expect(readdirSync(ws.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 180_000);
});

describe('real process: locking', () => {
  it('a second check on the same data directory is refused while the first runs, and the first finishes undisturbed', async () => {
    const ws = workspace(120);
    const out1 = join(ws.dir, 'one.csv');
    const hold = join(ws.dir, 'release');
    const first = start(ws, checkArgs(ws, out1), { CRASH_HOLD_FILE: hold, CRASH_HOLD_AFTER: '3' });
    expect(await first.waitForCall(3)).toBe(true);

    const lock = JSON.parse(readFileSync(join(ws.dataDir, LOCK_FILE), 'utf8')) as { pid: number };
    expect(lock.pid).toBe(first.child.pid);

    const second = start(ws, checkArgs(ws, join(ws.dir, 'two.csv')));
    const secondExit = await second.exited;
    expect(secondExit.code).toBe(1);
    expect(second.stderr()).toContain(`Another check or login is already running (pid ${first.child.pid}`);
    expect(existsSync(join(ws.dir, 'two.csv'))).toBe(false);
    // An account reset is exclusive too.
    const reset = start(ws, ['account-reset', 'telegram', 'a']);
    expect((await reset.exited).code).toBe(1);
    expect(reset.stderr()).toContain('already running');
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(true);

    // `report` only reads: it works while the check runs and writes a valid partial report.
    const partial = join(ws.dir, 'partial.csv');
    const reading = start(ws, ['report', ws.csv, '--out', partial, '--apps', APPS_UNDER_TEST.join(',')]);
    expect((await reading.exited).code).toBe(0);
    expect(readFileSync(partial, 'utf8').split('\n')[0]).toBe(HEADER);

    // The first run was held inside its third platform call the whole time: it was certainly running.
    expect(first.child.exitCode).toBeNull();
    writeFileSync(hold, '');
    expect((await first.exited).code).toBe(0);
    expect(reportBody(out1)).toEqual(expectedRows(ws));
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(false);
  }, 120_000);
});

describe('real process: signals', () => {
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('%s finishes the batch, writes the report, exits 130 and frees the lock; a rerun completes without repeats', async (signal) => {
    const ws = workspace(150);
    const out = join(ws.dir, 'report.csv');
    const log1 = join(ws.dir, 'sent-1.log');
    const hold = join(ws.dir, 'release');
    const first = start(ws, checkArgs(ws, out), { CRASH_HOLD_FILE: hold, CRASH_HOLD_AFTER: '7', CRASH_SENT_LOG: log1 });
    expect(await first.waitForCall(7)).toBe(true);
    first.child.kill(signal);
    // Wait for the process to report the signal while it is still inside the held batch, then let the batch finish.
    await untilStderr(first, 'Interrupt received');
    writeFileSync(hold, '');
    const exit = await first.exited;
    expect(exit).toMatchObject({ code: 130, signal: null });
    expect(first.stderr()).toContain('Interrupt received');
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(false);
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe(HEADER);
    const partial = committed(ws);
    expect(APPS_UNDER_TEST.reduce((total, app) => total + partial[app].size, 0)).toBeGreaterThan(0);
    for (const app of APPS_UNDER_TEST) expect(partial[app].size).toBeLessThan(ws.numbers.length);

    const log2 = join(ws.dir, 'sent-2.log');
    const second = start(ws, checkArgs(ws, out), { CRASH_SENT_LOG: log2 });
    expect((await second.exited).code).toBe(0);
    expect(reportBody(out)).toEqual(expectedRows(ws));
    // A graceful stop commits the batch in flight, so no number was sent twice.
    const all = [...sentLines(log1), ...sentLines(log2)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(ws.numbers.length * APPS_UNDER_TEST.length);
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(false);
    expect(strayFiles(ws)).toEqual([]);
  }, 120_000);

  it('a second interrupt forces an immediate exit that still releases the lock and keeps the database sound', async () => {
    const ws = workspace(150);
    const out = join(ws.dir, 'report.csv');
    const hold = join(ws.dir, 'release');
    const running = start(ws, checkArgs(ws, out), { CRASH_HOLD_FILE: hold, CRASH_HOLD_AFTER: '3' });
    expect(await running.waitForCall(3)).toBe(true);
    running.child.kill('SIGINT');
    await untilStderr(running, 'Interrupt received'); // the first interrupt was handled: a second one now means "quit"
    running.child.kill('SIGINT');
    const exit = await running.exited;
    expect(exit.code).toBe(130);
    expect(existsSync(join(ws.dataDir, LOCK_FILE))).toBe(false);
    committed(ws);
  }, 60_000);
});

describe('real process: SIGKILL while the report is being written', () => {
  it('the report file is always a complete report, and any temp file left behind is private', async () => {
    const ws = workspace(100, 3);
    // A large input makes the report slow enough to be interrupted during parsing and writing.
    const lines = ['name,phone'];
    for (const e164 of ws.numbers) lines.push(`x,0${e164.slice(3)}`);
    const prng = new Prng(77);
    for (let i = 0; i < 60_000; i += 1) lines.push(`bulk ${i},0${prng.pick(['90', '91', '93'])}${prng.digits(7)}`);
    writeFileSync(ws.csv, `${lines.join('\n')}\n`);
    const out = join(ws.dir, 'report.csv');
    const reference = start(ws, ['report', ws.csv, '--out', out, '--apps', APPS_UNDER_TEST.join(',')]);
    expect((await reference.exited).code).toBe(0);
    const expected = readFileSync(out);

    // Kill as soon as the writer's temp file shows up (the CSV is still being built or written).
    let killed = 0;
    for (const extraMs of [0, 5, 15, 30, 60, 120]) {
      const running = start(ws, ['report', ws.csv, '--out', out, '--apps', APPS_UNDER_TEST.join(','), '--force']);
      let done = false;
      void running.exited.then(() => {
        done = true;
      });
      while (!done && !readdirSync(ws.dir).some((name) => name.startsWith('.report.csv.') && name.endsWith('.tmp'))) await pause(1);
      if (!done) {
        await pause(extraMs);
        running.child.kill('SIGKILL');
      }
      const { signal } = await running.exited;
      if (signal === 'SIGKILL') killed += 1;
      expect(readFileSync(out).equals(expected), `torn or changed report after a kill ${extraMs} ms into the write`).toBe(true);
    }
    expect(killed).toBeGreaterThanOrEqual(4);
    const orphans = readdirSync(ws.dir).filter((name) => name.endsWith('.tmp'));
    expect(orphans.length).toBeLessThanOrEqual(killed);
    // An abandoned temp file holds customer data, so it must be as private as the report.
    for (const name of orphans) expect(statSync(join(ws.dir, name)).mode & 0o777, name).toBe(0o600);
    // The next run replaces the report normally even with orphaned temp files around, and once they
    // are old enough to be nobody's work in progress it deletes them.
    const longAgo = Date.now() / 1000 - 3600;
    for (const name of orphans) utimesSync(join(ws.dir, name), longAgo, longAgo);
    const again = start(ws, ['report', ws.csv, '--out', out, '--apps', APPS_UNDER_TEST.join(',')]);
    expect((await again.exited).code).toBe(0);
    expect(readFileSync(out).equals(expected)).toBe(true);
    expect(readdirSync(ws.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 120_000);
});
