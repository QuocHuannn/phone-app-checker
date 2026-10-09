import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AdbModule from '../src/android/adb.ts';
import { viberAdapter } from '../src/adapters/viber.ts';
import { AdbError, shQuote } from '../src/android/adb.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

interface RawContact {
  id: number;
  sourceid: string;
}

// In-memory Android device: contacts provider + Viber database. Test double for adb only;
// the Viber adapter, node:sqlite and the adb command builders are real.
const device = vi.hoisted(() => ({
  /** device path -> host path of a SQLite file */
  files: new Map<string, string>(),
  rawContacts: [] as Array<{ id: number; sourceid: string }>,
  phoneRows: [] as Array<{ rawId: number; number: string }>,
  nextId: 1,
  commands: [] as string[],
  /** Numbers Viber considers users once it syncs. */
  viberUsers: new Set<string>(),
  /** When false, launching Viber does not ingest the contacts (sync never happens). */
  syncs: true,
  /** Called whenever Viber "syncs"; the test supplies how to write rows into the DB. */
  onSync: undefined as undefined | ((numbers: string[], users: Set<string>) => void),
  connectError: undefined as unknown,
  pingError: undefined as unknown,
  /** content delete does nothing (contacts provider refuses). */
  stuckDelete: false,
  /** Phone data rows are accepted by the provider but not stored. */
  dropPhoneRows: false,
  launched: 0,
  /** Number of upcoming DB reads that return a torn (truncated) copy. */
  tornReads: 0,
  /** [dir, ...names] of every readFileSet call. */
  fileSetCalls: [] as string[][],
  serial: 'emulator-5554',
}));

vi.mock('node:timers/promises', () => ({
  // Polling "sleeps" only advance the clock the adapter reads with Date.now().
  setTimeout: async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

vi.mock('../src/android/adb.ts', async (importOriginal) => {
  const real = await importOriginal<typeof AdbModule>();
  const bind = (command: string, name: string) => new RegExp(`--bind '${name}:[sil]:([^']*)'`).exec(command)?.[1];

  class FakeAdb {
    static contentInsertCommand = real.Adb.contentInsertCommand;
    static contentDeleteCommand = real.Adb.contentDeleteCommand;
    serial = device.serial;

    static async connect() {
      if (device.connectError) throw device.connectError;
      return new FakeAdb();
    }
    async packageInfo() {
      return { installed: true, versionName: '25.1.0' };
    }
    async ensureRoot() {
      return 'adbd';
    }
    async ping() {
      if (device.pingError) throw device.pingError;
    }
    async listDir() {
      return [...device.files.keys()].map((path) => path.split('/').pop() ?? path);
    }
    async readFileSet(dir: string, names: string[]) {
      device.fileSetCalls.push([dir, ...names]);
      const out = new Map<string, Buffer>();
      for (const name of names) {
        const host = device.files.get(`${dir}/${name}`);
        if (host !== undefined) out.set(name, Buffer.from(readFileSync(host)));
      }
      const main = out.get(names[0] ?? '');
      if (main !== undefined && device.tornReads > 0) {
        // Viber checkpointed while the archive was read: the copy of the main DB is cut short.
        device.tornReads -= 1;
        out.set(names[0] ?? '', main.subarray(0, 2048));
      }
      return out;
    }
    async launch() {
      device.launched += 1;
      if (!device.syncs) return;
      device.onSync?.(
        device.phoneRows.map((row) => row.number),
        device.viberUsers,
      );
    }
    async script(commands: string[]) {
      for (const command of commands) {
        device.commands.push(command);
        if (command.includes("'content://com.android.contacts/raw_contacts'")) {
          device.rawContacts.push({ id: device.nextId++, sourceid: bind(command, 'sourceid') ?? '' });
        } else if (bind(command, 'mimetype') === 'vnd.android.cursor.item/phone_v2' && !device.dropPhoneRows) {
          device.phoneRows.push({ rawId: Number(bind(command, 'raw_contact_id')), number: bind(command, 'data1') ?? '' });
        }
      }
      return '';
    }
    async shell(command: string) {
      device.commands.push(command);
      if (command.startsWith('content delete') && !device.stuckDelete) {
        device.rawContacts.length = 0;
        device.phoneRows.length = 0;
      }
      return '';
    }
    async contentQuery(uri: string, projection: string[], where?: string) {
      if (uri.includes('/raw_contacts')) {
        const like = /sourceid LIKE '([^']*)'/.exec(where ?? '')?.[1]?.replace('%', '');
        return device.rawContacts
          .filter((row: RawContact) => like === undefined || row.sourceid.startsWith(like))
          .map((row: RawContact) => ({ _id: String(row.id), sourceid: row.sourceid }))
          .map((row) => Object.fromEntries(projection.map((column) => [column, row[column as keyof typeof row] ?? null])));
      }
      return device.phoneRows.map((row) => ({ raw_contact_id: String(row.rawId) }));
    }
  }
  return { ...real, Adb: FakeAdb };
});

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+84912345678', country: 'VN' };
const C: PhoneNumber = { e164: '+6591234567', country: 'SG' };
const DB_PATH = '/data/data/com.viber.voip/databases/viber_data';

const QUERIES = {
  registeredQuery: 'SELECT number FROM phonebook WHERE is_viber = 1',
  syncedQuery: 'SELECT number FROM phonebook',
  authQuery: 'SELECT 1 FROM account LIMIT 1',
};

let dir: string;
let hostDb: string;
let logs: string[];
let options: Record<string, unknown>;

function createViberDb(path: string, activated = true): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE phonebook (number TEXT, is_viber INTEGER); CREATE TABLE account (id INTEGER)');
  if (activated) db.exec('INSERT INTO account VALUES (1)');
  db.close();
}

