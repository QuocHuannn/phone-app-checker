import { closeSync, constants, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parse as createCsvParser } from 'csv-parse';
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

/**
 * Turns parsed CSV records into the deduplicated entry list. Records arrive one at a time (the
 * whole-file parser feeds the same builder), so a file never needs all its rows in memory: the
 * first row plus at most SAMPLE_ROWS more are held until the phone column is known, after that a
 * record is reduced to one entry and dropped.
 */
class PhoneColumnBuilder {
  private readonly wanted: string | undefined;
  private readonly defaultRegion: string;
  private buffered: string[][] = [];
  private firstRow: string[] | undefined;
  private col = -1;
  private hasHeader = false;
  private decided = false;
  private atEnd = false;
  /** `--column <index>` validity needs the widest row in the file, so its failure waits for EOF. */
  private numericWanted: { text: string; value: number } | undefined;
  /** An error the batch parse would report; held so the empty-file check keeps its precedence. */
  private pendingError: Error | undefined;
  private sawCell = false;
  private maxWidth = 0;
  private rows = 0;
  private readonly seen = new Set<string>();
  private readonly entries: InputEntry[] = [];
  private duplicates = 0;

  constructor(options: ParseOptions) {
    const wanted = options.column?.trim();
    this.wanted = wanted === '' ? undefined : wanted;
    this.defaultRegion = options.defaultRegion;
  }

  add(record: string[]): void {
    this.firstRow ??= record;
    this.maxWidth = Math.max(this.maxWidth, record.length);
    if (!this.sawCell && record.some((cell) => cell.trim() !== '')) this.sawCell = true;
    if (this.pendingError !== undefined) return;
    if (this.decided) {
      this.consume(record);
      return;
    }
    this.buffered.push(record);
    this.tryDecide();
  }

  private isPhone(cell: string | undefined): boolean {
    return normalizePhone(cell ?? '', this.defaultRegion) !== null;
  }

  /** Digits and phone punctuation only, 7+ digits: a customer entry (maybe invalid), not a column title. */
  private looksLikePhone(cell: string | undefined): boolean {
    const text = (cell ?? '').trim();
    return /^\+?[\d\s().-]+$/.test(text) && text.replace(/\D/g, '').length >= 7;
  }

  /** Resolve the phone column as soon as the buffered records allow it; later rows stream through. */
  private tryDecide(): void {
    const first = this.buffered[0];
    if (first === undefined) return;
    const wanted = this.wanted;
    if (wanted !== undefined) {
      const byName = first.findIndex((h) => h.trim().toLowerCase() === wanted.toLowerCase());
      if (byName >= 0) {
        this.col = byName;
        this.hasHeader = true;
        this.decideDone();
        return;
      }
      if (/^\d+$/.test(wanted) && Number(wanted) >= 1) {
        this.col = Number(wanted) - 1;
        this.numericWanted = { text: wanted, value: Number(wanted) };
        this.hasHeader = !this.isPhone(first[this.col]) && !this.looksLikePhone(first[this.col]);
        this.decideDone();
        return;
      }
      this.pendingError = new Error(`Column "${wanted}" not found. Columns: ${describeColumns(first)}`);
      return;
    }
    if (first.some((cell) => this.isPhone(cell)) || first.some((cell) => this.looksLikePhone(cell))) {
      // bestPhoneColumn samples the first SAMPLE_ROWS rows; decide once that many are seen or the file ends.
      if (!this.atEnd && this.buffered.length < SAMPLE_ROWS) return;
      this.hasHeader = false;
      this.col = bestPhoneColumn(this.buffered, this.defaultRegion);
      if (this.col < 0) this.col = first.findIndex((cell) => this.looksLikePhone(cell));
      this.decideDone();
      return;
    }
    const hint = first.findIndex((h) => HEADER_HINT.test(normalizeHeader(h)));
    if (hint >= 0) {
      this.col = hint;
      this.hasHeader = true;
      this.decideDone();
      return;
    }
    // The fallback samples the first SAMPLE_ROWS data rows: the header row plus that many buffered.
    if (!this.atEnd && this.buffered.length < SAMPLE_ROWS + 1) return;
    this.hasHeader = true;
    this.col = bestPhoneColumn(this.buffered.slice(1), this.defaultRegion);
    if (this.col < 0) {
      this.pendingError = new Error(
        `Cannot find a phone column. Name its header "phone" (or use --column). Columns: ${describeColumns(first)}`,
      );
      return;
    }
    this.decideDone();
  }

  /** The buffered records are reclassified now that the column (and header) is known. */
  private decideDone(): void {
    const buffered = this.buffered;
    this.buffered = [];
    this.decided = true;
    for (let i = this.hasHeader ? 1 : 0; i < buffered.length; i += 1) this.consume(buffered[i] as string[]);
  }

  private consume(record: string[]): void {
    this.rows += 1;
    const input = record[this.col] ?? '';
    const phone = normalizePhone(input, this.defaultRegion);
    const key = phone ? phone.e164 : `invalid:${input.trim()}`;
    if (this.seen.has(key)) {
      this.duplicates += 1;
      return;
    }
    this.seen.add(key);
    this.entries.push({ input, phone });
  }

