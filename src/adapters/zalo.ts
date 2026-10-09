import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { LoginQRCallbackEventType, Zalo, ZaloApiError } from 'zca-js';
import type { API, Credentials, LoginQRCallbackEvent } from 'zca-js';
import { translator } from '../i18n/index.ts';
import { qrMatrixFromPng } from '../qr-png.ts';
import { QrScreen } from '../qr.ts';
import {
  AccountBanned,
  RateLimited,
  maskPhone,
  type Adapter,
  type AdapterContext,
  type CheckStatus,
  type PhoneNumber,
  type Session,
} from '../types.ts';

const execFileAsync = promisify(execFile);

/** Credentials file, mode 600, inside the account's private directory. */
const CREDENTIALS_FILE = 'credentials.json';
/** Temporary QR image shown during login; deleted as soon as login finishes. */
const QR_FILE = 'login-qr.png';
const MAX_QR_RETRIES = 3;

/**
 * Zalo error code returned by `friend/profile/get` when the phone number cannot be resolved:
 * either no Zalo account is registered for it, or the owner disabled "find me by phone number".
 * zca-js's own findUser special-cases this code (`code != 216`), the two causes are
 * indistinguishable from the response, so both map to `not_found`.
 */
const ERR_USER_NOT_FOUND = 216;

/** Vietnam E.164: +84 followed by 8-10 national digits. The shared scope already filters to VN. */
const VN_E164 = /^\+84\d{8,10}$/;

/**
 * zca-js reports HTTP-level failures only through the message
 * ("Request failed with status code <n>"); there is no error code for them.
 */
const HTTP_STATUS = /status code (\d{3})/i;

/** Messages zca-js throws when a stored cookie/imei set no longer yields a session. */
const LOGIN_REJECTED_MESSAGES: Record<string, true> = {
  'Đăng nhập thất bại': true,
  'Khởi tạo ngữ cảnh thất bại.': true,
};

type StoredCredentials = Pick<Credentials, 'imei' | 'userAgent'> & {
  cookie: Credentials['cookie'];
  language?: string;
};

function createClient(): Zalo {
  // checkUpdate would call the npm registry on every login; logging would print ids/cookies.
  return new Zalo({ checkUpdate: false, logging: false });
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.imei === 'string' &&
    v.imei !== '' &&
    typeof v.userAgent === 'string' &&
    v.userAgent !== '' &&
    (Array.isArray(v.cookie) || (typeof v.cookie === 'object' && v.cookie !== null)) &&
    (v.language === undefined || typeof v.language === 'string')
  );
}

async function saveCredentials(ctx: AdapterContext, credentials: StoredCredentials): Promise<void> {
  await mkdir(ctx.accountDir, { recursive: true, mode: 0o700 });
  const target = join(ctx.accountDir, CREDENTIALS_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials), { mode: 0o600 });
  // mode in writeFile is subject to umask and ignored for pre-existing files.
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

async function loadCredentials(ctx: AdapterContext): Promise<StoredCredentials> {
  const path = join(ctx.accountDir, CREDENTIALS_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No Zalo credentials for account "${ctx.account}". Run: login zalo --account ${ctx.account}`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Zalo credentials file for account "${ctx.account}" is corrupt; run login again.`);
  }
  if (!isStoredCredentials(parsed)) {
    throw new Error(
      `Zalo credentials file for account "${ctx.account}" is missing imei/cookie/userAgent; run login again.`,
    );
  }
  return parsed;
}

function httpStatus(err: ZaloApiError): number | undefined {
  const match = HTTP_STATUS.exec(err.message);
  return match ? Number(match[1]) : undefined;
}

/** Throw AccountBanned when the error means the saved web session is no longer accepted. */
function assertSessionUsable(err: unknown, partial?: Map<string, CheckStatus>): void {
  if (!(err instanceof ZaloApiError)) return;
  const status = httpStatus(err);
  if (status === 401 || status === 403 || Object.hasOwn(LOGIN_REJECTED_MESSAGES, err.message)) {
    throw new AccountBanned(
      `Zalo rejected the saved session (${err.message}); the account is logged out or blocked. Run login again.`,
      partial,
    );
  }
}

class ZaloSession implements Session {
  readonly #api: API;
  readonly #log: (message: string) => void;

  constructor(api: API, log: (message: string) => void) {
    this.#api = api;
    this.#log = log;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const results = new Map<string, CheckStatus>();
    for (const number of numbers) {
      // Out-of-scope or malformed numbers are left out and reported as `unknown`.
      if (!VN_E164.test(number.e164)) continue;
      try {
        results.set(number.e164, await this.#lookup(number.e164));
      } catch (err) {
        assertSessionUsable(err, results);
        if (err instanceof ZaloApiError && httpStatus(err) === 429) {
          throw new RateLimited(`Zalo throttled the account (${err.message})`, undefined, results);
        }
        this.#log(`zalo lookup failed for ${maskPhone(number.e164)}: ${describe(err)}`);
        throw err;
      }
    }
    return results;
  }

  async #lookup(e164: string): Promise<CheckStatus> {
    // findUser takes the number in international form without "+": "84901234567".
    // (A national "0901234567" is rewritten to the same form by zca-js when language is "vi".)
    try {
      const user = await this.#api.findUser(e164.slice(1));
      // Only the presence of a uid matters; the rest of the profile is neither read nor kept.
      if (typeof user?.uid === 'string' && user.uid !== '') return 'yes';
    } catch (err) {
      if (err instanceof ZaloApiError && err.code === ERR_USER_NOT_FOUND) return 'not_found';
      throw err;
    }
    throw new Error('Zalo findUser returned no error and no uid; response not understood');
  }

