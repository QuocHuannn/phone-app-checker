import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { writePrivateFileAtomic } from './private-file.ts';
import { REPORT_COLUMNS, STATUSES, type ReportRow } from './report.ts';
import { APPS, type App, type Status } from './types.ts';

/** One remembered check run: where its inputs, report and log are; never result data. */
export interface RunEntry {
  /** Epoch milliseconds when the check finished writing its report. */
  at: number;
  /** Absolute path of the input CSV that was checked. */
  csv: string;
  /** Apps the run covered (a report column still exists per unchecked app, as `skipped`). */
  apps: App[];
  /** Rows in the input CSV (invalid numbers included). */
  rows: number;
  /** Absolute path of the report the run wrote; may not exist any more. */
  report: string;
  /** Absolute path of the dashboard run log, or '' when the run had none (it is pruned on its own schedule). */
  log: string;
}

interface RunFile {
  runs: RunEntry[];
}

const RUN_LIMIT = 20;
const FILE_NAME = 'runs.json';
/** Open flag that refuses to follow a symlink in the last path component (POSIX only). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A stored run is kept only when every field has the right shape; unknown app names are dropped, not the run. */
function parseRun(entry: unknown): RunEntry | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const run = entry as Partial<RunEntry>;
  if (typeof run.at !== 'number' || typeof run.csv !== 'string' || typeof run.rows !== 'number') return undefined;
  if (!Array.isArray(run.apps) || typeof run.report !== 'string' || (run.log !== undefined && typeof run.log !== 'string')) return undefined;
  const apps = run.apps.filter((app): app is App => typeof app === 'string' && (APPS as readonly string[]).includes(app));
  return { at: run.at, csv: run.csv, apps, rows: run.rows, report: run.report, log: run.log ?? '' };
}

function parseRuns(text: string): RunFile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<RunFile>;
    const runs = (raw.runs ?? []).map(parseRun).filter((run): run is RunEntry => run !== undefined).slice(0, RUN_LIMIT);
    return { runs };
  } catch {
    return undefined;
  }
}

/**
 * The last checks run, kept in a private (600) JSON file inside the data directory: paths, counts and
 * timestamps only, never result data. Every method is safe on a read-only or corrupt file — listing is
 * empty, recording silently stops — so the menu never breaks over it. `null` is returned only when even
 * the directory cannot be prepared.
 */
export function openRunHistory(dataDir: string): RunHistory | null {
  const dir = resolve(dataDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
    return new RunHistory(dir);
  } catch {
    return null;
  }
}

export class RunHistory {
  private readonly file: string;

  /** `dir` must already be a private directory (the data directory or the app home). */
  constructor(dir: string) {
    this.file = join(dir, FILE_NAME);
  }

  private read(): RunFile {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      // Missing or unreadable file: nothing remembered yet.
    }
    return text === '' ? { runs: [] } : (parseRuns(text) ?? { runs: [] });
  }

  /**
   * Atomic mode-600 write: a private temp file beside `runs.json` is synced and renamed over it, so a
   * crash mid-write leaves the old list whole instead of a truncated file.
   */
  private write(state: RunFile): void {
    try {
      writePrivateFileAtomic(this.file, `${JSON.stringify(state)}\n`);
    } catch {
      // Nothing writable here: remembering is best-effort.
    }
  }

  /** The remembered runs, newest first (missing report or log files are kept — the list marks them). Always re-read: a check from this same session may have appended a run through its own store. */
  list(): RunEntry[] {
    return this.read().runs;
  }

  /** Remember a run (newest first, capped at twenty); a no-op when the file cannot be written. */
  add(run: RunEntry): void {
    const entry: RunEntry = {
      ...run,
      csv: resolve(run.csv),
      report: resolve(run.report),
      log: run.log === '' ? '' : resolve(run.log),
    };
    this.write({ runs: [entry, ...this.read().runs].slice(0, RUN_LIMIT) });
  }
}

/**
 * Reports written before the per-app `_checked_at` / `_stale` columns existed are still re-readable;
 * without observation columns a rebuilt row simply has nothing stale to report.
 */
const PREVIOUS_HEADER = ['input', 'e164', 'country', ...APPS, 'last_checked_at'].join(',');
const FULL_HEADER = REPORT_COLUMNS.join(',');

/**
 * Re-read a report CSV this tool wrote and rebuild its rows for {@link summarize}: statuses come from
 * the per-app columns, staleness from the `_stale` columns (the previous layout has none, so a rebuilt
 * row simply reports nothing stale). Any other header — a foreign file, a truncated first line —
 * throws, so the caller can say the report is gone.
 */
export function readReportRows(path: string): ReportRow[] {
  const records = parse(readFileSync(path, 'utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];
  const header = (records[0] ?? []).join(',');
  const full = header === FULL_HEADER;
  if (!full && header !== PREVIOUS_HEADER) throw new Error('not a report written by this tool');
  const CHECKED_AT = 4 + APPS.length;
  const STALE = CHECKED_AT + APPS.length;
  return records.slice(1).map((record): ReportRow => {
    const statuses = {} as Record<App, Status>;
    const observations: Partial<Record<App, { checkedAt: number; stale: boolean }>> = {};
    for (const [index, app] of APPS.entries()) {
      const cell = record[3 + index] ?? '';
      statuses[app] = (STATUSES as readonly string[]).includes(cell) ? (cell as Status) : 'unknown';
      if (!full) continue;
      const checkedAt = Date.parse(record[CHECKED_AT + index] ?? '');
      if (!Number.isNaN(checkedAt)) observations[app] = { checkedAt, stale: record[STALE + index] === 'yes' };
    }
    const e164 = record[1] ?? '';
    const lastCheckedAt = Date.parse(record[3 + APPS.length] ?? '');
    return {
      input: record[0] ?? '',
      e164,
      country: e164 === '' ? '' : (record[2] ?? ''),
      statuses,
      observations,
      lastCheckedAt: Number.isNaN(lastCheckedAt) ? undefined : lastCheckedAt,
    };
  });
}
