import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePhoneCsv } from '../src/csv.ts';
import { acquireRunLock, LOCK_FILE } from '../src/lock.ts';
import {
  checkReportTarget,
  formatReportCsv,
  REPORT_COLUMNS,
  writeReport,
  type ReportRow,
  ancestorInodeKeys,
  isInsideProtectedDir,
} from '../src/report.ts';
import { Store } from '../src/store.ts';
import { APPS, type App, type Status } from '../src/types.ts';

let base: string;
const stores: Store[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'checker-hardening-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // closed by the test
    }
  }
  rmSync(base, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

function openStore(dataDir: string): Store {
  const store = Store.open(dataDir);
  stores.push(store);
  return store;
}

describe('Store results never lose a definitive answer to unknown', () => {
  it('keeps a previous yes / not_found when a re-check only produces unknown', () => {
    const store = new Store(':memory:');
    stores.push(store);
    const e164 = '+84901234567';
    store.saveResults('telegram', new Map([[e164, 'yes']]), 1);
    store.saveResults('telegram', new Map([[e164, 'unknown']]), 2);
    expect(store.getResult(e164, 'telegram')).toEqual({ status: 'yes', checkedAt: 1 });

    store.saveResults('telegram', new Map([[e164, 'not_found']]), 3);
    expect(store.getResult(e164, 'telegram')).toEqual({ status: 'not_found', checkedAt: 3 });
    store.saveResults('telegram', new Map([[e164, 'unknown']]), 4);
    expect(store.getResult(e164, 'telegram')).toEqual({ status: 'not_found', checkedAt: 3 });
  });

  it('still records unknown for numbers without a definitive answer', () => {
    const store = new Store(':memory:');
    stores.push(store);
    store.saveResults('zalo', new Map([['+84901234567', 'unknown']]), 1);
    store.saveResults('zalo', new Map([['+84901234567', 'unknown']]), 2);
    expect(store.getResult('+84901234567', 'zalo')).toEqual({ status: 'unknown', checkedAt: 2 });
  });
});

describe('Store.open hardening', () => {
  it('refuses a symlinked data directory', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'data');
    symlinkSync(real, link);
    expect(() => Store.open(link)).toThrow(/symbolic link/);
    expect(readdirSync(real)).toEqual([]);
  });

  it('refuses a symlinked database file', () => {
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const target = join(base, 'elsewhere.db');
    writeFileSync(target, '');
    symlinkSync(target, join(dataDir, 'checker.db'));
    expect(() => Store.open(dataDir)).toThrow(/symbolic link/);
    expect(readFileSync(target)).toHaveLength(0);
  });

  it('refuses a symlinked WAL sidecar', () => {
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const target = join(base, 'wal-target');
    writeFileSync(target, '');
    symlinkSync(target, join(dataDir, 'checker.db-wal'));
    expect(() => Store.open(dataDir)).toThrow(/symbolic link/);
  });

  it('repairs a world-readable data directory and database, WAL and SHM included', () => {
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const first = openStore(dataDir);
    first.saveResults('telegram', new Map([['+84901234567', 'yes']]), 1);
    first.close();
    // Simulate files left behind with default permissions.
    chmodSync(join(dataDir, 'checker.db'), 0o644);
    writeFileSync(join(dataDir, 'checker.db-shm'), '', { mode: 0o644 });
    chmodSync(join(dataDir, 'checker.db-shm'), 0o644);
    chmodSync(dataDir, 0o755);

    const second = openStore(dataDir);
    second.saveResults('telegram', new Map([['+84912345678', 'yes']]), 2);
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'checker.db'))).toBe(0o600);
    for (const sidecar of ['checker.db-wal', 'checker.db-shm']) {
      const path = join(dataDir, sidecar);
      if (existsSync(path)) expect(mode(path)).toBe(0o600);
    }
  });

  it('creates the database privately even under a permissive umask', () => {
    const previous = process.umask(0);
    try {
      const dataDir = join(base, 'fresh');
      const store = openStore(dataDir);
      store.saveResults('line', new Map([['+84901234567', 'yes']]), 1);
      expect(mode(dataDir)).toBe(0o700);
      expect(mode(join(dataDir, 'checker.db'))).toBe(0o600);
      for (const sidecar of ['checker.db-wal', 'checker.db-shm']) {
        const path = join(dataDir, sidecar);
        if (existsSync(path)) expect(mode(path)).toBe(0o600);
      }
    } finally {
      process.umask(previous);
    }
  });
});

