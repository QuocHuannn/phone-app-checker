import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason } from 'baileys';
import type * as Baileys from 'baileys';
import { whatsappAdapter } from '../src/adapters/whatsapp.ts';
import { QrScreen } from '../src/qr.ts';
import { AccountBanned, RateLimited, type AdapterContext, type PhoneNumber } from '../src/types.ts';

type Handler = (update: Record<string, unknown>) => void;

interface FakeSocket {
  handlers: Record<string, Handler[]>;
  wsHandlers: Record<string, ((node: unknown) => void)[]>;
  ended: boolean;
  authState: { creds: { account?: unknown; advSecretKey?: string } };
  config: Record<string, unknown>;
  emit(event: string, update: Record<string, unknown>): void;
  ws: { on(event: string, handler: (node: unknown) => void): void; emit(event: string, node: unknown): void };
}

// Test double for the Baileys socket only; DisconnectReason and the adapter are real.
const fake = vi.hoisted(() => ({
  sockets: [] as unknown[],
  creds: { account: { id: 'linked' } } as { account?: unknown; advSecretKey?: string },
  /** What a freshly created socket does once the adapter has attached its listeners. */
  script: undefined as undefined | ((sock: FakeSocket) => void),
  onWhatsApp: undefined as undefined | ((...ids: string[]) => Promise<unknown>),
  pairingCodes: [] as string[],
  saved: 0,
  acks: [] as unknown[],
  credUpdates: [] as unknown[],
  webVersion: { version: [2, 3000, 1] as [number, number, number], isLatest: false },
}));

vi.mock('baileys', async (importOriginal) => {
  const real = await importOriginal<typeof Baileys>();
  const makeWASocket = (config: Record<string, unknown>) => {
    const sock: FakeSocket & Record<string, unknown> = {
      handlers: {},
      ended: false,
      authState: { creds: fake.creds },
      config,
      emit(event, update) {
        for (const handler of sock.handlers[event] ?? []) handler(update);
      },
      ev: {
        on(event: string, handler: Handler) {
          (sock.handlers[event] ??= []).push(handler);
        },
        emit(event: string, update: Record<string, unknown>) {
          if (event === 'creds.update') fake.credUpdates.push(update);
        },
      },
      ws: {
        on(event: string, handler: (node: unknown) => void) {
          (sock.wsHandlers[event] ??= []).push(handler);
        },
        emit(event: string, node: unknown) {
          for (const handler of sock.wsHandlers[event] ?? []) handler(node);
        },
      },
      wsHandlers: {},
      sendNode: async (node: unknown) => {
        fake.acks.push(node);
      },
      onWhatsApp: (...ids: string[]) => fake.onWhatsApp?.(...ids),
      requestPairingCode: async (phone: string) => {
        fake.pairingCodes.push(phone);
        return 'ABCD1234';
      },
      end: async () => {
        sock.ended = true;
      },
    };
    fake.sockets.push(sock);
    setTimeout(() => fake.script?.(sock), 0);
    return sock;
  };
  return {
    ...real,
    default: makeWASocket,
    useMultiFileAuthState: async () => ({
      state: { creds: fake.creds },
      saveCreds: async () => {
        fake.saved += 1;
      },
    }),
    fetchLatestWaWebVersion: async () => fake.webVersion,
  };
});

const A: PhoneNumber = { e164: '+84901234567', country: 'VN' };
const B: PhoneNumber = { e164: '+84912345678', country: 'VN' };

let dir: string;
let logs: string[];
let options: Record<string, unknown>;

function ctx(): AdapterContext {
  return {
    app: 'whatsapp',
    account: 'wa1',
    accountDir: dir,
    pacing: {
      enabled: true,
      batchSize: 20,
      dailyCap: 300,
      minIntervalMs: 0,
      jitterMs: 0,
      rateLimitCooldownMs: 1000,
      errorCooldownMs: 1000,
    },
    options,
    log: (message) => logs.push(message),
  };
}

const lastSocket = () => fake.sockets[fake.sockets.length - 1] as FakeSocket;

