import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRunLock, LOCK_FILE, RECLAIM_FILE, writeFully } from '../src/lock.ts';

const CHILD = resolve('tests/fixtures/lock-child.ts');

let root: string;
let dataDir: string;
let control: string;
let children: Child[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lock-race-'));
  dataDir = join(root, 'data');
  control = join(root, 'control');
  mkdirSync(dataDir);
  mkdirSync(control);
  children = [];
});

afterEach(() => {
  for (const child of children) child.process.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

/** A real child process running tests/fixtures/lock-child.ts. */
class Child {
  readonly process: ChildProcess;
  private output = '';
  private waiters: (() => void)[] = [];
  private readonly exited = Promise.withResolvers<void>();

  readonly name: string;

  constructor(name: string, pause?: 'publish' | 'guard' | 'stale' | 'removed' | 'observed') {
    this.name = name;
    this.process = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CHILD, dataDir, control, name],
      { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(pause ? { LOCK_PAUSE: pause } : {}) } },
    );
    this.process.on('exit', () => this.exited.resolve());
    this.process.stdout?.setEncoding('utf8');
    this.process.stdout?.on('data', (chunk: string) => {
      this.output += chunk;
      for (const wake of this.waiters.splice(0)) wake();
    });
    children.push(this);
  }

  /**
   * Resolve with the first output line matching `pattern`. The timer only bounds a hung child; the
   * awaited condition is the child's output itself.
   */
  async line(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
    const expired = Symbol('expired');
    const timer = Promise.withResolvers<typeof expired>();
    const handle = setTimeout(() => timer.resolve(expired), timeoutMs);
    try {
      for (;;) {
        const found = this.output.split('\n').find((l) => pattern.test(l));
        if (found !== undefined) return found;
        const next = Promise.withResolvers<void>();
        this.waiters.push(next.resolve);
        if ((await Promise.race([next.promise, timer.promise])) === expired) {
          throw new Error(`child ${this.name}: no output matching ${pattern} (got ${JSON.stringify(this.output)})`);
        }
      }
    } finally {
      clearTimeout(handle);
    }
  }

  /** WIN or LOSE verdict line. */
  verdict(timeoutMs?: number): Promise<string> {
    return this.line(/^(WIN|LOSE) /, timeoutMs);
  }

  ready(): Promise<string> {
    return this.line(/^READY$/);
  }

  resume(): void {
    writeFileSync(join(control, `${this.name}.resume`), '');
  }

  /** The child is frozen at its pause point. */
  async paused(): Promise<void> {
    await this.line(/^PAUSED$/);
  }

  /** Close stdin: a winner releases its lock and exits; resolves once the process is gone. */
  finish(): Promise<void> {
    this.process.stdin?.end();
    return this.exited.promise;
  }

  /** SIGKILL: no handlers, no cleanup; resolves once the process is gone. */
  kill(): Promise<void> {
    this.process.kill('SIGKILL');
    return this.exited.promise;
  }
}

function go(): void {
  writeFileSync(join(control, 'go'), '');
}

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  if (result.pid === undefined) throw new Error('spawn failed');
  return result.pid;
}

function writeStale(): number {
  const pid = deadPid();
  writeFileSync(join(dataDir, LOCK_FILE), `${JSON.stringify({ pid })}\n`);
  return pid;
}

function lockOwner(): number {
  const { pid } = JSON.parse(readFileSync(join(dataDir, LOCK_FILE), 'utf8'));
  return pid;
}

