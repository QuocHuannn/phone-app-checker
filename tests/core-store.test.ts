import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localDay, nextLocalMidnight, Store, type AccountState } from '../src/store.ts';
import type { CheckStatus } from '../src/types.ts';

const dirs: string[] = [];
const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.close();
    } catch {
      // closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memory(): Store {
  const store = new Store(':memory:');
  open.push(store);
  return store;
}

const account = (overrides: Partial<AccountState> = {}): AccountState => ({
  app: 'telegram',
  name: 'a',
  cooldownUntil: 0,
  disabledReason: null,
  day: '2026-10-08',
  usedToday: 0,
  nextAllowedAt: 0,
  ...overrides,
});

const results = (entries: [string, CheckStatus][]) => new Map<string, CheckStatus>(entries);

describe('Store results', () => {
  it('upserts results per (number, app)', () => {
    const store = memory();
    store.saveResults('telegram', results([['+84901234567', 'unknown']]), 1);
    store.saveResults('telegram', results([['+84901234567', 'yes']]), 2);
    store.saveResults('whatsapp', results([['+84901234567', 'not_found']]), 3);
    expect(store.getResult('+84901234567', 'telegram')).toEqual({ status: 'yes', checkedAt: 2 });
    expect(store.getResult('+84901234567', 'whatsapp')).toEqual({ status: 'not_found', checkedAt: 3 });
    expect(store.getResult('+84901234567', 'zalo')).toBeUndefined();
    expect([...store.allResults('telegram').keys()]).toEqual(['+84901234567']);
  });

  it('persists across reopen and creates a private data directory and database', () => {
    const base = mkdtempSync(join(tmpdir(), 'checker-store-'));
    dirs.push(base);
    const dataDir = join(base, 'nested', 'data');

    const first = Store.open(dataDir);
    first.saveResults('zalo', results([['+84901234567', 'yes']]), 5);
    first.saveAccount(account({ name: 'z', app: 'zalo', usedToday: 7 }));
    first.close();

    const second = Store.open(dataDir);
    open.push(second);
    expect(second.getResult('+84901234567', 'zalo')).toEqual({ status: 'yes', checkedAt: 5 });
    expect(second.getAccount('zalo', 'z').usedToday).toBe(7);
    expect(statSync(dataDir).mode & 0o077).toBe(0);
    expect(statSync(join(dataDir, 'checker.db')).mode & 0o077).toBe(0);
  });
});

describe('Store transactions', () => {
  it('rolls everything back when the callback throws', () => {
    const store = memory();
    expect(() =>
      store.transaction(() => {
        store.saveResults('telegram', results([['+1', 'yes']]), 1);
        store.saveAccount(account({ usedToday: 9 }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getResult('+1', 'telegram')).toBeUndefined();
    expect(store.getAccount('telegram', 'a').usedToday).toBe(0);
  });

  it('joins nested transactions instead of failing', () => {
    const store = memory();
    store.transaction(() => {
      store.saveResults('telegram', results([['+1', 'yes']]), 1);
      store.transaction(() => store.saveResults('telegram', results([['+2', 'not_found']]), 1));
    });
    expect(store.allResults('telegram').size).toBe(2);
    // a new transaction can start afterwards
    store.transaction(() => store.saveResults('telegram', results([['+3', 'yes']]), 1));
    expect(store.allResults('telegram').size).toBe(3);
  });
});

describe('Store accounts', () => {
  it('returns a blank state for unknown accounts and lists recorded ones in order', () => {
    const store = memory();
    expect(store.getAccount('line', 'x')).toEqual(account({ app: 'line', name: 'x', day: '' }));
    store.saveAccount(account({ app: 'zalo', name: 'b' }));
    store.saveAccount(account({ app: 'telegram', name: 'z' }));
    store.saveAccount(account({ app: 'telegram', name: 'a' }));
    expect(store.listAccounts().map((a) => `${a.app}/${a.name}`)).toEqual(['telegram/a', 'telegram/z', 'zalo/b']);
  });

  it('reset clears cooldown and ban but keeps today\'s usage', () => {
    const store = memory();
    store.saveAccount(account({ cooldownUntil: 99, disabledReason: 'banned', usedToday: 4, nextAllowedAt: 50 }));
    expect(store.resetAccount('telegram', 'a')).toBe(true);
    expect(store.getAccount('telegram', 'a')).toEqual(account({ usedToday: 4 }));
    expect(store.resetAccount('telegram', 'missing')).toBe(false);
  });
});

describe('local calendar helpers', () => {
  it('formats the local day and finds the next local midnight', () => {
    const ms = new Date(2026, 9, 8, 23, 59, 30).getTime();
    expect(localDay(ms)).toBe('2026-10-08');
    expect(nextLocalMidnight(ms)).toBe(new Date(2026, 9, 9, 0, 0, 0).getTime());
    expect(localDay(nextLocalMidnight(ms))).toBe('2026-10-09');
  });
});
