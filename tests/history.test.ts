import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli.ts';
import { openRunHistory, readReportRows, RunHistory, type RunEntry } from '../src/history.ts';
import { formatReportCsv, summarize, type ReportRow } from '../src/report.ts';
import { statusesFor } from './helpers/report-rows.ts';
import { AccountBanned, type Adapter, type App, type CheckStatus } from '../src/types.ts';

let dir: string;
let data: string;

beforeEach(() => {
  // realpath: process.cwd() reports /private/var on macOS, so a relative path would otherwise resolve to another spelling of the same folder.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pac-history-')));
  data = join(dir, 'data');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = (): RunHistory => {
  const history = openRunHistory(data);
  if (history === null) throw new Error('the data directory should be usable');
  return history;
};
const stored = () => join(data, 'runs.json');
const entry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  at: 1760266200000,
  csv: join(dir, 'customers.csv'),
  apps: ['telegram', 'zalo'],
  rows: 1000,
  report: join(dir, 'report.csv'),
  log: join(data, 'check-2026-10-12.log'),
  ...overrides,
});

describe('remembering check runs', () => {
  it('lists the newest run first and caps the list at twenty', () => {
    const history = open();
    for (let n = 0; n < 25; n += 1) history.add(entry({ at: n, csv: join(dir, `in-${n}.csv`) }));
    const list = history.list();
    expect(list).toHaveLength(20);
    expect(list[0]?.at).toBe(24);
    expect(list[19]?.at).toBe(5);
  });

  it('keeps every field of a run: timestamp, CSV, apps, rows, report and log', () => {
    const history = open();
    history.add(entry());
    expect(history.list()).toEqual([entry()]);
  });

  it('survives a restart: a new store over the same folder sees the same runs', () => {
    open().add(entry());
    open().add(entry({ csv: join(dir, 'second.csv') }));
    const list = open().list();
    expect(list.map((run) => run.csv)).toEqual([join(dir, 'second.csv'), join(dir, 'customers.csv')]);
  });

  it('resolves relative paths so the rows a menu shows are absolute', () => {
    const history = open();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      history.add(entry({ csv: 'in.csv', report: 'out.csv', log: 'run.log' }));
    } finally {
      process.chdir(cwd);
    }
    expect(history.list()).toEqual([entry({ csv: join(dir, 'in.csv'), report: join(dir, 'out.csv'), log: join(dir, 'run.log') })]);
  });

  it('keeps a run whose log is empty (a check without the dashboard log)', () => {
    open().add(entry({ log: '' }));
    expect(open().list()[0]?.log).toBe('');
  });
});

describe('privacy and failure', () => {
  it('writes runs.json owner-only, and keeps a corrupt file harmless', () => {
    const history = open();
    history.add(entry());
    expect(statSync(stored()).mode & 0o777).toBe(0o600);
    writeFileSync(stored(), 'not json {{');
    expect(open().list()).toEqual([]);
  });

  it('drops malformed entries but keeps the well-formed runs around them', () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(
      stored(),
      JSON.stringify({
        runs: [
          entry({ at: 3 }),
          null,
          { at: 'not a time', csv: 42 },
          { at: 2, csv: join(dir, 'a.csv'), apps: ['telegram', 'bogus-app'], rows: 1, report: join(dir, 'r.csv'), log: '' },
        ],
      }),
    );
    const list = open().list();
    expect(list).toHaveLength(2);
    expect(list[1]?.apps).toEqual(['telegram']);
  });

  it('a second store over the same folder sees runs the first one just wrote (same-session check)', () => {
    const writer = open();
    const reader = open();
    writer.add(entry());
    // The menu and the check command hold different store instances over the same data directory;
    // the reader must see the writer's run even after it has already listed once.
    expect(reader.list()).toEqual([entry()]);
    writer.add(entry({ csv: join(dir, 'newer.csv') }));
    expect(reader.list().map((run) => run.csv)).toEqual([join(dir, 'newer.csv'), join(dir, 'customers.csv')]);
  });

  it('is null when the data directory cannot be prepared, and an unwritable file only stops remembering', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where a folder is needed');
    expect(openRunHistory(join(blocker, 'data'))).toBeNull();
    const history = open();
    mkdirSync(stored(), { recursive: true });
    expect(() => history.add(entry())).not.toThrow();
    expect(history.list()).toEqual([]);
    expect(open().list()).toEqual([]); // the write could not reach disk
  });
});

