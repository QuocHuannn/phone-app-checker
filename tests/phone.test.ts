import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/phone.ts';
import { maskPhone, redactPhones } from '../src/types.ts';

describe('normalizePhone', () => {
  it.each([
    ['0901234567', '+84901234567', 'VN'],
    ['090 123 4567', '+84901234567', 'VN'],
    ['090.123.4567', '+84901234567', 'VN'],
    ['+84 90 123 4567', '+84901234567', 'VN'],
    ['84901234567', '+84901234567', 'VN'],
    ['0084901234567', '+84901234567', 'VN'],
    ["'0901234567", '+84901234567', 'VN'],
    ['0901234567.0', '+84901234567', 'VN'],
    ['  +84901234567  ', '+84901234567', 'VN'],
  ])('normalizes Vietnamese number %j', (raw, e164, country) => {
    expect(normalizePhone(raw, 'VN')).toEqual({ e164, country });
  });

  it.each([
    ['+65 9123 4567', '+6591234567', 'SG'],
    ['+61 412 345 678', '+61412345678', 'AU'],
    ['+82 10-1234-5678', '+821012345678', 'KR'],
    ['+1 415 555 2671', '+14155552671', 'US'],
  ])('normalizes international number %j regardless of the default region', (raw, e164, country) => {
    expect(normalizePhone(raw, 'VN')).toEqual({ e164, country });
  });

  it('uses the configured default region for national numbers', () => {
    expect(normalizePhone('0412 345 678', 'AU')).toEqual({ e164: '+61412345678', country: 'AU' });
  });

  it.each(['', '   ', 'abc', '12345', '0000000000', '+999 123', '090123', '8.4901E+11', 'N/A', '+84 (0) 12'])(
    'rejects %j',
    (raw) => {
      expect(normalizePhone(raw, 'VN')).toBeNull();
    },
  );

  it('gives the same E.164 for every spelling so duplicates can be merged', () => {
    const spellings = ['0901234567', '+84 901 234 567', '84901234567', '0084-901-234-567'];
    expect(new Set(spellings.map((s) => normalizePhone(s, 'VN')?.e164)).size).toBe(1);
  });
});

describe('phone masking', () => {
  it('keeps only the prefix and last digits', () => {
    expect(maskPhone('+84901234567')).toBe('+8490****567');
  });

  it('redacts phone-like digit runs inside free text', () => {
    expect(redactPhones('failed for +84 90 123 4567 (retry)')).toBe('failed for +8490****567 (retry)');
    expect(redactPhones('code 404 after 3 tries')).toBe('code 404 after 3 tries');
  });

  it('masks digit runs inside URLs and absolute paths too', () => {
    expect(redactPhones('Scan /data/sessions/zalo/0901234567/qr.png now')).toBe('Scan /data/sessions/zalo/09012****567/qr.png now');
    expect(redactPhones('open https://line.me/R/au/q/1234567890123?t=9876543210 please')).toBe(
      'open https://line.me/R/au/q/12345****123?t=98765****210 please',
    );
    expect(redactPhones('https://example.test/check?phone=%2B84901234567&n=0901234567')).toBe(
      'https://example.test/check?phone=%2B84901****567&n=09012****567',
    );
    expect(redactPhones(String.raw`C:\data\sessions\0901234567\qr.png`)).toBe(String.raw`C:\data\sessions\09012****567\qr.png`);
    expect(redactPhones('failed for 0901234567/0912345678')).toBe('failed for 09012****567/09123****678');
  });

  it('masks exactly seven digits, never returning the run whole', () => {
    expect(maskPhone('5551234')).toBe('55****4');
    expect(redactPhones('failed for 5551234')).toBe('failed for 55****4');
    expect(redactPhones('row 3: bad value 5551234.')).toBe('row 3: bad value 55****4.');
  });

  it('masks separated and parenthesised forms that CSV error text can carry', () => {
    expect(redactPhones('bad phone 555-1234')).toBe('bad phone 55****4');
    expect(redactPhones('bad phone 555 1234')).toBe('bad phone 55****4');
    expect(redactPhones('bad phone (090) 123-4567')).toBe('bad phone (09012****567');
    expect(redactPhones('bad phone "(090) 123-4567"')).toBe('bad phone "(09012****567"');
    expect(redactPhones('bad phone 090-123-4567, next')).toBe('bad phone 09012****567, next');
    expect(redactPhones('bad phone 12345678')).toBe('bad phone 123****8');
    expect(redactPhones('bad phone 123456789')).toBe('bad phone 1234****9');
  });

  it('keeps shorter numeric values readable', () => {
    expect(redactPhones('row 12 col 3: 123456 is too short, code 404')).toBe('row 12 col 3: 123456 is too short, code 404');
    expect(redactPhones('ratio 12.5 and 3-4 (2 of 9)')).toBe('ratio 12.5 and 3-4 (2 of 9)');
  });
});
