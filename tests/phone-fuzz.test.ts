import { getCountryCallingCode, getExampleNumber, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/mobile/examples';
import { describe, expect, it } from 'vitest';
import { parsePhoneCsv } from '../src/csv.ts';
import { normalizePhone } from '../src/phone.ts';
import { Prng } from './helpers/prng.ts';

/** Every target country of the product. */
const COUNTRIES = ['VN', 'SG', 'MY', 'ID', 'AU', 'NZ', 'KR', 'US', 'PH', 'TH', 'JP', 'TW', 'HK'] as const;
type Country = (typeof COUNTRIES)[number];

interface Sample {
  country: Country;
  cc: string;
  /** National significant number, digits only. */
  national: string;
  e164: string;
  nationalFormatted: string;
  internationalFormatted: string;
  rfc3966: string;
}

/** Fixed so CI is deterministic; set FUZZ_SEED to explore other inputs (a failure prints its seed). */
const SEED = Number(process.env.FUZZ_SEED ?? 20261009);

/** Valid numbers per country: the libphonenumber example with randomised trailing digits. */
function samples(country: Country, count: number, prng: Prng): Sample[] {
  const example = getExampleNumber(country as CountryCode, examples);
  if (example === undefined) throw new Error(`no example number for ${country}`);
  const cc = getCountryCallingCode(country as CountryCode);
  const seen = new Set<string>();
  const out: Sample[] = [];
  for (let attempt = 0; out.length < count && attempt < count * 40; attempt += 1) {
    const keep = Math.max(3, example.nationalNumber.length - prng.range(2, 5));
    const national = example.nationalNumber.slice(0, keep) + prng.digits(example.nationalNumber.length - keep);
    const parsed = parsePhoneNumberFromString(`+${cc}${national}`);
    if (!parsed?.isValid() || parsed.country !== country || seen.has(parsed.number)) continue;
    seen.add(parsed.number);
    out.push({
      country,
      cc,
      national: parsed.nationalNumber,
      e164: parsed.number,
      nationalFormatted: parsed.formatNational(),
      internationalFormatted: parsed.formatInternational(),
      rfc3966: parsed.format('RFC3966'),
    });
  }
  if (out.length < count / 2) throw new Error(`could only generate ${out.length} ${country} numbers`);
  return out;
}

const fullwidth = (text: string) => text.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))).replace(/\+/g, '\uFF0B');
const arabicIndic = (text: string) => text.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const persian = (text: string) => text.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
const separators = (text: string, prng: Prng) => text.replace(/[ -]/g, () => prng.pick([' ', '-', '.', '  ', ' - ', '\u00a0', '\t']));

/** Spellings that include an explicit international prefix: valid under any default region. */
function internationalForms(s: Sample, prng: Prng): string[] {
  const grouped = s.internationalFormatted;
  return [
    s.e164,
    grouped,
    s.rfc3966.replace('tel:', ''),
    `00${s.cc}${s.national}`,
    `00 ${s.cc} ${s.national}`,
    `+${s.cc}-${s.national}`,
    `+${s.cc}.${s.national}`,
    `+${s.cc} (0) ${s.national}`.replace('(0) ', ''),
    `  ${grouped}  `,
    `'${s.e164}`,
    `\u200f${grouped}\u200f`,
    `\u00a0${s.e164}\u00a0`,
    `\ufeff${s.e164}`,
    `${grouped} ext. 12`,
    `${grouped} x123`,
    `${s.e164};ext=45`,
    `${s.e164}#7`,
    fullwidth(s.e164),
    fullwidth(grouped),
    arabicIndic(s.e164),
    persian(s.e164),
    arabicIndic(grouped),
    `(${grouped})`,
    separators(grouped, prng),
    s.e164.replace('+', '00'),
    `${s.e164}.0`,
    `${s.e164.slice(1)}.0`.replace(/^/, '+'),
  ];
}

