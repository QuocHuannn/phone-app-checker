import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressHash, matrixAdapter, normalizeServerUrl } from '../src/adapters/matrix.ts';
import type { Lang } from '../src/i18n/index.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

// Test doubles for the two prompts only; the adapter, its HTTP mapping and its file writes are real.
const prompts = vi.hoisted(() => ({
  visible: [] as string[],
  hidden: [] as string[],
  asked: [] as string[],
}));

vi.mock('../src/prompt.ts', () => ({
  askVisible: async (question: string) => {
    prompts.asked.push(question);
    return prompts.visible.shift() ?? '';
  },
  askHidden: async (question: string) => {
    prompts.asked.push(question);
    return prompts.hidden.shift() ?? '';
  },
}));

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+41791234567', country: 'CH' };
const C: PhoneNumber = { e164: '+6591234567', country: 'SG' };

const HOME = 'https://matrix.example';
const IDENTITY = 'https://id.example';
const IDENTITY_TOKEN = 'identity-token-xyz';
const HOMESERVER_TOKEN = 'syt_homeserver_access_token';
const OPENID_TOKEN = 'openid-token-abc';
const PEPPER = 'pepper-one';
const PASSWORD = 'correct horse battery staple';
const USER_ID = '@alice:matrix.example';
const MATRIX_ID = '@bob:matrix.example';

const LOGIN = `POST ${HOME}/_matrix/client/v3/login`;
const OPENID = `POST ${HOME}/_matrix/client/v3/user/${encodeURIComponent(USER_ID)}/openid/request_token`;
const LOGOUT = `POST ${HOME}/_matrix/client/v3/logout`;
const REGISTER = `POST ${IDENTITY}/_matrix/identity/v2/account/register`;
const HASH_DETAILS = `GET ${IDENTITY}/_matrix/identity/v2/hash_details`;
const LOOKUP = `POST ${IDENTITY}/_matrix/identity/v2/lookup`;
const TERMS_GET = `GET ${IDENTITY}/_matrix/identity/v2/terms`;
const TERMS_POST = `POST ${IDENTITY}/_matrix/identity/v2/terms`;

interface Recorded {
  key: string;
  headers: Headers;
  body: unknown;
}

let dir: string;
let logs: string[];
let calls: Recorded[];
/** Replies per "METHOD url" in order; the last one repeats. */
let routes: Map<string, Array<Response | Error>>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function route(key: string, ...replies: Array<Response | Error>): void {
  routes.set(key, replies);
}

const keysCalled = (): string[] => calls.map((call) => call.key);
const callsTo = (key: string): Recorded[] => calls.filter((call) => call.key === key);

function ctx(options: Record<string, unknown> = { homeserver: HOME, identityServer: IDENTITY }, lang?: Lang): AdapterContext {
  return {
    app: 'matrix',
    account: 'm1',
    accountDir: dir,
    pacing: { enabled: true, batchSize: 1, dailyCap: 100, minIntervalMs: 0, jitterMs: 0, rateLimitCooldownMs: 1000, errorCooldownMs: 1000 },
    options,
    log: (message) => logs.push(message),
    ...(lang === undefined ? {} : { lang }),
  };
}

function saveCredentials(value: unknown = { identityServer: IDENTITY, identityToken: IDENTITY_TOKEN, lookupPepper: PEPPER }): void {
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(value));
}

async function session() {
  saveCredentials();
  return matrixAdapter.open(ctx());
}

