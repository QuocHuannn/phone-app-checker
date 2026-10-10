import type { ReportRow } from '../../src/report.ts';
import { APPS, type App, type Status } from '../../src/types.ts';

/** One status for every app, derived from APPS so a new app needs no edit here. */
export function statusesFor(overrides: Partial<Record<App, Status>>, fallback: Status): Record<App, Status> {
  return Object.fromEntries(APPS.map((app) => [app, overrides[app] ?? fallback])) as Record<App, Status>;
}

/** The mixed-answer row the report tests share: telegram yes, whatsapp not_found, zalo unknown, the rest skipped. */
export const SAMPLE_STATUSES: Record<App, Status> = statusesFor({ telegram: 'yes', whatsapp: 'not_found', zalo: 'unknown' }, 'skipped');
/** Deterministic rows for writer `id` and content `variant`; big enough to need several write() calls. */
export function reportRows(id: number, variant: number, count = 3000): ReportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    input: `writer-${id}-variant-${variant}-row-${i}-${'x'.repeat(40)}`,
    e164: `+8490${String(id).padStart(2, '0')}${String(i).padStart(5, '0')}`,
    country: 'VN',
    statuses: SAMPLE_STATUSES,
    observations: { telegram: { checkedAt: Date.UTC(2026, 9, 8) + variant, stale: variant % 2 === 1 } },
    lastCheckedAt: Date.UTC(2026, 9, 8) + variant,
  }));
}

/**
 * The header the report writer must produce, spelled out from APPS instead of read back from
 * REPORT_COLUMNS, so a test comparing the two stays an independent check of column order.
 */
export const REPORT_HEADER = [
  'input',
  'e164',
  'country',
  ...APPS,
  'last_checked_at',
  ...APPS.map((app) => `${app}_checked_at`),
  ...APPS.map((app) => `${app}_stale`),
].join(',');

/** Zero-based cell positions in a report line: statuses, last_checked_at, <app>_checked_at, <app>_stale. */
export const COLS = {
  statuses: 3,
  lastChecked: 3 + APPS.length,
  checked: 4 + APPS.length,
  stale: 4 + 2 * APPS.length,
  total: 4 + 3 * APPS.length,
};

/** One report line. Apps not named in `statuses` get `otherwise`; unnamed time and stale cells stay empty. */
export function reportLine(parts: {
  input: string;
  e164: string;
  country: string;
  statuses: Partial<Record<App, Status>>;
  otherwise: Status;
  lastChecked?: string;
  checked?: Partial<Record<App, string>>;
  stale?: Partial<Record<App, string>>;
}): string {
  return [
    parts.input,
    parts.e164,
    parts.country,
    ...APPS.map((app) => parts.statuses[app] ?? parts.otherwise),
    parts.lastChecked ?? '',
    ...APPS.map((app) => parts.checked?.[app] ?? ''),
    ...APPS.map((app) => parts.stale?.[app] ?? ''),
  ].join(',');
}

/** A count for every app, zero unless named. */
export function countsFor(overrides: Partial<Record<App, number>>): Record<App, number> {
  return Object.fromEntries(APPS.map((app) => [app, overrides[app] ?? 0])) as Record<App, number>;
}