function mutateDb(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(hostDb);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function ctx(): AdapterContext {
  return {
    app: 'viber',
    account: 'vb1',
    accountDir: dir,
    pacing: {
      enabled: true,
      batchSize: 100,
      dailyCap: 1000,
      minIntervalMs: 0,
      jitterMs: 0,
      rateLimitCooldownMs: 4242,
      errorCooldownMs: 2424,
    },
    options,
    log: (message) => logs.push(message),
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2026-10-08T05:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'viber-adapter-'));
  hostDb = join(dir, 'host-viber.db');
  createViberDb(hostDb);
  logs = [];
  options = { ...QUERIES, serial: 'emulator-5554' };
  device.files = new Map([[DB_PATH, hostDb]]);
  device.rawContacts.length = 0;
  device.phoneRows.length = 0;
  device.nextId = 1;
  device.commands.length = 0;
  device.viberUsers = new Set([A.e164]);
  device.syncs = true;
  device.connectError = undefined;
  device.pingError = undefined;
  device.stuckDelete = false;
  device.dropPhoneRows = false;
  device.launched = 0;
  device.tornReads = 0;
  device.fileSetCalls.length = 0;
  // Viber's contact sync: every injected number appears in `phonebook`, users are flagged.
  device.onSync = (numbers, users) =>
    mutateDb((db) => {
      const insert = db.prepare('INSERT INTO phonebook (number, is_viber) VALUES (?, ?)');
      const have = new Set(db.prepare('SELECT number FROM phonebook').all().map((row) => String(row.number)));
      for (const number of numbers) {
        if (!have.has(number)) insert.run(number, users.has(number) ? 1 : 0);
      }
    });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('viber options (fail closed)', () => {
  it.each(['registeredQuery', 'syncedQuery', 'authQuery'])('requires %s and points at the discovery script', async (key) => {
    delete options[key];
    await expect(viberAdapter.open(ctx())).rejects.toThrow(new RegExp(`"${key}" is required.*viber-discover-schema\\.sh`, 's'));
  });

  it('accepts only a single read-only statement', async () => {
    options.registeredQuery = 'SELECT number FROM phonebook; DELETE FROM phonebook';
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/single SELECT/);
    options.registeredQuery = 'DELETE FROM phonebook';
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/must start with SELECT or WITH/);
  });

  it('refuses contact accounts that could touch real contacts', async () => {
    options.contactAccountType = 'com.google';
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/must not be a real account type/);
    options.contactAccountType = 'phone-app-checker.local';
    options.contactAccountName = "x'; DROP";
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/contactAccountName/);
  });

  it('rejects a relative dbPath and out-of-range numbers', async () => {
    options.dbPath = 'databases/viber_data';
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/absolute device path/);
    delete options.dbPath;
    options.stablePolls = 0;
    await expect(viberAdapter.open(ctx())).rejects.toThrow(/stablePolls/);
  });
});

