import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { Adb, AdbError, isTransientAdbError, sqlQuote } from '../android/adb.ts';
import {
  AccountBanned,
  RateLimited,
  maskPhone,
  type Adapter,
  type AdapterContext,
  type CheckStatus,
  type PhoneNumber,
  type Session,
} from '../types.ts';

/**
 * Viber check via the contact-sync mechanism of the real Viber app on Android:
 * inject contacts under a dedicated account, let Viber sync them, read which ones Viber
 * marked as registered from its own database, then delete the injected contacts.
 *
 * Nothing is ever sent or called. The Viber DB schema is NOT hard-coded: the user supplies
 * read-only SELECT queries (found with scripts/viber-discover-schema.sh, see
 * docs/viber-setup.md) and this adapter validates them against the device's databases and
 * fails closed when they are missing, invalid, or match more than one database.
 */

const VIBER_PACKAGE = 'com.viber.voip';
const DATA_DIR = `/data/data/${VIBER_PACKAGE}`;
const DEVICE_FILE = 'viber-device.json';

const RAW_CONTACTS_URI = 'content://com.android.contacts/raw_contacts';
/** caller_is_syncadapter makes ContactsProvider hard-delete instead of flagging rows deleted. */
const RAW_CONTACTS_HARD_DELETE_URI = `${RAW_CONTACTS_URI}?caller_is_syncadapter=true`;
const DATA_URI = 'content://com.android.contacts/data';
const MIME_PHONE = 'vnd.android.cursor.item/phone_v2';
const MIME_NAME = 'vnd.android.cursor.item/name';
const PHONE_TYPE_MOBILE = 2;

const E164 = /^\+[1-9]\d{6,14}$/;
const SQLITE_MAGIC = 'SQLite format 3\0';
/** Account identifiers must not be able to touch real accounts. */
const ACCOUNT_ID = /^[A-Za-z0-9._-]{3,64}$/;
const FORBIDDEN_ACCOUNT_TYPE = /^(com\.(google|android|viber|whatsapp|samsung|microsoft|apple)|org\.)/i;

const DOC_HINT = 'See docs/viber-setup.md and run scripts/viber-discover-schema.sh.';
const LOGGED_OUT_MESSAGE =
  'Viber authQuery returned no rows: the app appears to be logged out or deactivated. Re-activate it manually, then run login again.';

interface ViberOptions {
  adbPath?: string;
  serial?: string;
  /** Absolute device path of the Viber SQLite DB. When unset it is discovered and must be unambiguous. */
  dbPath?: string;
  /** SELECT returning one column `number`: numbers Viber marks as registered Viber users. */
  registeredQuery: string;
  /** SELECT returning one column `number`: every number Viber has ingested from the phonebook. */
  syncedQuery: string;
  /** SELECT returning >=1 row (any columns) only while the app is activated / logged in. */
  authQuery: string;
  contactAccountName: string;
  contactAccountType: string;
  syncTimeoutMs: number;
  pollIntervalMs: number;
  /** Never conclude before this long after injection. */
  minWaitMs: number;
  /** Consecutive polls with an unchanged registered set required before concluding. */
  stablePolls: number;
  /** Bring Viber to the foreground after injection. */
  foreground: boolean;
}

interface SavedDevice {
  serial: string;
  dbPath: string;
  versionName?: string;
  verifiedAt: string;
}

interface Snapshot {
  /** Digits-only numbers Viber marked as registered. */
  registered: Set<string>;
  /** Digits-only numbers Viber ingested from the phonebook. */
  synced: Set<string>;
  authenticated: boolean;
}

interface QuerySet {
  registered: string;
  synced: string;
  auth: string;
}

// ---------------------------------------------------------------- options