describe('re-reading a report the tool wrote', () => {
  const rows: ReportRow[] = [
    {
      input: 'An, "quoted"',
      e164: '+84901234567',
      country: 'VN',
      statuses: statusesFor({ telegram: 'yes', zalo: 'not_found' }, 'skipped'),
      observations: { telegram: { checkedAt: 1760000000000, stale: true }, zalo: { checkedAt: 1760000000000, stale: false } },
      lastCheckedAt: 1760000000000,
    },
    {
      input: 'abc',
      e164: '',
      country: '',
      statuses: statusesFor({}, 'invalid'),
      observations: {},
      lastCheckedAt: undefined,
    },
  ];

  it('rebuilds every field so summarize sees the same numbers as at write time', () => {
    const report = join(dir, 'report.csv');
    writeFileSync(report, formatReportCsv(rows));
    expect(readReportRows(report)).toEqual(rows);
    expect(summarize(readReportRows(report))).toEqual(summarize(rows));
  });

  it('accepts the older layout without the per-app _checked_at/_stale columns', () => {
    const report = join(dir, 'old-report.csv');
    const header = `input,e164,country,${['telegram', 'whatsapp', 'zalo', 'viber', 'line', 'threema', 'matrix'].join(',')},last_checked_at`;
    writeFileSync(report, `${header}\n0901234567,+84901234567,VN,yes,skipped,skipped,skipped,skipped,skipped,skipped,2026-10-12T12:00:00.000Z\n`);
    const rebuilt = readReportRows(report);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.statuses.telegram).toBe('yes');
    expect(rebuilt[0]?.observations).toEqual({});
    expect(summarize(rebuilt).perApp.telegram.yes).toBe(1);
  });

  it('refuses a foreign CSV and an unknown status cell does not pretend to be a result', () => {
    const foreign = join(dir, 'foreign.csv');
    writeFileSync(foreign, 'name,phone\nAn,0901234567\n');
    expect(() => readReportRows(foreign)).toThrow();
    const weird = join(dir, 'weird.csv');
    writeFileSync(
      weird,
      `input,e164,country,${['telegram', 'whatsapp', 'zalo', 'viber', 'line', 'threema', 'matrix'].join(',')},last_checked_at\n0901,+84901,VN,maybe,,,,,,,\n`,
    );
    expect(readReportRows(weird)[0]?.statuses.telegram).toBe('unknown');
  });
});

describe('recording a real check', () => {
  const NOW = Date.UTC(2026, 9, 12, 5, 0, 0);
  const CSV_TEXT = ['phone', '0901234567', '+6591234567', 'abc'].join('\n');

  function fakeAdapter(app: App): Adapter {
    return {
      app,
      async login() {
        throw new AccountBanned('unused in this test');
      },
      async open() {
        return {
          async check(batch) {
            return new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));
          },
          async close() {},
        };
      },
    };
  }

  it('a finished check appends one run entry naming its CSV, apps, rows and report', async () => {
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        dataDir: data,
        apps: { telegram: { enabled: true, batchSize: 5, minIntervalMs: 0, jitterMs: 0 } },
      }),
    );
    const csv = join(dir, 'customers.csv');
    const out = join(dir, 'report.csv');
    writeFileSync(csv, CSV_TEXT);
    mkdirSync(join(data, 'sessions', 'telegram', 'a'), { recursive: true });
    const program = createProgram({
      loadAdapter: async (app) => fakeAdapter(app),
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      lifecycleDir: join(dir, 'lifecycle'),
      log: () => {},
      print: () => {},
      exit: () => {},
    });
    await program.parseAsync(['--config', config, 'check', csv, '--out', out, '--apps', 'telegram'], { from: 'user' });

    expect(statSync(stored()).mode & 0o777).toBe(0o600);
    const list = open().list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      at: NOW,
      csv,
      apps: ['telegram'],
      rows: 3,
      report: out,
      log: '',
    });
  });
});
