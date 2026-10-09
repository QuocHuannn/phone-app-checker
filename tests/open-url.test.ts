import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openUrl, TELEGRAM_APPS_URL } from '../src/open-url.ts';

interface Call {
  command: string;
  args: string[];
  options: unknown;
}

/** A spawner that records the call and ends the "process" with `exit` (or an error). */
function fakeSpawn(outcome: { exit?: number; error?: Error; throws?: Error } = { exit: 0 }) {
  const calls: Call[] = [];
  let unrefs = 0;
  const spawn = (command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    if (outcome.throws) throw outcome.throws;
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {
      unrefs += 1;
    };
    queueMicrotask(() => {
      if (outcome.error) child.emit('error', outcome.error);
      else child.emit('exit', outcome.exit ?? 0);
    });
    return child as never;
  };
  return { calls, spawn: spawn as never, unrefs: () => unrefs };
}

describe('openUrl', () => {
  it('opens the fixed Telegram address with /usr/bin/open: one argument, no shell, detached, output ignored', async () => {
    const f = fakeSpawn();
    await expect(openUrl(TELEGRAM_APPS_URL, { platform: 'darwin', stdoutIsTTY: true, spawn: f.spawn })).resolves.toBe(true);
    expect(f.calls).toEqual([{ command: '/usr/bin/open', args: ['https://my.telegram.org/apps'], options: { stdio: 'ignore', detached: true } }]);
    expect(f.unrefs()).toBe(1);
  });

  it('never starts anything when stdout is not a terminal (scripts, pipes, cron)', async () => {
    const f = fakeSpawn();
    await expect(openUrl(TELEGRAM_APPS_URL, { platform: 'darwin', stdoutIsTTY: false, spawn: f.spawn })).resolves.toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('never starts anything on another platform', async () => {
    const f = fakeSpawn();
    for (const platform of ['linux', 'win32'] as const) {
      await expect(openUrl(TELEGRAM_APPS_URL, { platform, stdoutIsTTY: true, spawn: f.spawn })).resolves.toBe(false);
    }
    expect(f.calls).toEqual([]);
  });

  it.each([
    'https://evil.example/apps',
    'https://my.telegram.org/apps?x=1',
    'https://my.telegram.org/apps ',
    'http://my.telegram.org/apps',
    'https://my.telegram.org/apps; rm -rf ~',
    '--help',
    '-a Calculator',
    'file:///etc/passwd',
    '',
  ])('refuses any address that is not exactly the fixed one: %j', async (url) => {
    const f = fakeSpawn();
    await expect(openUrl(url, { platform: 'darwin', stdoutIsTTY: true, spawn: f.spawn })).resolves.toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('says false when open fails, errors, or cannot even start', async () => {
    for (const outcome of [{ exit: 1 }, { error: new Error('ENOENT') }, { throws: new Error('EACCES') }]) {
      const f = fakeSpawn(outcome);
      await expect(openUrl(TELEGRAM_APPS_URL, { platform: 'darwin', stdoutIsTTY: true, spawn: f.spawn })).resolves.toBe(false);
    }
  });
});
