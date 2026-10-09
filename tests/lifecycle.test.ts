import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli.ts';
import {
  acquireLifecycleShared,
  LIFECYCLE_BARRIER,
  LIFECYCLE_DIR_NAME,
  LIFECYCLE_SHARED,
  lifecycleDir,
} from '../src/lock.ts';
import type { Adapter, App } from '../src/types.ts';

let root: string;
let lc: string;
let barrier: string;
const sleepers: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  lc = join(root, 'lifecycle');
  barrier = join(lc, LIFECYCLE_BARRIER);
});

afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  if (result.pid === undefined) throw new Error('spawn failed');
  return result.pid;
}

function livePid(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  sleepers.push(child);
  if (child.pid === undefined) throw new Error('spawn failed');
  return child.pid;
}

function writeBarrier(pid: number): void {
  mkdirSync(lc, { recursive: true });
  writeFileSync(barrier, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`);
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const registrations = (): string[] => (existsSync(join(lc, LIFECYCLE_SHARED)) ? readdirSync(join(lc, LIFECYCLE_SHARED)) : []);

describe('lifecycleDir', () => {
  it('is derived from the given home, outside the app home and the installation tree', () => {
    const dir = lifecycleDir('/Users/someone');
    expect(dir.startsWith('/Users/someone/')).toBe(true);
    expect(dir.endsWith(LIFECYCLE_DIR_NAME)).toBe(true);
    if (process.platform === 'darwin') {
      expect(dir).toBe(`/Users/someone/Library/Application Support/${LIFECYCLE_DIR_NAME}`);
    }
    expect(dir).not.toContain('/Applications/phone-app-checker');
    expect(dir).not.toBe('/Users/someone/Library/Application Support/phone-app-checker');
  });
});

describe('acquireLifecycleShared', () => {
  it('registers <pid>.<token> for the duration of the hold, idempotent release, no leaked exit handler', () => {
    const before = process.listenerCount('exit');
    const hold = acquireLifecycleShared(lc);
    const [name] = registrations();
    expect(registrations()).toHaveLength(1);
    expect(name).toMatch(new RegExp(`^${process.pid}\\.[0-9a-f]{16}$`));
    expect(JSON.parse(readFileSync(join(lc, LIFECYCLE_SHARED, name ?? ''), 'utf8')).pid).toBe(process.pid);
    expect(process.listenerCount('exit')).toBe(before + 1);
    hold.release();
    hold.release();
    expect(registrations()).toEqual([]);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('many commands hold it at once (shared)', () => {
    const a = acquireLifecycleShared(lc);
    const b = acquireLifecycleShared(lc);
    expect(registrations()).toHaveLength(2);
    a.release();
    b.release();
    expect(registrations()).toEqual([]);
  });

  it('refuses while install/uninstall holds the barrier, and leaves nothing registered', () => {
    writeBarrier(livePid());
    expect(() => acquireLifecycleShared(lc)).toThrow(/install or uninstall of phone-app-checker is in progress \(pid \d+, .*\); nothing was opened/);
    expect(registrations()).toEqual([]);
    expect(existsSync(barrier)).toBe(true);
  });

  it('an abandoned barrier (owner gone) fails closed with repair guidance and is never broken', () => {
    const dead = deadPid();
    writeBarrier(dead);
    const before = readFileSync(barrier, 'utf8');
    expect(() => acquireLifecycleShared(lc)).toThrow(
      new RegExp(`interrupted: ${escapeRe(barrier)} was left by pid ${dead}.*Repair:.*delete ${escapeRe(barrier)}`, 's'),
    );
    expect(readFileSync(barrier, 'utf8')).toBe(before);
    expect(registrations()).toEqual([]);
    rmSync(barrier); // the documented repair
    acquireLifecycleShared(lc).release();
  });

  it('a barrier without a usable owner is refused as abandoned', () => {
    mkdirSync(lc, { recursive: true });
    writeFileSync(barrier, 'garbage');
    expect(() => acquireLifecycleShared(lc)).toThrow(/interrupted.*cannot be identified.*Repair:/s);
    expect(readFileSync(barrier, 'utf8')).toBe('garbage');
  });

  it('a live-owner refusal names the barrier file and says how to clear it (the pid may have been reused)', () => {
    const pid = livePid();
    writeBarrier(pid);
    expect(() => acquireLifecycleShared(lc)).toThrow(
      new RegExp(`in progress \\(pid ${pid}, ${escapeRe(barrier)}\\).*If nothing is running, delete ${escapeRe(barrier)}`, 's'),
    );
    expect(existsSync(barrier)).toBe(true); // never broken automatically
  });

  it('a pid that may not be signalled (EPERM, pid 1) counts as alive, like install.sh/uninstall.sh: refused with the repair path', () => {
    writeBarrier(1);
    expect(() => acquireLifecycleShared(lc)).toThrow(
      new RegExp(`in progress \\(pid 1, ${escapeRe(barrier)}\\).*If nothing is running, delete ${escapeRe(barrier)}`, 's'),
    );
    expect(registrations()).toEqual([]);
  });

  it('register-then-check ordering: a barrier published between the two steps is seen', () => {
    let hold: unknown;
    expect(() => {
      hold = acquireLifecycleShared(lc, { afterRegistered: () => writeBarrier(livePid()) });
    }).toThrow(/in progress/);
    expect(hold).toBeUndefined();
    expect(registrations()).toEqual([]);
  });

  it('retries when a finishing uninstall removes the empty directories between mkdir and publish', () => {
    mkdirSync(lc, { recursive: true });
    const hold = acquireLifecycleShared(lc);
    expect(registrations()).toHaveLength(1);
    hold.release();
    rmSync(lc, { recursive: true }); // as lifecycle_cleanup does once nothing is registered
    const again = acquireLifecycleShared(lc);
    expect(registrations()).toHaveLength(1);
    again.release();
  });

  describe.skipIf(process.getuid?.() === 0)('unreadable barrier', () => {
    it('is an error, not "no barrier"', () => {
      writeBarrier(livePid());
      chmodSync(barrier, 0o000);
      try {
        expect(() => acquireLifecycleShared(lc)).toThrow(/Cannot read the lock .*EACCES/s);
      } finally {
        chmodSync(barrier, 0o600);
      }
      expect(registrations()).toEqual([]);
    });
  });
});

describe('every CLI entry point holds the lifecycle registration BEFORE it bootstraps or opens anything', () => {
  let out: string;
  let csv: string;
  let configDir: string;
  let externalData: string;
  let configFile: string;
  let loads: string[];

  beforeEach(() => {
    out = join(root, 'out');
    mkdirSync(out);
    csv = join(root, 'numbers.csv');
    writeFileSync(csv, 'phone\n0901234567\n');
    configDir = join(root, 'config-dir');
    externalData = join(root, 'external-data'); // outside the app home
    mkdirSync(configDir);
    configFile = join(configDir, 'my.config.json');
    writeFileSync(configFile, JSON.stringify({ dataDir: externalData }));
    loads = [];
  });

  function program(env: NodeJS.ProcessEnv = {}) {
    return createProgram({
      lifecycleDir: lc,
      env,
      log: () => {},
      print: () => {},
      loadAdapter: async (app: App): Promise<Adapter> => {
        loads.push(app);
        throw new Error('adapter must not be loaded while maintenance runs');
      },
    });
  }

  const COMMANDS: [string, string[]][] = [
    ['check', ['check', 'CSV', '--out', 'OUT']],
    ['login', ['login', 'telegram']],
    ['report', ['report', 'CSV', '--out', 'OUT']],
    ['accounts', ['accounts']],
    ['account-reset', ['account-reset', 'telegram', 'default']],
    ['doctor', ['doctor']],
  ];
  const args = (template: string[]): string[] =>
    template.map((a) => (a === 'CSV' ? csv : a === 'OUT' ? join(out, 'report.csv') : a));

  describe.each([
    ['explicit --config with an external dataDir', () => ({ prefix: ['--config', configFile], env: {} as NodeJS.ProcessEnv })],
    ['PHONE_APP_CHECKER_HOME (release mode, fresh home)', () => ({ prefix: [] as string[], env: { PHONE_APP_CHECKER_HOME: join(root, 'home-a', 'phone-app-checker') } as NodeJS.ProcessEnv })],
    ['another PHONE_APP_CHECKER_HOME', () => ({ prefix: [] as string[], env: { PHONE_APP_CHECKER_HOME: join(root, 'home-b') } as NodeJS.ProcessEnv })],
  ])('%s', (_label, setup) => {
    it.each(COMMANDS)('%s is refused while maintenance holds the barrier, and touches nothing', async (_name, template) => {
      writeBarrier(livePid());
      const { prefix, env } = setup();
      const rootBefore = readdirSync(root).sort();
      await expect(program(env).parseAsync([...prefix, ...args(template)], { from: 'user' })).rejects.toThrow(/in progress/);
      expect(loads).toEqual([]);
      expect(existsSync(externalData)).toBe(false); // data directory not created
      expect(readdirSync(root).sort()).toEqual(rootBefore); // no app home bootstrapped, no report, no database
      expect(readdirSync(out)).toEqual([]);
      expect(registrations()).toEqual([]);
    });

    it.each(COMMANDS)('%s is refused with repair guidance when maintenance was abandoned', async (_name, template) => {
      writeBarrier(deadPid());
      const { prefix, env } = setup();
      const rootBefore = readdirSync(root).sort();
      await expect(program(env).parseAsync([...prefix, ...args(template)], { from: 'user' })).rejects.toThrow(/interrupted.*Repair:/s);
      expect(readdirSync(root).sort()).toEqual(rootBefore);
      expect(existsSync(barrier)).toBe(true);
    });
  });

  it('the hidden data-dir command still answers (install.sh calls it while it holds the exclusive side)', async () => {
    writeBarrier(livePid());
    const printed: string[] = [];
    const cli = createProgram({ lifecycleDir: lc, env: {}, log: () => {}, print: (text) => printed.push(text) });
    await cli.parseAsync(['--config', configFile, 'data-dir'], { from: 'user' });
    expect(printed).toEqual([externalData]);
    expect(registrations()).toEqual([]);
  });

  it('a command is registered for its whole run and unregistered on success and on failure', async () => {
    const seen: number[] = [];
    const loadAdapter = async (app: App): Promise<Adapter> => ({
      app,
      async login() {
        seen.push(registrations().length);
        if (process.env.LIFECYCLE_TEST_FAIL === '1') throw new Error('OTP rejected');
      },
      async open() {
        throw new Error('not used');
      },
    });
    const make = () => createProgram({ lifecycleDir: lc, env: {}, log: () => {}, print: () => {}, loadAdapter });

    await make().parseAsync(['--config', configFile, 'login', 'telegram'], { from: 'user' });
    expect(seen).toEqual([1]);
    expect(registrations()).toEqual([]);

    process.env.LIFECYCLE_TEST_FAIL = '1';
    try {
      await expect(make().parseAsync(['--config', configFile, 'login', 'telegram'], { from: 'user' })).rejects.toThrow('OTP rejected');
    } finally {
      delete process.env.LIFECYCLE_TEST_FAIL;
    }
    expect(seen).toEqual([1, 1]);
    expect(registrations()).toEqual([]);
  });

  it('two commands for different homes register side by side (shared, not serialised)', async () => {
    const otherConfig = join(configDir, 'other.config.json');
    writeFileSync(otherConfig, JSON.stringify({ dataDir: join(root, 'external-data-2') }));

    // Both logins must be inside their command at the same moment: each waits for the other to arrive,
    // and the registrations are counted while both are still running. A serialised implementation
    // (second command blocked until the first finished) would never let the second one arrive, so the
    // test would hang and fail on its timeout instead of passing.
    let arrived = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const seen: number[] = [];
    const loadAdapter = async (app: App): Promise<Adapter> => ({
      app,
      async login() {
        arrived += 1;
        if (arrived === 2) openGate();
        await gate;
        seen.push(registrations().length);
      },
      async open() {
        throw new Error('not used');
      },
    });
    const make = () => createProgram({ lifecycleDir: lc, env: {}, log: () => {}, print: () => {}, loadAdapter });
    await Promise.all([
      make().parseAsync(['--config', configFile, 'login', 'telegram'], { from: 'user' }),
      make().parseAsync(['--config', otherConfig, 'login', 'zalo'], { from: 'user' }),
    ]);
    expect(arrived).toBe(2);
    expect(seen).toEqual([2, 2]); // two live registrations at once, seen from inside both commands
    expect(registrations()).toEqual([]); // and both released at the end
  });
});

describe('the run lock is taken before the database is opened', () => {
  it.each([
    ['check', (csv: string, cfg: string) => ['--config', cfg, 'check', csv, '--out', join(root, 'r.csv')]],
    ['account-reset', (_csv: string, cfg: string) => ['--config', cfg, 'account-reset', 'telegram', 'a']],
  ])('%s refused by a live run never creates or opens checker.db', async (_name, argv) => {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'check.lock'), `${JSON.stringify({ pid: livePid() })}\n`);
    const cfg = join(root, 'c.json');
    writeFileSync(cfg, JSON.stringify({ dataDir }));
    const csv = join(root, 'n.csv');
    writeFileSync(csv, 'phone\n0901234567\n');
    const cli = createProgram({ lifecycleDir: lc, env: {}, log: () => {}, print: () => {}, loadAdapter: async () => { throw new Error('no'); } });
    await expect(cli.parseAsync(argv(csv, cfg), { from: 'user' })).rejects.toThrow(/already running/);
    expect(readdirSync(dataDir).sort()).toEqual(['check.lock']);
  });
});
