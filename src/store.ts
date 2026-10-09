import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertSafeAppRoot } from './paths.ts';
import type { App, CheckStatus } from './types.ts';

export interface StoredResult {
  status: CheckStatus;
  checkedAt: number;
}

export interface AccountState {
  app: App;
  name: string;
  /** Epoch ms until which the account must rest after rate limiting or an error. */
  cooldownUntil: number;
  /** Set when the account was banned/logged out; cleared by login or account-reset. */
  disabledReason: string | null;
  /** Local calendar day (YYYY-MM-DD) that usedToday refers to. */
  day: string;
  usedToday: number;
  /** Epoch ms before which the next batch must not start (minIntervalMs + jitter). */
  nextAllowedAt: number;
}

const SCHEMA_VERSION = 2;

export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch ms of the next local midnight after `ms`. */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

interface AccountRow {
  app: App;
  name: string;
  cooldown_until: number;
  disabled_reason: string | null;
  day: string;
  used_today: number;
  next_allowed_at: number;
}

function toState(row: AccountRow): AccountState {
  return {
    app: row.app,
    name: row.name,
    cooldownUntil: row.cooldown_until,
    disabledReason: row.disabled_reason,
    day: row.day,
    usedToday: row.used_today,
    nextAllowedAt: row.next_allowed_at,
  };
}

