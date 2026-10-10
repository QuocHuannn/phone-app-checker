import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import type { App, CheckStatus } from '../src/types.ts';
import { Prng } from './helpers/prng.ts';

const dirs: string[] = [];
const opened: Store[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checker-store-'));
  dirs.push(dir);
  return dir;
}

function openIn(dataDir: string): Store {
  const store = Store.open(dataDir);
  opened.push(store);
  return store;
}

const mode = (path: string) => statSync(path).mode & 0o777;
const NOT_ROOT = process.getuid?.() !== 0;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('migration', () => {
  it('creates the schema, private modes and WAL mode from nothing', () => {
    const dir = join(tempDir(), 'data');
    const store = openIn(dir);
    expect(userVersion(store.db)).toBe(3);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['accounts', 'failed_checks', 'results']);
    expect((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'checker.db'))).toBe(0o600);
    store.saveResults('telegram', new Map([['+84901234567', 'yes']]), 1);
    for (const sidecar of ['checker.db-wal', 'checker.db-shm']) {
      if (existsSync(join(dir, sidecar))) expect(mode(join(dir, sidecar)), sidecar).toBe(0o600);
    }
  });

  it('upgrades a version-1 database in place and keeps its data', () => {
    const dir = tempDir();
    const path = join(dir, 'checker.db');
    const v1 = new DatabaseSync(path);
    v1.exec(`
      CREATE TABLE results (e164 TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (e164, app));
      CREATE TABLE accounts (app TEXT NOT NULL, name TEXT NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT,
        day TEXT NOT NULL DEFAULT '', used_today INTEGER NOT NULL DEFAULT 0, next_allowed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app, name));
      INSERT INTO results VALUES ('+84901234567', 'zalo', 'yes', 1700000000000);
      INSERT INTO accounts VALUES ('zalo', 'a', 5, 'banned', '2026-10-08', 7, 9);
      PRAGMA user_version = 1;
    `);
    v1.close();
    chmodSync(path, 0o600);

    const store = openIn(dir);
    expect(userVersion(store.db)).toBe(3);
    expect(store.getResult('+84901234567', 'zalo')).toEqual({ status: 'yes', checkedAt: 1700000000000 });
    expect(store.getAccount('zalo', 'a')).toMatchObject({ cooldownUntil: 5, disabledReason: 'banned', usedToday: 7, nextAllowedAt: 9 });
    expect(store.failedChecks('zalo').size).toBe(0);
    store.close();
    // Opening again is a no-op.
    expect(userVersion(openIn(dir).db)).toBe(3);
  });

  it('refuses a database from a newer version without touching it or leaving it locked', () => {
    const dir = tempDir();
    const path = join(dir, 'checker.db');
    const future = new DatabaseSync(path);
    future.exec('CREATE TABLE results (e164 TEXT); INSERT INTO results VALUES (\'x\'); PRAGMA user_version = 99;');
    future.close();
    chmodSync(path, 0o600);
    const before = readFileSync(path);
    expect(() => Store.open(dir)).toThrow(/newer version \(schema 99, supported 3\)/);
    expect(readFileSync(path).equals(before)).toBe(true);
    // The failed open released its handle: another connection can write immediately.
    const other = new DatabaseSync(path);
    other.exec('PRAGMA busy_timeout = 100; INSERT INTO results VALUES (\'y\')');
    other.close();
  });

  it('treats an empty database file as new', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'checker.db'), '', { mode: 0o600 });
    expect(userVersion(openIn(dir).db)).toBe(3);
  });
  it.each([[1], [2]])('opens the committed 0.1.0 fixture database at schema %s and keeps its rows', (schema) => {
    const dir = tempDir();
    const path = join(dir, 'checker.db');
    const seed = fileURLToPath(new URL('./fixtures/v0.1.0/seed-checker-db.mjs', import.meta.url));
    execFileSync(process.execPath, [seed, path, String(schema)]);
    chmodSync(path, 0o600);

    const store = openIn(dir);
    expect(userVersion(store.db)).toBe(3);
    expect(store.getResult('+84901000001', 'telegram')).toEqual({ status: 'yes', checkedAt: 1700000000000 });
    expect(store.getResult('+84902000002', 'whatsapp')).toEqual({ status: 'not_found', checkedAt: 1700000001000 });
    expect(store.getResult('+84903000003', 'zalo')).toEqual({ status: 'unknown', checkedAt: 1700000002000 });
    expect(store.getAccount('telegram', 'main')).toMatchObject({ usedToday: 3, day: '2026-10-01' });
    expect(store.failedChecks('telegram').get('+84904000004')).toBe(schema === 1 ? undefined : 2);
    store.close();
    // Reopening the migrated database is a no-op.
    expect(userVersion(openIn(dir).db)).toBe(3);
  });

  it('upgrades a version-2 database to 3 keeping accounts, with no batch timing until one is measured', () => {
    const dir = tempDir();
    const path = join(dir, 'checker.db');
    const v2 = new DatabaseSync(path);
    v2.exec(`
      CREATE TABLE results (e164 TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (e164, app));
      CREATE TABLE accounts (app TEXT NOT NULL, name TEXT NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT,
        day TEXT NOT NULL DEFAULT '', used_today INTEGER NOT NULL DEFAULT 0, next_allowed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app, name));
      CREATE TABLE failed_checks (e164 TEXT NOT NULL, app TEXT NOT NULL, failures INTEGER NOT NULL, last_failed_at INTEGER NOT NULL, PRIMARY KEY (e164, app));
      INSERT INTO results VALUES ('+84901234567', 'telegram', 'yes', 1700000000000);
      INSERT INTO accounts VALUES ('telegram', 'main', 5, NULL, '2026-10-08', 7, 9);
      PRAGMA user_version = 2;
    `);
    v2.close();
    chmodSync(path, 0o600);

    const store = openIn(dir);
    expect(userVersion(store.db)).toBe(3);
    expect(store.getResult('+84901234567', 'telegram')).toEqual({ status: 'yes', checkedAt: 1700000000000 });
    expect(store.getAccount('telegram', 'main')).toEqual({
      app: 'telegram',
      name: 'main',
      cooldownUntil: 5,
      disabledReason: null,
      day: '2026-10-08',
      usedToday: 7,
      nextAllowedAt: 9,
      lastBatchMs: null,
      avgBatchMs: null,
      batchesDone: 0,
    });
    store.saveAccount({ ...store.getAccount('telegram', 'main'), lastBatchMs: 1200, avgBatchMs: 1500, batchesDone: 4 });
    store.close();
    expect(openIn(dir).getAccount('telegram', 'main')).toMatchObject({ lastBatchMs: 1200, avgBatchMs: 1500, batchesDone: 4, usedToday: 7 });
  });

});

