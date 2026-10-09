import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitWhenFlushed } from '../src/cli.ts';
import { plural } from '../src/plural.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'phone-app-checker.js');
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-process-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The real entry point, in a throw-away HOME, with no terminal (so no menu). */
function run(args: string[], timeout = 30_000) {
  return spawnSync(process.execPath, [...NODE_ARGS, BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    env: { PATH: process.env.PATH, HOME: dir, PHONE_APP_CHECKER_HOME: join(dir, 'home') },
  });
}

describe('plural', () => {
  it('uses the singular for exactly one and the plural for everything else', () => {
    expect(plural(1, 'number')).toBe('1 number');
    expect(plural(0, 'number')).toBe('0 numbers');
    expect(plural(2, 'account')).toBe('2 accounts');
    expect(plural(1, 'batch', 'batches')).toBe('1 batch');
    expect(plural(3, 'batch', 'batches')).toBe('3 batches');
  });
});

describe('exitWhenFlushed', () => {
  it('waits for every stream to take its write before it exits with the code', async () => {
    const order: string[] = [];
    const accept: Record<string, () => void> = {};
    const stream = (name: string) => ({
      write(_text: string, callback: () => void) {
        accept[name] = () => {
          order.push(`${name} flushed`);
          callback();
        };
      },
    });
    const finished = exitWhenFlushed(7, [stream('stdout'), stream('stderr')], (code) => order.push(`exit ${code}`));
    accept.stderr?.();
    await Promise.resolve();
    expect(order).toEqual(['stderr flushed']); // stdout has not taken its write yet: no exit
    accept.stdout?.();
    await finished;
    expect(order).toEqual(['stderr flushed', 'stdout flushed', 'exit 7']);
  });

  it('ends a process that still has a long timer pending (what Baileys leaves behind) at once, with the right code', () => {
    // A real child process: the point is that a pending 60 s timer does not keep it alive, which fake timers cannot show.
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [...NODE_ARGS, '--input-type=module', '-e', `import { exitWhenFlushed } from ${JSON.stringify(join(ROOT, 'src', 'cli.ts'))}; setTimeout(() => {}, 60000); console.log('done'); await exitWhenFlushed(3);`],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.stdout).toBe('done\n');
    expect(result.status).toBe(3);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('command line errors', () => {
  it('print every error in one style ("Error: ...") with exit code 1', () => {
    for (const args of [['bogus'], ['login'], ['login', 'whatsapp', '--method', 'foo'], ['doctor', '--bogus'], ['check', '--max-age', 'abc', 'x.csv']]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toMatch(/^Error: /);
      expect(result.stderr, args.join(' ')).not.toMatch(/^error:/m);
    }
  });

  it('say a missing CSV is not found, in one line, without the system error text', () => {
    const result = run(['check', join(dir, 'nope.csv')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Error: File not found: ${join(dir, 'nope.csv')}`);
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('keep the example out of the phone-number errors (messages are phone-masked: an example would print as "+8490****567")', () => {
    const result = run(['login', 'whatsapp', '--method', 'code', '--phone', '12']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be in international format: "+", the country code, then the number.');
    expect(result.stderr).not.toContain('****');
  });

  it('say how to log in when there are no accounts, for the menu and for the command line', () => {
    const result = run(['accounts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).');
  });
});
