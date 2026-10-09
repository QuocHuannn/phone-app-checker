import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneHash, threemaAdapter } from '../src/adapters/threema.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

// Test doubles for the two hidden/visible prompts only; the adapter, its HTTP mapping and its file writes are real.
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

const GATEWAY_ID = '*MYGATE1';
const SECRET = 'sup3r-secret-value';

let dir: string;
let logs: string[];
let requests: URL[];
/** Next response per request, consumed in order; the last one repeats. */
let replies: Array<Response | Error>;

function reply(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function ctx(): AdapterContext {
  return {
    app: 'threema',
    account: 't1',
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

function saveCredentials(value: unknown = { gatewayId: GATEWAY_ID, secret: SECRET }): void {
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(value));
}

async function session() {
  saveCredentials();
  return threemaAdapter.open(ctx());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'threema-adapter-'));
  logs = [];
  requests = [];
  replies = [];
  prompts.visible.length = 0;
  prompts.hidden.length = 0;
  prompts.asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      requests.push(new URL(String(input)));
      const next = replies.length > 1 ? replies.shift() : replies[0];
      if (next === undefined) throw new Error('unexpected fetch');
      if (next instanceof Error) throw next;
      return next.clone();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('phoneHash', () => {
  it('matches the vector published in the Threema Gateway documentation', () => {
    expect(phoneHash('+41791234567')).toBe('ad398f4d7ebe63c6550a486cc6e07f9baa09bd9d8b3d8cb9d9be106d35a7fdbc');
  });

  it('hashes the digits only: the leading "+" is not part of the input', () => {
    expect(phoneHash('41791234567')).toBe(phoneHash('+41791234567'));
  });
});

describe('threema open()', () => {
  it('requires saved credentials and explains how to create them', async () => {
    await expect(threemaAdapter.open(ctx())).rejects.toThrow(/login threema --account t1/);
  });

  it('rejects corrupt or incomplete credential files', async () => {
    writeFileSync(join(dir, 'credentials.json'), '{not json');
    await expect(threemaAdapter.open(ctx())).rejects.toThrow(/corrupt/);
    saveCredentials({ gatewayId: GATEWAY_ID });
    await expect(threemaAdapter.open(ctx())).rejects.toThrow(/missing a valid gatewayId\/secret/);
    saveCredentials({ gatewayId: 'not-an-id', secret: SECRET });
    await expect(threemaAdapter.open(ctx())).rejects.toThrow(/missing a valid gatewayId\/secret/);
  });

  it('makes no request until a check runs', async () => {
    await session();
    expect(requests).toEqual([]);
  });
});

describe('threema check()', () => {
  it('asks the documented lookup endpoint with the hash, the Gateway ID and the secret', async () => {
    replies = [reply(200, 'ABCD1234')];
    await (await session()).check([B]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.origin).toBe('https://msgapi.threema.ch');
    expect(request?.pathname).toBe(`/lookup/phone_hash/${phoneHash(B.e164)}`);
    expect(request?.searchParams.get('from')).toBe(GATEWAY_ID);
    expect(request?.searchParams.get('secret')).toBe(SECRET);
    // The phone number itself never travels in the URL, only its hash.
    expect(request?.href).not.toContain('41791234567');
  });

  it.each(['ABCD1234', '*ABCD1234', 'ABCD1234\n'])('is yes for a 200 whose body is a Threema ID (%j)', async (body) => {
    replies = [reply(200, body)];
    expect((await (await session()).check([A])).get(A.e164)).toBe('yes');
  });

  it('is not_found for 404', async () => {
    replies = [reply(404)];
    expect((await (await session()).check([A])).get(A.e164)).toBe('not_found');
  });

  it('checks one request per number and returns each answer', async () => {
    replies = [reply(200, 'ABCD1234'), reply(404)];
    const result = await (await session()).check([A, B]);
    expect(result.get(A.e164)).toBe('yes');
    expect(result.get(B.e164)).toBe('not_found');
    expect(requests).toHaveLength(2);
  });

  it.each(['', 'short', 'ABCD12345', 'abcd1234', '<html>error</html>'])('refuses a 200 whose body is not a Threema ID (%j)', async (body) => {
    replies = [reply(200, body)];
    await expect((await session()).check([A])).rejects.toThrow(/not a Threema ID/);
  });

  it('keeps answers obtained before a 401 and bans the account', async () => {
    replies = [reply(200, 'ABCD1234'), reply(401)];
    const failure = await (await session()).check([A, B]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountBanned);
    expect((failure as AccountBanned).partial.get(A.e164)).toBe('yes');
    expect((failure as AccountBanned).partial.has(B.e164)).toBe(false);
  });

  it('treats 402 (no credits) as an account that cannot continue, with a message that says why', async () => {
    replies = [reply(402)];
    const failure = await (await session()).check([A]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountBanned);
    expect((failure as Error).message).toMatch(/no credits/i);
  });

  it('maps 429 to RateLimited with Retry-After seconds converted to milliseconds, keeping partial answers', async () => {
    replies = [reply(404), reply(429, '', { 'Retry-After': '120' })];
    const failure = await (await session()).check([A, B]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect((failure as RateLimited).retryAfterMs).toBe(120_000);
    expect((failure as RateLimited).partial.get(A.e164)).toBe('not_found');
  });

  it.each([[undefined], ['soon'], ['0'], ['-5'], ['Wed, 21 Oct 2026 07:28:00 GMT']])('leaves the wait to the scheduler when Retry-After is %j', async (header) => {
    replies = [reply(429, '', header === undefined ? {} : { 'Retry-After': header })];
    const failure = await (await session()).check([A]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect((failure as RateLimited).retryAfterMs).toBeUndefined();
  });

  it.each([400, 500, 503])('throws a plain error for HTTP %i so the scheduler applies its error cooldown', async (status) => {
    replies = [reply(status)];
    const failure = await (await session()).check([A]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RateLimited);
    expect(failure).not.toBeInstanceOf(AccountBanned);
    expect((failure as Error).message).toContain(String(status));
  });

  it('leaves malformed numbers out of the answer (they become unknown) without calling the Gateway', async () => {
    replies = [reply(200, 'ABCD1234')];
    const result = await (await session()).check([{ e164: '+0123', country: '' }, { e164: 'not a number', country: '' }, A]);
    expect([...result.keys()]).toEqual([A.e164]);
    expect(requests).toHaveLength(1);
  });

  it('checks numbers of any country (the scope is not restricted)', async () => {
    replies = [reply(404)];
    expect((await (await session()).check([C])).get(C.e164)).toBe('not_found');
  });

  it('turns a network failure into a plain error that does not reveal the secret or the URL', async () => {
    replies = [new Error(`connect ECONNREFUSED https://msgapi.threema.ch/lookup/phone_hash/x?from=${GATEWAY_ID}&secret=${SECRET}`)];
    const failure = await (await session()).check([A]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RateLimited);
    expect(String((failure as Error).message)).not.toContain(SECRET);
    expect((failure as Error).cause).toBeUndefined();
  });

  it('never logs the secret, the request URL, a full number or the Threema ID', async () => {
    replies = [reply(200, 'ABCD1234'), reply(500)];
    await (await session()).check([A, B]).catch(() => undefined);
    const text = logs.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secret=');
    expect(text).not.toContain('msgapi.threema.ch');
    expect(text).not.toContain('41791234567');
    expect(text).not.toContain('ABCD1234');
    expect(text).toContain('+4179');
  });

  it('closes without error', async () => {
    await expect((await session()).close()).resolves.toBeUndefined();
  });
});

describe('threema login()', () => {
  function answer(id: string, secret: string): void {
    prompts.visible.push(id);
    prompts.hidden.push(secret);
  }

  it('verifies the pair with /credits, then saves it mode 600 and leaves no temporary file', async () => {
    replies = [reply(200, '42')];
    answer(GATEWAY_ID, SECRET);
    await threemaAdapter.login(ctx());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/credits');
    expect(requests[0]?.searchParams.get('from')).toBe(GATEWAY_ID);
    expect(requests[0]?.searchParams.get('secret')).toBe(SECRET);
    const file = join(dir, 'credentials.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ gatewayId: GATEWAY_ID, secret: SECRET });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // What login saved is what a later run opens.
    await expect(threemaAdapter.open(ctx())).resolves.toBeDefined();
  });

  it('accepts a lower-case Gateway ID and surrounding blanks, saving the canonical form', async () => {
    replies = [reply(200, '42')];
    answer('  *mygate1 ', `  ${SECRET}  `);
    await threemaAdapter.login(ctx());
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))).toEqual({ gatewayId: GATEWAY_ID, secret: SECRET });
  });

  it('asks the secret through the hidden prompt, never the visible one', async () => {
    replies = [reply(200, '42')];
    answer(GATEWAY_ID, SECRET);
    await threemaAdapter.login(ctx());
    expect(prompts.visible).toEqual([]);
    expect(prompts.hidden).toEqual([]);
    expect(prompts.asked).toHaveLength(2);
    expect(prompts.asked.join('\n')).not.toContain(SECRET);
  });

  it('saves nothing when the Gateway answers 401', async () => {
    replies = [reply(401)];
    answer(GATEWAY_ID, SECRET);
    await expect(threemaAdapter.login(ctx())).rejects.toThrow(/rejected the Gateway ID or secret.*nothing was saved/);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('keeps an earlier working credentials file when a new login fails', async () => {
    saveCredentials();
    replies = [reply(401)];
    answer('*OTHER99', 'wrong-secret');
    await expect(threemaAdapter.login(ctx())).rejects.toThrow(/nothing was saved/);
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))).toEqual({ gatewayId: GATEWAY_ID, secret: SECRET });
  });

  it.each([402, 500])('saves nothing and names the status when the Gateway answers %i', async (status) => {
    replies = [reply(status)];
    answer(GATEWAY_ID, SECRET);
    await expect(threemaAdapter.login(ctx())).rejects.toThrow(new RegExp(`HTTP ${status}.*nothing was saved`));
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('saves nothing and hides the secret when the network fails', async () => {
    replies = [new Error(`getaddrinfo ENOTFOUND msgapi.threema.ch?secret=${SECRET}`)];
    answer(GATEWAY_ID, SECRET);
    const failure = await threemaAdapter.login(ctx()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain(SECRET);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('asks again for a malformed Gateway ID without contacting the Gateway', async () => {
    replies = [reply(200, '42')];
    prompts.visible.push('MYGATE1', '*SHORT', GATEWAY_ID);
    prompts.hidden.push(SECRET);
    await threemaAdapter.login(ctx());
    expect(requests).toHaveLength(1);
    expect(logs).toHaveLength(2);
  });

  it('gives up after three malformed Gateway IDs and saves nothing', async () => {
    prompts.visible.push('a', 'b', 'c', GATEWAY_ID);
    await expect(threemaAdapter.login(ctx())).rejects.toThrow(/Gateway ID/);
    expect(requests).toEqual([]);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('refuses an empty secret without contacting the Gateway', async () => {
    answer(GATEWAY_ID, '   ');
    await expect(threemaAdapter.login(ctx())).rejects.toThrow(/nothing was saved/);
    expect(requests).toEqual([]);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });
});
