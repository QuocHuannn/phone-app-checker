import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Thin, shell-free wrapper around the `adb` binary. Every call goes through
 * `execFile` with an argv array; the only shell involved is the one on the
 * Android device, and every value interpolated into it goes through `shQuote`.
 */

export type AdbErrorKind =
  /** `adb` binary not found / not executable. */
  | 'adb-missing'
  /** No device in `device` state (none attached, offline, unauthorized). */
  | 'no-device'
  /** Several devices attached and no serial chosen. */
  | 'ambiguous-device'
  /** Link to the device dropped mid-command. */
  | 'disconnected'
  | 'timeout'
  /** Device reachable but the command exited non-zero. */
  | 'command-failed'
  /** Neither `adb root` nor `su` gives access to app-private data. */
  | 'root-unavailable';

export class AdbError extends Error {
  readonly kind: AdbErrorKind;
  constructor(kind: AdbErrorKind, message: string) {
    super(message);
    this.name = 'AdbError';
    this.kind = kind;
  }
}

/** True for errors where waiting and retrying later may help (device/link problems). */
export function isTransientAdbError(error: unknown): error is AdbError {
  return (
    error instanceof AdbError &&
    (error.kind === 'disconnected' || error.kind === 'timeout' || error.kind === 'no-device')
  );
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 512 * 1024 * 1024;

const DISCONNECT_PATTERNS = [
  /device offline/i,
  /no devices\/emulators found/i,
  /device '[^']*' not found/i,
  /device unauthorized/i,
  /protocol fault/i,
  /connection reset/i,
  /device .*closed/i,
  /transport (error|closed)/i,
];

/** Single-quote a value for the Android device shell. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end < 0 ? field.length : end);
}

/**
 * Parse an uncompressed tar stream (ustar/pax headers, regular files only) into name -> content.
 * Verifies header checksums, entry sizes and the end-of-archive marker; any violation throws a
 * transient `disconnected` AdbError, because the usual cause is the adb link dropping mid-stream.
 */
