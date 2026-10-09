import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginQRCallbackEventType, ZaloApiError } from 'zca-js';
import { qrMatrix } from '../src/qr.ts';
import { qrPng } from './helpers/png.ts';
import type * as ZcaJs from 'zca-js';
import { zaloAdapter } from '../src/adapters/zalo.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

// Test double for the zca-js client only; ZaloApiError and the QR event enum are real.
const fake = vi.hoisted(() => ({
  findUser: undefined as undefined | ((phone: string) => Promise<unknown>),
  loginError: undefined as undefined | Error,
  loginQR: undefined as undefined | ((options: { qrPath: string }, callback: (event: unknown) => void) => Promise<unknown>),
  loginCalls: [] as unknown[],
}));

vi.mock('zca-js', async (importOriginal) => {
  const real = await importOriginal<typeof ZcaJs>();
  class FakeZalo {
    async login(credentials: unknown) {
      fake.loginCalls.push(credentials);
      if (fake.loginError) throw fake.loginError;
      return { findUser: (phone: string) => fake.findUser?.(phone) };
    }
    async loginQR(options: { qrPath: string }, callback: (event: unknown) => void) {
      if (!fake.loginQR) throw new Error('unexpected loginQR');
      return fake.loginQR(options, callback);
    }
  }
  return { ...real, Zalo: FakeZalo };
});

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+84912345678', country: 'VN' };
const SG: PhoneNumber = { e164: '+6591234567', country: 'SG' };

const CREDENTIALS = { imei: 'imei-1', userAgent: 'UA/1.0', cookie: [{ key: 'a', value: 'b' }], language: 'vi' };

let dir: string;
let logs: string[];

function ctx(): AdapterContext {
  return {
    app: 'zalo',
    account: 'z1',
    accountDir: dir,
    pacing: {
      enabled: true,
      batchSize: 1,
      dailyCap: 100,
      minIntervalMs: 0,
      jitterMs: 0,
      rateLimitCooldownMs: 1000,
      errorCooldownMs: 1000,
    },
    options: {},
    log: (message) => logs.push(message),
  };
}

function saveCredentials(value: unknown = CREDENTIALS): void {
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(value));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zalo-adapter-'));
  logs = [];
  fake.findUser = undefined;
  fake.loginError = undefined;
  fake.loginQR = undefined;
  fake.loginCalls.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('zalo open()', () => {
  it('requires saved credentials and explains how to create them', async () => {
    await expect(zaloAdapter.open(ctx())).rejects.toThrow(/login zalo --account z1/);
  });

  it('rejects corrupt or incomplete credential files', async () => {
    writeFileSync(join(dir, 'credentials.json'), '{not json');
    await expect(zaloAdapter.open(ctx())).rejects.toThrow(/corrupt/);
    saveCredentials({ imei: 'x' });
    await expect(zaloAdapter.open(ctx())).rejects.toThrow(/missing imei\/cookie\/userAgent/);
  });

  it('logs in with the stored credentials', async () => {
    saveCredentials();
    await zaloAdapter.open(ctx());
    expect(fake.loginCalls).toEqual([CREDENTIALS]);
  });

  it.each(['Đăng nhập thất bại', 'Khởi tạo ngữ cảnh thất bại.'])('maps the login rejection "%s" to AccountBanned', async (message) => {
    saveCredentials();
    fake.loginError = new ZaloApiError(message);
    await expect(zaloAdapter.open(ctx())).rejects.toBeInstanceOf(AccountBanned);
  });

  it('passes other login errors through', async () => {
    saveCredentials();
    fake.loginError = new Error('ENOTFOUND');
    await expect(zaloAdapter.open(ctx())).rejects.toThrow('ENOTFOUND');
  });
});

