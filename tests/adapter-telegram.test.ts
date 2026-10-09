import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tl } from '@mtcute/node';
import type * as Mtcute from '@mtcute/node';
import { telegramAdapter } from '../src/adapters/telegram.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

// Test double for the mtcute client only; the adapter, mtcute's tl/RpcError and Long are real.
const fake = vi.hoisted(() => ({
  instances: [] as Array<{
    calls: Array<{ method: string; params: Record<string, unknown> }>;
    destroyed: boolean;
    options: Record<string, unknown>;
  }>,
  onCall: undefined as undefined | ((method: string, params: Record<string, unknown>) => unknown),
  getMe: undefined as undefined | (() => Promise<unknown>),
  startAnswers: [] as string[],
  startError: undefined as unknown,
  qrUrls: [] as string[],
  qrPassword: false,
  qrWaitForAbort: false,
  lastStart: undefined as undefined | { phone?: unknown },
  startUser: undefined as undefined | { displayName?: string; phoneNumber?: string | null },
}));

vi.mock('../src/prompt.ts', () => ({
  askVisible: async (question: string) => `visible:${question}`,
  askHidden: async (question: string) => `hidden:${question}`,
}));

vi.mock('@mtcute/node', async (importOriginal) => {
  const real = await importOriginal<typeof Mtcute>();
  class FakeTelegramClient {
    calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    destroyed = false;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      fake.instances.push(this);
    }
    async connect() {}
    async start(params: {
      phone: () => Promise<string>;
      code: () => Promise<string>;
      password: () => Promise<string>;
      qrCodeHandler?: (url: string, expires: Date) => void;
      abortSignal?: AbortSignal;
    }) {
      if (fake.startError) throw fake.startError;
      fake.lastStart = params;
      if (params.qrCodeHandler) {
        for (const url of fake.qrUrls) params.qrCodeHandler(url, new Date(Date.now() + 30_000));
        if (fake.qrPassword) fake.startAnswers.push(`password:${await params.password()}`);
        if (fake.qrWaitForAbort) {
          const { promise, reject } = Promise.withResolvers<never>();
          params.abortSignal?.addEventListener('abort', () => reject(params.abortSignal?.reason));
          await promise;
        }
        return fake.startUser as never;
      }
      fake.startAnswers.push(`phone:${await params.phone()}`);
      fake.startAnswers.push(`code:${await params.code()}`);
      fake.startAnswers.push(`password:${await params.password()}`);
      return fake.startUser as never;
    }
    async getMe() {
      return fake.getMe ? fake.getMe() : { id: 1 };
    }
    async call(params: { _: string } & Record<string, unknown>) {
      this.calls.push({ method: params._, params });
      if (!fake.onCall) throw new Error('unexpected call');
      return fake.onCall(params._, params);
    }
    async destroy() {
      this.destroyed = true;
    }
  }
  return { ...real, TelegramClient: FakeTelegramClient };
});

interface ClientId {
  toString(): string;
}

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+84912345678', country: 'VN' };
const C: PhoneNumber = { e164: '+6591234567', country: 'SG' };

let dir: string;
let logs: string[];

