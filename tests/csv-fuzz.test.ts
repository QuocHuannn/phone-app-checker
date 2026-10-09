import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeCsvBytes, parsePhoneCsv, readPhoneCsv } from '../src/csv.ts';
import { Prng } from './helpers/prng.ts';

const dir = mkdtempSync(join(tmpdir(), 'checker-csv-fuzz-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = { defaultRegion: 'VN' };
let fileNo = 0;

function writeTemp(bytes: Buffer | string): string {
  fileNo += 1;
  const path = join(dir, `input-${fileNo}.csv`);
  writeFileSync(path, bytes);
  return path;
}

function utf16le(text: string, bom = true): Buffer {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from(text, 'utf16le')).swap16()]);
}

describe('encodings and line endings', () => {
  const rows = [
    ['Họ tên', 'Số điện thoại', 'Ghi chú'],
    ['Nguyễn Văn An', '0901234567', 'khách quen'],
    ['Trần Thị Bình', '+84 91 234 5678', 'đã gọi'],
    ['Lê Cường', '84912345678', 'trùng số Bình'],
  ];
  const expected = ['+84901234567', '+84912345678'];
  const encode = (delimiter: string, eol: string) => rows.map((row) => row.join(delimiter)).join(eol) + eol;

  it.each([
    ['UTF-8 with BOM', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encode(',', '\r\n'))])],
    ['UTF-8 without BOM', () => Buffer.from(encode(',', '\n'))],
    ['UTF-16LE with BOM, tab separated (Excel "Unicode Text")', () => utf16le(encode('\t', '\r\n'))],
    ['UTF-16LE with BOM, comma separated', () => utf16le(encode(',', '\r\n'))],
    ['UTF-16BE with BOM', () => utf16be(encode('\t', '\n'))],
    ['CR-only line endings (old Mac Excel)', () => Buffer.from(encode(',', '\r'))],
    ['semicolon separated (EU locale Excel)', () => Buffer.from(encode(';', '\r\n'))],
    ['tab separated', () => Buffer.from(encode('\t', '\n'))],
    ['no trailing newline', () => Buffer.from(encode(',', '\n').trimEnd())],
  ])('reads %s from disk', (_name, make) => {
    const parsed = readPhoneCsv(writeTemp(make()), OPTIONS);
    expect(parsed.column).toBe('Số điện thoại');
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.entries.map((e) => e.phone?.e164)).toEqual(expected);
    expect(parsed.rows).toBe(3);
    expect(parsed.duplicates).toBe(1);
    // Vietnamese text survives decoding intact (the report echoes the input cell verbatim).
    expect(parsed.entries[0]?.input).toBe('0901234567');
  });

  it('decodes Vietnamese header text from UTF-16 exactly', () => {
    expect(decodeCsvBytes(utf16le('Số điện thoại\r\n'))).toBe('Số điện thoại\r\n');
    expect(decodeCsvBytes(utf16be('Số điện thoại\r\n'))).toBe('Số điện thoại\r\n');
  });

  it('sniffs the delimiter per file even when CR-only data holds more commas than the header has', () => {
    const text = ['name;note;phone', 'An;"a, b, c, d, e, f";0901234567', 'Binh;1, 2, 3, 4, 5, 6, 7;0912345678'].join('\r');
    const parsed = parsePhoneCsv(text, OPTIONS);
    expect(parsed.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567', '+84912345678']);
    expect(parsed.column).toBe('phone');
  });

  it('handles quoted multi-line cells, escaped quotes and ragged rows', () => {
    const text = [
      'name,note,phone',
      '"An\nNguyen","line1\nline2, with ""quote"" and comma",0901234567',
      'Binh',
      'Chi,x,0912345678,extra,more,columns',
      '"",,',
      'Dung,"multi\r\nline",+65 9123 4567',
      '',
    ].join('\n');
    const parsed = parsePhoneCsv(text, OPTIONS);
    expect(parsed.entries.map((e) => [e.input, e.phone?.e164 ?? null])).toEqual([
      ['0901234567', '+84901234567'],
      ['', null],
      ['0912345678', '+84912345678'],
      ['+65 9123 4567', '+6591234567'],
    ]);
    expect(parsed.rows).toBe(5);
    expect(parsed.duplicates).toBe(1);
  });

  it('reads an unterminated quote as a clear parse error, not a hang or a partial list', () => {
    expect(() => parsePhoneCsv('name,phone\n"A,0901234567\nB,0912345678\n', OPTIONS)).toThrow(/Cannot parse CSV/);
  });

  it('tolerates stray quotes in the middle of a cell', () => {
    const parsed = parsePhoneCsv('name,phone\nA "x" B,0901234567\n5" nail,0912345678\n', OPTIONS);
    expect(parsed.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567', '+84912345678']);
  });
});