const hashOf = (n: PhoneNumber, pepper = PEPPER): string => addressHash(n.e164, pepper);
const lookupBody = (index = 0): { addresses: string[]; algorithm: string; pepper: string } =>
  callsTo(LOOKUP)[index]?.body as { addresses: string[]; algorithm: string; pepper: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrix-adapter-'));
  logs = [];
  calls = [];
  routes = new Map();
  prompts.visible.length = 0;
  prompts.hidden.length = 0;
  prompts.asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
      calls.push({
        key,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const queue = routes.get(key);
      if (queue === undefined) throw new Error(`unexpected fetch ${key}`);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error(`unexpected fetch ${key}`);
      if (next instanceof Error) throw next;
      return next.clone();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('addressHash', () => {
  it('matches the vector in the Matrix identity-service specification', () => {
    // https://spec.matrix.org/v1.19/identity-service-api/ : `18005552067` with pepper `matrixrocks`.
    expect(addressHash('18005552067', 'matrixrocks')).toBe('nlo35_T5fzSGZzJApqu8lgIudJvmOQtDaHtr-I4rU7I');
  });

  it('hashes the digits only: a leading "+" is not part of the msisdn', () => {
    expect(addressHash('+18005552067', 'matrixrocks')).toBe(addressHash('18005552067', 'matrixrocks'));
  });

  it('depends on the pepper, and is URL-safe unpadded base64', () => {
    expect(addressHash('+18005552067', 'other')).not.toBe(addressHash('+18005552067', 'matrixrocks'));
    expect(addressHash('+18005552067', 'matrixrocks')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('normalizeServerUrl', () => {
  it.each([
    ['matrix.org', 'https://matrix.org'],
    ['https://matrix.org/', 'https://matrix.org'],
    [' https://matrix.org ', 'https://matrix.org'],
    ['https://host.example:8448/base/', 'https://host.example:8448/base'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(['http://matrix.org', 'ftp://matrix.org', 'https://user:pw@matrix.org', 'https://matrix.org/?a=1', 'https://matrix.org/#x', '', 'https://'])(
    'refuses %j (tokens and passwords must only travel over plain https)',
    (input) => {
      expect(normalizeServerUrl(input)).toBeUndefined();
    },
  );
});

describe('matrix open()', () => {
  it('requires saved credentials and explains how to create them', async () => {
    await expect(matrixAdapter.open(ctx())).rejects.toThrow(/login matrix --account m1/);
  });

  it('rejects corrupt or incomplete credential files', async () => {
    writeFileSync(join(dir, 'credentials.json'), '{not json');
    await expect(matrixAdapter.open(ctx())).rejects.toThrow(/corrupt/);
    saveCredentials({ identityServer: IDENTITY, identityToken: IDENTITY_TOKEN });
    await expect(matrixAdapter.open(ctx())).rejects.toThrow(/missing a valid identityServer\/identityToken\/lookupPepper/);
    saveCredentials({ identityServer: 'http://id.example', identityToken: IDENTITY_TOKEN, lookupPepper: PEPPER });
    await expect(matrixAdapter.open(ctx())).rejects.toThrow(/missing a valid/);
    saveCredentials({ identityServer: IDENTITY, identityToken: '', lookupPepper: PEPPER });
    await expect(matrixAdapter.open(ctx())).rejects.toThrow(/missing a valid/);
  });

  it('makes no request until a check runs', async () => {
    await session();
    expect(calls).toEqual([]);
  });
});

describe('matrix check()', () => {
  it('sends one lookup for the whole batch with the token, the sha256 hashes and the pepper', async () => {
    route(LOOKUP, json(200, { mappings: {} }));
    await (await session()).check([A, B, C]);
    expect(keysCalled()).toEqual([LOOKUP]);
    const [call] = calls;
    expect(call?.headers.get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
    expect(lookupBody()).toEqual({
      addresses: [hashOf(A), hashOf(B), hashOf(C)],
      algorithm: 'sha256',
      pepper: PEPPER,
    });
    // Numbers never travel in clear text, only their hashes.
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('84901234567');
  });

  it('is yes for a hash present in mappings and not_found for one that is absent', async () => {
    route(LOOKUP, json(200, { mappings: { [hashOf(A)]: MATRIX_ID } }));
    const result = await (await session()).check([A, B]);
    expect(result.get(A.e164)).toBe('yes');
    expect(result.get(B.e164)).toBe('not_found');
  });

  it('is not_found for everyone when the server returns an empty mappings object', async () => {
    route(LOOKUP, json(200, { mappings: {} }));
    const result = await (await session()).check([A, B]);
    expect([...result.values()]).toEqual(['not_found', 'not_found']);
  });

  it('looks a repeated number up once', async () => {
    route(LOOKUP, json(200, { mappings: {} }));
    await (await session()).check([A, A]);
    expect(lookupBody().addresses).toEqual([hashOf(A)]);
  });

  it('leaves malformed numbers out (they become unknown) and skips the call when nothing is valid', async () => {
    route(LOOKUP, json(200, { mappings: {} }));
    const s = await session();
    const result = await s.check([{ e164: '+0123', country: '' }, { e164: 'not a number', country: '' }, A]);
    expect([...result.keys()]).toEqual([A.e164]);
    expect(lookupBody().addresses).toEqual([hashOf(A)]);
    calls.length = 0;
    expect((await s.check([{ e164: 'x', country: '' }])).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no mappings key', {}],
    ['mappings as an array', { mappings: [] }],
    ['mappings as a string', { mappings: 'yes' }],
  ])('refuses a 200 with %s instead of guessing', async (_name, body) => {
    route(LOOKUP, json(200, body));
    await expect((await session()).check([A])).rejects.toThrow(/mappings object/);
  });

  describe('M_INVALID_PEPPER', () => {
    it('refreshes hash_details once, re-hashes with the new pepper and retries', async () => {
      route(LOOKUP, json(400, { errcode: 'M_INVALID_PEPPER', error: 'rotated' }), json(200, { mappings: { [hashOf(A, 'pepper-two')]: MATRIX_ID } }));
      route(HASH_DETAILS, json(200, { algorithms: ['none', 'sha256'], lookup_pepper: 'pepper-two' }));
      const result = await (await session()).check([A, B]);
      expect(keysCalled()).toEqual([LOOKUP, HASH_DETAILS, LOOKUP]);
      expect(callsTo(HASH_DETAILS)[0]?.headers.get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
      expect(lookupBody(1)).toEqual({ addresses: [hashOf(A, 'pepper-two'), hashOf(B, 'pepper-two')], algorithm: 'sha256', pepper: 'pepper-two' });
      expect(result.get(A.e164)).toBe('yes');
      expect(result.get(B.e164)).toBe('not_found');
    });

    it('keeps the new pepper for the next batch of the same session', async () => {
      route(LOOKUP, json(400, { errcode: 'M_INVALID_PEPPER' }), json(200, { mappings: {} }));
      route(HASH_DETAILS, json(200, { algorithms: ['sha256'], lookup_pepper: 'pepper-two' }));
      const s = await session();
      await s.check([A]);
      await s.check([B]);
      expect(keysCalled()).toEqual([LOOKUP, HASH_DETAILS, LOOKUP, LOOKUP]);
      expect(lookupBody(2).pepper).toBe('pepper-two');
    });

    it('does not loop: a second M_INVALID_PEPPER is a plain error', async () => {
      route(LOOKUP, json(400, { errcode: 'M_INVALID_PEPPER' }));
      route(HASH_DETAILS, json(200, { algorithms: ['sha256'], lookup_pepper: 'pepper-two' }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RateLimited);
      expect(failure).not.toBeInstanceOf(AccountBanned);
      expect(keysCalled()).toEqual([LOOKUP, HASH_DETAILS, LOOKUP]);
    });

    it('fails clearly when the refreshed hash_details no longer offers sha256', async () => {
      route(LOOKUP, json(400, { errcode: 'M_INVALID_PEPPER' }));
      route(HASH_DETAILS, json(200, { algorithms: ['none'], lookup_pepper: 'pepper-two' }));
      await expect((await session()).check([A])).rejects.toThrow(/sha256/);
      expect(keysCalled()).toEqual([LOOKUP, HASH_DETAILS]);
    });

    it('maps a rejected refresh to the account state (a token the server no longer knows)', async () => {
      route(LOOKUP, json(400, { errcode: 'M_INVALID_PEPPER' }));
      route(HASH_DETAILS, json(401, { errcode: 'M_UNAUTHORIZED', error: 'unknown token' }));
      await expect((await session()).check([A])).rejects.toBeInstanceOf(AccountBanned);
    });
  });

  describe('failures', () => {
    it.each([
      ['M_UNAUTHORIZED', 401],
      ['M_UNKNOWN_TOKEN', 401],
    ])('treats HTTP 401 %s as an account that must log in again', async (errcode, status) => {
      route(LOOKUP, json(status, { errcode, error: 'no' }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AccountBanned);
      expect((failure as Error).message).toMatch(/login again/i);
    });

    it('treats M_TERMS_NOT_SIGNED (403) as an account that must log in again to accept new terms', async () => {
      route(LOOKUP, json(403, { errcode: 'M_TERMS_NOT_SIGNED', error: 'Please accept our updated terms of service' }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AccountBanned);
      expect((failure as Error).message).toMatch(/terms/i);
    });

    it('maps 429 to RateLimited using retry_after_ms from the body', async () => {
      route(LOOKUP, json(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'slow down', retry_after_ms: 90_000 }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RateLimited);
      expect((failure as RateLimited).retryAfterMs).toBe(90_000);
    });

    it('falls back to the Retry-After header (seconds) when the body has no retry_after_ms', async () => {
      route(LOOKUP, json(429, { errcode: 'M_LIMIT_EXCEEDED' }, { 'Retry-After': '120' }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect((failure as RateLimited).retryAfterMs).toBe(120_000);
    });

    it.each([[undefined], ['soon'], ['0'], ['-5'], ['Wed, 21 Oct 2026 07:28:00 GMT']])('leaves the wait to the scheduler when Retry-After is %j', async (header) => {
      route(LOOKUP, json(429, {}, header === undefined ? {} : { 'Retry-After': header }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RateLimited);
      expect((failure as RateLimited).retryAfterMs).toBeUndefined();
    });

    it('treats M_LIMIT_EXCEEDED as a rate limit even on a non-429 status', async () => {
      route(LOOKUP, json(400, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 5000 }));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RateLimited);
    });

    it.each([
      [400, { errcode: 'M_INVALID_PARAM' }],
      [404, { errcode: 'M_UNRECOGNIZED' }],
      [500, { errcode: 'M_UNKNOWN' }],
      [502, undefined],
    ])('throws a plain error for HTTP %i so the scheduler applies its error cooldown', async (status, body) => {
      route(LOOKUP, body === undefined ? new Response('<html>bad gateway</html>', { status }) : json(status, body));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RateLimited);
      expect(failure).not.toBeInstanceOf(AccountBanned);
      expect((failure as Error).message).toContain(String(status));
    });

    it('turns a network failure into a plain error that does not reveal the token', async () => {
      route(LOOKUP, new Error(`connect ECONNREFUSED ${IDENTITY} (Authorization: Bearer ${IDENTITY_TOKEN})`));
      const failure = await (await session()).check([A]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RateLimited);
      expect((failure as Error).message).not.toContain(IDENTITY_TOKEN);
      expect((failure as Error).cause).toBeUndefined();
    });
  });

  it('never logs the token, the pepper, a hash, a full number or a Matrix ID', async () => {
    route(LOOKUP, json(200, { mappings: { [hashOf(A)]: MATRIX_ID } }), json(500, { errcode: 'M_UNKNOWN' }));
    const s = await session();
    await s.check([A]);
    await s.check([B]).catch(() => undefined);
    const text = logs.join('\n');
    expect(text).not.toContain(IDENTITY_TOKEN);
    expect(text).not.toContain(PEPPER);
    expect(text).not.toContain(hashOf(B));
    expect(text).not.toContain('41791234567');
    expect(text).not.toContain(MATRIX_ID);
    expect(text).toContain('+4179');
  });

  it('closes without error', async () => {
    await expect((await session()).close()).resolves.toBeUndefined();
  });
});

describe('matrix login()', () => {
  const OPENID_BODY = { access_token: OPENID_TOKEN, expires_in: 3600, matrix_server_name: 'matrix.example', token_type: 'Bearer' };

  /** Happy path for every endpoint; individual tests override what they exercise. */
  function allGood(): void {
    route(LOGIN, json(200, { access_token: HOMESERVER_TOKEN, user_id: USER_ID, device_id: 'D1' }));
    route(OPENID, json(200, OPENID_BODY));
    route(REGISTER, json(200, { token: IDENTITY_TOKEN }));
    route(HASH_DETAILS, json(200, { algorithms: ['none', 'sha256'], lookup_pepper: PEPPER }));
    route(LOGOUT, json(200, {}));
  }

  /** Homeserver (Enter = configured default), username, then the password through the hidden prompt. */
  function answer(options: { homeserver?: string; user?: string; password?: string } = {}): void {
    prompts.visible.push(options.homeserver ?? '', options.user ?? 'alice');
    prompts.hidden.push(options.password ?? PASSWORD);
  }

  const credentialsFile = (): string => join(dir, 'credentials.json');

  it('walks login -> openid -> register -> hash_details, saves three fields mode 600, and logs the homeserver session out', async () => {
    allGood();
    answer();
    await matrixAdapter.login(ctx());

    expect(keysCalled()).toEqual([LOGIN, OPENID, REGISTER, HASH_DETAILS, LOGOUT]);
    expect(callsTo(LOGIN)[0]?.body).toMatchObject({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' }, password: PASSWORD });
    expect(callsTo(OPENID)[0]?.headers.get('authorization')).toBe(`Bearer ${HOMESERVER_TOKEN}`);
    // The identity server gets exactly what the homeserver issued, and never the homeserver access token.
    expect(callsTo(REGISTER)[0]?.body).toEqual(OPENID_BODY);
    expect(callsTo(REGISTER)[0]?.headers.get('authorization')).toBeNull();
    expect(callsTo(HASH_DETAILS)[0]?.headers.get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
    expect(callsTo(LOGOUT)[0]?.headers.get('authorization')).toBe(`Bearer ${HOMESERVER_TOKEN}`);

    const saved = readFileSync(credentialsFile(), 'utf8');
    expect(JSON.parse(saved)).toEqual({ identityServer: IDENTITY, identityToken: IDENTITY_TOKEN, lookupPepper: PEPPER });
    expect(saved).not.toContain(PASSWORD);
    expect(saved).not.toContain(HOMESERVER_TOKEN);
    expect(saved).not.toContain(OPENID_TOKEN);
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${credentialsFile()}.tmp`)).toBe(false);
    // What login saved is what a later run opens.
    await expect(matrixAdapter.open(ctx())).resolves.toBeDefined();
  });

  it('asks the password through the hidden prompt only, and never logs it', async () => {
    allGood();
    answer();
    await matrixAdapter.login(ctx());
    expect(prompts.hidden).toEqual([]);
    expect(prompts.asked).toHaveLength(3);
    expect(prompts.asked.join('\n')).not.toContain(PASSWORD);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('uses the typed homeserver instead of the configured one, and the configured identity server', async () => {
    const other = 'https://other.example';
    route(`POST ${other}/_matrix/client/v3/login`, json(200, { access_token: HOMESERVER_TOKEN, user_id: USER_ID }));
    route(`POST ${other}/_matrix/client/v3/user/${encodeURIComponent(USER_ID)}/openid/request_token`, json(200, OPENID_BODY));
    route(`POST ${other}/_matrix/client/v3/logout`, json(200, {}));
    route(REGISTER, json(200, { token: IDENTITY_TOKEN }));
    route(HASH_DETAILS, json(200, { algorithms: ['sha256'], lookup_pepper: PEPPER }));
    answer({ homeserver: 'other.example/' });
    await matrixAdapter.login(ctx());
    expect(keysCalled()[0]).toBe(`POST ${other}/_matrix/client/v3/login`);
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).identityServer).toBe(IDENTITY);
  });

  it('defaults to matrix.org and vector.im when nothing is configured or typed', async () => {
    route('POST https://matrix.org/_matrix/client/v3/login', json(200, { access_token: HOMESERVER_TOKEN, user_id: USER_ID }));
    route(`POST https://matrix.org/_matrix/client/v3/user/${encodeURIComponent(USER_ID)}/openid/request_token`, json(200, OPENID_BODY));
    route('POST https://matrix.org/_matrix/client/v3/logout', json(200, {}));
    route('POST https://vector.im/_matrix/identity/v2/account/register', json(200, { token: IDENTITY_TOKEN }));
    route('GET https://vector.im/_matrix/identity/v2/hash_details', json(200, { algorithms: ['sha256'], lookup_pepper: PEPPER }));
    answer();
    await matrixAdapter.login(ctx({}));
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).identityServer).toBe('https://vector.im');
  });

  describe('refusals before any request', () => {
    it('rejects an http:// address from the config without prompting', async () => {
      await expect(matrixAdapter.login(ctx({ homeserver: 'http://matrix.example' }))).rejects.toThrow(/apps\.matrix\.options\.homeserver must be an https/);
      await expect(matrixAdapter.login(ctx({ identityServer: 'http://id.example' }))).rejects.toThrow(/apps\.matrix\.options\.identityServer must be an https/);
      expect(prompts.asked).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('asks again for a homeserver that is not https and gives up after three', async () => {
      allGood();
      prompts.visible.push('http://matrix.example', 'ftp://x', '', 'alice');
      prompts.hidden.push(PASSWORD);
      await matrixAdapter.login(ctx());
      expect(logs).toHaveLength(2);
      expect(keysCalled()[0]).toBe(LOGIN);

      prompts.visible.push('http://a', 'http://b', 'http://c', 'alice');
      calls.length = 0;
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/https/);
      expect(calls).toEqual([]);
    });

    it.each([
      ['username', { user: '   ' }],
      ['password', { password: '' }],
    ])('refuses an empty %s without contacting any server', async (_what, given) => {
      answer(given);
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/nothing was saved/);
      expect(calls).toEqual([]);
      expect(existsSync(credentialsFile())).toBe(false);
    });
  });

  describe('homeserver login failures', () => {
    it('saves nothing on a bad password and has nothing to log out', async () => {
      route(LOGIN, json(403, { errcode: 'M_FORBIDDEN', error: 'Invalid username or password' }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/rejected the username or password.*nothing was saved/);
      expect(keysCalled()).toEqual([LOGIN]);
      expect(existsSync(credentialsFile())).toBe(false);
    });

    it('says to wait when the homeserver throttles logins (429)', async () => {
      route(LOGIN, json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1000 }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/throttling.*nothing was saved/i);
      expect(existsSync(credentialsFile())).toBe(false);
    });

    it('rejects a 200 that lacks the access token or user id', async () => {
      route(LOGIN, json(200, { user_id: USER_ID }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/nothing was saved/);
      expect(keysCalled()).toEqual([LOGIN]);
    });

    it('hides the password when the network fails during login', async () => {
      route(LOGIN, new Error(`socket hang up while sending {"password":"${PASSWORD}"}`));
      answer();
      const failure = await matrixAdapter.login(ctx()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).not.toContain(PASSWORD);
      expect(existsSync(credentialsFile())).toBe(false);
    });
  });

  describe('failures after the homeserver session exists', () => {
    it('saves nothing but still logs the homeserver session out when the OpenID token is refused', async () => {
      allGood();
      route(OPENID, json(403, { errcode: 'M_FORBIDDEN' }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/OpenID token.*nothing was saved/);
      expect(keysCalled()).toEqual([LOGIN, OPENID, LOGOUT]);
      expect(existsSync(credentialsFile())).toBe(false);
    });

    it('saves nothing but still logs out when the identity server will not register the token', async () => {
      allGood();
      route(REGISTER, json(401, { errcode: 'M_UNKNOWN' }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/did not accept the OpenID token.*nothing was saved/);
      expect(keysCalled()).toEqual([LOGIN, OPENID, REGISTER, LOGOUT]);
      expect(existsSync(credentialsFile())).toBe(false);
    });

    it('saves nothing when hash_details does not offer sha256 with a pepper', async () => {
      allGood();
      route(HASH_DETAILS, json(200, { algorithms: ['none'], lookup_pepper: PEPPER }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/sha256/);
      expect(existsSync(credentialsFile())).toBe(false);
      expect(keysCalled().at(-1)).toBe(LOGOUT);
    });

    it('keeps an earlier working credentials file when a new login fails', async () => {
      saveCredentials();
      allGood();
      route(REGISTER, json(401, {}));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/nothing was saved/);
      expect(JSON.parse(readFileSync(credentialsFile(), 'utf8'))).toEqual({ identityServer: IDENTITY, identityToken: IDENTITY_TOKEN, lookupPepper: PEPPER });
    });

    it('still succeeds when the logout of the homeserver session fails', async () => {
      allGood();
      route(LOGOUT, new Error('network down'));
      answer();
      await matrixAdapter.login(ctx());
      expect(existsSync(credentialsFile())).toBe(true);
    });
  });

  describe('terms of service', () => {
    const TERMS = {
      policies: {
        terms_of_service: {
          version: '2.0',
          en: { name: 'Terms of Service', url: `${IDENTITY}/tos-2.0-en.html` },
          fr: { name: 'Conditions', url: `${IDENTITY}/tos-2.0-fr.html` },
        },
        privacy_policy: {
          version: '1.2',
          fr: { name: 'Politique', url: `${IDENTITY}/privacy-1.2-fr.html` },
        },
      },
    };

    function termsRequired(): void {
      allGood();
      route(HASH_DETAILS, json(403, { errcode: 'M_TERMS_NOT_SIGNED', error: 'accept the terms' }), json(200, { algorithms: ['sha256'], lookup_pepper: PEPPER }));
      route(TERMS_GET, json(200, TERMS));
      route(TERMS_POST, json(200, {}));
    }

    it('shows the terms, takes a yes, posts one URL per policy, then asks hash_details again', async () => {
      termsRequired();
      answer();
      prompts.visible.push('y');
      await matrixAdapter.login(ctx());

      expect(keysCalled()).toEqual([LOGIN, OPENID, REGISTER, HASH_DETAILS, TERMS_GET, TERMS_POST, HASH_DETAILS, LOGOUT]);
      // English where offered, the only available language otherwise.
      expect(callsTo(TERMS_POST)[0]?.body).toEqual({ user_accepts: [`${IDENTITY}/tos-2.0-en.html`, `${IDENTITY}/privacy-1.2-fr.html`] });
      expect(callsTo(TERMS_POST)[0]?.headers.get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
      const shown = logs.join('\n');
      expect(shown).toContain(`${IDENTITY}/tos-2.0-en.html`);
      expect(shown).toContain(`${IDENTITY}/privacy-1.2-fr.html`);
      expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).lookupPepper).toBe(PEPPER);
    });

    it('accepts the answer in the person\'s language', async () => {
      termsRequired();
      answer();
      prompts.visible.push('Có');
      await matrixAdapter.login(ctx(undefined, 'vi'));
      expect(callsTo(TERMS_POST)).toHaveLength(1);
    });

    it.each(['n', 'no', '', 'maybe'])('saves nothing and agrees to nothing when the answer is %j', async (reply) => {
      termsRequired();
      answer();
      prompts.visible.push(reply);
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/not accepted/);
      expect(callsTo(TERMS_POST)).toEqual([]);
      expect(existsSync(credentialsFile())).toBe(false);
      expect(keysCalled().at(-1)).toBe(LOGOUT);
    });

    it('fails clearly when the server demands terms but lists none', async () => {
      termsRequired();
      route(TERMS_GET, json(200, { policies: {} }));
      answer();
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/did not list any.*nothing was saved/);
      expect(callsTo(TERMS_POST)).toEqual([]);
    });

    it('does not loop when hash_details still wants terms after the agreement', async () => {
      termsRequired();
      route(HASH_DETAILS, json(403, { errcode: 'M_TERMS_NOT_SIGNED' }));
      answer();
      prompts.visible.push('y');
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/refused hash_details.*nothing was saved/);
      expect(callsTo(TERMS_GET)).toHaveLength(1);
      expect(callsTo(TERMS_POST)).toHaveLength(1);
      expect(existsSync(credentialsFile())).toBe(false);
    });

    it('saves nothing when the server does not take the agreement', async () => {
      termsRequired();
      route(TERMS_POST, json(500, {}));
      answer();
      prompts.visible.push('y');
      await expect(matrixAdapter.login(ctx())).rejects.toThrow(/did not take the terms agreement.*nothing was saved/);
      expect(existsSync(credentialsFile())).toBe(false);
    });
  });
});
