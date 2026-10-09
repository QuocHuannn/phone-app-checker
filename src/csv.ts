import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { normalizePhone } from './phone.ts';
import { terminalSafe, type PhoneNumber } from './types.ts';

/** One unique input value: a valid number (deduplicated by E.164) or an invalid raw cell. */
export interface InputEntry {
  /** Original cell value, kept verbatim for the report. */
  input: string;
  /** null when the value is not a valid phone number. */
  phone: PhoneNumber | null;
}

export interface ParsedInput {
  /** Unique entries in order of first appearance. */
  entries: InputEntry[];
  /** Header text, or "#<n>" (1-based) for a headerless file. */
  column: string;
  hasHeader: boolean;
  /** Data rows read, before deduplication. */
  rows: number;
  /** Rows dropped because the same E.164 (or the same invalid text) appeared earlier. */
  duplicates: number;
}

export interface ParseOptions {
  /** Header name (case-insensitive) or 1-based column index. Auto-detected when omitted. */
  column?: string | undefined;
  defaultRegion: string;
}

/** Header words that identify a phone column, matched on lower-cased, accent-stripped text. */
const HEADER_HINT =
  /\b(phone|mobile|tel|telephone|cell|cellphone|msisdn|gsm|sdt|sodt|zalo|whatsapp|viber)\b|dien thoai|di dong/;

/** Rows sampled when guessing the phone column from content. */
const SAMPLE_ROWS = 200;

function normalizeHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Non-empty lines examined when the first line alone cannot decide the delimiter. */
const SNIFF_LINES = 20;
const DELIMITERS = [',', ';', '\t'] as const;
const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

/**
 * Pick the delimiter that occurs most (outside quotes) on the first non-empty line. When two
 * delimiters tie there (e.g. `Phone;Name,Note` or `0912345678,0987654321;x`), the first line
 * cannot decide: choose the candidate whose first-line count repeats on most of the following
 * non-empty lines (a real delimiter is as frequent on every row). If the rows cannot separate
 * them either, refuse with a re-save instruction rather than guess a column layout, which would
 * turn a customer file into an all-invalid run.
 */
function sniffDelimiter(text: string): string {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, SNIFF_LINES)
    .map((l) => l.replace(/"[^"]*"/g, ''));
  const first = lines[0] ?? '';
  const count = (line: string, delimiter: string) => line.split(delimiter).length - 1;
  let bestCount = 0;
  for (const delimiter of DELIMITERS) bestCount = Math.max(bestCount, count(first, delimiter));
  if (bestCount === 0) return ',';
  const tied = DELIMITERS.filter((delimiter) => count(first, delimiter) === bestCount);
  const [only, ...rivals] = tied;
  if (only === undefined) return ',';
  if (rivals.length === 0) return only;
  const agreeing = (delimiter: string) => lines.filter((line) => count(line, delimiter) === bestCount).length;
  const scored = tied.map((delimiter) => ({ delimiter, score: agreeing(delimiter) })).sort((a, b) => b.score - a.score);
  const top = scored[0];
  const next = scored[1];
  if (top !== undefined && next !== undefined && top.score > next.score) return top.delimiter;
  throw new Error(
    `Cannot tell how the columns are separated: the first line has the same number of ` +
      `${tied.map((delimiter) => DELIMITER_NAMES[delimiter]).join(' and ')} separators, and the other rows do not settle it. ` +
      'Re-save the file as "CSV UTF-8 (Comma delimited)" with only the phone column or with clean column titles, then try again.',
  );
}

