import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isSupportedCountry } from 'libphonenumber-js/max';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, loadConfig, type Config } from '../src/config.ts';
import { APPS } from '../src/types.ts';
import { Prng } from './helpers/prng.ts';

const dir = mkdtempSync(join(tmpdir(), 'checker-config-fuzz-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fileNo = 0;
function load(content: string | Buffer): Config {
  fileNo += 1;
  const path = join(dir, `config-${fileNo}.json`);
  writeFileSync(path, content);
  return loadConfig(path);
}

/** The contract every successfully loaded config must satisfy, whatever the file said. */
function assertSane(config: Config): void {
  expect(isSupportedCountry(config.defaultRegion)).toBe(true);
  expect(isAbsolute(config.dataDir)).toBe(true);
  expect(Number.isFinite(config.maxAgeDays) && config.maxAgeDays >= 0).toBe(true);
  for (const app of APPS) {
    const c = config.apps[app];
    expect(typeof c.enabled).toBe('boolean');
    expect(Number.isInteger(c.batchSize) && c.batchSize >= 1, `${app}.batchSize ${c.batchSize}`).toBe(true);
    expect(Number.isInteger(c.dailyCap) && c.dailyCap >= 1, `${app}.dailyCap ${c.dailyCap}`).toBe(true);
    expect(c.rateLimitCooldownMs).toBeGreaterThanOrEqual(1);
    for (const key of ['minIntervalMs', 'jitterMs', 'rateLimitCooldownMs', 'errorCooldownMs'] as const) {
      expect(Number.isFinite(c[key]) && c[key] >= 0 && c[key] <= 365 * 24 * 3_600_000, `${app}.${key} ${c[key]}`).toBe(true);
    }
    expect(c.options !== null && typeof c.options === 'object' && !Array.isArray(c.options)).toBe(true);
  }
}

function expectConfigError(content: string | Buffer, pattern?: RegExp): void {
  let caught: unknown;
  try {
    load(content);
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a config error for ${JSON.stringify(content.toString().slice(0, 80))}`).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/^Config error:/);
  if (pattern) expect((caught as Error).message).toMatch(pattern);
}

describe('loadConfig: files that are not a config', () => {
  it.each([
    ['empty file', ''],
    ['whitespace only', '  \n\t '],
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"vn"'],
    ['number', '123'],
    ['true', 'true'],
    ['truncated object', '{"defaultRegion": "VN"'],
    ['trailing comma', '{"defaultRegion": "VN",}'],
    ['comments', '{"defaultRegion": "VN" /* x */}'],
    ['single quotes', "{'defaultRegion': 'VN'}"],
    ['curly quotes', '{\u201CdefaultRegion\u201D: \u201CVN\u201D}'],
    ['binary garbage', Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x7b])],
    ['NaN literal', '{"maxAgeDays": NaN}'],
    ['Infinity literal', '{"maxAgeDays": Infinity}'],
    ['duplicate-looking nesting 200k deep', `${'['.repeat(200_000)}${']'.repeat(200_000)}`],
  ])('rejects %s with a config error', (_name, content) => {
    expectConfigError(content);
  });

  it('accepts a UTF-8 byte order mark (Notepad)', () => {
    const config = load(`\ufeff${JSON.stringify({ defaultRegion: 'SG' })}`);
    expect(config.defaultRegion).toBe('SG');
    expect(load(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])).defaultRegion).toBe('VN');
  });

  it('reads an empty object as all defaults', () => {
    const config = load('{}');
    assertSane(config);
    expect(config.apps).toEqual(DEFAULT_APPS);
  });

  it('reports a directory, a missing file and an unreadable file clearly', () => {
    expect(() => loadConfig(dir)).toThrow(/^Config error:/);
    expect(() => loadConfig(join(dir, 'does-not-exist.json'))).toThrow(/not found/);
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked.json');
      writeFileSync(locked, '{}');
      chmodSync(locked, 0o000);
      expect(() => loadConfig(locked)).toThrow(/^Config error:.*cannot read \(EACCES\)/);
      chmodSync(locked, 0o600);
    }
  });

  it('never echoes file content (an API hash) in a syntax error', () => {
    const secret = 'sup3rSecretApiHash0123456789abcdef';
    for (const text of [
      `{"apps": {"telegram": {"options": {"apiHash": "${secret}" "apiId": 1}}}}`,
      `{"apps": {"telegram": {"options": {"apiHash": "${secret}",,}}}}`,
      `{"apps": {"telegram": {"options": {"apiHash": ${secret}}}}}`,
      `{"apps": {"telegram": {"options": {"apiHash": "${secret}"}}}`,
    ]) {
      let message = '';
      try {
        load(text);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Config error:/);
      expect(message).not.toContain(secret);
    }
  });
});

describe('loadConfig: wrong values', () => {
  const app = (settings: unknown) => JSON.stringify({ apps: { telegram: settings } });
  it.each([
    ['defaultRegion wrong type', JSON.stringify({ defaultRegion: 84 }), /defaultRegion/],
    ['defaultRegion lower case', JSON.stringify({ defaultRegion: 'vn' }), /defaultRegion/],
    ['defaultRegion long', JSON.stringify({ defaultRegion: 'VNM' }), /defaultRegion/],
    ['defaultRegion UK is not ISO', JSON.stringify({ defaultRegion: 'UK' }), /not a known country code/],
    ['defaultRegion ZZ', JSON.stringify({ defaultRegion: 'ZZ' }), /not a known country code/],
    ['dataDir number', JSON.stringify({ dataDir: 5 }), /dataDir/],
    ['dataDir empty', JSON.stringify({ dataDir: '' }), /dataDir/],
    ['dataDir blank', JSON.stringify({ dataDir: '   ' }), /dataDir/],
    ['maxAgeDays negative', JSON.stringify({ maxAgeDays: -1 }), /maxAgeDays/],
    ['maxAgeDays string', JSON.stringify({ maxAgeDays: '30' }), /maxAgeDays/],
    ['maxAgeDays overflow to Infinity', '{"maxAgeDays": 1e999}', /maxAgeDays/],
    ['unknown top-level key', JSON.stringify({ defaultRegon: 'VN' }), /unknown setting "defaultRegon"/],
    ['apps array', JSON.stringify({ apps: [] }), /apps must be an object/],
    ['apps string', JSON.stringify({ apps: 'x' }), /apps must be an object/],
    ['unknown app', JSON.stringify({ apps: { signal: {} } }), /unknown app "signal"/],
    ['app as array', app([]), /apps\.telegram must be an object/],
    ['app as null', app(null), /apps\.telegram must be an object/],
    ['app as number', app(3), /apps\.telegram must be an object/],
    ['unknown app setting', app({ batchsize: 5 }), /unknown setting "batchsize"/],
    ['enabled string', app({ enabled: 'yes' }), /enabled/],
    ['enabled number', app({ enabled: 1 }), /enabled/],
    ['enabled null', app({ enabled: null }), /enabled/],
    ['batchSize zero', app({ batchSize: 0 }), /batchSize/],
    ['batchSize negative', app({ batchSize: -5 }), /batchSize/],
    ['batchSize fractional', app({ batchSize: 2.5 }), /whole number/],
    ['batchSize string', app({ batchSize: '5' }), /batchSize/],
    ['batchSize null', app({ batchSize: null }), /batchSize/],
    ['batchSize Infinity', '{"apps":{"telegram":{"batchSize":1e999}}}', /batchSize/],
    ['batchSize -Infinity', '{"apps":{"telegram":{"batchSize":-1e999}}}', /batchSize/],
    ['dailyCap zero', app({ dailyCap: 0 }), /dailyCap/],
    ['dailyCap fractional (would leave an empty batch)', app({ dailyCap: 1.5 }), /whole number/],
    ['dailyCap tiny fraction', app({ dailyCap: 0.5 }), /dailyCap/],
    ['rateLimitCooldownMs zero', app({ rateLimitCooldownMs: 0 }), /rateLimitCooldownMs/],
    ['minIntervalMs negative', app({ minIntervalMs: -1 }), /minIntervalMs/],
    ['minIntervalMs huge', app({ minIntervalMs: 1e15 }), /at most/],
    ['jitterMs huge', app({ jitterMs: 1e300 }), /at most/],
    ['errorCooldownMs huge', app({ errorCooldownMs: 4e10 }), /at most/],
    ['options array', app({ options: [1, 2] }), /options must be an object/],
    ['options null', app({ options: null }), /options must be an object/],
    ['options string', app({ options: 'x' }), /options must be an object/],
  ])('rejects %s', (_name, content, pattern) => {
    expectConfigError(content, pattern);
  });

  it('treats a top-level null as "not set" (defaults), like a missing key', () => {
    const config = load('{"defaultRegion": null, "dataDir": null, "maxAgeDays": null, "apps": null}');
    assertSane(config);
    expect(config).toMatchObject({ defaultRegion: 'VN', maxAgeDays: 30 });
    expect(config.apps).toEqual(DEFAULT_APPS);
  });

  it('accepts the boundaries', () => {
    const config = load(
      app({ batchSize: 1, dailyCap: 1, rateLimitCooldownMs: 1, minIntervalMs: 0, jitterMs: 0, errorCooldownMs: 0, enabled: false }),
    );
    assertSane(config);
    expect(config.apps.telegram).toMatchObject({ batchSize: 1, dailyCap: 1, minIntervalMs: 0, enabled: false });
    assertSane(load(app({ batchSize: Number.MAX_SAFE_INTEGER, dailyCap: 2 ** 53 - 1, minIntervalMs: 365 * 24 * 3_600_000 })));
    assertSane(load(JSON.stringify({ maxAgeDays: 0 })));
    assertSane(load(JSON.stringify({ maxAgeDays: 1e300 })));
  });

  it('does not pollute Object.prototype from __proto__ keys', () => {
    const config = load('{"apps":{"telegram":{"options":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}}}');
    assertSane(config);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => load('{"__proto__": {"x": 1}}')).toThrow(/unknown setting "__proto__"/);
    expect(() => load('{"apps": {"__proto__": {}}}')).toThrow(/unknown app "__proto__"/);
    expect(() => load('{"apps": {"telegram": {"__proto__": {}}}}')).toThrow(/unknown setting "__proto__"/);
  });

  it('keeps options of a huge file usable', () => {
    const blob = 'x'.repeat(3_000_000);
    const config = load(JSON.stringify({ apps: { telegram: { options: { blob } } } }));
    expect(config.apps.telegram.options.blob).toHaveLength(3_000_000);
  });
});

describe('loadConfig: random structures never escape as anything but a config error', () => {
  const VALUES = (prng: Prng, depth: number): unknown => {
    const kind = prng.int(depth > 2 ? 9 : 12);
    switch (kind) {
      case 0:
        return null;
      case 1:
        return prng.chance(0.5);
      case 2:
        return prng.pick([0, -0, 1, -1, 2.5, 1e308, -1e308, 5e-324, 2 ** 53, 30, 1000, 86_400_000, 1e12]);
      case 3:
        return prng.pick(['', ' ', 'VN', 'US', 'UK', 'vn', 'x'.repeat(1000), '0', '\u0000', '😀', '__proto__', 'constructor']);
      case 4:
        return prng.range(-5, 5000);
      case 5:
        return prng.next() * 1e6;
      case 6:
        return prng.pick(['telegram', 'whatsapp', 'zalo', 'viber', 'line', 'signal']);
      case 7:
        return [];
      case 8:
        return {};
      case 9:
        return Array.from({ length: prng.range(0, 4) }, () => VALUES(prng, depth + 1));
      default: {
        const object: Record<string, unknown> = {};
        const keys = ['defaultRegion', 'dataDir', 'maxAgeDays', 'apps', 'enabled', 'batchSize', 'dailyCap', 'options', 'telegram', 'zalo', 'x', '__proto__'];
        for (let i = 0, n = prng.range(0, 4); i < n; i += 1) object[prng.pick(keys)] = VALUES(prng, depth + 1);
        return object;
      }
    }
  };

  const BASE = () => ({
    defaultRegion: 'VN',
    dataDir: './data',
    maxAgeDays: 30,
    apps: { telegram: { enabled: true, batchSize: 10, dailyCap: 200, minIntervalMs: 1000, options: { apiId: 1 } }, zalo: { dailyCap: 50 } },
  });

  it('mutating one setting of a valid config at a time (2000 cases)', () => {
    const prng = new Prng(31337);
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 2000; i += 1) {
      const config = BASE() as Record<string, unknown>;
      const path = prng.pick([
        ['defaultRegion'],
        ['dataDir'],
        ['maxAgeDays'],
        ['apps'],
        ['apps', 'telegram'],
        ['apps', 'zalo'],
        ['apps', 'telegram', 'enabled'],
        ['apps', 'telegram', 'batchSize'],
        ['apps', 'telegram', 'dailyCap'],
        ['apps', 'telegram', 'minIntervalMs'],
        ['apps', 'telegram', 'jitterMs'],
        ['apps', 'telegram', 'rateLimitCooldownMs'],
        ['apps', 'telegram', 'errorCooldownMs'],
        ['apps', 'telegram', 'options'],
        ['apps', 'line', 'batchSize'],
      ]);
      let cursor = config;
      for (const key of path.slice(0, -1)) {
        if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key] as Record<string, unknown>;
      }
      cursor[path[path.length - 1] as string] = VALUES(prng, 0);
      const text = JSON.stringify(config);
      try {
        assertSane(load(text));
        accepted += 1;
      } catch (error) {
        if (!(error instanceof Error) || !/^Config error:/.test(error.message)) throw new Error(`case ${i}: ${text.slice(0, 200)} -> ${String(error)}`, { cause: error });
        rejected += 1;
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(500);
  });

  it('arbitrary JSON documents and byte-level corruption of a valid file (2000 cases)', () => {
    const prng = new Prng(424242);
    for (let i = 0; i < 2000; i += 1) {
      let text = JSON.stringify(prng.chance(0.5) ? VALUES(prng, 0) : BASE());
      if (prng.chance(0.5) && text.length > 2) {
        const at = prng.int(text.length);
        text = prng.pick([
          () => text.slice(0, at),
          () => text.slice(0, at) + text.slice(at + 1),
          () => text.slice(0, at) + prng.pick(['{', '}', '[', ']', ',', ':', '"', '\u201C', '\u0000', '\ufeff']) + text.slice(at),
          () => text.slice(at),
        ])();
      }
      try {
        assertSane(load(text));
      } catch (error) {
        if (!(error instanceof Error) || !/^Config error:/.test(error.message)) throw new Error(`case ${i}: ${JSON.stringify(text.slice(0, 200))} -> ${String(error)}`, { cause: error });
      }
    }
  });

  it('a relative dataDir is anchored at the base directory, an absolute one is kept', () => {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'checker.config.json'), JSON.stringify({ dataDir: 'store' }));
    expect(loadConfig(undefined, join(dir, 'home')).dataDir).toBe(join(dir, 'home', 'store'));
    expect(load(JSON.stringify({ dataDir: '/var/tmp/x' })).dataDir).toBe('/var/tmp/x');
  });
});
