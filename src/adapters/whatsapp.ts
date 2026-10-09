import { randomBytes } from 'node:crypto';
import { chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  type BinaryNode,
  type ConnectionState,
  type WASocket,
} from 'baileys';
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
} from '../types.ts';

/** Max time a whole `login` may take (QR scan or pairing-code entry included). */
const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
/** Max time `open()` waits for a saved session to come online. */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
/** Pairing finishes with a server-requested restart; bound how many we follow. */
const MAX_PAIRING_RESTARTS = 5;
/** A QR login whose connection drops before anyone scans starts over this many times (new connection, new codes). */
const MAX_QR_RECONNECTS = 3;
/** Disconnect codes that mean "the connection broke", not "WhatsApp refused": closed (428), lost/timed out (408), unavailable (503). */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.timedOut,
  DisconnectReason.unavailableService,
]);
/** Grace period after a fresh login for WhatsApp to finish key upload / initial sync. */
const POST_LOGIN_SETTLE_MS = 15_000;
const VERSION_LOOKUP_TIMEOUT_MS = 10_000;

const SET_UP_HINT = 'Run `login whatsapp --account <name>` again.';

interface WhatsAppOptions {
  /** Phone number of the WhatsApp account being linked; enables pairing-code login instead of QR. */
  pairingPhone: string | undefined;
  loginTimeoutMs: number;
  connectTimeoutMs: number;
}

function readTimeout(options: Record<string, unknown>, key: string, fallback: number): number {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5_000 || value > 900_000) {
    throw new Error(`apps.whatsapp.options.${key} must be an integer between 5000 and 900000 (milliseconds).`);
  }
  return value;
}

/** Digits of a phone number written in any common format ("+84 90 123 4567"), or undefined unless it has 8-15 digits. */
function phoneDigits(raw: unknown): string | undefined {
  const digits = typeof raw === 'string' ? raw.replace(/[\s()+-]/g, '') : '';
  return /^\d{8,15}$/.test(digits) ? digits : undefined;
}

function readOptions(options: Record<string, unknown>): WhatsAppOptions {
  let pairingPhone: string | undefined;
  const rawPhone = options.pairingPhone;
  if (rawPhone !== undefined) {
    const digits = phoneDigits(rawPhone);
    if (digits === undefined) {
      throw new Error(
        'apps.whatsapp.options.pairingPhone must be the phone number of the WhatsApp account being linked, in international format: "+", the country code, then the number.',
      );
    }
    pairingPhone = digits;
  }
  return {
    pairingPhone,
    loginTimeoutMs: readTimeout(options, 'loginTimeoutMs', DEFAULT_LOGIN_TIMEOUT_MS),
    connectTimeoutMs: readTimeout(options, 'connectTimeoutMs', DEFAULT_CONNECT_TIMEOUT_MS),
  };
}

