import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Long, TelegramClient, tl, type User } from '@mtcute/node';
import {
  AccountBanned,
  RateLimited,
  maskPhone,
  terminalSafe,
  type Adapter,
  type AdapterContext,
  type CheckStatus,
  type PhoneNumber,
  type Session,
} from '../types.ts';
import { askHidden, askVisible } from '../prompt.ts';
import { translator, type Translator } from '../i18n/index.ts';
import { QrScreen } from '../qr.ts';
import { createUi, formatDuration, Spinner } from '../ui.ts';
import { readTelegramCredentials } from './telegram-credentials.ts';
import { createSessionStorage, scrubPeerCache } from './telegram-storage.ts';

/** How long a QR login waits for the scan before giving up (the code itself is renewed about every 30 s). */
const QR_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Telegram adapter (MTProto user account via mtcute).
 *
 * A number is looked up by importing it as a temporary contact (`contacts.importContacts`).
 * Only the clientId -> E.164 mapping is used from the response; names, usernames, user ids
 * and avatars are never read or stored. Imported contacts are removed after every batch. The
 * session database keeps credentials only: mtcute's peer cache is replaced by a non-persistent
 * one, and sessions from earlier versions are scrubbed of cached profiles when opened.
 */

const SESSION_FILE = 'session.sqlite';
const E164 = /^\+\d{6,15}$/;

/** RPC errors after which the account cannot be used without human intervention. */
const BANNED_ERRORS: Record<string, true> = {
  PEER_FLOOD: true,
  AUTH_KEY_UNREGISTERED: true,
  AUTH_KEY_INVALID: true,
  AUTH_KEY_DUPLICATED: true,
  SESSION_REVOKED: true,
  SESSION_EXPIRED: true,
  USER_DEACTIVATED: true,
  USER_DEACTIVATED_BAN: true,
};