  async close(): Promise<void> {
    // zca-js opens no socket unless a listener is started, which this adapter never does.
  }
}

function describe(err: unknown): string {
  if (err instanceof ZaloApiError) {
    return `${err.message}${err.code === null ? '' : ` (code ${err.code})`}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the QR picture in the default viewer, only when it is safe to: macOS, a terminal on stdout, and a
 * private (mode 600) regular file inside this account's own directory. Never throws; false when not opened.
 */
async function openQrPicture(path: string, accountDir: string): Promise<boolean> {
  if (process.platform !== 'darwin' || process.stdout.isTTY !== true) return false;
  try {
    const info = await stat(path);
    const inside = resolve(path).startsWith(`${resolve(accountDir)}${sep}`);
    if (!inside || !info.isFile() || (info.mode & 0o777) !== 0o600) return false;
    await execFileAsync('/usr/bin/open', [path], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export const zaloAdapter: Adapter = {
  app: 'zalo',

  async login(ctx) {
    await mkdir(ctx.accountDir, { recursive: true, mode: 0o700 });
    const qrPath = join(ctx.accountDir, QR_FILE);
    const say = translator(ctx.lang);
    const screen = new QrScreen({ lang: ctx.lang, write: ctx.log });
    let shown = 0;
    const state: { captured?: StoredCredentials; declined: boolean; gaveUp: boolean; retries: number } = {
      declined: false,
      gaveUp: false,
      retries: 0,
    };

    /**
     * Draw the code in the terminal. zca-js hands over the login QR as a PNG (and a token whose use is not
     * documented), so the module grid is read back from the picture and redrawn. When the picture is not
     * a plain QR this reader understands, the PNG is saved (mode 600, removed afterwards), its path printed
     * and, on a Mac terminal, the picture opened.
     */
    const present = (event: Extract<LoginQRCallbackEvent, { type: LoginQRCallbackEventType.QRCodeGenerated }>): void => {
      const image: unknown = event.data?.image;
      const matrix = typeof image === 'string' ? qrMatrixFromPng(Buffer.from(image, 'base64')) : undefined;
      if (matrix !== undefined) {
        shown += 1;
        if (shown === 1) ctx.log(`${say('zaloQrTitle')}\n  ${say('zaloQrSteps')}`);
        screen.show(matrix, shown > 1 ? say('qrRefreshed', { count: shown }) : undefined);
        return;
      }
      void event.actions
        .saveToFile(qrPath)
        .then(() => chmod(qrPath, 0o600))
        .then(async () => {
          ctx.log(`${say('zaloQrTitle')}\n  ${say('zaloQrSteps')}\n  ${say('zaloQrFile', { path: qrPath })}`);
          if (await openQrPicture(qrPath, ctx.accountDir)) ctx.log(say('zaloQrOpened'));
        })
        .catch((err: unknown) => {
          ctx.log(`Could not write the QR image: ${describe(err)}`);
          event.actions.abort();
        });
    };

    try {
      await createClient().loginQR({ qrPath }, (event) => {
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            // The QR is a short-lived login token: only ever shown to this terminal or written under accountDir.
            present(event);
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            screen.clear();
            ctx.log(say('zaloQrScanned'));
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            screen.clear();
            if (state.retries < MAX_QR_RETRIES) {
              state.retries += 1;
              ctx.log(say('zaloQrExpired', { attempt: state.retries, max: MAX_QR_RETRIES }));
              event.actions.retry();
            } else {
              state.gaveUp = true;
              event.actions.abort();
            }
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            state.declined = true;
            event.actions.abort();
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            state.captured = {
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
              language: 'vi',
            };
            break;
        }
      });
    } catch (err) {
      if (state.declined) throw new Error(say('zaloQrDeclined'));
      if (state.gaveUp) throw new Error(say('zaloQrGaveUp'));
      throw err;
    } finally {
      screen.clear();
      await rm(qrPath, { force: true });
    }

    if (!state.captured) throw new Error('Zalo login finished without returning credentials.');
    await saveCredentials(ctx, state.captured);
  },

  async open(ctx) {
    const credentials = await loadCredentials(ctx);
    let api: API;
    try {
      api = await createClient().login(credentials);
    } catch (err) {
      assertSessionUsable(err);
      throw err;
    }
    return new ZaloSession(api, ctx.log);
  },
};
