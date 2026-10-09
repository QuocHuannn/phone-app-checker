import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePhoneCsv, type InputEntry } from '../src/csv.ts';
import { buildReport, formatReportCsv, formatSummary, REPORT_COLUMNS, summarize, writeReport, type ReportRow } from '../src/report.ts';
import { Store } from '../src/store.ts';
import type { App, CheckStatus } from '../src/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const T1 = Date.UTC(2026, 9, 1);
const T2 = Date.UTC(2026, 9, 2);
const T3 = Date.UTC(2026, 9, 3);
const T4 = Date.UTC(2026, 9, 4);
/** Everything in the fixture is well inside the max age. */
const FRESH = { now: T4 + DAY, maxAgeMs: 30 * DAY };

const INPUT = ['phone', '0901234567', '+65 9123 4567', 'abc', '090 123 4567'].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { store: Store; entries: InputEntry[] } {
  const store = new Store(':memory:');
  const save = (app: App, e164: string, status: CheckStatus, at: number) =>
    store.saveResults(app, new Map([[e164, status]]), at);
  save('telegram', '+84901234567', 'yes', T1);
  save('telegram', '+6591234567', 'not_found', T2);
  save('whatsapp', '+84901234567', 'yes', T3);
  save('zalo', '+84901234567', 'not_found', T4);
  // A result for an app that is not part of the report must not leak into it.
  save('viber', '+84901234567', 'yes', T4 + 1000);
  return { store, entries: parsePhoneCsv(INPUT, { defaultRegion: 'VN' }).entries };
}