/** National spellings (what people type for local customers), valid under the number's own region. */
function nationalForms(s: Sample, prng: Prng): string[] {
  const national = s.nationalFormatted;
  const digitsOnly = national.replace(/\D/g, '');
  return [
    national,
    digitsOnly,
    separators(national, prng),
    `'${digitsOnly}`,
    `'${national}`,
    `\u200f${national}\u200f`,
    `\u00a0${national}\u00a0`,
    `${national} ext. 12`,
    `${digitsOnly} x12`,
    `${digitsOnly};ext=3`,
    fullwidth(digitsOnly),
    fullwidth(national),
    arabicIndic(digitsOnly),
    persian(national),
    `${digitsOnly}.0`,
    `${digitsOnly}.00`,
    `${national.replace(/[()]/g, '')}`,
    `(${digitsOnly})`,
    // Excel drops the trunk "0" (and keeps no separators) when it stores the cell as a number.
    s.national,
    `${s.national}.0`,
    fullwidth(s.national),
  ];
}

describe('normalizePhone fuzz: every target country', () => {
  for (const country of COUNTRIES) {
    it(`${country}: international spellings normalize to the same E.164 under every default region`, () => {
      const prng = new Prng(SEED + country.charCodeAt(0) * 31 + country.charCodeAt(1));
      for (const sample of samples(country, 25, prng)) {
        for (const form of internationalForms(sample, prng)) {
          for (const region of COUNTRIES) {
            const got = normalizePhone(form, region);
            expect(got, `${JSON.stringify(form)} under ${region} (seed ${prng.seed})`).toEqual({ e164: sample.e164, country });
          }
        }
      }
    });

    it(`${country}: national spellings normalize under their own default region`, () => {
      const prng = new Prng(SEED + 7 + country.charCodeAt(0) * 31 + country.charCodeAt(1));
      for (const sample of samples(country, 40, prng)) {
        for (const form of nationalForms(sample, prng)) {
          const got = normalizePhone(form, country);
          expect(got, `${JSON.stringify(form)} under ${country} (seed ${prng.seed})`).toEqual({ e164: sample.e164, country });
        }
      }
    });

    it(`${country}: country code without "+" is recovered under VN and under its own region`, () => {
      const prng = new Prng(SEED + 13 + country.charCodeAt(0) * 31 + country.charCodeAt(1));
      for (const sample of samples(country, 40, prng)) {
        const bare = `${sample.cc}${sample.national}`;
        for (const form of [bare, `${sample.cc} ${sample.national}`, fullwidth(bare), arabicIndic(bare), `${bare}.0`, `${bare} ext. 9`]) {
          for (const region of new Set<Country>(['VN', country])) {
            const got = normalizePhone(form, region);
            // Reading the same digits as a valid national number of the default region is the one
            // legitimate alternative, and only for a foreign number (never for the region's own code).
            const national = region !== country ? parsePhoneNumberFromString(bare, region as CountryCode) : undefined;
            if (national?.isValid()) continue;
            expect(got, `${JSON.stringify(form)} under ${region} (seed ${prng.seed})`).toEqual({ e164: sample.e164, country });
          }
        }
      }
    });
  }

  it('never turns a foreign number into a number of the default region by guessing digits', () => {
    const prng = new Prng(SEED);
    for (const country of COUNTRIES) {
      for (const sample of samples(country, 15, prng)) {
        for (const region of COUNTRIES) {
          if (region === country) continue;
          for (const form of [sample.e164, `00${sample.cc}${sample.national}`, sample.internationalFormatted]) {
            expect(normalizePhone(form, region)?.country, `${form} under ${region}`).toBe(country);
          }
        }
      }
    }
  });
});