/** Open flag that refuses to follow a symlink in the last path component (POSIX only). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function describeOpenError(path: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new Error(`${path} is a symbolic link or not a directory; refusing to use it. Point dataDir at a real directory.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** SQLite's own wording ("file is not a database") says neither which file nor what to do about it. */
function describeDatabaseError(path: string, error: unknown): Error {
  if ((error as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR') return error instanceof Error ? error : new Error(String(error));
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Cannot open the results database ${path}: ${reason}. The file may be damaged or not a database. ` +
      'It was left untouched: restore a backup, or move it aside to start a new one (earlier results are then not reused).',
    { cause: error },
  );
}

function assertOwnedByUs(path: string, uid: number): void {
  const current = process.getuid?.();
  if (current !== undefined && uid !== current) {
    throw new Error(`${path} is owned by uid ${uid}, not by the current user (${current}); refusing to store customer data there.`);
  }
}

/**
 * Validate (home, shared user folders, installation tree: all refused before anything is written),
 * create when absent and enforce a private, owned data directory. Never follows a symlink.
 */
export function ensureDataDirectory(dir: string): void {
  assertSafeAppRoot(dir, 'data directory');
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    throw describeOpenError(dir, error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
    assertOwnedByUs(dir, stat.uid);
    if ((stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Make `path` a private (0600), owned regular file: created exclusively before SQLite touches it,
 * repaired when it already exists. Never follows a symlink. `create: false` leaves absent files alone.
 */
function ensurePrivateFile(path: string, create: boolean): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (!create) return;
      try {
        closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600));
      } catch (createError) {
        throw describeOpenError(path, createError);
      }
      return;
    }
    throw describeOpenError(path, error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    assertOwnedByUs(path, stat.uid);
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      // Looked at before anything is written: switching the journal mode already rewrites the file
      // header, which a database from a newer version must not see.
      this.assertSupportedVersion();
      this.db.exec('PRAGMA journal_mode = WAL');
      this.migrate();
    } catch (error) {
      // Do not leave a handle (and its file locks) behind when the file is unusable.
      this.db.close();
      throw error;
    }
  }

  /**
   * Open <dataDir>/checker.db. The data directory must be a real directory owned by the current
   * user (created 0700 when absent, repaired to 0700 otherwise); the database and its WAL/SHM
   * files are kept 0600, and symlinks are refused.
   */
  static open(dataDir: string): Store {
    ensureDataDirectory(dataDir);
    const path = join(dataDir, 'checker.db');
    ensurePrivateFile(path, true);
    for (const suffix of SIDECAR_SUFFIXES) ensurePrivateFile(path + suffix, false);
    let store: Store;
    try {
      store = new Store(path);
    } catch (error) {
      throw describeDatabaseError(path, error);
    }
    try {
      for (const suffix of SIDECAR_SUFFIXES) ensurePrivateFile(path + suffix, false);
      chmodSync(path, 0o600);
    } catch (error) {
      store.close();
      throw error;
    }
    return store;
  }

  private schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    return row?.user_version ?? 0;
  }

  private assertSupportedVersion(): void {
    const version = this.schemaVersion();
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database was written by a newer version (schema ${version}, supported ${SCHEMA_VERSION})`);
    }
  }

  private migrate(): void {
    if (this.schemaVersion() === SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        e164 TEXT NOT NULL,
        app TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (e164, app)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        app TEXT NOT NULL,
        name TEXT NOT NULL,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        day TEXT NOT NULL DEFAULT '',
        used_today INTEGER NOT NULL DEFAULT 0,
        next_allowed_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app, name)
      );
      CREATE TABLE IF NOT EXISTS failed_checks (
        e164 TEXT NOT NULL,
        app TEXT NOT NULL,
        failures INTEGER NOT NULL,
        last_failed_at INTEGER NOT NULL,
        PRIMARY KEY (e164, app)
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  /** Run `fn` atomically. Re-entrant: nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      // SQLite has already rolled back on some errors (database or disk full); a failing ROLLBACK
      // must not replace the error that explains what went wrong.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  /** Every stored result of one app, keyed by E.164. */
  allResults(app: App): Map<string, StoredResult> {
    const rows = this.db.prepare('SELECT e164, status, checked_at FROM results WHERE app = ?').all(app) as unknown as {
      e164: string;
      status: CheckStatus;
      checked_at: number;
    }[];
    const map = new Map<string, StoredResult>();
    for (const row of rows) map.set(row.e164, { status: row.status, checkedAt: row.checked_at });
    return map;
  }

  getResult(e164: string, app: App): StoredResult | undefined {
    const row = this.db
      .prepare('SELECT status, checked_at FROM results WHERE e164 = ? AND app = ?')
      .get(e164, app) as unknown as { status: CheckStatus; checked_at: number } | undefined;
    return row ? { status: row.status, checkedAt: row.checked_at } : undefined;
  }

  /** Upsert a batch of results in one transaction. */
  saveResults(app: App, results: Map<string, CheckStatus>, checkedAt: number): void {
    if (results.size === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO results (e164, app, status, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (e164, app) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at
       WHERE excluded.status <> 'unknown' OR results.status = 'unknown'`,
    );
    const answered = this.db.prepare('DELETE FROM failed_checks WHERE e164 = ? AND app = ?');
    this.transaction(() => {
      for (const [e164, status] of results) {
        stmt.run(e164, app, status, checkedAt);
        // Any answer, even `unknown`, proves the number itself does not break the check.
        answered.run(e164, app);
      }
    });
  }

  /**
   * Numbers whose batch failed with an unexpected error in an earlier check and that have not been
   * answered since, with how many times that happened. The scheduler checks them last and one by
   * one, so a number the platform keeps rejecting cannot block, or take its neighbours down with it.
   */
  failedChecks(app: App): Map<string, number> {
    const rows = this.db.prepare('SELECT e164, failures FROM failed_checks WHERE app = ?').all(app) as unknown as {
      e164: string;
      failures: number;
    }[];
    return new Map(rows.map((row) => [row.e164, row.failures]));
  }

  recordFailedChecks(app: App, e164s: Iterable<string>, failedAt: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO failed_checks (e164, app, failures, last_failed_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (e164, app) DO UPDATE SET failures = failures + 1, last_failed_at = excluded.last_failed_at`,
    );
    this.transaction(() => {
      for (const e164 of e164s) stmt.run(e164, app, failedAt);
    });
  }

  getAccount(app: App, name: string): AccountState {
    const row = this.db
      .prepare(
        `SELECT app, name, cooldown_until, disabled_reason, day, used_today, next_allowed_at
         FROM accounts WHERE app = ? AND name = ?`,
      )
      .get(app, name) as unknown as AccountRow | undefined;
    if (!row) {
      return { app, name, cooldownUntil: 0, disabledReason: null, day: '', usedToday: 0, nextAllowedAt: 0 };
    }
    return toState(row);
  }

  /** All accounts that have state recorded, ordered by app then name. */
  listAccounts(): AccountState[] {
    const rows = this.db
      .prepare(
        `SELECT app, name, cooldown_until, disabled_reason, day, used_today, next_allowed_at
         FROM accounts ORDER BY app, name`,
      )
      .all() as unknown as AccountRow[];
    return rows.map(toState);
  }

  saveAccount(state: AccountState): void {
    this.db
      .prepare(
        `INSERT INTO accounts (app, name, cooldown_until, disabled_reason, day, used_today, next_allowed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (app, name) DO UPDATE SET cooldown_until = excluded.cooldown_until,
           disabled_reason = excluded.disabled_reason, day = excluded.day,
           used_today = excluded.used_today, next_allowed_at = excluded.next_allowed_at`,
      )
      .run(
        state.app,
        state.name,
        state.cooldownUntil,
        state.disabledReason,
        state.day,
        state.usedToday,
        state.nextAllowedAt,
      );
  }

  /**
   * Clear cooldown, ban flag and pacing delay. Today's usage is kept so resetting
   * cannot be used to bypass the daily cap.
   */
  resetAccount(app: App, name: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE accounts SET cooldown_until = 0, disabled_reason = NULL, next_allowed_at = 0
         WHERE app = ? AND name = ?`,
      )
      .run(app, name);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