describe('damaged databases', () => {
  function seeded(): { dir: string; path: string } {
    const dir = tempDir();
    const store = Store.open(dir);
    for (let i = 0; i < 3000; i += 1) store.saveResults('telegram', new Map([[`+84900${String(i).padStart(6, '0')}`, 'yes']]), i);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();
    return { dir, path: join(dir, 'checker.db') };
  }

  it.each([
    ['text file', (path: string) => writeFileSync(path, 'this is not a database. '.repeat(200), { mode: 0o600 })],
    ['overwritten header', (path: string) => {
      const bytes = readFileSync(path);
      bytes.fill(0xaa, 0, 100);
      writeFileSync(path, bytes);
    }],
    ['truncated mid-file', (path: string) => truncateSync(path, 5000)],
    ['zeroed pages after the first', (path: string) => {
      const bytes = readFileSync(path);
      bytes.fill(0, 8192, Math.min(bytes.length, 65_536));
      writeFileSync(path, bytes);
    }],
  ])('%s: fails with the file named, leaves it byte-identical and allows a fresh start after moving it aside', (_name, damage) => {
    const { dir, path } = seeded();
    damage(path);
    const before = readFileSync(path);
    let failure = '';
    try {
      const store = Store.open(dir);
      // SQLite may open a file whose damage is in later pages; the first full read must then fail loudly.
      try {
        store.allResults('telegram');
        const check = store.db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
        expect(check.map((row) => row.integrity_check)).not.toEqual(['ok']);
        failure = 'detected by integrity_check';
      } catch (error) {
        failure = (error as Error).message;
      } finally {
        store.close();
      }
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).not.toBe('');
    if (!failure.startsWith('detected') && !/malformed|disk image/.test(failure)) expect(failure).toContain(path);
    if (failure.includes('Cannot open')) {
      expect(failure).toMatch(/left untouched/);
      expect(readFileSync(path).equals(before)).toBe(true);
    }
    // Operator recovery: move the damaged file away and start again.
    renameSync(path, `${path}.damaged`);
    for (const sidecar of ['-wal', '-shm']) rmSync(path + sidecar, { force: true });
    const fresh = openIn(dir);
    expect(fresh.allResults('telegram').size).toBe(0);
    expect(readdirSync(dir)).toContain('checker.db.damaged');
  });
});

