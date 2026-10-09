import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Linejs from '@evex/linejs';
import { lineAdapter } from '../src/adapters/line.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

// Test double for the linejs login functions and client only; the adapter is real.
const fake = vi.hoisted(() => ({
  findContact: undefined as undefined | ((params: { phone: string }) => Promise<unknown>),
  authToken: 'token-1' as string | undefined,
  loginError: undefined as unknown,
  loginInit: undefined as unknown,
  loginToken: undefined as string | undefined,
  qrCallbacks: undefined as undefined | ((callbacks: { onReceiveQRUrl?: (url: string) => void; onPincodeRequest?: (pin: string) => void }) => void),
  tokenListeners: [] as Array<(token: string) => void>,
  closed: 0,
}));

vi.mock('@evex/linejs', async (importOriginal) => {
  const real = await importOriginal<typeof Linejs>();
  function makeClient() {
    return {
      base: {
        get authToken() {
          return fake.authToken;
        },
        relation: { findContactByPhoneV3: (params: { phone: string }) => fake.findContact?.(params) },
        push: {
          conns: [
            {
              async close() {
                fake.closed += 1;
              },
            },
          ],
        },
        on(event: string, listener: (token: string) => void) {
          if (event === 'update:authtoken') fake.tokenListeners.push(listener);
        },
      },
    };
  }
  return {
    ...real,
    loginWithAuthToken: async (token: string, init: unknown) => {
      fake.loginToken = token;
      fake.loginInit = init;
      if (fake.loginError) throw fake.loginError;
      return makeClient();
    },
    loginWithQR: async (callbacks: { onReceiveQRUrl?: (url: string) => void; onPincodeRequest?: (pin: string) => void }, init: unknown) => {
      fake.loginInit = init;
      fake.qrCallbacks?.(callbacks);
      if (fake.loginError) throw fake.loginError;
      return makeClient();
    },
  };
});

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+84912345678', country: 'VN' };
const C: PhoneNumber = { e164: '+85291234567', country: 'HK' };

let dir: string;
let options: Record<string, unknown>;

function ctx(): AdapterContext {
  return {
    app: 'line',
    account: 'l1',
    accountDir: dir,
    pacing: {
      enabled: true,
      batchSize: 1,
      dailyCap: 50,
      minIntervalMs: 0,
      jitterMs: 0,
      rateLimitCooldownMs: 1000,
      errorCooldownMs: 1000,
    },
    options,
    log: () => {},
  };
}

function saveAuth(value: unknown = { authToken: 'token-1', device: 'DESKTOPWIN' }): void {
  writeFileSync(join(dir, 'line-auth.json'), JSON.stringify(value));
}

