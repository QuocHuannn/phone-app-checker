import { describe, expect, it } from 'vitest';
import { parsePhoneCsv } from '../src/csv.ts';

const opts = { defaultRegion: 'VN' };
const e164s = (text: string) => parsePhoneCsv(text, opts).entries.map((e) => e.phone?.e164 ?? null);

describe('delimiter sniffing when the first line ties', () => {
  it('uses the delimiter whose count repeats on the following rows (semicolon file, comma in the title)', () => {
    const text = 'Phone;Name,Note\n0901234567;An\n0912345678;Binh\n';
    const result = parsePhoneCsv(text, opts);
    expect(result.column).toBe('Phone');
    expect(result.entries.map((e) => e.phone?.e164)).toEqual(['+84901234567', '+84912345678']);
  });

  it('uses the delimiter whose count repeats on the following rows (comma file, semicolon in the title)', () => {
    expect(e164s('Name;x,Phone\nAn,0901234567\nBinh,0912345678\n')).toEqual(['+84901234567', '+84912345678']);
  });

  it('resolves a comma/tab tie the same way', () => {
    expect(e164s('Phone\tName,Note\n0901234567\tAn\n0912345678\tBinh\n')).toEqual(['+84901234567', '+84912345678']);
  });

  it('works through a UTF-8 BOM and CRLF line endings', () => {
    expect(e164s('\uFEFFPhone;Name,Note\r\n0901234567;An\r\n0912345678;Binh\r\n')).toEqual([
      '+84901234567',
      '+84912345678',
    ]);
  });

  it('refuses an unresolvable comma/semicolon tie with a re-save instruction instead of guessing', () => {
    const text = 'Phone;Name,Note\n0901234567;An,x\n0912345678;Binh,y\n';
    expect(() => parsePhoneCsv(text, opts)).toThrow(/comma and semicolon separators/);
    expect(() => parsePhoneCsv(text, opts)).toThrow(/Re-save the file as "CSV UTF-8/);
  });

  it('refuses a tie that only the first line shows (single-row file)', () => {
    expect(() => parsePhoneCsv('Phone;Name,Note\n', opts)).toThrow(/Re-save/);
  });

  it('refuses a headerless first row that ties and does not echo the numbers', () => {
    let message = '';
    try {
      parsePhoneCsv('0901234567,0912345678;x\n0923456789,0934567890;y\n', opts);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Re-save/);
    expect(message).not.toMatch(/\d{7}/);
  });

  it('does not count separators inside quotes, so quoted commas never cause a tie', () => {
    expect(e164s('"Name, full";Phone\n"An, B";0901234567\n')).toEqual(['+84901234567']);
  });

  it('keeps the existing behaviour when one delimiter clearly leads or no delimiter occurs', () => {
    expect(e164s('name,phone,note\nAn,0901234567,a;b\n')).toEqual(['+84901234567']);
    expect(e164s('phone\n0901234567\n0912345678\n')).toEqual(['+84901234567', '+84912345678']);
  });
});
