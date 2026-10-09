import { createHmac } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { translator } from '../i18n/index.ts';
import { askHidden, askVisible } from '../prompt.ts';
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

/**
 * Threema, through the official Threema Gateway API (https://gateway.threema.ch/en/developer/api):
 * `GET lookup/phone_hash/<HMAC-SHA256 of the E.164 number without "+">` answers with a Threema ID
 * (200) or "no match" (404). Nothing is ever sent to the person. Only people who linked a phone
 * number to their Threema ID can be found, so `not_found` can also mean "not linked".
 *
 * The HMAC key is published by Threema, so the hash is a pseudonym, not protection: the number is
 * effectively sent to Threema. docs/threema-setup.md and docs/responsible-use.md say so.
 *
 * The Gateway authenticates with `from` (Gateway ID) and `secret` as query parameters, so a request
 * URL is a credential: it is never logged and never put into an error message.
 */

const BASE_URL = 'https://msgapi.threema.ch';
/** Public HMAC key from the Gateway documentation (hexadecimal). */
const PHONE_HASH_KEY = Buffer.from('85adf8226953f3d96cfd5d09bf29555eb955fcd8aa5ec4f9fcd869e258370723', 'hex');
const CREDENTIALS_FILE = 'credentials.json';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOGIN_ATTEMPTS = 3;

/** Gateway IDs are "*" plus seven capital letters or digits. */
const GATEWAY_ID = /^\*[A-Z0-9]{7}$/;
/** A Threema ID is eight characters; the Gateway may or may not include the leading "*". */
const THREEMA_ID = /^\*?[A-Z0-9]{8}$/;
/** E.164 digits only: the same bound libphonenumber enforces. */
const E164 = /^\+[1-9]\d{6,14}$/;

interface StoredCredentials {
  gatewayId: string;
  secret: string;
}

/** Hash the Gateway expects for a number: HMAC-SHA256 over the E.164 digits without "+", lowercase hex. */
export function phoneHash(e164: string): string {
  return createHmac('sha256', PHONE_HASH_KEY).update(e164.replace(/^\+/, '')).digest('hex');
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.gatewayId === 'string' && GATEWAY_ID.test(v.gatewayId) && typeof v.secret === 'string' && v.secret !== '';
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
  let raw: string;
  try {
    raw = await readFile(join(ctx.accountDir, CREDENTIALS_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No Threema credentials for account "${ctx.account}". Run: login threema --account ${ctx.account}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Threema credentials file for account "${ctx.account}" is corrupt; run login again.`);
  }
  if (!isStoredCredentials(parsed)) {
    throw new Error(`Threema credentials file for account "${ctx.account}" is missing a valid gatewayId/secret; run login again.`);
  }
  return parsed;
}

/** What went wrong without the request URL, which carries the secret. */
function describe(err: unknown, credentials: StoredCredentials): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(credentials.secret).join('[secret]');
}

/** `Retry-After` in whole seconds (the HTTP-date form is not used by the Gateway); undefined otherwise. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds > 0 ? seconds * 1000 : undefined;
}

async function gatewayGet(path: string, credentials: StoredCredentials): Promise<Response> {
  const url = new URL(path, BASE_URL);
  url.searchParams.set('from', credentials.gatewayId);
  url.searchParams.set('secret', credentials.secret);
  try {
    return await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // Rebuilt without the cause chain: undici can attach the request URL to it.
    throw new Error(`Threema Gateway request failed: ${describe(err, credentials)}`);
  }
}

class ThreemaSession implements Session {
  readonly #credentials: StoredCredentials;
  readonly #log: (message: string) => void;

  constructor(credentials: StoredCredentials, log: (message: string) => void) {
    this.#credentials = credentials;
    this.#log = log;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    const results = new Map<string, CheckStatus>();
    for (const number of numbers) {
      // Malformed numbers are left out and reported as `unknown`.
      if (!E164.test(number.e164)) continue;
      results.set(number.e164, await this.#lookup(number.e164, results));
    }
    return results;
  }

  async #lookup(e164: string, partial: Map<string, CheckStatus>): Promise<CheckStatus> {
    const response = await gatewayGet(`/lookup/phone_hash/${phoneHash(e164)}`, this.#credentials);
    switch (response.status) {
      case 200: {
        const body = (await response.text()).trim();
        // Only the shape matters; the Threema ID itself is neither kept nor logged.
        if (THREEMA_ID.test(body)) return 'yes';
        throw new Error('Threema lookup returned 200 with a body that is not a Threema ID; response not understood');
      }
      case 404:
        return 'not_found';
      case 401:
        throw new AccountBanned('Threema Gateway rejected the Gateway ID or secret. Run login again.', partial);
      case 402:
        throw new AccountBanned('Threema Gateway reports no credits left on this Gateway ID. Add credits, then run the check again.', partial);
      case 429:
        throw new RateLimited('Threema Gateway throttled the account (HTTP 429)', retryAfterMs(response), partial);
      default:
        this.#log(`threema lookup failed for ${maskPhone(e164)}: HTTP ${response.status}`);
        throw new Error(`Threema Gateway answered HTTP ${response.status}`);
    }
  }

  async close(): Promise<void> {
    // Plain HTTPS requests: there is no connection to close.
  }
}

async function askGatewayId(ctx: AdapterContext): Promise<string> {
  const say = translator(ctx.lang);
  for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
    const answer = (await askVisible(say('threemaIdPrompt'))).trim().toUpperCase();
    if (GATEWAY_ID.test(answer)) return answer;
    ctx.log(say('threemaIdInvalid'));
  }
  throw new Error(say('threemaIdInvalid'));
}

export const threemaAdapter: Adapter = {
  app: 'threema',

  async login(ctx) {
    const say = translator(ctx.lang);
    const gatewayId = await askGatewayId(ctx);
    const secret = (await askHidden(say('threemaSecretPrompt'))).trim();
    if (secret === '') throw new Error('No secret entered; nothing was saved.');
    const credentials: StoredCredentials = { gatewayId, secret };

    // GET /credits proves the pair is accepted without looking anything up. Nothing is saved before it passes.
    const response = await gatewayGet('/credits', credentials);
    if (response.status === 401) {
      throw new Error('Threema Gateway rejected the Gateway ID or secret; nothing was saved.');
    }
    if (response.status !== 200) {
      throw new Error(`Threema Gateway answered HTTP ${response.status} while checking the credentials; nothing was saved.`);
    }
    await saveCredentials(ctx, credentials);
  },

  async open(ctx) {
    return new ThreemaSession(await loadCredentials(ctx), ctx.log);
  },
};