describe('run lock', () => {
  it('is exclusive, names the owner, and is removed on release', () => {
    const dataDir = join(base, 'lock');
    mkdirSync(dataDir);
    const lock = acquireRunLock(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, LOCK_FILE), 'utf8')).pid).toBe(process.pid);
    expect(mode(join(dataDir, LOCK_FILE))).toBe(0o600);
    expect(() => acquireRunLock(dataDir)).toThrow(new RegExp(`already running \\(pid ${process.pid}`));
    lock.release();
    lock.release();
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(false);
    acquireRunLock(dataDir).release();
  });

  it('recovers a lock whose process is gone', () => {
    const dataDir = join(base, 'stale');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, LOCK_FILE), JSON.stringify({ pid: 424242 }));
    const lock = acquireRunLock(dataDir, { isAlive: () => false });
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('recovers an unreadable lock file but refuses a live owner', () => {
    const dataDir = join(base, 'junk');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, LOCK_FILE), 'not json');
    acquireRunLock(dataDir).release();

    writeFileSync(join(dataDir, LOCK_FILE), JSON.stringify({ pid: 424242 }));
    expect(() => acquireRunLock(dataDir, { isAlive: (pid) => pid === 424242 })).toThrow(/pid 424242/);
  });

  it.each([['{"foo":1}'], ['{"pid":0}'], ['{"pid":-3}'], ['{"pid":1.5}'], ['{"pid":"7"}'], ['null'], ['[]'], ['']])(
    'reclaims a lock whose JSON has no usable pid: %j',
    (content) => {
      const dataDir = join(base, `lock-nopid-${Buffer.from(content).toString('hex')}`);
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, LOCK_FILE), content);
      const lock = acquireRunLock(dataDir, { isAlive: () => true });
      expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid);
      lock.release();
    },
  );

  it('never deletes a lock that another process took over', () => {
    const dataDir = join(base, 'takeover');
    mkdirSync(dataDir);
    const lock = acquireRunLock(dataDir);
    writeFileSync(lock.path, JSON.stringify({ pid: 424242 }));
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });

  it('removes its process exit hook when released', () => {
    const dataDir = join(base, 'hooks');
    mkdirSync(dataDir);
    const before = process.listenerCount('exit');
    const lock = acquireRunLock(dataDir);
    expect(process.listenerCount('exit')).toBe(before + 1);
    lock.release();
    expect(process.listenerCount('exit')).toBe(before);
  });
});

const row = (input: string, e164 = ''): ReportRow => ({
  input,
  e164,
  country: e164 ? 'VN' : '',
  statuses: Object.fromEntries(APPS.map((app) => [app, e164 ? 'yes' : 'invalid'])) as Record<App, Status>,
  observations: {},
  lastCheckedAt: undefined,
});

const REPORT_HEADER = REPORT_COLUMNS.join(',');