describe('header detection', () => {
  const headers = [
    'Số điện thoại',
    'SỐ ĐIỆN THOẠI',
    'Số  điện   thoại',
    'Điện thoại',
    'Điện thoại di động',
    'Số di động',
    'SDT',
    'SĐT',
    'sdt khach hang',
    'Phone',
    'PHONE NUMBER',
    'phone_number',
    'Mobile',
    'Mobile No.',
    'Cellphone',
    'Telephone',
    'Tel',
    'Zalo',
  ];
  it.each(headers)('picks column %j from the header', (header) => {
    const parsed = parsePhoneCsv(`id,${header},email\n1,0901234567,a@example.com\n2,0912345678,b@example.com\n`, OPTIONS);
    expect(parsed.column).toBe(header);
    expect(parsed.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567', '+84912345678']);
  });

  it('falls back to the column whose cells are phone numbers when no header word matches', () => {
    const parsed = parsePhoneCsv('Mã KH,Liên hệ,Địa chỉ\nK1,0901234567,Hà Nội\nK2,0912345678,Huế\n', OPTIONS);
    expect(parsed.column).toBe('Liên hệ');
    expect(parsed.entries).toHaveLength(2);
  });

  it('uses the first of several phone-like columns and ignores the other', () => {
    for (const text of ['phone,phone\n0901234567,0912345678\n', 'Phone,Mobile\n0901234567,0912345678\n', 'Mobile,Phone\n0901234567,0912345678\n']) {
      const parsed = parsePhoneCsv(text, OPTIONS);
      expect(parsed.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567']);
    }
  });

  it('honours --column by name (case-insensitive) and by 1-based index, and explains failures', () => {
    const text = 'id,Primary,Secondary\n1,0901234567,0912345678\n';
    expect(parsePhoneCsv(text, { ...OPTIONS, column: 'secondary' }).entries[0]?.phone?.e164).toBe('+84912345678');
    expect(parsePhoneCsv(text, { ...OPTIONS, column: '3' }).entries[0]?.phone?.e164).toBe('+84912345678');
    for (const bad of ['0', '-1', '4', '2.5', 'nope']) {
      expect(() => parsePhoneCsv(text, { ...OPTIONS, column: bad }), bad).toThrow(/not found/);
    }
  });

  it('treats a file without header as data', () => {
    const parsed = parsePhoneCsv('An,0901234567\nBinh,0912345678\n', OPTIONS);
    expect(parsed).toMatchObject({ hasHeader: false, column: '#2', rows: 2 });
    const single = parsePhoneCsv('0901234567\n0912345678\n', OPTIONS);
    expect(single).toMatchObject({ hasHeader: false, column: '#1', rows: 2 });
  });

  it('does not mistake an invalid customer number in the first row for a header', () => {
    const parsed = parsePhoneCsv('0901234567x\n0912345678\n', OPTIONS);
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.entries.map((e) => e.input)).toEqual(['0901234567x', '0912345678']);
  });
});

describe('degenerate files', () => {
  it('rejects empty and whitespace-only files as empty', () => {
    for (const text of ['', '\n', '\r\n\r\n', '   \n\t\n', ',,\n,,\n', '\ufeff']) {
      expect(() => parsePhoneCsv(text, OPTIONS), JSON.stringify(text)).toThrow(/empty/);
    }
    expect(() => readPhoneCsv(writeTemp(''), OPTIONS)).toThrow(/empty/);
    expect(() => readPhoneCsv(writeTemp(utf16le('')), OPTIONS)).toThrow(/empty/);
  });

  it('accepts a header-only file as zero numbers', () => {
    for (const text of ['name,phone\n', 'name,phone', 'phone\r\n', '\ufeffSố điện thoại\r\n']) {
      const parsed = parsePhoneCsv(text, OPTIONS);
      expect(parsed.entries, JSON.stringify(text)).toEqual([]);
      expect(parsed.rows).toBe(0);
      expect(parsed.hasHeader).toBe(true);
    }
  });

  it('refuses binary files with a Save-As hint instead of parsing garbage', () => {
    const xlsxLike = Buffer.concat([Buffer.from('PK\u0003\u0004\u0014\u0000\u0006\u0000'), Buffer.alloc(64, 0), Buffer.from('[Content_Types].xml')]);
    expect(() => readPhoneCsv(writeTemp(xlsxLike), OPTIONS)).toThrow(/not a plain-text CSV.*CSV UTF-8/s);
    const prng = new Prng(77);
    for (let i = 0; i < 25; i += 1) {
      const bytes = Buffer.from(Array.from({ length: prng.range(1, 5000) }, () => prng.int(256)));
      if (bytes[0] === 0xff || bytes[0] === 0xfe) continue; // would be read as UTF-16 by design
      let message = '';
      try {
        readPhoneCsv(writeTemp(bytes), OPTIONS);
      } catch (error) {
        message = (error as Error).message;
      }
      // Garbage never yields numbers, never crashes with a non-Error, and never dumps raw bytes.
      expect(message, `seed 77 case ${i}`).not.toBe('');
      expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\uFFFD]/);
      expect(message.length).toBeLessThan(2000);
    }
  });

  it('handles UTF-16 without BOM or a lone BOM byte as an error, not a crash', () => {
    expect(() => readPhoneCsv(writeTemp(utf16le('phone\r\n0901234567\r\n', false)), OPTIONS)).toThrow(/not a plain-text CSV/);
    expect(() => readPhoneCsv(writeTemp(Buffer.from([0xff])), OPTIONS)).toThrow();
  });

  it('keeps error messages short and printable even with huge or hostile header cells', () => {
    const hostile = `\u001b[31m${'A'.repeat(100_000)}\u001b[0m\u0000`;
    let message = '';
    try {
      parsePhoneCsv(`${hostile},other\nx,y\n`, OPTIONS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Cannot find a phone column/);
    expect(message.length).toBeLessThan(400);
    expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(() => parsePhoneCsv('a,b\n1,2\n', { ...OPTIONS, column: 'zzz' })).toThrow(/Columns: 1:"a", 2:"b"/);
    const wide = Array.from({ length: 500 }, (_, i) => `c${i}`).join(',');
    let wideMessage = '';
    try {
      parsePhoneCsv(`${wide}\n${wide}\n`, OPTIONS);
    } catch (error) {
      wideMessage = (error as Error).message;
    }
    expect(wideMessage.length).toBeLessThan(500);
    expect(wideMessage).toMatch(/more\)/);
  });

  it('survives a 5 MB cell in any position and a 2 MB digit string as a phone cell', () => {
    const huge = 'x'.repeat(5_000_000);
    const started = performance.now();
    expect(parsePhoneCsv(`${huge},phone\nA,0901234567\n`, OPTIONS).entries).toHaveLength(1);
    expect(parsePhoneCsv(`name,phone\n${huge},0901234567\nB,0912345678\n`, OPTIONS).entries).toHaveLength(2);
    const longDigits = parsePhoneCsv(`phone\n${'9'.repeat(2_000_000)}\n0912345678\n`, OPTIONS);
    expect(longDigits.entries.map((e) => e.phone?.e164 ?? null)).toEqual([null, '+84912345678']);
    expect(performance.now() - started).toBeLessThan(45_000); // catastrophic-backtracking guard, below the 60 s test timeout
  });
});