/** Shape of what linejs throws for a TalkException: InternalError{ type, data: { code, reason } }. */
function talkError(code: string, reason?: string): Error {
  return Object.assign(new Error(`TalkException ${code}`), { type: 'LiffError', data: { code, reason } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-adapter-'));
  options = {};
  fake.findContact = undefined;
  fake.authToken = 'token-1';
  fake.loginError = undefined;
  fake.loginInit = undefined;
  fake.qrCallbacks = undefined;
  fake.loginToken = undefined;
  fake.tokenListeners.length = 0;
  fake.closed = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('line open()', () => {
  it('needs a saved session and says how to create it', async () => {
    await expect(lineAdapter.open(ctx())).rejects.toThrow(/login line --account l1/);
  });

  it('rejects an unreadable or invalid auth file', async () => {
    writeFileSync(join(dir, 'line-auth.json'), '{nope');
    await expect(lineAdapter.open(ctx())).rejects.toThrow(/unreadable/);
    saveAuth({ authToken: '', device: 'DESKTOPWIN' });
    await expect(lineAdapter.open(ctx())).rejects.toThrow(/invalid/);
    saveAuth({ authToken: 'x', device: 'TOASTER' });
    await expect(lineAdapter.open(ctx())).rejects.toThrow(/invalid/);
  });

  it('logs in with the saved token and device, creating private storage', async () => {
    saveAuth({ authToken: 'token-9', device: 'DESKTOPMAC' });
    fake.authToken = 'token-9';
    await lineAdapter.open(ctx());
    expect(fake.loginToken).toBe('token-9');
    expect(fake.loginInit).toMatchObject({ device: 'DESKTOPMAC' });
    expect(statSync(join(dir, 'line-storage.json')).mode & 0o777).toBe(0o600);
  });

  it('persists a token refreshed during login and later', async () => {
    saveAuth();
    fake.authToken = 'token-2';
    await lineAdapter.open(ctx());
    expect(JSON.parse(readFileSync(join(dir, 'line-auth.json'), 'utf8'))).toEqual({ authToken: 'token-2', device: 'DESKTOPWIN' });
    fake.tokenListeners[0]?.('token-3');
    expect(JSON.parse(readFileSync(join(dir, 'line-auth.json'), 'utf8')).authToken).toBe('token-3');
  });

  it('maps a revoked token to AccountBanned', async () => {
    saveAuth();
    fake.loginError = talkError('AUTHENTICATION_FAILED', 'token revoked');
    await expect(lineAdapter.open(ctx())).rejects.toBeInstanceOf(AccountBanned);
  });

  it('keeps other login failures as plain errors without leaking digits', async () => {
    saveAuth();
    fake.loginError = new Error('connect ECONNRESET for +84901234567');
    const error = await lineAdapter.open(ctx()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AccountBanned);
    expect((error as Error).message).not.toContain('84901234567');
  });

  it('rejects an unsupported device option on login', async () => {
    options = { device: 'TOASTER' };
    await expect(lineAdapter.login(ctx())).rejects.toThrow(/Unsupported LINE device/);
    options = { loginMode: 'sms' };
    await expect(lineAdapter.login(ctx())).rejects.toThrow(/Unsupported LINE login mode/);
  });
});

describe('line check()', () => {
  async function session() {
    saveAuth();
    return lineAdapter.open(ctx());
  }

  it('is yes when a contact (mid) comes back and queries by E.164', async () => {
    const queried: string[] = [];
    fake.findContact = async ({ phone }) => {
      queried.push(phone);
      return { mid: 'u123' };
    };
    expect((await (await session()).check([A])).get(A.e164)).toBe('yes');
    expect(queried).toEqual([A.e164]);
  });

  it('is unknown when the answer has no mid', async () => {
    fake.findContact = async () => ({});
    expect((await (await session()).check([A])).get(A.e164)).toBe('unknown');
  });

  it('is not_found for NOT_FOUND', async () => {
    fake.findContact = async () => {
      throw talkError('NOT_FOUND');
    };
    expect((await (await session()).check([A])).get(A.e164)).toBe('not_found');
  });

  it('reads the code from a nested response too (data.e.code)', async () => {
    fake.findContact = async () => {
      throw Object.assign(new Error('x'), { type: 'InternalError', data: { e: { code: 'NOT_FOUND' } } });
    };
    expect((await (await session()).check([A])).get(A.e164)).toBe('not_found');
  });

  it.each(['EXCESSIVE_ACCESS', 'EXCEED_DAILY_QUOTA', 'ABUSE_BLOCK', 'FEATURE_RESTRICTED', 'SERVER_BUSY'])(
    'throws RateLimited for %s with answers so far',
    async (code) => {
      fake.findContact = async ({ phone }) => {
        if (phone === A.e164) return { mid: 'u1' };
        throw talkError(code);
      };
      const error = await (await session()).check([A, B]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimited);
      expect([...(error as RateLimited).partial]).toEqual([[A.e164, 'yes']]);
      expect((error as Error).message).not.toContain(B.e164);
    },
  );

  it('treats a restriction reason without a known code as RateLimited', async () => {
    fake.findContact = async () => {
      throw talkError('SOMETHING_NEW', 'Search is restricted for this account');
    };
    await expect((await session()).check([A])).rejects.toBeInstanceOf(RateLimited);
  });

  it.each([
    ['code', talkError('NOT_AUTHENTICATED')],
    ['code', talkError('BANNED')],
    ['type', Object.assign(new Error('x'), { type: 'NotAuthorized' })],
    ['type', Object.assign(new Error('x'), { type: 'RefreshError' })],
  ])('throws AccountBanned on an auth failure by %s', async (_kind, failure) => {
    fake.findContact = async ({ phone }) => {
      if (phone === A.e164) return { mid: 'u1' };
      throw failure;
    };
    const error = await (await session()).check([A, B]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect([...(error as AccountBanned).partial]).toEqual([[A.e164, 'yes']]);
  });

  it('fails plainly on an unclassified error, naming only a masked number', async () => {
    fake.findContact = async () => {
      throw talkError('INTERNAL_ERROR', `lookup for ${C.e164} failed`);
    };
    const error = await (await session()).check([C]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimited);
    expect(error).not.toBeInstanceOf(AccountBanned);
    expect((error as Error).message).toContain('+8529****567');
    expect((error as Error).message).not.toContain(C.e164);
    expect((error as Error).message).not.toContain('85291234567');
  });

  it('closes push connections on close()', async () => {
    const s = await session();
    await s.close();
    expect(fake.closed).toBe(1);
  });
});

describe('line login()', () => {
  it('stores only the token and device, mode 600', async () => {
    fake.authToken = 'fresh-token';
    await lineAdapter.login(ctx());
    const file = join(dir, 'line-auth.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ authToken: 'fresh-token', device: 'DESKTOPWIN' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fake.closed).toBe(1);
  });

  it('fails when login yields no token', async () => {
    fake.authToken = undefined;
    await expect(lineAdapter.login(ctx())).rejects.toThrow(/without an access token/);
    expect(existsSync(join(dir, 'line-auth.json'))).toBe(false);
  });

  it('wraps login failures without leaking digits', async () => {
    fake.loginError = new Error('rejected 0901234567890');
    const error = await lineAdapter.login(ctx()).catch((e: unknown) => e);
    expect((error as Error).message).toContain('LINE qr login failed');
    expect((error as Error).message).not.toContain('0901234567890');
  });

  it('draws the QR URL with the shared renderer, in the requested language, and asks for the PIN', async () => {
    const url = `https://line.me/R/au/q/${'A1b2C3'.repeat(10)}?secret=${'x'.repeat(40)}&e2eeVersion=1`;
    fake.qrCallbacks = (callbacks) => {
      callbacks.onReceiveQRUrl?.(url);
      callbacks.onPincodeRequest?.('1234');
    };
    const logs: string[] = [];
    await lineAdapter.login({ ...ctx(), lang: 'zh', log: (message) => logs.push(message) });
    const text = logs.join('\n');
    expect(text).toContain('请用拥有该账号的手机上的 LINE 应用扫描此二维码。');
    expect(text).toContain(`(或打开: ${url})`);
    expect(text).toContain('##');
    expect(text).toContain('请在手机上输入 PIN 1234 以确认登录。');
    expect(text).not.toContain('qrcode');
  });

  it('drops the library\'s own "[login] ..." debug line from the terminal during login, and puts console.log back afterwards', async () => {
    const original = console.log;
    const seen: unknown[][] = [];
    const capture = (...args: unknown[]): void => void seen.push(args);
    console.log = capture;
    try {
      fake.qrCallbacks = () => {
        console.log('[login] ForSecure: maxCount=2 intervalSec=150 nonce=32chars');
        console.log('something else the library said');
      };
      await lineAdapter.login({ ...ctx(), log: () => {} });
      expect(console.log).toBe(capture);
      console.log('after login');
      expect(seen).toEqual([['something else the library said'], ['after login']]);
    } finally {
      console.log = original;
    }
  });
});
