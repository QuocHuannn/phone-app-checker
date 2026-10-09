import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeReport } from '../src/report.ts';
import { reportRows } from './helpers/report-rows.ts';

/*
 * Disk faults inside the report writer. node:fs is wrapped so a chosen call fails the way a full
 * or failing disk would; everything else is the real file system.
 */
const faults = vi.hoisted(() => ({ writeSync: undefined as undefined | ((call: number) => number | undefined), fsyncSync: undefined as undefined | (() => void), renameSync: undefined as undefined | (() => void), writes: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((fd: number, data: NodeJS.ArrayBufferView, offset: number, length: number) => {
      faults.writes += 1;
      // A hook may answer with a byte limit: the disk accepts only that much of this write.
      const limit = faults.writeSync?.(faults.writes);
      return actual.writeSync(fd, data, offset, limit === undefined ? length : Math.min(length, limit));
    }) as typeof actual.writeSync,
    fsyncSync: (fd: number) => {
      faults.fsyncSync?.();
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      faults.renameSync?.();
      actual.renameSync(from, to);
    },
  };
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checker-report-fault-'));
  faults.writeSync = undefined;
  faults.fsyncSync = undefined;
  faults.renameSync = undefined;
  faults.writes = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('report writer under disk faults', () => {
  const faultCases: [string, () => void, RegExp][] = [
    ['disk full on the first write', () => (faults.writeSync = () => { throw errno('ENOSPC', 'no space left on device, write'); }), /ENOSPC/],
    ['disk full after a short first write', () => (faults.writeSync = (call) => { if (call >= 2) throw errno('ENOSPC', 'no space left on device, write'); return 1000; }), /ENOSPC/],
    ['I/O error on fsync', () => (faults.fsyncSync = () => { throw errno('EIO', 'input/output error, fsync'); }), /EIO/],
    ['rename refused', () => (faults.renameSync = () => { throw errno('EXDEV', 'cross-device link not permitted, rename'); }), /EXDEV/],
  ];

  it.each(faultCases)('%s: the previous report stays intact, no temp file is left, and the error says why', (_name, inject, pattern) => {
    const out = join(dir, 'report.csv');
    writeReport(out, reportRows(1, 0, 4000));
    const before = readFileSync(out);
    faults.writes = 0;
    inject();
    expect(() => writeReport(out, reportRows(2, 0, 4000))).toThrow(pattern);
    faults.writeSync = undefined;
    faults.fsyncSync = undefined;
    faults.renameSync = undefined;
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['report.csv']);
    // And the next attempt, once the fault is gone, succeeds.
    writeReport(out, reportRows(2, 0, 4000));
    expect(readFileSync(out, 'utf8')).toContain('writer-2-');
  });

  it('a fault on the very first report leaves no partial file behind', () => {
    const out = join(dir, 'report.csv');
    faults.writeSync = () => {
      throw errno('ENOSPC', 'no space left on device, write');
    };
    expect(() => writeReport(out, reportRows(1, 0, 10))).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