function disconnect(statusCode: number): Record<string, unknown> {
  return { connection: 'close', lastDisconnect: { error: Object.assign(new Error('closed'), { output: { statusCode } }) } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-adapter-'));
  logs = [];
  options = {};
  fake.sockets.length = 0;
  fake.creds = { account: { id: 'linked' } };
  fake.script = (sock) => sock.emit('connection.update', { connection: 'open' });
  fake.onWhatsApp = undefined;
  fake.pairingCodes.length = 0;
  fake.saved = 0;
  fake.acks.length = 0;
  fake.credUpdates.length = 0;
  fake.webVersion = { version: [2, 3000, 1], isLatest: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('whatsapp options', () => {
  it('validates timeouts and the pairing phone', async () => {
    options = { connectTimeoutMs: 10 };
    await expect(whatsappAdapter.open(ctx())).rejects.toThrow(/connectTimeoutMs/);
    options = { pairingPhone: 'nope' };
    await expect(whatsappAdapter.login(ctx())).rejects.toThrow(/pairingPhone/);
  });
});

describe('whatsapp open()', () => {
  it('refuses an account that was never linked', async () => {
    fake.creds = {};
    await expect(whatsappAdapter.open(ctx())).rejects.toThrow(/not logged in.*login whatsapp/s);
    expect(fake.sockets).toHaveLength(0);
  });

  it('reports an empty or unlinked account directory as an actionable login state, not a retryable error', async () => {
    // e.g. the directory a failed re-pair left behind: nothing saved, nothing to reconnect with.
    fake.creds = {};
    expect(readdirSync(dir)).toEqual([]);
    const error = await whatsappAdapter.open(ctx()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AccountBanned);
    expect((error as AccountBanned).message).toContain('login whatsapp --account <name>');
    expect(fake.sockets).toHaveLength(0);
  });

  it('connects silently, without history sync or presence', async () => {
    const session = await whatsappAdapter.open(ctx());
    const config = (lastSocket() as FakeSocket).config;
    expect(config).toMatchObject({ markOnlineOnConnect: false, syncFullHistory: false });
    expect(config.logger).toMatchObject({ level: 'silent' });
    await session.close();
    expect(lastSocket().ended).toBe(true);
  });

  it('maps a logged-out connection to AccountBanned', async () => {
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.loggedOut));
    const error = await whatsappAdapter.open(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect(lastSocket().ended).toBe(true);
  });

  it('maps 403 and connection-replaced to AccountBanned', async () => {
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.forbidden));
    await expect(whatsappAdapter.open(ctx())).rejects.toBeInstanceOf(AccountBanned);
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.connectionReplaced));
    await expect(whatsappAdapter.open(ctx())).rejects.toBeInstanceOf(AccountBanned);
  });

  it('treats a connection timeout as a retryable plain error', async () => {
    options = { connectTimeoutMs: 5_000 };
    vi.useFakeTimers();
    try {
      fake.script = undefined;
      const pending = whatsappAdapter.open(ctx()).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_100);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AccountBanned);
      expect((error as Error).message).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('whatsapp check()', () => {
  async function session() {
    return whatsappAdapter.open(ctx());
  }

  it('queries bare digits and maps exists to yes / not_found', async () => {
    const queried: string[] = [];
    fake.onWhatsApp = async (...ids) => {
      queried.push(...ids);
      return [
        { jid: '84901234567@s.whatsapp.net', exists: true },
        { jid: '84912345678@s.whatsapp.net', exists: false },
      ];
    };
    const result = await (await session()).check([A, B]);
    expect(queried.sort()).toEqual(['84901234567', '84912345678']);
    expect(result).toEqual(
      new Map([
        [A.e164, 'yes'],
        [B.e164, 'not_found'],
      ]),
    );
  });

  it('accepts device-suffixed jids', async () => {
    fake.onWhatsApp = async () => [{ jid: '84901234567:12@s.whatsapp.net', exists: true }];
    expect((await (await session()).check([A])).get(A.e164)).toBe('yes');
  });

  it('treats numbers WhatsApp did not mention as not_found', async () => {
    fake.onWhatsApp = async () => [{ jid: '84901234567@s.whatsapp.net', exists: true }];
    const result = await (await session()).check([A, B]);
    expect(result.get(B.e164)).toBe('not_found');
  });

  it('does not claim absence when a positive answer cannot be matched (LID jid)', async () => {
    fake.onWhatsApp = async () => [{ jid: '1234567890@lid', exists: true }];
    const result = await (await session()).check([A, B]);
    expect(result.size).toBe(0);
  });

  it('keeps explicit answers even when some positives are unattributable', async () => {
    fake.onWhatsApp = async () => [
      { jid: '84901234567@s.whatsapp.net', exists: true },
      { jid: '1234567890@lid', exists: true },
    ];
    const result = await (await session()).check([A, B]);
    expect(result.get(A.e164)).toBe('yes');
    expect(result.has(B.e164)).toBe(false);
  });

  it('turns rate-overlimit into RateLimited', async () => {
    fake.onWhatsApp = async () => {
      throw Object.assign(new Error('rate-overlimit'), { output: { statusCode: 429 } });
    };
    await expect((await session()).check([A])).rejects.toBeInstanceOf(RateLimited);
  });

  it('turns an IQ 401/403 into AccountBanned', async () => {
    fake.onWhatsApp = async () => {
      throw Object.assign(new Error('not-authorized'), { output: { statusCode: 401 } });
    };
    await expect((await session()).check([A])).rejects.toBeInstanceOf(AccountBanned);
  });

  it('fails the batch when the connection drops mid-check', async () => {
    const s = await session();
    fake.onWhatsApp = () => new Promise(() => {});
    const pending = s.check([A]).catch((e: unknown) => e);
    await vi.waitFor(() => expect(fake.onWhatsApp).toBeDefined());
    lastSocket().emit('connection.update', disconnect(DisconnectReason.loggedOut));
    expect(await pending).toBeInstanceOf(AccountBanned);
  });

  it('wraps unknown errors with their code', async () => {
    fake.onWhatsApp = async () => {
      throw Object.assign(new Error('boom'), { output: { statusCode: 500 } });
    };
    const error = await (await session()).check([A]).catch((e: unknown) => e);
    expect((error as Error).message).toContain('(500)');
    expect(error).not.toBeInstanceOf(RateLimited);
    expect(error).not.toBeInstanceOf(AccountBanned);
  });

  it('answers an empty batch without a network call', async () => {
    expect(await (await session()).check([])).toEqual(new Map());
  });
});

describe('whatsapp login()', () => {
  it('renders no pairing code without pairingPhone and stops once the device is linked', async () => {
    fake.creds = {};
    fake.script = (sock) => {
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login(ctx());
    expect(fake.pairingCodes).toEqual([]);
    expect(logs.join('\n')).not.toMatch(/linked device is ready|credentials saved/);
    expect(lastSocket().ended).toBe(true);
  });

  it('requests a pairing code for the configured phone', async () => {
    fake.creds = {};
    options = { pairingPhone: '+84 90 123 4567' };
    fake.script = (sock) => {
      sock.emit('connection.update', { qr: 'qr-data' });
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login(ctx());
    await vi.waitFor(() => expect(fake.pairingCodes).toEqual(['84901234567']));
    expect(logs.join('\n')).toContain('ABCD-1234');
  });

  describe('QR and pairing-code choices', () => {
    const WA_QR = (n: number) => `2@${'ref'.repeat(20)}${n},${'pub'.repeat(14)}=,${'sec'.repeat(14)}=,${'id'.repeat(8)}==`;

    it('draws every QR WhatsApp rotates, announces the title once and marks each new code', async () => {
      fake.creds = {};
      fake.script = (sock) => {
        sock.emit('connection.update', { qr: WA_QR(1) });
        sock.emit('connection.update', { qr: WA_QR(2) });
        sock.emit('connection.update', { qr: WA_QR(3) });
        fake.creds.account = { id: 'linked' };
        sock.emit('connection.update', { connection: 'open' });
      };
      await whatsappAdapter.login(ctx());
      const text = logs.join('\n');
      expect(text.match(/Scan this QR code with the phone that owns the WhatsApp account\./g)).toHaveLength(1);
      expect(text).toContain('Linked devices > Link a device');
      expect(text).not.toContain('New QR code (#1)');
      expect(text).toContain('New QR code (#2)');
      expect(text).toContain('New QR code (#3)');
      expect(fake.pairingCodes).toEqual([]);
    });

    it('shows the instructions in the requested language', async () => {
      fake.creds = {};
      fake.script = (sock) => {
        sock.emit('connection.update', { qr: WA_QR(1) });
        fake.creds.account = { id: 'linked' };
        sock.emit('connection.update', { connection: 'open' });
      };
      await whatsappAdapter.login({ ...ctx(), lang: 'ko' });
      expect(logs.join('\n')).toContain('WhatsApp 계정을 가진 휴대폰으로 이 QR 코드를 스캔하세요.');
    });

    it('an explicit QR choice beats a configured pairingPhone', async () => {
      fake.creds = {};
      options = { pairingPhone: '+84901234567' };
      fake.script = (sock) => {
        sock.emit('connection.update', { qr: WA_QR(1) });
        fake.creds.account = { id: 'linked' };
        sock.emit('connection.update', { connection: 'open' });
      };
      await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });
      expect(fake.pairingCodes).toEqual([]);
      expect(logs.join('\n')).toContain('Scan this QR code');
    });

    it('the pairing-code choice needs no configuration: it uses the given phone and prints the 8-character code with the steps', async () => {
      fake.creds = {};
      fake.script = (sock) => {
        sock.emit('connection.update', { qr: WA_QR(1) });
        sock.emit('connection.update', { qr: WA_QR(2) });
        fake.creds.account = { id: 'linked' };
        sock.emit('connection.update', { connection: 'open' });
      };
      await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code', phone: '+84 901 234 567' } });
      await vi.waitFor(() => expect(fake.pairingCodes).toEqual(['84901234567']));
      const text = logs.join('\n');
      expect(text).toContain('Pairing code: ABCD-1234');
      expect(text).toContain('Link with phone number instead');
      expect(text).not.toContain('Scan this QR code');
    });

    it('the pairing-code choice rejects a bad phone, and a missing one when none is configured', async () => {
      fake.creds = {};
      await expect(whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code', phone: 'nope' } })).rejects.toThrow(/international format/);
      await expect(whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code' } })).rejects.toThrow(/--phone/);
      expect(fake.sockets).toHaveLength(0);
      options = { pairingPhone: '+84901234567' };
      fake.script = (sock) => {
        sock.emit('connection.update', { qr: WA_QR(1) });
        fake.creds.account = { id: 'linked' };
        sock.emit('connection.update', { connection: 'open' });
      };
      await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code' } });
      await vi.waitFor(() => expect(fake.pairingCodes).toEqual(['84901234567']));
    });
  });

  it('follows the server restart that completes pairing', async () => {
    fake.creds = {};
    let attempt = 0;
    fake.script = (sock) => {
      attempt += 1;
      if (attempt === 1) {
        sock.emit('connection.update', disconnect(DisconnectReason.restartRequired));
        return;
      }
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login(ctx());
    expect(fake.sockets).toHaveLength(2);
  });

  it('reports a rejected login with a pairing hint', async () => {
    fake.creds = {};
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.loggedOut));
    const error = await whatsappAdapter.login(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect((error as Error).message).toContain('pairingPhone');
  });

  it('fails when the connection opens without a linked account', async () => {
    fake.creds = {};
    await expect(whatsappAdapter.login(ctx())).rejects.toThrow(/not linked to an account/);
  });
});

describe('whatsapp QR login follows WhatsApp\'s request for a fresh code', () => {
  const REFRESH = 'CB:notification,type:companion_reg_refresh';
  const refreshNode = (child: string | null = 'companion_reg_refresh') => ({
    tag: 'notification',
    attrs: { from: 's.whatsapp.net', id: '77', type: 'companion_reg_refresh', t: '1' },
    content: child === null ? [] : [{ tag: child, attrs: {} }],
  });
  const LINK = (ref: string, adv = 'OLDSECRETOLDSECRETOLDSECRETOLDSECRETOLDS=') => `https://wa.me/settings/linked_devices#2@${ref},NOISEKEY=,IDENTKEY=,${adv},1`;
  const advOf = (qr: string) => qr.split('#')[1]?.split(',')[3];
  let shown: { qr: string; heading: string | undefined }[];

  beforeEach(() => {
    shown = [];
    vi.spyOn(QrScreen.prototype, 'show').mockImplementation((source, heading) => {
      shown.push({ qr: source as string, heading });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('answers the notification with a new secret, draws the same session\'s code again with it, and keeps it on every later rotation', async () => {
    fake.creds = {};
    fake.script = (sock) => {
      sock.emit('connection.update', { qr: LINK('ref1') });
      sock.ws.emit(REFRESH, refreshNode());
      // Baileys keeps building rotated codes with the secret it captured at the start.
      sock.emit('connection.update', { qr: LINK('ref2') });
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });

    expect(shown).toHaveLength(3);
    const fresh = advOf(shown[1]?.qr ?? '');
    expect(fresh).not.toBe(advOf(shown[0]?.qr ?? ''));
    expect(Buffer.from(fresh ?? '', 'base64')).toHaveLength(32);
    // Same session (same ref and keys), only the secret differs; the next rotation carries the new secret too.
    expect(shown[1]?.qr.replace(fresh ?? '', 'X')).toBe(shown[0]?.qr.replace(advOf(shown[0]?.qr ?? '') ?? '', 'X'));
    expect(shown[2]?.qr).toBe(LINK('ref2', fresh));
    expect(shown[1]?.heading).toContain('WhatsApp asked for a fresh code after your scan');
    // The secret the server will verify the pairing against is the one on screen, and is saved.
    expect(fake.creds.advSecretKey).toBe(fresh);
    expect(fake.credUpdates).toEqual([{ advSecretKey: fresh }]);
    // A device that is not linked yet has no account id, so Baileys cannot acknowledge for it: the adapter does.
    expect(fake.acks).toEqual([{ tag: 'ack', attrs: { id: '77', to: 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' } }]);
  });

  it('accepts the pair-device-rotate-qr form, ignores a notification with neither child, and one that arrives before any code', async () => {
    fake.creds = {};
    fake.script = (sock) => {
      sock.ws.emit(REFRESH, refreshNode());
      sock.emit('connection.update', { qr: LINK('ref1') });
      sock.ws.emit(REFRESH, refreshNode('something-else'));
      sock.ws.emit(REFRESH, refreshNode(null));
      sock.ws.emit(REFRESH, refreshNode('pair-device-rotate-qr'));
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });
    // before the first code: acknowledged, nothing to redraw; the two invalid shapes: no ack, no change; the rotate form: redrawn.
    expect(fake.acks).toHaveLength(2);
    expect(shown).toHaveLength(2);
    expect(fake.credUpdates).toHaveLength(1);
  });

  it('does nothing in the pairing-code login, whose session must keep its secret', async () => {
    fake.creds = {};
    fake.script = (sock) => {
      sock.emit('connection.update', { qr: LINK('ref1') });
      sock.ws.emit(REFRESH, refreshNode());
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code', phone: '+84901234567' } });
    expect(fake.acks).toEqual([]);
    expect(fake.credUpdates).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('draws only what the QR screen is given, newest last: a rotation replaces, it never adds a second code', async () => {
    fake.creds = {};
    fake.script = (sock) => {
      for (const ref of ['a', 'b', 'c']) sock.emit('connection.update', { qr: LINK(ref) });
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });
    expect(shown.map((s) => s.heading)).toEqual([
      expect.stringContaining('about 60 seconds'),
      expect.stringContaining('New QR code (#2)'),
      expect.stringContaining('New QR code (#3)'),
    ]);
    expect(shown[1]?.heading).toContain('about 20 seconds');
  });
});

describe('whatsapp QR login when the connection breaks before the scan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The waits between new connections (1 s, 2 s, 3 s) run at once; every other timer is untouched. */
  function skipBackoff(): void {
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      real(fn, ms === 1_000 || ms === 2_000 || ms === 3_000 ? 0 : ms)) as typeof setTimeout);
  }

  it('starts over on a new connection and says so', async () => {
    skipBackoff();
    fake.creds = {};
    let attempt = 0;
    fake.script = (sock) => {
      attempt += 1;
      if (attempt === 1) {
        sock.emit('connection.update', disconnect(DisconnectReason.connectionClosed));
        return;
      }
      fake.creds.account = { id: 'linked' };
      sock.emit('connection.update', { connection: 'open' });
    };
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } });
    expect(fake.sockets).toHaveLength(2);
    expect(logs.join('\n')).toContain('The connection to WhatsApp dropped before the code was scanned. Trying again (1/3).');
    expect(logs.join('\n')).not.toContain('QR code not working?');
  });

  it('gives up after three new connections, with the pairing-code hint, and reports the real error', async () => {
    skipBackoff();
    fake.creds = {};
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.connectionClosed));
    const login = whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } }).catch((e: unknown) => e);
    const error = await login;
    expect(fake.sockets).toHaveLength(4);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('428');
    const text = logs.join('\n');
    expect(text).toContain('(3/3)');
    expect(text).toContain('QR code not working? Use the pairing code instead');
  });

  it('does not retry a refusal (401), and the pairing code login never prints the QR hint', async () => {
    fake.creds = {};
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.loggedOut));
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'qr' } }).catch(() => {});
    expect(fake.sockets).toHaveLength(1);

    logs.length = 0;
    fake.sockets.length = 0;
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.connectionClosed));
    await whatsappAdapter.login({ ...ctx(), loginChoice: { method: 'code', phone: '+84901234567' } }).catch(() => {});
    expect(fake.sockets).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('QR code not working?');
  });
});