/** Baileys logs JIDs / phone numbers at info level; keep it fully silent. */
interface SilentLogger {
  level: string;
  child(bindings: Record<string, unknown>): SilentLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const silentLogger: SilentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class LinkTimeout extends Error {
  constructor() {
    super('Timed out waiting for the WhatsApp connection to open');
    this.name = 'LinkTimeout';
  }
}

function errorCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { data?: unknown; output?: { statusCode?: unknown } };
  // IQ error nodes surface as Boom({ data: <server error code> }); stream/connection errors set statusCode.
  if (typeof e.data === 'number') return e.data;
  const status = e.output?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


/** Map a Baileys failure to the error contract of the scheduler. */
function classify(err: unknown): Error {
  if (err instanceof AccountBanned || err instanceof RateLimited) return err;
  const code = errorCode(err);
  switch (code) {
    case DisconnectReason.loggedOut:
      return new AccountBanned(
        `WhatsApp logged this linked device out (revoked, account banned, or unlinked from the phone). ${SET_UP_HINT}`,
      );
    case DisconnectReason.forbidden:
      return new AccountBanned(
        'WhatsApp refused the connection (403): the account is banned or restricted. Check the phone before using it again.',
      );
    case DisconnectReason.connectionReplaced:
      return new AccountBanned(
        `The linked-device session was replaced (440): this account was linked or opened from another place. ${SET_UP_HINT}`,
      );
    default:
  }
  if (code === 429 || /rate-overlimit/i.test(errorText(err))) {
    return new RateLimited('WhatsApp throttled the account (rate-overlimit).');
  }
  if (err instanceof LinkTimeout || code === DisconnectReason.timedOut) {
    return new Error('WhatsApp connection timed out (temporary).', { cause: err });
  }
  if (code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch) {
    return new Error(`WhatsApp session is unusable (${code}). ${SET_UP_HINT}`, { cause: err });
  }
  return new Error(`WhatsApp error${code === undefined ? '' : ` (${code})`}: ${errorText(err)}`, { cause: err });
}

/** Login-specific wording for failures that are really "the user did not finish pairing". */
function classifyLogin(err: unknown): Error {
  const code = errorCode(err);
  if (err instanceof LinkTimeout || code === DisconnectReason.timedOut) {
    return new Error(
      'WhatsApp login timed out before the device was linked. Re-run login and, on the phone, open WhatsApp > Settings > Linked devices > Link a device, then scan the QR code (or enter the pairing code) promptly.',
      { cause: err },
    );
  }
  if (code === DisconnectReason.loggedOut) {
    return new AccountBanned(
      `WhatsApp rejected the login (401). If you used a pairing code, check "pairingPhone" is the number of the phone you are linking; otherwise ${SET_UP_HINT.toLowerCase()}`,
    );
  }
  return classify(err);
}

let versionLookup: Promise<[number, number, number] | undefined> | undefined;

/**
 * The WhatsApp Web version WhatsApp itself is serving right now, or undefined to use the version bundled with
 * Baileys. Baileys' own `fetchLatestBaileysVersion` is not used: it only reads the constant from Baileys'
 * repository, which is the bundled version again (it reports `isLatest: true` while months behind), and
 * WhatsApp stops completing device links for versions that old (WhiskeySockets/Baileys#2679).
 */
function latestWaVersion(): Promise<[number, number, number] | undefined> {
  versionLookup ??= (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), VERSION_LOOKUP_TIMEOUT_MS);
      });
      const found = await Promise.race([fetchLatestWaWebVersion(), timeout]);
      const bundled = DEFAULT_CONNECTION_CONFIG.version;
      // Never go back to something older than what ships with Baileys, whatever the page says.
      if (!found?.isLatest || found.version[2] < bundled[2]) return undefined;
      return found.version;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  })();
  return versionLookup;
}

async function endSocket(sock: WASocket): Promise<void> {
  try {
    await sock.end(undefined);
  } catch {
    // The socket is being discarded; a failure to close an already-dead socket is irrelevant.
  }
}

interface Link {
  sock: WASocket;
  /** True once the server completed device pairing on this connection. */
  isNewLogin(): boolean;
  /** Resolves once the server has delivered pending notifications (initial sync). */
  synced: Promise<void>;
  /** Rejects when the connection drops after it was open. */
  closed: Promise<never>;
  /** Wait until every credential update has been written to disk. */
  flush(): Promise<void>;
  /** Persist credentials, then terminate the socket. Does not log the device out. */
  close(): Promise<void>;
}

/** `rescan` is true when WhatsApp asked for a fresh code for the same session (see `REG_REFRESH_EVENT`). */
type QrHandler = (qr: string, sock: WASocket, rescan: boolean) => void | Promise<void>;

/**
 * Since 2026-07-28 WhatsApp sends this notification to a device that is not linked yet right after the phone
 * scans its QR code: the code on screen carries a registration secret that WhatsApp has just retired, the
 * phone reports that it could not link, and no `pair-success` ever follows. WhatsApp Web answers it by
 * generating a new secret and drawing the same session's QR again; Baileys 7.0.0-rc14 drops the notification
 * (WhiskeySockets/Baileys#2737, fix proposed in #2765), so the QR login does it here.
 */
const REG_REFRESH_EVENT = 'CB:notification,type:companion_reg_refresh';

/** The notification is only valid with one of these two children (as in WhatsApp Web's handler). */
function isRegRefresh(node: BinaryNode): boolean {
  return Array.isArray(node.content) && node.content.some((child) => child.tag === 'companion_reg_refresh' || child.tag === 'pair-device-rotate-qr');
}

/**
 * The QR payload is `[https://wa.me/settings/linked_devices#]ref,noisePublicKey,identityPublicKey,advSecret[,platform]`;
 * the same payload with the secret replaced, or undefined when it does not have that shape.
 */