function ctx(options: Record<string, unknown> = { apiId: 12345, apiHash: 'hash' }): AdapterContext {
  return {
    app: 'telegram',
    account: 'tg1',
    accountDir: dir,
    pacing: {
      enabled: true,
      batchSize: 10,
      dailyCap: 200,
      minIntervalMs: 0,
      jitterMs: 0,
      rateLimitCooldownMs: 1000,
      errorCooldownMs: 1000,
    },
    options,
    log: (message) => logs.push(message),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-adapter-'));
  fake.startError = undefined;
  fake.qrUrls = [];
  fake.qrPassword = false;
  fake.qrWaitForAbort = false;
  fake.lastStart = undefined;
  fake.startUser = undefined;
  logs = [];
  fake.instances.length = 0;
  fake.onCall = undefined;
  fake.getMe = undefined;
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** importContacts answer: `found` numbers are imported, `retry` numbers are deferred. */
function importAnswer(found: string[], retry: string[] = []) {
  return (method: string, params: Record<string, unknown>) => {
    if (method === 'contacts.deleteByPhones') return true;
    const contacts = params.contacts as Array<{ clientId: ClientId; phone: string }>;
    return {
      imported: contacts.filter((c) => found.includes(c.phone)).map((c) => ({ clientId: c.clientId })),
      retryContacts: contacts.filter((c) => retry.includes(c.phone)).map((c) => c.clientId),
    };
  };
}

describe('telegram credentials', () => {
  it('fails with setup instructions when api credentials are missing', async () => {
    await expect(telegramAdapter.open(ctx({}))).rejects.toThrow(/TELEGRAM_API_ID/);
  });

  it('accepts credentials from the environment', async () => {
    process.env.TELEGRAM_API_ID = '777';
    process.env.TELEGRAM_API_HASH = 'abc';
    // checker.config.example.json ships apiId/apiHash as null so the environment is used.
    const session = await telegramAdapter.open(ctx({ apiId: null, apiHash: null }));
    expect(fake.instances[0]?.options.apiId).toBe(777);
    await session.close();
  });
});

describe('telegram login()', () => {
  it('asks for the phone visibly, and the code and 2FA password without echo, then destroys the client', async () => {
    fake.startAnswers.length = 0;
    await telegramAdapter.login(ctx());
    expect(fake.startAnswers).toEqual([
      'phone:visible:Telegram phone number (international format, for example +84901234567): ',
      'code:hidden:Login code sent by Telegram (not shown while you type): ',
      'password:hidden:Two-step verification password (not shown while you type): ',
    ]);
    expect(fake.instances[0]?.destroyed).toBe(true);
    // The success line ("Logged in ...") is printed once by the login command, not by each adapter.
    expect(logs.join('\n')).not.toContain('session saved');
  });

  it('asks in the language it was given', async () => {
    fake.startAnswers.length = 0;
    await telegramAdapter.login({ ...ctx(), lang: 'vi' });
    expect(fake.startAnswers[0]).toBe('phone:visible:Số điện thoại Telegram (dạng quốc tế, ví dụ +84901234567): ');
    expect(logs.join('\n')).not.toContain('đã đăng nhập');
  });

  describe('QR login (--method qr)', () => {
    const qr = (extra: Partial<AdapterContext> = {}): AdapterContext => ({ ...ctx(), loginChoice: { method: 'qr' }, ...extra });

    it('draws every token Telegram issues as a QR code, marks the refreshed one, and never asks for a phone or code', async () => {
      fake.qrUrls = ['tg://login?token=AAAA', 'tg://login?token=BBBB'];
      fake.startAnswers.length = 0;
      await telegramAdapter.login(qr());
      const text = logs.join('\n');
      expect(text).toContain('Scan this QR code with the Telegram app on your phone.');
      expect(text).toContain('Link Desktop Device');
      expect(text).toContain('New QR code (#2)');
      expect(text.match(/##/g)?.length ?? 0).toBeGreaterThan(100); // two codes, drawn in plain mode (not a terminal here)
      expect(fake.startAnswers).toEqual([]);
      expect(fake.lastStart?.phone).toBeUndefined();
      expect(logs.at(-1)).toContain('New QR code (#2)');
      expect(fake.instances[0]?.destroyed).toBe(true);
    });

    it('asks the two-step password without echo, after the code was scanned', async () => {
      fake.qrUrls = ['tg://login?token=AAAA'];
      fake.qrPassword = true;
      fake.startAnswers.length = 0;
      await telegramAdapter.login(qr());
      expect(fake.startAnswers).toEqual(['password:hidden:Two-step verification password (not shown while you type): ']);
    });

    it('gives up with a clear message when nobody scans in time', async () => {
      vi.useFakeTimers();
      try {
        fake.qrUrls = ['tg://login?token=AAAA'];
        fake.qrWaitForAbort = true;
        const done = telegramAdapter.login(qr()).catch((error: Error) => error);
        await vi.advanceTimersByTimeAsync(300_001);
        expect(await done).toMatchObject({ message: 'Nobody scanned the QR code in time. Run the login again.' });
        expect(fake.instances[0]?.destroyed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('never uses the echoing client.input for login input', async () => {
    fake.startAnswers.length = 0;
    await telegramAdapter.login(ctx());
    expect(fake.startAnswers.some((answer) => answer.includes('input:'))).toBe(false);
  });

  it('runs mtcute without an update loop and with a storage that cannot persist peers', async () => {
    await telegramAdapter.login(ctx());
    const options = fake.instances[0]?.options as { disableUpdates?: boolean; storage?: { peers: { store: (peer: unknown) => unknown } } };
    expect(options.disableUpdates).toBe(true);
    expect(options.storage?.peers.store({})).toBeUndefined();
  });

  it('destroys the client when login fails', async () => {
    fake.startError = new Error('PHONE_CODE_INVALID');
    await expect(telegramAdapter.login(ctx())).rejects.toThrow('PHONE_CODE_INVALID');
    expect(fake.instances[0]?.destroyed).toBe(true);
  });

  describe('after a successful login', () => {
    it('shows who was linked: the name and the masked number, never the full number or anything from the session', async () => {
      fake.startUser = { displayName: 'An \u001b[31mNguyen', phoneNumber: '84901234567' };
      await telegramAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });
      const text = logs.join('\n');
      expect(text).toMatch(/Telegram account linked: An\s+Nguyen \(\+8490\*\*\*\*567\)\./);
      expect(text).not.toContain('84901234567');
      expect(text).not.toContain('\u001b');
      expect(text).not.toMatch(/session|auth_key|token=/i);
    });

    it('is translated and still prints nothing when Telegram told us nothing', async () => {
      fake.startUser = { displayName: 'Lan', phoneNumber: null };
      await telegramAdapter.login({ ...ctx(), lang: 'vi' });
      expect(logs.join('\n')).toContain('Đã liên kết tài khoản Telegram: Lan.');
      logs.length = 0;
      fake.startUser = undefined;
      await telegramAdapter.login(ctx());
      expect(logs.join('\n')).not.toContain('linked');
    });
  });

  describe('refusals from Telegram are explained in plain words', () => {
    const refuse = async (error: Error, lang?: AdapterContext['lang']) => {
      fake.startError = error;
      const failure = await telegramAdapter.login({ ...ctx(), ...(lang === undefined ? {} : { lang }) }).catch((caught: Error) => caught);
      expect(fake.instances.at(-1)?.destroyed).toBe(true);
      return failure as Error;
    };

    it('FLOOD_WAIT says how long to wait', async () => {
      const error = tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' });
      const failure = await refuse(error);
      expect(failure.message).toBe('Telegram asks you to wait 45 s before trying again (too many attempts). Nothing is wrong with your account; try again later.');
      expect(failure.cause).toBe(error);
      const long = await refuse(tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_7500' }));
      expect(long.message).toContain('wait 2 h 05 min');
    });

    it.each([
      ['PHONE_MIGRATE_4', 303, 'moving this number to another server'],
      ['SESSION_PASSWORD_NEEDED', 401, 'two-step password'],
      ['PHONE_NUMBER_INVALID', 400, 'international format'],
      ['PHONE_CODE_INVALID', 400, 'login code is wrong'],
      ['PHONE_CODE_EXPIRED', 400, 'code expired'],
      ['PASSWORD_HASH_INVALID', 400, 'two-step password is wrong'],
      ['API_ID_INVALID', 400, 'rejected the api_id / api_hash'],
      ['PHONE_NUMBER_BANNED', 400, 'does not let this phone number log in'],
      ['PHONE_NUMBER_FLOOD', 400, 'blocked further login attempts'],
      ['SOMETHING_NEW', 400, 'refused the request (SOMETHING_NEW)'],
    ])('%s', async (text, code, wanted) => {
      const error = new tl.RpcError(code, text);
      const failure = await refuse(error);
      expect(failure.message).toContain(wanted);
      expect(failure.cause).toBe(error);
      // Plain words, not a stack of codes: the raw code is only quoted where it helps (unknown ones, the few named in the text).
      expect(failure.message.length).toBeLessThan(260);
    });

    it('speaks the language of the login', async () => {
      const failure = await refuse(tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_30' }), 'vi');
      expect(failure.message).toBe('Telegram yêu cầu bạn đợi 30 s trước khi thử lại (quá nhiều lần thử). Tài khoản của bạn không có vấn đề gì; hãy thử lại sau.');
    });

    it('leaves errors that are not Telegram refusals alone', async () => {
      const error = new Error('getaddrinfo ENOTFOUND');
      expect(await refuse(error)).toBe(error);
    });
  });
});

describe('telegram open()', () => {
  it('maps a dead session to AccountBanned with a login hint and destroys the client', async () => {
    fake.getMe = async () => {
      throw new tl.RpcError(401, 'AUTH_KEY_UNREGISTERED');
    };
    const error = await telegramAdapter.open(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect((error as Error).message).toContain('login telegram --account tg1');
    expect(fake.instances[0]?.destroyed).toBe(true);
  });

  it('passes unrelated connection errors through unchanged', async () => {
    fake.getMe = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(telegramAdapter.open(ctx())).rejects.toThrow('ECONNRESET');
  });
});

describe('telegram check()', () => {
  it('reports yes/not_found per number and deletes only the imported contacts it found', async () => {
    fake.onCall = importAnswer([A.e164]);
    const session = await telegramAdapter.open(ctx());
    const result = await session.check([A, B]);
    expect(result).toEqual(
      new Map([
        [A.e164, 'yes'],
        [B.e164, 'not_found'],
      ]),
    );
    const calls = fake.instances[0]!.calls;
    expect(calls.map((c) => c.method)).toEqual(['contacts.importContacts', 'contacts.deleteByPhones']);
    expect(calls[1]?.params.phones).toEqual([A.e164]);
    // The temporary contact carries no real name, only a placeholder.
    const imported = calls[0]?.params.contacts as Array<{ firstName: string; lastName: string }>;
    expect(imported.every((c) => /^chk\d+$/.test(c.firstName) && c.lastName === '')).toBe(true);
  });

  it('ignores malformed numbers and duplicates, and skips the call when nothing is left', async () => {
    fake.onCall = importAnswer([]);
    const session = await telegramAdapter.open(ctx());
    expect(await session.check([{ e164: 'abc', country: '' }])).toEqual(new Map());
    expect(fake.instances[0]!.calls).toEqual([]);
    await session.check([A, A]);
    const contacts = fake.instances[0]!.calls[0]?.params.contacts as unknown[];
    expect(contacts).toHaveLength(1);
  });

  it('turns retry_contacts into RateLimited keeping the answered numbers', async () => {
    fake.onCall = importAnswer([A.e164], [C.e164]);
    const session = await telegramAdapter.open(ctx());
    const error = await session.check([A, B, C]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    const partial = (error as RateLimited).partial;
    expect(partial.get(A.e164)).toBe('yes');
    expect(partial.get(B.e164)).toBe('not_found');
    expect(partial.get(C.e164)).toBe('unknown');
  });

  it('turns FLOOD_WAIT into RateLimited with the server-provided wait', async () => {
    fake.onCall = (method) => {
      if (method === 'contacts.importContacts') throw tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' });
      return true;
    };
    const session = await telegramAdapter.open(ctx());
    const error = await session.check([A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(45_000);
  });

  it('treats PEER_FLOOD as an account problem', async () => {
    fake.onCall = (method) => {
      if (method === 'contacts.importContacts') throw new tl.RpcError(400, 'PEER_FLOOD');
      return true;
    };
    const session = await telegramAdapter.open(ctx());
    await expect(session.check([A])).rejects.toBeInstanceOf(AccountBanned);
  });

  it('treats other flood-class errors as RateLimited without a wait hint', async () => {
    fake.onCall = (method) => {
      if (method === 'contacts.importContacts') throw new tl.RpcError(420, 'SOMETHING_FLOOD');
      return true;
    };
    const session = await telegramAdapter.open(ctx());
    const error = await session.check([A]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBeUndefined();
  });

  it('lets unknown errors through and still tries to remove contacts that may have been imported', async () => {
    fake.onCall = (method) => {
      if (method === 'contacts.importContacts') throw new Error('socket closed');
      return true;
    };
    const session = await telegramAdapter.open(ctx());
    await expect(session.check([A])).rejects.toThrow('socket closed');
    expect(fake.instances[0]!.calls.map((c) => c.method)).toEqual(['contacts.importContacts', 'contacts.deleteByPhones']);
  });

  it('keeps results when deleting contacts fails and logs only masked numbers', async () => {
    fake.onCall = (method, params) => {
      if (method === 'contacts.deleteByPhones') throw new Error('network down');
      return importAnswer([A.e164])(method, params);
    };
    const session = await telegramAdapter.open(ctx());
    expect((await session.check([A])).get(A.e164)).toBe('yes');
    const log = logs.join('\n');
    expect(log).toContain('could not delete 1 imported contact');
    expect(log).not.toContain(A.e164);
  });

  it('uses fresh client ids across batches', async () => {
    fake.onCall = importAnswer([]);
    const session = await telegramAdapter.open(ctx());
    await session.check([A]);
    await session.check([B]);
    const ids = fake.instances[0]!.calls.flatMap((c) =>
      c.method === 'contacts.importContacts'
        ? (c.params.contacts as Array<{ clientId: ClientId }>).map((x) => x.clientId.toString())
        : [],
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('close() is idempotent', async () => {
    const session = await telegramAdapter.open(ctx());
    await session.close();
    await session.close();
    expect(fake.instances[0]?.destroyed).toBe(true);
  });
});

describe('telegram sessions from earlier versions', () => {
  it('purges cached customer profiles from session.sqlite before the client opens it', async () => {
    const file = join(dir, 'session.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE peers (id INTEGER PRIMARY KEY, hash TEXT, usernames TEXT, updated INTEGER, phone TEXT, complete BLOB)');
    db.prepare('INSERT INTO peers VALUES (1, ?, ?, 0, ?, ?)').run('h', '[]', '84901234567', Buffer.from('CustomerFirstName'));
    db.close();

    const session = await telegramAdapter.open(ctx());
    await session.close();

    const after = new DatabaseSync(file, { readOnly: true });
    try {
      expect(after.prepare('SELECT COUNT(*) AS n FROM peers').get()).toEqual({ n: 0 });
    } finally {
      after.close();
    }
    expect(logs.join('\n')).toContain('removed 1 cached peer profile');
  });
});