describe('whatsapp WhatsApp Web version', () => {
  const BUNDLED = 1_043_857_760;

  async function versionUsed(lookup: { version: [number, number, number]; isLatest: boolean }): Promise<unknown> {
    vi.resetModules();
    fake.webVersion = lookup;
    // The version lookup is memoised for the life of the module, so each case needs a fresh copy of the adapter.
    const { whatsappAdapter: fresh } = await import('../src/adapters/whatsapp.ts');
    await fresh.open(ctx());
    return lastSocket().config.version;
  }

  it('uses the version WhatsApp Web is serving when it is newer than the bundled one', async () => {
    expect(await versionUsed({ version: [2, 3000, BUNDLED + 5_000_000], isLatest: true })).toEqual([2, 3000, BUNDLED + 5_000_000]);
  });

  it('keeps the bundled version when the lookup is not confident or reports something older', async () => {
    expect(await versionUsed({ version: [2, 3000, BUNDLED + 5_000_000], isLatest: false })).toBeUndefined();
    expect(await versionUsed({ version: [2, 3000, BUNDLED - 1], isLatest: true })).toBeUndefined();
  });
});

describe('whatsapp login() after the device was revoked', () => {
  const staleFile = () => join(dir, 'creds.json');

  it('clears the revoked credentials and pairs again instead of failing forever', async () => {
    writeFileSync(staleFile(), '{"stale":true}');
    let attempt = 0;
    let filesDuringRetry: string[] = ['unset'];
    fake.script = (sock) => {
      attempt += 1;
      if (attempt === 1) {
        sock.emit('connection.update', disconnect(DisconnectReason.loggedOut));
        return;
      }
      filesDuringRetry = readdirSync(dir);
      sock.emit('connection.update', { qr: 'qr-data' });
      sock.emit('connection.update', { connection: 'open' });
    };

    await whatsappAdapter.login(ctx());

    expect(fake.sockets).toHaveLength(2);
    expect(filesDuringRetry).toEqual([]);
    expect(existsSync(staleFile())).toBe(false);
    const text = logs.join('\n');
    expect(text).toContain('rejected the saved credentials');
    expect(text).toContain('starting a new pairing');
    expect(text).toContain('Scan this QR code');
  });

  it('gives up with the pairing hint when the fresh pairing is rejected too', async () => {
    writeFileSync(staleFile(), '{"stale":true}');
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.loggedOut));
    const error = await whatsappAdapter.login(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect((error as Error).message).toContain('pairingPhone');
    expect(fake.sockets).toHaveLength(2);
  });

  it('keeps the credentials and says exactly what to do when another client replaced the session', async () => {
    writeFileSync(staleFile(), '{"keep":true}');
    fake.script = (sock) => sock.emit('connection.update', disconnect(DisconnectReason.connectionReplaced));
    const error = await whatsappAdapter.login(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBanned);
    expect((error as Error).message).toContain(dir);
    expect((error as Error).message).toContain('delete that directory');
    expect(existsSync(staleFile())).toBe(true);
    expect(fake.sockets).toHaveLength(1);
  });
});

describe('whatsapp credential file modes', () => {
  it('sets the auth files Baileys wrote with the default umask to 600 when the session closes', async () => {
    const file = join(dir, 'app-state-sync-key-1.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    chmodSync(file, 0o644);
    const session = await whatsappAdapter.open(ctx());
    await session.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