function createClient(ctx: AdapterContext): TelegramClient {
  const { apiId, apiHash } = readTelegramCredentials(ctx.options);
  const file = join(ctx.accountDir, SESSION_FILE);
  // Sessions written by earlier versions may hold cached customer profiles; purge them first.
  let purged: number;
  try {
    purged = scrubPeerCache(file);
  } catch (error) {
    throw new Error(`Could not remove cached Telegram peer profiles from ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (purged > 0) ctx.log(`telegram/${ctx.account}: removed ${purged} cached peer profile(s) kept by an earlier version.`);
  return new TelegramClient({
    apiId,
    apiHash,
    storage: createSessionStorage(file),
    // No update loop: nothing should stream user objects into the session.
    disableUpdates: true,
  });
}

/** Session files hold full account access; keep them owner-only. Best effort. */
async function restrictSessionFiles(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith(SESSION_FILE)) await chmod(join(dir, name), 0o600);
    }
  } catch {
    // directory is already private (mode 700); a failed chmod is not fatal
  }
}

/** Translate an mtcute error into the adapter contract; unknown errors pass through. */
function translateError(err: unknown, partial: Map<string, CheckStatus>): unknown {
  if (!tl.RpcError.is(err)) return err;
  if (err.is('FLOOD_WAIT_%d') || err.is('FLOOD_PREMIUM_WAIT_%d')) {
    return new RateLimited(`Telegram FLOOD_WAIT ${err.seconds}s`, err.seconds * 1000, partial);
  }
  const text: string = err.text;
  if (Object.hasOwn(BANNED_ERRORS, text) || err.code === tl.RpcError.UNAUTHORIZED) {
    return new AccountBanned(`Telegram account unusable: ${text}`, partial);
  }
  if (err.code === tl.RpcError.FLOOD) {
    return new RateLimited(`Telegram throttled: ${text}`, undefined, partial);
  }
  return err;
}

/**
 * Telegram's login refusals in plain words (what happened, what to do next); the raw error is kept as `cause`.
 * Errors that are not Telegram RPC errors (a timeout, a network failure) are returned unchanged.
 */
export function friendlyLoginError(err: unknown, say: Translator): unknown {
  if (!tl.RpcError.is(err)) return err;
  const fail = (message: string): Error => new Error(message, { cause: err });
  const text: string = err.text;
  if (err.is('FLOOD_WAIT_%d') || err.is('FLOOD_PREMIUM_WAIT_%d')) return fail(say('telegramErrFlood', { wait: formatDuration(err.seconds * 1000) }));
  if (/^(PHONE|NETWORK|USER)_MIGRATE_\d+$/.test(text)) return fail(say('telegramErrMigrate'));
  switch (text) {
    case 'SESSION_PASSWORD_NEEDED':
      return fail(say('telegramErrPasswordNeeded'));
    case 'PHONE_NUMBER_INVALID':
      return fail(say('telegramErrPhoneInvalid'));
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EMPTY':
      return fail(say('telegramErrCodeInvalid'));
    case 'PHONE_CODE_EXPIRED':
      return fail(say('telegramErrCodeExpired'));
    case 'PASSWORD_HASH_INVALID':
      return fail(say('telegramErrPasswordInvalid'));
    case 'API_ID_INVALID':
    case 'API_ID_PUBLISHED_FLOOD':
      return fail(say('telegramErrApiId'));
    case 'PHONE_NUMBER_BANNED':
    case 'USER_DEACTIVATED':
    case 'USER_DEACTIVATED_BAN':
      return fail(say('telegramErrBanned'));
    case 'PHONE_NUMBER_FLOOD':
      return fail(say('telegramErrTooMany'));
    default:
      return fail(say('telegramErrGeneric', { code: terminalSafe(text, 60) }));
  }
}

/** "Name (+84901****567)" for the account that just logged in; the number is masked, the session is never shown. `undefined` when nothing is known. */
export function describeLinkedUser(user: { displayName?: string; phoneNumber?: string | null } | undefined): string | undefined {
  const name = terminalSafe(user?.displayName ?? '', 80);
  const digits = (user?.phoneNumber ?? '').replace(/\D/g, '');
  const phone = digits === '' ? '' : maskPhone(`+${digits}`);
  if (name === '') return phone === '' ? undefined : phone;
  return phone === '' ? name : `${name} (${phone})`;
}

class TelegramSession implements Session {
  private readonly client: TelegramClient;
  private readonly ctx: AdapterContext;
  private seq = 0;
  private closed = false;

  constructor(client: TelegramClient, ctx: AdapterContext) {
    this.client = client;
    this.ctx = ctx;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const results = new Map<string, CheckStatus>();
    const byClientId = new Map<string, string>();
    const contacts: tl.RawInputPhoneContact[] = [];
    const queued = new Set<string>();

    for (const { e164 } of numbers) {
      if (!E164.test(e164) || queued.has(e164)) continue;
      queued.add(e164);
      const clientId = Long.fromNumber(++this.seq);
      byClientId.set(clientId.toString(), e164);
      contacts.push({
        _: 'inputPhoneContact',
        clientId,
        phone: e164,
        // Neutral placeholder; Telegram rejects nameless contacts.
        firstName: `chk${this.seq}`,
        lastName: '',
      });
    }
    if (contacts.length === 0) return results;

    let imported: tl.contacts.RawImportedContacts;
    try {
      imported = await this.client.call(
        { _: 'contacts.importContacts', contacts },
        { floodSleepThreshold: 0 },
      );
    } catch (err) {
      // The request may have reached the server even though no response arrived.
      await this.removeContacts(contacts.map((c) => c.phone));
      throw translateError(err, results);
    }

    const found: string[] = [];
    for (const item of imported.imported) {
      const e164 = byClientId.get(item.clientId.toString());
      if (e164 !== undefined) {
        results.set(e164, 'yes');
        found.push(e164);
      }
    }

    const retry = new Set(imported.retryContacts.map((id) => id.toString()));
    for (const [clientId, e164] of byClientId) {
      if (results.has(e164)) continue;
      results.set(e164, retry.has(clientId) ? 'unknown' : 'not_found');
    }

    await this.removeContacts(found);

    if (retry.size > 0) {
      throw new RateLimited(
        `Telegram deferred ${retry.size}/${contacts.length} contacts (retry_contacts)`,
        undefined,
        results,
      );
    }
    return results;
  }

  /** Best-effort removal of imported contacts so the account's address book stays empty. */
  private async removeContacts(phones: string[]): Promise<void> {
    if (phones.length === 0) return;
    try {
      await this.client.call(
        { _: 'contacts.deleteByPhones', phones },
        { floodSleepThreshold: 0 },
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.ctx.log(
        `telegram/${this.ctx.account}: could not delete ${phones.length} imported contact(s) ` +
          `(${phones.map(maskPhone).join(', ')}): ${why}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.destroy();
  }
}

/**
 * QR login (https://core.telegram.org/api/qr-login): Telegram issues a login token that lives about 30
 * seconds; mtcute calls `qrCodeHandler` with a fresh `tg://login?token=...` URL each time one is issued,
 * and the screen replaces the previous code. Gives up when nobody scans within QR_LOGIN_TIMEOUT_MS.
 */
async function loginWithQr(
  client: TelegramClient,
  ctx: AdapterContext,
  screen: QrScreen,
  password: () => Promise<string>,
  invalidCodeCallback: (type: 'code' | 'password') => void,
  connecting: Spinner,
): Promise<User> {
  const say = translator(ctx.lang);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(say('telegramQrTimeout'))), QR_LOGIN_TIMEOUT_MS);
  let count = 0;
  try {
    return await client.start({
      qrCodeHandler: (url) => {
        connecting.stop();
        count += 1;
        if (count === 1) ctx.log(`${say('telegramQrTitle')}\n  ${say('telegramQrSteps')}`);
        screen.show(url, count > 1 ? say('qrRefreshed', { count }) : undefined);
      },
      password,
      invalidCodeCallback,
      abortSignal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const telegramAdapter: Adapter = {
  app: 'telegram',

  async login(ctx) {
    const say = translator(ctx.lang);
    const client = createClient(ctx);
    const screen = new QrScreen({ lang: ctx.lang, write: ctx.log, waiting: say('spinWaitingScan') });
    // "Connecting..." until Telegram answers with the first QR code or asks for something; never written to a pipe or a log.
    const connecting = new Spinner(process.stderr, createUi(process.stderr, process.env), say('spinConnecting')).start();
    try {
      // The login code and the two-step password are secrets: never echoed to the terminal.
      const password = () => {
        connecting.stop();
        screen.clear();
        return askHidden(say('telegramPasswordPrompt'));
      };
      const invalidCodeCallback = (type: 'code' | 'password'): void => {
        connecting.stop();
        ctx.log(type === 'code' ? say('telegramInvalidCode') : say('telegramInvalidPassword'));
      };
      let user: User | undefined;
      try {
        if (ctx.loginChoice?.method === 'qr') {
          user = await loginWithQr(client, ctx, screen, password, invalidCodeCallback, connecting);
        } else {
          user = await client.start({
            phone: () => {
              connecting.stop();
              return askVisible(say('telegramPhonePrompt'));
            },
            code: () => {
              connecting.stop();
              return askHidden(say('telegramCodePrompt'));
            },
            password,
            invalidCodeCallback,
          });
        }
      } catch (error) {
        connecting.stop();
        throw friendlyLoginError(error, say);
      }
      connecting.stop();
      screen.clear();
      const who = describeLinkedUser(user);
      if (who !== undefined) ctx.log(say('telegramLinked', { who }));
    } finally {
      connecting.stop();
      screen.clear();
      await client.destroy();
      await restrictSessionFiles(ctx.accountDir);
    }
  },

  async open(ctx) {
    const client = createClient(ctx);
    try {
      await client.connect();
      // Cheapest authenticated call; fails with AUTH_KEY_UNREGISTERED when the session is dead
      // or was never created. Nothing from the profile is kept.
      await client.getMe();
    } catch (err) {
      await client.destroy().catch(() => undefined);
      const translated = translateError(err, new Map());
      if (translated instanceof AccountBanned) {
        throw new AccountBanned(
          `${translated.message}. Run "login telegram --account ${ctx.account}" again.`,
        );
      }
      throw translated;
    }
    await restrictSessionFiles(ctx.accountDir);
    return new TelegramSession(client, ctx);
  },
};
