import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { loginWithAuthToken, loginWithPassword, loginWithQR, type Client } from '@evex/linejs';
import { FileStorage } from '@evex/linejs/storage';
import { translator } from '../i18n/index.ts';
import { QrScreen } from '../qr.ts';
import {
  AccountBanned,
  RateLimited,
  type Adapter,
  type AdapterContext,
  type CheckStatus,
  type PhoneNumber,
  type Session,
  maskPhone,
} from '../types.ts';

const SETUP_DOC = 'docs/line-setup.md';
const MIN_NODE = { major: 22, minor: 18 };

/**
 * Devices that register as a *secondary* client, so logging in does not evict the
 * phone that owns the account. `DESKTOPWIN` is the default.
 */
const DEVICES = ['DESKTOPWIN', 'DESKTOPMAC', 'ANDROIDSECONDARY', 'IOSIPAD'] as const;
type LineDevice = (typeof DEVICES)[number];
const LOGIN_MODES = ['qr', 'password'] as const;
type LoginMode = (typeof LOGIN_MODES)[number];

/** Files inside accountDir. Both are written with mode 600. */
const STORAGE_FILE = 'line-storage.json'; // linejs KV: refresh token, E2EE keys, QR cert
const AUTH_FILE = 'line-auth.json'; // { authToken, device }

/**
 * TalkException codes (names as decoded by linejs) by outcome.
 * - not_found: documented "no such user" answer.
 * - rate_limited: search throttled or temporarily restricted; back off, the account is fine.
 * - auth: token revoked/expired, account banned or client rejected; needs a human.
 */
const CODE_CLASS: Record<string, ErrorClass | undefined> = {
  NOT_FOUND: 'not_found',
  EXCESSIVE_ACCESS: 'rate_limited',
  EXCEED_DAILY_QUOTA: 'rate_limited',
  ABUSE_BLOCK: 'rate_limited',
  FEATURE_RESTRICTED: 'rate_limited',
  SERVER_BUSY: 'rate_limited',
  SHOULD_RETRY: 'rate_limited',
  CONGESTION_CONTROL: 'rate_limited',
  AUTHENTICATION_FAILED: 'auth',
  NOT_AUTHENTICATED: 'auth',
  NOT_AUTHORIZED_DEVICE: 'auth',
  NOT_AUTHORIZED_SESSION: 'auth',
  NOT_AVAILABLE_SESSION: 'auth',
  MUST_REFRESH_V3_TOKEN: 'auth',
  ALREADY_EXPIRED: 'auth',
  BANNED: 'auth',
  DEACTIVATED_ACCOUNT_BOUND_TO_THIS_IDENTITY: 'auth',
  UNSUPPORTED_ACCOUNT_TYPE: 'auth',
  MUST_UPGRADE: 'auth',
  INCOMPATIBLE_APP_VERSION: 'auth',
  INCOMPATIBLE_APP_TYPE: 'auth',
};
/** linejs InternalError `type`s that mean there is no usable login. */
const TYPE_CLASS: Record<string, ErrorClass | undefined> = {
  NotAuthorized: 'auth',
  RefreshError: 'auth',
};

type ErrorClass = 'not_found' | 'rate_limited' | 'auth' | 'other';

interface SavedAuth {
  authToken: string;
  device: LineDevice;
}

function isLineDevice(value: unknown): value is LineDevice {
  return DEVICES.some((device) => device === value);
}

function isLoginMode(value: unknown): value is LoginMode {
  return LOGIN_MODES.some((mode) => mode === value);
}

function assertRuntime(): void {
  const node = process.versions.node;
  if ('Bun' in globalThis || 'Deno' in globalThis) {
    throw new Error(`LINE adapter requires Node.js >=${MIN_NODE.major}.${MIN_NODE.minor}. See ${SETUP_DOC}.`);
  }
  const [major = 0, minor = 0] = node.split('.').map(Number);
  if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
    throw new Error(
      `LINE adapter requires Node.js >=${MIN_NODE.major}.${MIN_NODE.minor} (running ${node}). See ${SETUP_DOC}.`,
    );
  }
}

function readStringOption(ctx: AdapterContext, key: string): string | undefined {
  const value = ctx.options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`apps.line.options.${key} must be a string. See ${SETUP_DOC}.`);
  }
  return value;
}

function readLoginMode(ctx: AdapterContext): LoginMode {
  const value = readStringOption(ctx, 'loginMode') ?? 'qr';
  if (!isLoginMode(value)) {
    throw new Error(
      `Unsupported LINE login mode "${value}". Set apps.line.options.loginMode to "qr" or "password". See ${SETUP_DOC}.`,
    );
  }
  return value;
}