describe('Vietnamese 0-prefixed numbers versus the default region', () => {
  const VN_PREFIXES = ['90', '91', '93', '94', '96', '97', '98', '32', '33', '34', '35', '36', '37', '38', '39', '70', '76', '77', '78', '79', '81', '82', '83', '84', '85', '86', '88', '89', '56', '58', '59'];

  it('is +84 only under VN; under any other region it is a number of that region\'s calling code or invalid', () => {
    const prng = new Prng(SEED + 99);
    let vnValid = 0;
    for (let i = 0; i < 400; i += 1) {
      const national = `0${prng.pick(VN_PREFIXES)}${prng.digits(7)}`;
      const asVn = normalizePhone(national, 'VN');
      if (asVn !== null) {
        vnValid += 1;
        expect(asVn).toEqual({ e164: `+84${national.slice(1)}`, country: 'VN' });
      }
      for (const region of COUNTRIES) {
        if (region === 'VN') continue;
        const other = normalizePhone(national, region);
        if (other === null) continue;
        // Same calling code, not same country: 0851235868 under AU is Christmas Island (CX), +61 too.
        expect(other.e164.startsWith(`+${getCountryCallingCode(region as CountryCode)}`), `${national} under ${region}`).toBe(true);
        expect(other.e164.startsWith('+84'), `${national} under ${region}`).toBe(false);
      }
    }
    expect(vnValid).toBeGreaterThan(300);
  });

  it('does not read a foreign trunk-prefixed number as the region\'s international dialing prefix', () => {
    // Singapore dials abroad with 0[0-3]x; "0386485553" is a Vietnamese number, not "038" + NZ +64 85553.
    expect(normalizePhone('0386485553', 'SG')).toBeNull();
    expect(normalizePhone('0386485553', 'VN')).toEqual({ e164: '+84386485553', country: 'VN' });
    // "00" is the explicit international prefix and stays honoured under every region.
    expect(normalizePhone('0084386485553', 'SG')).toEqual({ e164: '+84386485553', country: 'VN' });
    expect(normalizePhone('0084386485553', 'US')).toEqual({ e164: '+84386485553', country: 'VN' });
  });

  it('keeps the spellings of one VN number identical (so duplicates merge) under VN', () => {
    const prng = new Prng(SEED + 100);
    for (let i = 0; i < 200; i += 1) {
      const rest = `${prng.pick(VN_PREFIXES)}${prng.digits(7)}`;
      const canonical = normalizePhone(`+84${rest}`, 'VN');
      if (canonical === null) continue;
      for (const spelling of [`0${rest}`, `84${rest}`, `0084${rest}`, `+840${rest}`, `${rest}`, `+84 ${rest.slice(0, 2)} ${rest.slice(2)}`, `(0${rest.slice(0, 2)}) ${rest.slice(2, 5)} ${rest.slice(5)}`]) {
        expect(normalizePhone(spelling, 'VN'), spelling).toEqual(canonical);
      }
    }
  });
});