describe('report CSV formula escaping', () => {
  it.each([
    ['=HYPERLINK("http://x","y")', "'=HYPERLINK"],
    ['+cmd|calc', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM"],
    ['\t=1', "'\t=1"],
    ['\r=1', "'\r=1"],
    ['  =1+1', "'  =1+1"],
  ])('neutralizes untrusted cell %j', (input, expectedPrefix) => {
    const cells = parse(formatReportCsv([row(input)]), { relax_column_count: true }) as string[][];
    expect(cells[1]?.[0]?.startsWith(expectedPrefix)).toBe(true);
    expect(cells[1]?.[1]).toBe('');
  });

  it('also neutralizes a formula hiding in front of a parseable number', () => {
    const cells = parse(formatReportCsv([row('=+84901234567', '+84901234567')])) as string[][];
    expect(cells[1]?.[0]).toBe("'=+84901234567");
    expect(cells[1]?.[1]).toBe('+84901234567');
  });

  it('keeps valid numbers written with phone characters readable', () => {
    const cells = parse(formatReportCsv([row('+84 90 123 4567', '+84901234567'), row('0901234567', '+84901234567')])) as string[][];
    expect(cells[1]?.[0]).toBe('+84 90 123 4567');
    expect(cells[2]?.[0]).toBe('0901234567');
  });
});

describe('writeReport target safety', () => {
  const rows = [row('0901234567', '+84901234567')];

  it('writes a private file through an unpredictable temp and leaves no temp behind', () => {
    const out = join(base, 'report.csv');
    writeReport(out, rows);
    expect(mode(out)).toBe(0o600);
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe(REPORT_HEADER);
    expect(readdirSync(base)).toEqual(['report.csv']);
  });

  it('never follows or truncates a pre-planted <out>.tmp, symlink or regular file', () => {
    const victim = join(base, 'victim.txt');
    writeFileSync(victim, 'precious');
    const out = join(base, 'report.csv');
    symlinkSync(victim, `${out}.tmp`);
    writeReport(out, rows);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe(REPORT_HEADER);

    const input = join(base, 'customers.csv.tmp');
    writeFileSync(input, 'phone\n0901234567\n');
    writeReport(join(base, 'customers.csv'), rows);
    expect(readFileSync(input, 'utf8')).toBe('phone\n0901234567\n');
  });

  it('refuses the input CSV itself, through a symlink, and through a hard link', () => {
    const input = join(base, 'in.csv');
    writeFileSync(input, 'phone\n0901234567\n');
    const target = { protectedFiles: [input] };
    expect(() => checkReportTarget(input, target)).toThrow(/must differ/);

    symlinkSync(input, join(base, 'sym.csv'));
    expect(() => checkReportTarget(join(base, 'sym.csv'), { ...target, force: true })).toThrow(/must differ/);

    linkSync(input, join(base, 'hard.csv'));
    expect(() => checkReportTarget(join(base, 'hard.csv'), { ...target, force: true })).toThrow(/must differ/);
    expect(() => writeReport(join(base, 'hard.csv'), rows, { ...target, force: true })).toThrow(/must differ/);
    expect(readFileSync(input, 'utf8')).toBe('phone\n0901234567\n');
  });

  it('refuses paths inside the data directory, database hard links and session files', () => {
    const dataDir = join(base, 'data');
    const store = openStore(dataDir);
    store.close();
    mkdirSync(join(dataDir, 'sessions', 'zalo', 'z'), { recursive: true });
    writeFileSync(join(dataDir, 'sessions', 'zalo', 'z', 'cred.json'), '{}');
    const target = { protectedDirs: [dataDir], force: true };

    expect(() => checkReportTarget(join(dataDir, 'checker.db'), target)).toThrow(/data directory/);
    expect(() => checkReportTarget(join(dataDir, 'new.csv'), target)).toThrow(/data directory/);
    expect(() => checkReportTarget(join(dataDir, 'sessions', 'zalo', 'z', 'cred.json'), target)).toThrow(/data directory/);

    linkSync(join(dataDir, 'checker.db'), join(base, 'alias.csv'));
    linkSync(join(dataDir, 'sessions', 'zalo', 'z', 'cred.json'), join(base, 'cred-alias.csv'));
    expect(() => checkReportTarget(join(base, 'alias.csv'), target)).toThrow(/hard link/);
    expect(() => checkReportTarget(join(base, 'cred-alias.csv'), target)).toThrow(/hard link/);

    // A symlinked directory leading into the data dir is resolved too.
    symlinkSync(dataDir, join(base, 'via-link'));
    expect(() => checkReportTarget(join(base, 'via-link', 'x.csv'), target)).toThrow(/data directory/);
  });

  describe('case-variant paths into the data directory', () => {
    const probe = mkdtempSync(join(tmpdir(), 'checker-Case-'));
    const caseInsensitive = existsSync(join(dirname(probe), basename(probe).toUpperCase()));
    rmSync(probe, { recursive: true, force: true });

    it.skipIf(!caseInsensitive)('refuses a case-variant spelling of the data directory, leaf present or absent', () => {
      const dataDir = join(base, 'data');
      openStore(dataDir).close();
      const variant = join(base, 'DATA');
      const target = { protectedDirs: [dataDir], force: true };
      expect(() => checkReportTarget(join(variant, 'new.csv'), target)).toThrow(/data directory/);
      expect(() => checkReportTarget(join(variant, 'CHECKER.DB'), target)).toThrow(/data directory/);
      expect(() => checkReportTarget(join(variant, 'Sessions', 'new', 'report.csv'), target)).toThrow(/data directory/);
      expect(() => writeReport(join(variant, 'new.csv'), rows, target)).toThrow(/data directory/);
      // The protected directory itself may also be named in another case.
      expect(() => checkReportTarget(variant, target)).toThrow(/data directory/);
      expect(() => checkReportTarget(join(base, 'Data-other', 'x.csv'), target)).not.toThrow();
      expect(readdirSync(dataDir).some((name) => name.endsWith('.csv') || name.endsWith('.tmp'))).toBe(false);
    });

    it.skipIf(!caseInsensitive)('refuses a case-variant protected directory spelling too', () => {
      const dataDir = join(base, 'Data');
      openStore(dataDir).close();
      const target = { protectedDirs: [join(base, 'DATA')], force: true };
      expect(() => checkReportTarget(join(dataDir, 'new.csv'), target)).toThrow(/data directory/);
    });
  });

  it('decides containment by inode ancestry, whatever name the path was reached through', () => {
    const dataDir = join(base, 'data');
    mkdirSync(join(dataDir, 'sessions'), { recursive: true });
    const root = realpathSync.native(dataDir);
    // Not canonicalised on purpose: a name that only the inode check can relate to the root.
    symlinkSync(dataDir, join(base, 'alias'));
    expect(isInsideProtectedDir(join(base, 'alias', 'missing', 'x.csv'), root, false)).toBe(true);
    expect(isInsideProtectedDir(join(base, 'alias'), root, false)).toBe(true);
    expect(isInsideProtectedDir(join(base, 'elsewhere', 'x.csv'), root, false)).toBe(false);
    expect(isInsideProtectedDir(join(base, 'data-sibling.csv'), root, false)).toBe(false);

    const keys = ancestorInodeKeys(join(dataDir, 'sessions', 'missing', 'leaf.csv'));
    expect(keys.has(`${statSync(dataDir).dev}:${statSync(dataDir).ino}`)).toBe(true);
    expect(keys.has(`${statSync(join(dataDir, 'sessions')).dev}:${statSync(join(dataDir, 'sessions')).ino}`)).toBe(true);
  });

  it('compares names case-folded only when the directory is absent on a case-insensitive platform', () => {
    const root = join(base, 'not-created-yet');
    expect(isInsideProtectedDir(join(base, 'NOT-CREATED-YET', 'x.csv'), root, true)).toBe(true);
    expect(isInsideProtectedDir(join(base, 'NOT-CREATED-YET'), root, true)).toBe(true);
    expect(isInsideProtectedDir(join(base, 'NOT-CREATED-YET', 'x.csv'), root, false)).toBe(false);
    expect(isInsideProtectedDir(join(base, 'not-created-yet-too', 'x.csv'), root, true)).toBe(false);
    expect(isInsideProtectedDir(join(root, 'x.csv'), root, false)).toBe(true);
  });

  it('does not silently replace an unrelated existing file', () => {
    const out = join(base, 'important.csv');
    writeFileSync(out, 'name,salary\nann,1\n');
    expect(() => writeReport(out, rows)).toThrow(/--force/);
    expect(readFileSync(out, 'utf8')).toBe('name,salary\nann,1\n');

    writeReport(out, rows, { force: true });
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe(REPORT_HEADER);
  });

  it('replaces a previous report and an empty placeholder without --force', () => {
    const out = join(base, 'report.csv');
    writeReport(out, rows);
    writeReport(out, [row('abc')]);
    expect(readFileSync(out, 'utf8')).toContain('abc,,,invalid');

    const empty = join(base, 'empty.csv');
    writeFileSync(empty, '');
    writeReport(empty, rows);
    expect(readFileSync(empty, 'utf8').split('\n')[0]).toBe(REPORT_HEADER);
  });

  it('refuses a symlinked destination unless forced, and never writes through it', () => {
    const victim = join(base, 'victim.csv');
    writeFileSync(victim, `${REPORT_HEADER}\n`);
    const out = join(base, 'report.csv');
    symlinkSync(victim, out);
    expect(() => writeReport(out, rows)).toThrow(/symbolic link/);

    writeReport(out, rows, { force: true });
    expect(readFileSync(victim, 'utf8')).toBe(`${REPORT_HEADER}\n`);
    expect(statSync(out).isFile()).toBe(true);
  });

  it('rejects a directory as the report file', () => {
    const out = join(base, 'dir');
    mkdirSync(out);
    expect(() => writeReport(out, rows, { force: true })).toThrow(/not a regular file/);
  });
});

describe('headerless CSV', () => {
  it('keeps a phone-like but invalid first row as invalid data', () => {
    const parsed = parsePhoneCsv('0901234\n0901234567\n', { defaultRegion: 'VN' });
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.rows).toBe(2);
    expect(parsed.entries.map((e) => [e.input, e.phone?.e164 ?? null])).toEqual([
      ['0901234', null],
      ['0901234567', '+84901234567'],
    ]);
  });

  it('keeps it even when no row is a valid number', () => {
    const parsed = parsePhoneCsv('1234567\n7654321\n', { defaultRegion: 'VN' });
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.entries.map((e) => e.input)).toEqual(['1234567', '7654321']);
  });

  it('still treats a real header as a header', () => {
    const parsed = parsePhoneCsv('name,phone\nAn,0901234567\n', { defaultRegion: 'VN' });
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.rows).toBe(1);
  });
});