export function parseTar(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const corrupt = (why: string) => new AdbError('disconnected', `adb returned a truncated or malformed archive (${why})`);
  let offset = 0;
  for (;;) {
    if (offset + 512 > data.length) throw corrupt('no end-of-archive marker');
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return files;

    const stored = Number.parseInt(tarString(header, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
    if (stored !== sum) throw corrupt('bad header checksum');

    const size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8);
    if (!Number.isInteger(size) || size < 0) throw corrupt('bad entry size');
    const start = offset + 512;
    if (start + size > data.length) throw corrupt('entry cut short');
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === '0' || type === '\0') {
      const prefix = tarString(header, 345, 155);
      const name = `${prefix === '' ? '' : `${prefix}/`}${tarString(header, 0, 100)}`.replace(/^\.\//, '');
      files.set(name, Buffer.from(data.subarray(start, start + size)));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
}

/** Quote a value as an SQL string literal (for `content ... --where`). */
export function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runAdb(adbPath: string, args: string[], timeoutMs: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  // Error text names only the adb subcommand: shell command lines can contain customer numbers.
  const subcommand = args[0] === '-s' ? (args[2] ?? '') : (args[0] ?? '');
  execFile(
    adbPath,
    args,
    { encoding: 'buffer', timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
    (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const err = error as NodeJS.ErrnoException & { killed?: boolean };
      const detail = stderr.toString('utf8').trim() || stdout.toString('utf8').trim();
      if (err.code === 'ENOENT') {
        reject(
          new AdbError(
            'adb-missing',
            `adb not found at "${adbPath}". Install Android platform-tools and put adb on PATH, or set the Viber option "adbPath".`,
          ),
        );
      } else if (err.killed || err.code === 'ETIMEDOUT') {
        reject(new AdbError('timeout', `adb ${subcommand} timed out after ${timeoutMs} ms`));
      } else if (DISCONNECT_PATTERNS.some((p) => p.test(detail))) {
        reject(new AdbError('disconnected', `adb device unavailable: ${detail}`));
      } else {
        // err.message embeds the full command line (customer numbers); only adb's own output is safe to show.
        reject(new AdbError('command-failed', `adb ${subcommand} failed: ${detail || `exit status ${String(err.code ?? 'unknown')}`}`));
      }
    },
  );
  return promise;
}

export interface AdbDevice {
  serial: string;
  state: string;
}

/** Parse `adb devices` output. */
export async function listDevices(adbPath = 'adb'): Promise<AdbDevice[]> {
  const out = (await runAdb(adbPath, ['devices'], 20_000)).toString('utf8');
  const devices: AdbDevice[] = [];
  for (const line of out.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) devices.push({ serial, state });
  }
  return devices;
}

export interface AdbOptions {
  adbPath?: string;
  /** Device serial; auto-selected when exactly one device is attached. */
  serial?: string;
  timeoutMs?: number;
}

export type RootMode = 'adbd' | 'su';

export interface InsertBind {
  name: string;
  /** content(1) bind types: s=string, i=int, l=long, b=boolean, n=null. */
  type: 's' | 'i' | 'l' | 'b';
  value: string | number | boolean;
}

export class Adb {
  readonly serial: string;
  private readonly adbPath: string;
  private readonly timeoutMs: number;
  private rootMode: RootMode | undefined;

  private constructor(adbPath: string, serial: string, timeoutMs: number) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.timeoutMs = timeoutMs;
  }

  /** Select a device in `device` state and return a handle bound to it. */
  static async connect(options: AdbOptions = {}): Promise<Adb> {
    const adbPath = options.adbPath ?? 'adb';
    const devices = await listDevices(adbPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.serial) {
      const match = devices.find((d) => d.serial === options.serial);
      if (!match) {
        throw new AdbError(
          'no-device',
          `adb device "${options.serial}" not attached (attached: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ') || 'none'}). Start the emulator or reconnect the phone.`,
        );
      }
      if (match.state !== 'device') {
        throw new AdbError(
          'no-device',
          `adb device "${match.serial}" is in state "${match.state}" (expected "device"). Wait for boot, or accept the USB debugging prompt on the phone.`,
        );
      }
      return new Adb(adbPath, match.serial, timeoutMs);
    }
    const ready = devices.filter((d) => d.state === 'device');
    if (ready.length === 0) {
      throw new AdbError(
        'no-device',
        `No adb device in "device" state (attached: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ') || 'none'}). Start the emulator or connect the phone with USB debugging enabled.`,
      );
    }
    if (ready.length > 1) {
      throw new AdbError(
        'ambiguous-device',
        `Several adb devices attached (${ready.map((d) => d.serial).join(', ')}). Set the Viber option "serial".`,
      );
    }
    return new Adb(adbPath, ready[0]!.serial, timeoutMs);
  }

  /** Run `adb -s <serial> <args>`; resolves raw stdout. */
  exec(args: string[], timeoutMs: number = this.timeoutMs): Promise<Buffer> {
    return runAdb(this.adbPath, ['-s', this.serial, ...args], timeoutMs);
  }

  /** Run a command in the device shell (as shell user, or root when adbd runs as root). */
  async shell(command: string, timeoutMs?: number): Promise<string> {
    return (await this.exec(['shell', command], timeoutMs)).toString('utf8');
  }

  /** Run several device-shell commands in one adb round trip. Stops at the first failing command. */
  script(commands: string[], timeoutMs?: number): Promise<string> {
    if (commands.length === 0) return Promise.resolve('');
    return this.shell(`set -e\n${commands.join('\n')}`, timeoutMs ?? Math.max(60_000, commands.length * 3000));
  }

  /** Fails with AdbError when the device is gone. */
  async ping(): Promise<void> {
    await this.exec(['get-state'], 15_000);
  }

  private async uid(): Promise<string> {
    return (await this.shell('id -u', 15_000)).trim();
  }

  /**
   * Make sure app-private data (/data/data/...) is readable: adbd already root,
   * `adb root`, or `su -c`. Throws root-unavailable with an actionable message.
   */
  async ensureRoot(): Promise<RootMode> {
    if (this.rootMode) return this.rootMode;
    if ((await this.uid()) === '0') return (this.rootMode = 'adbd');

    try {
      await this.exec(['root'], 30_000);
    } catch (error) {
      if (error instanceof AdbError && error.kind === 'adb-missing') throw error;
      // "adbd cannot run as root in production builds" etc. -> try su below.
    }
    // adbd restarts after `adb root`; wait for the device to come back.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.exec(['wait-for-device'], 30_000);
        if ((await this.uid()) === '0') return (this.rootMode = 'adbd');
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await sleep(1000);
      }
    }

    try {
      const out = await this.shell(`su -c ${shQuote('id -u')}`, 20_000);
      if (out.trim() === '0') return (this.rootMode = 'su');
    } catch (error) {
      if (isTransientAdbError(error)) throw error;
    }
    throw new AdbError(
      'root-unavailable',
      'Root access is required to read the Viber database (app-private data), and neither `adb root` nor `su` works on this device. ' +
        'Use an Android Studio AVD with a "Google APIs" image (NOT "Google Play"), or a rooted phone. See docs/viber-setup.md. ' +
        'A UI-scraping fallback is intentionally not implemented because it would rely on unverified screen layouts.',
    );
  }

  /** Run a command with root privileges (see ensureRoot). */
  async rootShell(command: string, timeoutMs?: number): Promise<string> {
    const mode = await this.ensureRoot();
    return this.shell(mode === 'su' ? `su -c ${shQuote(command)}` : command, timeoutMs);
  }

  /** Names of the entries of a device directory (root). Empty when it does not exist. */
  async listDir(remote: string): Promise<string[]> {
    const out = await this.rootShell(`ls -1 ${shQuote(remote)} 2>/dev/null || true`);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Read several files of one device directory as root in a single `tar` stream, so a database
   * and its `-wal` come from one read boundary instead of two separate pulls. Files that do not
   * exist are simply absent from the result. A short or malformed archive throws a transient
   * (`disconnected`) error rather than yielding partial data.
   */
  async readFileSet(dir: string, names: string[]): Promise<Map<string, Buffer>> {
    const mode = await this.ensureRoot();
    const probe = names.map((name) => `[ -f ${shQuote(name)} ] && echo ${shQuote(name)}`).join('; ');
    const listing = await this.rootShell(`cd ${shQuote(dir)} 2>/dev/null && { ${probe}; true; }`);
    const present = names.filter((name) => listing.split('\n').some((line) => line.trim() === name));
    if (present.length === 0) return new Map();
    const tar = `cd ${shQuote(dir)} && tar -cf - ${present.map(shQuote).join(' ')}`;
    const archive = await this.exec(['exec-out', mode === 'su' ? `su -c ${shQuote(tar)}` : tar], 5 * 60_000);
    const files = parseTar(archive);
    for (const name of present) {
      if (!files.has(name)) throw new AdbError('disconnected', `adb archive of ${dir} is missing an expected file`);
    }
    return files;
  }

  /** Installed state and versionName of a package. */
  async packageInfo(pkg: string): Promise<{ installed: boolean; versionName?: string }> {
    const path = (await this.shell(`pm path ${shQuote(pkg)} 2>/dev/null || true`)).trim();
    if (!path.startsWith('package:')) return { installed: false };
    const dump = await this.shell(`dumpsys package ${shQuote(pkg)} | grep -m1 versionName= || true`);
    const version = /versionName=(\S+)/.exec(dump)?.[1];
    return version ? { installed: true, versionName: version } : { installed: true };
  }

  /** Bring a package's launcher activity to the foreground (no intents beyond launching). */
  async launch(pkg: string): Promise<void> {
    await this.shell(`monkey -p ${shQuote(pkg)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true`);
  }

  /** Command string for `content insert`; combine with `script()` for one round trip. */
  static contentInsertCommand(uri: string, binds: InsertBind[]): string {
    const flags = binds.map((b) => `--bind ${shQuote(`${b.name}:${b.type}:${String(b.value)}`)}`);
    return `content insert --uri ${shQuote(uri)} ${flags.join(' ')}`;
  }

  /**
   * `content query` parsed into rows. Column order follows `projection`. Values containing
   * the ", col=" sequence of a later column would mis-parse; callers only query ids/tags.
   * SQL NULL becomes null.
   */
  async contentQuery(uri: string, projection: string[], where?: string): Promise<Array<Record<string, string | null>>> {
    const parts = [
      'content query',
      `--uri ${shQuote(uri)}`,
      `--projection ${shQuote(projection.join(':'))}`,
      ...(where ? [`--where ${shQuote(where)}`] : []),
    ];
    const out = await this.shell(parts.join(' '));
    const rows: Array<Record<string, string | null>> = [];
    for (const line of out.split('\n')) {
      const match = /^Row: \d+ (.*)$/.exec(line.replace(/\r$/, ''));
      if (!match) continue;
      const body = match[1]!;
      const row: Record<string, string | null> = {};
      let cursor = 0;
      projection.forEach((column, i) => {
        const prefix = `${column}=`;
        if (!body.startsWith(prefix, cursor)) {
          throw new AdbError('command-failed', `Unexpected content query output for column "${column}"`);
        }
        const valueStart = cursor + prefix.length;
        const next = projection[i + 1];
        const end = next === undefined ? body.length : body.indexOf(`, ${next}=`, valueStart);
        if (end < 0) throw new AdbError('command-failed', `Unexpected content query output for column "${next}"`);
        const raw = body.slice(valueStart, end);
        row[column] = raw === 'NULL' ? null : raw;
        cursor = end + 2;
      });
      rows.push(row);
    }
    return rows;
  }

  /** `content delete` command string (not executed). */
  static contentDeleteCommand(uri: string, where: string): string {
    return `content delete --uri ${shQuote(uri)} --where ${shQuote(where)}`;
  }
}
