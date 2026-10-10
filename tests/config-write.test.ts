import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_CONFIG_VERSION, loadConfig } from '../src/config.ts';
import { parseTelegramApiHash, parseTelegramApiId, saveTelegramCredentials } from '../src/config-write.ts';
import { readTelegramCredentials } from '../src/adapters/telegram-credentials.ts';

const HASH = '0123456789abcdef0123456789abcdef';
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-config-write-'));
  file = join(dir, 'checker.config.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseTelegramApiId / parseTelegramApiHash', () => {
  it('accepts digits only for the api_id', () => {
    expect(parseTelegramApiId(' 1234567 ')).toBe(1234567);
    for (const bad of ['', '0', '-5', '12.5', '1e6', '12ab', '١٢٣', '123456789012345', '+1']) expect(parseTelegramApiId(bad), bad).toBeUndefined();
  });

  it('accepts exactly 32 hex characters for the api_hash, normalised to lower case', () => {
    expect(parseTelegramApiHash(` ${HASH.toUpperCase()} `)).toBe(HASH);
    for (const bad of ['', HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}g`, `${HASH.slice(2)} x`, '"' + HASH.slice(2) + '"']) {
      expect(parseTelegramApiHash(bad), bad).toBeUndefined();
    }
  });
});

describe('saveTelegramCredentials', () => {
  it('keeps every other setting, writes owner-only, and the result loads and is read back', () => {
    writeFileSync(file, JSON.stringify({ defaultRegion: 'SG', apps: { zalo: { enabled: false }, telegram: { dailyCap: 7, options: { apiId: null, apiHash: null, other: 'kept' } } } }), { mode: 0o644 });
    saveTelegramCredentials(file, 1234567, HASH);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      defaultRegion: 'SG',
      apps: { zalo: { enabled: false }, telegram: { dailyCap: 7, options: { apiId: 1234567, apiHash: HASH, other: 'kept' } } },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const config = loadConfig(file);
    expect(config.defaultRegion).toBe('SG');
    expect(config.apps.telegram.dailyCap).toBe(7);
    expect(readTelegramCredentials(config.apps.telegram.options, {})).toEqual({ apiId: 1234567, apiHash: HASH });
    expect(readdirSync(dir)).toEqual(['checker.config.json']); // no temporary file left behind
  });

  it('creates the file when it is missing, and tolerates a byte order mark', () => {
    saveTelegramCredentials(file, 42, HASH);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      apps: { telegram: { options: { apiId: 42, apiHash: HASH } } },
    });
    writeFileSync(file, `\uFEFF${JSON.stringify({ maxAgeDays: 3 })}`);
    saveTelegramCredentials(file, 43, HASH);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      maxAgeDays: 3,
      apps: { telegram: { options: { apiId: 43, apiHash: HASH } } },
    });
  });

  it('refuses a file written by a newer version instead of stamping it older', () => {
    writeFileSync(file, JSON.stringify({ configVersion: CURRENT_CONFIG_VERSION + 1, apps: { telegram: {} } }));
    const before = readFileSync(file, 'utf8');
    expect(() => saveTelegramCredentials(file, 1, HASH)).toThrow(/needs a newer version/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a config that is not valid JSON or has the wrong shape, leaving it untouched and never quoting it', () => {
    const cases: [string, RegExp][] = [
      [`{ "apps": { "telegram": { "options": { "apiHash": "${HASH}" } } `, /not valid JSON/],
      ['[1, 2]', /JSON object/],
      ['{ "apps": 5 }', /"apps"/],
      ['{ "apps": { "telegram": [] } }', /"apps.telegram"/],
      ['{ "apps": { "telegram": { "options": "x" } } }', /"apps.telegram.options"/],
    ];
    for (const [text, message] of cases) {
      writeFileSync(file, text);
      let thrown: unknown;
      try {
        saveTelegramCredentials(file, 1, HASH);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).not.toContain(HASH);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
    expect(readdirSync(dir)).toEqual(['checker.config.json']);
  });

  it('replaces a symlink at the target instead of writing through it', () => {
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, '{}');
    symlinkSync(elsewhere, file);
    saveTelegramCredentials(file, 5, HASH);
    expect(readFileSync(elsewhere, 'utf8')).toBe('{}');
    expect(JSON.parse(readFileSync(file, 'utf8')).apps.telegram.options.apiId).toBe(5);
  });

  it('fails clearly when the directory does not exist, without a stray temporary file', () => {
    mkdirSync(join(dir, 'sub'));
    expect(() => saveTelegramCredentials(join(dir, 'missing', 'c.json'), 1, HASH)).toThrow();
    expect(readdirSync(join(dir, 'sub'))).toEqual([]);
  });
});
