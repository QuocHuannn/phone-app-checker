import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePhoneCsv, type InputEntry } from '../src/csv.ts';
import { buildReport, formatReportCsv, formatSummary, REPORT_COLUMNS, summarize, writeReport, type AppTotals, type ReportRow, type ReportSummary } from '../src/report.ts';
import { createUi, stripAnsi } from '../src/ui.ts';
import { Store } from '../src/store.ts';
import { APPS, type App, type CheckStatus } from '../src/types.ts';
import { COLS, countsFor, REPORT_HEADER, reportLine, statusesFor } from './helpers/report-rows.ts';

const DAY = 24 * 60 * 60 * 1000;
const ESC = '\u001b';
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
    expect(REPORT_COLUMNS.join(',')).toBe(REPORT_HEADER);
    expect(formatReportCsv(rows)).toBe(
      [
        REPORT_COLUMNS.join(','),
        reportLine({
          input: '0901234567',
          e164: '+84901234567',
          country: 'VN',
          statuses: { telegram: 'yes', whatsapp: 'yes', zalo: 'not_found' },
          otherwise: 'skipped',
          lastChecked: '2026-10-04T00:00:00.000Z',
          checked: { telegram: '2026-10-01T00:00:00.000Z', whatsapp: '2026-10-03T00:00:00.000Z', zalo: '2026-10-04T00:00:00.000Z' },
          stale: { telegram: 'no', whatsapp: 'no', zalo: 'no' },
        }),
        reportLine({
          input: '+65 9123 4567',
          e164: '+6591234567',
          country: 'SG',
          statuses: { telegram: 'not_found', whatsapp: 'unknown' },
          otherwise: 'skipped',
          lastChecked: '2026-10-02T00:00:00.000Z',
          checked: { telegram: '2026-10-02T00:00:00.000Z' },
          stale: { telegram: 'no' },
        }),
        reportLine({ input: 'abc', e164: '', country: '', statuses: {}, otherwise: 'invalid' }),
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
    // Columns: input/e164/country, one status per app, last_checked_at, <app>_checked_at, <app>_stale (all derived from APPS).
    const cells = formatReportCsv([old as ReportRow]).split('\n')[1]?.split(',') ?? [];
    expect(cells[COLS.lastChecked]).toBe('2026-10-04T00:00:00.000Z');
    expect(cells.slice(COLS.checked, COLS.checked + 2)).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z']);
    expect(cells.slice(COLS.stale, COLS.stale + 2)).toEqual(['yes', 'no']);
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
    expect(first?.statuses).toEqual(statusesFor({ telegram: 'yes' }, 'skipped'));
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
    expect(csv.split('\n')[1]).toBe(
      reportLine({ input: '+84 (90) 123-4567', e164: '+84901234567', country: 'VN', statuses: { telegram: 'unknown' }, otherwise: 'skipped' }),
    );
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
    expect(summary.yesByCountry.get('VN')).toEqual(countsFor({ telegram: 1, whatsapp: 1 }));

    const text = formatSummary(summary);
    expect(text).toContain('Numbers: 3 unique (2 valid, 1 invalid)');
    // Counts carry each status's share of all 3 rows; the TOTAL line shares of all 21 cells (3 rows × 7 apps).
    expect(text).toMatch(/telegram\s+1 \(33%\)\s+1 \(33%\)\s+0 \(0%\)\s+0 \(0%\)\s+1 \(33%\)/);
    expect(text).toContain('TOTAL · yes: 2 (10%) · not_found: 2 (10%) · unknown: 1 (5%) · skipped: 9 (43%) · invalid: 7 (33%)');
    expect(text).toContain('Registered (yes) by country');
    expect(text).toMatch(/VN\s+2\s+21\s+10%/);
    expect(text).toContain('not_found');
    expect(text).not.toContain('STALE');
  });

  it('rich tier: status colours and a bold TOTAL line, same text once stripped', () => {
    const { store, entries } = fixture();
    const summary = summarize(buildReport(store, entries, ['telegram', 'whatsapp', 'zalo'], FRESH));
    const rich = formatSummary(summary, createUi({ isTTY: true, columns: 100, rows: 30 }, { TERM: 'xterm-256color' }));
    expect(rich).toContain(`${ESC}[1m${ESC}[32m`); // yes header: bold + green
    expect(rich).toContain(`${ESC}[31m`); // invalid column red
    expect(rich).toContain(`${ESC}[1mTOTAL${ESC}[22m`);
    expect(rich).toContain(`${ESC}[32myes: ${ESC}[39m`);
    // Layout parity: stripping every escape sequence reproduces the plain tier byte for byte.
    expect(stripAnsi(rich)).toBe(formatSummary(summary));
  });

  it('an empty report shows a dash instead of percentages', () => {
    const text = formatSummary(summarize([]));
    expect(text).toContain('0 (—)');
    expect(text).toContain('yes: 0 (—)');
    expect(text).not.toContain('Registered (yes) by country');
  });

  it('caps the country table at 10 rows and counts the rest', () => {
    const perApp = Object.fromEntries(
      APPS.map((app) => [app, { yes: 12, not_found: 0, unknown: 0, skipped: 0, invalid: 0 }]),
    ) as Record<App, AppTotals>;
    const yesByCountry = new Map(
      Array.from({ length: 12 }, (_, i) => [
        `C${String(i).padStart(2, '0')}`,
        Object.fromEntries(APPS.map((app) => [app, 1])) as Record<App, number>,
      ]),
    );
    const summary: ReportSummary = { rows: 12, valid: 12, invalid: 0, perApp, stale: countsFor({}), yesByCountry };
    const text = formatSummary(summary);
    expect(text).toContain('C09');
    expect(text).toContain('… 2 more');
    expect(text).not.toContain('C10');
    expect(text).not.toContain('C11');
  });

  it('counts stale observations per app and says so', () => {
    const { store, entries } = fixture();
    const summary = summarize(buildReport(store, entries, ['telegram', 'whatsapp', 'zalo'], { now: T4 + DAY, maxAgeMs: 2 * DAY }));
    // telegram yes (T1, 4 days) and not_found (T2, 3 days) are stale; whatsapp T3 (2 days, not < 2) is stale; zalo T4 is fresh.
    expect(summary.stale).toEqual(countsFor({ telegram: 2, whatsapp: 1 }));
    expect(formatSummary(summary)).toContain('STALE: telegram 2, whatsapp 1 — 3 yes/not_found results are older than the max age or dated in the future');
  });
});