describe('filesystem permissions', () => {
  it('repairs loose modes on the directory, the database and its WAL/SHM files', () => {
    const dir = tempDir();
    const first = Store.open(dir);
    first.saveResults('telegram', new Map([['+84901234567', 'yes']]), 1);
    first.close();
    const path = join(dir, 'checker.db');
    chmodSync(dir, 0o777);
    chmodSync(path, 0o666);
    for (const sidecar of ['-wal', '-shm']) {
      const side = path + sidecar;
      if (!existsSync(side)) closeSync(openSync(side, 'w', 0o644));
      chmodSync(side, 0o644);
    }
    const store = openIn(dir);
    expect(store.getResult('+84901234567', 'telegram')?.status).toBe('yes');
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    for (const sidecar of ['-wal', '-shm']) if (existsSync(path + sidecar)) expect(mode(path + sidecar)).toBe(0o600);
  });

  it.runIf(NOT_ROOT)('a data directory that cannot be created fails with the OS reason', () => {
    const parent = tempDir();
    chmodSync(parent, 0o500);
    expect(() => Store.open(join(parent, 'data'))).toThrow(/EACCES/);
  });

  it('refuses a data directory that is a file or a database path that is a directory', () => {
    const base = tempDir();
    writeFileSync(join(base, 'afile'), 'x');
    expect(() => Store.open(join(base, 'afile'))).toThrow(/not a directory/);
    mkdirSync(join(base, 'dd', 'checker.db'), { recursive: true, mode: 0o700 });
    expect(() => Store.open(join(base, 'dd'))).toThrow(/not a regular file/);
  });
});

describe('disk full', () => {
  function fill(store: Store, prefix: string): number {
    let written = 0;
    for (let i = 0; i < 100_000; i += 1) {
      store.saveResults('telegram', new Map([[`${prefix}${i}`, 'yes']]), 1);
      written += 1;
    }
    return written;
  }

  it('reports the real error, rolls back cleanly, keeps earlier data and recovers when space returns', () => {
    const store = openIn(tempDir());
    store.saveResults('telegram', new Map([['+84900000001', 'yes']]), 1);
    store.db.exec('PRAGMA max_page_count = 8');
    let written = 0;
    expect(() => {
      written = fill(store, '+8491');
    }).toThrow(/database or disk is full/);
    // The error that explains the problem is not replaced by "cannot rollback".
    expect(() => store.saveResults('telegram', new Map([['+84900000002', 'yes']]), 2)).toThrow(/full/);
    const integrity = store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    expect(store.getResult('+84900000001', 'telegram')?.status).toBe('yes');

    // A multi-statement transaction that hits the limit leaves none of its rows behind.
    const before = store.allResults('telegram').size;
    expect(() =>
      store.transaction(() => {
        store.saveAccount({ app: 'telegram', name: 'a', cooldownUntil: 0, disabledReason: null, day: '2026-10-08', usedToday: 1, nextAllowedAt: 0, lastBatchMs: null, avgBatchMs: null, batchesDone: 0 });
        fill(store, '+8492');
      }),
    ).toThrow(/full/);
    expect(store.allResults('telegram').size).toBe(before);
    expect(store.getAccount('telegram', 'a').day).toBe('');

    // Space returns: everything works again, including nested transactions.
    store.db.exec('PRAGMA max_page_count = 1000000');
    store.transaction(() => {
      store.saveResults('telegram', new Map([['+84900000003', 'not_found']]), 3);
      store.transaction(() => store.saveResults('telegram', new Map([['+84900000004', 'yes']]), 4));
    });
    expect(store.getResult('+84900000003', 'telegram')?.status).toBe('not_found');
    expect(store.getResult('+84900000004', 'telegram')?.status).toBe('yes');
    expect(written).toBe(0);
  });
});

