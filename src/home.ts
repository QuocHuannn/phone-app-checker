import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_FILE } from './config.ts';
import { assertSafeAppRoot } from './paths.ts';

/** Open flag that refuses to follow a symlink in the last path component (POSIX only). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const packageRoot = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));

/** The example config shipped next to `src/` (in a checkout and in the release bundle alike). */
export function exampleConfigPath(): string {
  return packageRoot('checker.config.example.json');
}

/** `version` from the package.json next to `src/`. */
export function packageVersion(): string {
  const file = packageRoot('package.json');
  const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${file} has no "version"`);
  }
  return pkg.version;
}

/** Written into the release bundle by the build script; absent in a source checkout. */
export interface BuildInfo {
  version: string;
  platform: string;
  node: string;
  nodeSha256: string;
  lockSha256: string;
  builtAt: string;
  builder: string;
}

const BUILD_INFO_KEYS = ['version', 'platform', 'node', 'nodeSha256', 'lockSha256', 'builtAt', 'builder'] as const;

/** Parse BUILD-INFO.json; `null` when the file does not exist, an error when it is malformed. */
export function readBuildInfo(file: string = packageRoot('BUILD-INFO.json')): BuildInfo | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file} must contain a JSON object`);
  const record = raw as Record<string, unknown>;
  const info = {} as Record<string, string>;
  for (const key of BUILD_INFO_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`${file}: "${key}" must be a string`);
    info[key] = value;
  }
  return info as unknown as BuildInfo;
}

/** Make `dir` a real directory owned by the current user with mode 700. Never follows a symlink. */
export function ensureHomeDirectory(dir: string): void {
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error(`${dir} is a symlink; refusing to use it as the app home.`);
  // Before anything is created or chmod-ed: refuses `/`, the home directory and its parents, the
  // user's own folders (Documents, Desktop, ...; a config marker there proves nothing) and anything
  // overlapping the installation tree, on physical paths.
  assertSafeAppRoot(dir, 'app home');
  if (existing === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    throw new Error(`Cannot use ${dir} as the app home: ${(error as Error).message}`, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`${dir} is owned by uid ${stat.uid}, not by the current user (${uid}); refusing to use it as the app home.`);
    }
    if ((stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prepare the app home: create it (700) and, when absent, copy the bundled example config to
 * `<home>/checker.config.json` (600). Never overwrites an existing config. Returns true when the
 * config was created now.
 */
export function bootstrapHome(home: string, log: (message: string) => void): boolean {
  const dir = resolve(home);
  ensureHomeDirectory(dir);
  const file = resolve(dir, DEFAULT_CONFIG_FILE);
  const example = readFileSync(exampleConfigPath());
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new Error(`Cannot create ${file}: ${(error as Error).message}`, { cause: error });
  }
  try {
    let written = 0;
    while (written < example.length) written += writeSync(fd, example, written);
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    unlinkSync(file);
    throw new Error(`Cannot write ${file}: ${(error as Error).message}`, { cause: error });
  }
  closeSync(fd);
  log(`First run: created ${file}. It holds the settings (enabled apps, pacing); Telegram's apiId/apiHash are asked for in the menu at login. Then run: phone-app-checker doctor`);
  return true;
}