describe('randomised round trip', () => {
  const PHONE_HEADERS = ['Số điện thoại', 'SDT', 'Phone', 'Mobile', 'Điện thoại', 'Tel'];
  const SPELLINGS = [
    (n: string) => `0${n}`,
    (n: string) => `+84${n}`,
    (n: string) => `84${n}`,
    (n: string) => `0084${n}`,
    (n: string) => `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`,
    (n: string) => `+84 ${n.slice(0, 2)}-${n.slice(2, 5)}-${n.slice(5)}`,
    (n: string) => `'0${n}`,
    (n: string) => `${n}`,
    (n: string) => `0${n}.0`,
  ];
  const NOTES = ['plain', 'has, comma', 'has "quote"', 'two\nlines', 'semi;colon', 'tab\there', 'đã gọi', ''];

  function cell(value: string, delimiter: string, prng: Prng): string {
    const needs = /["\r\n]/.test(value) || value.includes(delimiter);
    return needs || prng.chance(0.2) ? `"${value.replaceAll('"', '""')}"` : value;
  }

  for (let round = 0; round < 40; round += 1) {
    it(`round ${round}: layout, delimiter, line endings and spellings do not change the result`, () => {
      const prng = new Prng(1000 + round);
      const delimiter = prng.pick([',', ';', '\t']);
      const eol = prng.pick(['\n', '\r\n', '\r']);
      const phoneIndex = prng.int(4);
      const names = ['id', 'name', 'email', 'note'];
      const header = [...names.slice(0, phoneIndex), prng.pick(PHONE_HEADERS), ...names.slice(phoneIndex)];
      const rowCount = prng.range(1, 60);
      const lines = [header.map((h) => cell(h, delimiter, prng)).join(delimiter)];
      const expected: (string | null)[] = [];
      const seen = new Set<string>();
      let duplicates = 0;
      for (let r = 0; r < rowCount; r += 1) {
        const kind = prng.int(10);
        let phoneText: string;
        let key: string;
        let e164: string | null;
        if (kind === 0) {
          phoneText = prng.pick(['abc', 'N/A', '12345', '']);
          e164 = null;
          key = `invalid:${phoneText.trim()}`;
        } else {
          const national = `${prng.pick(['90', '91', '93', '98', '97', '32', '86'])}${prng.digits(7)}`;
          phoneText = prng.pick(SPELLINGS)(national);
          e164 = `+84${national}`;
          key = e164;
        }
        const cells = [String(r), `Khách ${r}`, `u${r}@example.com`, prng.pick(NOTES)];
        cells.splice(phoneIndex, 0, phoneText);
        lines.push(cells.map((c) => cell(c, delimiter, prng)).join(delimiter));
        if (seen.has(key)) duplicates += 1;
        else {
          seen.add(key);
          expected.push(e164);
        }
      }
      const text = (prng.chance(0.3) ? '\ufeff' : '') + lines.join(eol) + (prng.chance(0.5) ? eol : '');
      const parsed = parsePhoneCsv(text, OPTIONS);
      expect(parsed.hasHeader, `seed ${1000 + round}`).toBe(true);
      expect(parsed.entries.map((e) => e.phone?.e164 ?? null)).toEqual(expected);
      expect(parsed.rows).toBe(rowCount);
      expect(parsed.duplicates).toBe(duplicates);
    });
  }
});

describe('scale', () => {
  it('parses 100,000 rows quickly with a bounded memory footprint and merges duplicates', () => {
    const prng = new Prng(424242);
    const lines = ['id,name,Số điện thoại,email,note'];
    const unique = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      const national = `${prng.pick(['90', '91', '93', '98', '97'])}${prng.digits(7)}`;
      unique.add(national);
      const spelling = i % 3 === 0 ? `0${national}` : i % 3 === 1 ? `+84 ${national}` : `84${national}`;
      lines.push(`${i},Nguyen Van ${i},${spelling},u${i}@example.com,"note, with comma ${i}"`);
    }
    const text = lines.join('\r\n');
    const before = process.memoryUsage().rss;
    const started = performance.now();
    const parsed = parsePhoneCsv(text, OPTIONS);
    const elapsed = performance.now() - started;
    const growthMb = (process.memoryUsage().rss - before) / 1e6;

    expect(parsed.rows).toBe(100_000);
    expect(parsed.entries).toHaveLength(unique.size);
    expect(parsed.duplicates).toBe(100_000 - unique.size);
    expect(parsed.entries.every((e) => e.phone !== null)).toBe(true);
    expect(elapsed, `took ${Math.round(elapsed)} ms`).toBeLessThan(45_000); // generous: stays valid on a loaded machine
    expect(growthMb, `grew ${Math.round(growthMb)} MB`).toBeLessThan(800);
  });

  it('parses a 100k-row file read from disk in UTF-16LE', () => {
    const prng = new Prng(7);
    const lines = ['phone'];
    for (let i = 0; i < 100_000; i += 1) lines.push(`0${prng.pick(['90', '91', '93'])}${prng.digits(7)}`);
    const parsed = readPhoneCsv(writeTemp(utf16le(lines.join('\r\n'))), OPTIONS);
    expect(parsed.rows).toBe(100_000);
    expect(parsed.entries.length).toBeGreaterThan(99_000);
  });
});