describe('transactions', () => {
  it('is all-or-nothing, re-entrant, and usable after a failure', () => {
    const store = openIn(tempDir());
    expect(() =>
      store.transaction(() => {
        store.saveResults('zalo', new Map([['+84900000001', 'yes']]), 1);
        store.transaction(() => store.saveResults('zalo', new Map([['+84900000002', 'yes']]), 1));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.allResults('zalo').size).toBe(0);
    // An error from a nested call propagates and rolls the outer transaction back.
    expect(() =>
      store.transaction(() => {
        store.saveResults('zalo', new Map([['+84900000003', 'yes']]), 1);
        store.transaction(() => {
          throw new Error('nested');
        });
      }),
    ).toThrow('nested');
    expect(store.allResults('zalo').size).toBe(0);
    expect(store.transaction(() => 42)).toBe(42);
    expect(store.db.isTransaction).toBe(false);
  });

  it('fails fast and recoverably when another connection holds the write lock', () => {
    const dir = tempDir();
    const store = openIn(dir);
    store.db.exec('PRAGMA busy_timeout = 50');
    const other = new DatabaseSync(join(dir, 'checker.db'));
    other.exec('PRAGMA busy_timeout = 50; BEGIN IMMEDIATE');
    expect(() => store.saveResults('line', new Map([['+84900000001', 'yes']]), 1)).toThrow(/locked|busy/);
    expect(store.db.isTransaction).toBe(false);
    other.exec('ROLLBACK');
    other.close();
    store.saveResults('line', new Map([['+84900000001', 'yes']]), 1);
    expect(store.getResult('+84900000001', 'line')?.status).toBe('yes');
  });

  it('keeps readers consistent while another connection writes (WAL)', () => {
    const dir = tempDir();
    const writer = openIn(dir);
    writer.saveResults('line', new Map([['+84900000001', 'yes']]), 1);
    const reader = new DatabaseSync(join(dir, 'checker.db'), { readOnly: true });
    writer.db.exec("BEGIN IMMEDIATE; INSERT INTO results VALUES ('+84900000002', 'line', 'yes', 2)");
    expect((reader.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number }).n).toBe(1);
    writer.db.exec('COMMIT');
    expect((reader.prepare('SELECT COUNT(*) AS n FROM results').get() as { n: number }).n).toBe(2);
    reader.close();
  });
});

describe('saveResults model check', () => {
  /** The rule in plain words: a definitive answer always replaces; unknown only replaces unknown. */
  it('matches a reference model over 6000 random operations', () => {
    const store = openIn(tempDir());
    const prng = new Prng(99);
    const model = new Map<string, { status: CheckStatus; at: number }>();
    const apps: App[] = ['telegram', 'zalo'];
    const numbers = Array.from({ length: 40 }, (_, i) => `+8490${String(i).padStart(7, '0')}`);
    let clock = 0;
    for (let i = 0; i < 6000; i += 1) {
      const app = prng.pick(apps);
      const batch = new Map<string, CheckStatus>();
      for (let k = prng.range(1, 5); k > 0; k -= 1) batch.set(prng.pick(numbers), prng.pick(['yes', 'not_found', 'unknown'] as const));
      clock += prng.range(0, 3);
      store.saveResults(app, batch, clock);
      for (const [e164, status] of batch) {
        const key = `${app}|${e164}`;
        const current = model.get(key);
        if (current === undefined || status !== 'unknown' || current.status === 'unknown') model.set(key, { status, at: clock });
      }
    }
    for (const app of apps) {
      const stored = store.allResults(app);
      for (const e164 of numbers) {
        const expected = model.get(`${app}|${e164}`);
        expect(stored.get(e164), `${app} ${e164}`).toEqual(expected === undefined ? undefined : { status: expected.status, checkedAt: expected.at });
      }
    }
  });

  it('treats hostile strings as data, never as SQL', () => {
    const store = openIn(tempDir());
    const names = ["'; DROP TABLE results; --", 'a"b', 'ünï©ode 😀', "robert'); DROP TABLE accounts;--", ''];
    for (const name of names) {
      store.saveAccount({ app: 'viber', name, cooldownUntil: 1, disabledReason: name, day: '2026-10-08', usedToday: 2, nextAllowedAt: 3, lastBatchMs: null, avgBatchMs: null, batchesDone: 0 });
      store.saveResults('viber', new Map([[name, 'yes']]), 5);
      expect(store.getAccount('viber', name)).toMatchObject({ name, disabledReason: name, usedToday: 2 });
      expect(store.getResult(name, 'viber')?.status).toBe('yes');
    }
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'results'").get()).toEqual({ n: 1 });
  });

  it('round-trips the largest exact integers', () => {
    const store = openIn(tempDir());
    const big = Number.MAX_SAFE_INTEGER;
    store.saveAccount({ app: 'line', name: 'a', cooldownUntil: big, disabledReason: null, day: 'x', usedToday: big, nextAllowedAt: big, lastBatchMs: null, avgBatchMs: null, batchesDone: 0 });
    expect(store.getAccount('line', 'a')).toMatchObject({ cooldownUntil: big, usedToday: big, nextAllowedAt: big });
    store.saveResults('line', new Map([['+1', 'yes']]), big);
    expect(store.getResult('+1', 'line')?.checkedAt).toBe(big);
  });
});

describe('failed checks', () => {
  it('counts repeated failures per app and clears them when the number is answered, even with unknown', () => {
    const store = openIn(tempDir());
    store.recordFailedChecks('zalo', ['+84900000001', '+84900000002'], 10);
    store.recordFailedChecks('zalo', ['+84900000001'], 20);
    store.recordFailedChecks('line', ['+84900000001'], 30);
    expect([...store.failedChecks('zalo')]).toEqual(expect.arrayContaining([['+84900000001', 2], ['+84900000002', 1]]));
    expect(store.failedChecks('line').get('+84900000001')).toBe(1);
    store.saveResults('zalo', new Map([['+84900000001', 'unknown']]), 40);
    expect(store.failedChecks('zalo').has('+84900000001')).toBe(false);
    expect(store.failedChecks('zalo').get('+84900000002')).toBe(1);
    expect(store.failedChecks('line').get('+84900000001')).toBe(1);
    store.recordFailedChecks('zalo', [], 50);
  });

  it('backs up and restores as a plain file copy (WAL checkpointed)', () => {
    const dir = tempDir();
    const store = openIn(dir);
    store.saveResults('telegram', new Map([['+84900000001', 'yes']]), 1);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copyDir = join(tempDir(), 'copy');
    mkdirSync(copyDir, { mode: 0o700 });
    copyFileSync(join(dir, 'checker.db'), join(copyDir, 'checker.db'));
    chmodSync(join(copyDir, 'checker.db'), 0o600);
    expect(openIn(copyDir).getResult('+84900000001', 'telegram')?.status).toBe('yes');
  });
});
