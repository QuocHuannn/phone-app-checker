// Child process for tests/crash-recovery.test.ts: the real CLI (src/cli.ts main) with a test-only
// adapter injected through the documented `loadAdapter` seam. Everything else is the real code path.
//   argv:  <cli arguments...>
//   env:   CRASH_SENT_LOG  file that receives one "<app> <e164>" line per number handed to a platform
//          CRASH_DELAY_MS  real milliseconds every platform call takes (default 3)
//          CRASH_HOLD_FILE every call from number CRASH_HOLD_AFTER (default 1) on blocks until this file exists,
//                          so a test can interrupt or compete with a run that is certainly still in flight
// Every platform call prints "CALL <n>" on stdout (synchronously) so the parent can time a kill.
import { appendFileSync, existsSync, writeSync } from 'node:fs';
import { main } from '../../src/cli.ts';
import type { Adapter, App } from '../../src/types.ts';
import { truth } from '../helpers/truth.ts';

const sentLog = process.env.CRASH_SENT_LOG;
const delay = Number(process.env.CRASH_DELAY_MS ?? '3');
const holdFile = process.env.CRASH_HOLD_FILE;
const holdAfter = Number(process.env.CRASH_HOLD_AFTER ?? '1');
let calls = 0;

function adapterFor(app: App): Adapter {
  return {
    app,
    async login() {},
    async open() {
      return {
        async check(batch) {
          calls += 1;
          writeSync(1, `CALL ${calls} ${app}\n`);
          if (sentLog !== undefined) appendFileSync(sentLog, batch.map((n) => `${app} ${n.e164}\n`).join(''));
          while (holdFile !== undefined && calls >= holdAfter && !existsSync(holdFile)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          return new Map(batch.map((n) => [n.e164, truth(app, n.e164)]));
        },
        async close() {},
      };
    },
  };
}

const code = await main(['node', 'cli', ...process.argv.slice(2)], { loadAdapter: async (app) => adapterFor(app) });
process.exitCode = code;
