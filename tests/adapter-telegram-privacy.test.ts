import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Long, SqliteStorage, TelegramClient } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionStorage, scrubPeerCache } from '../src/adapters/telegram-storage.ts';

// Real mtcute client and storage; only the network call is replaced, so the caching path that
// follows every RPC response (BaseTelegramClient.call -> storage.peers.updatePeersFrom) is real.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-privacy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CUSTOMER = {
  _: 'user',
  id: 424242,
  accessHash: Long.fromNumber(987654321),
  phone: '84901234567',
  firstName: 'CustomerFirstName',
  lastName: 'CustomerLastName',
  username: 'customer_handle',
} as const;

const IMPORT_RESPONSE = {
  _: 'contacts.importedContacts',
  imported: [{ _: 'importedContact', userId: CUSTOMER.id, clientId: Long.fromNumber(1) }],
  popularInvites: [],
  retryContacts: [],
  users: [CUSTOMER],
};

interface Internals {
  _client: { _connected: boolean; mt: { call: (message: unknown, params: unknown) => Promise<unknown> } };
}

async function lookupThrough(storage: SqliteStorage): Promise<void> {
  const client = new TelegramClient({ apiId: 1, apiHash: 'hash', storage, disableUpdates: true });
  await client.prepare();
  const internals = client as unknown as Internals;
  internals._client._connected = true;
  internals._client.mt.call = async () => IMPORT_RESPONSE;
  const result = await client.call({ _: 'contacts.importContacts', contacts: [] });
  expect(result).toMatchObject({ imported: [{ userId: CUSTOMER.id }] });
  await client.destroy();
}

const peerRows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id, phone FROM peers').all();
  } finally {
    db.close();
  }
};

const wholeStore = (file: string) =>
  readdirSync(dir)
    .filter((name) => name.startsWith('session.sqlite'))
    .map((name) => readFileSync(join(dir, name)).toString('latin1'))
    .join('');

describe('telegram session storage keeps no customer profiles', () => {
  it('control: the stock mtcute storage persists the returned customer', async () => {
    const file = join(dir, 'session.sqlite');
    await lookupThrough(new SqliteStorage(file));
    expect(peerRows(file)).toEqual([{ id: CUSTOMER.id, phone: CUSTOMER.phone }]);
  });

  it('a normal lookup through createSessionStorage leaves no peers behind', async () => {
    const file = join(dir, 'session.sqlite');
    await lookupThrough(createSessionStorage(file));
    expect(peerRows(file)).toEqual([]);
    const bytes = wholeStore(file);
    for (const needle of ['CustomerFirstName', 'CustomerLastName', 'customer_handle', '84901234567']) {
      expect(bytes).not.toContain(needle);
    }
  });
});

describe('scrubPeerCache (migration of sessions written by earlier versions)', () => {
  it('deletes cached peers, reclaims their bytes and reports how many', async () => {
    const file = join(dir, 'session.sqlite');
    await lookupThrough(new SqliteStorage(file));
    expect(wholeStore(file)).toContain('CustomerFirstName');

    expect(scrubPeerCache(file)).toBe(1);
    expect(peerRows(file)).toEqual([]);
    expect(wholeStore(file)).not.toContain('CustomerFirstName');
    expect(wholeStore(file)).not.toContain('84901234567');
    expect(scrubPeerCache(file)).toBe(0);

    // The session itself (auth keys, state) is untouched.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()).toMatchObject({ n: expect.any(Number) });
    } finally {
      db.close();
    }
  });

  it('does nothing when there is no session file or no peers table', () => {
    expect(scrubPeerCache(join(dir, 'missing.sqlite'))).toBe(0);
    const file = join(dir, 'other.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE kv (key TEXT, value TEXT)');
    db.close();
    expect(scrubPeerCache(file)).toBe(0);
  });
});