describe('spreadsheet artefacts', () => {
  it('rejects Excel scientific notation instead of guessing the lost digits', () => {
    const prng = new Prng(SEED + 5);
    let tried = 0;
    for (const country of COUNTRIES) {
      for (const sample of samples(country, 12, prng)) {
        const value = Number(`${sample.cc}${sample.national}`);
        for (const precision of [1, 2, 3, 5, 8]) {
          if (precision >= `${sample.cc}${sample.national}`.length - 1) continue;
          for (const text of [value.toExponential(precision).replace('e+', 'E+'), value.toExponential(precision).replace('e', 'E'), value.toExponential(precision)]) {
            for (const region of ['VN', country]) {
              tried += 1;
              expect(normalizePhone(text, region), `${text} under ${region}`).toBeNull();
            }
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(500);
    for (const text of ['8.49E+10', '8.49012E+10', '9.01E+08', '8.49E10', '8,49E+10', '8.49e+10']) {
      expect(normalizePhone(text, 'VN'), text).toBeNull();
    }
  });

  it('strips a float ".0" suffix only from a plain numeric cell, not from dotted phone formats', () => {
    expect(normalizePhone('84901234567.0', 'VN')?.e164).toBe('+84901234567');
    expect(normalizePhone('901234567.0', 'VN')?.e164).toBe('+84901234567');
    expect(normalizePhone('0901234567.000', 'VN')?.e164).toBe('+84901234567');
    expect(normalizePhone('+84901234567.0', 'VN')?.e164).toBe('+84901234567');
    // The final group of a dot-formatted number can legitimately be all zeros.
    expect(normalizePhone('415.882.0000', 'US')?.e164).toBe('+14158820000');
    expect(normalizePhone('+1 415.882.0000', 'VN')?.e164).toBe('+14158820000');
    expect(normalizePhone('415-882-0000', 'US')?.e164).toBe('+14158820000');
  });

  it('does not let the float strip turn a short number into a longer valid one', () => {
    // Indonesian numbers vary in length: "81234567.0" is the 8-digit number, not "812345670".
    expect(normalizePhone('81234567.0', 'ID')).toEqual(normalizePhone('81234567', 'ID'));
  });

  it('reads a bare own-country-code number as international, never as a longer national number', () => {
    expect(normalizePhone('62812345678', 'ID')).toEqual({ e164: '+62812345678', country: 'ID' });
    expect(normalizePhone('６２８１２３４５６７８', 'ID')).toEqual({ e164: '+62812345678', country: 'ID' });
    expect(normalizePhone('0812345678', 'ID')).toEqual({ e164: '+62812345678', country: 'ID' });
    expect(normalizePhone('812345678', 'ID')).toEqual({ e164: '+62812345678', country: 'ID' });
  });

  it('rejects letters, vanity numbers, two numbers in one cell and junk', () => {
    for (const text of [
      '1-800-FLOWERS',
      '0901-ABC-4567',
      'call me',
      '0901234567 / 0912345678',
      '0901234567, 0912345678',
      '0901234567 or 0912345678',
      '+',
      '++84901234567',
      '+0901234567',
      '0000000000',
      '1'.repeat(300),
      '9'.repeat(8),
      '\u0000',
      '\u200f',
      '😀',
    ]) {
      expect(normalizePhone(text, 'VN'), JSON.stringify(text)).toBeNull();
    }
  });

  it('survives hostile input without throwing', () => {
    const prng = new Prng(SEED + 31);
    const alphabet = ['0', '1', '8', '9', '+', ' ', '-', '.', '(', ')', '\u00a0', '\u200f', "'", 'x', 'E', '٠', '８', '\uFF0B', 'a', '#', ';', '\n', '\u0000'];
    for (let i = 0; i < 3000; i += 1) {
      const length = prng.range(0, 40);
      let text = '';
      for (let j = 0; j < length; j += 1) text += prng.pick(alphabet);
      const region = prng.pick(COUNTRIES);
      const got = normalizePhone(text, region);
      if (got !== null) expect(got.e164).toMatch(/^\+[1-9]\d{6,14}$/);
    }
    expect(normalizePhone('0901234567', 'ZZ')).toBeNull();
    expect(normalizePhone('+84901234567', 'ZZ')?.e164).toBe('+84901234567');
  });

  it('is idempotent: normalizing a normalized number gives the same number', () => {
    const prng = new Prng(SEED + 77);
    for (const country of COUNTRIES) {
      for (const sample of samples(country, 20, prng)) {
        const once = normalizePhone(sample.nationalFormatted, country);
        expect(once).not.toBeNull();
        expect(normalizePhone(once?.e164 ?? '', 'VN')).toEqual(once);
        expect(normalizePhone(once?.e164 ?? '', country)).toEqual(once);
      }
    }
  });
});

describe('CSV cells in many spellings collapse to one entry', () => {
  it('merges every spelling of one number into a single entry', () => {
    const lines = ['phone', '0901234567', '+84 90 123 4567', '84901234567', '0084901234567', "'0901234567", '０９０１２３４５６７', '٠٩٠١٢٣٤٥٦٧', '0901234567.0', '(090) 123 4567', '090.123.4567'];
    const parsed = parsePhoneCsv(lines.join('\n'), { defaultRegion: 'VN' });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.duplicates).toBe(lines.length - 2);
    expect(parsed.entries[0]?.phone?.e164).toBe('+84901234567');
  });
});