export function withAdvSecret(qr: string, advSecret: string): string | undefined {
  const split = qr.indexOf('#') + 1;
  const fields = qr.slice(split).split(',');
  if (fields.length < 4) return undefined;
  fields[3] = advSecret;
  return qr.slice(0, split) + fields.join(',');
}

/**
 * Open a socket from the credentials in ctx.accountDir and resolve when the connection is
 * open. Rejects with the raw disconnect error, a LinkTimeout, or a QR-handler error. The
 * socket is always terminated on rejection and credentials are flushed first. `refreshOnScan` makes a QR
 * login follow WhatsApp's request for a fresh code after a scan.
 */
async function connect(ctx: AdapterContext, timeoutMs: number, onQr?: QrHandler, refreshOnScan = false): Promise<Link> {
  const { state, saveCreds } = await useMultiFileAuthState(ctx.accountDir);
  const version = await latestWaVersion();

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: silentLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  let saveChain: Promise<void> = Promise.resolve();
  let saveError: unknown;
  sock.ev.on('creds.update', () => {
    saveChain = saveChain.then(saveCreds).catch((err: unknown) => {
      saveError = err;
    });
  });

  let rejectClosed!: (err: unknown) => void;
  const closed = new Promise<never>((_, reject) => {
    rejectClosed = reject;
  });
  closed.catch(() => {}); // consumers race it; avoid an unhandled rejection when nobody does.

  let resolveSynced!: () => void;
  const synced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });

  let newLogin = false;
  let closing: Promise<void> | undefined;

  const flush = async (): Promise<void> => {
    await saveChain;
    if (saveError !== undefined) {
      throw new Error(
        `Could not save WhatsApp credentials to the account directory: ${errorText(saveError)}`,
        { cause: saveError },
      );
    }
  };

  const link: Link = {
    sock,
    isNewLogin: () => newLogin,
    synced,
    closed,
    flush,
    close() {
      closing ??= (async () => {
        try {
          await flush();
        } finally {
          await endSocket(sock);
          await restrictAccountFiles(ctx.accountDir);
        }
      })();
      return closing;
    },
  };

  return new Promise<Link>((resolve, reject) => {
    let opened = false;
    let settled = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Pairing writes credentials immediately before the server forces a restart;
      // they must be on disk before the caller reconnects.
      void saveChain
        .then(() => endSocket(sock))
        .then(() => restrictAccountFiles(ctx.accountDir))
        .then(() => reject(err));
    };

    const timer = setTimeout(() => fail(new LinkTimeout()), timeoutMs);

    let advSecret: string | undefined;
    let currentQr: string | undefined;

    if (onQr && refreshOnScan) {
      sock.ws.on(REG_REFRESH_EVENT, (node: BinaryNode) => {
        if (opened || settled || !isRegRefresh(node)) return;
        // Baileys acknowledges a notification only when it can read the account id, which a device that is
        // not linked yet does not have; the server expects the acknowledgement either way.
        void sock
          .sendNode({ tag: 'ack', attrs: { id: node.attrs.id ?? '', to: node.attrs.from ?? '', class: 'notification', type: node.attrs.type ?? '' } })
          .catch(() => {});
        if (currentQr === undefined) return;
        advSecret = randomBytes(32).toString('base64');
        // Pairing is verified against this secret when the server completes it: keep it in step with the code on screen.
        sock.authState.creds.advSecretKey = advSecret;
        sock.ev.emit('creds.update', { advSecretKey: advSecret });
        const rotated = withAdvSecret(currentQr, advSecret);
        if (rotated === undefined) return;
        currentQr = rotated;
        Promise.resolve(onQr(rotated, sock, true)).catch(fail);
      });
    }

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      if (update.isNewLogin) newLogin = true;
      if (update.receivedPendingNotifications) resolveSynced();

      if (update.qr && onQr && !opened && !settled) {
        // Baileys builds every rotated code with the secret it captured when the first one was made; once
        // WhatsApp has retired that secret, each code must carry the current one.
        const qr = advSecret === undefined ? update.qr : (withAdvSecret(update.qr, advSecret) ?? update.qr);
        currentQr = qr;
        Promise.resolve(onQr(qr, sock, false)).catch(fail);
      }

      if (update.connection === 'open' && !opened && !settled) {
        opened = true;
        settled = true;
        clearTimeout(timer);
        resolve(link);
        return;
      }

      if (update.connection === 'close') {
        const err = update.lastDisconnect?.error ?? new Error('WhatsApp connection closed');
        rejectClosed(err);
        if (!opened) fail(err);
      }
    });
  });
}