describe('viber login()', () => {
  it('verifies the setup and stores device, DB path and app version (mode 600)', async () => {
    await viberAdapter.login(ctx());
    const file = join(dir, 'viber-device.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ serial: 'emulator-5554', dbPath: DB_PATH, versionName: '25.1.0' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toContain('0 registered / 0 synced');
  });

  it('refuses an app that is not activated', async () => {
    mutateDb((db) => db.exec('DELETE FROM account'));
    await expect(viberAdapter.login(ctx())).rejects.toThrow(/not activated/);
  });

  it('fails when no database accepts the queries and lists why', async () => {
    options.registeredQuery = 'SELECT nope AS number FROM phonebook';
    const error = await viberAdapter.login(ctx()).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/None of the Viber databases accepts/);
    expect((error as Error).message).toContain('registeredQuery does not compile');
  });

  it('fails when the queries are valid in several databases unless dbPath is set', async () => {
    const second = join(dir, 'second.db');
    createViberDb(second);
    device.files.set('/data/data/com.viber.voip/databases/second_data', second);
    await expect(viberAdapter.login(ctx())).rejects.toThrow(/Ambiguous/);
    options.dbPath = DB_PATH;
    await viberAdapter.login(ctx());
  });

  it('rejects queries with the wrong column shape', async () => {
    options.syncedQuery = 'SELECT number, is_viber FROM phonebook';
    await expect(viberAdapter.login(ctx())).rejects.toThrow(/exactly one column named "number"/);
  });

  it('rejects an encrypted / non-SQLite database file', async () => {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'x'.repeat(4096));
    device.files = new Map([['/data/data/com.viber.voip/databases/viber_data', junk]]);
    await expect(viberAdapter.login(ctx())).rejects.toThrow(/not a plain SQLite file/);
  });
});

describe('viber open()', () => {
  it('maps a missing device to RateLimited (retry later) and a missing root to a hard error', async () => {
    device.connectError = new AdbError('no-device', 'No adb device');
    const limited = await viberAdapter.open(ctx()).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimited);
    expect((limited as RateLimited).retryAfterMs).toBe(2424);

    device.connectError = new AdbError('root-unavailable', 'no root');
    const hard = await viberAdapter.open(ctx()).catch((e: unknown) => e);
    expect(hard).not.toBeInstanceOf(RateLimited);
    expect((hard as Error).message).toBe('no root');
  });

  it('maps an empty authQuery to AccountBanned', async () => {
    mutateDb((db) => db.exec('DELETE FROM account'));
    await expect(viberAdapter.open(ctx())).rejects.toBeInstanceOf(AccountBanned);
  });
});

