import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Adb, AdbError, isTransientAdbError, listDevices, parseTar, shQuote, sqlQuote } from '../src/android/adb.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adb-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway executable standing in for the adb binary: runs `body` as a POSIX shell script. */
function fakeAdb(body: string): string {
  const path = join(dir, 'adb');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('quoting', () => {
  it('shQuote survives single quotes and shell metacharacters', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote("it's $(rm -rf /); `x`")).toBe(`'it'\\''s $(rm -rf /); \`x\`'`);
  });

  it('sqlQuote doubles single quotes', () => {
    expect(sqlQuote("a'b")).toBe("'a''b'");
  });
});

describe('command builders', () => {
  it('builds content insert with quoted binds', () => {
    expect(
      Adb.contentInsertCommand('content://x/raw', [
        { name: 'account_type', type: 's', value: 'a.b' },
        { name: 'raw_contact_id', type: 'i', value: 7 },
      ]),
    ).toBe("content insert --uri 'content://x/raw' --bind 'account_type:s:a.b' --bind 'raw_contact_id:i:7'");
  });

  it('builds content delete with a quoted where clause', () => {
    expect(Adb.contentDeleteCommand('content://x/raw', "account_name='n'")).toBe(
      `content delete --uri 'content://x/raw' --where 'account_name='\\''n'\\'''`,
    );
  });
});

describe('error classification', () => {
  it('treats link problems as transient and the rest as permanent', () => {
    for (const kind of ['disconnected', 'timeout', 'no-device'] as const) {
      expect(isTransientAdbError(new AdbError(kind, 'x'))).toBe(true);
    }
    for (const kind of ['adb-missing', 'ambiguous-device', 'command-failed', 'root-unavailable'] as const) {
      expect(isTransientAdbError(new AdbError(kind, 'x'))).toBe(false);
    }
    expect(isTransientAdbError(new Error('x'))).toBe(false);
  });
});

describe('device discovery against an adb binary', () => {
  it('reports a missing adb binary with install guidance', async () => {
    const error = await listDevices(join(dir, 'does-not-exist')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdbError);
    expect((error as AdbError).kind).toBe('adb-missing');
    expect((error as AdbError).message).toContain('platform-tools');
  });

  it('parses `adb devices` output', async () => {
    const adb = fakeAdb('printf "List of devices attached\\nemulator-5554\\tdevice\\nR58M\\tunauthorized\\n\\n"');
    expect(await listDevices(adb)).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'R58M', state: 'unauthorized' },
    ]);
  });

  it('picks the only ready device, ignoring unauthorized ones', async () => {
    const adb = fakeAdb('printf "List of devices attached\\nemulator-5554\\tdevice\\nR58M\\tunauthorized\\n"');
    expect((await Adb.connect({ adbPath: adb })).serial).toBe('emulator-5554');
  });

  it('refuses to guess between several ready devices', async () => {
    const adb = fakeAdb('printf "List of devices attached\\na\\tdevice\\nb\\tdevice\\n"');
    await expect(Adb.connect({ adbPath: adb })).rejects.toMatchObject({ kind: 'ambiguous-device' });
    expect((await Adb.connect({ adbPath: adb, serial: 'b' })).serial).toBe('b');
  });

  it('reports no device and unauthorized devices distinctly', async () => {
    const none = fakeAdb('printf "List of devices attached\\n"');
    await expect(Adb.connect({ adbPath: none })).rejects.toMatchObject({ kind: 'no-device' });
    await expect(Adb.connect({ adbPath: none, serial: 'x' })).rejects.toMatchObject({ kind: 'no-device' });
    const unauth = fakeAdb('printf "List of devices attached\\nR58M\\tunauthorized\\n"');
    await expect(Adb.connect({ adbPath: unauth, serial: 'R58M' })).rejects.toThrow(/USB debugging prompt/);
  });
});

describe('device commands', () => {
  const devices = 'if [ "$1" = devices ]; then printf "List of devices attached\\nd1\\tdevice\\n"; exit 0; fi';

  it('classifies adb stderr: offline device -> disconnected, other failures -> command-failed', async () => {
    const offline = fakeAdb(`${devices}\necho "error: device offline" >&2; exit 1`);
    const a = await Adb.connect({ adbPath: offline });
    await expect(a.shell('id')).rejects.toMatchObject({ kind: 'disconnected' });

    const failing = fakeAdb(`${devices}\necho "boom" >&2; exit 1`);
    const b = await Adb.connect({ adbPath: failing });
    await expect(b.shell('id')).rejects.toMatchObject({ kind: 'command-failed' });
  });

  it('never puts the shell command (which may hold a phone number) in error text', async () => {
    const failing = fakeAdb(`${devices}\nexit 1`);
    const adb = await Adb.connect({ adbPath: failing });
    const error = await adb.shell('echo +84901234567').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('84901234567');
  });

  it('times out hung commands as transient errors', async () => {
    const hung = fakeAdb(`${devices}\nexec sleep 5`);
    const adb = await Adb.connect({ adbPath: hung, timeoutMs: 200 });
    const error = await adb.shell('id').catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(isTransientAdbError(error)).toBe(true);
  });

  it('detects root from the device uid', async () => {
    const root = fakeAdb(`${devices}\nif [ "$3" = shell ] && [ "$4" = "id -u" ]; then echo 0; exit 0; fi\nexit 0`);
    expect(await (await Adb.connect({ adbPath: root })).ensureRoot()).toBe('adbd');
  });

  it('parses content query rows by projection order and maps NULL', async () => {
    const rows = fakeAdb(
      `${devices}\nprintf "Row: 0 _id=4, sourceid=pac-ab-0\\nRow: 1 _id=5, sourceid=NULL\\nnoise\\n"`,
    );
    const adb = await Adb.connect({ adbPath: rows });
    expect(await adb.contentQuery('content://x', ['_id', 'sourceid'])).toEqual([
      { _id: '4', sourceid: 'pac-ab-0' },
      { _id: '5', sourceid: null },
    ]);
  });

  it('rejects content query output that does not match the projection', async () => {
    const wrong = fakeAdb(`${devices}\nprintf "Row: 0 other=1\\n"`);
    const adb = await Adb.connect({ adbPath: wrong });
    await expect(adb.contentQuery('content://x', ['_id'])).rejects.toMatchObject({ kind: 'command-failed' });
  });

  it('reads package state and version', async () => {
    const pm = fakeAdb(
      `${devices}\ncase "$4" in\n*"pm path"*) echo "package:/data/app/x/base.apk";;\n*dumpsys*) echo "    versionName=25.1.0";;\nesac`,
    );
    expect(await (await Adb.connect({ adbPath: pm })).packageInfo('com.viber.voip')).toEqual({
      installed: true,
      versionName: '25.1.0',
    });
    const absent = fakeAdb(`${devices}\nexit 0`);
    expect(await (await Adb.connect({ adbPath: absent })).packageInfo('com.viber.voip')).toEqual({ installed: false });
  });
});

