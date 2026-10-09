import { getCountryCallingCode, parseDigits, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { PhoneNumber } from './types.ts';

type Parsed = NonNullable<ReturnType<typeof parsePhoneNumberFromString>>;

function parseValid(text: string, region: string, sameCallingCode?: string): Parsed | null {
  const parsed = parsePhoneNumberFromString(text, region as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  if (sameCallingCode !== undefined && parsed.countryCallingCode !== sameCallingCode) return null;
  return parsed;
}

function toPhone(parsed: Parsed | null): PhoneNumber | null {
  return parsed === null ? null : { e164: parsed.number, country: parsed.country ?? '' };
}

/** Numbers a messaging app can be registered on. */
function isMobile(parsed: Parsed): boolean {
  const type = parsed.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
}

/** Calling code of `region`, or undefined when libphonenumber does not know the region. */
function callingCode(region: string): string | undefined {
  try {
    return getCountryCallingCode(region as CountryCode);
  } catch {
    return undefined;
  }
}

/**
 * A spreadsheet float artifact: digits (and spaces) followed by ".0". Dotted phone formats such as
 * "415.882.0000" also end in ".0..." but contain another dot before it, so they are left alone.
 */
const SPREADSHEET_FLOAT = /^(\+?[\d ]*\d)\.0+$/;

/** Letters and extension markers: such a cell may carry digits that are not part of the number. */
const NOT_PLAIN_NUMBER = /[\p{L}#;*]/u;

/**
 * Normalize a raw cell to E.164. Accepts "+84 90 123 4567", "0901234567",
 * "0084901234567", "84901234567" (country code without "+"), full-width and Arabic-Indic digits,
 * a leading apostrophe, a trailing spreadsheet ".0" and an extension ("x12", "ext. 12"; dropped).
 * Returns null when the value is not a valid phone number (letters, two numbers in one cell,
 * Excel scientific notation such as "8.49E+10": the lost digits are never guessed).
 *
 * Without "+" or "00" a number belongs to the default region: "0386485553" under SG is not
 * silently read through Singapore's international dialing prefix. The digits of a number written
 * with its country code but no "+" are tried when the national reading fails. When both readings
 * of a number that starts with the region's own calling code are valid, the mobile one wins
 * ("62812345678" in an Indonesian list is +62 812 345 678, not a "62..." area code; the
 * lost-zero Vietnamese "846941059" stays the national 084 mobile).
 */
export function normalizePhone(raw: string, defaultRegion: string): PhoneNumber | null {
  // Invisible format marks (RLM, zero-width, BOM) and non-ASCII digits/plus are folded first so
  // every later check sees the same characters a human sees.
  let text = raw
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Nd}/gu, (digit) => parseDigits(digit))
    .replace(/\uFF0B/g, '+')
    // Tabs, thin and narrow no-break spaces and line breaks inside a cell are plain separators.
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  // Spreadsheet exports sometimes keep a leading apostrophe or a trailing ".0".
  text = text.replace(/^['\u2018\u2019`]+/, '');
  const floatForm = SPREADSHEET_FLOAT.exec(text);
  if (floatForm?.[1] !== undefined) text = floatForm[1];
  if (text.startsWith('00')) text = `+${text.slice(2)}`;

  // Digits-only reading of a number written without "+" ("84901234567"). When the cell has letters
  // or extension markers the digit run could swallow extension digits, so only the text from the
  // first digit on is used and libphonenumber splits off the extension itself.
  const firstDigit = text.search(/\d/);
  const bareCandidate = (() => {
    if (firstDigit < 0 || text.startsWith('+')) return undefined;
    const digits = text.replace(/\D/g, '');
    if (digits.length < 8 || digits.startsWith('0')) return undefined;
    return NOT_PLAIN_NUMBER.test(text) ? `+${text.slice(firstDigit)}` : `+${digits}`;
  })();

  const ownCode = callingCode(defaultRegion);
  // Without "+" (or the "00" rewritten above) the number must belong to the default region's own
  // calling code. Otherwise libphonenumber would read a leading "0xx" of a foreign trunk-prefixed
  // number as the region's international dialing prefix (VN "0386485553" under SG would become a
  // short NZ number) instead of rejecting it.
  const direct = parseValid(text, defaultRegion, text.startsWith('+') ? undefined : ownCode);

  if (bareCandidate !== undefined && ownCode !== undefined && bareCandidate.slice(1).startsWith(ownCode)) {
    // "62812345678" in an Indonesian list reads as national (a "62" fixed-line area code) and as
    // +62 812 345 678. Both are valid; the one a messaging app can be registered on wins, and the
    // national reading keeps every other tie ("846941059" is a lost-zero Vietnamese 084 mobile).
    const withOwnCode = parseValid(bareCandidate, defaultRegion);
    if (withOwnCode && (direct === null || (isMobile(withOwnCode) && !isMobile(direct)))) return toPhone(withOwnCode);
  }
  if (direct) return toPhone(direct);

  return bareCandidate === undefined ? null : toPhone(parseValid(bareCandidate, defaultRegion));
}
