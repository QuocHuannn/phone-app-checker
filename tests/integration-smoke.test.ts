import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { Store } from '../src/store.ts';
import { APPS, type Adapter, type App, type CheckStatus } from '../src/types.ts';
import { REPORT_HEADER } from './helpers/report-rows.ts';
import { NOW, runSmokeScenario, type SmokeResult } from './smoke/scenario.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-integration-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('CLI end to end (injected test adapter, real everything else)', () => {
  let result: SmokeResult;

  beforeEach(async () => {
    result = await runSmokeScenario(dir);
  });

  it('normalises numbers, merges duplicates and writes invalid rows', () => {
    const lines = result.report1.trimEnd().split('\n');
    expect(lines[0]).toBe(REPORT_HEADER);
    // "0901234567" and "090 123 4567" are one number; the first spelling is kept.
    expect(lines.filter((l) => l.includes('+84901234567'))).toHaveLength(1);
    expect(result.report1).toContain('0084912345678,+84912345678,VN,');
    expect(result.report1).toContain('+65 9123 4567,+6591234567,SG,');
    const invalid = `${APPS.map(() => 'invalid').join(',')},`;
    expect(result.report1).toContain(`abc,,,${invalid}`);
    expect(result.report1).toContain(`\n,,,${invalid}`);
  });

  it('reports skipped for disabled apps and for numbers outside Zalo scope', () => {
    for (const line of result.report1.trimEnd().split('\n').slice(1)) {
      const cells = line.split(',');
      if (cells[1] === '') continue;
      expect(cells.slice(4, 5)).toEqual(['skipped']); // whatsapp disabled
      // viber, line and every later app are disabled in this scenario
      expect(cells.slice(3 + APPS.indexOf('viber'), 3 + APPS.length)).toEqual(APPS.slice(APPS.indexOf('viber')).map(() => 'skipped'));
      if (cells[2] !== 'VN') expect(cells[5]).toBe('skipped'); // zalo is Vietnam only
    }
  });

  it('leaves throttled numbers out of the cache until the account has rested, then completes them', () => {
    // First telegram batch was throttled (FLOOD_WAIT) and retried after the cooldown.
    expect(result.calls[0]?.filter((c) => c.startsWith('telegram'))).toEqual(['telegram:2', 'telegram:2', 'telegram:2']);
    expect(result.report1).not.toMatch(/,unknown,/);
    expect(result.exitCodes.every((code) => code === 0)).toBe(true);
  });

  it('reuses cached answers on a rerun and only checks new numbers on a changed file', () => {
    expect(result.calls[1]).toEqual([]);
    expect(result.report2).toBe(result.report1);
    expect(result.calls[2]?.sort()).toEqual(['telegram:1', 'zalo:1']);
    expect(result.report3).toContain('0987654321,+84987654321,VN,yes,skipped,not_found,skipped,skipped,');
  });

  it('persists every answer in SQLite and rebuilds the report without adapters', () => {
    expect(result.stored).toEqual({ telegram: 5, zalo: 3 });
    expect(result.calls[3]).toEqual([]);
  });

  it('prints a summary with per-app counts and a yes-by-country table', () => {
    expect(result.summary).toContain('Numbers: 6 unique (4 valid, 2 invalid)');
    expect(result.summary).toMatch(/telegram\s+2\s+2\s+0\s+0\s+2/);
    expect(result.summary).toContain('Registered (yes) by country:');
    expect(result.accounts).toMatch(/telegram\s+tg1\s+ready\s+5\/200/);
  });

  it('never writes a full phone number to the logs', () => {
    const text = result.logs.join('\n');
    expect(text).not.toMatch(/\+?84901234567/);
    expect(text).not.toMatch(/6591234567/);
  });
});

describe('interrupting and resuming', () => {
  it('a Ctrl-C finishes the batch, writes a partial report and exits 130; the next run only checks the rest', async () => {
    const config = join(dir, 'config.json');
    const dataDir = join(dir, 'data');
    writeFileSync(
      config,
      JSON.stringify({ dataDir, apps: { telegram: { batchSize: 1, minIntervalMs: 0, jitterMs: 0 }, whatsapp: { enabled: false }, zalo: { enabled: false } } }),
    );
    mkdirSync(join(dataDir, 'sessions', 'telegram', 'tg1'), { recursive: true });
    const csv = join(dir, 'in.csv');
    const out = join(dir, 'out.csv');
    writeFileSync(csv, 'phone\n0901234561\n0901234562\n0901234563\n');

    const seen: string[] = [];
    let interruptAfter = 1;
    const adapter: Adapter = {
      app: 'telegram',
      async login() {},
      async open() {
        return {
          async check(batch) {
            for (const n of batch) seen.push(n.e164);
            if (--interruptAfter === 0) process.emit('SIGINT');
            return new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));
          },
          async close() {},
        };
      },
    };
    const deps = {
      loadAdapter: async (_app: App) => adapter,
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      log: () => {},
      print: () => {},
      lifecycleDir: join(dir, 'lifecycle'),
    };
    const argv = ['node', 'x', '--config', config, 'check', csv, '--out', out, '--apps', 'telegram'];

    expect(await main(argv, deps)).toBe(130);
    expect(seen).toEqual(['+84901234561']);
    const partial = readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(partial[1]).toContain('+84901234561,VN,yes');
    expect(partial[2]).toContain('+84901234562,VN,unknown');
    expect(partial[3]).toContain('+84901234563,VN,unknown');

    process.exitCode = undefined;
    interruptAfter = Infinity;
    expect(await main(argv, deps)).toBe(0);
    expect(seen).toEqual(['+84901234561', '+84901234562', '+84901234563']);
    expect(readFileSync(out, 'utf8')).not.toContain('unknown');

    const store = Store.open(dataDir);
    try {
      expect(store.allResults('telegram').size).toBe(3);
    } finally {
      store.close();
    }
  });
});
