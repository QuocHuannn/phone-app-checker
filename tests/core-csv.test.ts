import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePhoneCsv, readPhoneCsv } from '../src/csv.ts';

const opts = { defaultRegion: 'VN' };
const e164s = (text: string, column?: string) =>
  parsePhoneCsv(text, { ...opts, column }).entries.map((e) => e.phone?.e164 ?? null);

describe('parsePhoneCsv column detection', () => {
  it('finds the phone column from an English header', () => {
    const result = parsePhoneCsv('name,phone,city\nAn,0901234567,HCM\nBinh,0912345678,HN\n', opts);
    expect(result).toMatchObject({ column: 'phone', hasHeader: true, rows: 2, duplicates: 0 });
    expect(result.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567', '+84912345678']);
  });

  it('finds Vietnamese headers regardless of accents and case', () => {
    expect(e164s('Họ tên,Số điện thoại\nAn,0901234567\n')).toEqual(['+84901234567']);
    expect(e164s('ten,SĐT\nAn,0901234567\n')).toEqual(['+84901234567']);
    expect(e164s('ten,Điện Thoại di động\nAn,0901234567\n')).toEqual(['+84901234567']);
  });

  it('falls back to the column that holds phone numbers when no header matches', () => {
    const result = parsePhoneCsv('a,b,c\nx,0901234567,y\nx,0912345678,y\n', opts);
    expect(result).toMatchObject({ column: 'b', hasHeader: true });
    expect(result.entries).toHaveLength(2);
  });

  it('treats a file without header row as data', () => {
    const result = parsePhoneCsv('An,0901234567\nBinh,0912345678\n', opts);
    expect(result).toMatchObject({ column: '#2', hasHeader: false, rows: 2 });
  });

  it('honours --column by name (case-insensitive) and by 1-based index', () => {
    const text = 'phone,alt_phone\n0901234567,0912345678\n';
    expect(e164s(text)).toEqual(['+84901234567']);
    expect(e164s(text, 'ALT_PHONE')).toEqual(['+84912345678']);
    expect(e164s(text, '2')).toEqual(['+84912345678']);
  });

  it('reports available columns when --column does not exist', () => {
    expect(() => parsePhoneCsv('a,b\n1,2\n', { ...opts, column: 'phone' })).toThrow(/Column "phone" not found.*1:"a"/);
  });

  it('refuses to guess when no column holds phone numbers', () => {
    expect(() => parsePhoneCsv('a,b\nx,y\n', opts)).toThrow(/--column/);
  });

  it('rejects an empty file', () => {
    expect(() => parsePhoneCsv('\n\n', opts)).toThrow(/empty/);
  });
});

describe('parsePhoneCsv formats', () => {
  it('handles BOM, CRLF, quoted fields and semicolon or tab delimiters', () => {
    expect(e164s('\uFEFFname,phone\r\n"An, Nguyen",0901234567\r\n')).toEqual(['+84901234567']);
    expect(e164s('name;phone\nAn;0901234567\n')).toEqual(['+84901234567']);
    expect(e164s('name\tphone\nAn\t0901234567\n')).toEqual(['+84901234567']);
  });

  it('tolerates ragged rows', () => {
    expect(e164s('name,phone,note\nAn,0901234567\nBinh,0912345678,x,y\n')).toEqual(['+84901234567', '+84912345678']);
  });
});

describe('parsePhoneCsv invalid rows and deduplication', () => {
  const text = [
    'name,phone',
    'An,0901234567',
    'Binh,+84 90 123 4567', // same number, other spelling
    'Chi,not a phone',
    'Dung,',
    'Em,not a phone',
    'Giang,+65 9123 4567',
    'Hoa,0901234567',
  ].join('\n');

  it('keeps the original input value and merges duplicates by E.164', () => {
    const result = parsePhoneCsv(text, opts);
    expect(result.rows).toBe(7);
    expect(result.duplicates).toBe(3);
    expect(result.entries.map((e) => [e.input, e.phone?.e164 ?? null])).toEqual([
      ['0901234567', '+84901234567'],
      ['not a phone', null],
      ['', null],
      ['+65 9123 4567', '+6591234567'],
    ]);
  });

  it('records the country of each valid number', () => {
    const result = parsePhoneCsv(text, opts);
    expect(result.entries.map((e) => e.phone?.country)).toEqual(['VN', undefined, undefined, 'SG']);
  });
});

describe('readPhoneCsv errors', () => {
  it('says a missing file is not found, and a folder is a folder, without system error text', () => {
    const missing = join(tmpdir(), 'pac-csv-missing', 'nope.csv');
    expect(() => readPhoneCsv(missing, opts)).toThrow(`File not found: ${missing}`);
    expect(() => readPhoneCsv(tmpdir(), opts)).toThrow(`${tmpdir()} is a folder, not a CSV file`);
  });

  it('tells a user without a --column option to name the phone header', () => {
    expect(() => parsePhoneCsv('name,city\nAn,HCM\n', opts)).toThrow(/Name its header "phone" \(or use --column\)\. Columns: 1:"name", 2:"city"/);
  });
});
