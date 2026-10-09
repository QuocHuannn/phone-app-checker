import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { isSupportedCountry } from 'libphonenumber-js/max';
import { join, resolve } from 'node:path';
import type { App, PacingSettings } from './types.ts';
import { APPS } from './types.ts';

export interface AppConfig extends PacingSettings {
  /** App-specific options (e.g. Telegram apiId/apiHash, Viber adb serial). */
  options: Record<string, unknown>;
}

export interface Config {
  /** Region used for numbers written without a country code (ISO2). */
  defaultRegion: string;
  dataDir: string;
  /** Reuse yes/not_found results younger than this. */
  maxAgeDays: number;
  apps: Record<App, AppConfig>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Conservative starting points. Platforms do not publish limits; tune them
 * after a pilot run (see README).
 */
export const DEFAULT_APPS: Record<App, AppConfig> = {
  telegram: {
    enabled: true,
    batchSize: 10,
    dailyCap: 200,
    minIntervalMs: 2 * MINUTE,
    jitterMs: MINUTE,
    rateLimitCooldownMs: 6 * HOUR,
    errorCooldownMs: 10 * MINUTE,
    options: {},
  },
  whatsapp: {
    enabled: true,
    batchSize: 20,
    dailyCap: 300,
    minIntervalMs: 2 * MINUTE,
    jitterMs: MINUTE,
    rateLimitCooldownMs: 6 * HOUR,
    errorCooldownMs: 10 * MINUTE,
    options: {},
  },
  zalo: {
    enabled: true,
    batchSize: 1,
    dailyCap: 100,
    minIntervalMs: 30_000,
    jitterMs: 30_000,
    rateLimitCooldownMs: 24 * HOUR,
    errorCooldownMs: 10 * MINUTE,
    options: {},
  },
  viber: {
    enabled: false,
    batchSize: 100,
    dailyCap: 1000,
    minIntervalMs: 30 * MINUTE,
    jitterMs: 10 * MINUTE,
    rateLimitCooldownMs: 12 * HOUR,
    errorCooldownMs: 10 * MINUTE,
    options: {},
  },
  line: {
    enabled: false,
    batchSize: 1,
    dailyCap: 50,
    minIntervalMs: 2 * MINUTE,
    jitterMs: MINUTE,
    rateLimitCooldownMs: 24 * HOUR,
    errorCooldownMs: 10 * MINUTE,
    options: {},
  },
};

export const DEFAULT_CONFIG_FILE = 'checker.config.json';

/** Environment variable that switches the CLI to release mode: config and data live in this directory. */
export const HOME_ENV = 'PHONE_APP_CHECKER_HOME';

/**
 * libphonenumber is only needed to validate `defaultRegion` when a config file is loaded; keep it
 * off the `--help` / `-V` path (r2 §4.9; same pattern as src/phone.ts). CJS entry keeps this sync.
 */
type Lib = { isSupportedCountry: typeof isSupportedCountry };
let lib: Lib | undefined;
const lp = (): Lib => (lib ??= createRequire(import.meta.url)('libphonenumber-js/max') as Lib);

const PACING_KEYS = [
  'batchSize',
  'dailyCap',
  'minIntervalMs',
  'jitterMs',
  'rateLimitCooldownMs',
  'errorCooldownMs',
] as const;

/** Settings counted in whole numbers: a fractional batch size or daily cap would leave an empty batch. */
const WHOLE_NUMBER_KEYS: readonly string[] = ['batchSize', 'dailyCap'];

/** A wait longer than a year is a typo (an extra zero, microseconds for milliseconds) and would hang a run. */
const MAX_DURATION_MS = 365 * 24 * 60 * MINUTE;

const TOP_LEVEL_KEYS = ['defaultRegion', 'dataDir', 'maxAgeDays', 'apps'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Config error: ${message}`);
}

/** "line L, column C" for a 0-based offset into `text`. */
function lineColumn(text: string, offset: number): string {
  const before = text.slice(0, offset);
  return `line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`;
}

const CURLY_QUOTES = /[\u2018\u2019\u201C\u201D]/;

/**
 * Why JSON.parse gave up, without quoting the file. V8's message repeats the text around the error,
 * which in a config file can be an API hash. Only a position, or the one thing a non-technical user
 * is likely to have done (typed curly quotes in TextEdit), is reported.
 */
function jsonSyntaxProblem(text: string, error: unknown): string {
  const curly = CURLY_QUOTES.exec(text);
  if (curly !== null) {
    return `not valid JSON: curly quotes at ${lineColumn(text, curly.index)}; use plain straight quotes (")`;
  }
  const reason = error instanceof Error ? error.message : '';
  const position = /\bposition (\d+)/.exec(reason);
  return position?.[1] === undefined
    ? 'not valid JSON (check quotes, commas and braces near your last edit)'
    : `not valid JSON at ${lineColumn(text, Number(position[1]))}`;
}

function mergeApp(app: App, base: AppConfig, raw: unknown): AppConfig {
  if (raw === undefined) return { ...base, options: { ...base.options } };
  if (!isPlainObject(raw)) fail(`apps.${app} must be an object`);
  const input = raw;
  for (const key of Object.keys(input)) {
    if (key !== 'enabled' && key !== 'options' && !(PACING_KEYS as readonly string[]).includes(key)) {
      fail(`unknown setting "${key}" in apps.${app}`);
    }
  }
  const merged: AppConfig = { ...base, options: { ...base.options } };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') fail(`apps.${app}.enabled must be true/false`);
    merged.enabled = input.enabled;
  }
  for (const key of PACING_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`apps.${app}.${key} must be a non-negative number`);
    }
    if (WHOLE_NUMBER_KEYS.includes(key) && !Number.isInteger(value)) fail(`apps.${app}.${key} must be a whole number`);
    if (!WHOLE_NUMBER_KEYS.includes(key) && value > MAX_DURATION_MS) {
      fail(`apps.${app}.${key} must be at most ${MAX_DURATION_MS} (one year, in milliseconds)`);
    }
    merged[key] = value;
  }
  if (merged.batchSize < 1) fail(`apps.${app}.batchSize must be >= 1`);
  if (merged.dailyCap < 1) fail(`apps.${app}.dailyCap must be >= 1`);
  if (merged.rateLimitCooldownMs < 1) fail(`apps.${app}.rateLimitCooldownMs must be >= 1`);
  if (input.options !== undefined) {
    if (!isPlainObject(input.options)) fail(`apps.${app}.options must be an object`);
    Object.assign(merged.options, input.options);
  }
  return merged;
}