function optString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Viber option "${key}" must be a string`);
  return value;
}

function optNumber(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Viber option "${key}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Only a single read-only statement is accepted; the DB copy is also opened with query_only. */
function readOnlyQuery(key: string, raw: Record<string, unknown>): string {
  const value = optString(raw, key);
  if (!value) {
    throw new Error(
      `Viber option "${key}" is required: the Viber DB schema differs between app versions and is not hard-coded. ${DOC_HINT}`,
    );
  }
  const sql = value.trim().replace(/;\s*$/, '');
  if (sql.includes(';')) throw new Error(`Viber option "${key}" must be a single SELECT statement`);
  if (!/^(select|with)\b/i.test(sql)) throw new Error(`Viber option "${key}" must start with SELECT or WITH`);
  return sql;
}

function parseOptions(raw: Record<string, unknown>): ViberOptions {
  const contactAccountName = optString(raw, 'contactAccountName') ?? 'phone-app-checker';
  const contactAccountType = optString(raw, 'contactAccountType') ?? 'phone-app-checker.local';
  if (!ACCOUNT_ID.test(contactAccountName)) {
    throw new Error('Viber option "contactAccountName" must match [A-Za-z0-9._-]{3,64}');
  }
  if (!ACCOUNT_ID.test(contactAccountType) || FORBIDDEN_ACCOUNT_TYPE.test(contactAccountType)) {
    throw new Error(
      'Viber option "contactAccountType" must match [A-Za-z0-9._-]{3,64} and must not be a real account type (com.google, com.android.*, com.viber.*, ...)',
    );
  }
  const dbPath = optString(raw, 'dbPath');
  if (dbPath !== undefined && !dbPath.startsWith('/')) {
    throw new Error('Viber option "dbPath" must be an absolute device path');
  }
  const adbPath = optString(raw, 'adbPath');
  const serial = optString(raw, 'serial');
  const foreground = raw['foreground'];
  if (foreground !== undefined && typeof foreground !== 'boolean') {
    throw new Error('Viber option "foreground" must be a boolean');
  }
  return {
    ...(adbPath !== undefined && { adbPath }),
    ...(serial !== undefined && { serial }),
    ...(dbPath !== undefined && { dbPath }),
    registeredQuery: readOnlyQuery('registeredQuery', raw),
    syncedQuery: readOnlyQuery('syncedQuery', raw),
    authQuery: readOnlyQuery('authQuery', raw),
    contactAccountName,
    contactAccountType,
    syncTimeoutMs: optNumber(raw, 'syncTimeoutMs', 180_000, 10_000, 3_600_000),
    pollIntervalMs: optNumber(raw, 'pollIntervalMs', 5_000, 1_000, 120_000),
    minWaitMs: optNumber(raw, 'minWaitMs', 15_000, 0, 600_000),
    stablePolls: optNumber(raw, 'stablePolls', 2, 1, 20),
    foreground: foreground ?? true,
  };
}

// ---------------------------------------------------------------- DB inspection

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Pull the main DB file and its -wal (which holds recent writes) to a local scratch path through
 * ONE root tar stream, so both come from the same read boundary. Returns false when the DB is absent.
 */
async function pullDatabase(adb: Adb, remote: string, local: string): Promise<boolean> {
  const name = posix.basename(remote);
  const files = await adb.readFileSet(posix.dirname(remote), [name, `${name}-wal`]);
  const main = files.get(name);
  if (!main) return false;
  await rm(`${local}-wal`, { force: true });
  await writeFile(local, main, { mode: 0o600 });
  const wal = files.get(`${name}-wal`);
  if (wal && wal.length > 0) await writeFile(`${local}-wal`, wal, { mode: 0o600 });
  return true;
}

/**
 * Even from one archive, Viber may checkpoint while the tar reads: the copy then fails to open or
 * query as "malformed". That is a torn read, not a schema problem, so it is retried and, if it
 * persists, surfaces as a transient adb error (the scheduler cools the account down and retries).
 */
const TORN_DB_ERROR = /malformed|disk image|not a database|file is encrypted|corrupt/i;
const SNAPSHOT_ATTEMPTS = 3;

class TornSnapshotError extends AdbError {
  constructor(detail: string) {
    super('disconnected', `Viber database snapshot was inconsistent (${detail}); it will be retried`);
    this.name = 'TornSnapshotError';
  }
}

async function withTornRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TornSnapshotError) || attempt >= SNAPSHOT_ATTEMPTS) throw error;
      await sleep(500);
    }
  }
}

function openCopy(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA query_only = ON');
  return db;
}

/** Check that the queries compile against this DB and have the agreed column shape. */
function verifyQueries(db: DatabaseSync, queries: QuerySet): string | undefined {
  const shapes: Array<[string, string, boolean]> = [
    ['registeredQuery', queries.registered, true],
    ['syncedQuery', queries.synced, true],
    ['authQuery', queries.auth, false],
  ];
  for (const [label, sql, needNumber] of shapes) {
    let columns: string[];
    try {
      columns = db
        .prepare(sql)
        .columns()
        .map((c) => c.name);
    } catch (error) {
      return `${label} does not compile: ${(error as Error).message}`;
    }
    if (needNumber && !(columns.length === 1 && columns[0] === 'number')) {
      return `${label} must return exactly one column named "number" (got: ${columns.join(', ') || 'none'})`;
    }
    if (!needNumber && columns.length === 0) return `${label} returns no columns`;
  }
  return undefined;
}

function numberSet(db: DatabaseSync, sql: string): Set<string> {
  const set = new Set<string>();
  for (const row of db.prepare(sql).all()) {
    const value = row['number'];
    if (value === null || value === undefined) continue;
    const d = digits(String(value));
    if (d) set.add(d);
  }
  return set;
}

function readSnapshot(db: DatabaseSync, queries: QuerySet): Snapshot {
  return {
    registered: numberSet(db, queries.registered),
    synced: numberSet(db, queries.synced),
    authenticated: db.prepare(queries.auth).get() !== undefined,
  };
}

type Pulled = { snapshot: Snapshot } | { missing: true } | { problem: string };

/** Pull a consistent copy of the Viber DB (+WAL) into a scratch dir under `parentDir` and read it. */
function pullAndRead(adb: Adb, remote: string, parentDir: string, queries: QuerySet): Promise<Pulled> {
  return withTornRetry(async (): Promise<Pulled> => {
    const dir = await mkdtemp(join(parentDir, 'snap-'));
    try {
      const local = join(dir, 'viber.db');
      if (!(await pullDatabase(adb, remote, local))) return { missing: true };
      let db: DatabaseSync;
      try {
        db = openCopy(local);
      } catch (error) {
        throw new TornSnapshotError((error as Error).message);
      }
      try {
        const problem = verifyQueries(db, queries);
        if (problem !== undefined) {
          if (TORN_DB_ERROR.test(problem)) throw new TornSnapshotError(problem);
          return { problem };
        }
        try {
          return { snapshot: readSnapshot(db, queries) };
        } catch (error) {
          if (TORN_DB_ERROR.test((error as Error).message)) throw new TornSnapshotError((error as Error).message);
          throw error;
        }
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** Why `remote` is not a usable Viber DB for these queries, or undefined when it is usable. */
async function validateDatabase(adb: Adb, remote: string, workDir: string, queries: QuerySet): Promise<string | undefined> {
  return withTornRetry(() => validateOnce(adb, remote, workDir, queries));
}

async function validateOnce(adb: Adb, remote: string, workDir: string, queries: QuerySet): Promise<string | undefined> {
  const local = join(workDir, 'candidate.db');
  if (!(await pullDatabase(adb, remote, local))) return 'file not found';
  const file = await open(local);
  let header: string;
  try {
    const { bytesRead, buffer } = await file.read(Buffer.alloc(SQLITE_MAGIC.length), 0, SQLITE_MAGIC.length, 0);
    header = buffer.toString('latin1', 0, bytesRead);
  } finally {
    await file.close();
  }
  if (header !== SQLITE_MAGIC) return 'not a plain SQLite file (encrypted or not a database)';
  let db: DatabaseSync;
  try {
    db = openCopy(local);
  } catch (error) {
    if (TORN_DB_ERROR.test((error as Error).message)) throw new TornSnapshotError((error as Error).message);
    return `cannot open: ${(error as Error).message}`;
  }
  try {
    const problem = verifyQueries(db, queries);
    if (problem !== undefined && TORN_DB_ERROR.test(problem)) throw new TornSnapshotError(problem);
    return problem;
  } finally {
    db.close();
  }
}

/** Find the single Viber database in which all configured queries are valid. */
async function discoverDatabase(adb: Adb, workDir: string, queries: QuerySet): Promise<string> {
  const dir = `${DATA_DIR}/databases`;
  const names = (await adb.listDir(dir)).filter((n) => !/-(journal|wal|shm)$/.test(n));
  if (names.length === 0) {
    throw new Error(`No databases found in ${dir} on ${adb.serial}. Is Viber activated (opened past the welcome screens)?`);
  }
  const matches: string[] = [];
  const rejected: string[] = [];
  for (const name of names) {
    const reason = await validateDatabase(adb, `${dir}/${name}`, workDir, queries);
    if (reason === undefined) matches.push(`${dir}/${name}`);
    else rejected.push(`${name}: ${reason}`);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `None of the Viber databases accepts the configured queries (this app version may use a different schema).\n  ${rejected.join('\n  ')}\n${DOC_HINT}`,
    );
  }
  throw new Error(
    `Ambiguous: the configured queries are valid in ${matches.length} databases (${matches.join(', ')}). Set the Viber option "dbPath" to the right one, or tighten the queries.`,
  );
}

// ---------------------------------------------------------------- saved device state

async function loadSaved(accountDir: string): Promise<SavedDevice | undefined> {
  let text: string;
  try {
    text = await readFile(join(accountDir, DEVICE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as SavedDevice).serial === 'string' &&
    typeof (data as SavedDevice).dbPath === 'string'
  ) {
    return data as SavedDevice;
  }
  throw new Error(`${join(accountDir, DEVICE_FILE)} is malformed; delete it and run login again`);
}

// ---------------------------------------------------------------- connection shared by login/open

interface Connection {
  adb: Adb;
  opts: ViberOptions;
  queries: QuerySet;
  dbPath: string;
  snapshot: Snapshot;
  versionName: string | undefined;
}

async function connect(ctx: AdapterContext): Promise<Connection> {
  const opts = parseOptions(ctx.options);
  const queries: QuerySet = { registered: opts.registeredQuery, synced: opts.syncedQuery, auth: opts.authQuery };
  const saved = await loadSaved(ctx.accountDir);

  const serial = opts.serial ?? saved?.serial;
  const adb = await Adb.connect({
    ...(opts.adbPath !== undefined && { adbPath: opts.adbPath }),
    ...(serial !== undefined && { serial }),
  });
  const info = await adb.packageInfo(VIBER_PACKAGE);
  if (!info.installed) {
    throw new Error(`${VIBER_PACKAGE} is not installed on ${adb.serial}. Install the pinned Viber APK first. ${DOC_HINT}`);
  }
  if (saved?.versionName && info.versionName && saved.versionName !== info.versionName) {
    ctx.log(`viber: app version changed ${saved.versionName} -> ${info.versionName}; re-validating DB queries`);
  }
  await adb.ensureRoot();

  const workDir = await mkdtemp(join(ctx.accountDir, 'probe-'));
  try {
    let dbPath: string | undefined;
    const pinned = opts.dbPath ?? saved?.dbPath;
    if (pinned) {
      const reason = await validateDatabase(adb, pinned, workDir, queries);
      if (reason === undefined) dbPath = pinned;
      else if (opts.dbPath) throw new Error(`Configured Viber dbPath ${pinned} is unusable: ${reason}`);
      else ctx.log(`viber: saved DB ${pinned} no longer valid (${reason}); rediscovering`);
    }
    dbPath ??= await discoverDatabase(adb, workDir, queries);

    const pulled = await pullAndRead(adb, dbPath, workDir, queries);
    if ('missing' in pulled) throw new Error(`Viber database ${dbPath} disappeared`);
    if ('problem' in pulled) throw new Error(`Viber DB queries are no longer valid: ${pulled.problem}`);
    return { adb, opts, queries, dbPath, snapshot: pulled.snapshot, versionName: info.versionName };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- adapter

class ViberSession implements Session {
  private readonly adb: Adb;
  private readonly opts: ViberOptions;
  private readonly queries: QuerySet;
  private readonly dbPath: string;
  private readonly ctx: AdapterContext;

  constructor(conn: Connection, ctx: AdapterContext) {
    this.adb = conn.adb;
    this.opts = conn.opts;
    this.queries = conn.queries;
    this.dbPath = conn.dbPath;
    this.ctx = ctx;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const partial = new Map<string, CheckStatus>();
    const valid = [...new Set(numbers.map((n) => n.e164).filter((e) => E164.test(e)))];
    if (valid.length === 0) return partial;

    let failure: unknown;
    let timedOut = false;
    try {
      timedOut = await this.runBatch(valid, partial);
    } catch (error) {
      failure = error;
    }

    // Always remove what we injected, whatever happened above.
    let cleanupFailure: unknown;
    try {
      await this.cleanup();
    } catch (error) {
      cleanupFailure = error;
    }

    if (failure !== undefined) {
      if (cleanupFailure !== undefined) {
        this.ctx.log(`viber: cleanup also failed (${(cleanupFailure as Error).message}); next run will retry it`);
      }
      throw this.mapFailure(failure, partial);
    }
    if (cleanupFailure !== undefined) {
      throw new RateLimited(
        `Viber contact cleanup failed, results kept: ${(cleanupFailure as Error).message}`,
        this.ctx.pacing.errorCooldownMs,
        partial,
      );
    }
    if (timedOut) {
      this.ctx.log(`viber: sync did not settle within ${this.opts.syncTimeoutMs} ms (${partial.size}/${valid.length} resolved)`);
      throw new RateLimited(
        `Viber contact sync did not settle within ${this.opts.syncTimeoutMs} ms`,
        this.ctx.pacing.rateLimitCooldownMs,
        partial,
      );
    }
    return partial;
  }

  async close(): Promise<void> {
    try {
      await this.cleanup();
    } catch (error) {
      this.ctx.log(`viber: cleanup on close failed: ${(error as Error).message}`);
    }
  }

  /** Returns true when the sync wait timed out before results settled. */
  private async runBatch(numbers: string[], partial: Map<string, CheckStatus>): Promise<boolean> {
    await this.adb.ping();
    await this.snapshot(); // throws AccountBanned when Viber is logged out
    await this.cleanup(); // leftovers from an interrupted run would pollute the synced set

    const tag = `pac-${randomUUID().slice(0, 8)}`;
    this.ctx.log(`viber: injecting ${numbers.length} contacts (${maskPhone(numbers[0]!)} ...)`);
    await this.inject(numbers, tag);
    if (this.opts.foreground) await this.adb.launch(VIBER_PACKAGE);

    const started = Date.now();
    let previous: string | undefined;
    let stable = 0;
    for (;;) {
      await sleep(this.opts.pollIntervalMs);
      const snap = await this.snapshot();

      const key = numbers.filter((n) => snap.registered.has(digits(n))).join(',');
      stable = key === previous ? stable + 1 : 0;
      previous = key;
      const settled = stable >= this.opts.stablePolls;

      partial.clear();
      let allIngested = true;
      for (const n of numbers) {
        const d = digits(n);
        if (snap.registered.has(d)) partial.set(n, 'yes');
        else if (snap.synced.has(d)) {
          // Ingested but not marked registered: only trustworthy once the registered set stopped changing.
          if (settled) partial.set(n, 'not_found');
        } else allIngested = false;
      }

      const elapsed = Date.now() - started;
      if (allIngested && settled && elapsed >= this.opts.minWaitMs) return false;
      if (elapsed >= this.opts.syncTimeoutMs) return true;
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const pulled = await pullAndRead(this.adb, this.dbPath, this.ctx.accountDir, this.queries);
    if ('missing' in pulled) {
      throw new AccountBanned(
        `Viber database ${this.dbPath} is gone: the app was probably logged out, reset, or reinstalled. Re-activate Viber, then run login again.`,
      );
    }
    if ('problem' in pulled) {
      throw new Error(`Viber DB schema no longer matches the configured queries (app updated?): ${pulled.problem}. ${DOC_HINT}`);
    }
    if (!pulled.snapshot.authenticated) throw new AccountBanned(LOGGED_OUT_MESSAGE);
    return pulled.snapshot;
  }

  private scope(): string {
    return `account_name=${sqlQuote(this.opts.contactAccountName)} AND account_type=${sqlQuote(this.opts.contactAccountType)}`;
  }

  private async inject(numbers: string[], tag: string): Promise<void> {
    const { contactAccountName: accountName, contactAccountType: accountType } = this.opts;

    await this.adb.script(
      numbers.map((_, i) =>
        Adb.contentInsertCommand(RAW_CONTACTS_URI, [
          { name: 'account_type', type: 's', value: accountType },
          { name: 'account_name', type: 's', value: accountName },
          { name: 'sourceid', type: 's', value: `${tag}-${i}` },
        ]),
      ),
    );

    const rows = await this.adb.contentQuery(RAW_CONTACTS_URI, ['_id', 'sourceid'], `${this.scope()} AND sourceid LIKE ${sqlQuote(`${tag}-%`)}`);
    const rawIds = new Map<number, string>();
    for (const row of rows) {
      const index = /-(\d+)$/.exec(row['sourceid'] ?? '')?.[1];
      const id = row['_id'];
      if (index !== undefined && id !== null && id !== undefined && /^\d+$/.test(id)) rawIds.set(Number(index), id);
    }
    if (rawIds.size !== numbers.length) {
      throw new AdbError('command-failed', `Android accepted ${rawIds.size} of ${numbers.length} raw contacts; contacts provider may be rejecting the injected account`);
    }

    const dataCommands: string[] = [];
    numbers.forEach((number, i) => {
      const rawId = rawIds.get(i)!;
      dataCommands.push(
        Adb.contentInsertCommand(DATA_URI, [
          { name: 'raw_contact_id', type: 'i', value: rawId },
          { name: 'mimetype', type: 's', value: MIME_NAME },
          { name: 'data1', type: 's', value: `PAC ${tag} ${i}` },
        ]),
        Adb.contentInsertCommand(DATA_URI, [
          { name: 'raw_contact_id', type: 'i', value: rawId },
          { name: 'mimetype', type: 's', value: MIME_PHONE },
          { name: 'data1', type: 's', value: number },
          { name: 'data2', type: 'i', value: PHONE_TYPE_MOBILE },
        ]),
      );
    });
    await this.adb.script(dataCommands);

    const phoneRows = await this.adb.contentQuery(
      DATA_URI,
      ['raw_contact_id'],
      `mimetype=${sqlQuote(MIME_PHONE)} AND raw_contact_id IN (${[...rawIds.values()].join(',')})`,
    );
    if (phoneRows.length !== numbers.length) {
      throw new AdbError('command-failed', `Only ${phoneRows.length} of ${numbers.length} phone rows were written`);
    }
  }

  /**
   * Delete every raw contact of the dedicated account/type (nothing else) and verify.
   * Idempotent: a no-op when none remain.
   */
  private async cleanup(): Promise<void> {
    const owned = () => this.adb.contentQuery(RAW_CONTACTS_URI, ['_id'], this.scope());
    let remaining = (await owned()).length;
    for (let attempt = 0; remaining > 0 && attempt < 3; attempt++) {
      await this.adb.shell(Adb.contentDeleteCommand(RAW_CONTACTS_HARD_DELETE_URI, this.scope()));
      remaining = (await owned()).length;
    }
    if (remaining > 0) {
      throw new Error(
        `${remaining} injected contacts could not be removed from account "${this.opts.contactAccountName}" (${this.opts.contactAccountType}). ` +
          `Remove that account's contacts manually on ${this.adb.serial} before continuing.`,
      );
    }
  }

  private mapFailure(failure: unknown, partial: Map<string, CheckStatus>): Error {
    if (failure instanceof AccountBanned) return partial.size ? new AccountBanned(failure.message, partial) : failure;
    if (failure instanceof RateLimited) return failure;
    if (isTransientAdbError(failure)) {
      return new RateLimited(`adb unavailable: ${failure.message}`, this.ctx.pacing.errorCooldownMs, partial);
    }
    return failure instanceof Error ? failure : new Error(String(failure));
  }
}