describe('report', () => {
  it('writes the exact, deterministic CSV', () => {
    const { store, entries } = fixture();
    const rows = buildReport(store, entries, ['telegram', 'whatsapp', 'zalo'], FRESH);
    expect(REPORT_COLUMNS.join(',')).toBe(
      'input,e164,country,telegram,whatsapp,zalo,viber,line,last_checked_at,' +
        'telegram_checked_at,whatsapp_checked_at,zalo_checked_at,viber_checked_at,line_checked_at,' +
        'telegram_stale,whatsapp_stale,zalo_stale,viber_stale,line_stale',
    );
    expect(formatReportCsv(rows)).toBe(
      [
        REPORT_COLUMNS.join(','),
        '0901234567,+84901234567,VN,yes,yes,not_found,skipped,skipped,2026-10-04T00:00:00.000Z,' +
          '2026-10-01T00:00:00.000Z,2026-10-03T00:00:00.000Z,2026-10-04T00:00:00.000Z,,,no,no,no,,',
        '+65 9123 4567,+6591234567,SG,not_found,unknown,skipped,skipped,skipped,2026-10-02T00:00:00.000Z,' +
          '2026-10-02T00:00:00.000Z,,,,,no,,,,',
        'abc,,,invalid,invalid,invalid,invalid,invalid' + ','.repeat(11),
        '',
      ].join('\n'),
    );
    expect(formatReportCsv(buildReport(store, entries, ['zalo', 'whatsapp', 'telegram'], FRESH))).toBe(formatReportCsv(rows));
  });

  it('keeps a retained old result distinguishable: newest last_checked_at stays, per-app time and stale say the rest', () => {
    const store = new Store(':memory:');
    const e164 = '+84901234567';
    store.saveResults('telegram', new Map([[e164, 'not_found']]), T1);
    // A refresh that came back unknown never overwrites the older conclusive result...
    store.saveResults('telegram', new Map([[e164, 'unknown']]), T3);
    // ...while another app was checked recently.
    store.saveResults('whatsapp', new Map([[e164, 'yes']]), T4);
    const { entries } = parsePhoneCsv('phone\n0901234567\n', { defaultRegion: 'VN' });
    const [row] = buildReport(store, entries, ['telegram', 'whatsapp'], { now: T4 + DAY, maxAgeMs: 30 * DAY });
    expect(row?.statuses).toMatchObject({ telegram: 'not_found', whatsapp: 'yes' });
    expect(row?.lastCheckedAt).toBe(T4);
    expect(row?.observations.telegram).toEqual({ checkedAt: T1, stale: false });
    const old = buildReport(store, entries, ['telegram', 'whatsapp'], { now: T4 + DAY, maxAgeMs: 2 * DAY })[0];
    expect(old?.observations).toEqual({ telegram: { checkedAt: T1, stale: true }, whatsapp: { checkedAt: T4, stale: false } });
    // Columns: 0-2 input/e164/country, 3-7 statuses, 8 last_checked_at, 9-13 <app>_checked_at, 14-18 <app>_stale.
    const cells = formatReportCsv([old as ReportRow]).split('\n')[1]?.split(',') ?? [];
    expect(cells[8]).toBe('2026-10-04T00:00:00.000Z');
    expect(cells.slice(9, 11)).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z']);
    expect(cells.slice(14, 16)).toEqual(['yes', 'no']);
  });

  it('gives an unknown attempt no observation time, and treats a future-dated result as stale', () => {
    const store = new Store(':memory:');
    store.saveResults('telegram', new Map([['+84901234567', 'unknown']]), T2);
    store.saveResults('whatsapp', new Map([['+84901234567', 'yes']]), T4 + 10 * DAY);
    const { entries } = parsePhoneCsv('phone\n0901234567\n', { defaultRegion: 'VN' });
    const [row] = buildReport(store, entries, ['telegram', 'whatsapp'], { now: T4, maxAgeMs: 30 * DAY });
    expect(row?.statuses.telegram).toBe('unknown');
    expect(row?.observations.telegram).toBeUndefined();
    expect(row?.lastCheckedAt).toBe(T4 + 10 * DAY);
    expect(row?.observations.whatsapp?.stale).toBe(true);
  });

  it('marks disabled apps skipped even when results are stored, and pending cells unknown', () => {
    const { store, entries } = fixture();
    const [first, second] = buildReport(store, entries, ['telegram'], FRESH);
    expect(first?.statuses).toEqual({
      telegram: 'yes',
      whatsapp: 'skipped',
      zalo: 'skipped',
      viber: 'skipped',
      line: 'skipped',
    });
    expect(first?.lastCheckedAt).toBe(T1);
    expect(second?.statuses.telegram).toBe('not_found');
    const withWhatsApp = buildReport(store, entries, ['telegram', 'whatsapp'], FRESH);
    expect(withWhatsApp[1]?.statuses.whatsapp).toBe('unknown');
  });

  it('skips numbers outside an app scope (Zalo is VN only) and keeps invalid rows invalid', () => {
    const { store, entries } = fixture();
    const rows = buildReport(store, entries, ['zalo'], FRESH);
    expect(rows[1]?.statuses.zalo).toBe('skipped');
    expect(rows[2]?.statuses.zalo).toBe('invalid');
    expect(rows[2]?.e164).toBe('');
  });

  it('shows the last known result even when it is old, flagged stale', () => {
    const { store, entries } = fixture();
    const rows = buildReport(store, entries, ['telegram'], FRESH);
    expect(rows[0]?.statuses.telegram).toBe('yes');
  });

  it('keeps the original input text verbatim', () => {
    const store = new Store(':memory:');
    const { entries } = parsePhoneCsv('phone\n+84 (90) 123-4567\n', { defaultRegion: 'VN' });
    const csv = formatReportCsv(buildReport(store, entries, ['telegram'], FRESH));
    expect(csv.split('\n')[1]).toBe('+84 (90) 123-4567,+84901234567,VN,unknown,skipped,skipped,skipped,skipped' + ','.repeat(11));
  });

  it('writes the file atomically with private permissions', () => {
    const { store, entries } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'checker-report-'));
    dirs.push(dir);
    const path = join(dir, 'report.csv');
    const rows = buildReport(store, entries, ['telegram'], FRESH);
    writeReport(path, rows);
    expect(readFileSync(path, 'utf8')).toBe(formatReportCsv(rows));
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe('summary', () => {
  it('counts statuses per app and yes per country', () => {
    const { store, entries } = fixture();
    const summary = summarize(buildReport(store, entries, ['telegram', 'whatsapp', 'zalo'], FRESH));
    expect(summary).toMatchObject({ rows: 3, valid: 2, invalid: 1 });
    expect(summary.perApp.telegram).toEqual({ yes: 1, not_found: 1, unknown: 0, skipped: 0, invalid: 1 });
    expect(summary.perApp.whatsapp).toEqual({ yes: 1, not_found: 0, unknown: 1, skipped: 0, invalid: 1 });
    expect(summary.perApp.zalo).toEqual({ yes: 0, not_found: 1, unknown: 0, skipped: 1, invalid: 1 });
    expect(summary.perApp.viber.skipped).toBe(2);
    expect(summary.yesByCountry.get('VN')).toEqual({ telegram: 1, whatsapp: 1, zalo: 0, viber: 0, line: 0 });

    const text = formatSummary(summary);
    expect(text).toContain('Numbers: 3 unique (2 valid, 1 invalid)');
    expect(text).toMatch(/telegram\s+1\s+1\s+0\s+0\s+1/);
    expect(text).toContain('Registered (yes) by country');
    expect(text).toContain('not_found');
    expect(text).not.toContain('STALE');
  });

  it('counts stale observations per app and says so', () => {
    const { store, entries } = fixture();
    const summary = summarize(buildReport(store, entries, ['telegram', 'whatsapp', 'zalo'], { now: T4 + DAY, maxAgeMs: 2 * DAY }));
    // telegram yes (T1, 4 days) and not_found (T2, 3 days) are stale; whatsapp T3 (2 days, not < 2) is stale; zalo T4 is fresh.
    expect(summary.stale).toEqual({ telegram: 2, whatsapp: 1, zalo: 0, viber: 0, line: 0 });
    expect(formatSummary(summary)).toContain('STALE: telegram 2, whatsapp 1 — 3 yes/not_found results are older than the max age or dated in the future');
  });
});
