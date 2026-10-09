import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '@mtcute/node';

/**
 * mtcute caches every user object it receives (id, username, phone, full profile) in the
 * `peers` table of the session database, including the users returned for imported contacts.
 * This tool must keep customer profiles nowhere, so the session storage keeps authorization
 * data (auth keys, key-value state) on disk but swaps the peer cache for one that retains
 * nothing; mtcute's in-memory LRU still works for the lifetime of a client.
 */
const nonPersistentPeers = {
  store: () => undefined,
  getById: () => null,
  getByUsername: () => null,
  getByPhone: () => null,
  deleteAll: () => undefined,
};

class PrivateSessionStorage extends SqliteStorage {
  constructor(file: string) {
    super(file);
    // `peers` is a readonly field set by the base constructor; replace it before first use.
    Object.defineProperty(this, 'peers', { value: nonPersistentPeers, enumerable: true });
  }
}

/** Session storage that persists credentials only, never peer (customer profile) data. */
export function createSessionStorage(file: string): SqliteStorage {
  return new PrivateSessionStorage(file);
}

/**
 * Migration for sessions written by earlier versions: delete every cached peer from an existing
 * session database, reclaim the pages (so profile bytes do not linger in free space) and verify.
 * Returns how many cached profiles were removed. Must run while no client has the file open.
 */
export function scrubPeerCache(file: string): number {
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const hasTable = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get();
    if (hasTable === undefined) return 0;
    const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM peers').get() as { n: number | bigint }).n);
    const before = count();
    if (before === 0) return 0;
    db.exec('PRAGMA secure_delete = ON');
    db.exec('DELETE FROM peers');
    if (count() !== 0) throw new Error('peers table is not empty after delete');
    db.exec('VACUUM');
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return before;
  } finally {
    db.close();
  }
}
