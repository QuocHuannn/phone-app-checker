import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The release bundle and `npm run build` ship compiled JavaScript, not TypeScript sources. These
 * checks run the emitted tree end to end: the layout, the rewritten imports, and package-relative
 * files (package.json / checker.config.example.json) that src/home.ts must find from build/js.
 */

const ROOT = resolve(import.meta.dirname, '..');
const BUILD = join(ROOT, 'build', 'js');
const ENTRY = join(BUILD, 'bin', 'phone-app-checker.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pac-build-test-'));
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Fresh process in a temp cwd: doctor creates ./data there, never in the repository. */
function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(work, 'run-'));
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '' };
}

describe('npm run build output (build/js)', () => {
  it('emits the release layout as JavaScript only', () => {
    expect(existsSync(ENTRY)).toBe(true);
    expect(existsSync(join(BUILD, 'src', 'cli.js'))).toBe(true);
    expect(readFileSync(ENTRY, 'utf8')).toContain("import('../src/cli.js')");
    const emitted = readdirSync(BUILD, { recursive: true }) as string[];
    expect(emitted.filter((file) => file.endsWith('.ts'))).toEqual([]);
  });

  it('runs --version and --help from the compiled tree', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const version = run(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(pkg.version);
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: phone-app-checker');
    expect(help.stderr).toBe('');
  });

  it('doctor runs from the compiled tree and reports every app row', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const version = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = run(['doctor']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(new RegExp(`^OK\\s+version\\s+${version}\\b`, 'm'));
    expect(result.stdout).toMatch(/^OK\s+runtime/m);
    expect(result.stdout).toMatch(/^OK\s+viber\s+disabled \(adapter available\)/m);
  });
});
