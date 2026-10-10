import { readFileSync } from 'node:fs';
import { migrateConfigObject } from './config.ts';
import { writePrivateFileAtomic } from './private-file.ts';

/** Telegram `api_id`: digits only, a positive number that is still exact as a JSON number. */
export function parseTelegramApiId(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Telegram `api_hash`: exactly 32 hexadecimal characters (stored lower-case); anything else is `undefined`. */
export function parseTelegramApiHash(text: string): string | undefined {
  const trimmed = text.trim();
  return /^[0-9a-fA-F]{32}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Store the Telegram API credentials in the config file at `file` (created when missing): every other
 * setting is kept, the file is replaced atomically with mode 0600. Messages never quote the file or the
 * credentials. Throws when the existing file is not a JSON object with object-valued `apps.telegram`.
 */
export function saveTelegramCredentials(file: string, apiId: number, apiHash: string): void {
  let root: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read the config file (${(error as NodeJS.ErrnoException).code ?? 'read error'})`);
    }
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('the config file is not valid JSON; fix it first');
    }
    if (!isObject(parsed)) throw new Error('the config file must contain a JSON object');
    try {
      root = migrateConfigObject(parsed);
    } catch (error) {
      throw new Error(`${(error as Error).message}; not writing`);
    }
  } else {
    root = migrateConfigObject(root);
  }
  const apps = root.apps ?? {};
  if (!isObject(apps)) throw new Error('"apps" in the config file must be an object');
  const telegram = apps.telegram ?? {};
  if (!isObject(telegram)) throw new Error('"apps.telegram" in the config file must be an object');
  const options = telegram.options ?? {};
  if (!isObject(options)) throw new Error('"apps.telegram.options" in the config file must be an object');

  root.apps = { ...apps, telegram: { ...telegram, options: { ...options, apiId, apiHash } } };
  writePrivateFileAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
}
