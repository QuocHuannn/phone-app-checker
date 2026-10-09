import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/viber-discover-schema.sh');
const DB_DIR = '/data/data/com.viber.voip/databases';

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'viber-script-'));
  log = join(dir, 'adb.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executable(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Fake adb: records every argument list; the device exposes one plain and one hostile file name. */
function fakeAdb(rootUid: string): string {
  return executable(
    'adb',
    `
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *get-state*) echo device ;;
  *"pm path"*) echo package:/data/app/viber ;;
  *dumpsys*) echo 'versionName=1.2.3' ;;
  "shell id -u") echo ${rootUid} ;;
  *"su -c 'id -u'"*) echo 0 ;;
  *"ls -1"*) printf 'good.db\\n%s\\n..\\n' "evil'; touch ${join(dir, 'PWNED')}; '.db" ;;
  *"test -f"*) echo yes ;;
  *exec-out*) printf 'not sqlite' ;;
  root) exit 1 ;;
esac`,
  );
}

function runScript(rootUid: string, env: Record<string, string> = {}) {
  executable('sqlite3', 'exit 0');
  executable('sleep', 'exit 0');
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, ADB: fakeAdb(rootUid), ...env },
    timeout: 30_000,
  });
}

const adbLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

describe('scripts/viber-discover-schema.sh', () => {
  it('is syntactically valid bash', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('never lets an app-owned file name reach a root shell (adbd root)', () => {
    const result = runScript('0');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('unsafe name');
    const commands = adbLog();
    expect(commands).not.toContain('touch');
    expect(commands).not.toContain('evil');
    expect(commands).toContain(`shell test -f '${DB_DIR}/good.db' && echo yes || echo no`);
    expect(commands).toContain(`exec-out cat '${DB_DIR}/good.db'`);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });

  it('quotes every layer of the su -c command and still skips hostile names (su root)', () => {
    const result = runScript('2000');
    expect(result.status).toBe(0);
    const commands = adbLog();
    expect(commands).not.toContain('touch');
    expect(commands).toContain(`shell su -c 'ls -1 '\\''${DB_DIR}'\\'' 2>/dev/null || true'`);
    expect(commands).toContain(`shell su -c 'test -f '\\''${DB_DIR}/good.db'\\'' && echo yes || echo no'`);
    expect(commands).toContain(`exec-out su -c 'cat '\\''${DB_DIR}/good.db'\\'''`);
  });

  it('rejects a package id that is not a plain Android package name before touching adb', () => {
    const result = runScript('0', { VIBER_PACKAGE: "com.viber.voip; touch pwned #" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VIBER_PACKAGE');
    expect(adbLog()).toBe('');
  });
});
