import { describe, expect, it } from 'vitest';
import { parsePhoneCsv } from '../src/csv.ts';

const OPTIONS = { defaultRegion: 'VN' };

function message(csv: string, column?: string): string {
  try {
    parsePhoneCsv(csv, column === undefined ? OPTIONS : { ...OPTIONS, column });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected parsePhoneCsv to throw');
}

describe('column errors never echo digit-heavy cells', () => {
  it('masks digit-heavy cells of a first row that is not a header', () => {
    const text = message('ref 123456 x,no. 5555 5,zzz\nfoo,bar,baz\n');
    expect(text).toMatch(/^Cannot find a phone column/);
    expect(text).not.toMatch(/123456|5555/);
    expect(text).toContain('1:"<digits hidden>"');
    expect(text).toContain('2:"<digits hidden>"');
    // ordinary header text stays readable so the operator can pick --column
    expect(text).toContain('3:"zzz"');
  });

  it('masks digits of any script and keeps short numbers in titles (Q3, Code9)', () => {
    const text = message('Q3 report,Code9,ref \u0661\u0662\u0663\u0664\u0665\u0666\u0667,x\nfoo,bar,baz,qux\n');
    expect(text).toContain('1:"Q3 report"');
    expect(text).toContain('2:"Code9"');
    expect(text).toContain('3:"<digits hidden>"');
    expect(text).not.toMatch(/\u0661\u0662\u0663/);
  });

  it('masks the columns listed when --column names one that does not exist', () => {
    const text = message('ref 123456 x,b\nfoo,bar\n', 'zzz');
    expect(text).toMatch(/^Column "zzz" not found/);
    expect(text).not.toContain('123456');
    expect(text).toContain('1:"<digits hidden>"');
    expect(text).toContain('2:"b"');
  });
});
