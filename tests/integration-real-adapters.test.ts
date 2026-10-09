import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { APPS } from '../src/types.ts';
import { reportLine } from './helpers/report-rows.ts';

// Runs the five REAL adapters (no injection) against account directories that have no
// credentials. Nothing reaches the network: every adapter must fail closed before connecting,
// with an actionable message, and the run must still produce a complete report.

let dir: string;
const savedEnv = { id: process.env.TELEGRAM_API_ID, hash: process.env.TELEGRAM_API_HASH };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-real-adapters-'));
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv.id !== undefined) process.env.TELEGRAM_API_ID = savedEnv.id;
  if (savedEnv.hash !== undefined) process.env.TELEGRAM_API_HASH = savedEnv.hash;
});

describe('real adapters without credentials', () => {
  it('fail closed with login/setup hints and leave every cell unknown', async () => {
    const dataDir = join(dir, 'data');
    for (const app of APPS) mkdirSync(join(dataDir, 'sessions', app, 'acc'), { recursive: true });
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ dataDir }));
    const csv = join(dir, 'in.csv');
    writeFileSync(csv, 'phone\n0901234567\n');
    const out = join(dir, 'report.csv');
    const logs: string[] = [];

    const code = await main(
      ['node', 'x', '--config', config, 'check', csv, '--out', out, '--apps', APPS.join(','), '--no-wait'],
      { log: (message) => logs.push(message), print: () => {}, lifecycleDir: join(dir, 'lifecycle'), now: () => Date.UTC(2026, 9, 8), sleep: async () => {} },
    );

    expect(code).toBe(0);
    const log = logs.join('\n');
    expect(log).toMatch(/telegram: acc: error.*TELEGRAM_API_ID/);
    // An unlinked WhatsApp account is disabled once with a login hint, not retried as a generic error.
    expect(log).toMatch(/whatsapp: WARNING acc: account disabled.*login whatsapp/);
    expect(log).not.toMatch(/whatsapp: acc: error/);
    expect(log).toMatch(/zalo: acc: error.*login zalo --account acc/);
    expect(log).toMatch(/viber: acc: error.*"registeredQuery" is required/);
    expect(log).toMatch(/line: acc: error.*login line --account acc/);
    expect(log).toMatch(/threema: acc: error.*login threema --account acc/);
    expect(readFileSync(out, 'utf8').split('\n')[1]).toBe(
      reportLine({ input: '0901234567', e164: '+84901234567', country: 'VN', statuses: {}, otherwise: 'unknown' }),
    );
    // Nothing was conclusive: the run must say so loudly instead of looking finished.
    expect(log).toContain('INCOMPLETE');
    expect(log).toContain('no_accounts');
    expect(log).not.toMatch(/remaining \d+ \(done\)/);
    expect(log).not.toContain('+84901234567');
  });
});