export const viberAdapter: Adapter = {
  app: 'viber',

  /**
   * Verifies the setup; activation itself is manual (SMS / call confirmation happens outside
   * this tool). Checks: adb device, Viber installed, root access, valid DB queries, and that
   * the app is activated per `authQuery`.
   */
  async login(ctx) {
    const conn = await connect(ctx);
    if (!conn.snapshot.authenticated) {
      throw new Error(
        `Viber on ${conn.adb.serial} is not activated (authQuery returned no rows). Open Viber on the device, complete phone-number activation manually (SMS/call code), then run login again.`,
      );
    }
    const saved: SavedDevice = {
      serial: conn.adb.serial,
      dbPath: conn.dbPath,
      ...(conn.versionName !== undefined && { versionName: conn.versionName }),
      verifiedAt: new Date().toISOString(),
    };
    await writeFile(join(ctx.accountDir, DEVICE_FILE), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    ctx.log(
      `viber: device ${conn.adb.serial}, Viber ${conn.versionName ?? 'unknown version'}, DB ${conn.dbPath}, ` +
        `${conn.snapshot.registered.size} registered / ${conn.snapshot.synced.size} synced numbers visible`,
    );
  },

  async open(ctx) {
    const conn = await connect(ctx).catch((error: unknown) => {
      // Setup problems surface as plain errors; a device that dropped off is retryable.
      if (isTransientAdbError(error)) {
        throw new RateLimited(`adb unavailable: ${error.message}`, ctx.pacing.errorCooldownMs);
      }
      throw error;
    });
    if (!conn.snapshot.authenticated) {
      throw new AccountBanned(LOGGED_OUT_MESSAGE);
    }
    return new ViberSession(conn, ctx);
  },
};
