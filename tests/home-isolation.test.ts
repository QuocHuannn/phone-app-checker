import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lifecycleDir } from '../src/lock.ts';
import { diffSnapshots, GUARDED_PREFIX, realAppSupportDir, snapshotGuarded } from './helpers/real-home-guard.ts';

describe('test HOME isolation (tests/setup/isolate-home.ts)', () => {
  it('HOME is a temp dir, not the real home', () => {
    const real = userInfo().homedir;
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME).not.toBe(real);
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(homedir()).toBe(process.env.HOME);
  });

  it('the default lifecycle directory resolves under the temp HOME', () => {
    const dir = lifecycleDir();
    expect(dir.startsWith(process.env.HOME as string)).toBe(true);
    expect(dir.startsWith(realAppSupportDir())).toBe(false);
  });

  it('PHONE_APP_CHECKER_HOME is not inherited from the shell', () => {
    expect(process.env.PHONE_APP_CHECKER_HOME).toBeUndefined();
  });
});

describe('real-home guard (tests/helpers/real-home-guard.ts)', () => {
  let appSupport: string;

  beforeEach(() => {
    appSupport = mkdtempSync(join(tmpdir(), 'guard-appsupport-'));
    mkdirSync(join(appSupport, `${GUARDED_PREFIX}-lifecycle`, 'shared'), { recursive: true });
    mkdirSync(join(appSupport, 'SomethingElse'));
  });

  afterEach(() => {
    rmSync(appSupport, { recursive: true, force: true });
  });

  it('reports nothing when guarded entries are untouched', () => {
    const before = snapshotGuarded(appSupport);
    expect(diffSnapshots(before, snapshotGuarded(appSupport))).toEqual([]);
  });

  it('reports a file written below a guarded directory, and a new guarded directory', () => {
    const before = snapshotGuarded(appSupport);
    writeFileSync(join(appSupport, `${GUARDED_PREFIX}-lifecycle`, 'shared', '1.x'), '');
    mkdirSync(join(appSupport, GUARDED_PREFIX));
    const changes = diffSnapshots(before, snapshotGuarded(appSupport));
    expect(changes).toContain(`created  ${join(appSupport, `${GUARDED_PREFIX}-lifecycle`, 'shared', '1.x')}`);
    expect(changes).toContain(`created  ${join(appSupport, GUARDED_PREFIX)}`);
  });

  it('reports a removed guarded entry and ignores unrelated siblings', () => {
    const before = snapshotGuarded(appSupport);
    rmSync(join(appSupport, `${GUARDED_PREFIX}-lifecycle`, 'shared'), { recursive: true });
    writeFileSync(join(appSupport, 'SomethingElse', 'x'), 'unrelated');
    const changes = diffSnapshots(before, snapshotGuarded(appSupport));
    expect(changes.some((line) => line.startsWith('removed') && line.endsWith('shared'))).toBe(true);
    expect(changes.some((line) => line.includes('SomethingElse'))).toBe(false);
  });
});