describe('zalo check()', () => {
  async function session() {
    saveCredentials();
    return zaloAdapter.open(ctx());
  }

  it('is yes when findUser returns a uid, querying without the "+"', async () => {
    const queried: string[] = [];
    fake.findUser = async (phone) => {
      queried.push(phone);
      return { uid: '123456' };
    };
    const result = await (await session()).check([A]);
    expect(result.get(A.e164)).toBe('yes');
    expect(queried).toEqual(['84901234567']);
  });

  it('is not_found for the "cannot resolve" code 216', async () => {
    fake.findUser = async () => {
      throw new ZaloApiError('Không tìm thấy', 216);
    };
    expect((await (await session()).check([A])).get(A.e164)).toBe('not_found');
  });

  it('leaves non-Vietnamese numbers out so they stay unknown', async () => {
    const queried: string[] = [];
    fake.findUser = async (phone) => {
      queried.push(phone);
      return { uid: '1' };
    };
    const result = await (await session()).check([SG, A]);
    expect([...result.keys()]).toEqual([A.e164]);
    expect(queried).toEqual(['84901234567']);
  });

  it('throws RateLimited on HTTP 429 and hands back what it already knows', async () => {
    fake.findUser = async (phone) => {
      if (phone === '84901234567') return { uid: '1' };
      throw new ZaloApiError('Request failed with status code 429');
    };
    const error = await (await session()).check([A, B]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect([...(error as RateLimited).partial]).toEqual([[A.e164, 'yes']]);
  });

  it.each(['Request failed with status code 401', 'Request failed with status code 403', 'Đăng nhập thất bại'])(
    'throws AccountBanned when the session is rejected ("%s")',
    async (message) => {
      fake.findUser = async () => {
        throw new ZaloApiError(message);
      };
      await expect((await session()).check([A])).rejects.toBeInstanceOf(AccountBanned);
    },
  );

  it('throws plain errors for other failures and logs only the masked number', async () => {
    fake.findUser = async () => {
      throw new ZaloApiError('Request failed with status code 500');
    };
    await expect((await session()).check([A])).rejects.toThrow(/status code 500/);
    expect(logs.join('\n')).not.toContain(A.e164);
    expect(logs.join('\n')).toContain('+8490****567');
  });

  it('does not guess when the response has neither error nor uid', async () => {
    fake.findUser = async () => ({});
    await expect((await session()).check([A])).rejects.toThrow(/not understood/);
  });
});

describe('zalo login()', () => {
  it('saves the QR login data with mode 600 and removes the QR image', async () => {
    fake.loginQR = async ({ qrPath }, callback) => {
      writeFileSync(qrPath, 'png');
      callback({
        type: LoginQRCallbackEventType.GotLoginInfo,
        data: { cookie: CREDENTIALS.cookie, imei: CREDENTIALS.imei, userAgent: CREDENTIALS.userAgent },
      });
      return {};
    };
    await zaloAdapter.login(ctx());
    const file = join(dir, 'credentials.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(CREDENTIALS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'login-qr.png'))).toBe(false);
  });

  it('reports a declined QR login', async () => {
    fake.loginQR = async (_options, callback) => {
      callback({ type: LoginQRCallbackEventType.QRCodeDeclined, actions: { abort() {} } });
      throw new Error('aborted');
    };
    await expect(zaloAdapter.login(ctx())).rejects.toThrow(/declined/);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('fails when the login finishes without credentials', async () => {
    fake.loginQR = async () => ({});
    await expect(zaloAdapter.login(ctx())).rejects.toThrow(/without returning credentials/);
  });

  describe('QR code in the terminal', () => {
    const PAYLOAD = 'https://zalo.me/qr/' + 'k8Jd0sQw'.repeat(6);
    const png = (payload: string, scale = 5) =>
      qrPng(qrMatrix(payload), { scale, margin: 4, colorType: 2, depth: 8 }).toString('base64');
    const generated = (image: string, actions: Record<string, unknown> = {}) => ({
      type: LoginQRCallbackEventType.QRCodeGenerated,
      data: { code: 'c', image, token: 't', options: {} },
      actions: { saveToFile: async () => { throw new Error('must not write a file'); }, retry() {}, abort() {}, ...actions },
    });
    const gotInfo = {
      type: LoginQRCallbackEventType.GotLoginInfo,
      data: { cookie: CREDENTIALS.cookie, imei: CREDENTIALS.imei, userAgent: CREDENTIALS.userAgent },
    };

    it('draws the PNG as a terminal QR (no file), then the scanned message, in the requested language', async () => {
      fake.loginQR = async (_options, callback) => {
        callback(generated(png(PAYLOAD)));
        callback({ type: LoginQRCallbackEventType.QRCodeScanned, data: { avatar: '', display_name: 'Someone' }, actions: {} });
        callback(gotInfo);
        return {};
      };
      await zaloAdapter.login({ ...ctx(), lang: 'vi' });
      const text = logs.join('\n');
      expect(text).toContain('Quét mã QR này bằng app Zalo trên điện thoại.');
      expect(text).toContain('##');
      expect(text).toContain('Đã quét mã QR. Hãy xác nhận đăng nhập trên điện thoại.');
      expect(text).not.toContain('Someone');
      expect(text).not.toMatch(/Đã lưu thông tin đăng nhập Zalo|saved for account/);
      expect(existsSync(join(dir, 'login-qr.png'))).toBe(false);
    });

    it('redraws a new code after it expires, marks it, and gives up after three expiries', async () => {
      let retries = 0;
      fake.loginQR = async (_options, callback) => {
        callback(generated(png(PAYLOAD)));
        for (let i = 0; i < 3; i++) {
          callback({ type: LoginQRCallbackEventType.QRCodeExpired, data: null, actions: { retry: () => (retries += 1), abort() {} } });
          callback(generated(png(PAYLOAD + i)));
        }
        callback({ type: LoginQRCallbackEventType.QRCodeExpired, data: null, actions: { retry: () => (retries += 1), abort() {} } });
        throw new Error('aborted');
      };
      await expect(zaloAdapter.login(ctx())).rejects.toThrow('The QR code expired too many times. Run the login again.');
      const text = logs.join('\n');
      expect(retries).toBe(3);
      expect(text).toContain('The QR code expired. Making a new one (1/3).');
      expect(text).toContain('The QR code expired. Making a new one (3/3).');
      expect(text).toContain('New QR code (#4)');
      expect(text.match(/Scan this QR code with the Zalo app on your phone\./g)).toHaveLength(1);
    });

    it('falls back to the image file (mode 600, path printed, removed afterwards) when the picture is not a readable QR', async () => {
      let saved = '';
      fake.loginQR = async ({ qrPath }, callback) => {
        callback(
          generated('not-a-png', {
            saveToFile: async (path: string) => {
              saved = path;
              writeFileSync(path, 'png');
            },
          }),
        );
        await vi.waitFor(() => expect(logs.join('\n')).toContain('scan this picture instead'));
        expect(statSync(qrPath).mode & 0o777).toBe(0o600);
        callback(gotInfo);
        return {};
      };
      await zaloAdapter.login(ctx());
      expect(saved).toBe(join(dir, 'login-qr.png'));
      expect(logs.join('\n')).toContain(`scan this picture instead: ${join(dir, 'login-qr.png')}`);
      expect(logs.join('\n')).not.toContain('The QR picture was opened'); // stdout is not a terminal here
      expect(existsSync(join(dir, 'login-qr.png'))).toBe(false);
    });
  });
});