  /** End of input: the empty-file check runs first, then the deferred `--column <index>` width check. */
  finish(): ParsedInput {
    this.atEnd = true;
    if (!this.decided && this.pendingError === undefined) this.tryDecide();
    if (!this.sawCell) throw new Error('CSV file is empty');
    if (this.pendingError !== undefined) throw this.pendingError;
    if (this.numericWanted !== undefined && this.numericWanted.value > this.maxWidth) {
      throw new Error(`Column "${this.numericWanted.text}" not found. Columns: ${describeColumns(this.firstRow as string[])}`);
    }
    return {
      entries: this.entries,
      column: this.hasHeader ? (this.firstRow?.[this.col] ?? '').trim() : `#${this.col + 1}`,
      hasHeader: this.hasHeader,
      rows: this.rows,
      duplicates: this.duplicates,
    };
  }
}

/** Parse CSV text, locate the phone column, normalize to E.164 and deduplicate. */
export function parsePhoneCsv(text: string, options: ParseOptions): ParsedInput {
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
  const builder = new PhoneColumnBuilder(options);
  for (const row of rows) builder.add(row);
  return builder.finish();
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

/** Bytes pulled from the input file per `readSync`; records and sniff text stay bounded by it. */
const READ_CHUNK = 256 * 1024;

/** csv-parse exposes its incremental record engine as `parser.api.parse`; it is not in the type surface. */
interface CsvParserEngine {
  api: {
    parse: (chunk: Buffer | undefined, end: boolean, push: (record: string[]) => void, close: () => void) => Error | undefined;
  };
}

/** True once the sniffed text holds every line `sniffDelimiter` can look at: the 21st line break ends it. */
function sniffDelimiterReady(text: string): boolean {
  return (text.match(/\r\n|\r|\n/g)?.length ?? 0) > SNIFF_LINES;
}

function newParser(delim: string): CsvParserEngine {
  return createCsvParser({
    bom: true,
    delimiter: delim,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as unknown as CsvParserEngine;
}

/**
 * Read a CSV file without holding its bytes or rows: the file is pulled in fixed chunks, decoded
 * incrementally (the UTF-16 byte-order marks of `decodeCsvBytes` are handled the same way), and
 * csv-parse's record engine is fed each chunk so records reach the column builder one at a time.
 */
export function readPhoneCsv(path: string, options: ParseOptions): ParsedInput {
  const describe = (error: unknown): Error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Error(`File not found: ${path}`, { cause: error });
    if (code === 'EISDIR') return new Error(`${path} is a folder, not a CSV file`, { cause: error });
    return new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw describe(error);
  }
  const builder = new PhoneColumnBuilder(options);
  // Set at the first chunk, once the byte-order mark (or its absence) names the encoding.
  let utf16: 'le' | 'be' | undefined;
  let decoder: StringDecoder | undefined;
  // Leftover odd byte of a UTF-16 stream carried into the next chunk; a UTF-16 unit is two bytes.
  let carry = Buffer.alloc(0);
  // Decoded text waiting for the delimiter sniff; cleared as soon as the parser takes over.
  let sniffed = '';
  let parser: CsvParserEngine | undefined;
  /** Errors come back from the engine instead of being thrown; the wording is the batch parser's. */
  const feed = (chunk: Buffer | undefined, end: boolean): void => {
    const error = parser?.api.parse(chunk, end, (record) => builder.add(record), () => {});
    if (error !== undefined) throw new Error(`Cannot parse CSV: ${terminalSafe(error.message, 500)}`, { cause: error });
  };
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buf, 0, READ_CHUNK, null);
      } catch (error) {
        throw describe(error);
      }
      const eof = bytesRead === 0;
      let chunk = buf.subarray(0, bytesRead);
      if (decoder === undefined) {
        // First chunk (or an empty file): name the encoding the way decodeCsvBytes does.
        if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) utf16 = 'le';
        else if (chunk.length >= 2 && chunk[0] === 0xfe && chunk[1] === 0xff) utf16 = 'be';
        decoder = new StringDecoder(utf16 === undefined ? 'utf8' : 'utf16le');
        chunk = chunk.subarray(utf16 === undefined ? 0 : 2);
      }
      let text: string;
      if (utf16 === undefined) {
        // A NUL byte never occurs in a text CSV: it means a binary file (an .xlsx workbook, a PDF)
        // or UTF-16 without a byte order mark, and decoding it as UTF-8 would produce garbage.
        if (chunk.includes(0)) {
          throw new Error(
            `${path} is not a plain-text CSV (it contains binary data, e.g. an .xlsx workbook). ` +
              'In Excel use File > Save As > "CSV UTF-8 (Comma delimited)".',
          );
        }
        text = decoder.write(chunk);
      } else {
        const pair = Buffer.concat([carry, chunk]);
        const even = pair.length - (pair.length % 2);
        // `pair` is fresh per chunk; keep the odd tail byte for the next pair (BE is swapped into LE).
        carry = Buffer.from(pair.subarray(even));
        text = decoder.write(utf16 === 'be' ? Buffer.from(pair.subarray(0, even)).swap16() : pair.subarray(0, even));
      }
      if (parser === undefined) {
        sniffed += text;
        if (sniffDelimiterReady(sniffed) || eof) {
          parser = newParser(sniffDelimiter(sniffed));
          feed(Buffer.from(sniffed, 'utf8'), false);
          sniffed = '';
        }
      } else {
        feed(Buffer.from(text, 'utf8'), false);
      }
      if (eof) break;
    }
    // Flush the decoder tail (a unit split across chunks, or the odd byte of a truncated UTF-16
    // stream), then the parser's end-of-input state; records reach the builder all along.
    const tail = (decoder as StringDecoder).end(carry);
    if (tail !== '') feed(Buffer.from(tail, 'utf8'), false);
    feed(undefined, true);
  } finally {
    closeSync(fd);
  }
  return builder.finish();
}