describe('viber check()', () => {
  async function session() {
    return viberAdapter.open(ctx());
  }

  it('injects contacts under the dedicated account, reads Viber results and removes the contacts', async () => {
    const result = await (await session()).check([A, B, C]);
    expect(result).toEqual(
      new Map([
        [A.e164, 'yes'],
        [B.e164, 'not_found'],
        [C.e164, 'not_found'],
      ]),
    );
    expect(device.launched).toBe(1);
    expect(device.rawContacts).toEqual([]);
    const inserts = device.commands.filter((c) => c.startsWith('content insert'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const command of inserts.filter((c) => c.includes('/raw_contacts'))) {
      expect(command).toContain("account_type:s:phone-app-checker.local");
      expect(command).toContain("account_name:s:phone-app-checker");
    }
    // Deletion is scoped to the dedicated account and type only.
    const deletes = device.commands.filter((c) => c.startsWith('content delete'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const command of deletes) {
      expect(command).toContain(shQuote("account_name='phone-app-checker' AND account_type='phone-app-checker.local'"));
    }
    expect(logs.join('\n')).not.toContain(A.e164);
  });

  it('ignores malformed numbers and duplicates and does not touch the device for an empty batch', async () => {
    const s = await session();
    expect(await s.check([{ e164: 'abc', country: '' }])).toEqual(new Map());
    expect(device.commands).toEqual([]);
    await s.check([A, A]);
    const phoneInserts = device.commands.filter((c) => c.includes('phone_v2'));
    expect(phoneInserts).toHaveLength(1);
  });

  it('removes leftovers of an interrupted earlier run before injecting', async () => {
    device.rawContacts.push({ id: 99, sourceid: 'pac-leftover-0' });
    device.nextId = 100;
    const s = await session();
    await s.check([A]);
    const firstDelete = device.commands.findIndex((c) => c.startsWith('content delete'));
    const firstInsert = device.commands.findIndex((c) => c.includes('content insert'));
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstInsert).toBeGreaterThan(firstDelete);
    expect(device.rawContacts).toEqual([]);
  });

  it('leaves numbers unanswered and rate-limits when the sync never happens, still cleaning up', async () => {
    device.syncs = false;
    const error = await (await session()).check([A, B]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(4242);
    expect((error as RateLimited).partial.size).toBe(0);
    expect(device.rawContacts).toEqual([]);
  });

  it('never claims not_found for a number Viber did not ingest', async () => {
    device.onSync = (numbers) =>
      mutateDb((db) => {
        // Viber only ingested the first number before the timeout.
        db.prepare('INSERT INTO phonebook (number, is_viber) VALUES (?, 0)').run(numbers[0] ?? '');
      });
    const error = await (await session()).check([B, A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    const partial = (error as RateLimited).partial;
    expect(partial.get(B.e164)).toBe('not_found');
    expect(partial.has(A.e164)).toBe(false);
  });

  it('maps a dropped adb link to RateLimited with the error cooldown and cleans up when it can', async () => {
    const s = await session();
    device.pingError = new AdbError('disconnected', 'adb device unavailable');
    const error = await s.check([A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(2424);
  });

  it('reports AccountBanned when Viber was logged out between batches', async () => {
    const s = await session();
    mutateDb((db) => db.exec('DELETE FROM account'));
    await expect(s.check([A])).rejects.toBeInstanceOf(AccountBanned);
    expect(device.rawContacts).toEqual([]);
  });

  it('reports AccountBanned when the database is gone', async () => {
    const s = await session();
    device.files.clear();
    await expect(s.check([A])).rejects.toBeInstanceOf(AccountBanned);
  });

  it('stops with an actionable error when the schema no longer matches the queries', async () => {
    const s = await session();
    mutateDb((db) => db.exec('DROP TABLE phonebook'));
    await expect(s.check([A])).rejects.toThrow(/schema no longer matches.*viber-discover-schema\.sh/s);
  });

  it('keeps the results but rate-limits when contacts cannot be removed', async () => {
    device.stuckDelete = true;
    const error = await (await session()).check([A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).message).toMatch(/cleanup failed/);
    expect((error as RateLimited).partial.get(A.e164)).toBe('yes');
  });

  it('rejects an injection the contacts provider only half accepted', async () => {
    // The provider drops phone rows: data inserts "succeed" but nothing is stored.
    device.dropPhoneRows = true;
    const s = await session();
    const error = await s.check([A, B]).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/phone rows were written/);
    expect(device.rawContacts).toEqual([]);
  });

  it('close() removes any injected contacts', async () => {
    const s = await session();
    device.rawContacts.push({ id: 5, sourceid: 'x' });
    await s.close();
    expect(device.rawContacts).toEqual([]);
  });
});

describe('viber snapshot consistency', () => {
  const DB_DIR = '/data/data/com.viber.voip/databases';

  it('pulls the database and its WAL through a single archive read each time', async () => {
    const s = await viberAdapter.open(ctx());
    await s.check([A]);
    expect(device.fileSetCalls.length).toBeGreaterThan(2);
    for (const call of device.fileSetCalls) expect(call).toEqual([DB_DIR, 'viber_data', 'viber_data-wal']);
  });

  it('retries a torn copy instead of reporting it as a schema problem', async () => {
    const s = await viberAdapter.open(ctx());
    device.fileSetCalls.length = 0;
    device.tornReads = 2;
    const result = await s.check([A]);
    expect(result.get(A.e164)).toBe('yes');
    expect(device.tornReads).toBe(0);
    expect(device.fileSetCalls.length).toBeGreaterThanOrEqual(3);
    expect(device.rawContacts).toEqual([]);
  });

  it('treats a persistently torn copy as transient: RateLimited with the error cooldown, contacts cleaned', async () => {
    const s = await viberAdapter.open(ctx());
    device.tornReads = 1000;
    const error = await s.check([A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(2424);
    expect((error as RateLimited).message).toMatch(/inconsistent/);
    expect(error).not.toBeInstanceOf(AccountBanned);
    expect(device.rawContacts).toEqual([]);
  });

  it('open() maps a persistently torn copy to a retryable error, not a schema failure', async () => {
    device.tornReads = 1000;
    const error = await viberAdapter.open(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(2424);
  });
});
