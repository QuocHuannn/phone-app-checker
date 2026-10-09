import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { stringify as createCsvStringifier } from 'csv-stringify';
import { APP_SCOPE } from './adapters/index.ts';
import type { InputEntry } from './csv.ts';
import { isFresh } from './scheduler.ts';
import type { Store, StoredResult } from './store.ts';
import { APPS, type App, type Status } from './types.ts';
import { PLAIN_UI, formatDuration, type Paint, type Ui } from './ui.ts';
import { translator, type Translator } from './i18n/index.ts';

export const STATUSES: readonly Status[] = ['yes', 'not_found', 'unknown', 'skipped', 'invalid'];

export const REPORT_COLUMNS = [
  'input',
  'e164',
  'country',
  ...APPS,
  'last_checked_at',
  ...APPS.map((app) => `${app}_checked_at` as const),
  ...APPS.map((app) => `${app}_stale` as const),
] as const;

/** When a yes/not_found was observed, and whether it is too old (or future-dated) to count as fresh. */
export interface Observation {
  checkedAt: number;
  stale: boolean;
}

/** What "fresh" means for the report: the same max age the scheduler uses. */
export interface ReportFreshness {
  now: number;
  maxAgeMs: number;
}

export interface ReportRow {
  input: string;
  /** Empty for invalid input. */
  e164: string;
  country: string;
  statuses: Record<App, Status>;
  /** Per app: the stored yes/not_found observation (undefined for unknown, skipped, invalid or nothing stored). */
  observations: Partial<Record<App, Observation>>;
  /** Newest check time among the reported results (an `unknown` attempt included); undefined when none. */
  lastCheckedAt: number | undefined;
}

export type AppTotals = Record<Status, number>;

export interface ReportSummary {
  rows: number;
  valid: number;
  invalid: number;
  perApp: Record<App, AppTotals>;
  /** Per app: yes/not_found cells whose observation is older than the max age (or future-dated). */
  stale: Record<App, number>;
  /** Number of `yes` per country (ISO2, '' = unknown) per app. */
  yesByCountry: Map<string, Record<App, number>>;
}

/**
 * Build one report row per input entry from stored results.
 *
 * Cell rules: invalid number -> `invalid` everywhere; app not in `apps` or number outside
 * the app's scope -> `skipped`; stored result -> its status (last known, even if older than
 * --max-age); nothing stored yet -> `unknown` (pending). `last_checked_at` is the NEWEST time of
 * any stored result of the row (an `unknown` attempt included) and says nothing about each app;
 * `<app>_checked_at` / `<app>_stale` give the time of the yes/not_found itself and whether it is
 * older than the max age (or dated in the future), i.e. a retained result a refresh did not replace.
 */
export function buildReport(
  store: Store,
  entries: InputEntry[],
  apps: readonly App[],
  freshness: ReportFreshness,
  /** Results already loaded per app; maps missing an app fall back to one `allResults` call. */
  stored?: Partial<Record<App, Map<string, StoredResult>>>,
): ReportRow[] {
  const selected = new Set<App>(apps);
  const results = {} as Record<App, Map<string, StoredResult>>;
  for (const app of APPS) results[app] = stored?.[app] ?? (selected.has(app) ? store.allResults(app) : new Map());

  return entries.map((entry): ReportRow => {
    const statuses = {} as Record<App, Status>;
    const observations: Partial<Record<App, Observation>> = {};
    const { phone } = entry;
    if (phone === null) {
      for (const app of APPS) statuses[app] = 'invalid';
      return { input: entry.input, e164: '', country: '', statuses, observations, lastCheckedAt: undefined };
    }
    let lastCheckedAt: number | undefined;
    for (const app of APPS) {
      if (!selected.has(app) || !APP_SCOPE[app](phone)) {
        statuses[app] = 'skipped';
        continue;
      }
      const result = results[app].get(phone.e164);
      statuses[app] = result?.status ?? 'unknown';
      if (result && (lastCheckedAt === undefined || result.checkedAt > lastCheckedAt)) lastCheckedAt = result.checkedAt;
      // Only a yes/not_found is an observation about the number; an `unknown` row only records an attempt.
      if (result && result.status !== 'unknown') {
        observations[app] = { checkedAt: result.checkedAt, stale: !isFresh(result, freshness.now, freshness.maxAgeMs) };
      }
    }
    return { input: entry.input, e164: phone.e164, country: phone.country, statuses, observations, lastCheckedAt };
  });
}

/**
 * Cells that spreadsheets would evaluate as formulas (`=`, `+`, `-`, `@`, tab, CR, LF, their
 * full-width forms, optionally after spaces or invisible marks) get a leading `'` so
 * Excel/LibreOffice show them as text.
 */
