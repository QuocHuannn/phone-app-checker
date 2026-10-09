import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterEach, describe, expect, it } from 'vitest';
import { formatReportCsv, neutralizeFormula, REPORT_COLUMNS, writeReport, type ReportRow } from '../src/report.ts';
import { normalizePhone } from '../src/phone.ts';
import { Prng } from './helpers/prng.ts';
import { reportRows, SAMPLE_STATUSES, statusesFor } from './helpers/report-rows.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already removed
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checker-report-fuzz-'));
  dirs.push(dir);
  return dir;
}

function row(input: string, e164 = '', overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    input,
    e164,
    country: e164 === '' ? '' : 'VN',
    statuses: e164 === '' ? statusesFor({}, 'invalid') : SAMPLE_STATUSES,
    observations: {},
    lastCheckedAt: undefined,
    ...overrides,
  };
}

const NOT_ROOT = process.getuid?.() !== 0;

describe('formula escaping fuzz', () => {
  const FRAGMENTS = [
    '=', '+', '-', '@', '\t', '\r', '\n', ' ', '  ', '\u00a0', '\u200f', '\u200b', '\ufeff', '\u2028', '＝', '＋', '－', '＠', '−',
    'cmd', '|', '!', 'A1', 'SUM(1,2)', 'HYPERLINK("http://evil","x")', '"', "'", ',', ';', '\\', '0901234567', '84', '(', ')', '.', '😀', 'Số điện thoại', 'é', 'e\u0301', '中文', 'العربية',
  ];
  const TRIGGER = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/;

  it('never lets a customer-supplied cell start as a formula, and loses no content (20000 strings)', () => {
    const prng = new Prng(8675309);
    const rows: ReportRow[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      let input = '';
      for (let j = prng.range(0, 8); j > 0; j -= 1) input += prng.pick(FRAGMENTS);
      // Half of the rows are valid numbers: those keep plain phone text readable, nothing else.
      const valid = prng.chance(0.3) && normalizePhone(input, 'VN') !== null;
      rows.push(row(input, valid ? '+84901234567' : ''));
    }
    const text = formatReportCsv(rows);
    const parsed = parse(text, { relax_column_count: false }) as string[][];
    expect(parsed).toHaveLength(rows.length + 1);
    expect(parsed[0]).toEqual([...REPORT_COLUMNS]);
    let neutralized = 0;
    for (const [index, source] of rows.entries()) {
      const cells = parsed[index + 1] as string[];
      expect(cells, `row ${index}`).toHaveLength(REPORT_COLUMNS.length);
      const cell = cells[0] as string;
      const plainPhone = source.e164 !== '' && /^\+?[\d ().-]+$/.test(source.input);
      if (plainPhone) {
        expect(cell).toBe(source.input);
      } else if (cell !== source.input) {
        // The only permitted change is the leading apostrophe on a cell that would be a formula.
        expect(cell, `row ${index}`).toBe(`'${source.input}`);
        neutralized += 1;
      } else {
        expect(TRIGGER.test(cell), `row ${index}: ${JSON.stringify(cell)}`).toBe(false);
        expect(/^[\s\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(cell), `row ${index}: ${JSON.stringify(cell)}`).toBe(false);
      }
      // Our own columns are never influenced by the input text.
      expect(cells[1]).toBe(source.e164);
      expect(cells.slice(3, 8)).toEqual(REPORT_COLUMNS.slice(3, 8).map((app) => source.statuses[app as keyof typeof source.statuses]));
    }
    expect(neutralized).toBeGreaterThan(1000);
  });

  it('neutralizeFormula is idempotent in effect: the result never starts with a trigger and a second pass only adds quotes to formulas', () => {
    const prng = new Prng(5);
    for (let i = 0; i < 5000; i += 1) {
      let input = '';
      for (let j = prng.range(0, 6); j > 0; j -= 1) input += prng.pick(FRAGMENTS);
      const once = neutralizeFormula(input);
      expect(once === input || once === `'${input}`).toBe(true);
      expect(/^[\s\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(once) || TRIGGER.test(once)).toBe(false);
      expect(neutralizeFormula(once)).toBe(once);
    }
  });

  it('keeps quotes, commas, newlines and unicode round-trippable through a strict CSV parser', () => {
    const prng = new Prng(11);
    const inputs = Array.from({ length: 3000 }, () => {
      let input = 'x';
      for (let j = prng.range(1, 10); j > 0; j -= 1) input += prng.pick(FRAGMENTS);
      return input;
    });
    const parsed = parse(formatReportCsv(inputs.map((input) => row(input))), { columns: true }) as Record<string, string>[];
    expect(parsed.map((r) => r.input)).toEqual(inputs);
    const bytes = Buffer.from(formatReportCsv(inputs.map((input) => row(input))), 'utf8');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it('is deterministic whatever the order of the status keys', () => {
    const a = row('x', '+84901234567', { statuses: { ...SAMPLE_STATUSES, whatsapp: 'no_such' as never } });
    const b = row('x', '+84901234567', { statuses: Object.fromEntries(Object.entries({ ...SAMPLE_STATUSES, whatsapp: 'no_such' }).reverse()) as typeof SAMPLE_STATUSES });
    expect(formatReportCsv([a])).toBe(formatReportCsv([b]));
  });
});

describe('writing the report', () => {
  it('writes 100,000 rows quickly, atomically, privately and leaves only the report behind', () => {
    const dir = tempDir();
    const out = join(dir, 'report.csv');
    const rows = reportRows(1, 0, 100_000);
    const started = performance.now();
    const previous = process.umask(0o000);
    try {
      writeReport(out, rows);
    } finally {
      process.umask(previous);
    }
    expect(performance.now() - started).toBeLessThan(45_000); // generous: stays valid on a loaded machine
    expect(readdirSync(dir)).toEqual(['report.csv']);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8').split('\n')).toHaveLength(100_002);
  });

  it('a failure while formatting leaves the previous report untouched and no temp file', () => {
    const dir = tempDir();
    const out = join(dir, 'report.csv');
    writeReport(out, reportRows(1, 0, 10));
    const before = readFileSync(out);
    const poisoned = reportRows(2, 0, 10);
    Object.defineProperty(poisoned[5], 'input', {
      get() {
        throw new Error('cannot render this row');
      },
    });
    expect(() => writeReport(out, poisoned)).toThrow('cannot render this row');
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['report.csv']);
  });

  it.runIf(NOT_ROOT)('a read-only directory fails with the OS reason and keeps the previous report', () => {
    const dir = tempDir();
    const out = join(dir, 'report.csv');
    writeReport(out, reportRows(1, 0, 10));
    const before = readFileSync(out);
    chmodSync(dir, 0o500);
    expect(() => writeReport(out, reportRows(2, 0, 10))).toThrow(/EACCES/);
    chmodSync(dir, 0o700);
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['report.csv']);
  });

  it.runIf(NOT_ROOT)('a read-only previous report is replaced by a fresh private file (the directory permits it)', () => {
    const dir = tempDir();
    const out = join(dir, 'report.csv');
    writeReport(out, reportRows(1, 0, 10));
    chmodSync(out, 0o400);
    writeReport(out, reportRows(2, 0, 10));
    expect(readFileSync(out, 'utf8')).toContain('writer-2-');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('a missing output directory is an error, not a silent mkdir', () => {
    const dir = tempDir();
    expect(() => writeReport(join(dir, 'nope', 'report.csv'), reportRows(1, 0, 1))).toThrow(/ENOENT/);
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });

  it('with --force a symlinked destination is replaced itself, never written through', () => {
    const dir = tempDir();
    const target = join(dir, 'precious.txt');
    writeFileSync(target, 'keep me');
    const out = join(dir, 'report.csv');
    symlinkSync(target, out);
    expect(() => writeReport(out, reportRows(1, 0, 3))).toThrow(/symbolic link/);
    writeReport(out, reportRows(1, 0, 3), { force: true });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(statSync(out).isFile()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['precious.txt', 'report.csv']);
  });

  it('removes temp files that killed writers left behind, but only old ones with this report\'s exact pattern', () => {
    const dir = tempDir();
    const hour = Date.now() / 1000 - 3600;
    const plant = (name: string, old: boolean, content = 'partial customer data') => {
      const path = join(dir, name);
      writeFileSync(path, content);
      if (old) utimesSync(path, hour, hour);
      return path;
    };
    for (const base of ['report.csv', 'báo cáo (1)+a.csv']) {
      const out = join(dir, base);
      const staleA = `.${base}.0123456789abcdef.tmp`;
      const staleB = `.${base}.fedcba9876543210.tmp`;
      const young = `.${base}.aaaaaaaaaaaaaaaa.tmp`;
      const otherReport = `.other-${base}.0123456789abcdef.tmp`;
      const wrongSuffix = `.${base}.0123456789abcdef.tmp.bak`;
      const notHex = `.${base}.0123456789abcdeg.tmp`;
      plant(staleA, true);
      plant(staleB, true);
      plant(young, false);
      plant(otherReport, true);
      plant(wrongSuffix, true);
      plant(notHex, true);
      mkdirSync(join(dir, `.${base}.bbbbbbbbbbbbbbbb.tmp`));
      utimesSync(join(dir, `.${base}.bbbbbbbbbbbbbbbb.tmp`), hour, hour);
      symlinkSync(join(dir, staleA), join(dir, `.${base}.cccccccccccccccc.tmp`));
      writeReport(out, reportRows(1, 0, 3));
      const left = readdirSync(dir);
      expect(left).not.toContain(staleA);
      expect(left).not.toContain(staleB);
      for (const kept of [young, otherReport, wrongSuffix, notHex, `.${base}.bbbbbbbbbbbbbbbb.tmp`, `.${base}.cccccccccccccccc.tmp`]) {
        expect(left, kept).toContain(kept);
      }
    }
  });

  it('survives unicode file names', () => {
    const dir = tempDir();
    const out = join(dir, 'báo cáo 😀.csv');
    writeReport(out, reportRows(1, 0, 3));
    expect(readdirSync(dir)).toEqual(['báo cáo 😀.csv']);
  });
});

describe('concurrent writers', () => {
  it('six processes writing one path: every read sees one complete report, none torn, no temp files left', async () => {
    const dir = tempDir();
    const out = join(dir, 'report.csv');
    const writers = 6;
    const iterations = 25;
    const expected = new Set<string>();
    for (let id = 1; id <= writers; id += 1) for (const variant of [0, 1]) expected.add(formatReportCsv(reportRows(id, variant)));
    writeReport(out, reportRows(1, 0));

    const fixture = join(import.meta.dirname, 'fixtures', 'report-writer.ts');
    const children = Array.from({ length: writers }, (_, index) =>
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, out, String(index + 1), String(iterations)], { stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    const exits = children.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('exit', (code) => resolve({ code, stderr }));
        }),
    );
    let running = true;
    void Promise.all(exits).then(() => {
      running = false;
    });
    let reads = 0;
    let torn = 0;
    while (running) {
      const text = readFileSync(out, 'utf8');
      reads += 1;
      if (!expected.has(text)) torn += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const result of await Promise.all(exits)) expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(torn, `${torn} of ${reads} reads were not a complete report`).toBe(0);
    expect(reads).toBeGreaterThan(5);
    expect(expected.has(readFileSync(out, 'utf8'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['report.csv']);
  }, 120_000);
});
