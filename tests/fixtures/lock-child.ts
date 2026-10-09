// Child process for tests/lock-race.test.ts: takes the run lock and reports WIN/LOSE on stdout.
//   argv: <dataDir> <controlDir> <name>
//   env LOCK_PAUSE = "publish" | "guard" | "stale" | "removed" | "observed" (optional)
//     publish  - lock content written to a private temp file, not yet published
//     guard    - this process holds the reclaim guard, stale owner not yet validated
//     stale    - guard held and stale owner validated, unlink not yet done
//     removed  - stale lock unlinked, guard still held
//     observed - an abandoned reclaim guard was seen, the run is about to be refused
// Protocol: prints READY, waits for <control>/go, runs acquireRunLock (pausing at the requested point
// until <control>/<name>.resume exists, after printing PAUSED), prints
// "WIN <pid>" or "LOSE <message>"; a winner keeps the lock until its stdin closes.
import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { acquireRunLock, type LockTestHooks } from '../../src/lock.ts';

const [dataDirArg, controlArg, nameArg] = process.argv.slice(2);
if (dataDirArg === undefined || controlArg === undefined || nameArg === undefined) {
  throw new Error('usage: lock-child <dataDir> <controlDir> <name>');
}
const dataDir: string = dataDirArg;
const control: string = controlArg;
const name: string = nameArg;

function waitFor(file: string): void {
  while (!existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

// Synchronous writes: the event loop is blocked while paused, so console.log could stay queued.
function say(text: string): void {
  writeSync(1, `${text}\n`);
}

function pauseHere(): void {
  say('PAUSED');
  waitFor(join(control, `${name}.resume`));
}

const HOOK_FOR_PAUSE: Record<string, keyof LockTestHooks> = {
  publish: 'beforePublish',
  guard: 'afterGuardAcquired',
  stale: 'afterStaleValidated',
  removed: 'afterStaleRemoved',
  observed: 'afterGuardObserved',
};

const pause = process.env.LOCK_PAUSE;
const hooks: LockTestHooks = {};
if (pause !== undefined) {
  const hook = HOOK_FOR_PAUSE[pause];
  if (hook === undefined) throw new Error(`unknown LOCK_PAUSE ${pause}`);
  hooks[hook] = pauseHere;
}
say('READY');
waitFor(join(control, 'go'));

try {
  const lock = acquireRunLock(dataDir, { testHooks: hooks });
  say(`WIN ${process.pid}`);
  process.stdin.resume();
  process.stdin.on('end', () => {
    lock.release();
    process.exit(0);
  });
} catch (error) {
  say(`LOSE ${(error as Error).message}`);
  process.exit(0);
}