const FORMULA_START = /^[\t\r\n]|^[\s\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;
/** A plain phone-looking value cannot carry a formula payload; keep valid numbers readable. */
const PLAIN_PHONE_TEXT = /^\+?[\d ().-]+$/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One report row as CSV cells; shared by the buffered formatter and the streaming writer. */
function reportCells(row: ReportRow): string[] {
  return [
    // The input cell is customer-supplied text: neutralize spreadsheet formulas unless it is a
    // valid number written with only phone characters. e164/country/status cells are ours.
    row.e164 !== '' && PLAIN_PHONE_TEXT.test(row.input) ? row.input : neutralizeFormula(row.input),
    row.e164,
    row.country,
    ...APPS.map((app) => row.statuses[app]),
    row.lastCheckedAt === undefined ? '' : new Date(row.lastCheckedAt).toISOString(),
    ...APPS.map((app) => {
      const at = row.observations[app]?.checkedAt;
      return at === undefined || !Number.isFinite(at) ? '' : new Date(at).toISOString();
    }),
    ...APPS.map((app) => {
      const observation = row.observations[app];
      return observation === undefined ? '' : observation.stale ? 'yes' : 'no';
    }),
  ];
}

export function formatReportCsv(rows: ReportRow[]): string {
  return stringify(
    rows.map(reportCells),
    { header: true, columns: [...REPORT_COLUMNS] },
  );
}

export interface ReportTarget {
  /** Replace an existing file even when it is not a report written by this tool. */
  force?: boolean | undefined;
  /** Files that must never be overwritten (the input CSV); compared by real path and by inode. */
  protectedFiles?: readonly string[] | undefined;
  /** Directory trees that must never be written into or overwritten (the data directory). */
  protectedDirs?: readonly string[] | undefined;
}

/**
 * `realpath` that tolerates a path whose tail does not exist yet. The native implementation also
 * returns the on-disk letter case of the existing part on case-insensitive volumes.
 */
function realpathLoose(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function inodeKey(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
}

/** Inode keys of `path` (when it exists) and of every existing ancestor directory. */
export function ancestorInodeKeys(path: string): Set<string> {
  const keys = new Set<string>();
  for (let current = resolve(path); ; current = dirname(current)) {
    const key = inodeKey(current);
    if (key !== undefined) keys.add(key);
    if (dirname(current) === current) return keys;
  }
}

/** Default volumes on macOS and Windows ignore letter case, so `DATA` and `data` are one directory. */
const CASE_INSENSITIVE_PLATFORM = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Whether `real` (a canonical path whose tail may not exist yet) is `root` or lies below it.
 * String prefixes alone miss case variants on case-insensitive volumes, so when `root` exists the
 * decision is made by inode: the report must not have `root` as itself or any existing ancestor,
 * whatever letter case or link it was reached through, even when the leaf is absent. A `root` that
 * does not exist yet can only be compared by name, case-folded on case-insensitive platforms.
 */
export function isInsideProtectedDir(real: string, root: string, caseInsensitive = CASE_INSENSITIVE_PLATFORM): boolean {
  if (real === root || real.startsWith(root + sep)) return true;
  const rootKey = inodeKey(root);
  if (rootKey !== undefined) return ancestorInodeKeys(real).has(rootKey);
  if (!caseInsensitive) return false;
  const folded = real.toLowerCase();
  const foldedRoot = root.toLowerCase();
  return folded === foldedRoot || folded.startsWith(foldedRoot + sep);
}

/** Inodes of every regular file below `dir` (database, WAL/SHM, sessions) so hardlinks are caught. */
function protectedInodes(dir: string): Set<string> {
  const keys = new Set<string>();
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return keys;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const key = inodeKey(join(entry.parentPath, entry.name));
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

const HEADER_LINE = REPORT_COLUMNS.join(',');
/** Reports written before the per-app `_checked_at` / `_stale` columns existed are still this tool's own files. */
const PREVIOUS_HEADER_LINE = ['input', 'e164', 'country', ...APPS, 'last_checked_at'].join(',');

/** True when the file is empty or starts with this tool's report header (current or previous layout). */
function looksLikePriorReport(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(HEADER_LINE.length + 2);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read === 0) return true;
    const first = buffer.toString('utf8', 0, read).split(/\r?\n/, 1)[0];
    return first === HEADER_LINE || first === PREVIOUS_HEADER_LINE;
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate that `path` is a safe place for the report and return its absolute form. Refuses the
 * input CSV (by path, symlink or hardlink), anything inside the data directory, non-regular files,
 * and existing files that are not a previous report unless `force` is set.
 */
export function checkReportTarget(path: string, target: ReportTarget = {}): string {
  const dest = resolve(path);
  const real = realpathLoose(dest);
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  const existingKey = existing === undefined ? undefined : inodeKey(dest);

  for (const file of target.protectedFiles ?? []) {
    if (real === realpathLoose(file) || (existingKey !== undefined && existingKey === inodeKey(file))) {
      throw new Error(`--out must differ from the input CSV (${path} is the same file, possibly via a link)`);
    }
  }
  for (const dir of target.protectedDirs ?? []) {
    const root = realpathLoose(dir);
    if (isInsideProtectedDir(real, root)) {
      throw new Error(`--out ${path} is inside the data directory ${dir}; choose a report file outside it`);
    }
    if (existingKey !== undefined && protectedInodes(root).has(existingKey)) {
      throw new Error(`--out ${path} is the same file as a data-directory file (hard link); choose another report file`);
    }
  }

  if (existing === undefined) return dest;
  if (existing.isSymbolicLink()) {
    if (target.force !== true) {
      throw new Error(`--out ${path} is a symbolic link; refusing to replace it. Pass --force to replace the link itself.`);
    }
    return dest;
  }
  if (!existing.isFile()) throw new Error(`--out ${path} exists and is not a regular file`);
  if (target.force !== true && !looksLikePriorReport(dest)) {
    throw new Error(`--out ${path} already exists and is not a report written by this tool; pass --force to overwrite it`);
  }
  return dest;
}

/** A writer killed mid-write leaves its temp file behind; one this old cannot belong to a live writer. */
const STALE_TEMP_MS = 15 * 60 * 1000;

/**
 * Remove temp files of earlier, killed runs of this report (`.<name>.<16 hex>.tmp`, regular files
 * only, never links). They hold a partial copy of customer data and nothing else would ever delete them.
 */
function removeStaleTemps(dest: string): void {
  const dir = dirname(dest);
  const pattern = new RegExp(`^\\.${basename(dest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{16}\\.tmp$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_TEMP_MS) unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
}

/** Serialized CSV accumulates to this size before it is written to the file. */
const WRITE_FLUSH_SIZE = 256 * 1024;

/**
 * Write the report atomically: an exclusive, unpredictable mode-0600 temp file in the destination
 * directory, fsynced, then renamed over the destination. Never follows a symlink and never touches
 * a pre-existing temp path. Rows are serialized one at a time through csv-stringify's incremental
 * engine and flushed to the file, so the whole CSV string is never held in memory; the bytes are
 * identical to `formatReportCsv(rows)`.
 */
export function writeReport(path: string, rows: ReportRow[], target: ReportTarget = {}): void {
  const dest = checkReportTarget(path, target);
  removeStaleTemps(dest);
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      // The Stringifier's transform api is what its stream wrapper calls for every record; driving
      // it directly keeps this writer synchronous like the rest of the store/report layer while a
      // serialized row is written as soon as it exists, never buffered into one report string.
      const stringifier = createCsvStringifier({ header: true, columns: [...REPORT_COLUMNS] }) as unknown as {
        api: {
          __transform: (record: string[], push: (chunk: string) => void) => Error | undefined;
          bom: (push: (chunk: string) => void) => unknown;
          headers: (push: (chunk: string) => void) => Error | undefined;
        };
      };
      let pending = '';
      const push = (chunk: string) => {
        pending += chunk;
        if (pending.length >= WRITE_FLUSH_SIZE) {
          const data = Buffer.from(pending, 'utf8');
          pending = '';
          writeSync(fd, data, 0, data.length);
        }
      };
      const flush = () => {
        if (pending === '') return;
        const data = Buffer.from(pending, 'utf8');
        pending = '';
        writeSync(fd, data, 0, data.length);
      };
      for (const row of rows) {
        const error = stringifier.api.__transform(reportCells(row), push);
        if (error !== undefined) throw error;
      }
      if (rows.length === 0) {
        // An empty report is still the header line, which the engine emits from its flush step.
        stringifier.api.bom(push);
        const error = stringifier.api.headers(push);
        if (error !== undefined) throw error;
      }
      flush();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dest);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may already be gone (renamed); nothing else to clean.
    }
    throw error;
  }
}

export function summarize(rows: ReportRow[]): ReportSummary {
  const perApp = {} as Record<App, AppTotals>;
  for (const app of APPS) {
    perApp[app] = { yes: 0, not_found: 0, unknown: 0, skipped: 0, invalid: 0 };
  }
  const yesByCountry = new Map<string, Record<App, number>>();
  let invalid = 0;
  const stale: Record<App, number> = { telegram: 0, whatsapp: 0, zalo: 0, viber: 0, line: 0 };
  for (const row of rows) {
    if (row.e164 === '') invalid += 1;
    for (const app of APPS) {
      if (row.observations[app]?.stale === true) stale[app] += 1;
      const status = row.statuses[app];
      perApp[app][status] += 1;
      if (status !== 'yes') continue;
      let counts = yesByCountry.get(row.country);
      if (!counts) {
        counts = { telegram: 0, whatsapp: 0, zalo: 0, viber: 0, line: 0 };
        yesByCountry.set(row.country, counts);
      }
      counts[app] += 1;
    }
  }
  return { rows: rows.length, valid: rows.length - invalid, invalid, perApp, stale, yesByCountry };
}

/** Pads by the plain text width, then paints: colour codes never disturb the alignment. */
function table(header: string[], body: string[][], paint?: (row: number, column: number, cell: string) => string): string {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const pad = (cell: string, i: number): string => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0));
  const line = (cells: string[], row: number): string => cells.map((c, i) => (paint === undefined ? pad(c, i) : paint(row, i, pad(c, i)))).join('  ');
  return [line(header, -1), ...body.map((cells, row) => line(cells, row))].join('\n');
}

/** Colour of a status column: yes green, not_found yellow, invalid red, unknown / skipped dim. */
function statusPaint(ui: Ui, status: Status | undefined): Paint {
  if (status === 'yes') return ui.green;
  if (status === 'not_found') return ui.yellow;
  if (status === 'invalid') return ui.red;
  return ui.dim;
}

/** Extra run facts for `formatSummary` (the report command keeps the classic output). */
export interface SummaryExtras {
  /** Apps this run/report covered (default: all apps — the table then shows every column). */
  apps?: readonly App[];
  /** Wall time of the run; adds the `Done in …` header line. */
  durationMs?: number;
  /** Account names that answered at least one number, per app. */
  accountsUsed?: Partial<Record<App, readonly string[]>>;
  /** Message lookup (default: English). */
  tr?: Translator;
}

/** Human-readable summary: status counts per requested app, then `yes` counts per country. `ui` colours the status table (plain by default). */
export function formatSummary(summary: ReportSummary, ui: Ui = PLAIN_UI, options: SummaryExtras = {}): string {
  const tr = options.tr ?? translator();
  const shown = options.apps ?? APPS;
  const out: string[] = [];
  if (options.durationMs !== undefined) {
    const unfinished = shown.reduce((total, app) => total + summary.perApp[app].unknown, 0);
    out.push(tr('summaryDone', { time: formatDuration(options.durationMs), numbers: summary.rows, unfinished }), '');
  }
  out.push(tr('summaryNumbers', { total: summary.rows, valid: summary.valid, invalid: summary.invalid }), '');
  const perApp = shown.map((app) => [app, ...STATUSES.map((status) => String(summary.perApp[app][status]))]);
  out.push(
    table(
      [tr('summaryColApp'), tr('summaryColYes'), tr('summaryColNotFound'), tr('summaryColUnknown'), tr('summaryColSkipped'), tr('summaryColInvalid')],
      perApp,
      (row, column, cell) => {
        if (column === 0) return row < 0 ? ui.bold(cell) : cell;
        const status = STATUSES[column - 1];
        // Headers carry the colour of their column; a zero count is quiet (dim) whatever the column.
        if (row < 0) return ui.bold(statusPaint(ui, status)(cell));
        return (perApp[row]?.[column] ?? '0') === '0' ? ui.dim(cell) : statusPaint(ui, status)(cell);
      },
    ),
  );
  const accounts = shown
    .flatMap((app) => (options.accountsUsed?.[app] ?? []).map((name) => ({ app, name })))
    .map(({ app, name }) => `${app} ${name}`);
  if (accounts.length > 0) out.push('', tr('summaryAccountsUsed', { list: accounts.join(' · ') }));
  if (summary.yesByCountry.size > 0) {
    const countries = [...summary.yesByCountry.entries()].sort((a, b) => {
      const total = (counts: Record<App, number>) => shown.reduce((sum, app) => sum + counts[app], 0);
      return total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]);
    });
    out.push('', tr('summaryYesByCountry'));
    out.push(
      table(
        [tr('summaryColCountry'), ...shown],
        countries.map(([country, counts]) => [country === '' ? '??' : country, ...shown.map((app) => String(counts[app]))]),
      ),
    );
  }
  const stale = shown.filter((app) => summary.stale[app] > 0);
  if (stale.length > 0) {
    const staleTotal = stale.reduce((sum, app) => sum + summary.stale[app], 0);
    out.push('', tr('summaryStale', { apps: stale.map((app) => `${app} ${summary.stale[app]}`).join(', '), count: staleTotal }));
  }
  out.push('', tr('summaryFootnote'));
  return out.join('\n');
}
