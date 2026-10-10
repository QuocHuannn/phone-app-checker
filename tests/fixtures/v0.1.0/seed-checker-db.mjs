#!/usr/bin/env node
/**
 * Writes the phone-app-checker 0.1.0 fixture database to the path in argv[2]:
 * synthetic numbers from the +84 9xx test range only, no real data.
 *
 * Usage: node seed-checker-db.mjs <path> [schema]
 *   schema 1 = the pre-0.1.0 layout without failed_checks (exercises the v1->v2 step)
 *   schema 2 = the released 0.1.0 schema (default; what verify-release.sh seeds)
 *
 * Plain .mjs + node:sqlite so the release clean room can run it with the bundle's
 * own runtime: no Node and no repo dependencies are needed on PATH.
 */
import { DatabaseSync } from 'node:sqlite';

const [, , path, schemaArg] = process.argv;
const schema = schemaArg === undefined ? 2 : Number(schemaArg);
if (path === undefined || ![1, 2].includes(schema)) {
  console.error('usage: node seed-checker-db.mjs <path> [1|2]');
  process.exit(2);
}

const db = new DatabaseSync(path);
try {
  db.exec(`
    CREATE TABLE results (
      e164 TEXT NOT NULL,
      app TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (e164, app)
    );
    CREATE TABLE accounts (
      app TEXT NOT NULL,
      name TEXT NOT NULL,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      day TEXT NOT NULL DEFAULT '',
      used_today INTEGER NOT NULL DEFAULT 0,
      next_allowed_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app, name)
    );
    INSERT INTO results VALUES
      ('+84901000001', 'telegram', 'yes', 1700000000000),
      ('+84902000002', 'whatsapp', 'not_found', 1700000001000),
      ('+84903000003', 'zalo', 'unknown', 1700000002000);
    INSERT INTO accounts VALUES
      ('telegram', 'main', 0, NULL, '2026-10-01', 3, 0);
  `);
  if (schema === 2) {
    db.exec(`
      CREATE TABLE failed_checks (
        e164 TEXT NOT NULL,
        app TEXT NOT NULL,
        failures INTEGER NOT NULL,
        last_failed_at INTEGER NOT NULL,
        PRIMARY KEY (e164, app)
      );
      INSERT INTO failed_checks VALUES ('+84904000004', 'telegram', 2, 1700000003000);
      PRAGMA user_version = 2;
    `);
  } else {
    db.exec('PRAGMA user_version = 1;');
  }
} finally {
  db.close();
}