function isLinked(creds: { account?: unknown }): boolean {
  // `account` is only written when the server completes device pairing.
  return creds.account !== undefined;
}

/** Remove half-finished pairing state (e.g. an abandoned pairing-code attempt). */
async function clearAccountDir(dir: string): Promise<void> {
  const entries = await readdir(dir);
  await Promise.all(entries.map((name) => rm(join(dir, name), { recursive: true, force: true })));
}

/** Baileys writes its auth files with the process umask (usually 0644); keep them owner-only. */
async function restrictAccountFiles(dir: string): Promise<void> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) await chmod(join(dir, entry.name), 0o600);
    }
  } catch {
    // The directory itself is mode 700; a failed chmod here is not fatal.
  }
}

/** Resolve after `ms` or when `p` settles (resolve or reject), without leaving a timer behind. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch {
    // A close during settle is handled by the caller via flush/close; nothing to add here.
  } finally {
    clearTimeout(timer);
  }
}

class WhatsAppSession implements Session {
  private readonly link: Link;
  private closeError: unknown;

  constructor(link: Link) {
    this.link = link;
    link.closed.catch((err: unknown) => {
      this.closeError = err;
    });
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const out = new Map<string, CheckStatus>();
    if (numbers.length === 0) return out;
    if (this.closeError !== undefined) throw classify(this.closeError);

    const digitsByNumber = new Map<string, string>();
    for (const n of numbers) digitsByNumber.set(n.e164, n.e164.replace(/\D/g, ''));
    const queried = new Set(digitsByNumber.values());

    let results: { jid: string; exists: boolean }[] | undefined;
    try {
      results = await Promise.race([this.link.sock.onWhatsApp(...queried), this.link.closed]);
    } catch (err) {
      throw classify(err);
    }
    if (results === undefined) {
      throw new Error('WhatsApp returned no answer for the contact lookup (temporary).');
    }

    const exists = new Map<string, boolean>();
    // Positive answers whose JID we cannot tie back to a queried number (e.g. LID form).
    let unmatchedPositives = 0;
    for (const r of results) {
      const digits = r.jid.endsWith('@lid') ? '' : (r.jid.split('@')[0]?.split(':')[0] ?? '');
      if (queried.has(digits)) exists.set(digits, r.exists || exists.get(digits) === true);
      else if (r.exists) unmatchedPositives++;
    }

    for (const [e164, digits] of digitsByNumber) {
      const found = exists.get(digits);
      if (found === true) out.set(e164, 'yes');
      // An unattributable positive means this batch cannot prove absence for numbers WhatsApp
      // did not explicitly answer; leave them out so they are reported as `unknown`.
      else if (found === false || unmatchedPositives === 0) out.set(e164, 'not_found');
    }
    return out;
  }

  async close(): Promise<void> {
    await this.link.close();
  }
}

export const whatsappAdapter: Adapter = {
  app: 'whatsapp',

  async login(ctx: AdapterContext): Promise<void> {
    const options = readOptions(ctx.options);
    const say = translator(ctx.lang);
    const choice = ctx.loginChoice;
    // An explicit choice (menu or flags) beats the configured pairingPhone; no choice keeps the config's behaviour.
    let pairingPhone = options.pairingPhone;
    if (choice?.method === 'qr') pairingPhone = undefined;
    else if (choice?.method === 'code') {
      if (choice.phone !== undefined) {
        pairingPhone = phoneDigits(choice.phone);
        if (pairingPhone === undefined) {
          // No example number in the text: error messages are phone-masked, and an example would come out as "+8490****567".
          throw new Error('The phone number for the WhatsApp pairing code must be in international format: "+", the country code, then the number.');
        }
      } else if (pairingPhone === undefined) {
        throw new Error('The WhatsApp pairing code needs the phone number of the account being linked: pass --phone <number>.');
      }
    }

    const { state } = await useMultiFileAuthState(ctx.accountDir);
    let resumed = isLinked(state.creds);
    if (resumed) {
      ctx.log('Credentials already saved; verifying that the linked device still works.');
    } else {
      await clearAccountDir(ctx.accountDir);
    }

    const deadline = Date.now() + options.loginTimeoutMs;
    let pairingRequested = false;
    let qrCount = 0;
    const screen = new QrScreen({ lang: ctx.lang, write: ctx.log });

    const onQr: QrHandler = async (qr, sock, rescan) => {
      if (pairingPhone === undefined) {
        // Only the newest code is ever on screen: each one replaces the last, and says how long it lasts.
        qrCount += 1;
        if (qrCount === 1) ctx.log(`${say('whatsappQrTitle')}\n  ${say('whatsappQrSteps')}`);
        const heading = rescan ? say('qrRescan') : qrCount > 1 ? say('qrRefreshed', { count: qrCount }) : say('qrFirst');
        screen.show(qr, heading);
        return;
      }
      if (pairingRequested) return;
      pairingRequested = true;
      const code = await sock.requestPairingCode(pairingPhone);
      const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      ctx.log(`${say('whatsappPairingCode', { code: formatted })}\n  ${say('whatsappPairingSteps')}`);
    };

    let restarts = 0;
    let reconnects = 0;
    for (;;) {
      const remaining = deadline - Date.now();
      let link: Link;
      try {
        if (remaining <= 0) throw new LinkTimeout();
        try {
          link = await connect(ctx, remaining, onQr, pairingPhone === undefined);
        } finally {
          screen.clear();
        }
      } catch (err) {
        if (resumed && errorCode(err) === DisconnectReason.loggedOut) {
          // The saved link was revoked or unlinked from the phone: those credentials can never work
          // again, so drop them and pair from scratch instead of failing on them forever.
          resumed = false;
          await clearAccountDir(ctx.accountDir);
          ctx.log(
            'WhatsApp rejected the saved credentials (401: the linked device was removed or revoked). ' +
              'They were deleted; starting a new pairing.',
          );
          continue;
        }
        if (resumed && errorCode(err) === DisconnectReason.connectionReplaced) {
          throw new AccountBanned(
            'The saved WhatsApp session was replaced (440): another client is using this linked device. ' +
              `The saved credentials in ${ctx.accountDir} were kept. Close the other client (or a running check) ` +
              'and run login again; to pair from scratch instead, delete that directory first.',
          );
        }
        if (errorCode(err) === DisconnectReason.restartRequired && restarts < MAX_PAIRING_RESTARTS) {
          restarts += 1;
          ctx.log('WhatsApp asked to restart the connection to finish pairing; reconnecting.');
          continue;
        }
        // The connection dropped before anyone scanned: a new connection brings new codes, so try again
        // (the same login deadline applies) before giving up.
        if (pairingPhone === undefined && !resumed && TRANSIENT_CODES.has(errorCode(err) ?? 0) && reconnects < MAX_QR_RECONNECTS && deadline - Date.now() > 10_000) {
          reconnects += 1;
          ctx.log(say('whatsappQrReconnecting', { attempt: reconnects, max: MAX_QR_RECONNECTS }));
          await new Promise<void>((resolve) => setTimeout(resolve, reconnects * 1_000));
          continue;
        }
        if (pairingPhone === undefined && !resumed) ctx.log(say('whatsappQrFailedHint'));
        throw classifyLogin(err);
      }

      try {
        await link.flush();
        const fresh = link.isNewLogin();
        if (!isLinked(link.sock.authState.creds)) {
          throw new Error(
            'WhatsApp connected but this device is not linked to an account. ' + SET_UP_HINT,
          );
        }
        if (fresh) await settleWithin(Promise.race([link.synced, link.closed]), POST_LOGIN_SETTLE_MS);
        await link.close();
        return;
      } catch (err) {
        await link.close().catch(() => {});
        throw err instanceof AccountBanned || err instanceof RateLimited ? err : classifyLogin(err);
      }
    }
  },

  async open(ctx: AdapterContext): Promise<Session> {
    const options = readOptions(ctx.options);

    const { state } = await useMultiFileAuthState(ctx.accountDir);
    if (!isLinked(state.creds)) {
      // Empty or half-paired directory (e.g. a re-pair that failed): retrying cannot help, only a
      // new login can. AccountBanned disables the account so every run does not retry it blindly.
      throw new AccountBanned(`WhatsApp account "${ctx.account}" is not logged in (no linked device saved). ${SET_UP_HINT}`);
    }

    try {
      return new WhatsAppSession(await connect(ctx, options.connectTimeoutMs));
    } catch (err) {
      throw classify(err);
    }
  },
};