/** Config file that `loadConfig(path, home)` reads: an explicit `path` is cwd-relative, else `<home or cwd>/checker.config.json`. */
export function configFilePath(path?: string, home?: string): string {
  return path !== undefined ? resolve(path) : join(home === undefined ? process.cwd() : resolve(home), DEFAULT_CONFIG_FILE);
}

/**
 * Load config: built-in defaults overlaid by the JSON file when it exists.
 *
 * `home` undefined = source mode: the default file and a relative `dataDir` resolve against cwd.
 * `home` set = release mode: the default file is `<home>/checker.config.json` and a relative
 * `dataDir` is anchored at `<home>`. An explicit `path` is always cwd-relative.
 */
export function loadConfig(path?: string, home?: string): Config {
  const base = home === undefined ? process.cwd() : resolve(home);
  const file = configFilePath(path, home);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      fail(`${file}: cannot read (${(error as NodeJS.ErrnoException).code ?? 'read error'})`);
    }
    try {
      // Notepad and some exporters save UTF-8 with a byte order mark, which JSON.parse rejects.
      raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch (error) {
      fail(`${file}: ${jsonSyntaxProblem(text, error)}`);
    }
  } else if (path !== undefined) {
    fail(`${file} not found`);
  }

  if (!isPlainObject(raw)) fail(`${file} must contain a JSON object`);
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) fail(`unknown setting "${key}"`);
  }
  const defaultRegion = raw.defaultRegion ?? 'VN';
  if (typeof defaultRegion !== 'string' || !/^[A-Z]{2}$/.test(defaultRegion)) {
    fail('defaultRegion must be a 2-letter country code such as "VN"');
  }
  // "UK" is not ISO (the United Kingdom is "GB"): an unknown code would silently mark every
  // national number in the CSV invalid.
  if (!lp().isSupportedCountry(defaultRegion)) fail(`defaultRegion "${defaultRegion}" is not a known country code (for example VN, SG, US, GB)`);
  const dataDir = raw.dataDir ?? './data';
  if (typeof dataDir !== 'string' || dataDir.trim() === '') fail('dataDir must be a non-empty string');
  const maxAgeDays = raw.maxAgeDays ?? 30;
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    fail('maxAgeDays must be a non-negative number');
  }

  const rawApps = raw.apps ?? {};
  if (!isPlainObject(rawApps)) fail('apps must be an object');
  for (const key of Object.keys(rawApps)) {
    if (!(APPS as readonly string[]).includes(key)) fail(`unknown app "${key}" in apps`);
  }
  const apps = {} as Record<App, AppConfig>;
  for (const app of APPS) apps[app] = mergeApp(app, DEFAULT_APPS[app], rawApps[app]);

  return { defaultRegion, dataDir: resolve(base, dataDir), maxAgeDays, apps };
}

/** Account names become directory names, so keep them to a safe alphabet. */
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function assertAccountName(name: string): void {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid account name "${name}": use 1-32 letters, digits, "-" or "_", starting with a letter or digit`);
  }
}

/** Private directory holding one account's session files: <dataDir>/sessions/<app>/<name>. */
export function accountDirPath(config: Config, app: App, name: string): string {
  assertAccountName(name);
  return join(config.dataDir, 'sessions', app, name);
}

/** Create the account directory (mode 700) and return its path. */
export function ensureAccountDir(config: Config, app: App, name: string): string {
  const dir = accountDirPath(config, app, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Names of accounts that have a session directory for the app, sorted. */
export function listAccountNames(config: Config, app: App): string[] {
  const root = join(config.dataDir, 'sessions', app);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ACCOUNT_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