/** Minimal ustar writer for the tests: one regular file (or other type) entry. */
function tarEntry(name: string, content: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}
const tarOf = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

describe('parseTar', () => {
  it('reads regular files, strips ./ and ignores directories', () => {
    const big = Buffer.alloc(1300, 7);
    const files = parseTar(
      tarOf(tarEntry('./', Buffer.alloc(0), '5'), tarEntry('./viber_data', big), tarEntry('viber_data-wal', Buffer.from('wal'))),
    );
    expect([...files.keys()]).toEqual(['viber_data', 'viber_data-wal']);
    expect(files.get('viber_data')).toEqual(big);
    expect(files.get('viber_data-wal')?.toString()).toBe('wal');
  });

  it('accepts an empty file entry', () => {
    expect(parseTar(tarOf(tarEntry('empty', Buffer.alloc(0)))).get('empty')).toHaveLength(0);
  });

  it.each([
    ['an entry cut short', (tar: Buffer) => tar.subarray(0, 700)],
    ['a missing end marker', (tar: Buffer) => tar.subarray(0, tar.length - 1024)],
    ['an empty stream', () => Buffer.alloc(0)],
    [
      'a corrupted header',
      (tar: Buffer) => {
        const copy = Buffer.from(tar);
        copy[3] = copy[3] === 0x41 ? 0x42 : 0x41;
        return copy;
      },
    ],
  ])('rejects %s as a transient adb error', (_label, damage) => {
    const tar = tarOf(tarEntry('viber_data', Buffer.alloc(900, 1)));
    const error = (() => {
      try {
        parseTar(damage(tar));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(AdbError);
    expect(isTransientAdbError(error)).toBe(true);
  });
});

describe('Adb.readFileSet', () => {
  async function readSet(names: string[], listing: string, tar: Buffer, dirName = '/data/data/com.viber.voip/databases') {
    const tarPath = join(dir, 'archive.tar');
    const log = join(dir, 'adb.log');
    writeFileSync(tarPath, tar);
    const adbPath = fakeAdb(`
case "$*" in
  *devices*) printf 'List of devices attached\\nemu\\tdevice\\n\\n' ;;
  *exec-out*) printf '%s\\n' "$*" >> '${log}'; cat '${tarPath}' ;;
  *"id -u"*) echo 0 ;;
  *"[ -f"*) printf '%s\\n' "$*" >> '${log}'; printf '%s\\n' ${listing} ;;
esac`);
    const adb = await Adb.connect({ adbPath, serial: 'emu' });
    const files = await adb.readFileSet(dirName, names);
    return { files, log: readFileSync(log, 'utf8') };
  }

  it('reads the database and its WAL from one tar stream with quoted paths', async () => {
    const { files, log } = await readSet(
      ['viber_data', 'viber_data-wal', 'viber_data-shm'],
      "viber_data viber_data-wal",
      tarOf(tarEntry('viber_data', Buffer.from('main')), tarEntry('viber_data-wal', Buffer.from('wal'))),
    );
    expect(files.get('viber_data')?.toString()).toBe('main');
    expect(files.get('viber_data-wal')?.toString()).toBe('wal');
    expect(files.has('viber_data-shm')).toBe(false);
    expect(log).toContain("cd '/data/data/com.viber.voip/databases' && tar -cf - 'viber_data' 'viber_data-wal'");
    expect(log.match(/exec-out/g)).toHaveLength(1);
  });

  it('quotes hostile file names for the device shell', async () => {
    const hostile = "x'; touch /tmp/pwned; '";
    const { log } = await readSet([hostile], `"${hostile}"`, tarOf(tarEntry(hostile, Buffer.from('d'))));
    expect(log).toContain(`tar -cf - ${shQuote(hostile)}`);
    expect(log).toContain(`[ -f ${shQuote(hostile)} ] && echo ${shQuote(hostile)}`);
  });

  it('returns an empty map when none of the files exist and fails transiently on a short archive', async () => {
    const none = await readSet(['viber_data'], "''", Buffer.alloc(0));
    expect(none.files.size).toBe(0);
    const error = await readSet(['viber_data'], 'viber_data', Buffer.alloc(100)).catch((e: unknown) => e);
    expect(isTransientAdbError(error)).toBe(true);
  });
});
