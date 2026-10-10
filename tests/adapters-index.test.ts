import { describe, expect, it } from 'vitest';
import { APP_SCOPE, loadAdapter } from '../src/adapters/index.ts';
import { APPS } from '../src/types.ts';

describe('loadAdapter', () => {
  it.each(APPS)('loads the real %s adapter module', async (app) => {
    const adapter = await loadAdapter(app);
    expect(adapter.app).toBe(app);
    expect(typeof adapter.login).toBe('function');
    expect(typeof adapter.open).toBe('function');
  });
});

describe('APP_SCOPE', () => {
  const vn = { e164: '+84901234567', country: 'VN' };
  const sg = { e164: '+6591234567', country: 'SG' };

  it('limits Zalo to Vietnam and checks every other app for every country', () => {
    expect(APP_SCOPE.zalo(vn)).toBe(true);
    expect(APP_SCOPE.zalo(sg)).toBe(false);
    for (const app of APPS.filter((candidate) => candidate !== 'zalo')) {
      expect(APP_SCOPE[app](vn)).toBe(true);
      expect(APP_SCOPE[app](sg)).toBe(true);
    }
  });
});