function readDevice(ctx: AdapterContext): LineDevice {
  const value = readStringOption(ctx, 'device') ?? 'DESKTOPWIN';
  if (!isLineDevice(value)) {
    throw new Error(
      `Unsupported LINE device "${value}". Set apps.line.options.device to one of ${DEVICES.join(', ')}. See ${SETUP_DOC}.`,
    );
  }
  return value;
}

/** Create the file (mode 600) when missing, so linejs' own writes keep the mode. */
function ensurePrivateFile(path: string, initial: string): void {
  if (!existsSync(path)) writeFileSync(path, initial, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createStorage(accountDir: string): FileStorage {
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  const path = join(accountDir, STORAGE_FILE);
  ensurePrivateFile(path, '{}');
  return new FileStorage(path);
}

function saveAuth(accountDir: string, auth: SavedAuth): void {
  const path = join(accountDir, AUTH_FILE);
  writeFileSync(path, JSON.stringify(auth), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadAuth(ctx: AdapterContext): SavedAuth {
  const path = join(ctx.accountDir, AUTH_FILE);
  const hint = `Run \`login line --account ${ctx.account}\` first. See ${SETUP_DOC}.`;
  if (!existsSync(path)) throw new Error(`No saved LINE session for account "${ctx.account}". ${hint}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Saved LINE session for account "${ctx.account}" is unreadable. ${hint}`);
  }
  const authToken = field(parsed, 'authToken');
  const device = field(parsed, 'device');
  if (typeof authToken !== 'string' || authToken === '' || !isLineDevice(device)) {
    throw new Error(`Saved LINE session for account "${ctx.account}" is invalid. ${hint}`);
  }
  return { authToken, device };
}

/** Prompt on the terminal; `hidden` suppresses echo (passwords). */
async function prompt(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`LINE login needs an interactive terminal (stdin is not a TTY). See ${SETUP_DOC}.`);
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const pending = rl.question(question);
    muted = hidden;
    const answer = await pending;
    if (hidden) process.stdout.write('\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Strip long digit runs so a phone number can never leak through an error message. */
function scrub(text: string): string {
  return text.replace(/\+?\d{7,}/g, '***');
}

interface ErrorFacts {
  type: string | undefined;
  code: string | undefined;
  reason: string | undefined;
}

/** Read `source[key]` from an unknown value; undefined when it is not an object with that key. */
function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null && key in source
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Duck-typed read of linejs' InternalError: `type` plus `data`, the decoded TalkException
 * (`data.code`) or the whole response (`data.e.code`).
 */
function errorFacts(error: unknown): ErrorFacts {
  const data = field(error, 'data');
  const nested = field(data, 'e');
  return {
    type: text(field(error, 'type')) ?? text(field(error, 'name')),
    code: text(field(data, 'code')) ?? text(field(nested, 'code')),
    reason: text(field(data, 'reason')) ?? text(field(nested, 'reason')),
  };
}

function classify(facts: ErrorFacts): ErrorClass {
  const { type, code, reason } = facts;
  if (code !== undefined && Object.hasOwn(CODE_CLASS, code)) return CODE_CLASS[code] ?? 'other';
  if (type !== undefined && Object.hasOwn(TYPE_CLASS, type)) return TYPE_CLASS[type] ?? 'other';
  if (reason && /restrict|too many|excessive/i.test(reason)) return 'rate_limited';
  return 'other';
}

function describe(facts: ErrorFacts): string {
  const parts = [facts.code ?? facts.type ?? 'unknown error'];
  if (facts.reason) parts.push(scrub(facts.reason).slice(0, 120));
  return parts.join(': ');
}

/** Turn a linejs failure outside `check()` into AccountBanned when it is an auth failure. */
function rethrowSetupError(error: unknown, ctx: AdapterContext): never {
  const facts = errorFacts(error);
  if (classify(facts) === 'auth') {
    throw new AccountBanned(
      `LINE session for "${ctx.account}" is no longer valid (${describe(facts)}). ` +
        `Run \`login line --account ${ctx.account}\` again. See ${SETUP_DOC}.`,
    );
  }
  const detail = error instanceof Error ? scrub(error.message).slice(0, 200) : describe(facts);
  throw new Error(`LINE session open failed: ${detail}. See ${SETUP_DOC}.`, { cause: error });
}

function persistTokenUpdates(client: Client, ctx: AdapterContext, device: LineDevice): void {
  const save = (authToken: string) => {
    try {
      saveAuth(ctx.accountDir, { authToken, device });
    } catch (error) {
      ctx.log(`line: could not persist refreshed token: ${(error as Error).message}`);
    }
  };
  client.base.on('update:authtoken', save);
}

class LineSession implements Session {
  private readonly client: Client;
  private readonly ctx: AdapterContext;

  constructor(client: Client, ctx: AdapterContext) {
    this.client = client;
    this.ctx = ctx;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const results = new Map<string, CheckStatus>();
    for (const { e164 } of numbers) {
      try {
        // Read-only lookup: resolves a contact without adding a friend or sending anything.
        const contact = await this.client.base.relation.findContactByPhoneV3({ phone: e164 });
        // Only the presence of a mid matters; nothing from the contact is kept.
        results.set(e164, typeof contact?.mid === 'string' && contact.mid !== '' ? 'yes' : 'unknown');
      } catch (error) {
        const facts = errorFacts(error);
        switch (classify(facts)) {
          case 'not_found':
            results.set(e164, 'not_found');
            break;
          case 'rate_limited':
            throw new RateLimited(
              `LINE phone search throttled or restricted at ${maskPhone(e164)} (${describe(facts)})`,
              undefined,
              results,
            );
          case 'auth':
            throw new AccountBanned(
              `LINE account "${this.ctx.account}" is logged out, banned or rejected (${describe(facts)}). ` +
                `Run \`login line --account ${this.ctx.account}\` again. See ${SETUP_DOC}.`,
              results,
            );
          default:
            // Message is scrubbed: linejs error text can embed request details.
            throw new Error(`LINE lookup failed at ${maskPhone(e164)} (${describe(facts)})`, { cause: error });
        }
      }
    }
    return results;
  }

  async close(): Promise<void> {
    // check() never opens push/poll streams; close any connection linejs may have opened anyway.
    const conns = this.client.base.push.conns;
    await Promise.allSettled(conns.map((conn) => conn.close()));
  }
}

export const lineAdapter: Adapter = {
  app: 'line',

  async login(ctx) {
    assertRuntime();
    const mode = readLoginMode(ctx);
    const device = readDevice(ctx);
    const storage = createStorage(ctx.accountDir);
    const init = { device, storage };
    const say = translator(ctx.lang);
    const screen = new QrScreen({ lang: ctx.lang, write: ctx.log });
    let qrCount = 0;

    // linejs prints a debug line ("[login] ForSecure: maxCount=2 ...") to the terminal while it logs in; drop exactly those.
    const consoleLog = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[login] ')) return;
      consoleLog(...args);
    };

    let client: Client;
    try {
      if (mode === 'qr') {
        client = await loginWithQR(
          {
            onReceiveQRUrl: (url) => {
              qrCount += 1;
              if (qrCount === 1) ctx.log(say('lineQrTitle'));
              // The link is part of the block the screen redraws, so rotating or removing the code removes it too.
              const link = say('lineQrUrl', { url });
              screen.show(url, qrCount > 1 ? `${say('qrRefreshed', { count: qrCount })}\n${link}` : link);
            },
            onPincodeRequest: (pin) => {
              screen.clear();
              ctx.log(say('linePin', { pin }));
            },
          },
          init,
        );
      } else {
        const email = await prompt('LINE e-mail: ');
        const password = await prompt('LINE password: ', true);
        client = await loginWithPassword(
          {
            email,
            password,
            onPincodeRequest: (pin) => {
              screen.clear();
              ctx.log(say('linePin', { pin }));
            },
          },
          init,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? scrub(error.message).slice(0, 200) : describe(errorFacts(error));
      throw new Error(`LINE ${mode} login failed: ${detail}. See ${SETUP_DOC}.`, { cause: error });
    } finally {
      screen.clear();
      console.log = consoleLog;
    }

    const authToken = client.base.authToken;
    if (!authToken) {
      throw new Error(`LINE login finished without an access token. See ${SETUP_DOC}.`);
    }
    saveAuth(ctx.accountDir, { authToken, device });
    // Profile data stays in memory only; nothing about the account is written besides the token.
    await Promise.allSettled(client.base.push.conns.map((conn) => conn.close()));
  },

  async open(ctx) {
    assertRuntime();
    const { authToken, device } = loadAuth(ctx);
    const storage = createStorage(ctx.accountDir);
    let client: Client;
    try {
      client = await loginWithAuthToken(authToken, { device, storage });
    } catch (error) {
      rethrowSetupError(error, ctx);
    }
    // The token can be refreshed during login (before a listener could attach) or later.
    if (client.base.authToken && client.base.authToken !== authToken) {
      saveAuth(ctx.accountDir, { authToken: client.base.authToken, device });
    }
    persistTokenUpdates(client, ctx, device);
    return new LineSession(client, ctx);
  },
};
