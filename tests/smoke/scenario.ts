import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { Store } from '../../src/store.ts';
import {
  RateLimited,
  type Adapter,
  type App,
  type CheckStatus,
  type PhoneNumber,
} from '../../src/types.ts';

/**
 * End-to-end CLI scenario with a deterministic, test-only adapter injected through the CLI's
 * `loadAdapter` seam. Everything else is real: argument parsing, config file, CSV reading,
 * phone normalisation, scheduler, SQLite store, report writer and summary.
 */

export const NOW = Date.UTC(2026, 9, 8, 5, 0, 0);
export const HOUR = 60 * 60 * 1000;

/** Header with accents and a semicolon-free layout; rows exercise every normalisation path. */
export const CSV_V1 = [
  'Họ tên,SĐT,Ghi chú',
  'An,0901234567,vip',
  'An (trùng),090 123 4567,duplicate of the row above',
  'Bình,+65 9123 4567,Singapore',
  'Chi,0084912345678,00 prefix',
  'Dũng,abc,not a number',
  'Em,,empty cell',
  'Phúc,+1 650 253 0000,US',
  '',
].join('\n');

/** Same file plus one new customer, used to prove cached results are reused. */
export const CSV_V2 = `${CSV_V1}Giang,0987654321,new customer\n`;

export interface SmokeResult {
  report1: string;
  report2: string;
  report3: string;
  summary: string;
  accounts: string;
  /** "app:batchSize" per Session.check call, per run. */
  calls: string[][];
  logs: string[];
  stored: Record<string, number>;
  exitCodes: number[];
}

function statusFor(app: App, number: PhoneNumber): CheckStatus {
  const lastDigit = Number(number.e164.slice(-1));
  if (app === 'zalo') return number.e164.includes('90') ? 'yes' : 'not_found';
  return lastDigit % 2 === 1 ? 'yes' : 'not_found';
}

function adapterFor(app: App, record: (call: string) => void, throttleFirstBatch: () => boolean): Adapter {
  return {
    app,
    async login(ctx) {
      writeFileSync(join(ctx.accountDir, 'session.json'), '{}', { mode: 0o600 });
    },
    async open() {
      return {
        async check(batch) {
          record(`${app}:${batch.length}`);
          if (app === 'telegram' && throttleFirstBatch()) {
            throw new RateLimited('FLOOD_WAIT_60', 60_000, new Map());
          }
          return new Map<string, CheckStatus>(batch.map((n) => [n.e164, statusFor(app, n)]));
        },
        async close() {},
      };
    },
  };
}

export async function runSmokeScenario(dir: string): Promise<SmokeResult> {
  const config = join(dir, 'checker.config.json');
  const dataDir = join(dir, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    config,
    JSON.stringify({
      defaultRegion: 'VN',
      dataDir,
      apps: {
        telegram: { enabled: true, batchSize: 2, minIntervalMs: 0, jitterMs: 0 },
        whatsapp: { enabled: false },
        zalo: { enabled: true, batchSize: 1, minIntervalMs: 0, jitterMs: 0 },
      },
    }),
  );
  const csv = join(dir, 'customers.csv');
  const out = join(dir, 'report.csv');

  let clock = NOW;
  let calls: string[] = [];
  const allCalls: string[][] = [];
  const logs: string[] = [];
  const printed: string[] = [];
  const exitCodes: number[] = [];
  let throttleTelegram = false;

  const deps = {
    loadAdapter: async (app: App) =>
      adapterFor(
        app,
        (call) => calls.push(call),
        () => {
          const throttle = throttleTelegram;
          throttleTelegram = false;
          return throttle;
        },
      ),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    random: () => 0,
    log: (message: string) => logs.push(message),
    print: (text: string) => printed.push(text),
    lifecycleDir: join(dir, 'lifecycle'),
  };
  const cli = async (...args: string[]) => {
    exitCodes.push(await main(['node', 'phone-app-checker', '--config', config, ...args], deps));
  };
  const nextRun = () => {
    allCalls.push(calls);
    calls = [];
  };

  // 1. Log in one account per app, then the first full run. Telegram throttles its first batch:
  //    that batch must stay unknown, the account must rest, and the run must resume after the wait.
  await cli('login', 'telegram', '--account', 'tg1');
  await cli('login', 'zalo', '--account', 'z1');
  writeFileSync(csv, CSV_V1);
  throttleTelegram = true;
  await cli('check', csv, '--out', out);
  const report1 = readFileSync(out, 'utf8');
  const summary = printed.at(-1) ?? '';
  nextRun();

  // 2. Same file again: nothing should be checked, the report must be identical.
  await cli('check', csv, '--out', out);
  const report2 = readFileSync(out, 'utf8');
  nextRun();

  // 3. A new customer appears: only that number is checked.
  writeFileSync(csv, CSV_V2);
  await cli('check', csv, '--out', out);
  const report3 = readFileSync(out, 'utf8');
  nextRun();

  // 4. report rebuilds from SQLite without touching any adapter.
  await cli('report', csv, '--out', join(dir, 'rebuilt.csv'));
  nextRun();
  const rebuilt = readFileSync(join(dir, 'rebuilt.csv'), 'utf8');
  if (rebuilt !== report3) throw new Error('report command did not reproduce the check report');

  await cli('accounts');
  const accounts = printed.at(-1) ?? '';

  const store = Store.open(dataDir);
  const stored: Record<string, number> = {};
  try {
    for (const app of ['telegram', 'zalo'] as const) stored[app] = store.allResults(app).size;
  } finally {
    store.close();
  }

  return { report1, report2, report3, summary, accounts, calls: allCalls, logs, stored, exitCodes };
}