/** Column whose cells parse as valid phones most often in the sampled rows, or -1. */
function bestPhoneColumn(rows: string[][], defaultRegion: string): number {
  const counts: number[] = [];
  for (const row of rows.slice(0, SAMPLE_ROWS)) {
    row.forEach((cell, index) => {
      if (normalizePhone(cell, defaultRegion) !== null) counts[index] = (counts[index] ?? 0) + 1;
    });
  }
  let best = -1;
  let bestCount = 0;
  counts.forEach((count, index) => {
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  return best;
}

/** Columns shown in an error message; a binary file or a huge cell must not flood or garble the terminal. */
const MAX_DESCRIBED_COLUMNS = 12;
const MAX_DESCRIBED_CELL = 40;
/** A cell with this many digits (any script) could be a phone number or other customer data: never echoed. */
const MASKED_DIGIT_COUNT = 5;

/**
 * A customer-controlled string (a column title) made safe to print: terminalSafe (escape sequences,
 * control and bidi characters removed, capped), and digit-heavy text hidden because it may be customer
 * data when the first row is not a header.
 */
export function safeLabel(text: string): string {
  // Escape sequences first: their parameters ("[2K") are digits that are not customer data.
  const clean = terminalSafe(text, Number.POSITIVE_INFINITY);
  if ((clean.match(/\p{Nd}/gu)?.length ?? 0) >= MASKED_DIGIT_COUNT) return '<digits hidden>';
  return terminalSafe(clean, MAX_DESCRIBED_CELL);
}

function describeColumns(header: string[]): string {
  const shown = header.slice(0, MAX_DESCRIBED_COLUMNS).map((cell, i) => `${i + 1}:"${safeLabel(cell)}"`);
  if (header.length > MAX_DESCRIBED_COLUMNS) shown.push(`... (${header.length - MAX_DESCRIBED_COLUMNS} more)`);
  return shown.join(', ');
}

/** Parse CSV text, locate the phone column, normalize to E.164 and deduplicate. */
export function parsePhoneCsv(text: string, options: ParseOptions): ParsedInput {
  const { defaultRegion } = options;
  let rows: string[][];
  try {
    rows = parse(text, {
      bom: true,
      delimiter: sniffDelimiter(text),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as string[][];
  } catch (error) {
    // csv-parse can quote the offending record in its message: keep escape sequences out of the terminal.
    throw new Error(`Cannot parse CSV: ${terminalSafe((error as Error).message, 500)}`, { cause: error });
  }
  const first = rows[0];
  if (first === undefined || rows.every((row) => row.every((cell) => cell.trim() === ''))) {
    throw new Error('CSV file is empty');
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const isPhone = (cell: string | undefined) => normalizePhone(cell ?? '', defaultRegion) !== null;
  /** Digits and phone punctuation only, 7+ digits: a customer entry (maybe invalid), not a column title. */
  const looksLikePhone = (cell: string | undefined) => {
    const text = (cell ?? '').trim();
    return /^\+?[\d\s().-]+$/.test(text) && text.replace(/\D/g, '').length >= 7;
  };

  let col = -1;
  let hasHeader: boolean;
  const wanted = options.column?.trim();
  if (wanted !== undefined && wanted !== '') {
    const byName = first.findIndex((h) => h.trim().toLowerCase() === wanted.toLowerCase());
    if (byName >= 0) {
      col = byName;
      hasHeader = true;
    } else if (/^\d+$/.test(wanted) && Number(wanted) >= 1 && Number(wanted) <= width) {
      col = Number(wanted) - 1;
      hasHeader = !isPhone(first[col]) && !looksLikePhone(first[col]);
    } else {
      throw new Error(`Column "${wanted}" not found. Columns: ${describeColumns(first)}`);
    }
  } else if (first.some(isPhone) || first.some(looksLikePhone)) {
    hasHeader = false;
    col = bestPhoneColumn(rows, defaultRegion);
    if (col < 0) col = first.findIndex(looksLikePhone);
  } else {
    hasHeader = true;
    col = first.findIndex((h) => HEADER_HINT.test(normalizeHeader(h)));
    if (col < 0) col = bestPhoneColumn(rows.slice(1), defaultRegion);
    if (col < 0) {
      throw new Error(`Cannot find a phone column. Name its header "phone" (or use --column). Columns: ${describeColumns(first)}`);
    }
  }

  const data = hasHeader ? rows.slice(1) : rows;
  const seen = new Set<string>();
  const entries: InputEntry[] = [];
  let duplicates = 0;
  for (const row of data) {
    const input = row[col] ?? '';
    const phone = normalizePhone(input, defaultRegion);
    const key = phone ? phone.e164 : `invalid:${input.trim()}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    entries.push({ input, phone });
  }
  return {
    entries,
    column: hasHeader ? (first[col] ?? '').trim() : `#${col + 1}`,
    hasHeader,
    rows: data.length,
    duplicates,
  };
}

/**
 * Decode the bytes of a CSV file. Excel's "Unicode Text" export is UTF-16 (little endian) with a
 * byte order mark; everything else is read as UTF-8 (a UTF-8 BOM is dropped by the CSV parser). A
 * NUL byte never occurs in a text CSV: it means a binary file (an .xlsx workbook, a PDF) or UTF-16
 * without a byte order mark, and decoding it as UTF-8 would only produce garbage columns.
 */
export function decodeCsvBytes(bytes: Buffer, label = 'The file'): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes.includes(0)) {
    throw new Error(
      `${label} is not a plain-text CSV (it contains binary data, e.g. an .xlsx workbook). ` +
        'In Excel use File > Save As > "CSV UTF-8 (Comma delimited)".',
    );
  }
  return bytes.toString('utf8');
}

export function readPhoneCsv(path: string, options: ParseOptions): ParsedInput {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`File not found: ${path}`, { cause: error });
    if (code === 'EISDIR') throw new Error(`${path} is a folder, not a CSV file`, { cause: error });
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
  return parsePhoneCsv(decodeCsvBytes(bytes, path), options);
}