describe('run lock across real processes', () => {
  it.each([1, 2, 3, 4, 5])('round %i: racing on one stale lock yields exactly one winner', async () => {
    writeStale();
    const racers = Array.from({ length: 8 }, (_, i) => new Child(`r${i}`));
    await Promise.all(racers.map((r) => r.ready()));
    go();
    const verdicts = await Promise.all(racers.map((r) => r.verdict()));

    const winners = verdicts.filter((v) => v.startsWith('WIN '));
    expect(winners).toHaveLength(1);
    for (const loser of verdicts.filter((v) => v.startsWith('LOSE '))) expect(loser).toMatch(/already running|Could not acquire/);
    const winnerPid = Number(winners[0]?.slice(4));
    expect(lockOwner()).toBe(winnerPid); // the loser(s) did not delete or replace the winner's lock
    await Promise.all(racers.map((r) => r.finish()));
  }, 60_000);

  it('a reclaimer paused after validating the stale lock locks out a second reclaimer; one winner', async () => {
    const stalePid = writeStale();
    const slow = new Child('slow', 'stale');
    await slow.ready();
    go();
    await slow.paused(); // holds the reclaim guard, stale owner validated, unlink not yet done

    const fast = new Child('fast');
    await fast.ready();

    // The fast process must neither remove the stale lock nor take over while the guard is held.
    expect(await fast.verdict(30_000)).toMatch(/^LOSE Could not acquire/);
    expect(lockOwner()).toBe(stalePid);
    expect(existsSync(join(dataDir, RECLAIM_FILE))).toBe(true);

    slow.resume();
    const won = await slow.verdict();
    expect(won).toMatch(/^WIN /);
    expect(lockOwner()).toBe(Number(won.slice(4)));
    expect(existsSync(join(dataDir, RECLAIM_FILE))).toBe(false);

    // A latecomer sees a live owner and never touches the lock.
    const late = new Child('late');
    await late.ready();
    expect(await late.verdict()).toMatch(/^LOSE Another check or login is already running \(pid \d+/);
    expect(lockOwner()).toBe(Number(won.slice(4)));
    await slow.finish();
  }, 60_000);

  it('a creator paused before publishing holds no lock and loses to whoever took it meanwhile', async () => {
    const slow = new Child('slow', 'publish');
    await slow.ready();
    go();
    await slow.paused();
    // No half-written lock file is ever visible, so nobody can mistake it for a stale lock.
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(false);

    const other = new Child('other');
    await other.ready();
    const won = await other.verdict();
    expect(won).toMatch(/^WIN /);

    slow.resume();
    expect(await slow.verdict()).toBe(
      `LOSE Another check or login is already running (pid ${won.slice(4)}, lock ${join(dataDir, LOCK_FILE)}). Wait for it to finish; ` +
        `if nothing is running, delete ${join(dataDir, LOCK_FILE)} (the pid may have been reused after a crash or power cut).`,
    );
    expect(lockOwner()).toBe(Number(won.slice(4)));
    await other.finish();
  }, 60_000);

  it('a creator paused before publishing cannot clobber a lock reclaimed from a stale file', async () => {
    writeStale();
    const slow = new Child('slow', 'publish');
    await slow.ready();
    go();
    await slow.paused();

    const other = new Child('other');
    await other.ready();
    const won = await other.verdict();
    expect(won).toMatch(/^WIN /);

    slow.resume();
    expect(await slow.verdict()).toMatch(new RegExp(`^LOSE Another check or login is already running \\(pid ${won.slice(4)},`));
    expect(lockOwner()).toBe(Number(won.slice(4)));
    await other.finish();
  }, 60_000);

  it('leaves no temp or guard files behind after a contended recovery', async () => {
    writeStale();
    const racers = Array.from({ length: 4 }, (_, i) => new Child(`r${i}`));
    await Promise.all(racers.map((r) => r.ready()));
    go();
    await Promise.all(racers.map((r) => r.verdict()));
    await Promise.all(racers.map((r) => r.finish()));
    expect(readdirSync(dataDir)).toEqual([]);
  }, 60_000);
});

describe('run lock guard recovery: fails closed, never breaks a guard automatically', () => {
  const guardFile = () => join(dataDir, RECLAIM_FILE);
  const writeDeadGuard = (): string => {
    const content = `${JSON.stringify({ pid: deadPid(), token: 'dead' })}\n`;
    writeFileSync(guardFile(), content);
    return content;
  };

  it('refuses with a distinct repair message when the reclaim guard was left by a crashed reclaimer', () => {
    const owner = writeStale();
    const guard = writeDeadGuard();
    expect(() => acquireRunLock(dataDir)).toThrow(/Lock recovery was interrupted.*check\.lock\.reclaim.*Repair:.*delete .*check\.lock\.reclaim/s);
    // Nothing was moved, restored or deleted.
    expect(readFileSync(guardFile(), 'utf8')).toBe(guard);
    expect(lockOwner()).toBe(owner);
    expect(readdirSync(dataDir).sort()).toEqual([LOCK_FILE, RECLAIM_FILE]);
  });

  it('refuses a guard without a readable owner the same way (it cannot be proven abandoned or live)', () => {
    writeStale();
    writeFileSync(guardFile(), 'garbage');
    expect(() => acquireRunLock(dataDir)).toThrow(/Lock recovery was interrupted/);
    expect(readFileSync(guardFile(), 'utf8')).toBe('garbage');
  });

  it('a guard whose pid is alive (maybe reused after a crash) ends the retries with the guard path and how to clear it', () => {
    const owner = writeStale();
    const live = `${JSON.stringify({ pid: process.pid, token: 'live' })}\n`;
    writeFileSync(guardFile(), live);
    expect(() => acquireRunLock(dataDir)).toThrow(
      new RegExp(`Could not acquire the run lock .*recovery guard ${guardFile().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*If nothing is running, delete ${guardFile().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's'),
    );
    expect(readFileSync(guardFile(), 'utf8')).toBe(live); // never broken automatically
    expect(lockOwner()).toBe(owner);
  }, 30_000);

  it('recovers normally once a person removed the abandoned guard', () => {
    writeStale();
    writeDeadGuard();
    expect(() => acquireRunLock(dataDir)).toThrow(/Repair:/);
    rmSync(guardFile());
    const lock = acquireRunLock(dataDir);
    expect(lockOwner()).toBe(process.pid);
    lock.release();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('does not need the guard when the lock is absent: an abandoned guard does not block a fresh acquire', () => {
    writeDeadGuard();
    const lock = acquireRunLock(dataDir);
    expect(lockOwner()).toBe(process.pid);
    lock.release();
    expect(existsSync(guardFile())).toBe(true); // still there, still reported once a recovery is needed
  });

  it('does not break a reclaim guard held by a live process', () => {
    const owner = writeStale();
    expect(owner).not.toBe(process.pid);
    writeFileSync(guardFile(), `${JSON.stringify({ pid: process.pid, token: 'live' })}\n`);
    expect(() => acquireRunLock(dataDir)).toThrow(/Could not acquire the run lock/);
    expect(existsSync(guardFile())).toBe(true);
    expect(lockOwner()).toBe(owner);
  }, 15_000);

  it('uses the injected liveness probe for the guard owner too', () => {
    writeStale();
    writeFileSync(guardFile(), `${JSON.stringify({ pid: 424242, token: 'x' })}\n`);
    expect(() => acquireRunLock(dataDir, { isAlive: (pid) => pid === 424242 })).toThrow(/Could not acquire/);
    expect(() => acquireRunLock(dataDir, { isAlive: () => false })).toThrow(/Lock recovery was interrupted/);
  }, 15_000);
});

describe.skipIf(process.getuid?.() === 0)('run lock refuses what it cannot read', () => {
  it('an unreadable lock file is not a stale lock: the error propagates and nothing is deleted', () => {
    writeFileSync(join(dataDir, LOCK_FILE), `${JSON.stringify({ pid: deadPid() })}\n`, { mode: 0o600 });
    chmodSync(join(dataDir, LOCK_FILE), 0o000);
    expect(() => acquireRunLock(dataDir)).toThrow(/Cannot read the lock .*check\.lock.*EACCES.*refusing to guess/s);
    chmodSync(join(dataDir, LOCK_FILE), 0o600);
    expect(readdirSync(dataDir)).toEqual([LOCK_FILE]);
  });

  it('an unreadable reclaim guard is refused as well', () => {
    writeStale();
    writeFileSync(join(dataDir, RECLAIM_FILE), `${JSON.stringify({ pid: deadPid() })}\n`, { mode: 0o600 });
    chmodSync(join(dataDir, RECLAIM_FILE), 0o000);
    expect(() => acquireRunLock(dataDir)).toThrow(/Cannot read the lock .*check\.lock\.reclaim.*EACCES/s);
    chmodSync(join(dataDir, RECLAIM_FILE), 0o600);
    expect(readdirSync(dataDir).sort()).toEqual([LOCK_FILE, RECLAIM_FILE]);
  });

  it('a lock path that is not a regular file (EISDIR) is refused, not treated as stale', () => {
    mkdirSync(join(dataDir, LOCK_FILE));
    expect(() => acquireRunLock(dataDir)).toThrow(/Cannot read the lock .*EISDIR/s);
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(true);
  });
});

describe('writeFully', () => {
  it('keeps writing after short writes until every byte is out', () => {
    const chunks: string[] = [];
    const shortWriter = (_fd: number, buffer: Buffer, offset: number) => {
      const take = Math.min(3, buffer.length - offset);
      chunks.push(buffer.subarray(offset, offset + take).toString('utf8'));
      return take;
    };
    writeFully(-1, '{"pid":12345}\n', shortWriter);
    expect(chunks.join('')).toBe('{"pid":12345}\n');
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('run lock: abandoned recovery with real SIGKILL at every boundary', () => {
  const guardFile = () => join(dataDir, RECLAIM_FILE);

  async function killAt(pause: 'publish' | 'guard' | 'stale' | 'removed'): Promise<Child> {
    const victim = new Child('victim', pause);
    await victim.ready();
    go();
    await victim.paused();
    await victim.kill();
    return victim;
  }

  it.each(['guard', 'stale'] as const)(
    'killed %s: the stale lock and the dead guard stay untouched, later runs refuse with the repair message, then recover after repair',
    async (pause) => {
      const owner = writeStale();
      await killAt(pause);
      const guardBefore = readFileSync(guardFile(), 'utf8');
      expect(JSON.parse(guardBefore).pid).toBeGreaterThan(0);
      expect(lockOwner()).toBe(owner); // not yet unlinked

      const next = new Child('next');
      await next.ready();
      expect(await next.verdict()).toMatch(/^LOSE Lock recovery was interrupted: .*Repair:/);
      expect(readFileSync(guardFile(), 'utf8')).toBe(guardBefore);
      expect(lockOwner()).toBe(owner);

      rmSync(guardFile()); // the documented repair
      const after = new Child('after');
      await after.ready();
      const won = await after.verdict();
      expect(won).toMatch(/^WIN /);
      expect(lockOwner()).toBe(Number(won.slice(4)));
      await after.finish();
    },
    60_000,
  );

  it('killed after the stale lock was unlinked: a fresh acquire still works (no guard needed); a later recovery then fails closed', async () => {
    writeStale();
    await killAt('removed');
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(false);
    expect(existsSync(guardFile())).toBe(true);

    const winner = new Child('winner');
    await winner.ready();
    const won = await winner.verdict();
    expect(won).toMatch(/^WIN /);
    expect(lockOwner()).toBe(Number(won.slice(4)));
    await winner.kill();

    // The winner died too: its lock is stale and the orphan guard is still there.
    const next = new Child('next');
    await next.ready();
    expect(await next.verdict()).toMatch(/^LOSE Lock recovery was interrupted/);
    expect(lockOwner()).toBe(Number(won.slice(4)));
  }, 60_000);

  it('killed before publishing: no lock exists, so the next run simply takes it', async () => {
    await killAt('publish');
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(false);
    const next = new Child('next');
    await next.ready();
    const won = await next.verdict();
    expect(won).toMatch(/^WIN /);
    await next.finish();
  }, 60_000);

  it('a lock whose owner is SIGKILLed while holding it is recovered automatically (no guard involved)', async () => {
    const holder = new Child('holder');
    await holder.ready();
    go();
    const won = await holder.verdict();
    expect(won).toMatch(/^WIN /);
    await holder.kill();
    expect(lockOwner()).toBe(Number(won.slice(4)));

    const next = new Child('next');
    await next.ready();
    const recovered = await next.verdict();
    expect(recovered).toMatch(/^WIN /);
    expect(lockOwner()).toBe(Number(recovered.slice(4)));
    await next.finish();
  }, 60_000);
});

describe('run lock: the three-reclaimer schedule that broke the old dead-guard breaker', () => {
  // Old schedule: stale main lock + dead guard G0. A observes G0 dead and is about to move it aside;
  // B replaces G0 with a live guard G1 and validates the stale lock; A then moves G1 away; C takes
  // G2 and also validates the stale lock; B and C both unlink "their" validated lock, so C deletes
  // B's fresh lock and two runs would be admitted. Here A can only refuse: it never touches a guard.
  it('A (paused after observing G0) cannot disturb B (holding G1, paused after validating); C is locked out; exactly one winner', async () => {
    const stalePid = writeStale();
    writeFileSync(join(dataDir, RECLAIM_FILE), `${JSON.stringify({ pid: deadPid(), token: 'G0' })}\n`);

    const a = new Child('A', 'observed');
    await a.ready();
    go();
    await a.paused(); // A has seen the dead G0

    rmSync(join(dataDir, RECLAIM_FILE)); // the repair B's side of the schedule needs: G0 is gone
    const b = new Child('B', 'stale');
    await b.ready();
    await b.paused(); // B holds G1 and validated the stale lock
    const g1 = readFileSync(join(dataDir, RECLAIM_FILE), 'utf8');
    expect(JSON.parse(g1).pid).toBe(b.process.pid);

    const c = new Child('C');
    await c.ready();
    expect(await c.verdict(30_000)).toMatch(/^LOSE Could not acquire/); // locked out while G1 is live

    a.resume(); // A wakes up and acts on its stale observation
    expect(await a.verdict()).toMatch(/^LOSE Lock recovery was interrupted/);
    expect(readFileSync(join(dataDir, RECLAIM_FILE), 'utf8')).toBe(g1); // G1 untouched
    expect(lockOwner()).toBe(stalePid); // nobody unlinked anything but B, and B has not yet

    b.resume();
    const won = await b.verdict();
    expect(won).toMatch(/^WIN /);
    expect(lockOwner()).toBe(Number(won.slice(4))); // B's lock is intact: C did not delete it
    expect(existsSync(join(dataDir, RECLAIM_FILE))).toBe(false);

    const late = new Child('late');
    await late.ready();
    expect(await late.verdict()).toMatch(/^LOSE Another check or login is already running/);
    await b.finish();
  }, 90_000);
});
