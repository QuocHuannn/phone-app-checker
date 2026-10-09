import type { ReportRow } from '../../src/report.ts';

/** Deterministic rows for writer `id` and content `variant`; big enough to need several write() calls. */
export function reportRows(id: number, variant: number, count = 3000): ReportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    input: `writer-${id}-variant-${variant}-row-${i}-${'x'.repeat(40)}`,
    e164: `+8490${String(id).padStart(2, '0')}${String(i).padStart(5, '0')}`,
    country: 'VN',
    statuses: { telegram: 'yes', whatsapp: 'not_found', zalo: 'unknown', viber: 'skipped', line: 'skipped' },
    observations: { telegram: { checkedAt: Date.UTC(2026, 9, 8) + variant, stale: variant % 2 === 1 } },
    lastCheckedAt: Date.UTC(2026, 9, 8) + variant,
  }));
}
